from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCounterKind,
    ModelUsagePricingStatus,
    ModelUsageReservationStatus,
)
from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
    ModelUsageReservationMeter,
)
from app.services.model_usage.errors import ModelUsageCounterAuditError
from app.services.model_usage.types import capability_meter_contract


ACTIVE_RESERVATION_STATUSES = (
    ModelUsageReservationStatus.RESERVED,
    ModelUsageReservationStatus.DISPATCHING,
    ModelUsageReservationStatus.UNCERTAIN,
)


@dataclass(frozen=True, slots=True)
class CounterValues:
    settled_value: Decimal
    reserved_value: Decimal
    adjustment_value: Decimal


@dataclass(frozen=True, slots=True)
class CounterAuditReport:
    counter_id: str
    family_id: str
    before: CounterValues
    expected: CounterValues
    after: CounterValues
    drift_detected: bool
    rechecked_under_lock: bool
    repaired: bool
    healthy: bool


@dataclass(frozen=True, slots=True)
class CounterAuditBatchReport:
    reports: tuple[CounterAuditReport, ...]
    errors: tuple[str, ...]
    healthy: bool


def _decimal_sum(db: Session, statement) -> Decimal:
    return Decimal(db.scalar(statement) or 0)


def _values(counter: ModelUsagePeriodCounter) -> CounterValues:
    return CounterValues(
        settled_value=counter.settled_value,
        reserved_value=counter.reserved_value,
        adjustment_value=counter.adjustment_value,
    )


def _event_cost(db: Session, counter: ModelUsagePeriodCounter) -> Decimal:
    statement = select(func.coalesce(func.sum(ModelUsageEvent.cost_cny), 0)).where(
        ModelUsageEvent.family_id == counter.family_id,
        ModelUsageEvent.period_start == counter.period_start,
        ModelUsageEvent.period_end == counter.period_end,
        ModelUsageEvent.pricing_status == ModelUsagePricingStatus.PRICED,
        ModelUsageEvent.cost_cny.is_not(None),
    )
    if counter.counter_kind is ModelUsageCounterKind.CAPABILITY_COST:
        statement = statement.where(ModelUsageEvent.capability == counter.capability)
    return _decimal_sum(db, statement)


def _reservation_cost(db: Session, counter: ModelUsagePeriodCounter) -> Decimal:
    statement = select(
        func.coalesce(func.sum(ModelUsageReservation.reserved_cost_cny), 0)
    ).where(
        ModelUsageReservation.family_id == counter.family_id,
        ModelUsageReservation.period_start == counter.period_start,
        ModelUsageReservation.period_end == counter.period_end,
        ModelUsageReservation.status.in_(ACTIVE_RESERVATION_STATUSES),
        ModelUsageReservation.pricing_status == ModelUsagePricingStatus.PRICED,
        ModelUsageReservation.reserved_cost_cny.is_not(None),
    )
    if counter.counter_kind is ModelUsageCounterKind.CAPABILITY_COST:
        statement = statement.where(ModelUsageReservation.capability == counter.capability)
    return _decimal_sum(db, statement)


def _adjustment_cost(db: Session, counter: ModelUsagePeriodCounter) -> Decimal:
    statement = (
        select(func.coalesce(func.sum(ModelUsageAdjustment.cost_delta_cny), 0))
        .select_from(ModelUsageAdjustmentGroup)
        .join(
            ModelUsageAdjustment,
            ModelUsageAdjustment.adjustment_group_id == ModelUsageAdjustmentGroup.id,
        )
        .where(
            ModelUsageAdjustmentGroup.family_id == counter.family_id,
            ModelUsageAdjustmentGroup.period_start == counter.period_start,
            ModelUsageAdjustmentGroup.period_end == counter.period_end,
            ModelUsageAdjustment.cost_delta_cny.is_not(None),
        )
    )
    if counter.counter_kind is ModelUsageCounterKind.CAPABILITY_COST:
        statement = statement.where(ModelUsageAdjustment.capability == counter.capability)
    return _decimal_sum(db, statement)


