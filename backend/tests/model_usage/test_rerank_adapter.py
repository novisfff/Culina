from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
)
from app.models.model_usage import ModelUsageEvent
from app.services.family_model_settings.types import (
    ResolvedCapabilityBinding,
    ResolvedProviderEndpoint,
)
from app.services.model_usage.adapters.rerank import (
    RerankUsageAdapter,
    RerankUsageDependencies,
)
from app.services.model_usage.configured_variants import ConfiguredUsageVariant
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageContractError
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.policies import CapabilityLimitCommand
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import ReservationDecision
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW, set_policy


pytest_plugins = ("tests.model_usage.test_reservations",)


def _family_rerank_binding() -> ResolvedCapabilityBinding:
    return ResolvedCapabilityBinding(
        family_id="family-reserve",
        config_revision_id="family-revision-rerank-a",
        provider_profile_id="family-rerank-profile-a",
        provider_profile_version_id="family-rerank-profile-version-a",
        adapter_kind="openai_compatible_http",
        auth_mode="api_key",
        endpoint=ResolvedProviderEndpoint(
            normalized_url="https://rerank.provider.example/v1",
            scheme="https",
            host="rerank.provider.example",
            port=443,
            base_path="/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        websocket_endpoint=None,
        requested_model="family-rerank-model",
        billing_model="family-rerank-billing-model",
        capability="rerank",
        variant_key="search",
        billing_scheme_key="rerank-token-v1",
        options={"top_n": 24},
    )


@pytest.fixture()
def receipt_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="rerank-test-key",
        keys={"rerank-test-key": b"rerank-test-secret"},
    )


@pytest.fixture()
def rerank_adapter(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
) -> RerankUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return RerankUsageAdapter(
        provider="dashscope",
        model="rerank-test",
        candidate_limit=20,
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=receipt_signer,
        clock=lambda: NOW,
    )


def test_rerank_exact_candidate_count_and_content_free_receipt(
    rerank_adapter: RerankUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    publish(model_usage_db, raw_manifest())

    attempt = rerank_adapter.begin(
        attribution=reservation_context.attribution,
        attempt_key="search-1:rerank",
        estimated_input_tokens=71,
        fingerprint="hmac:rerank-request",
    )

    assert attempt.estimate.quantity(ModelUsageMeter.INPUT_TOKENS) == Decimal("71")

    permit = attempt.prepare_dispatch()
    assert permit.recovery_policy.mode is ModelUsageRecoveryMode.NONE
    receipt = rerank_adapter.receipt_from_response(
        permit,
        reported_model="rerank-test-2026-07-01",
        provider_request_id="rerank-request-1",
        provider_input_tokens=43,
        completed_at=NOW + timedelta(seconds=1),
    )

    by_meter = {line.meter: line for line in receipt.meters}
    assert receipt.measurement_status is ModelUsageMeasurementStatus.EXACT
    assert by_meter[ModelUsageMeter.INPUT_TOKENS].quantity == Decimal("43")
    assert all(line.quantity_source is ModelUsageQuantitySource.PROVIDER for line in receipt.meters)
    assert "鸡肉" not in repr(receipt)

    settlement = attempt.settle(receipt)

    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.capability is ModelUsageCapability.RERANK
    assert event.reported_model == "rerank-test-2026-07-01"
    assert event.fingerprint == "hmac:rerank-request"


def test_family_bound_rerank_context_captures_config_profile_and_price_identity(
    receipt_signer: ProviderUsageReceiptSigner,
    reservation_context,
) -> None:
    binding = _family_rerank_binding()

    class CaptureFacade:
        context = None
        estimate = None

        def reserve(self, context, estimate, *, fingerprint: str, at=None):
            del fingerprint, at
            self.context = context
            self.estimate = estimate
            return ReservationDecision(decision="allowed", reservation_id="rerank-reservation-a")

    facade = CaptureFacade()
    adapter = RerankUsageAdapter.for_binding(
        binding,
        RerankUsageDependencies(
            usage_facade=facade,
            session_factory=lambda: None,  # type: ignore[arg-type]
            signer=receipt_signer,
            price_version_id="family-price-rerank-a",
            clock=lambda: NOW,
        ),
    )

    attempt = adapter.begin(
        attribution=reservation_context.attribution,
        attempt_key="family-search-rerank:1",
        estimated_input_tokens=17,
        fingerprint="hmac:family-rerank-context",
    )

    assert attempt.context.config_revision_id == binding.config_revision_id
    assert attempt.context.provider_profile_id == binding.provider_profile_id
    assert attempt.context.provider_profile_version_id == binding.provider_profile_version_id
    assert attempt.context.explicit_price_version_id == "family-price-rerank-a"
    assert attempt.context.provider == binding.provider_profile_id
    assert attempt.context.requested_model == binding.requested_model
    assert attempt.context.billing_model == binding.billing_model
    assert facade.context is attempt.context
    assert facade.estimate is attempt.estimate


def test_rerank_confirmed_not_executed_receipt_settles_zero_amount(
    rerank_adapter: RerankUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    publish(model_usage_db, raw_manifest())
    attempt = rerank_adapter.begin(
        attribution=reservation_context.attribution,
        attempt_key="search-no-secret:rerank",
        estimated_input_tokens=41,
        fingerprint="hmac:rerank-no-secret",
    )
    permit = attempt.prepare_dispatch()

    receipt = rerank_adapter.confirmed_not_executed_receipt(permit)
    assert receipt.provider_outcome.value == "not_billed"
    assert receipt.execution_certainty.value == "confirmed_not_executed"
    assert all(line.quantity == Decimal("0") for line in receipt.meters)

    settlement = attempt.settle(receipt)
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.cost_cny == Decimal("0")


def test_rerank_rejects_empty_input_token_estimate_without_a_reservation(
    rerank_adapter: RerankUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    with pytest.raises(ModelUsageContractError, match="rerank_input_tokens_invalid"):
        rerank_adapter.begin(
            attribution=reservation_context.attribution,
            attempt_key="search-empty:rerank",
            estimated_input_tokens=0,
            fingerprint="hmac:rerank-empty",
        )

    assert model_usage_db.query(ModelUsageEvent).count() == 0


def test_rerank_budget_block_happens_before_dispatch(
    rerank_adapter: RerankUsageAdapter,
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
                capability=ModelUsageCapability.RERANK,
                limit_kind=ModelUsageLimitKind.METER,
                meter=ModelUsageMeter.INPUT_TOKENS,
                limit_value=Decimal("1"),
            ),
        ),
        active_variants=(
            ConfiguredUsageVariant(
                provider="dashscope",
                billing_model="rerank-test",
                capability=ModelUsageCapability.RERANK,
                variant_key="top_n=20",
                billing_scheme_key="rerank-token-v1",
                billable_meters=frozenset({ModelUsageMeter.INPUT_TOKENS}),
                produced_meters=frozenset({ModelUsageMeter.INPUT_TOKENS}),
            ),
        ),
    )

    with pytest.raises(ModelUsageBlocked, match="model_usage_capability_limit_exceeded"):
        rerank_adapter.begin(
            attribution=reservation_context.attribution,
            attempt_key="search-blocked:rerank",
            estimated_input_tokens=2,
            fingerprint="hmac:rerank-blocked",
        )
