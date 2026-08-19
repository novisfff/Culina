from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app.ai.images.generation import (
    ImageGenerationClient,
    ImageGenerationRequest,
    ImageProviderDependencies,
)
from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.api import family_model_settings as family_model_settings_api
from app.core.enums import (
    ImageGenerationMode,
    MediaEntityType,
    ModelUsageAttributionKind,
    ModelUsageOperationSource,
)
from app.main import app
from app.models.family_model_settings import FamilyModelSettings, FamilySearchProfile
from app.models.model_usage import ModelUsageEvent, ModelUsageReservation
from app.repos.family_model_settings.search_profiles import list_profile_documents
from app.services.ai_audio.schemas import (
    CookingRealtimeSessionRequest,
    SpeechRequest,
    TranscriptionRequest,
)
from app.services.ai_audio.service import AIAudioService, AudioDependencies
from app.services.family_model_settings.capability_tests import CapabilityTestDependencies
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.search_profiles import (
    activate_ready_search_profile,
    seed_search_profile_documents,
)
from app.services.family_model_settings.types import EmbeddingUsageSnapshot
from app.services.model_usage.adapters.embedding import EmbeddingUsageDependencies
from app.services.model_usage.adapters.image_generation import ImageGenerationUsageAdapter
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.adapters.rerank import RerankUsageDependencies
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import UsageAttribution
from app.services.search.embeddings import build_embedding_client
from app.services.search.rerank import RerankDependencies, build_rerank_client

from tests.family_model_settings.fake_provider import FakeFamilyModelProvider
from tests.family_model_settings._support import (
    SECRET_MARKER,
    FamilyModelApiContext,
    family_model_api,
)
from tests.family_model_settings.test_capability_tests import (
    _publish_all_capabilities,
    _publish_llm,
)


@pytest.fixture()
def fake_provider(family_model_api: FamilyModelApiContext) -> FakeFamilyModelProvider:
    """Route the Owner capability API through the protocol-faithful fake."""

    provider = FakeFamilyModelProvider()
    app.dependency_overrides[
        family_model_settings_api.get_family_model_capability_test_dependencies
    ] = lambda: CapabilityTestDependencies(
        cipher=family_model_api.cipher,
        network_policy=family_model_api.policy,
        transport=provider,  # type: ignore[arg-type]
        usage_facade=ModelUsageFacade(session_factory=family_model_api.session_factory),
        signer=ProviderUsageReceiptSigner(
            active_key_id="protocol-acceptance",
            keys={"protocol-acceptance": b"family-model-protocol-acceptance-key"},
        ),
        session_factory=family_model_api.session_factory,
    )
    return provider


@dataclass(frozen=True, slots=True)
class _RealDispatchResult:
    completed_or_streamed: bool


def _protocol_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="protocol-acceptance",
        keys={"protocol-acceptance": b"family-model-protocol-acceptance-key"},
    )


def _resolver(context: FamilyModelApiContext, db) -> FamilyModelConfigurationResolver:
    return FamilyModelConfigurationResolver(
        db,
        network_policy=context.policy,
        cipher=context.cipher,
    )


def _resolve_credential(context: FamilyModelApiContext):
    def resolve(binding, secret_version_id):
        with context.session_factory() as db:
            return _resolver(context, db).resolve_dispatch_credential(
                binding,
                secret_version_id,
            )

    return resolve


def _attribution(*, capability: str) -> UsageAttribution:
    return UsageAttribution(
        family_id="family-a",
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id="owner-a",
        operation_source=(
            ModelUsageOperationSource.IMAGE_JOB
            if capability == "image_generation"
            else ModelUsageOperationSource.INTERACTIVE
        ),
        logical_operation_id=f"protocol-acceptance-{capability}",
    )


