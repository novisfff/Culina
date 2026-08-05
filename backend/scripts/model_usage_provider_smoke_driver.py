from __future__ import annotations

"""Real-provider smoke driver using Culina's production accounting adapters."""

import asyncio
from dataclasses import dataclass

from sqlalchemy import select

from app.ai.images.generation import (
    ImageGenerationClient,
    ImageGenerationRequest,
    MeteredImageGenerationResult,
    normalize_image_generation_request,
)
from app.ai.images.jobs import _image_usage_adapter_for_request
from app.ai.runtime.factory import build_chat_provider
from app.core.config import get_settings
from app.core.enums import (
    ImageGenerationMode,
    MediaEntityType,
    MembershipStatus,
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageOperationSource,
)
from app.core.utils import create_id
from app.db.session import SessionLocal
from app.models.domain import Family, Membership, User
from app.models.model_usage import ModelUsageEvent, ModelUsageReservation
from app.services.ai_audio.dashscope_audio import DashScopeAudioProvider
from app.services.ai_audio.realtime import realtime_voice_session_store
from app.services.ai_audio.schemas import (
    CookingRealtimeSessionRequest,
    SpeechRequest,
    SpeechResult,
    TranscriptionRequest,
)
from app.services.ai_audio.service import AIAudioService, SpeechResultCache
from app.services.model_usage.preflight import run_first_launch_preflight
from app.services.model_usage.provider_registry import provider_usage_registrations
from app.services.model_usage.types import UsageAttribution
from app.services.search.embeddings import build_embedding_client
from app.services.search.rerank import build_rerank_client


_EXPECTED_CAPABILITIES = frozenset(ModelUsageCapability)


