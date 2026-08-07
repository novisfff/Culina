from __future__ import annotations

from collections import defaultdict
from typing import Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsagePricingStatus,
    ModelUsageResolutionKind,
)
from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageEvent,
    ModelUsageEventMeter,
)
from app.services.model_usage.adjustments import (
    EffectiveUsageState,
    _apply_line_to_state,
    effective_state_for_event,
)
from app.services.model_usage.errors import ModelUsageAdjustmentValidationError


def adjustment_group_order_key(group: ModelUsageAdjustmentGroup) -> tuple[object, str]:
    return (group.created_at, group.id)


def adjustment_line_order_key(line: ModelUsageAdjustment) -> tuple[int, str]:
    return (line.line_sequence, line.id)


def _validate_persisted_line(line: ModelUsageAdjustment) -> None:
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
                line.price_snapshot_json,
                line.price_snapshot_checksum,
                line.resolved_cost_cny,
            )
        ):
            raise ModelUsageAdjustmentValidationError("meter_correction_fields_invalid")
    elif line.resolution_kind is ModelUsageResolutionKind.PRICING_CORRECTION:
        if (
            line.meter is not None
            or line.meter_delta is not None
            or line.resulting_provider_outcome is not None
            or line.resulting_execution_certainty is not None
            or line.resulting_measurement_status is not None
            or line.resulting_pricing_status is not ModelUsagePricingStatus.PRICED
            or line.price_snapshot_json is None
            or line.price_snapshot_checksum is None
            or line.resolved_cost_cny is None
            or line.cost_delta_cny is None
        ):
            raise ModelUsageAdjustmentValidationError("pricing_correction_fields_invalid")
    elif line.resolution_kind is ModelUsageResolutionKind.EXECUTION_RESOLUTION:
        if (
            line.resulting_provider_outcome is None
            or line.resulting_execution_certainty is None
            or line.resulting_measurement_status is None
        ):
            raise ModelUsageAdjustmentValidationError("execution_resolution_status_required")
        if line.price_snapshot_json is not None or line.resolved_cost_cny is not None:
            raise ModelUsageAdjustmentValidationError("execution_resolution_fields_invalid")
    else:
        raise ModelUsageAdjustmentValidationError("unsupported_adjustment_resolution")


def project_effective_states(
    *,
    events: Sequence[ModelUsageEvent],
    event_meters: Sequence[ModelUsageEventMeter],
    adjustment_groups: Sequence[ModelUsageAdjustmentGroup],
    adjustment_lines: Sequence[ModelUsageAdjustment],
) -> Mapping[str, EffectiveUsageState]:
    """Bulk-project effective state with the canonical append order."""

    events_by_id = {event.id: event for event in events}
    meters_by_event: dict[str, list[ModelUsageEventMeter]] = defaultdict(list)
    for meter in event_meters:
        if meter.event_id not in events_by_id:
            raise ValueError("model_usage_event_meter_source_mismatch")
        meters_by_event[meter.event_id].append(meter)

    groups_by_event: dict[str, list[ModelUsageAdjustmentGroup]] = defaultdict(list)
    groups_by_id: dict[str, ModelUsageAdjustmentGroup] = {}
    for group in adjustment_groups:
        event = events_by_id.get(group.source_event_id)
        if event is None or group.family_id != event.family_id:
            raise ValueError("model_usage_adjustment_source_mismatch")
        groups_by_event[event.id].append(group)
        groups_by_id[group.id] = group

    lines_by_group: dict[str, list[ModelUsageAdjustment]] = defaultdict(list)
    for line in adjustment_lines:
        if line.adjustment_group_id not in groups_by_id:
            raise ValueError("model_usage_adjustment_group_mismatch")
        _validate_persisted_line(line)
        lines_by_group[line.adjustment_group_id].append(line)

    projected: dict[str, EffectiveUsageState] = {}
    for event in events:
        state = EffectiveUsageState(
            source_event_id=event.id,
            capability=event.capability,
            cost_cny=event.cost_cny,
            meter_quantities={
                meter.meter: meter.quantity
                for meter in sorted(
                    meters_by_event[event.id], key=lambda item: item.meter_key
                )
            },
            execution_certainty=event.execution_certainty,
            measurement_status=event.measurement_status,
            pricing_status=event.pricing_status,
            provider_outcome=event.provider_outcome,
            meter_costs={
                meter.meter: meter.cost_cny
                for meter in sorted(
                    meters_by_event[event.id], key=lambda item: item.meter_key
                )
            },
            meter_roles={
                meter.meter: meter.meter_role
                for meter in sorted(
                    meters_by_event[event.id], key=lambda item: item.meter_key
                )
            },
        )
        for group in sorted(groups_by_event[event.id], key=adjustment_group_order_key):
            for line in sorted(
                lines_by_group[group.id], key=adjustment_line_order_key
            ):
                state = _apply_line_to_state(state, line)
        projected[event.id] = state
    return projected


def effective_event_state(
    db: Session,
    *,
    family_id: str,
    event_id: str,
) -> EffectiveUsageState:
    """Project an immutable event through its append-only adjustment history.

    The event lookup is always family-scoped. Adjustment loading remains scoped
    by the source event's persisted family in ``effective_state_for_event``.
    """

    statement = select(ModelUsageEvent).where(
        ModelUsageEvent.id == event_id,
        ModelUsageEvent.family_id == family_id,
    )
    event = db.scalar(statement)
    if event is None:
        raise LookupError("model_usage_event_not_found")
    return effective_state_for_event(db, event=event)