def _audio_dependencies(
    context: FamilyModelApiContext,
    provider: FakeFamilyModelProvider,
) -> AudioDependencies:
    settings = SimpleNamespace(
        family_model_audio_upload_max_bytes=10 * 1024 * 1024,
        family_model_stt_max_duration_seconds=60,
        family_model_tts_max_characters=300,
        family_model_realtime_session_max_seconds=300,
        model_usage_receipt_integrity_active_key_id="protocol-acceptance",
        model_usage_receipt_integrity_keys_json=SecretStr(
            json.dumps(
                {
                    "protocol-acceptance": {
                        "key": "family-model-protocol-acceptance-key"
                    }
                }
            )
        ),
    )
    return AudioDependencies(
        resolver_factory=lambda db: _resolver(context, db),
        transport_factory=lambda _resolver_: provider,  # type: ignore[arg-type]
        session_factory=context.session_factory,
        settings_factory=lambda: settings,
    )


def _activate_published_search_profile(context: FamilyModelApiContext) -> str:
    with context.session_factory() as db:
        profile = db.scalar(
            select(FamilySearchProfile).where(FamilySearchProfile.family_id == "family-a")
        )
        assert profile is not None
        seed_search_profile_documents(
            db,
            family_id="family-a",
            profile_id=profile.id,
            enqueue_jobs=False,
        )
        for row in list_profile_documents(
            db,
            family_id="family-a",
            search_profile_id=profile.id,
            for_update=True,
        ):
            row.status = "indexed"
        activate_ready_search_profile(
            db,
            family_id="family-a",
            profile_id=profile.id,
            actor_user_id="owner-a",
        )
        db.commit()
        return profile.id


async def _dispatch_realtime_audio(
    service: AIAudioService,
) -> bool:
    runtime = service.prepare_cooking_voice_stream(
        CookingRealtimeSessionRequest(
            family_id="family-a",
            user_id="owner-a",
            recipe_id="recipe-protocol-acceptance",
            cook_session_id="cook-protocol-acceptance",
            session_revision=1,
            subject={"source": "recipe_cook_page"},
        )
    )
    usage_scope = runtime.session.realtime_usage_scope
    assert usage_scope is not None
    speech = await runtime.provider.synthesize_realtime_text(
        SpeechRequest(
            text="开始烹饪",
            surface="recipe_cook_page",
            family_id="family-a",
            user_id="owner-a",
            operation_id="protocol-acceptance-realtime",
        ),
        realtime_usage_scope=usage_scope,
        realtime_turn_id="protocol-acceptance-turn",
    )
    outcome = await usage_scope.finish_current_lease_once(
        completion_reason="protocol_acceptance_complete"
    )
    return bool(speech.audio_bytes) and outcome.settlement is not None


