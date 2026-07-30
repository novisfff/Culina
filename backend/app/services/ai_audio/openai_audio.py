from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any

import httpx
from fastapi import HTTPException, status

from app.core.config import Settings
from app.services.ai_audio.providers import provider_unavailable
from app.services.ai_audio.schemas import SpeechRequest, SpeechResult, TranscriptionRequest, TranscriptionResult
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import normalize_transcript
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.errors import ModelUsageContractError, ModelUsageError
from app.services.model_usage.types import DispatchPermit


_CONFIRMED_NOT_EXECUTED_STATUS_CODES = frozenset({400, 401, 403, 404, 405, 406, 413, 415, 422, 429})


class _ConfirmedAudioProviderFailure(RuntimeError):
    def __init__(self, *, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"audio provider returned HTTP {status_code}")


class _AmbiguousAudioProviderFailure(RuntimeError):
    pass


class OpenAIAudioProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        capability: str,
        usage_adapter: AudioUsageAdapter | None = None,
        model_usage_required: bool = False,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.capability = capability
        self.usage_adapter = usage_adapter
        self.model_usage_required = model_usage_required
        self.transport = transport

    @property
    def api_key(self) -> str:
        if self.capability == "stt":
            return self.settings.ai_stt_api_key.strip() or self.settings.ai_api_key.strip()
        if self.capability == "tts":
            return self.settings.ai_tts_api_key.strip() or self.settings.ai_api_key.strip()
        return self.settings.ai_api_key.strip()

    @property
    def api_base(self) -> str:
        if self.capability == "stt":
            return (self.settings.ai_stt_api_base.strip() or self.settings.ai_api_base).rstrip("/")
        if self.capability == "tts":
            return (self.settings.ai_tts_api_base.strip() or self.settings.ai_api_base).rstrip("/")
        return self.settings.ai_api_base.rstrip("/")

    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if not self.api_key:
            raise provider_unavailable("openai", "transcription")
        model = self.settings.ai_stt_model.strip() or "gpt-4o-mini-transcribe"
        files = {"file": (request.filename or "audio.webm", request.audio_bytes, request.content_type)}
        data: dict[str, str] = {"model": model}
        if request.language_hint and request.language_hint != "auto":
            data["language"] = request.language_hint
        adapter = self._require_usage_adapter()
        attempt: MeteredProviderAttempt | None = None
        permit: DispatchPermit | None = None
        settled = False
        if adapter is not None:
            duration = _required_measured_duration(request)
            attempt = adapter.begin_stt(
                request,
                duration_seconds=duration,
                fingerprint=adapter.request_fingerprint(
                    _stt_fingerprint_payload(
                        provider="openai",
                        model=model,
                        request=request,
                    )
                ),
            )
            permit = attempt.prepare_dispatch()
        try:
            response = self._post_transcription(data=data, files=files)
        except _ConfirmedAudioProviderFailure as exc:
            self._settle_confirmed_not_executed(attempt, permit, adapter, exc.status_code)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别服务返回错误") from exc
        except _AmbiguousAudioProviderFailure as exc:
            self._mark_uncertain(attempt)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别服务不可用") from exc
        try:
            if attempt is not None and permit is not None and adapter is not None:
                attempt.settle(
                    adapter.stt_receipt(
                        permit,
                        duration_seconds=_required_measured_duration(request),
                        reported_model=model,
                        provider_request_id=_provider_request_id(response),
                    )
                )
                settled = True
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("transcription response must be an object")
            text = normalize_transcript(str(payload.get("text") or ""))
            if not text:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别结果为空")
            return TranscriptionResult(
                text=text,
                language=payload.get("language") if isinstance(payload.get("language"), str) else None,
                duration_seconds=None,
                provider="openai",
                model=model,
                raw_metadata={},
            )
        except HTTPException:
            if not settled:
                self._mark_uncertain(attempt)
            raise
        except Exception as exc:
            if not settled:
                self._mark_uncertain(attempt)
            if isinstance(exc, ModelUsageContractError):
                raise
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音识别结果无效") from exc

    def synthesize(self, request: SpeechRequest) -> SpeechResult:
        if not self.api_key:
            raise provider_unavailable("openai", "speech")
        model = self.settings.ai_tts_model.strip() or "gpt-4o-mini-tts"
        voice = request.voice or self.settings.ai_tts_voice.strip() or "alloy"
        audio_format = self.settings.ai_tts_format.strip() or "mp3"
        text = sanitize_speech_text(request.text)
        adapter = self._require_usage_adapter()
        attempt: MeteredProviderAttempt | None = None
        permit: DispatchPermit | None = None
        settled = False
        if adapter is not None:
            attempt = adapter.begin_tts(
                request,
                sanitized_text=text,
                fingerprint=adapter.request_fingerprint(
                    _tts_fingerprint_payload(
                        provider="openai",
                        model=model,
                        voice=voice,
                        audio_format=audio_format,
                        text=text,
                    )
                ),
            )
            permit = attempt.prepare_dispatch()
        try:
            response = self._post_speech(
                {"model": model, "voice": voice, "input": text, "response_format": audio_format}
            )
        except _ConfirmedAudioProviderFailure as exc:
            self._settle_confirmed_not_executed(attempt, permit, adapter, exc.status_code)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成服务返回错误") from exc
        except _AmbiguousAudioProviderFailure as exc:
            self._mark_uncertain(attempt)
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成服务不可用") from exc
        try:
            if attempt is not None and permit is not None and adapter is not None:
                # Settle before accessing provider audio bytes so a successful
                # send remains durable even if local response handling fails.
                attempt.settle(
                    adapter.tts_receipt(
                        permit,
                        sanitized_text=text,
                        reported_model=model,
                        provider_request_id=_provider_request_id(response),
                    )
                )
                settled = True
            audio_bytes = response.content
            if not audio_bytes:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成结果为空")
            return SpeechResult(
                content_type=_content_type_for_format(audio_format),
                audio_bytes=audio_bytes,
                audio_stream=None,
                external_url=None,
                external_url_expires_at=None,
                provider="openai",
                model=model,
            )
        except HTTPException:
            if not settled:
                self._mark_uncertain(attempt)
            raise
        except Exception as exc:
            if not settled:
                self._mark_uncertain(attempt)
            if isinstance(exc, ModelUsageError):
                raise
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="语音合成结果无效") from exc

    def _require_usage_adapter(self) -> AudioUsageAdapter | None:
        if self.usage_adapter is None and self.model_usage_required:
            raise ModelUsageContractError("model_usage_adapter_required")
        return self.usage_adapter

    def _post_transcription(self, *, data: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> httpx.Response:
        try:
            with httpx.Client(
                timeout=self.settings.ai_stt_timeout_seconds,
                transport=self.transport,
            ) as client:
                response = client.post(
                    f"{self.api_base}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    data=data,
                    files=files,
                )
                response.raise_for_status()
                return response
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in _CONFIRMED_NOT_EXECUTED_STATUS_CODES:
                raise _ConfirmedAudioProviderFailure(status_code=exc.response.status_code) from exc
            raise _AmbiguousAudioProviderFailure(str(exc)) from exc
        except httpx.TransportError as exc:
            raise _AmbiguousAudioProviderFailure(str(exc)) from exc

    def _post_speech(self, payload: dict[str, str]) -> httpx.Response:
        try:
            with httpx.Client(
                timeout=self.settings.ai_tts_timeout_seconds,
                transport=self.transport,
            ) as client:
                response = client.post(
                    f"{self.api_base}/audio/speech",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=payload,
                )
                response.raise_for_status()
                return response
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in _CONFIRMED_NOT_EXECUTED_STATUS_CODES:
                raise _ConfirmedAudioProviderFailure(status_code=exc.response.status_code) from exc
            raise _AmbiguousAudioProviderFailure(str(exc)) from exc
        except httpx.TransportError as exc:
            raise _AmbiguousAudioProviderFailure(str(exc)) from exc

    @staticmethod
    def _mark_uncertain(attempt: MeteredProviderAttempt | None) -> None:
        if attempt is None:
            return
        try:
            attempt.mark_uncertain("audio_provider_result_unavailable")
        except Exception:
            # Preserve the original provider/ledger exception.  The durable
            # dispatching reservation is still a conservative resend barrier.
            pass

    def _settle_confirmed_not_executed(
        self,
        attempt: MeteredProviderAttempt | None,
        permit: DispatchPermit | None,
        adapter: AudioUsageAdapter | None,
        status_code: int,
    ) -> None:
        if attempt is None or permit is None or adapter is None:
            return
        try:
            attempt.settle(
                adapter.confirmed_not_executed_receipt(
                    permit,
                    stable_provider_request_id=f"http_status_{status_code}",
                )
            )
        except Exception:
            self._mark_uncertain(attempt)


def _content_type_for_format(audio_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "mpeg": "audio/mpeg",
        "wav": "audio/wav",
        "opus": "audio/ogg",
        "aac": "audio/aac",
        "flac": "audio/flac",
        "pcm": "audio/wav",
    }.get(audio_format.lower(), "application/octet-stream")


def _required_measured_duration(request: TranscriptionRequest) -> Decimal:
    duration = request.measured_duration_seconds
    if not isinstance(duration, Decimal) or duration <= 0:
        raise ModelUsageContractError("audio_stt_server_duration_required")
    return duration


def _stt_fingerprint_payload(*, provider: str, model: str, request: TranscriptionRequest) -> bytes:
    return json.dumps(
        {
            "audio_sha256": hashlib.sha256(request.audio_bytes).hexdigest(),
            "content_type": request.content_type,
            "filename": request.filename,
            "kind": "stt",
            "model": model,
            "provider": provider,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _tts_fingerprint_payload(
    *,
    provider: str,
    model: str,
    voice: str,
    audio_format: str,
    text: str,
) -> bytes:
    return json.dumps(
        {
            "audio_format": audio_format,
            "kind": "tts",
            "model": model,
            "provider": provider,
            "text": text,
            "voice": voice,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _provider_request_id(response: Any) -> str | None:
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    value = headers.get("x-request-id") or headers.get("request-id")
    return value if isinstance(value, str) and value else None
