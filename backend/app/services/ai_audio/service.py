from __future__ import annotations

import hashlib
from collections import OrderedDict
from dataclasses import replace
from decimal import Decimal
from datetime import timedelta
from threading import RLock
from uuid import uuid4

from fastapi import HTTPException, status

from app.core.config import Settings
from app.core.enums import ModelUsageCapability
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.services.ai_audio.dashscope_audio import DashScopeAudioProvider
from app.services.ai_audio.openai_audio import OpenAIAudioProvider
from app.services.ai_audio.providers import DISABLED_PROVIDERS, normalize_provider, provider_unavailable
from app.services.ai_audio.realtime import (
    RealtimeProviderScope,
    RealtimeVoiceSessionState,
    realtime_voice_session_store,
)
from app.services.ai_audio.schemas import (
    CookingRealtimeSession,
    CookingRealtimeSessionRequest,
    SpeechRequest,
    SpeechResult,
    TranscriptionRequest,
    TranscriptionResult,
)
from app.services.ai_audio.speech import sanitize_speech_text
from app.services.ai_audio.transcription import AudioDurationError, measure_audio_duration_seconds
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.adapters.realtime_audio import RealtimeAudioUsageAdapter
from app.services.model_usage.configured_variants import configured_usage_variants
from app.services.model_usage.errors import (
    ModelUsageBlocked,
    ModelUsageContractError,
    ModelUsageError,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring


class SpeechResultCache:
    """Small process-local cache for successful normal TTS responses.

    Cache keys contain only a SHA-256 digest scoped to the caller family and
    user.  A cache hit deliberately bypasses the external provider and thus
    creates no new usage event.
    """

    def __init__(self, *, max_entries: int = 128) -> None:
        self._max_entries = max_entries
        self._items: OrderedDict[str, SpeechResult] = OrderedDict()
        self._lock = RLock()

    def get(self, key: str) -> SpeechResult | None:
        with self._lock:
            result = self._items.get(key)
            if result is not None:
                self._items.move_to_end(key)
            return result

    def put(self, key: str, result: SpeechResult) -> None:
        if result.audio_bytes is None:
            return
        with self._lock:
            self._items[key] = result
            self._items.move_to_end(key)
            while len(self._items) > self._max_entries:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


speech_result_cache = SpeechResultCache()


def _audio_usage_adapter(
    settings: Settings,
    *,
    provider: str,
    capability: ModelUsageCapability,
) -> AudioUsageAdapter | None:
    if not bool(getattr(settings, "model_usage_required", False)):
        return None
    if capability is ModelUsageCapability.STT:
        model = str(getattr(settings, "ai_stt_model", "") or "").strip() or "gpt-4o-mini-transcribe"
        audio_format = str(getattr(settings, "ai_stt_audio_format", "") or "").strip() or "auto"
        variant_key = f"format={audio_format}"
    else:
        model = str(getattr(settings, "ai_tts_model", "") or "").strip() or "gpt-4o-mini-tts"
        voice = str(getattr(settings, "ai_tts_voice", "") or "").strip() or "default"
        variant_key = f"voice={voice}"
    return AudioUsageAdapter(
        provider=provider,
        model=model,
        capability=capability,
        variant_key=variant_key,
        usage_facade=ModelUsageFacade(session_factory=SessionLocal),
        session_factory=SessionLocal,
        signer=decode_receipt_integrity_keyring(settings).signer(),
    )


def _realtime_usage_adapter(
    settings: Settings,
    *,
    provider: str,
) -> RealtimeAudioUsageAdapter | None:
    """Build the lease adapter without reserving anything for a new session."""

    if not bool(getattr(settings, "model_usage_required", False)):
        return None
    variants = tuple(
        variant
        for variant in configured_usage_variants(settings)
        if variant.capability is ModelUsageCapability.REALTIME_AUDIO
        and variant.provider == provider
    )
    if len(variants) != 1:
        raise ModelUsageContractError("realtime_billing_variant_required")
    return RealtimeAudioUsageAdapter(
        billing_variant=variants[0],
        usage_facade=ModelUsageFacade(session_factory=SessionLocal),
        session_factory=SessionLocal,
        signer=decode_receipt_integrity_keyring(settings).signer(),
    )


def _duration_error_response(exc: AudioDurationError) -> HTTPException:
    if exc.code == "audio_duration_exceeded":
        return HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": exc.code, "message": "音频时长超过当前限制。"},
        )
    if exc.code == "audio_duration_probe_unavailable":
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": exc.code, "message": "当前无法核验音频时长，请稍后重试。"},
        )
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": exc.code, "message": "无法识别音频格式或参数。"},
    )


def _usage_block_response(exc: ModelUsageBlocked, *, capability: ModelUsageCapability) -> HTTPException:
    message = (
        "当前语音额度受限，请改用文字输入。"
        if capability is ModelUsageCapability.STT
        else "当前无法生成语音，文字内容仍可使用。"
    )
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"code": exc.code, "message": message},
    )


def _usage_error_response(exc: ModelUsageError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"code": exc.code, "message": "当前语音服务暂不可用，请稍后重试。"},
    )


