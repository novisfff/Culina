from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsagePricingStatus,
    ModelUsageResolutionKind,
)
from app.models.model_usage import ModelUsageEvent
from app.services.model_usage.adjustments import (
    AdjustmentCommand,
    AdjustmentLineCommand,
    apply_adjustment,
    preview_adjustment,
)
from app.services.model_usage.effective_state import effective_event_state
from tests.model_usage.test_adjustments import (
    evidence_snapshot,
    unknown_source_event,
    unpriced_source_event,
)


pytest_plugins = ("tests.model_usage.test_reservations",)


def _event_snapshot(event: ModelUsageEvent) -> tuple[object, ...]:
    return (
        event.provider_outcome,
        event.execution_certainty,
        event.measurement_status,
        event.pricing_status,
        event.cost_cny,
        event.price_version_id,
        event.price_snapshot_checksum,
    )


def test_execution_resolution_removes_unresolved_unknown_without_mutating_event(
    model_usage_db: Session,
    unknown_source_event: ModelUsageEvent,
) -> None:
    original = _event_snapshot(unknown_source_event)
    command = AdjustmentCommand(
        family_id=unknown_source_event.family_id,
        source_event_id=unknown_source_event.id,
        source_reservation_id=unknown_source_event.reservation_id,
        idempotency_key="effective-execution-resolution",
        fingerprint="fp-effective-execution-resolution",
        reason_code="provider_usage_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-EFFECTIVE-1",
        evidence_ref="provider:request:effective-1",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.EXECUTION_RESOLUTION,
                resulting_provider_outcome=unknown_source_event.provider_outcome.SUCCEEDED,
                resulting_execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
                resulting_measurement_status=ModelUsageMeasurementStatus.EXACT,
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)
    apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))

    effective = effective_event_state(model_usage_db, unknown_source_event.id)

    assert effective.execution_certainty is ModelUsageExecutionCertainty.CONFIRMED_EXECUTED
    assert effective.measurement_status is ModelUsageMeasurementStatus.EXACT
    assert _event_snapshot(unknown_source_event) == original


def test_pricing_resolution_uses_evidence_snapshot_without_repricing_event(
    model_usage_db: Session,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    original = _event_snapshot(unpriced_source_event)
    snapshot = evidence_snapshot(
        complete=True,
        billing_scheme_key=unpriced_source_event.billing_scheme_key,
    )
    command = AdjustmentCommand(
        family_id=unpriced_source_event.family_id,
        source_event_id=unpriced_source_event.id,
        source_reservation_id=unpriced_source_event.reservation_id,
        idempotency_key="effective-pricing-resolution",
        fingerprint="fp-effective-pricing-resolution",
        reason_code="provider_price_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-EFFECTIVE-2",
        evidence_ref="provider:invoice:effective-2",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.PRICING_CORRECTION,
                cost_delta_cny=Decimal("110"),
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
                price_snapshot=snapshot,
                resolved_cost_cny=Decimal("110"),
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)
    apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))

    effective = effective_event_state(model_usage_db, unpriced_source_event.id)

    assert effective.pricing_status is ModelUsagePricingStatus.PRICED
    assert effective.cost_cny == Decimal("110")
    assert _event_snapshot(unpriced_source_event) == original
