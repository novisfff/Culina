from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import timedelta
from decimal import Decimal
from threading import RLock
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import ModelUsageCapability
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.services.ai_audio.config import (
    ResolvedAudioProviderConfig,
    resolved_audio_provider_config,
)
from app.services.ai_audio.dashscope_audio import (
    DashScopeAudioProvider,
    RealtimeAudioProvider,
)
from app.services.ai_audio.openai_audio import OpenAIAudioProvider
from app.services.ai_audio.providers import (
    AudioProviderDependencies,
    audio_capability_error,
)
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
from app.services.access_tickets import create_realtime_websocket_ticket
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderTransport
from app.services.family_model_settings.types import ResolvedCapabilityBinding
from app.services.model_usage.adapters.audio import AudioUsageAdapter
from app.services.model_usage.adapters.realtime_audio import RealtimeAudioUsageAdapter
from app.services.model_usage.errors import (
    ModelUsageBlocked,
    ModelUsageContractError,
    ModelUsageError,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring


class SpeechResultCache:
    """Small process-local cache for successful normal TTS responses.

    Cache keys include immutable binding identity, so a newly published model or
    profile cannot receive bytes generated under a prior family configuration.
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


@dataclass(frozen=True, slots=True)
class AudioDependencies:
    """Factories for request-scoped, non-secret audio infrastructure."""

    resolver_factory: Callable[[Session], FamilyModelConfigurationResolver]
    transport_factory: Callable[[FamilyModelConfigurationResolver], ProviderTransport]
    session_factory: Callable[[], Session]
    settings_factory: Callable[[], object]

    @classmethod
    def production(cls) -> "AudioDependencies":
        return cls(
            resolver_factory=lambda db: FamilyModelConfigurationResolver(db),
            transport_factory=lambda resolver: ProviderTransport.from_settings(
                get_settings(), policy=resolver.network_policy
            ),
            session_factory=SessionLocal,
            settings_factory=get_settings,
        )


@dataclass(frozen=True, slots=True)
class CookingVoiceRuntime:
    """An ephemeral or persisted realtime session plus its bound provider."""

    session: RealtimeVoiceSessionState
    provider: RealtimeAudioProvider


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


def _usage_error_response(exc: ModelUsageError | ModelUsageContractError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"code": exc.code, "message": "当前语音服务暂不可用，请稍后重试。"},
    )


class AIAudioService:
    """Family-scoped audio application service.

    The trusted membership scope enters its constructor.  Requests merely carry
    user-controlled language/voice/content input and are checked again against
    that scope before a provider binding is resolved.
    """

    def __init__(
        self,
        db: Session,
        *,
        family_id: str,
        user_id: str,
        dependencies: AudioDependencies | None = None,
        cache: SpeechResultCache | None = None,
    ) -> None:
        self.db = db
        self.family_id = family_id
        self.user_id = user_id
        self.dependencies = dependencies or AudioDependencies.production()
        self.cache = cache or speech_result_cache

    def transcribe(self, request: TranscriptionRequest) -> TranscriptionResult:
        self._require_request_scope(request.family_id, request.user_id)
        try:
            binding = self._binding("stt")
            config = resolved_audio_provider_config(binding)
        except FamilyModelSettingsError as exc:
            raise audio_capability_error(exc) from exc
        try:
            measured = measure_audio_duration_seconds(
                request.audio_bytes,
                content_type=request.content_type,
                metadata=request.metadata,
                max_duration_seconds=Decimal(
                    str(self._setting("family_model_stt_max_duration_seconds", 60))
                ),
            )
        except AudioDurationError as exc:
            raise _duration_error_response(exc) from exc
        measured_request = replace(request, measured_duration_seconds=measured)
        try:
            provider = self._http_provider(config)
            result = provider.transcribe(measured_request)
        except FamilyModelSettingsError as exc:
            raise audio_capability_error(exc) from exc
        except ModelUsageBlocked as exc:
            raise _usage_block_response(exc, capability=ModelUsageCapability.STT) from exc
        except ModelUsageError as exc:
            raise _usage_error_response(exc) from exc
        except ModelUsageContractError as exc:
            raise _usage_error_response(exc) from exc
        return replace(result, duration_seconds=float(measured))

    @property
    def audio_upload_max_bytes(self) -> int:
        return self._setting("family_model_audio_upload_max_bytes", 10 * 1024 * 1024)

    def synthesize(self, request: SpeechRequest) -> SpeechResult:
        self._require_request_scope(request.family_id, request.user_id)
        try:
            binding = self._binding("tts")
            config = resolved_audio_provider_config(binding)
        except FamilyModelSettingsError as exc:
            raise audio_capability_error(exc) from exc
        text = sanitize_speech_text(
            request.text,
            max_chars=int(self._setting("family_model_tts_max_characters", 300)),
        )
        voice = request.voice or config.voice or "default"
        cache_key = _speech_cache_key(
            family_id=self.family_id,
            user_id=self.user_id,
            binding=binding,
            voice=voice,
            text=text,
        )
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            result = self._http_provider(config).synthesize(replace(request, text=text))
        except FamilyModelSettingsError as exc:
            raise audio_capability_error(exc) from exc
        except ModelUsageBlocked as exc:
            raise _usage_block_response(exc, capability=ModelUsageCapability.TTS) from exc
        except ModelUsageError as exc:
            raise _usage_error_response(exc) from exc
        except ModelUsageContractError as exc:
            raise _usage_error_response(exc) from exc
        self.cache.put(cache_key, result)
        return result

    def create_cooking_session(
        self,
        request: CookingRealtimeSessionRequest,
    ) -> CookingRealtimeSession:
        runtime = self._new_realtime_runtime(request, register=True)
        connection_ticket = create_realtime_websocket_ticket(
            session_id=runtime.session.session_id,
            family_id=runtime.session.family_id,
            user_id=runtime.session.user_id,
        )
        runtime.session.connection_ticket_id = connection_ticket.ticket_id
        return CookingRealtimeSession(
            mode="agent_backed_websocket",
            session_id=runtime.session.session_id,
            websocket_url=(
                f"/api/ai/realtime/cooking/sessions/{runtime.session.session_id}/ws"
            ),
            websocket_ticket=connection_ticket.token,
            websocket_ticket_expires_at=connection_ticket.expires_at,
            expires_at=runtime.session.expires_at,
        )

    def prepare_cooking_voice_stream(
        self,
        request: CookingRealtimeSessionRequest,
    ) -> CookingVoiceRuntime:
        """Create an ephemeral, still-metered realtime scope for SSE voice."""

        return self._new_realtime_runtime(request, register=False)

    def realtime_runtime_for_session(
        self,
        session: RealtimeVoiceSessionState,
    ) -> RealtimeAudioProvider:
        """Re-resolve exactly the session revision and verify binding identity."""

        if session.family_id != self.family_id or session.user_id != self.user_id:
            raise FamilyModelSettingsError("family_model_capability_disabled")
        binding = self._resolver().resolve_revision(
            self.family_id,
            session.config_revision_id,
            "realtime_audio",
            "default",
        )
        if not _session_binding_matches(session, binding):
            raise FamilyModelSettingsError("family_model_realtime_binding_changed")
        return self._realtime_provider(binding)

    def _new_realtime_runtime(
        self,
        request: CookingRealtimeSessionRequest,
        *,
        register: bool,
    ) -> CookingVoiceRuntime:
        self._require_request_scope(request.family_id, request.user_id)
        if request.subject.get("source") != "recipe_cook_page":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid cooking voice subject",
            )
        try:
            binding = self._binding("realtime_audio")
            provider = self._realtime_provider(binding)
            adapter = self._realtime_usage_adapter(binding)
        except FamilyModelSettingsError as exc:
            raise audio_capability_error(exc) from exc
        except (ModelUsageError, ModelUsageContractError) as exc:
            raise _usage_error_response(exc) from exc
        created_at = utcnow()
        expires_at = created_at + timedelta(
            seconds=int(
                self._setting("family_model_realtime_session_max_seconds", 300)
            )
        )
        state = RealtimeVoiceSessionState(
            session_id=f"voice_session-{uuid4().hex}",
            family_id=self.family_id,
            user_id=self.user_id,
            config_revision_id=binding.config_revision_id,
            provider_profile_id=binding.provider_profile_id,
            provider_profile_version_id=binding.provider_profile_version_id,
            requested_model=binding.requested_model,
            binding_identity_checksum=_binding_identity_checksum(binding),
            adapter_kind=binding.adapter_kind,
            recipe_id=request.recipe_id,
            cook_session_id=request.cook_session_id,
            session_revision=request.session_revision,
            subject=request.subject,
            created_at=created_at,
            expires_at=expires_at,
        )
        state.realtime_usage_scope = RealtimeProviderScope(
            session=state,
            usage_adapter=adapter,
            schedule_deadlines=register,
        )
        if register:
            realtime_voice_session_store.put(state)
        return CookingVoiceRuntime(session=state, provider=provider)

    def _binding(
        self,
        capability: str,
    ) -> ResolvedCapabilityBinding:
        return self._resolver().resolve_active(
            self.family_id,
            capability,  # type: ignore[arg-type]
            "default",
        )

    def _resolver(self) -> FamilyModelConfigurationResolver:
        return self.dependencies.resolver_factory(self.db)

    def _provider_dependencies(
        self,
        resolver: FamilyModelConfigurationResolver,
    ) -> AudioProviderDependencies:
        return AudioProviderDependencies(
            transport=self.dependencies.transport_factory(resolver),
            resolve_dispatch_credential=resolver.resolve_dispatch_credential,
        )

    def _http_provider(
        self,
        config: ResolvedAudioProviderConfig,
    ) -> OpenAIAudioProvider | DashScopeAudioProvider:
        binding = config.binding
        resolver = self._resolver()
        dependencies = self._provider_dependencies(resolver)
        adapter = AudioUsageAdapter(
            usage_facade=ModelUsageFacade(session_factory=self.dependencies.session_factory),
            session_factory=self.dependencies.session_factory,
            signer=decode_receipt_integrity_keyring(
                self.dependencies.settings_factory()
            ).signer(),
            capability=(
                ModelUsageCapability.STT
                if binding.capability == "stt"
                else ModelUsageCapability.TTS
            ),
            binding=binding,
        )
        if binding.adapter_kind == "openai_compatible_http":
            return OpenAIAudioProvider(
                config,
                dependencies=dependencies,
                usage_adapter=adapter,
            )
        if binding.adapter_kind == "dashscope":
            return DashScopeAudioProvider(
                config,
                dependencies=dependencies,
                usage_adapter=adapter,
            )
        raise FamilyModelSettingsError("family_model_provider_protocol_unsupported")

    def _realtime_provider(
        self,
        binding: ResolvedCapabilityBinding,
    ) -> RealtimeAudioProvider:
        resolver = self._resolver()
        return RealtimeAudioProvider(
            resolved_audio_provider_config(binding),
            dependencies=self._provider_dependencies(resolver),
        )

    def _realtime_usage_adapter(
        self,
        binding: ResolvedCapabilityBinding,
    ) -> RealtimeAudioUsageAdapter:
        return RealtimeAudioUsageAdapter(
            usage_facade=ModelUsageFacade(session_factory=self.dependencies.session_factory),
            session_factory=self.dependencies.session_factory,
            signer=decode_receipt_integrity_keyring(
                self.dependencies.settings_factory()
            ).signer(),
            binding=binding,
        )

    def _require_request_scope(self, family_id: str, user_id: str) -> None:
        if family_id != self.family_id or user_id != self.user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Audio request is not available",
            )

    def _setting(self, name: str, fallback: int) -> int:
        value = getattr(self.dependencies.settings_factory(), name, fallback)
        if isinstance(value, bool):
            return fallback
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return fallback
        return parsed if parsed > 0 else fallback


def _speech_cache_key(
    *,
    family_id: str,
    user_id: str,
    binding: ResolvedCapabilityBinding,
    voice: str,
    text: str,
) -> str:
    material = "\x1f".join(
        (
            family_id,
            user_id,
            binding.config_revision_id,
            binding.provider_profile_id,
            binding.provider_profile_version_id,
            binding.requested_model,
            voice,
            text,
        )
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _binding_identity_checksum(binding: ResolvedCapabilityBinding) -> str:
    """Checksum enough immutable metadata to reject revision/profile drift."""

    payload = {
        "adapter_kind": binding.adapter_kind,
        "billing_model": binding.billing_model,
        "billing_scheme_key": binding.billing_scheme_key,
        "capability": binding.capability,
        "config_revision_id": binding.config_revision_id,
        "options": dict(binding.options),
        "provider_profile_id": binding.provider_profile_id,
        "provider_profile_version_id": binding.provider_profile_version_id,
        "requested_model": binding.requested_model,
        "variant_key": binding.variant_key,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _session_binding_matches(
    session: RealtimeVoiceSessionState,
    binding: ResolvedCapabilityBinding,
) -> bool:
    return (
        binding.config_revision_id == session.config_revision_id
        and binding.provider_profile_id == session.provider_profile_id
        and binding.provider_profile_version_id == session.provider_profile_version_id
        and binding.requested_model == session.requested_model
        and binding.adapter_kind == session.adapter_kind
        and _binding_identity_checksum(binding) == session.binding_identity_checksum
    )
