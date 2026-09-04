from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, status

from app.services.ai_audio.config import (
    ResolvedAudioProviderConfig,
    binding_endpoint_url,
    realtime_endpoint_url,
)
from app.services.ai_audio.providers import (
    AudioProviderDependencies,
    audio_provider_error,
)
from app.services.ai_audio.realtime import RealtimeProviderOperation, RealtimeProviderScope
from app.services.ai_audio.schemas import (
    SpeechRequest,
    SpeechResult,
    TranscriptionRequest,
    TranscriptionResult,
)
from app.services.ai_audio.speech import dashscope_tts_billable_characters, sanitize_speech_text
from app.services.ai_audio.transcription import (
    AudioDurationError,
    measure_audio_duration_seconds,
    normalize_transcript,
)
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.transport import ProviderResponse
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.adapters.realtime_audio import LEASE_SECONDS
from app.services.model_usage.decimal_math import quantize_quantity
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import DispatchPermit


_CONFIRMED_NOT_EXECUTED_STATUS_CODES = frozenset(
    {400, 401, 403, 404, 405, 406, 413, 415, 422, 429}
)
_DEFAULT_INPUT_SAMPLE_RATE = 16000
_DEFAULT_OUTPUT_SAMPLE_RATE = 24000
_REALTIME_AUDIO_FORMAT = "pcm"
_REALTIME_LANGUAGE_TYPE = "Chinese"


class _ConfirmedAudioProviderFailure(RuntimeError):
    def __init__(self, *, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"audio provider returned HTTP {status_code}")


class _AmbiguousAudioProviderFailure(RuntimeError):
    pass


class _KnownNoSendRealtimeFailure(RuntimeError):
    """A credential precondition that happened before opening a WebSocket."""

    def __init__(self, cause: FamilyModelSettingsError | ModelUsageContractError) -> None:
        self.cause = cause
        super().__init__(str(cause))