class AIAudioService:
    def __init__(self, settings: Settings, *, cache: SpeechResultCache | None = None) -> None:
        self.settings = settings
        self.cache = cache or speech_result_cache

    def transcribe(self, request: TranscriptionRequest, provider: str | None = None) -> TranscriptionResult:
        selected = normalize_provider(provider or self.settings.ai_stt_provider)
        if selected in DISABLED_PROVIDERS:
            raise provider_unavailable(selected, "transcription")
        if selected not in {"openai", "dashscope"}:
            raise provider_unavailable(selected, "transcription")
        try:
            measured = measure_audio_duration_seconds(
                request.audio_bytes,
                content_type=request.content_type,
                metadata=request.metadata,
                max_duration_seconds=Decimal(str(self.settings.ai_stt_max_duration_seconds)),
            )
        except AudioDurationError as exc:
            raise _duration_error_response(exc) from exc
        measured_request = replace(request, measured_duration_seconds=measured)
        try:
            adapter = _audio_usage_adapter(
                self.settings,
                provider=selected,
                capability=ModelUsageCapability.STT,
            )
            required = bool(getattr(self.settings, "model_usage_required", False))
            if selected == "openai":
                result = OpenAIAudioProvider(
                    self.settings,
                    capability="stt",
                    usage_adapter=adapter,
                    model_usage_required=required,
                ).transcribe(measured_request)
            else:
                result = DashScopeAudioProvider(
                    self.settings,
                    capability="stt",
                    usage_adapter=adapter,
                    model_usage_required=required,
                ).transcribe(measured_request)
        except ModelUsageBlocked as exc:
            raise _usage_block_response(exc, capability=ModelUsageCapability.STT) from exc
        except ModelUsageError as exc:
            raise _usage_error_response(exc) from exc
        return replace(result, duration_seconds=float(measured))

    def synthesize(self, request: SpeechRequest, provider: str | None = None) -> SpeechResult:
        selected = normalize_provider(provider or self.settings.ai_tts_provider)
        if selected in DISABLED_PROVIDERS:
            raise provider_unavailable(selected, "speech")
        if selected not in {"openai", "dashscope"}:
            raise provider_unavailable(selected, "speech")
        text = sanitize_speech_text(request.text)
        model = self.settings.ai_tts_model.strip() or "gpt-4o-mini-tts"
        voice = request.voice or self.settings.ai_tts_voice.strip() or "default"
        cache_key = _speech_cache_key(
            family_id=request.family_id,
            user_id=request.user_id,
            provider=selected,
            model=model,
            voice=voice,
            text=text,
        )
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        sanitized_request = replace(request, text=text)
        try:
            adapter = _audio_usage_adapter(
                self.settings,
                provider=selected,
                capability=ModelUsageCapability.TTS,
            )
            required = bool(getattr(self.settings, "model_usage_required", False))
            if selected == "openai":
                result = OpenAIAudioProvider(
                    self.settings,
                    capability="tts",
                    usage_adapter=adapter,
                    model_usage_required=required,
                ).synthesize(sanitized_request)
            else:
                result = DashScopeAudioProvider(
                    self.settings,
                    capability="tts",
                    usage_adapter=adapter,
                    model_usage_required=required,
                ).synthesize(sanitized_request)
        except ModelUsageBlocked as exc:
            raise _usage_block_response(exc, capability=ModelUsageCapability.TTS) from exc
        except ModelUsageError as exc:
            raise _usage_error_response(exc) from exc
        self.cache.put(cache_key, result)
        return result

    def create_cooking_session(self, request: CookingRealtimeSessionRequest) -> CookingRealtimeSession:
        selected = normalize_provider(request.provider or self.settings.ai_realtime_provider)
        if selected in DISABLED_PROVIDERS:
            raise provider_unavailable(selected, "realtime")
        if selected not in {"openai", "dashscope"}:
            raise provider_unavailable(selected, "realtime")
        if request.subject.get("source") != "recipe_cook_page":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid cooking voice subject")
        created_at = utcnow()
        expires_at = created_at + timedelta(seconds=self.settings.ai_realtime_timeout_seconds)
        session_id = f"voice_session-{uuid4().hex}"
        state = RealtimeVoiceSessionState(
            session_id=session_id,
            family_id=request.family_id,
            user_id=request.user_id,
            provider=selected,
            recipe_id=request.recipe_id,
            cook_session_id=request.cook_session_id,
            session_revision=request.session_revision,
            subject=request.subject,
            created_at=created_at,
            expires_at=expires_at,
        )
        try:
            adapter = _realtime_usage_adapter(self.settings, provider=selected)
        except ModelUsageError as exc:
            raise _usage_error_response(exc) from exc
        if adapter is not None:
            state.realtime_usage_scope = RealtimeProviderScope(
                session=state,
                usage_adapter=adapter,
                schedule_deadlines=True,
            )
        realtime_voice_session_store.put(state)
        return CookingRealtimeSession(
            provider=selected,
            mode="agent_backed_websocket",
            session_id=session_id,
            websocket_url=f"/api/ai/realtime/cooking/sessions/{session_id}/ws",
            expires_at=expires_at,
        )


def _speech_cache_key(
    *,
    family_id: str,
    user_id: str,
    provider: str,
    model: str,
    voice: str,
    text: str,
) -> str:
    material = "\x1f".join((family_id, user_id, provider, model, voice, text)).encode("utf-8")
    return hashlib.sha256(material).hexdigest()
