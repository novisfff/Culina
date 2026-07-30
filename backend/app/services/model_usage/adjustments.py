from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from decimal import Decimal
from types import MappingProxyType
from typing import Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCorrectionStatus,
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageResolutionKind,
    ModelUsageRollupKind,
)
from app.core.utils import create_id
from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageAlert,
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
)
from app.repos.model_usage.adjustments import (
    adjustment_group_by_idempotency_key_for_update,
    adjustment_groups_for_source_event,
    adjustment_lines_for_groups,
    family_total_rollup_for_update,
    require_adjustment_group_for_update,
    require_family_event_for_update,
)
from app.services.model_usage.alerts import (
    evaluate_budget_alerts_with_focus,
    pending_budget_alert_thresholds,
)
from app.services.model_usage.counters import (
    capability_cost_dimension_key,
    capability_meter_dimension_key,
    family_cost_dimension_key,
)
from app.services.model_usage.decimal_math import exact_line_cost
from app.services.model_usage.errors import (
    ModelUsageAdjustmentConflict,
    ModelUsageAdjustmentValidationError,
    ModelUsageAdjustmentWindowClosed,
    ModelUsageStateError,
)
from app.services.model_usage.policies import lock_family_policy
from app.services.model_usage.pricing import UsagePriceSnapshot
from app.services.model_usage.types import capability_meter_contract


MONEY_QUANTUM = Decimal("0.000000000001")
QUANTITY_QUANTUM = Decimal("0.000001")


@dataclass(frozen=True, slots=True)
class AdjustmentLineCommand:
    resolution_kind: ModelUsageResolutionKind
    meter: ModelUsageMeter | None = None
    meter_delta: Decimal | None = None
    cost_delta_cny: Decimal | None = None
    resulting_provider_outcome: ModelUsageProviderOutcome | None = None
    resulting_execution_certainty: ModelUsageExecutionCertainty | None = None
    resulting_measurement_status: ModelUsageMeasurementStatus | None = None
    resulting_pricing_status: ModelUsagePricingStatus | None = None
    price_snapshot: UsagePriceSnapshot | None = None
    resolved_cost_cny: Decimal | None = None


@dataclass(frozen=True, slots=True)
class AdjustmentCommand:
    family_id: str
    source_event_id: str
    source_reservation_id: str | None
    idempotency_key: str
    fingerprint: str
    reason_code: str
    operator: str
    change_ticket: str
    evidence_ref: str
    lines: Sequence[AdjustmentLineCommand]
    confirm_checksum: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "lines", tuple(self.lines))


@dataclass(frozen=True, slots=True)
class EffectiveUsageState:
    source_event_id: str
    capability: object
    cost_cny: Decimal | None
    meter_quantities: Mapping[ModelUsageMeter, Decimal]
    execution_certainty: ModelUsageExecutionCertainty
    measurement_status: ModelUsageMeasurementStatus
    pricing_status: ModelUsagePricingStatus
    provider_outcome: ModelUsageProviderOutcome

    def __post_init__(self) -> None:
        object.__setattr__(self, "meter_quantities", MappingProxyType(dict(self.meter_quantities)))

    def quantity(self, meter: ModelUsageMeter) -> Decimal:
        return self.meter_quantities.get(meter, Decimal("0"))

    def guardrail_quantity(self, meter: ModelUsageMeter) -> Decimal:
        return self.quantity(meter)


@dataclass(frozen=True, slots=True)
class AdjustmentCounterDelta:
    cost: Decimal
    meter_values: Mapping[ModelUsageMeter, Decimal]

    def __post_init__(self) -> None:
        object.__setattr__(self, "meter_values", MappingProxyType(dict(self.meter_values)))

    def meter(self, meter: ModelUsageMeter) -> Decimal:
        return self.meter_values.get(meter, Decimal("0"))


@dataclass(frozen=True, slots=True)
class AdjustmentPreview:
    payload: Mapping[str, object]
    checksum: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", MappingProxyType(dict(self.payload)))


@dataclass(frozen=True, slots=True)
class AdjustmentResult:
    group: ModelUsageAdjustmentGroup
    lines: tuple[ModelUsageAdjustment, ...]
    effective: EffectiveUsageState
    counter_delta: AdjustmentCounterDelta
    preview: AdjustmentPreview | None = None
    alerts: tuple[ModelUsageAlert, ...] = field(default_factory=tuple)
    notification_focus: ModelUsageAlert | None = None