class DashScopeAudioProvider:
    """DashScope HTTP STT/TTS backed exclusively by a resolved family binding."""

    def __init__(
        self,
        config: ResolvedAudioProviderConfig,
        *,
        dependencies: AudioProviderDependencies,
        usage_adapter: AudioUsageAdapter,
    ) -> None:
        binding = config.binding
        if (
            binding.adapter_kind != "dashscope"
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
        payload = _dashscope_stt_payload(
            model=self.binding.requested_model,
            audio_data_url=(
                f"data:{request.content_type};base64,"
                f"{base64.b64encode(request.audio_bytes).decode('ascii')}"
            ),
            content_type=request.content_type,
            sample_rate=_metadata_sample_rate(request.metadata, _DEFAULT_INPUT_SAMPLE_RATE),
        )
        if language and language != "auto":
            parameters = payload.setdefault("parameters", {})
            if isinstance(parameters, dict):
                parameters["language"] = language
        if self.config.hotwords:
            parameters = payload.setdefault("parameters", {})
            if isinstance(parameters, dict):
                parameters["hotwords"] = list(self.config.hotwords)
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
            response = self._request_json(payload=payload, permit=permit)
        except FamilyModelSettingsError:
            self._settle_before_send_failure(attempt, permit)
            raise
        except ModelUsageContractError:
            self._settle_before_send_failure(attempt, permit)
            raise
        except _ConfirmedAudioProviderFailure as exc:
            self._settle_confirmed_not_executed(attempt, permit, exc.status_code)
            raise audio_provider_error(code="audio_transcription_rejected") from exc
        except _AmbiguousAudioProviderFailure as exc:
            self._mark_uncertain(attempt)
            raise audio_provider_error(code="audio_transcription_unavailable") from exc

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
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError("speech response must be an object")
            text = _extract_dashscope_text(body)
            if not text:
                raise ValueError("transcription result empty")
            return TranscriptionResult(
                text=text,
                language=language,
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
        voice = request.voice or self.config.voice or "Cherry"
        output_format = self.config.output_format or "mp3"
        payload = {
            "model": self.binding.requested_model,
            "input": {
                "text": text,
                "voice": voice,
                "language_type": _REALTIME_LANGUAGE_TYPE,
            },
            "parameters": {
                "format": output_format,
                "sample_rate": _DEFAULT_OUTPUT_SAMPLE_RATE,
            },
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
            response = self._request_json(payload=payload, permit=permit)
        except FamilyModelSettingsError:
            self._settle_before_send_failure(attempt, permit)
            raise
        except ModelUsageContractError:
            self._settle_before_send_failure(attempt, permit)
            raise
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
        try:
            body = response.json()
            if not isinstance(body, dict):
                raise ValueError("speech response must be an object")
            audio_bytes = _extract_dashscope_audio_bytes(body)
            if audio_bytes is None:
                audio_url = _extract_dashscope_audio_url(body)
                if not audio_url:
                    raise ValueError("speech audio missing")
                media = self.dependencies.transport.download_media(
                    audio_url,
                    source=self.binding.endpoint,
                    adapter_kind=self.binding.adapter_kind,
                )
                audio_bytes = media.content
                content_type = media.content_type
            else:
                content_type = _content_type_for_format(output_format)
            if not audio_bytes:
                raise ValueError("speech audio empty")
            return SpeechResult(
                content_type=content_type,
                audio_bytes=audio_bytes,
                audio_stream=None,
                external_url=None,
                external_url_expires_at=None,
            )
        except HTTPException:
            raise
        except Exception as exc:
            # The actual TTS send is already settled.  A media download or
            # decode failure must never trigger another provider request.
            raise audio_provider_error(code="audio_speech_invalid") from exc

    def _request_json(
        self,
        *,
        payload: dict[str, Any],
        permit: DispatchPermit,
    ) -> ProviderResponse:
        credential = None
        try:
            credential = self.dependencies.resolve_dispatch_credential(
                self.binding,
                permit.credential_secret_version_id,
            )
        except (FamilyModelSettingsError, ModelUsageContractError):
            raise
        except Exception as exc:
            raise _AmbiguousAudioProviderFailure() from exc
        if self.binding.auth_mode == "api_key" and not credential.api_key:
            # No transport has been entered yet, so the enclosing operation
            # can safely settle its dispatch permit as confirmed-no-send.
            raise ModelUsageContractError("audio_dispatch_credential_required")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-DashScope-SSE": "disable",
        }
        if credential.api_key:
            headers["Authorization"] = f"Bearer {credential.api_key}"
        if permit.provider_idempotency_key:
            headers["Idempotency-Key"] = permit.provider_idempotency_key
        endpoint_url = binding_endpoint_url(
            self.binding,
            "services/aigc/multimodal-generation/generation",
        )
        try:
            response = self.dependencies.transport.request(
                "POST",
                endpoint_url,
                headers=headers,
                json=payload,
            )
        except Exception as exc:
            # Any transport failure is potentially post-send, including
            # contract errors raised by policy enforcement after the dialer
            # has begun its work.  It must retain the uncertain resend
            # barrier rather than be treated as a credential precondition.
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

    def _settle_before_send_failure(
        self,
        attempt: MeteredProviderAttempt,
        permit: DispatchPermit,
    ) -> None:
        self._settle_confirmed_not_executed(attempt, permit, 0)


class RealtimeAudioProvider:
    """Realtime ASR/TTS over the shared family WebSocket transport.

    Both registered realtime adapter kinds use the same bounded OpenAI-style
    event protocol.  Provider-specific endpoint and credential details remain
    in the immutable binding, never in a client request or Settings object.
    """

    def __init__(
        self,
        config: ResolvedAudioProviderConfig,
        *,
        dependencies: AudioProviderDependencies,
    ) -> None:
        if config.binding.capability != "realtime_audio" or config.binding.adapter_kind not in {
            "dashscope",
            "openai_realtime",
        }:
            raise ModelUsageContractError("realtime_binding_adapter_unsupported")
        self.config = config
        self.dependencies = dependencies

    @property
    def binding(self):
        return self.config.binding

    async def transcribe_realtime_audio(
        self,
        request: TranscriptionRequest,
        *,
        on_delta: Callable[[str], Awaitable[None]] | None = None,
        realtime_usage_scope: RealtimeProviderScope,
        realtime_turn_id: str,
    ) -> TranscriptionResult:
        if "pcm" not in request.content_type.lower():
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail={
                    "code": "realtime_pcm_required",
                    "message": "当前实时语音只支持 PCM 音频，请改用文字或重新开始语音。",
                },
            )
        try:
            duration = measure_audio_duration_seconds(
                request.audio_bytes,
                content_type=request.content_type,
                metadata=request.metadata,
            )
        except AudioDurationError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": exc.code, "message": "无法识别实时语音音频参数。"},
            ) from exc
        if duration > LEASE_SECONDS:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "code": "realtime_audio_lease_duration_exceeded",
                    "message": "单次实时语音片段不能超过 30 秒，请分段说话。",
                },
            )
        async with realtime_usage_scope.provider_audio_operation(
            turn_id=realtime_turn_id,
            segment="duplex",
            direction="input",
            provider_model=self.binding.requested_model,
        ) as operation:
            _require_realtime_operation(operation)
            try:
                transcript = await self._transcribe_over_websocket(
                    request,
                    operation=operation,
                    on_delta=on_delta,
                )
            except _KnownNoSendRealtimeFailure as exc:
                operation.abort_before_provider_send()
                raise exc.cause from exc
            operation.add_input_seconds(duration)
        text = normalize_transcript(transcript)
        if not text:
            raise audio_provider_error(code="audio_transcription_invalid")
        return TranscriptionResult(
            text=text,
            language=request.language_hint or self.config.language_hint,
            duration_seconds=None,
            raw_metadata={"mode": "realtime"},
        )

    async def synthesize_realtime_text(
        self,
        request: SpeechRequest,
        *,
        realtime_usage_scope: RealtimeProviderScope,
        realtime_turn_id: str,
    ) -> SpeechResult:
        text = sanitize_speech_text(request.text)
        voice = request.voice or self.config.voice or "Cherry"
        async with realtime_usage_scope.provider_audio_operation(
            turn_id=realtime_turn_id,
            segment="duplex",
            direction="output",
            provider_model=self.binding.requested_model,
        ) as operation:
            _require_realtime_operation(operation)
            try:
                operation.add_tts_characters(_realtime_tts_characters(self.binding.adapter_kind, text))
                audio_bytes = await self._synthesize_over_websocket(
                    text=text,
                    voice=voice,
                    operation=operation,
                )
            except _KnownNoSendRealtimeFailure as exc:
                operation.abort_before_provider_send()
                raise exc.cause from exc
            operation.add_output_seconds(
                _pcm16_duration_seconds(audio_bytes, sample_rate=_DEFAULT_OUTPUT_SAMPLE_RATE)
            )
        if not audio_bytes:
            raise audio_provider_error(code="audio_speech_invalid")
        return SpeechResult(
            content_type="audio/wav",
            audio_bytes=_pcm16_to_wav(audio_bytes, sample_rate=_DEFAULT_OUTPUT_SAMPLE_RATE),
            audio_stream=None,
            external_url=None,
            external_url_expires_at=None,
        )

    async def stream_realtime_text(
        self,
        text_chunks: AsyncIterator[str],
        request: SpeechRequest,
        *,
        realtime_usage_scope: RealtimeProviderScope,
        realtime_turn_id: str,
    ) -> AsyncIterator[dict[str, Any]]:
        voice = request.voice or self.config.voice or "Cherry"
        yield {
            "type": "audio_start",
            "content_type": "audio/pcm",
            "format": "pcm16",
            "sample_rate": _DEFAULT_OUTPUT_SAMPLE_RATE,
            "channels": 1,
        }
        sequence = 0
        async with realtime_usage_scope.provider_audio_operation(
            turn_id=realtime_turn_id,
            segment="duplex",
            direction="output",
            provider_model=self.binding.requested_model,
        ) as operation:
            _require_realtime_operation(operation)
            try:
                async with self._websocket(operation) as websocket:
                    await _ws_send(
                        websocket,
                        _session_update_event(
                            voice=voice,
                            mode="commit",
                            input_transcription=False,
                        ),
                    )
                    segment_sequence = 0
                    async for raw_text in text_chunks:
                        try:
                            text = sanitize_speech_text(raw_text, max_chars=1000)
                        except HTTPException:
                            continue
                        if not text:
                            continue
                        operation.add_tts_characters(
                            _realtime_tts_characters(self.binding.adapter_kind, text)
                        )
                        segment_sequence += 1
                        await _ws_send(websocket, _text_append_event(text))
                        await _ws_send(websocket, _commit_event())
                        yield {
                            "type": "audio_trace",
                            "stage": "tts_segment_commit",
                            "segment_sequence": segment_sequence,
                            "chars": len(text),
                        }
                    await _ws_send(websocket, _finish_event())
                    while True:
                        event = await _next_event(websocket)
                        if event is None:
                            continue
                        audio = _event_audio(event)
                        if audio is not None:
                            operation.add_output_seconds(
                                _pcm16_duration_seconds(
                                    audio, sample_rate=_DEFAULT_OUTPUT_SAMPLE_RATE
                                )
                            )
                            sequence += 1
                            yield {
                                "type": "audio_delta",
                                "audio": base64.b64encode(audio).decode("ascii"),
                                "sequence": sequence,
                            }
                            continue
                        if event.get("type") == "session.finished":
                            break
                        _raise_provider_event_error(event)
            except _KnownNoSendRealtimeFailure as exc:
                operation.abort_before_provider_send()
                raise exc.cause from exc
        yield {"type": "audio_done", "sequence": sequence}

    async def _transcribe_over_websocket(
        self,
        request: TranscriptionRequest,
        *,
        operation: RealtimeProviderOperation,
        on_delta: Callable[[str], Awaitable[None]] | None,
    ) -> str:
        async with self._websocket(operation) as websocket:
            await _ws_send(
                websocket,
                _session_update_event(
                    voice=None,
                    mode=None,
                    input_transcription=True,
                    language=request.language_hint or self.config.language_hint,
                    sample_rate=_metadata_sample_rate(
                        request.metadata, _DEFAULT_INPUT_SAMPLE_RATE
                    ),
                ),
            )
            for offset in range(0, len(request.audio_bytes), 3200):
                await _ws_send(
                    websocket,
                    _audio_append_event(request.audio_bytes[offset : offset + 3200]),
                )
            await _ws_send(websocket, _audio_commit_event())
            await _ws_send(websocket, _finish_event())
            while True:
                event = await _next_event(websocket)
                if event is None:
                    continue
                delta = _extract_qwen_asr_delta_text(event)
                if delta and on_delta is not None:
                    await on_delta(delta)
                text = _extract_qwen_asr_completed_text(event)
                if text:
                    return text
                if event.get("type") == "session.finished":
                    return ""
                _raise_provider_event_error(event)

    async def _synthesize_over_websocket(
        self,
        *,
        text: str,
        voice: str,
        operation: RealtimeProviderOperation,
    ) -> bytes:
        chunks: list[bytes] = []
        async with self._websocket(operation) as websocket:
            await _ws_send(
                websocket,
                _session_update_event(
                    voice=voice,
                    mode="commit",
                    input_transcription=False,
                ),
            )
            await _ws_send(websocket, _text_append_event(text))
            await _ws_send(websocket, _commit_event())
            await _ws_send(websocket, _finish_event())
            while True:
                event = await _next_event(websocket)
                if event is None:
                    continue
                audio = _event_audio(event)
                if audio is not None:
                    chunks.append(audio)
                    continue
                if event.get("type") == "session.finished":
                    break
                _raise_provider_event_error(event)
        return b"".join(chunks)

    @asynccontextmanager
    async def _websocket(self, operation: RealtimeProviderOperation) -> AsyncIterator[object]:
        lease = operation.lease
        if lease is None:
            raise ModelUsageContractError("realtime_provider_send_not_authorized")
        credential = None
        websocket = None
        try:
            credential = self.dependencies.resolve_dispatch_credential(
                self.binding,
                lease.dispatch_permit.credential_secret_version_id,
            )
        except (FamilyModelSettingsError, ModelUsageContractError) as exc:
            # Credential resolution occurs before a WebSocket can be opened.
            # Keep this distinct from policy/dialer failures, which are
            # potentially post-send and therefore must remain uncertain.
            raise _KnownNoSendRealtimeFailure(exc) from exc
        if self.binding.auth_mode == "api_key" and not credential.api_key:
            raise _KnownNoSendRealtimeFailure(
                ModelUsageContractError("audio_dispatch_credential_required")
            )
        headers = {} if self.binding.adapter_kind == "dashscope" else {"OpenAI-Beta": "realtime=v1"}
        if credential.api_key:
            headers["Authorization"] = f"Bearer {credential.api_key}"
        endpoint_url = realtime_endpoint_url(self.binding)
        try:
            websocket = await asyncio.to_thread(
                self.dependencies.transport.connect_websocket,
                endpoint_url,
                headers=headers,
            )
        except Exception as exc:
            # A transport policy/dialer error can occur after the remote side
            # has observed the handshake; preserve the usage uncertainty
            # barrier instead of treating it as a credential failure.
            raise audio_provider_error(code="realtime_audio_unavailable") from exc
        finally:
            credential = None
        try:
            yield websocket
        except HTTPException:
            raise
        except FamilyModelSettingsError:
            raise
        except Exception as exc:
            raise audio_provider_error(code="realtime_audio_unavailable") from exc
        finally:
            if websocket is not None:
                try:
                    await asyncio.to_thread(getattr(websocket, "close"))
                except Exception:
                    pass


