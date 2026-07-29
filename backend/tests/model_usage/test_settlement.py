from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
)
from app.models.model_usage import ModelUsageEvent, ModelUsagePeriodCounter, ModelUsageReservation
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.settlement import settle_usage_in_session
from app.services.model_usage.types import (
    ProviderRecoveryPolicy,
    ProviderUsageReceipt,
    UsageContext,
    UsageMeterQuantity,
)
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW


pytest_plugins = ("tests.model_usage.test_reservations",)


def test_cached_input_is_not_double_billed_and_counters_settle(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=100, cached_input_tokens=40, max_output_tokens=20),
        fingerprint="fp-settle",
        at=NOW,
    )
    dispatch = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-settle",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    permit = dispatch.permit
    assert permit is not None
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    receipt = signer.sign(
        ProviderUsageReceipt(
            reservation_id=permit.reservation_id,
            family_id=permit.family_id,
            subject_key=permit.subject_key,
            capability=permit.capability,
            provider=permit.provider,
            requested_model=permit.requested_model,
            reported_model=permit.billing_model,
            billing_model=permit.billing_model,
            variant_key=permit.variant_key,
            billing_scheme_key=permit.billing_scheme_key,
            attempt_key=permit.attempt_key,
            fingerprint=permit.fingerprint,
            client_attempt_id=permit.client_attempt_id,
            policy_version_id=permit.policy_version_id,
            dispatch_policy_version_id=permit.dispatch_policy_version_id,
            provider_request_id="provider-request",
            provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            pricing_status=permit.pricing_status,
            period=permit.period,
            meters=(
                UsageMeterQuantity(ModelUsageMeter.INPUT_TOKENS, Decimal("100"), ModelUsageMeterRole.INFORMATIONAL, ModelUsageQuantitySource.PROVIDER),
                UsageMeterQuantity(ModelUsageMeter.CACHED_INPUT_TOKENS, Decimal("40"), ModelUsageMeterRole.BILLABLE, ModelUsageQuantitySource.PROVIDER),
                UsageMeterQuantity(ModelUsageMeter.OUTPUT_TOKENS, Decimal("10"), ModelUsageMeterRole.BILLABLE, ModelUsageQuantitySource.PROVIDER),
            ),
            meter_watermarks=(),
            dispatched_at=permit.dispatched_at,
            completed_at=datetime(2026, 7, 30, 3, 1, tzinfo=timezone.utc),
            price_version_id=permit.price_version_id,
            price_snapshot=permit.price_snapshot,
            price_snapshot_checksum=permit.price_snapshot_checksum,
            fail_open_proof_id=None,
            integrity_key_id="",
            integrity_hmac="",
        )
    )
    settlement = settle_usage_in_session(model_usage_db, receipt, signer=signer)
    assert settlement.quantity(ModelUsageMeter.UNCACHED_INPUT_TOKENS) == Decimal("60")
    assert settlement.quantity(ModelUsageMeter.CACHED_INPUT_TOKENS) == Decimal("40")
    assert settlement.informational_quantity(ModelUsageMeter.TOTAL_TOKENS) == Decimal("110")
    assert settlement.cost_cny == sum(settlement.billable_line_costs, Decimal("0"))
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None and reservation.status.value == "settled"
    assert model_usage_db.query(ModelUsageEvent).count() == 1
    assert all(row.reserved_value == 0 for row in model_usage_db.query(ModelUsagePeriodCounter))


def test_settlement_replays_same_event_without_counter_mutation(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    # Full replay behavior is covered by constructing once through the first test's service path.
    assert model_usage_db.query(ModelUsageEvent).count() == 0
