from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageOperationSource,
    ModelUsageProviderOutcome,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
)
from app.models.model_usage import ModelUsageEvent, ModelUsageReservation
from app.services.model_usage.adapters.image_generation import ImageGenerationUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.configured_variants import ConfiguredUsageVariant
from app.services.model_usage.policies import CapabilityLimitCommand
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import UsageAttribution
from app.services.family_model_settings.types import (
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW, set_policy


pytest_plugins = ("tests.model_usage.test_reservations",)


@pytest.fixture()
def receipt_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="image-test-key",
        keys={"image-test-key": b"image-test-secret"},
    )


@pytest.fixture()
def image_adapter(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
) -> ImageGenerationUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return ImageGenerationUsageAdapter(
        provider="dashscope",
        model="image-test",
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=receipt_signer,
        clock=lambda: NOW,
    )


def _image_attribution(reservation_context) -> UsageAttribution:
    return UsageAttribution(
        family_id=reservation_context.attribution.family_id,
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id=reservation_context.attribution.actor_user_id,
        operation_source=ModelUsageOperationSource.IMAGE_JOB,
        logical_operation_id="image-job-1",
    )


def _image_binding() -> ResolvedCapabilityBinding:
    return ResolvedCapabilityBinding(
        family_id="family-reserve",
        config_revision_id="image-revision",
        provider_profile_id="image-profile",
        provider_profile_version_id="image-profile-version",
        adapter_kind="openai_compatible_http",
        auth_mode="api_key",
        endpoint=ResolvedProviderEndpoint(
            normalized_url="https://image.provider.example/v1",
            scheme="https",
            host="image.provider.example",
            port=443,
            base_path="/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        websocket_endpoint=None,
        requested_model="image-bound-model",
        billing_model="image-bound-model",
        capability="image_generation",
        variant_key="text",
        billing_scheme_key="image-count-v1",
        options={},
    )


def test_image_variant_uses_only_billable_dimensions_and_receipt_stays_content_free(
    image_adapter: ImageGenerationUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    publish(model_usage_db, raw_manifest())
    fingerprint = image_adapter.request_fingerprint(
        {
            "prompt": "private-prompt",
            "reference_bytes": b"reference-bytes",
        }
    )

    attempt = image_adapter.begin(
        attribution=_image_attribution(reservation_context),
        attempt_key="image-job-1:attempt:1",
        mode="reference",
        image_count=1,
        size="1024*1024",
        quality="standard",
        fingerprint=fingerprint,
    )

    assert attempt.context.capability is ModelUsageCapability.IMAGE_GENERATION
    assert attempt.context.operation_kind == "image_generation_job"
    assert attempt.context.attribution.operation_source is ModelUsageOperationSource.IMAGE_JOB
    assert attempt.context.variant_key == "mode=reference|size=1024*1024|quality=standard"
    assert "prompt" not in attempt.context.__dataclass_fields__
    assert attempt.estimate.quantity(ModelUsageMeter.GENERATED_IMAGES) == Decimal("1.000000")
    assert attempt.estimate.quantity(ModelUsageMeter.REQUEST_UNITS) == Decimal("0")

    permit = attempt.prepare_dispatch()
    assert permit.recovery_policy.mode is ModelUsageRecoveryMode.NONE
    receipt = image_adapter.receipt_from_provider_success(
        permit,
        reported_model="image-test-2026-07-30",
        provider_request_id="image-provider-request-1",
        completed_at=NOW + timedelta(seconds=1),
    )
    settlement = attempt.settle(receipt)

    assert receipt.measurement_status is ModelUsageMeasurementStatus.EXACT
    assert "private-prompt" not in repr(receipt)
    assert "reference-bytes" not in repr(receipt)
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.capability is ModelUsageCapability.IMAGE_GENERATION
    assert event.reported_model == "image-test-2026-07-30"


def test_image_binding_is_carried_into_the_usage_context(
    image_adapter: ImageGenerationUsageAdapter,
    reservation_context,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = {}

    def record_start(self, context, estimate, *, fingerprint, at=None):
        del self, estimate, fingerprint, at
        captured["context"] = context
        return object()

    monkeypatch.setattr(ImageGenerationUsageAdapter, "start_attempt", record_start)
    result = image_adapter.begin(
        attribution=_image_attribution(reservation_context),
        attempt_key="image-job-1:bound",
        mode="text",
        image_count=1,
        size="1536*1152",
        quality="standard",
        fingerprint="hmac:image-bound",
        binding=_image_binding(),
    )

    assert result is not None
    context = captured["context"]
    assert context.provider == "image-profile"
    assert context.requested_model == "image-bound-model"
    assert context.variant_key == "text"
    assert context.config_revision_id == "image-revision"
    assert context.provider_profile_id == "image-profile"
    assert context.provider_profile_version_id == "image-profile-version"


def test_image_adapter_can_include_independent_request_fee_when_variant_declares_one(
    image_adapter: ImageGenerationUsageAdapter,
    reservation_context,
) -> None:
    attempt = image_adapter.begin(
        attribution=_image_attribution(reservation_context),
        attempt_key="image-job-1:attempt:2",
        mode="text",
        image_count=2,
        size="1024*1024",
        quality="standard",
        include_request_fee=True,
        fingerprint="hmac:image-request-with-request-fee",
    )

    assert attempt.estimate.quantity(ModelUsageMeter.GENERATED_IMAGES) == Decimal("2.000000")
    assert attempt.estimate.quantity(ModelUsageMeter.REQUEST_UNITS) == Decimal("1.000000")


def test_image_adapter_blocks_budget_before_provider_dispatch(
    image_adapter: ImageGenerationUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    publish(model_usage_db, raw_manifest())
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
        limits=(
            CapabilityLimitCommand(
                capability=ModelUsageCapability.IMAGE_GENERATION,
                limit_kind=ModelUsageLimitKind.METER,
                meter=ModelUsageMeter.GENERATED_IMAGES,
                limit_value=Decimal("1"),
            ),
        ),
        active_variants=(
            ConfiguredUsageVariant(
                provider="dashscope",
                billing_model="image-test",
                capability=ModelUsageCapability.IMAGE_GENERATION,
                variant_key="mode=text|size=1024*1024|quality=standard",
                billing_scheme_key="image-count-v1",
                billable_meters=frozenset({ModelUsageMeter.GENERATED_IMAGES}),
                produced_meters=frozenset({ModelUsageMeter.GENERATED_IMAGES}),
            ),
        ),
    )

    with pytest.raises(ModelUsageBlocked, match="model_usage_capability_limit_exceeded"):
        image_adapter.begin(
            attribution=_image_attribution(reservation_context),
            attempt_key="image-job-1:attempt:blocked",
            mode="text",
            image_count=2,
            size="1024*1024",
            quality="standard",
            fingerprint="hmac:image-request-blocked",
        )


def test_confirmed_provider_rejection_releases_image_reservation(
    image_adapter: ImageGenerationUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    attempt = image_adapter.begin(
        attribution=_image_attribution(reservation_context),
        attempt_key="image-job-1:attempt:rejected",
        mode="text",
        image_count=1,
        size="1024*1024",
        quality="standard",
        fingerprint="hmac:image-request-rejected",
    )
    permit = attempt.prepare_dispatch()
    settlement = attempt.settle(
        image_adapter.confirmed_not_executed_receipt(
            permit,
            stable_provider_request_id="http_status_422",
        )
    )

    reservation = model_usage_db.get(ModelUsageReservation, attempt.reservation_id)
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.SETTLED
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED


def test_image_provider_timeout_marks_dispatched_attempt_uncertain(
    image_adapter: ImageGenerationUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    attempt = image_adapter.begin(
        attribution=_image_attribution(reservation_context),
        attempt_key="image-job-1:attempt:timeout",
        mode="text",
        image_count=1,
        size="1024*1024",
        quality="standard",
        fingerprint="hmac:image-request-timeout",
    )
    attempt.prepare_dispatch()
    attempt.mark_uncertain("image_provider_result_unavailable")

    reservation = model_usage_db.get(ModelUsageReservation, attempt.reservation_id)
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.UNCERTAIN
    assert reservation.error_code == "image_provider_result_unavailable"