def _require_realtime_operation(operation: RealtimeProviderOperation) -> None:
    if operation.decision not in {"active", "renewed"}:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": operation.error_code or "model_usage_realtime_unavailable",
                "message": "本次语音会话已结束，可以继续使用文字。",
            },
        )


async def _ws_send(websocket: object, event: dict[str, Any]) -> None:
    try:
        await asyncio.to_thread(getattr(websocket, "send"), json.dumps(event, ensure_ascii=False))
    except Exception as exc:
        raise audio_provider_error(code="realtime_audio_unavailable") from exc


async def _next_event(websocket: object) -> dict[str, Any] | None:
    try:
        message = await asyncio.wait_for(
            asyncio.to_thread(getattr(websocket, "recv")), timeout=45.0
        )
    except TimeoutError as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail={"code": "realtime_audio_timeout", "message": "实时语音服务响应超时，请继续使用文字。"},
        ) from exc
    except Exception as exc:
        raise audio_provider_error(code="realtime_audio_unavailable") from exc
    if isinstance(message, bytes):
        return {"type": "response.audio.delta", "_audio": message}
    if not isinstance(message, str):
        return None
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _event_audio(event: dict[str, Any]) -> bytes | None:
    direct = event.get("_audio")
    if isinstance(direct, bytes):
        return direct
    if event.get("type") != "response.audio.delta":
        return None
    value = event.get("delta")
    if not isinstance(value, str):
        return None
    try:
        return base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise audio_provider_error(code="realtime_audio_invalid") from exc