def _canonical_decimal(value: Decimal | None) -> str | None:
    if value is None:
        return None
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


def _canonical_checksum(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _assert_decimal_delta(value: Decimal | None, *, quantum: Decimal, field_name: str) -> None:
    if value is None:
        return
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ModelUsageAdjustmentValidationError(f"{field_name}_invalid")
    if value.quantize(quantum) != value:
        raise ModelUsageAdjustmentValidationError(f"{field_name}_precision_invalid")


def _snapshot_payload(snapshot: UsagePriceSnapshot) -> dict[str, object]:
    return {
        "pricing_status": snapshot.pricing_status.value,
        "price_version_id": snapshot.price_version_id,
        "billing_model": snapshot.billing_model,
        "billing_scheme_key": snapshot.billing_scheme_key,
        "missing_billable_meters": sorted(
            meter.value for meter in snapshot.missing_billable_meters
        ),
        "checksum": snapshot.checksum,
        "rates": [
            {
                "meter": rate.meter.value,
                "meter_role": rate.meter_role.value,
                "unit_quantity": _canonical_decimal(rate.unit_quantity),
                "unit_price": _canonical_decimal(rate.unit_price),
                "source_currency": rate.source_currency,
                "fx_to_cny": _canonical_decimal(rate.fx_to_cny),
                "unit_price_cny": _canonical_decimal(rate.unit_price_cny),
            }
            for rate in sorted(snapshot.rates, key=lambda item: item.meter.value)
        ],
    }


def _event_state(db: Session, event: ModelUsageEvent) -> EffectiveUsageState:
    rows = tuple(
        db.scalars(
            select(ModelUsageEventMeter)
            .where(ModelUsageEventMeter.event_id == event.id)
            .order_by(ModelUsageEventMeter.meter_key)
        )
    )
    return EffectiveUsageState(
        source_event_id=event.id,
        capability=event.capability,
        cost_cny=event.cost_cny,
        meter_quantities={row.meter: row.quantity for row in rows},
        execution_certainty=event.execution_certainty,
        measurement_status=event.measurement_status,
        pricing_status=event.pricing_status,
        provider_outcome=event.provider_outcome,
    )


def _apply_line_to_state(
    state: EffectiveUsageState,
    line: AdjustmentLineCommand | ModelUsageAdjustment,
) -> EffectiveUsageState:
    meter = line.meter
    quantities = dict(state.meter_quantities)
    if meter is not None and line.meter_delta is not None:
        next_quantity = quantities.get(meter, Decimal("0")) + line.meter_delta
        if next_quantity < 0:
            raise ModelUsageAdjustmentValidationError("effective_usage_cannot_be_negative")
        quantities[meter] = next_quantity

    cost = state.cost_cny
    if line.cost_delta_cny is not None:
        next_cost = (cost or Decimal("0")) + line.cost_delta_cny
        if next_cost < 0:
            raise ModelUsageAdjustmentValidationError("effective_usage_cannot_be_negative")
        cost = next_cost

    if line.resolution_kind is ModelUsageResolutionKind.PRICING_CORRECTION:
        if line.resolved_cost_cny is None:
            raise ModelUsageAdjustmentValidationError("pricing_resolution_cost_required")
        if cost != line.resolved_cost_cny:
            raise ModelUsageAdjustmentValidationError("pricing_resolution_cost_delta_mismatch")

    return EffectiveUsageState(
        source_event_id=state.source_event_id,
        capability=state.capability,
        cost_cny=cost,
        meter_quantities=quantities,
        execution_certainty=(
            line.resulting_execution_certainty or state.execution_certainty
        ),
        measurement_status=(line.resulting_measurement_status or state.measurement_status),
        pricing_status=(line.resulting_pricing_status or state.pricing_status),
        provider_outcome=(line.resulting_provider_outcome or state.provider_outcome),
    )


def _ordered_existing_lines(
    db: Session,
    *,
    event: ModelUsageEvent,
) -> tuple[ModelUsageAdjustment, ...]:
    groups = adjustment_groups_for_source_event(
        db,
        family_id=event.family_id,
        source_event_id=event.id,
    )
    lines_by_group: dict[str, list[ModelUsageAdjustment]] = {
        group.id: [] for group in groups
    }
    for line in adjustment_lines_for_groups(db, group_ids=tuple(lines_by_group)):
        lines_by_group[line.adjustment_group_id].append(line)
    return tuple(
        line
        for group in groups
        for line in sorted(
            lines_by_group[group.id],
            key=lambda item: (item.line_sequence, item.id),
        )
    )


def effective_state_for_event(
    db: Session,
    *,
    event: ModelUsageEvent,
    proposed_lines: Sequence[AdjustmentLineCommand] = (),
) -> EffectiveUsageState:
    state = _event_state(db, event)
    for line in _ordered_existing_lines(db, event=event):
        state = _apply_line_to_state(state, line)
    for line in proposed_lines:
        state = _apply_line_to_state(state, line)
    return state


def _validate_line(
    event: ModelUsageEvent,
    line: AdjustmentLineCommand,
) -> None:
    if line.meter is None and line.meter_delta is not None:
        raise ModelUsageAdjustmentValidationError("meter_delta_requires_meter")
    if line.meter is not None:
        try:
            capability_meter_contract(event.capability, line.meter)
        except KeyError as exc:
            raise ModelUsageAdjustmentValidationError("adjustment_meter_not_supported") from exc
    _assert_decimal_delta(line.meter_delta, quantum=QUANTITY_QUANTUM, field_name="meter_delta")
    _assert_decimal_delta(line.cost_delta_cny, quantum=MONEY_QUANTUM, field_name="cost_delta")
    _assert_decimal_delta(line.resolved_cost_cny, quantum=MONEY_QUANTUM, field_name="resolved_cost")

    if line.resolution_kind is ModelUsageResolutionKind.METER_CORRECTION:
        if line.meter is None or line.meter_delta is None:
            raise ModelUsageAdjustmentValidationError("meter_correction_delta_required")
        if any(
            value is not None
            for value in (
                line.resulting_provider_outcome,
                line.resulting_execution_certainty,
                line.resulting_measurement_status,
                line.resulting_pricing_status,
                line.price_snapshot,
                line.resolved_cost_cny,
            )
        ):
            raise ModelUsageAdjustmentValidationError(
                "meter_correction_fields_invalid"
            )
    elif line.resolution_kind is ModelUsageResolutionKind.PRICING_CORRECTION:
        snapshot = line.price_snapshot
        if (
            line.meter is not None
            or line.meter_delta is not None
            or line.resulting_provider_outcome is not None
            or line.resulting_execution_certainty is not None
            or line.resulting_measurement_status is not None
        ):
            raise ModelUsageAdjustmentValidationError(
                "pricing_correction_fields_invalid"
            )
        if (
            snapshot is None
            or snapshot.checksum is None
            or snapshot.pricing_status is not ModelUsagePricingStatus.PRICED
            or line.resulting_pricing_status is not ModelUsagePricingStatus.PRICED
            or line.resolved_cost_cny is None
            or line.cost_delta_cny is None
        ):
            raise ModelUsageAdjustmentValidationError("pricing_resolution_snapshot_required")
    elif line.resolution_kind is ModelUsageResolutionKind.EXECUTION_RESOLUTION:
        if line.price_snapshot is not None or line.resolved_cost_cny is not None:
            raise ModelUsageAdjustmentValidationError(
                "execution_resolution_fields_invalid"
            )
        if (
            line.resulting_provider_outcome is None
            or line.resulting_execution_certainty is None
            or line.resulting_measurement_status is None
        ):
            raise ModelUsageAdjustmentValidationError("execution_resolution_status_required")
        if line.resulting_pricing_status is not None and not (
            line.resulting_pricing_status is ModelUsagePricingStatus.PRICED
            and line.resulting_provider_outcome is ModelUsageProviderOutcome.NOT_BILLED
            and line.resulting_execution_certainty
            is ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
        ):
            raise ModelUsageAdjustmentValidationError(
                "execution_resolution_fields_invalid"
            )
    else:
        raise ModelUsageAdjustmentValidationError("unsupported_adjustment_resolution")


def _validate_pricing_resolution_snapshot(
    db: Session,
    *,
    event: ModelUsageEvent,
    line: AdjustmentLineCommand,
    effective_before_line: EffectiveUsageState,
) -> None:
    if line.resolution_kind is not ModelUsageResolutionKind.PRICING_CORRECTION:
        return
    snapshot = line.price_snapshot
    if snapshot is None:
        raise ModelUsageAdjustmentValidationError("pricing_resolution_snapshot_required")
    if (
        snapshot.price_version_id is None
        or snapshot.billing_model != event.billing_model
        or snapshot.billing_scheme_key != event.billing_scheme_key
        or snapshot.missing_billable_meters
    ):
        raise ModelUsageAdjustmentValidationError("pricing_resolution_snapshot_incomplete")
    rates = {rate.meter: rate for rate in snapshot.rates}
    billable_rows = tuple(
        db.scalars(
            select(ModelUsageEventMeter)
            .where(ModelUsageEventMeter.event_id == event.id)
            .order_by(ModelUsageEventMeter.meter_key)
        )
    )
    billable = tuple(
        row for row in billable_rows if row.meter_role is ModelUsageMeterRole.BILLABLE
    )
    if not billable or any(
        (
            (rate := rates.get(row.meter)) is None
            or rate.meter_role is not ModelUsageMeterRole.BILLABLE
            or rate.unit_quantity <= 0
            or rate.unit_price_cny is None
            or rate.unit_price_cny < 0
        )
        for row in billable
    ):
        raise ModelUsageAdjustmentValidationError("pricing_resolution_snapshot_incomplete")
    resolved_cost = sum(
        (
            exact_line_cost(
                effective_before_line.quantity(row.meter),
                rates[row.meter].unit_price_cny,
                rates[row.meter].unit_quantity,
            )
            for row in billable
        ),
        Decimal("0"),
    )
    if line.resolved_cost_cny != resolved_cost:
        raise ModelUsageAdjustmentValidationError("pricing_resolution_cost_mismatch")


def _validate_command(command: AdjustmentCommand) -> None:
    values = (
        command.family_id,
        command.source_event_id,
        command.idempotency_key,
        command.fingerprint,
        command.reason_code,
        command.operator,
        command.change_ticket,
        command.evidence_ref,
    )
    if any(not value.strip() for value in values) or not command.lines:
        raise ModelUsageAdjustmentValidationError("adjustment_command_incomplete")


def _counter_dimensions(
    event: ModelUsageEvent,
    lines: Sequence[AdjustmentLineCommand],
) -> tuple[str, ...]:
    dimensions = [
        family_cost_dimension_key(),
        capability_cost_dimension_key(event.capability),
    ]
    meters = sorted(
        {
            line.meter
            for line in lines
            if line.meter is not None
            and line.meter_delta is not None
            and capability_meter_contract(event.capability, line.meter).guardrail_eligible
        },
        key=lambda item: item.value,
    )
    dimensions.extend(capability_meter_dimension_key(event.capability, meter) for meter in meters)
    return tuple(dimensions)


def _lock_adjustment_counters(
    db: Session,
    *,
    event: ModelUsageEvent,
    lines: Sequence[AdjustmentLineCommand],
) -> tuple[ModelUsagePeriodCounter, ...]:
    dimensions = _counter_dimensions(event, lines)
    rows: list[ModelUsagePeriodCounter] = []
    for dimension in dimensions:
        row = db.scalar(
            select(ModelUsagePeriodCounter)
            .where(
                ModelUsagePeriodCounter.family_id == event.family_id,
                ModelUsagePeriodCounter.period_start == event.period_start,
                ModelUsagePeriodCounter.dimension_key == dimension,
            )
            .with_for_update()
        )
        if row is None:
            raise ModelUsageStateError("adjustment_counter_missing")
        rows.append(row)
    return tuple(rows)


def _counter_delta(
    lines: Sequence[AdjustmentLineCommand | ModelUsageAdjustment],
) -> AdjustmentCounterDelta:
    meter_values: dict[ModelUsageMeter, Decimal] = {}
    cost = Decimal("0")
    for line in lines:
        if line.cost_delta_cny is not None:
            cost += line.cost_delta_cny
        if line.meter is not None and line.meter_delta is not None:
            meter_values[line.meter] = (
                meter_values.get(line.meter, Decimal("0")) + line.meter_delta
            )
    return AdjustmentCounterDelta(cost=cost, meter_values=meter_values)


def _lock_current_policy(
    db: Session,
    *,
    family_id: str,
) -> ModelUsagePolicyVersion:
    pointer = lock_family_policy(db, family_id=family_id)
    policy = db.get(ModelUsagePolicyVersion, pointer.current_policy_version_id)
    if policy is None:
        raise ModelUsageStateError("current_policy_missing")
    return policy


def _lock_open_source_event(
    db: Session,
    command: AdjustmentCommand,
) -> tuple[ModelUsageEvent, ModelUsageMonthlyRollup]:
    try:
        event = require_family_event_for_update(
            db,
            family_id=command.family_id,
            event_id=command.source_event_id,
        )
    except LookupError as exc:
        raise ModelUsageAdjustmentValidationError("source_event_required") from exc
    if (
        command.source_reservation_id is not None
        and command.source_reservation_id != event.reservation_id
    ):
        raise ModelUsageAdjustmentValidationError("source_reservation_mismatch")
    rollup = family_total_rollup_for_update(
        db,
        family_id=event.family_id,
        period_start=event.period_start,
        rollup_kind=ModelUsageRollupKind.FAMILY_TOTAL,
    )
    if (
        rollup is None
        or rollup.correction_status is not ModelUsageCorrectionStatus.OPEN
        or rollup.adjustment_closed_at is not None
    ):
        raise ModelUsageAdjustmentWindowClosed()
    return event, rollup


def _preview_payload(
    db: Session,
    *,
    event: ModelUsageEvent,
    state_before: EffectiveUsageState,
    state_after: EffectiveUsageState,
    counter_delta: AdjustmentCounterDelta,
    counters: Sequence[ModelUsagePeriodCounter],
    policy: ModelUsagePolicyVersion,
    rollup: ModelUsageMonthlyRollup,
) -> dict[str, object]:
    counter_after: dict[str, dict[str, str]] = {}
    family_effective_spend: Decimal | None = None
    family_counter: ModelUsagePeriodCounter | None = None
    for counter in counters:
        adjustment_delta = Decimal("0")
        if counter.counter_kind in {
            ModelUsageCounterKind.FAMILY_COST,
            ModelUsageCounterKind.CAPABILITY_COST,
        }:
            adjustment_delta = counter_delta.cost
        elif counter.meter is not None:
            adjustment_delta = counter_delta.meter(counter.meter)
        projected_adjustment = counter.adjustment_value + adjustment_delta
        projected_effective = (
            counter.settled_value + counter.reserved_value + projected_adjustment
        )
        counter_after[counter.dimension_key] = {
            "settled_value": _canonical_decimal(counter.settled_value) or "0",
            "reserved_value": _canonical_decimal(counter.reserved_value) or "0",
            "adjustment_value": _canonical_decimal(projected_adjustment) or "0",
            "effective_value": _canonical_decimal(projected_effective) or "0",
        }
        if counter.counter_kind is ModelUsageCounterKind.FAMILY_COST:
            family_counter = counter
            family_effective_spend = counter.settled_value + projected_adjustment
    if family_effective_spend is None or family_counter is None:
        raise ModelUsageStateError("adjustment_family_cost_counter_missing")
    crossed_thresholds = pending_budget_alert_thresholds(
        db,
        policy=policy,
        counter=family_counter,
        effective_spend=family_effective_spend,
    )
    return {
        "source_event_id": event.id,
        "effective_before": {
            "cost_cny": _canonical_decimal(state_before.cost_cny),
            "meters": {
                meter.value: _canonical_decimal(quantity)
                for meter, quantity in sorted(
                    state_before.meter_quantities.items(),
                    key=lambda item: item[0].value,
                )
            },
            "execution_certainty": state_before.execution_certainty.value,
            "measurement_status": state_before.measurement_status.value,
            "pricing_status": state_before.pricing_status.value,
        },
        "effective_after": {
            "cost_cny": _canonical_decimal(state_after.cost_cny),
            "meters": {
                meter.value: _canonical_decimal(quantity)
                for meter, quantity in sorted(
                    state_after.meter_quantities.items(),
                    key=lambda item: item[0].value,
                )
            },
            "execution_certainty": state_after.execution_certainty.value,
            "measurement_status": state_after.measurement_status.value,
            "pricing_status": state_after.pricing_status.value,
        },
        "cost_delta_cny": _canonical_decimal(counter_delta.cost),
        "meter_deltas": {
            meter.value: _canonical_decimal(delta)
            for meter, delta in sorted(
                counter_delta.meter_values.items(),
                key=lambda item: item[0].value,
            )
        },
        "counter_after": counter_after,
        "rollup_revision_after": rollup.revision + 1,
        "crossed_thresholds": [format(threshold, "f") for threshold in crossed_thresholds],
    }


def _validate_execution_resolution_result(
    *,
    event: ModelUsageEvent,
    state_after: EffectiveUsageState,
    lines: Sequence[AdjustmentLineCommand],
) -> None:
    if not any(
        line.resolution_kind is ModelUsageResolutionKind.EXECUTION_RESOLUTION
        for line in lines
    ):
        return
    if (
        state_after.execution_certainty
        is not ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
    ):
        return
    if (
        state_after.provider_outcome is not ModelUsageProviderOutcome.NOT_BILLED
        or state_after.measurement_status is not ModelUsageMeasurementStatus.EXACT
        or state_after.pricing_status is not ModelUsagePricingStatus.PRICED
        or state_after.cost_cny != Decimal("0")
    ):
        raise ModelUsageAdjustmentValidationError("execution_resolution_delta_mismatch")
    for meter, quantity in state_after.meter_quantities.items():
        if (
            capability_meter_contract(event.capability, meter).guardrail_eligible
            and quantity != 0
        ):
            raise ModelUsageAdjustmentValidationError("execution_resolution_delta_mismatch")


def _preview_from_locked(
    db: Session,
    *,
    command: AdjustmentCommand,
    event: ModelUsageEvent,
    policy: ModelUsagePolicyVersion,
    counters: Sequence[ModelUsagePeriodCounter],
    rollup: ModelUsageMonthlyRollup,
) -> AdjustmentPreview:
    state_before = effective_state_for_event(db, event=event)
    state_after = state_before
    for line in command.lines:
        _validate_line(event, line)
        _validate_pricing_resolution_snapshot(
            db,
            event=event,
            line=line,
            effective_before_line=state_after,
        )
        state_after = _apply_line_to_state(state_after, line)
    _validate_execution_resolution_result(
        event=event,
        state_after=state_after,
        lines=command.lines,
    )
    payload = _preview_payload(
        db,
        event=event,
        state_before=state_before,
        state_after=state_after,
        counter_delta=_counter_delta(command.lines),
        counters=counters,
        policy=policy,
        rollup=rollup,
    )
    return AdjustmentPreview(payload=payload, checksum=_canonical_checksum(payload))


def preview_adjustment(db: Session, command: AdjustmentCommand) -> AdjustmentPreview:
    _validate_command(command)
    policy = _lock_current_policy(db, family_id=command.family_id)
    event, rollup = _lock_open_source_event(db, command)
    counters = _lock_adjustment_counters(db, event=event, lines=command.lines)
    return _preview_from_locked(
        db,
        command=command,
        event=event,
        policy=policy,
        counters=counters,
        rollup=rollup,
    )


def _line_model(
    *,
    group: ModelUsageAdjustmentGroup,
    event: ModelUsageEvent,
    command: AdjustmentLineCommand,
    line_sequence: int,
) -> ModelUsageAdjustment:
    return ModelUsageAdjustment(
        id=create_id("usage-adjustment-line"),
        adjustment_group_id=group.id,
        line_sequence=line_sequence,
        capability=event.capability,
        meter=command.meter,
        meter_delta=command.meter_delta,
        cost_delta_cny=command.cost_delta_cny,
        resolution_kind=command.resolution_kind,
        resulting_provider_outcome=command.resulting_provider_outcome,
        resulting_execution_certainty=command.resulting_execution_certainty,
        resulting_measurement_status=command.resulting_measurement_status,
        resulting_pricing_status=command.resulting_pricing_status,
        price_snapshot_json=(
            _snapshot_payload(command.price_snapshot)
            if command.price_snapshot is not None
            else None
        ),
        price_snapshot_checksum=(
            command.price_snapshot.checksum if command.price_snapshot is not None else None
        ),
        resolved_cost_cny=command.resolved_cost_cny,
    )


def _apply_counter_delta(
    *,
    event: ModelUsageEvent,
    counters: Sequence[ModelUsagePeriodCounter],
    delta: AdjustmentCounterDelta,
) -> None:
    by_dimension = {counter.dimension_key: counter for counter in counters}
    if delta.cost:
        for dimension in (
            family_cost_dimension_key(),
            capability_cost_dimension_key(event.capability),
        ):
            counter = by_dimension[dimension]
            counter.adjustment_value += delta.cost
            counter.version += 1
    for meter, meter_delta in sorted(
        delta.meter_values.items(),
        key=lambda item: item[0].value,
    ):
        if not capability_meter_contract(event.capability, meter).guardrail_eligible:
            continue
        counter = by_dimension[capability_meter_dimension_key(event.capability, meter)]
        counter.adjustment_value += meter_delta
        counter.version += 1


def _result_for_group(
    db: Session,
    *,
    group: ModelUsageAdjustmentGroup,
    preview: AdjustmentPreview | None = None,
) -> AdjustmentResult:
    event = require_family_event_for_update(
        db,
        family_id=group.family_id,
        event_id=group.source_event_id,
    )
    lines = tuple(
        db.scalars(
            select(ModelUsageAdjustment)
            .where(ModelUsageAdjustment.adjustment_group_id == group.id)
            .order_by(ModelUsageAdjustment.line_sequence, ModelUsageAdjustment.id)
        )
    )
    return AdjustmentResult(
        group=group,
        lines=lines,
        effective=effective_state_for_event(db, event=event),
        counter_delta=_counter_delta(lines),
        preview=preview,
    )


def apply_adjustment(db: Session, command: AdjustmentCommand) -> AdjustmentResult:
    _validate_command(command)

    policy = _lock_current_policy(db, family_id=command.family_id)
    existing = adjustment_group_by_idempotency_key_for_update(
        db,
        family_id=command.family_id,
        idempotency_key=command.idempotency_key,
    )
    if existing is not None:
        if existing.fingerprint != command.fingerprint:
            raise ModelUsageAdjustmentConflict()
        return _result_for_group(db, group=existing)

    event, rollup = _lock_open_source_event(db, command)
    counters = _lock_adjustment_counters(db, event=event, lines=command.lines)
    preview = _preview_from_locked(
        db,
        command=command,
        event=event,
        policy=policy,
        counters=counters,
        rollup=rollup,
    )
    if command.confirm_checksum != preview.checksum:
        raise ModelUsageAdjustmentConflict("checksum_mismatch")

    group = ModelUsageAdjustmentGroup(
        id=create_id("usage-adjustment"),
        family_id=event.family_id,
        idempotency_key=command.idempotency_key,
        fingerprint=command.fingerprint,
        subject_id=event.subject_id,
        subject_key=event.subject_key,
        period_start=event.period_start,
        period_end=event.period_end,
        source_event_id=event.id,
        source_reservation_id=command.source_reservation_id,
        reason_code=command.reason_code,
        operator=command.operator,
        change_ticket=command.change_ticket,
        evidence_ref=command.evidence_ref,
    )
    savepoint = db.begin_nested()
    try:
        db.add(group)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        winner = require_adjustment_group_for_update(
            db,
            family_id=command.family_id,
            idempotency_key=command.idempotency_key,
        )
        if winner.fingerprint != command.fingerprint:
            raise ModelUsageAdjustmentConflict()
        return _result_for_group(db, group=winner)
    else:
        savepoint.commit()

    lines = tuple(
        _line_model(group=group, event=event, command=line, line_sequence=index)
        for index, line in enumerate(command.lines, start=1)
    )
    db.add_all(lines)
    _apply_counter_delta(
        event=event,
        counters=counters,
        delta=_counter_delta(command.lines),
    )
    family_counter = next(
        counter
        for counter in counters
        if counter.counter_kind is ModelUsageCounterKind.FAMILY_COST
    )
    alert_evaluation = evaluate_budget_alerts_with_focus(
        db,
        policy=policy,
        counter=family_counter,
    )
    db.flush()
    return replace(
        _result_for_group(db, group=group, preview=preview),
        alerts=alert_evaluation.alerts,
        notification_focus=alert_evaluation.notification_focus,
    )
