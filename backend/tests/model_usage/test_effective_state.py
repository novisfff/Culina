from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageResolutionKind,
)
from app.models.model_usage import ModelUsageEvent, ModelUsageEventMeter
from app.services.model_usage.adjustments import (
    AdjustmentCommand,
    AdjustmentLineCommand,
    apply_adjustment,
    preview_adjustment,
)
from app.services.model_usage.effective_state import effective_event_state
from tests.model_usage.test_adjustments import (
    evidence_snapshot,
    settled_source_event,
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

    effective = effective_event_state(
        model_usage_db,
        family_id=unknown_source_event.family_id,
        event_id=unknown_source_event.id,
    )

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

    effective = effective_event_state(
        model_usage_db,
        family_id=unpriced_source_event.family_id,
        event_id=unpriced_source_event.id,
    )

    assert effective.pricing_status is ModelUsagePricingStatus.PRICED
    assert effective.cost_cny == Decimal("110")
    assert _event_snapshot(unpriced_source_event) == original


def test_pricing_resolution_projects_costs_to_the_billable_meter_lines(
    model_usage_db: Session,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    snapshot = evidence_snapshot(
        complete=True,
        billing_scheme_key=unpriced_source_event.billing_scheme_key,
    )
    command = AdjustmentCommand(
        family_id=unpriced_source_event.family_id,
        source_event_id=unpriced_source_event.id,
        source_reservation_id=unpriced_source_event.reservation_id,
        idempotency_key="effective-meter-cost-pricing-resolution",
        fingerprint="fp-effective-meter-cost-pricing-resolution",
        reason_code="provider_price_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-EFFECTIVE-METER-COST",
        evidence_ref="provider:invoice:meter-cost",
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

    effective = effective_event_state(
        model_usage_db,
        family_id=unpriced_source_event.family_id,
        event_id=unpriced_source_event.id,
    )

    assert effective.meter_cost(ModelUsageMeter.INPUT_TOKENS) is None
    assert effective.meter_cost(ModelUsageMeter.UNCACHED_INPUT_TOKENS) == Decimal("60")
    assert effective.meter_cost(ModelUsageMeter.CACHED_INPUT_TOKENS) == Decimal("40")
    assert effective.meter_cost(ModelUsageMeter.OUTPUT_TOKENS) == Decimal("10")


def test_meter_correction_assigns_its_explicit_cost_delta_to_the_corrected_meter(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    source_meter = model_usage_db.scalar(
        select(ModelUsageEventMeter).where(
            ModelUsageEventMeter.event_id == settled_source_event.id,
            ModelUsageEventMeter.meter == ModelUsageMeter.UNCACHED_INPUT_TOKENS,
        )
    )
    assert (
        source_meter is not None
        and source_meter.cost_cny is not None
        and settled_source_event.cost_cny is not None
    )
    cost_delta = Decimal("-0.000001000000")
    command = AdjustmentCommand(
        family_id=settled_source_event.family_id,
        source_event_id=settled_source_event.id,
        source_reservation_id=settled_source_event.reservation_id,
        idempotency_key="effective-meter-cost-correction",
        fingerprint="fp-effective-meter-cost-correction",
        reason_code="provider_meter_correction",
        operator="release-owner",
        change_ticket="CULINA-USAGE-EFFECTIVE-METER-CORRECTION",
        evidence_ref="provider:invoice:meter-correction",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
                meter=ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                meter_delta=Decimal("-1"),
                cost_delta_cny=cost_delta,
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)
    apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))

    effective = effective_event_state(
        model_usage_db,
        family_id=settled_source_event.family_id,
        event_id=settled_source_event.id,
    )

    assert effective.cost_cny == settled_source_event.cost_cny + cost_delta
    assert (
        effective.meter_cost(ModelUsageMeter.UNCACHED_INPUT_TOKENS)
        == source_meter.cost_cny + cost_delta
    )


def test_confirmed_not_billed_resolution_clears_all_meter_costs(
    model_usage_db: Session,
    unknown_source_event: ModelUsageEvent,
) -> None:
    meters = tuple(
        model_usage_db.scalars(
            select(ModelUsageEventMeter)
            .where(ModelUsageEventMeter.event_id == unknown_source_event.id)
            .order_by(ModelUsageEventMeter.meter_key)
        )
    )
    assert meters and unknown_source_event.cost_cny is not None
    command = AdjustmentCommand(
        family_id=unknown_source_event.family_id,
        source_event_id=unknown_source_event.id,
        source_reservation_id=unknown_source_event.reservation_id,
        idempotency_key="effective-not-billed-meter-costs",
        fingerprint="fp-effective-not-billed-meter-costs",
        reason_code="provider_confirmed_not_executed",
        operator="release-owner",
        change_ticket="CULINA-USAGE-EFFECTIVE-NOT-BILLED",
        evidence_ref="provider:request:not-executed",
        lines=tuple(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.EXECUTION_RESOLUTION,
                meter=row.meter,
                meter_delta=-row.quantity,
                cost_delta_cny=(
                    -unknown_source_event.cost_cny if index == 0 else None
                ),
                resulting_provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
                resulting_execution_certainty=(
                    ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
                ),
                resulting_measurement_status=ModelUsageMeasurementStatus.EXACT,
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
            )
            for index, row in enumerate(meters)
        ),
    )
    preview = preview_adjustment(model_usage_db, command)
    apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))

    effective = effective_event_state(
        model_usage_db,
        family_id=unknown_source_event.family_id,
        event_id=unknown_source_event.id,
    )

    assert effective.cost_cny == Decimal("0")
    assert {
        row.meter: effective.meter_cost(row.meter) or Decimal("0")
        for row in meters
    } == {row.meter: Decimal("0") for row in meters}


def test_effective_state_rejects_wrong_family_scope(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    with pytest.raises(LookupError, match="model_usage_event_not_found"):
        effective_event_state(
            model_usage_db,
            family_id="other-family",
            event_id=settled_source_event.id,
        )


def test_effective_state_requires_explicit_family_scope(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    with pytest.raises(TypeError):
        effective_event_state(model_usage_db, settled_source_event.id)