def _raise_provider_event_error(event: dict[str, Any]) -> None:
    if event.get("type") != "error":
        return
    raise audio_provider_error(code="realtime_audio_rejected")


def _session_update_event(
    *,
    voice: str | None,
    mode: str | None,
    input_transcription: bool,
    language: str | None = None,
    sample_rate: int = _DEFAULT_OUTPUT_SAMPLE_RATE,
) -> dict[str, Any]:
    session: dict[str, Any] = {
        "input_audio_format": "pcm",
        "sample_rate": sample_rate,
        "turn_detection": None,
    }
    if input_transcription:
        session["modalities"] = ["text"]
        if language and language != "auto":
            session["input_audio_transcription"] = {"language": language}
    else:
        session.update(
            {
                "mode": mode or "commit",
                "voice": voice or "Cherry",
                "language_type": _REALTIME_LANGUAGE_TYPE,
                "response_format": _REALTIME_AUDIO_FORMAT,
                "sample_rate": _DEFAULT_OUTPUT_SAMPLE_RATE,
            }
        )
    return {"event_id": _event_id(), "type": "session.update", "session": session}


def _audio_append_event(payload: bytes) -> dict[str, str]:
    return {
        "event_id": _event_id(),
        "type": "input_audio_buffer.append",
        "audio": base64.b64encode(payload).decode("ascii"),
    }