def _event_meter(db: Session, counter: ModelUsagePeriodCounter) -> Decimal:
    return _decimal_sum(
        db,
        select(func.coalesce(func.sum(ModelUsageEventMeter.quantity), 0))
        .select_from(ModelUsageEvent)
        .join(ModelUsageEventMeter, ModelUsageEventMeter.event_id == ModelUsageEvent.id)
        .where(
            ModelUsageEvent.family_id == counter.family_id,
            ModelUsageEvent.period_start == counter.period_start,
            ModelUsageEvent.period_end == counter.period_end,
            ModelUsageEvent.capability == counter.capability,
            ModelUsageEventMeter.meter == counter.meter,
        ),
    )


def _reservation_meter(db: Session, counter: ModelUsagePeriodCounter) -> Decimal:
    return _decimal_sum(
        db,
        select(func.coalesce(func.sum(ModelUsageReservationMeter.reserved_quantity), 0))
        .select_from(ModelUsageReservation)
        .join(
            ModelUsageReservationMeter,
            ModelUsageReservationMeter.reservation_id == ModelUsageReservation.id,
        )
        .where(
            ModelUsageReservation.family_id == counter.family_id,
            ModelUsageReservation.period_start == counter.period_start,
            ModelUsageReservation.period_end == counter.period_end,
            ModelUsageReservation.capability == counter.capability,
            ModelUsageReservation.status.in_(ACTIVE_RESERVATION_STATUSES),
            ModelUsageReservationMeter.meter == counter.meter,
        ),
    )


def _adjustment_meter(db: Session, counter: ModelUsagePeriodCounter) -> Decimal:
    return _decimal_sum(
        db,
        select(func.coalesce(func.sum(ModelUsageAdjustment.meter_delta), 0))
        .select_from(ModelUsageAdjustmentGroup)
        .join(
            ModelUsageAdjustment,
            ModelUsageAdjustment.adjustment_group_id == ModelUsageAdjustmentGroup.id,
        )
        .where(
            ModelUsageAdjustmentGroup.family_id == counter.family_id,
            ModelUsageAdjustmentGroup.period_start == counter.period_start,
            ModelUsageAdjustmentGroup.period_end == counter.period_end,
            ModelUsageAdjustment.capability == counter.capability,
            ModelUsageAdjustment.meter == counter.meter,
            ModelUsageAdjustment.meter_delta.is_not(None),
        ),
    )


def expected_family_cost_values(
    db: Session, counter: ModelUsagePeriodCounter
) -> CounterValues:
    if counter.capability is not None or counter.meter is not None:
        raise ModelUsageCounterAuditError("family_cost_dimension_invalid")
    return CounterValues(_event_cost(db, counter), _reservation_cost(db, counter), _adjustment_cost(db, counter))


def expected_capability_cost_values(
    db: Session, counter: ModelUsagePeriodCounter
) -> CounterValues:
    if counter.capability is None or counter.meter is not None:
        raise ModelUsageCounterAuditError("capability_cost_dimension_invalid")
    return CounterValues(_event_cost(db, counter), _reservation_cost(db, counter), _adjustment_cost(db, counter))


def expected_capability_meter_values(
    db: Session, counter: ModelUsagePeriodCounter
) -> CounterValues:
    if counter.capability is None or counter.meter is None:
        raise ModelUsageCounterAuditError("capability_meter_dimension_invalid")
    try:
        contract = capability_meter_contract(counter.capability, counter.meter)
    except KeyError as exc:
        raise ModelUsageCounterAuditError("guardrail_meter_not_supported") from exc
    if not contract.guardrail_eligible:
        raise ModelUsageCounterAuditError("guardrail_meter_not_eligible")
    return CounterValues(
        _event_meter(db, counter),
        _reservation_meter(db, counter),
        _adjustment_meter(db, counter),
    )