class ProviderSmokeDriverError(RuntimeError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ProviderSmokeResult:
    capability: ModelUsageCapability
    event_id: str


class CulinaProviderSmokeDriver:
    """Send one minimal call per capability through the configured adapters.

    No prompt, transcript, audio, image, URL, provider response, family ID, or
    user ID is returned to the CLI artifact.  The only result is the settled
    model-usage event ID for each capability.
    """

    def __init__(self, *, family_id: str, user_id: str) -> None:
        self.family_id = family_id
        self.user_id = user_id
        self.settings = get_settings()
        self.run_id = create_id("provider-smoke")
        self._tts_result: SpeechResult | None = None
        self._tts_event_id: str | None = None
        self._validated = False

    def run(self, capability: ModelUsageCapability) -> ProviderSmokeResult:
        if not self._validated:
            self._validate_before_provider_send()
            self._validated = True
        handlers = {
            ModelUsageCapability.LLM: self._run_llm,
            ModelUsageCapability.EMBEDDING: self._run_embedding,
            ModelUsageCapability.RERANK: self._run_rerank,
            ModelUsageCapability.STT: self._run_stt,
            ModelUsageCapability.TTS: self._run_tts,
            ModelUsageCapability.REALTIME_AUDIO: self._run_realtime_audio,
            ModelUsageCapability.IMAGE_GENERATION: self._run_image_generation,
        }
        try:
            event_id = handlers[capability]()
        except ProviderSmokeDriverError:
            raise
        except Exception as exc:
            raise ProviderSmokeDriverError(
                f"provider_smoke_{capability.value}_failed"
            ) from exc
        if not event_id:
            raise ProviderSmokeDriverError(
                f"provider_smoke_{capability.value}_event_missing"
            )
        return ProviderSmokeResult(capability=capability, event_id=event_id)

    def _validate_before_provider_send(self) -> None:
        if not bool(getattr(self.settings, "model_usage_required", False)):
            raise ProviderSmokeDriverError("provider_smoke_model_usage_required")
        try:
            registrations = provider_usage_registrations(self.settings)
        except Exception as exc:
            raise ProviderSmokeDriverError("provider_smoke_registry_invalid") from exc
        registered = {item.capability for item in registrations}
        if registered != _EXPECTED_CAPABILITIES:
            raise ProviderSmokeDriverError("provider_smoke_registry_incomplete")

        try:
            preflight = run_first_launch_preflight(self.settings)
        except Exception as exc:
            raise ProviderSmokeDriverError("provider_smoke_preflight_unavailable") from exc
        if not preflight.ready:
            raise ProviderSmokeDriverError("provider_smoke_preflight_not_ready")

        with SessionLocal() as db:
            family_exists = db.get(Family, self.family_id) is not None
            user = db.get(User, self.user_id)
            membership = db.scalar(
                select(Membership).where(
                    Membership.family_id == self.family_id,
                    Membership.user_id == self.user_id,
                    Membership.status == MembershipStatus.ACTIVE,
                )
            )
        if not family_exists or user is None or not user.is_active or membership is None:
            raise ProviderSmokeDriverError("provider_smoke_membership_required")

    def _attribution(
        self,
        *,
        operation_id: str,
        source: ModelUsageOperationSource = ModelUsageOperationSource.INTERACTIVE,
    ) -> UsageAttribution:
        return UsageAttribution(
            family_id=self.family_id,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=self.user_id,
            operation_source=source,
            logical_operation_id=operation_id,
        )

    def _event_for_operation(
        self,
        *,
        capability: ModelUsageCapability,
        operation_id: str,
    ) -> str:
        with SessionLocal() as db:
            event_id = db.scalar(
                select(ModelUsageEvent.id)
                .join(
                    ModelUsageReservation,
                    ModelUsageReservation.id == ModelUsageEvent.reservation_id,
                )
                .where(
                    ModelUsageEvent.family_id == self.family_id,
                    ModelUsageEvent.capability == capability,
                    ModelUsageReservation.logical_operation_id == operation_id,
                )
                .order_by(ModelUsageEvent.created_at.desc())
                .limit(1)
            )
        if not event_id:
            raise ProviderSmokeDriverError(
                f"provider_smoke_{capability.value}_event_missing"
            )
        return event_id

    def _operation_id(self, capability: ModelUsageCapability) -> str:
        return f"{self.run_id}:{capability.value}"

    def _run_llm(self) -> str:
        operation_id = self._operation_id(ModelUsageCapability.LLM)
        result = build_chat_provider(self.settings).generate(
            system="Return one short acknowledgement.",
            user="smoke",
            usage_attribution=self._attribution(operation_id=operation_id),
        )
        if result.status != "completed" or not result.text:
            raise ProviderSmokeDriverError("provider_smoke_llm_result_invalid")
        return self._event_for_operation(
            capability=ModelUsageCapability.LLM,
            operation_id=operation_id,
        )

    def _run_embedding(self) -> str:
        operation_id = self._operation_id(ModelUsageCapability.EMBEDDING)
        result = build_embedding_client().embed_text(
            "smoke",
            attribution=self._attribution(operation_id=operation_id),
            attempt_key=f"{operation_id}:attempt:1",
        )
        if len(result.vectors) != 1 or not result.usage_event_id:
            raise ProviderSmokeDriverError("provider_smoke_embedding_result_invalid")
        return result.usage_event_id

    def _run_rerank(self) -> str:
        operation_id = self._operation_id(ModelUsageCapability.RERANK)
        results = build_rerank_client().rerank(
            query="smoke",
            documents=["smoke", "control"],
            top_n=1,
            attribution=self._attribution(operation_id=operation_id),
            attempt_key=f"{operation_id}:attempt:1",
        )
        if not results:
            raise ProviderSmokeDriverError("provider_smoke_rerank_result_invalid")
        return self._event_for_operation(
            capability=ModelUsageCapability.RERANK,
            operation_id=operation_id,
        )

    def _run_tts(self) -> str:
        if self._tts_result is not None and self._tts_event_id is not None:
            return self._tts_event_id
        operation_id = self._operation_id(ModelUsageCapability.TTS)
        service = AIAudioService(self.settings, cache=SpeechResultCache())
        self._tts_result = service.synthesize(
            SpeechRequest(
                text=f"测试 {self.run_id[-6:]}",
                surface="main_ai",
                family_id=self.family_id,
                user_id=self.user_id,
                operation_id=operation_id,
            )
        )
        if not self._tts_result.audio_bytes:
            raise ProviderSmokeDriverError("provider_smoke_tts_audio_missing")
        self._tts_event_id = self._event_for_operation(
            capability=ModelUsageCapability.TTS,
            operation_id=operation_id,
        )
        return self._tts_event_id

    def _run_stt(self) -> str:
        self._run_tts()
        assert self._tts_result is not None
        assert self._tts_result.audio_bytes is not None
        operation_id = self._operation_id(ModelUsageCapability.STT)
        result = AIAudioService(self.settings).transcribe(
            TranscriptionRequest(
                audio_bytes=self._tts_result.audio_bytes,
                filename="smoke-audio",
                content_type=self._tts_result.content_type,
                surface="main_ai",
                family_id=self.family_id,
                user_id=self.user_id,
                operation_id=operation_id,
            )
        )
        if not result.text:
            raise ProviderSmokeDriverError("provider_smoke_stt_result_invalid")
        return self._event_for_operation(
            capability=ModelUsageCapability.STT,
            operation_id=operation_id,
        )

    def _run_realtime_audio(self) -> str:
        provider = str(getattr(self.settings, "ai_realtime_provider", "") or "").strip().lower()
        if provider != "dashscope":
            raise ProviderSmokeDriverError("provider_smoke_realtime_driver_unsupported")
        operation_id = self._operation_id(ModelUsageCapability.REALTIME_AUDIO)
        session = AIAudioService(self.settings).create_cooking_session(
            CookingRealtimeSessionRequest(
                provider=provider,
                family_id=self.family_id,
                user_id=self.user_id,
                recipe_id="provider-smoke-recipe",
                cook_session_id=self.run_id,
                session_revision=1,
                subject={"source": "recipe_cook_page"},
            )
        )
        try:
            state = realtime_voice_session_store.require_owner(
                session.session_id,
                family_id=self.family_id,
                user_id=self.user_id,
            )
            if state.realtime_usage_scope is None:
                raise ProviderSmokeDriverError("provider_smoke_realtime_adapter_missing")
            result = asyncio.run(
                DashScopeAudioProvider(
                    self.settings,
                    capability="tts",
                ).synthesize_realtime_text(
                    SpeechRequest(
                        text="测试",
                        surface="recipe_cook_page",
                        family_id=self.family_id,
                        user_id=self.user_id,
                        operation_id=operation_id,
                    ),
                    realtime_usage_scope=state.realtime_usage_scope,
                    realtime_turn_id=operation_id,
                )
            )
        finally:
            realtime_voice_session_store.close(session.session_id)
        if not result.audio_bytes:
            raise ProviderSmokeDriverError("provider_smoke_realtime_result_invalid")
        return self._event_for_operation(
            capability=ModelUsageCapability.REALTIME_AUDIO,
            operation_id=operation_id,
        )

    def _run_image_generation(self) -> str:
        operation_id = self._operation_id(ModelUsageCapability.IMAGE_GENERATION)
        request = normalize_image_generation_request(
            ImageGenerationRequest(
                entity_type=MediaEntityType.FOOD,
                mode=ImageGenerationMode.TEXT,
                title="测试",
            )
        )
        adapter = _image_usage_adapter_for_request(request)
        if adapter is None:
            raise ProviderSmokeDriverError("provider_smoke_image_adapter_missing")
        attempt = adapter.begin(
            attribution=self._attribution(
                operation_id=operation_id,
                source=ModelUsageOperationSource.IMAGE_JOB,
            ),
            attempt_key=f"{operation_id}:attempt:1",
            mode=request.mode.value,
            image_count=1,
            size=request.size,
            quality=request.quality,
            fingerprint=adapter.request_fingerprint(
                {"runId": self.run_id, "capability": "image_generation"}
            ),
        )
        result = ImageGenerationClient().generate(
            request,
            usage_attempt=attempt,
            usage_adapter=adapter,
        )
        if not isinstance(result, MeteredImageGenerationResult):
            raise ProviderSmokeDriverError("provider_smoke_image_result_invalid")
        return result.usage_event_id