def dispatch_real_family_operation(
    context: FamilyModelApiContext,
    provider: FakeFamilyModelProvider,
    *,
    capability: str,
    variant: str,
) -> _RealDispatchResult:
    """Dispatch through the same production clients used by product surfaces."""

    facade = ModelUsageFacade(session_factory=context.session_factory)
    signer = _protocol_signer()
    credential_resolver = _resolve_credential(context)

    if capability == "llm":
        with context.session_factory() as db:
            binding = _resolver(context, db).resolve_active(
                "family-a", "llm", variant
            )
        runtime = OpenAICompatibleChatProvider(
            binding=binding,
            transport=provider,  # type: ignore[arg-type]
            resolve_dispatch_credential=credential_resolver,
            usage_adapter=LLMUsageAdapter(
                usage_facade=facade,
                session_factory=context.session_factory,
                signer=signer,
                binding=binding,
            ),
            model_usage_required=True,
        )
        generated = runtime.generate(
            system="只回复已完成",
            user="执行家庭模型协议验收",
            usage_attribution=_attribution(capability=capability),
        )
        return _RealDispatchResult(completed_or_streamed=bool(generated.text))

    if capability == "image_generation":
        with context.session_factory() as db:
            binding = _resolver(context, db).resolve_active(
                "family-a", "image_generation", variant
            )
        adapter = ImageGenerationUsageAdapter(
            usage_facade=facade,
            session_factory=context.session_factory,
            signer=signer,
            binding=binding,
        )
        request = ImageGenerationRequest(
            entity_type=MediaEntityType.FOOD,
            mode=ImageGenerationMode.TEXT,
            title="番茄炒蛋",
            size="1024x1024",
        )
        attempt = adapter.begin_image(
            attribution=_attribution(capability=capability),
            binding=binding,
            attempt_key="protocol-acceptance-image",
            request=request,
            fingerprint=adapter.request_fingerprint({"title": request.title}),
        )
        generated = ImageGenerationClient.for_binding(
            binding,
            dependencies=ImageProviderDependencies(
                transport=provider,  # type: ignore[arg-type]
                resolve_dispatch_credential=credential_resolver,
            ),
        ).generate(request, usage_attempt=attempt, usage_adapter=adapter)
        return _RealDispatchResult(
            completed_or_streamed=bool(generated.image.binary_content)
        )

    if capability in {"stt", "tts", "realtime_audio"}:
        with context.session_factory() as db:
            service = AIAudioService(
                db,
                family_id="family-a",
                user_id="owner-a",
                dependencies=_audio_dependencies(context, provider),
            )
            if capability == "stt":
                transcription = service.transcribe(
                    TranscriptionRequest(
                        audio_bytes=b"\x00\x00" * 16000,
                        filename="protocol.pcm",
                        content_type="audio/pcm",
                        surface="main_ai",
                        family_id="family-a",
                        user_id="owner-a",
                        operation_id="protocol-acceptance-stt",
                        metadata={
                            "sample_rate": 16000,
                            "sample_width_bytes": 2,
                            "channels": 1,
                        },
                    )
                )
                completed = bool(transcription.text)
            elif capability == "tts":
                speech = service.synthesize(
                    SpeechRequest(
                        text="家庭语音协议验收",
                        surface="recipe_cook_page",
                        family_id="family-a",
                        user_id="owner-a",
                        operation_id="protocol-acceptance-tts",
                    )
                )
                completed = bool(speech.audio_bytes)
            else:
                completed = asyncio.run(_dispatch_realtime_audio(service))
        return _RealDispatchResult(completed_or_streamed=completed)

    if capability == "embedding":
        profile_id = _activate_published_search_profile(context)
        with context.session_factory() as db:
            resolver = _resolver(context, db)
            profile = resolver.resolve_search_profile("family-a", profile_id)
            settings = db.get(FamilyModelSettings, "family-a")
            assert (
                settings is not None
                and settings.active_config_revision_id is not None
                and settings.active_price_version_id is not None
            )
            usage_snapshot = EmbeddingUsageSnapshot(
                config_revision_id=settings.active_config_revision_id,
                price_version_id=settings.active_price_version_id,
                candidate=False,
            )
        client = build_embedding_client(
            profile,
            transport=provider,  # type: ignore[arg-type]
            usage_dependencies=EmbeddingUsageDependencies(
                usage_facade=facade,
                session_factory=context.session_factory,
                signer=signer,
            ),
            resolve_dispatch_credential=credential_resolver,
        )
        embedded = client.embed_text(
            "番茄",
            attribution=_attribution(capability=capability),
            attempt_key="protocol-acceptance-embedding",
            usage_snapshot=usage_snapshot,
        )
        return _RealDispatchResult(completed_or_streamed=bool(embedded.vectors))

    if capability == "rerank":
        with context.session_factory() as db:
            binding = _resolver(context, db).resolve_active(
                "family-a", "rerank", variant
            )
            settings = db.get(FamilyModelSettings, "family-a")
            assert settings is not None and settings.active_price_version_id is not None
            price_version_id = settings.active_price_version_id
        reranked = build_rerank_client(
            binding,
            dependencies=RerankDependencies(
                transport=provider,  # type: ignore[arg-type]
                usage=RerankUsageDependencies(
                    usage_facade=facade,
                    session_factory=context.session_factory,
                    signer=signer,
                    price_version_id=price_version_id,
                ),
                resolve_dispatch_credential=credential_resolver,
            ),
        ).rerank(
            query="鸡肉",
            documents=["三黄鸡"],
            top_n=1,
            attribution=_attribution(capability=capability),
            attempt_key="protocol-acceptance-rerank",
        )
        return _RealDispatchResult(completed_or_streamed=bool(reranked))

    raise AssertionError(f"unsupported protocol acceptance capability: {capability}")