def expected_counter_values(
    db: Session, counter: ModelUsagePeriodCounter
) -> CounterValues:
    match counter.counter_kind:
        case ModelUsageCounterKind.FAMILY_COST:
            return expected_family_cost_values(db, counter)
        case ModelUsageCounterKind.CAPABILITY_COST:
            return expected_capability_cost_values(db, counter)
        case ModelUsageCounterKind.CAPABILITY_METER:
            return expected_capability_meter_values(db, counter)
        case _:
            raise ModelUsageCounterAuditError("unsupported_counter_kind")


def audit_counter(
    db: Session,
    counter_id: str,
    *,
    repair: bool = False,
    record_verification: bool = True,
) -> CounterAuditReport:
    counter = db.get(ModelUsagePeriodCounter, counter_id)
    if counter is None:
        raise ModelUsageCounterAuditError("counter_not_found")
    family_id = counter.family_id
    before = _values(counter)
    expected = expected_counter_values(db, counter)
    drift = before != expected
    rechecked = False
    repaired = False
    if drift and repair:
        counter = db.scalar(
            select(ModelUsagePeriodCounter)
            .where(
                ModelUsagePeriodCounter.id == counter_id,
                ModelUsagePeriodCounter.family_id == family_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        if counter is None:
            raise ModelUsageCounterAuditError("counter_not_found")
        rechecked = True
        expected = expected_counter_values(db, counter)
        if _values(counter) != expected:
            counter.settled_value = expected.settled_value
            counter.reserved_value = expected.reserved_value
            counter.adjustment_value = expected.adjustment_value
            counter.version += 1
            repaired = True
    if record_verification:
        counter.health_status = "healthy" if _values(counter) == expected else "drifted"
        counter.last_verified_at = datetime.now(timezone.utc)
        db.flush()
    after = _values(counter)
    return CounterAuditReport(
        counter_id=counter.id,
        family_id=family_id,
        before=before,
        expected=expected,
        after=after,
        drift_detected=drift,
        rechecked_under_lock=rechecked,
        repaired=repaired,
        healthy=after == expected,
    )


def audit_counters_batch(
    db: Session,
    *,
    repair: bool = False,
    limit: int = 100,
    fail_closed: bool = True,
    record_verification: bool = True,
) -> CounterAuditBatchReport:
    rows = tuple(
        db.scalars(
            select(ModelUsagePeriodCounter)
            .order_by(
                ModelUsagePeriodCounter.last_verified_at.is_not(None),
                ModelUsagePeriodCounter.last_verified_at,
                ModelUsagePeriodCounter.family_id,
                ModelUsagePeriodCounter.period_start,
                ModelUsagePeriodCounter.counter_kind,
                ModelUsagePeriodCounter.capability,
                ModelUsagePeriodCounter.meter,
            )
            .limit(limit)
        )
    )
    kind_order = {
        ModelUsageCounterKind.FAMILY_COST: 0,
        ModelUsageCounterKind.CAPABILITY_COST: 1,
        ModelUsageCounterKind.CAPABILITY_METER: 2,
    }
    ids = tuple(
        row.id
        for row in sorted(
            rows,
            key=lambda row: (
                row.family_id,
                row.period_start,
                kind_order.get(row.counter_kind, 99),
                row.capability.value if row.capability is not None else "",
                row.meter.value if row.meter is not None else "",
                row.dimension_key,
            ),
        )
    )
    reports: list[CounterAuditReport] = []
    errors: list[str] = []
    for counter_id in ids:
        try:
            reports.append(
                audit_counter(
                    db,
                    counter_id,
                    repair=repair,
                    record_verification=record_verification,
                )
            )
        except ModelUsageCounterAuditError as exc:
            errors.append(f"{counter_id}:{exc.code}")
    healthy = all(report.healthy for report in reports) and (not errors or not fail_closed)
    return CounterAuditBatchReport(tuple(reports), tuple(errors), healthy)
