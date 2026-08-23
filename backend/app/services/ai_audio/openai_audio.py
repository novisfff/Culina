from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any
from uuid import uuid4

from fastapi import HTTPException

from app.services.ai_audio.config import (
    ResolvedAudioProviderConfig,
    binding_endpoint_url,
)
from app.services.ai_audio.providers import (
    AudioProviderDependencies,
    audio_provider_error,
)
from app.services.ai_audio.schemas import (
    SpeechRequest,
    SpeechResult,
    TranscriptionRequest,
    TranscriptionResult,
)
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import normalize_transcript
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.transport import ProviderResponse
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.errors import ModelUsageContractError, ModelUsageError
from app.services.model_usage.types import DispatchPermit


_CONFIRMED_NOT_EXECUTED_STATUS_CODES = frozenset(
    {400, 401, 403, 404, 405, 406, 413, 415, 422, 429}
)


class _ConfirmedAudioProviderFailure(RuntimeError):
    def __init__(self, *, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"audio provider returned HTTP {status_code}")


class _AmbiguousAudioProviderFailure(RuntimeError):
    pass


class _KnownNoSendAudioFailure(RuntimeError):
    def __init__(self, cause: Exception) -> None:
        self.cause = cause
        super().__init__(str(cause))


class OpenAIAudioProvider:
    """OpenAI-compatible STT/TTS using one immutable family binding.

    No constructor argument can select an endpoint, model, or credential.  A
    provider call obtains its key only after ``prepare_dispatch`` persists the
    permit that pins the credential secret version.
    """

    def __init__(
        self,
        config: ResolvedAudioProviderConfig,
        *,
        dependencies: AudioProviderDependencies,
        usage_adapter: AudioUsageAdapter,
    ) -> None:
        binding = config.binding
        if (
            binding.adapter_kind != "openai_compatible_http"
            or binding.capability not in {"stt", "tts"}
        ):
            raise ModelUsageContractError("audio_binding_adapter_unsupported")
        if usage_adapter.binding is not binding and usage_adapter.binding != binding:
            raise ModelUsageContractError("audio_binding_required")
        self.config = config
        self.dependencies = dependencies
        self.usage_adapter = usage_adapter

    @property
    def binding(self):
        return self.config.binding

    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        if self.binding.capability != "stt":
            raise ModelUsageContractError("audio_stt_capability_mismatch")
        duration = _required_measured_duration(request)
        language = request.language_hint or self.config.language_hint
        fields: dict[str, str] = {"model": self.binding.requested_model}
        if language and language != "auto":
            fields["language"] = language
        body, content_type = _multipart_form(
            fields,
            filename=request.filename or "audio.webm",
            payload=request.audio_bytes,
            media_type=request.content_type,
        )
        attempt = self.usage_adapter.begin_stt(
            request,
            duration_seconds=duration,
            fingerprint=self.usage_adapter.request_fingerprint(
                _stt_fingerprint_payload(
                    binding=self.binding,
                    request=request,
                    language=language,
                )
            ),
            binding=self.binding,
        )
        permit = attempt.prepare_dispatch()
        try:
            response = self._request(
                suffix="audio/transcriptions",
                headers={"Accept": "application/json", "Content-Type": content_type},
                body=body,
                permit=permit,
            )
        except _KnownNoSendAudioFailure as exc:
            self._settle_confirmed_not_executed(attempt, permit, 0)
            raise exc.cause
        except _ConfirmedAudioProviderFailure as exc:
            self._settle_confirmed_not_executed(attempt, permit, exc.status_code)
            raise audio_provider_error(code="audio_transcription_rejected") from exc
        except _AmbiguousAudioProviderFailure as exc:
            self._mark_uncertain(attempt)
            raise audio_provider_error(code="audio_transcription_unavailable") from exc

        # A 2xx response represents a provider execution even if its body
        # later proves malformed.  Persist its receipt before parsing content.
        try:
            attempt.settle(
                self.usage_adapter.stt_receipt(
                    permit,
                    duration_seconds=duration,
                    reported_model=self.binding.requested_model,
                    provider_request_id=_provider_request_id(response),
                    provider_usage=_response_usage(response),
                )
            )
        except Exception:
            self._mark_uncertain(attempt)
            raise
        try:
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("transcription response must be an object")
            text = normalize_transcript(str(payload.get("text") or ""))
            if not text:
                raise ValueError("transcription result empty")
            return TranscriptionResult(
                text=text,
                language=(
                    payload.get("language")
                    if isinstance(payload.get("language"), str)
                    else language
                ),
                duration_seconds=None,
                raw_metadata={},
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise audio_provider_error(code="audio_transcription_invalid") from exc

    def synthesize(self, request: SpeechRequest) -> SpeechResult:
        if self.binding.capability != "tts":
            raise ModelUsageContractError("audio_tts_capability_mismatch")
        text = sanitize_speech_text(request.text)
        voice = request.voice or self.config.voice or "alloy"
        output_format = self.config.output_format or "mp3"
        payload = {
            "model": self.binding.requested_model,
            "voice": voice,
            "input": text,
            "response_format": output_format,
        }
        attempt = self.usage_adapter.begin_tts(
            request,
            sanitized_text=text,
            fingerprint=self.usage_adapter.request_fingerprint(
                _tts_fingerprint_payload(
                    binding=self.binding,
                    voice=voice,
                    audio_format=output_format,
                    text=text,
                )
            ),
            binding=self.binding,
        )
        permit = attempt.prepare_dispatch()
        try:
            response = self._request(
                suffix="audio/speech",
                headers={"Accept": "audio/*"},
                json=payload,
                permit=permit,
            )
        except _KnownNoSendAudioFailure as exc:
            self._settle_confirmed_not_executed(attempt, permit, 0)
            raise exc.cause
        except _ConfirmedAudioProviderFailure as exc:
            self._settle_confirmed_not_executed(attempt, permit, exc.status_code)
            raise audio_provider_error(code="audio_speech_rejected") from exc
        except _AmbiguousAudioProviderFailure as exc:
            self._mark_uncertain(attempt)
            raise audio_provider_error(code="audio_speech_unavailable") from exc

        try:
            attempt.settle(
                self.usage_adapter.tts_receipt(
                    permit,
                    sanitized_text=text,
                    reported_model=self.binding.requested_model,
                    provider_request_id=_provider_request_id(response),
                    provider_usage=_response_usage(response),
                )
            )
        except Exception:
            self._mark_uncertain(attempt)
            raise
        if not response.content:
            raise audio_provider_error(code="audio_speech_invalid")
        return SpeechResult(
            content_type=(
                response.header("content-type") or _content_type_for_format(output_format)
            ).split(";", 1)[0],
            audio_bytes=response.content,
            audio_stream=None,
            external_url=None,
            external_url_expires_at=None,
        )

    def _request(
        self,
        *,
        suffix: str,
        headers: dict[str, str],
        permit: DispatchPermit,
        json: object | None = None,
        body: bytes | None = None,
    ) -> ProviderResponse:
        credential = None
        try:
            # Credential resolution happens immediately before the shared,
            # policy-enforced transport send and after the permit is durable.
            credential = self.dependencies.resolve_dispatch_credential(
                self.binding,
                permit.credential_secret_version_id,
            )
        except (FamilyModelSettingsError, ModelUsageContractError) as exc:
            # A credential failure occurs before a send; preserving the domain
            # error lets the service return the correct Member-safe message.
            raise _KnownNoSendAudioFailure(exc) from exc
        try:
            request_headers = dict(headers)
            if self.binding.auth_mode == "api_key":
                if not credential.api_key:
                    raise _KnownNoSendAudioFailure(
                        ModelUsageContractError("audio_dispatch_credential_required")
                    )
                request_headers["Authorization"] = f"Bearer {credential.api_key}"
            if permit.provider_idempotency_key:
                request_headers["Idempotency-Key"] = permit.provider_idempotency_key
            response = self.dependencies.transport.request(
                "POST",
                binding_endpoint_url(self.binding, suffix),
                headers=request_headers,
                json=json,
                body=body,
            )
        except _KnownNoSendAudioFailure:
            raise
        except (FamilyModelSettingsError, ModelUsageContractError) as exc:
            # Once the shared transport has been entered, its failure may have
            # happened after a remote send.  Preserve the uncertain barrier.
            raise _AmbiguousAudioProviderFailure() from exc
        except Exception as exc:
            raise _AmbiguousAudioProviderFailure() from exc
        finally:
            credential = None
        if 200 <= response.status_code < 300:
            return response
        if response.status_code in _CONFIRMED_NOT_EXECUTED_STATUS_CODES:
            raise _ConfirmedAudioProviderFailure(status_code=response.status_code)
        raise _AmbiguousAudioProviderFailure()

    @staticmethod
    def _mark_uncertain(attempt: MeteredProviderAttempt) -> None:
        try:
            attempt.mark_uncertain("audio_provider_result_unavailable")
        except Exception:
            # Keep the original terminal error; recovery still has the
            # dispatching reservation as a conservative resend barrier.
            pass

    def _settle_confirmed_not_executed(
        self,
        attempt: MeteredProviderAttempt,
        permit: DispatchPermit,
        status_code: int,
    ) -> None:
        try:
            attempt.settle(
                self.usage_adapter.confirmed_not_executed_receipt(
                    permit,
                    stable_provider_request_id=f"http_status_{status_code}",
                )
            )
        except Exception:
            self._mark_uncertain(attempt)


def _multipart_form(
    fields: dict[str, str],
    *,
    filename: str,
    payload: bytes,
    media_type: str,
) -> tuple[bytes, str]:
    """Build the bounded STT multipart payload without a raw HTTP client."""

    boundary = f"----CulinaAudio{uuid4().hex}"
    safe_filename = filename.replace("\\", "_").replace('"', "_").replace("\r", "_").replace("\n", "_")
    chunks: list[bytes] = []
    for key, value in fields.items():
        chunks.extend(
            (
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
                value.encode("utf-8"),
                b"\r\n",
            )
        )
    chunks.extend(
        (
            f"--{boundary}\r\n".encode(),
            (
                "Content-Disposition: form-data; name=\"file\"; "
                f'filename="{safe_filename}"\r\n'
            ).encode(),
            f"Content-Type: {media_type}\r\n\r\n".encode(),
            payload,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        )
    )
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def _content_type_for_format(audio_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "mpeg": "audio/mpeg",
        "wav": "audio/wav",
        "ogg": "audio/ogg",
        "opus": "audio/ogg",
        "aac": "audio/aac",
        "flac": "audio/flac",
        "mp4": "audio/mp4",
        "pcm": "audio/wav",
    }.get(audio_format.lower(), "application/octet-stream")


def _required_measured_duration(request: TranscriptionRequest) -> Decimal:
    duration = request.measured_duration_seconds
    if not isinstance(duration, Decimal) or duration <= 0:
        raise ModelUsageContractError("audio_stt_server_duration_required")
    return duration


def _stt_fingerprint_payload(
    *,
    binding: Any,
    request: TranscriptionRequest,
    language: str | None,
) -> bytes:
    return json.dumps(
        {
            "audio_sha256": hashlib.sha256(request.audio_bytes).hexdigest(),
            "binding_revision": binding.config_revision_id,
            "content_type": request.content_type,
            "filename": request.filename,
            "kind": "stt",
            "language": language or "",
            "model": binding.requested_model,
            "profile": binding.provider_profile_id,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _tts_fingerprint_payload(
    *,
    binding: Any,
    voice: str,
    audio_format: str,
    text: str,
) -> bytes:
    return json.dumps(
        {
            "audio_format": audio_format,
            "binding_revision": binding.config_revision_id,
            "kind": "tts",
            "model": binding.requested_model,
            "profile": binding.provider_profile_id,
            "text": text,
            "voice": voice,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _provider_request_id(response: ProviderResponse) -> str | None:
    value = response.header("x-request-id") or response.header("request-id")
    return value if isinstance(value, str) and value else None


def _response_usage(response: ProviderResponse) -> object | None:
    content_type = (response.header("content-type") or "").lower()
    if "json" not in content_type:
        return None
    try:
        payload = response.json()
    except Exception:
        return None
    return payload.get("usage") if isinstance(payload, dict) else None