def _assert_snapshot(
    context: FamilyModelApiContext,
    *,
    capability: str,
    variant: str,
) -> ModelUsageReservation:
    with context.session_factory() as db:
        reservations = list(
            db.scalars(
                select(ModelUsageReservation).where(
                    ModelUsageReservation.family_id == "family-a",
                    ModelUsageReservation.capability == capability,
                    ModelUsageReservation.variant_key == variant,
                )
            )
        )
        assert len(reservations) == 1
        reservation = reservations[0]
        assert reservation.config_revision_id
        assert reservation.provider_profile_id
        assert reservation.provider_profile_version_id
        assert reservation.credential_secret_version_id
        assert reservation.price_version_id
        assert reservation.price_snapshot_checksum
        event = db.scalar(
            select(ModelUsageEvent).where(ModelUsageEvent.reservation_id == reservation.id)
        )
        assert event is not None
        assert event.config_revision_id == reservation.config_revision_id
        assert event.provider_profile_id == reservation.provider_profile_id
        assert event.provider_profile_version_id == reservation.provider_profile_version_id
        assert event.price_version_id == reservation.price_version_id
        assert event.price_snapshot_checksum == reservation.price_snapshot_checksum
        return reservation


def test_fake_provider_records_only_test_local_secret_markers() -> None:
    provider = FakeFamilyModelProvider()

    assert provider.requests_for("not-sent") == []


@pytest.mark.parametrize(
    ("capability", "variant", "model", "path"),
    (
        ("llm", "primary", "capability-test-llm", "/v1/chat/completions"),
        ("image_generation", "text", "capability-test-image", "/v1/images/generations"),
        ("stt", "default", "capability-test-stt", "/v1/audio/transcriptions"),
        ("tts", "default", "capability-test-tts", "/v1/audio/speech"),
        ("realtime_audio", "default", "capability-test-realtime", "/realtime"),
        ("embedding", "search", "capability-test-embedding", "/v1/embeddings"),
        ("rerank", "search", "capability-test-rerank", "/v1/rerank"),
    ),
)
def test_published_family_dispatches_each_capability_through_its_snapshot(
    family_model_api: FamilyModelApiContext,
    fake_provider: FakeFamilyModelProvider,
    capability: str,
    variant: str,
    model: str,
    path: str,
) -> None:
    _publish_all_capabilities(family_model_api)

    result = dispatch_real_family_operation(
        family_model_api,
        fake_provider,
        capability=capability,
        variant=variant,
    )

    assert result.completed_or_streamed
    reservation = _assert_snapshot(
        family_model_api,
        capability=capability,
        variant=variant,
    )
    requests = fake_provider.requests_for(SECRET_MARKER)
    if capability == "realtime_audio":
        handshakes = [request for request in requests if request.protocol == "websocket"]
        frames = [request for request in requests if request.protocol == "websocket_frame"]
        assert len(handshakes) == 1
        assert len(frames) == 4
        assert handshakes[0].path == path
        assert handshakes[0].model == model
        assert [
            frame.body.get("type")
            for frame in frames
            if isinstance(frame.body, dict)
        ] == [
            "session.update",
            "input_text_buffer.append",
            "input_text_buffer.commit",
            "session.finish",
        ]
    else:
        assert len(requests) == 1
        request = requests[0]
        assert request.protocol == "http"
        assert request.path == path
        assert request.model == model
        if capability == "stt":
            assert isinstance(request.body, bytes)
            assert b'name="file"' in request.body
        else:
            assert isinstance(request.body, dict)
            assert request.body["model"] == model
    assert reservation.requested_model == model