def _audio_commit_event() -> dict[str, str]:
    return {"event_id": _event_id(), "type": "input_audio_buffer.commit"}


def _text_append_event(text: str) -> dict[str, str]:
    return {"event_id": _event_id(), "type": "input_text_buffer.append", "text": text}


def _commit_event() -> dict[str, str]:
    return {"event_id": _event_id(), "type": "input_text_buffer.commit"}


def _finish_event() -> dict[str, str]:
    return {"event_id": _event_id(), "type": "session.finish"}


def _event_id() -> str:
    return f"event_{uuid4().hex}"


def _dashscope_stt_payload(
    *,
    model: str,
    audio_data_url: str,
    content_type: str,
    sample_rate: int,
) -> dict[str, Any]:
    if model.startswith("qwen3-asr-flash"):
        return {
            "model": model,
            "input": {
                "messages": [
                    {"role": "system", "content": [{"text": ""}]},
                    {"role": "user", "content": [{"audio": audio_data_url}]},
                ]
            },
            "parameters": {
                "asr_options": {"enable_itn": False},
                "format": _dashscope_format(content_type),
                "sample_rate": str(sample_rate),
            },
        }
    return {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": audio_data_url},
                        }
                    ],
                }
            ]
        },
        "parameters": {
            "format": _dashscope_format(content_type),
            "sample_rate": str(sample_rate),
        },
    }


