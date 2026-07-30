from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCorrectionStatus,
    ModelUsageExecutionCertainty,
    ModelUsageIncidentCoverage,
    ModelUsageMeasurementStatus,
    ModelUsagePricingStatus,
    ModelUsageReservationStatus,
    ModelUsageRollupKind,
)
from app.core.utils import create_id
from app.models.model_usage import ModelUsageMonthlyRollup
from app.repos.model_usage.reporting import (
    active_reservations_for_period,
    adjustment_groups_for_period,
    adjustment_lines_for_period_groups,
    event_meters_for_period_events,
    family_events_for_period,
    family_subjects_for_reporting,
    historical_rollups_for_period,
    incidents_for_period,
    unresolved_incident_attempts,
)
from app.services.model_usage.effective_state import project_effective_states
from app.services.model_usage.periods import BillingPeriod, SHANGHAI


def rollup_dimension_key(
    kind: ModelUsageRollupKind,
    dimensions: Mapping[str, str],
) -> str:
    normalized = "|".join(
        f"{key}={dimensions[key]}" for key in sorted(dimensions)
    )
    return f"{kind.value}|{normalized}" if normalized else kind.value


def _canonical_value(value: object) -> object:
    if isinstance(value, Decimal):
        if value == 0:
            return "0"
        return format(value.normalize(), "f")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat(timespec="microseconds")
    if isinstance(value, date):
        return value.isoformat()
    if hasattr(value, "value"):
        return getattr(value, "value")
    if isinstance(value, Mapping):
        return {str(key): _canonical_value(item) for key, item in value.items()}
    if isinstance(value, (set, frozenset)):
        return sorted(
            (_canonical_value(item) for item in value),
            key=lambda item: json.dumps(item, sort_keys=True),
        )
    if isinstance(value, (tuple, list)):
        return [_canonical_value(item) for item in value]
    return value