def test_capability_test_replay_never_sends_twice_and_rejects_key_reuse(
    family_model_api: FamilyModelApiContext,
    fake_provider: FakeFamilyModelProvider,
) -> None:
    _publish_all_capabilities(family_model_api)
    payload = {
        "variant_key": "primary",
        "confirm_billable": True,
        "idempotency_key": "protocol-replay-llm",
    }

    first = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test", json=payload
    )
    replay = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test", json=payload
    )
    conflict = family_model_api.client.post(
        "/api/family/model-settings/capabilities/image_generation/test",
        json=payload | {"variant_key": "text"},
    )

    assert first.status_code == 200, first.text
    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["code"] == "family_model_operation_idempotency_conflict"
    assert len([item for item in fake_provider.requests_for(SECRET_MARKER) if item.protocol == "http"]) == 1
    _assert_snapshot(family_model_api, capability="llm", variant="primary")


def test_rotation_uses_new_secret_only_for_new_dispatch_and_preserves_old_snapshot(
    family_model_api: FamilyModelApiContext,
    fake_provider: FakeFamilyModelProvider,
) -> None:
    _publish_llm(family_model_api)
    profile = family_model_api.client.get("/api/family/model-settings").json()["provider_profiles"][0]
    first = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "protocol-rotation-before",
        },
    )
    assert first.status_code == 200, first.text
    old_reservation = _assert_snapshot(family_model_api, capability="llm", variant="primary")
    settings_before_rotation = family_model_api.client.get("/api/family/model-settings").json()
    rotated_marker = "sk-protocol-rotated-marker"
    rotate = family_model_api.client.post(
        f"/api/family/model-settings/provider-profiles/{profile['id']}/rotate-key",
        json={
            "current_password": "OwnerPass123",
            "new_api_key": rotated_marker,
            "base_settings_version_number": settings_before_rotation["version_number"],
            "idempotency_key": "protocol-rotate-key",
        },
    )
    assert rotate.status_code == 200, rotate.text
    assert rotated_marker not in rotate.text
    settings_after_rotation = family_model_api.client.get("/api/family/model-settings").json()
    assert settings_after_rotation["provider_profiles"][0]["api_base_url"] == profile["api_base_url"]
    second = family_model_api.client.post(
        "/api/family/model-settings/capabilities/llm/test",
        json={
            "variant_key": "primary",
            "confirm_billable": True,
            "idempotency_key": "protocol-rotation-after",
        },
    )
    assert second.status_code == 200, second.text

    with family_model_api.session_factory() as db:
        reservations = list(
            db.scalars(
                select(ModelUsageReservation)
                .where(
                    ModelUsageReservation.family_id == "family-a",
                    ModelUsageReservation.capability == "llm",
                )
                .order_by(ModelUsageReservation.reserved_at)
            )
        )
    assert len(reservations) == 2
    assert reservations[0].credential_secret_version_id == old_reservation.credential_secret_version_id
    assert reservations[1].credential_secret_version_id != old_reservation.credential_secret_version_id
    assert len([request for request in fake_provider.requests_for(SECRET_MARKER) if request.protocol == "http"]) == 1
    assert len([request for request in fake_provider.requests_for(rotated_marker) if request.protocol == "http"]) == 1
    all_test_records = [*fake_provider.requests_for(SECRET_MARKER), *fake_provider.requests_for(rotated_marker)]
    assert rotated_marker not in json.dumps([request.body for request in all_test_records], ensure_ascii=False)