def _dashscope_format(content_type: str) -> str:
    lowered = content_type.lower()
    if "wav" in lowered:
        return "wav"
    if "mpeg" in lowered or "mp3" in lowered:
        return "mp3"
    if "mp4" in lowered or "m4a" in lowered:
        return "mp4"
    return "wav"


def _extract_dashscope_text(body: dict[str, Any]) -> str:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    choices = output.get("choices") if isinstance(output.get("choices"), list) else []
    first_choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    message = first_choice.get("message") if isinstance(first_choice.get("message"), dict) else {}
    candidates = [output.get("text"), output.get("transcription"), message.get("content")]
    for value in candidates:
        if isinstance(value, str) and normalize_transcript(value):
            return normalize_transcript(value)
        if isinstance(value, list):
            joined = " ".join(
                str(item.get("text") or item)
                for item in value
                if isinstance(item, dict)
            )
            if normalize_transcript(joined):
                return normalize_transcript(joined)
    return ""


def _extract_dashscope_audio_bytes(body: dict[str, Any]) -> bytes | None:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    audio = output.get("audio") if isinstance(output.get("audio"), dict) else {}
    for value in (audio.get("data"), output.get("data")):
        if isinstance(value, str) and value:
            try:
                return base64.b64decode(value, validate=True)
            except ValueError as exc:
                raise ValueError("audio payload invalid") from exc
    return None


def _extract_dashscope_audio_url(body: dict[str, Any]) -> str:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    audio = output.get("audio") if isinstance(output.get("audio"), dict) else {}
    for value in (audio.get("url"), output.get("url")):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _content_type_for_format(audio_format: str) -> str:
    return {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
        "mp4": "audio/mp4",
        "pcm": "audio/wav",
    }.get(audio_format.lower(), "audio/mpeg")


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
    try:
        payload = response.json()
    except Exception:
        return None
    return payload.get("usage") if isinstance(payload, dict) else None


def _metadata_sample_rate(metadata: dict[str, object], fallback: int) -> int:
    value = metadata.get("sample_rate") if isinstance(metadata, dict) else None
    if isinstance(value, bool):
        return fallback
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed in {8000, 16000, 24000, 48000} else fallback


def _extract_qwen_asr_completed_text(event: dict[str, Any]) -> str:
    if event.get("type") != "conversation.item.input_audio_transcription.completed":
        return ""
    value = event.get("transcript")
    return normalize_transcript(value) if isinstance(value, str) else ""


def _extract_qwen_asr_delta_text(event: dict[str, Any]) -> str:
    if event.get("type") not in {
        "conversation.item.input_audio_transcription.text",
        "conversation.item.input_audio_transcription.delta",
    }:
        return ""
    for key in ("text", "delta", "transcript"):
        value = event.get(key)
        if isinstance(value, str) and normalize_transcript(value):
            return normalize_transcript(value)
    return ""


def _realtime_tts_characters(adapter_kind: str, text: str) -> int:
    return dashscope_tts_billable_characters(text) if adapter_kind == "dashscope" else len(text)


def _pcm16_duration_seconds(payload: bytes, *, sample_rate: int) -> Decimal:
    if isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0:
        raise audio_provider_error(code="realtime_audio_invalid")
    if not payload or len(payload) % 2:
        raise audio_provider_error(code="realtime_audio_invalid")
    return quantize_quantity(Decimal(len(payload) // 2) / Decimal(sample_rate))


def _pcm16_to_wav(payload: bytes, *, sample_rate: int) -> bytes:
    import wave
    from io import BytesIO

    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(payload)
    return output.getvalue()