def _checksum(payload: object) -> str:
    encoded = json.dumps(
        _canonical_value(payload),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(slots=True)
class _DimensionAccumulator:
    kind: ModelUsageRollupKind
    dimensions: dict[str, str]
    subject_id: str | None = None
    subject_key: str | None = None
    capability: object | None = None
    provider: str | None = None
    billing_model: str | None = None
    meter: object | None = None
    local_day: object | None = None
    exact_event_count: int = 0
    estimated_event_count: int = 0
    unpriced_event_count: int = 0
    uncertain_attempt_count: int = 0
    unresolved_unknown_execution_count: int = 0
    unresolved_known_unmeasured_count: int = 0
    has_unknown_measurement_gap: bool = False
    meter_total: Decimal | None = None
    known_cost_total_cny: Decimal = Decimal("0")
    priced_event_count: int = 0
    source_event_ids: set[str] = field(default_factory=set)
    source_adjustment_ids: set[str] = field(default_factory=set)
    source_incident_ids: set[str] = field(default_factory=set)

    @property
    def dimension_key(self) -> str:
        return rollup_dimension_key(self.kind, self.dimensions)

    @property
    def cost_total_cny(self) -> Decimal | None:
        if self.source_event_ids and self.priced_event_count == 0:
            return None
        return self.known_cost_total_cny


@dataclass(frozen=True, slots=True)
class RollupBuildResult:
    rows: tuple[ModelUsageMonthlyRollup, ...]
    source_watermark: str
    checksum: str
    revision: int


def _row_payload(accumulator: _DimensionAccumulator) -> dict[str, object]:
    return {
        "rollup_kind": accumulator.kind,
        "dimension_key": accumulator.dimension_key,
        "subject_id": accumulator.subject_id,
        "subject_key": accumulator.subject_key,
        "capability": accumulator.capability,
        "provider": accumulator.provider,
        "billing_model": accumulator.billing_model,
        "meter": accumulator.meter,
        "local_day": accumulator.local_day,
        "exact_event_count": accumulator.exact_event_count,
        "estimated_event_count": accumulator.estimated_event_count,
        "unpriced_event_count": accumulator.unpriced_event_count,
        "uncertain_attempt_count": accumulator.uncertain_attempt_count,
        "unresolved_unknown_execution_count": (
            accumulator.unresolved_unknown_execution_count
        ),
        "unresolved_known_unmeasured_count": (
            accumulator.unresolved_known_unmeasured_count
        ),
        "has_unknown_measurement_gap": accumulator.has_unknown_measurement_gap,
        "meter_total": accumulator.meter_total,
        "cost_total_cny": accumulator.cost_total_cny,
        "source_event_count": len(accumulator.source_event_ids),
        "source_adjustment_count": len(accumulator.source_adjustment_ids),
        "source_incident_count": len(accumulator.source_incident_ids),
    }


def _result_from_existing(rows: Sequence[ModelUsageMonthlyRollup]) -> RollupBuildResult:
    ordered = tuple(sorted(rows, key=lambda row: row.dimension_key))
    payload = [(row.dimension_key, row.checksum, row.revision) for row in ordered]
    watermarks = {row.source_watermark for row in ordered}
    return RollupBuildResult(
        rows=ordered,
        source_watermark=(
            next(iter(watermarks))
            if len(watermarks) == 1
            else _checksum([(row.dimension_key, row.source_watermark) for row in ordered])
        ),
        checksum=_checksum(payload),
        revision=max((row.revision for row in ordered), default=0),
    )


def rebuild_monthly_rollups(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    computed_at: datetime | None = None,
) -> RollupBuildResult:
    family_existing = db.scalar(
        select(ModelUsageMonthlyRollup).where(
            ModelUsageMonthlyRollup.family_id == family_id,
            ModelUsageMonthlyRollup.period_start == period.start_at,
            ModelUsageMonthlyRollup.dimension_key
            == rollup_dimension_key(ModelUsageRollupKind.FAMILY_TOTAL, {}),
        )
    )
    if family_existing is not None and (
        family_existing.correction_status is ModelUsageCorrectionStatus.CLOSED
        or family_existing.raw_data_pruned_at is not None
    ):
        return _result_from_existing(
            historical_rollups_for_period(db, family_id=family_id, period=period)
        )

    events = family_events_for_period(db, family_id=family_id, period=period)
    event_ids = tuple(event.id for event in events)
    meters = event_meters_for_period_events(
        db, family_id=family_id, period=period, event_ids=event_ids
    )
    groups = adjustment_groups_for_period(
        db, family_id=family_id, period=period, event_ids=event_ids
    )
    lines = adjustment_lines_for_period_groups(
        db,
        family_id=family_id,
        period=period,
        group_ids=tuple(group.id for group in groups),
    )
    reservations = active_reservations_for_period(
        db, family_id=family_id, period=period
    )
    incidents = incidents_for_period(db, family_id=family_id, period=period)
    incident_attempts = unresolved_incident_attempts(
        db,
        family_id=family_id,
        incident_ids=tuple(incident.id for incident in incidents),
    )
    effective = project_effective_states(
        events=events,
        event_meters=meters,
        adjustment_groups=groups,
        adjustment_lines=lines,
    )
    subjects = family_subjects_for_reporting(db, family_id=family_id)

    source_payload = {
        "subjects": [
            (
                subject.id,
                subject.subject_key,
                subject.subject_kind,
                subject.anonymized_label,
                subject.unlinked_at,
            )
            for subject in subjects
        ],
        "events": [
            {
                "id": event.id,
                "created_at": event.created_at,
                "subject_key": event.subject_key,
                "capability": event.capability,
                "provider": event.provider,
                "billing_model": event.billing_model,
                "completed_at": event.completed_at,
                "execution_certainty": event.execution_certainty,
                "measurement_status": event.measurement_status,
                "pricing_status": event.pricing_status,
                "cost_cny": event.cost_cny,
            }
            for event in events
        ],
        "meters": [
            (row.id, row.event_id, row.meter, row.quantity, row.quantity_source)
            for row in meters
        ],
        "groups": [
            (group.id, group.source_event_id, group.created_at) for group in groups
        ],
        "lines": [
            (
                line.id,
                line.adjustment_group_id,
                line.line_sequence,
                line.resolution_kind,
                line.meter,
                line.meter_delta,
                line.cost_delta_cny,
                line.resulting_provider_outcome,
                line.resulting_execution_certainty,
                line.resulting_measurement_status,
                line.resulting_pricing_status,
                line.price_snapshot_json,
                line.price_snapshot_checksum,
                line.resolved_cost_cny,
            )
            for line in lines
        ],
        "reservations": [(row.id, row.status, row.updated_at) for row in reservations],
        "incidents": [
            (row.id, row.coverage, row.updated_at, row.recovered_at) for row in incidents
        ],
        "attempts": [
            (row.id, row.incident_id, row.recovery_status, row.resolved_at)
            for row in incident_attempts
        ],
    }
    source_checksum = _checksum(source_payload)
    source_watermark = (
        f"e:{len(events)}|a:{len(lines)}|i:{len(incidents)}|sha256:{source_checksum}"
    )

    accumulators: dict[str, _DimensionAccumulator] = {}

    def dimension(
        kind: ModelUsageRollupKind,
        dimensions: Mapping[str, str],
        **fields: object,
    ) -> _DimensionAccumulator:
        key = rollup_dimension_key(kind, dimensions)
        if key not in accumulators:
            accumulators[key] = _DimensionAccumulator(
                kind=kind,
                dimensions=dict(dimensions),
                **fields,
            )
        return accumulators[key]

    family = dimension(ModelUsageRollupKind.FAMILY_TOTAL, {})
    for subject in subjects:
        dimension(
            ModelUsageRollupKind.SUBJECT_TOTAL,
            {"subject_key": subject.subject_key},
            subject_id=subject.id,
            subject_key=subject.subject_key,
        )
    lines_by_event: dict[str, set[str]] = {event.id: set() for event in events}
    group_source = {group.id: group.source_event_id for group in groups}
    for line in lines:
        lines_by_event[group_source[line.adjustment_group_id]].add(line.id)

    for event in events:
        state = effective[event.id]
        local_day = event.completed_at.astimezone(SHANGHAI).date()
        related = (
            family,
            dimension(
                ModelUsageRollupKind.SUBJECT_TOTAL,
                {"subject_key": event.subject_key},
                subject_id=event.subject_id,
                subject_key=event.subject_key,
            ),
            dimension(
                ModelUsageRollupKind.CAPABILITY_TOTAL,
                {"capability": event.capability.value},
                capability=event.capability,
            ),
            dimension(
                ModelUsageRollupKind.CAPABILITY_TOTAL,
                {
                    "subject_key": event.subject_key,
                    "capability": event.capability.value,
                },
                subject_id=event.subject_id,
                subject_key=event.subject_key,
                capability=event.capability,
            ),
            dimension(
                ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
                {"provider": event.provider, "billing_model": event.billing_model},
                provider=event.provider,
                billing_model=event.billing_model,
            ),
            dimension(
                ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
                {
                    "subject_key": event.subject_key,
                    "provider": event.provider,
                    "billing_model": event.billing_model,
                },
                subject_id=event.subject_id,
                subject_key=event.subject_key,
                provider=event.provider,
                billing_model=event.billing_model,
            ),
            dimension(
                ModelUsageRollupKind.DAILY_CAPABILITY_COST,
                {"local_day": local_day.isoformat(), "capability": event.capability.value},
                capability=event.capability,
                local_day=local_day,
            ),
            dimension(
                ModelUsageRollupKind.DAILY_CAPABILITY_COST,
                {
                    "subject_key": event.subject_key,
                    "local_day": local_day.isoformat(),
                    "capability": event.capability.value,
                },
                subject_id=event.subject_id,
                subject_key=event.subject_key,
                capability=event.capability,
                local_day=local_day,
            ),
        )
        for accumulator in related:
            accumulator.source_event_ids.add(event.id)
            accumulator.source_adjustment_ids.update(lines_by_event[event.id])
            if state.measurement_status is ModelUsageMeasurementStatus.EXACT:
                accumulator.exact_event_count += 1
            else:
                accumulator.estimated_event_count += 1
            if state.pricing_status is ModelUsagePricingStatus.UNPRICED:
                accumulator.unpriced_event_count += 1
            elif state.cost_cny is not None:
                accumulator.known_cost_total_cny += state.cost_cny
                accumulator.priced_event_count += 1
            if state.execution_certainty is ModelUsageExecutionCertainty.UNKNOWN:
                accumulator.unresolved_unknown_execution_count += 1

        for meter, quantity in sorted(
            state.meter_quantities.items(), key=lambda item: item[0].value
        ):
            meter_dimension = dimension(
                ModelUsageRollupKind.METER_TOTAL,
                {"meter": meter.value},
                meter=meter,
                meter_total=Decimal("0"),
            )
            meter_dimension.source_event_ids.add(event.id)
            meter_dimension.source_adjustment_ids.update(lines_by_event[event.id])
            if state.measurement_status is ModelUsageMeasurementStatus.EXACT:
                meter_dimension.exact_event_count += 1
            else:
                meter_dimension.estimated_event_count += 1
            if state.pricing_status is ModelUsagePricingStatus.UNPRICED:
                meter_dimension.unpriced_event_count += 1
            if state.execution_certainty is ModelUsageExecutionCertainty.UNKNOWN:
                meter_dimension.unresolved_unknown_execution_count += 1
            meter_dimension.meter_total = (meter_dimension.meter_total or Decimal("0")) + quantity
            subject_meter_dimension = dimension(
                ModelUsageRollupKind.METER_TOTAL,
                {"subject_key": event.subject_key, "meter": meter.value},
                subject_id=event.subject_id,
                subject_key=event.subject_key,
                meter=meter,
                meter_total=Decimal("0"),
            )
            subject_meter_dimension.source_event_ids.add(event.id)
            subject_meter_dimension.source_adjustment_ids.update(lines_by_event[event.id])
            if state.measurement_status is ModelUsageMeasurementStatus.EXACT:
                subject_meter_dimension.exact_event_count += 1
            else:
                subject_meter_dimension.estimated_event_count += 1
            if state.pricing_status is ModelUsagePricingStatus.UNPRICED:
                subject_meter_dimension.unpriced_event_count += 1
            if state.execution_certainty is ModelUsageExecutionCertainty.UNKNOWN:
                subject_meter_dimension.unresolved_unknown_execution_count += 1
            subject_meter_dimension.meter_total = (
                subject_meter_dimension.meter_total or Decimal("0")
            ) + quantity

    for reservation in reservations:
        if reservation.status is not ModelUsageReservationStatus.UNCERTAIN:
            continue
        for accumulator in (
            family,
            dimension(
                ModelUsageRollupKind.SUBJECT_TOTAL,
                {"subject_key": reservation.subject_key},
                subject_id=reservation.subject_id,
                subject_key=reservation.subject_key,
            ),
            dimension(
                ModelUsageRollupKind.CAPABILITY_TOTAL,
                {"capability": reservation.capability.value},
                capability=reservation.capability,
            ),
            dimension(
                ModelUsageRollupKind.CAPABILITY_TOTAL,
                {
                    "subject_key": reservation.subject_key,
                    "capability": reservation.capability.value,
                },
                subject_id=reservation.subject_id,
                subject_key=reservation.subject_key,
                capability=reservation.capability,
            ),
            dimension(
                ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
                {
                    "provider": reservation.provider,
                    "billing_model": reservation.billing_model,
                },
                provider=reservation.provider,
                billing_model=reservation.billing_model,
            ),
            dimension(
                ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
                {
                    "subject_key": reservation.subject_key,
                    "provider": reservation.provider,
                    "billing_model": reservation.billing_model,
                },
                subject_id=reservation.subject_id,
                subject_key=reservation.subject_key,
                provider=reservation.provider,
                billing_model=reservation.billing_model,
            ),
        ):
            accumulator.uncertain_attempt_count += 1

    attempts_by_incident: dict[str, int] = {}
    for attempt in incident_attempts:
        attempts_by_incident[attempt.incident_id] = (
            attempts_by_incident.get(attempt.incident_id, 0) + 1
        )
    for incident in incidents:
        related = [family]
        if incident.subject_key is not None:
            related.append(
                dimension(
                    ModelUsageRollupKind.SUBJECT_TOTAL,
                    {"subject_key": incident.subject_key},
                    subject_id=incident.subject_id,
                    subject_key=incident.subject_key,
                )
            )
        if incident.capability is not None:
            related.append(
                dimension(
                    ModelUsageRollupKind.CAPABILITY_TOTAL,
                    {"capability": incident.capability.value},
                    capability=incident.capability,
                )
            )
        for accumulator in related:
            accumulator.source_incident_ids.add(incident.id)
            accumulator.unresolved_known_unmeasured_count += attempts_by_incident.get(
                incident.id, 0
            )
            if incident.coverage is ModelUsageIncidentCoverage.UNKNOWN_SCOPE:
                accumulator.has_unknown_measurement_gap = True
        if (
            incident.subject_id is None
            and incident.coverage is ModelUsageIncidentCoverage.UNKNOWN_SCOPE
        ):
            for accumulator in accumulators.values():
                if accumulator.kind is ModelUsageRollupKind.SUBJECT_TOTAL:
                    accumulator.source_incident_ids.add(incident.id)
                    accumulator.has_unknown_measurement_gap = True

    now = computed_at or datetime.now(timezone.utc)
    persisted: list[ModelUsageMonthlyRollup] = []
    for accumulator in sorted(
        accumulators.values(), key=lambda item: item.dimension_key
    ):
        payload = _row_payload(accumulator)
        checksum = _checksum(payload)
        existing = db.scalar(
            select(ModelUsageMonthlyRollup)
            .where(
                ModelUsageMonthlyRollup.family_id == family_id,
                ModelUsageMonthlyRollup.period_start == period.start_at,
                ModelUsageMonthlyRollup.dimension_key == accumulator.dimension_key,
            )
            .with_for_update()
        )
        values = {
            **payload,
            "source_watermark": source_watermark,
            "checksum": checksum,
        }
        if existing is None:
            existing = ModelUsageMonthlyRollup(
                id=create_id("usage-rollup"),
                family_id=family_id,
                period_start=period.start_at,
                period_end=period.end_at,
                revision=1,
                correction_status=ModelUsageCorrectionStatus.OPEN,
                adjustment_closed_at=None,
                raw_data_pruned_at=None,
                computed_at=now,
                **values,
            )
            db.add(existing)
        elif existing.checksum != checksum:
            for key, value in values.items():
                setattr(existing, key, value)
            existing.revision += 1
            existing.computed_at = now
        persisted.append(existing)
    db.flush()
    return _result_from_existing(persisted)
