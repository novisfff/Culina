from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from types import MappingProxyType
from typing import Mapping, Sequence

from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageIncidentCoverage,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsagePricingStatus,
    ModelUsageReservationStatus,
    ModelUsageRollupKind,
)
from app.models.model_usage import ModelUsageMonthlyRollup
from app.services.model_usage.adjustments import EffectiveUsageState
from app.services.model_usage.counters import effective_counter_value
from app.services.model_usage.effective_state import project_effective_states
from app.services.model_usage.periods import BillingPeriod


@dataclass(frozen=True, slots=True)
class AggregateEvent:
    event_id: str
    subject_id: str
    capability: object
    provider: str
    billing_model: str
    completed_at: datetime
    effective: EffectiveUsageState


@dataclass(frozen=True, slots=True)
class AggregateReservation:
    reservation_id: str
    status: ModelUsageReservationStatus


@dataclass(frozen=True, slots=True)
class AggregateIncident:
    incident_id: str
    coverage: ModelUsageIncidentCoverage
    started_at: datetime
    ended_at: datetime
    scope: tuple[str, ...]
    known_unmeasured_attempt_count: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "scope", tuple(self.scope))
        if self.known_unmeasured_attempt_count < 0:
            raise ValueError("known_unmeasured_attempt_count_cannot_be_negative")


@dataclass(frozen=True, slots=True)
class UsageGapInterval:
    started_at: datetime
    ended_at: datetime
    scope: tuple[str, ...]
    coverage: ModelUsageIncidentCoverage


@dataclass(frozen=True, slots=True)
class UsageAggregate:
    known_priced_cost_cny: Decimal = Decimal("0")
    exact_event_count: int = 0
    estimated_event_count: int = 0
    unpriced_event_count: int = 0
    uncertain_attempt_count: int = 0
    pending_attempt_count: int = 0
    unresolved_unknown_execution_attempt_count: int = 0
    conservative_estimated_cost_cny: Decimal | None = None
    known_unmeasured_attempt_count: int = 0
    measurement_gap: bool = False
    measurement_gap_scope: tuple[str, ...] = ()
    gap_intervals: tuple[UsageGapInterval, ...] = ()
    meter_totals: Mapping[ModelUsageMeter, Decimal] = field(default_factory=dict)
    counter_values: Mapping[str, Decimal] = field(default_factory=dict)
    source_event_count: int = 0
    source_reservation_count: int = 0
    source_incident_count: int = 0

    def __post_init__(self) -> None:
        object.__setattr__(self, "measurement_gap_scope", tuple(self.measurement_gap_scope))
        object.__setattr__(self, "gap_intervals", tuple(self.gap_intervals))
        object.__setattr__(self, "meter_totals", MappingProxyType(dict(self.meter_totals)))
        object.__setattr__(self, "counter_values", MappingProxyType(dict(self.counter_values)))

    @property
    def pricing_complete(self) -> bool:
        return self.unpriced_event_count == 0

    @property
    def total_cost_cny(self) -> Decimal | None:
        return self.known_priced_cost_cny if self.pricing_complete else None


def aggregate_usage(
    *,
    events: Sequence[AggregateEvent] = (),
    reservations: Sequence[AggregateReservation] = (),
    incidents: Sequence[AggregateIncident] = (),
    counter_values: Mapping[str, Decimal] | None = None,
) -> UsageAggregate:
    known_cost = Decimal("0")
    conservative_cost = Decimal("0")
    has_conservative_cost = False
    exact_count = 0
    estimated_count = 0
    unpriced_count = 0
    unresolved_unknown_count = 0
    meter_totals: dict[ModelUsageMeter, Decimal] = {}

    for item in events:
        state = item.effective
        if state.measurement_status is ModelUsageMeasurementStatus.EXACT:
            exact_count += 1
        else:
            estimated_count += 1
        if state.pricing_status is ModelUsagePricingStatus.UNPRICED:
            unpriced_count += 1
        elif state.cost_cny is not None:
            known_cost += state.cost_cny
        if state.execution_certainty is ModelUsageExecutionCertainty.UNKNOWN:
            unresolved_unknown_count += 1
        if (
            state.cost_cny is not None
            and (
                state.measurement_status is ModelUsageMeasurementStatus.ESTIMATED
                or state.execution_certainty is ModelUsageExecutionCertainty.UNKNOWN
            )
        ):
            conservative_cost += state.cost_cny
            has_conservative_cost = True
        for meter, quantity in state.meter_quantities.items():
            meter_totals[meter] = meter_totals.get(meter, Decimal("0")) + quantity

    pending_count = sum(
        reservation.status
        in (ModelUsageReservationStatus.RESERVED, ModelUsageReservationStatus.DISPATCHING)
        for reservation in reservations
    )
    uncertain_count = sum(
        reservation.status is ModelUsageReservationStatus.UNCERTAIN
        for reservation in reservations
    )

    ordered_incidents = sorted(
        incidents,
        key=lambda item: (item.started_at, item.ended_at, item.incident_id),
    )
    gap_scope = tuple(
        sorted({scope for incident in ordered_incidents for scope in incident.scope})
    )
    gap_intervals = tuple(
        UsageGapInterval(
            started_at=incident.started_at,
            ended_at=incident.ended_at,
            scope=incident.scope,
            coverage=incident.coverage,
        )
        for incident in ordered_incidents
    )

    return UsageAggregate(
        known_priced_cost_cny=known_cost,
        exact_event_count=exact_count,
        estimated_event_count=estimated_count,
        unpriced_event_count=unpriced_count,
        uncertain_attempt_count=uncertain_count,
        pending_attempt_count=pending_count,
        unresolved_unknown_execution_attempt_count=unresolved_unknown_count,
        conservative_estimated_cost_cny=(
            conservative_cost if has_conservative_cost else None
        ),
        known_unmeasured_attempt_count=sum(
            incident.known_unmeasured_attempt_count for incident in ordered_incidents
        ),
        measurement_gap=bool(ordered_incidents),
        measurement_gap_scope=gap_scope,
        gap_intervals=gap_intervals,
        meter_totals=meter_totals,
        counter_values=counter_values or {},
        source_event_count=len(events),
        source_reservation_count=len(reservations),
        source_incident_count=len(incidents),
    )


def aggregate_raw_usage(
    *,
    events: Sequence[AggregateEvent] = (),
    reservations: Sequence[AggregateReservation] = (),
    incidents: Sequence[AggregateIncident] = (),
    counter_values: Mapping[str, Decimal] | None = None,
) -> UsageAggregate:
    return aggregate_usage(
        events=events,
        reservations=reservations,
        incidents=incidents,
        counter_values=counter_values,
    )


def _aggregate_current_period(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    subject_id: str | None,
    include_counters: bool,
) -> UsageAggregate:
    from app.repos.model_usage.reporting import (
        active_reservations_for_period,
        adjustment_groups_for_period,
        adjustment_lines_for_period_groups,
        event_meters_for_period_events,
        family_counters_for_period,
        family_events_for_period,
        incidents_for_period,
        subject_events_for_period,
        unresolved_incident_attempts,
    )

    events = (
        family_events_for_period(db, family_id=family_id, period=period)
        if subject_id is None
        else subject_events_for_period(
            db,
            family_id=family_id,
            subject_id=subject_id,
            period=period,
        )
    )
    event_ids = tuple(event.id for event in events)
    meters = event_meters_for_period_events(
        db,
        family_id=family_id,
        period=period,
        event_ids=event_ids,
        subject_id=subject_id,
    )
    groups = adjustment_groups_for_period(
        db,
        family_id=family_id,
        period=period,
        event_ids=event_ids,
        subject_id=subject_id,
    )
    lines = adjustment_lines_for_period_groups(
        db,
        family_id=family_id,
        period=period,
        group_ids=tuple(group.id for group in groups),
        subject_id=subject_id,
    )
    effective = project_effective_states(
        events=events,
        event_meters=meters,
        adjustment_groups=groups,
        adjustment_lines=lines,
    )
    reservations = active_reservations_for_period(
        db,
        family_id=family_id,
        period=period,
        subject_id=subject_id,
    )
    incidents = incidents_for_period(
        db,
        family_id=family_id,
        period=period,
        subject_id=subject_id,
    )
    attempts = unresolved_incident_attempts(
        db,
        family_id=family_id,
        incident_ids=tuple(incident.id for incident in incidents),
        subject_id=subject_id,
    )
    attempt_counts: dict[str, int] = {}
    for attempt in attempts:
        attempt_counts[attempt.incident_id] = attempt_counts.get(attempt.incident_id, 0) + 1

    aggregate_events = tuple(
        AggregateEvent(
            event_id=event.id,
            subject_id=event.subject_id,
            capability=event.capability,
            provider=event.provider,
            billing_model=event.billing_model,
            completed_at=event.completed_at,
            effective=effective[event.id],
        )
        for event in events
    )
    aggregate_reservations = tuple(
        AggregateReservation(reservation_id=row.id, status=row.status)
        for row in reservations
    )
    aggregate_incidents = tuple(
        AggregateIncident(
            incident_id=incident.id,
            coverage=incident.coverage,
            started_at=max(incident.started_at, period.start_at),
            ended_at=min(incident.recovered_at or incident.period_end, period.end_at),
            scope=tuple(
                value
                for value in (
                    "global" if incident.family_id is None else "family",
                    (
                        f"subject:{incident.subject_key}"
                        if incident.subject_key is not None
                        else None
                    ),
                    (
                        f"capability:{incident.capability.value}"
                        if incident.capability is not None
                        else None
                    ),
                )
                if value is not None
            ),
            known_unmeasured_attempt_count=attempt_counts.get(incident.id, 0),
        )
        for incident in incidents
    )
    counters = (
        family_counters_for_period(db, family_id=family_id, period=period)
        if include_counters
        else ()
    )
    return aggregate_usage(
        events=aggregate_events,
        reservations=aggregate_reservations,
        incidents=aggregate_incidents,
        counter_values={
            counter.dimension_key: effective_counter_value(counter) for counter in counters
        },
    )


def aggregate_family_current_period(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
) -> UsageAggregate:
    return _aggregate_current_period(
        db,
        family_id=family_id,
        period=period,
        subject_id=None,
        include_counters=True,
    )


def aggregate_personal_current_period(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    period: BillingPeriod,
) -> UsageAggregate:
    from app.repos.model_usage.reporting import require_user_subject

    subject = require_user_subject(db, family_id=family_id, user_id=user_id)
    return _aggregate_current_period(
        db,
        family_id=family_id,
        period=period,
        subject_id=subject.id,
        include_counters=False,
    )


def aggregate_historical_rollups(
    rows: Sequence[ModelUsageMonthlyRollup],
    *,
    rollup_kind: ModelUsageRollupKind,
    subject_id: str | None = None,
) -> UsageAggregate:
    candidates = [
        row
        for row in rows
        if row.rollup_kind is rollup_kind
        and (subject_id is None or row.subject_id == subject_id)
    ]
    if len(candidates) != 1:
        raise LookupError("model_usage_historical_rollup_not_found")
    total = candidates[0]
    meter_totals = {
        row.meter: row.meter_total
        for row in rows
        if row.rollup_kind is ModelUsageRollupKind.METER_TOTAL
        and row.subject_id == subject_id
        and row.meter is not None
        and row.meter_total is not None
    }
    return UsageAggregate(
        known_priced_cost_cny=total.cost_total_cny or Decimal("0"),
        exact_event_count=total.exact_event_count,
        estimated_event_count=total.estimated_event_count,
        unpriced_event_count=total.unpriced_event_count,
        uncertain_attempt_count=total.uncertain_attempt_count,
        pending_attempt_count=0,
        unresolved_unknown_execution_attempt_count=(
            total.unresolved_unknown_execution_count
        ),
        conservative_estimated_cost_cny=None,
        known_unmeasured_attempt_count=total.unresolved_known_unmeasured_count,
        measurement_gap=(
            total.has_unknown_measurement_gap
            or total.unresolved_known_unmeasured_count > 0
        ),
        measurement_gap_scope=(
            ("family",)
            if (
                total.has_unknown_measurement_gap
                or total.unresolved_known_unmeasured_count > 0
            )
            else ()
        ),
        gap_intervals=(),
        meter_totals=meter_totals,
        counter_values={},
        source_event_count=total.source_event_count,
        source_reservation_count=total.uncertain_attempt_count,
        source_incident_count=total.source_incident_count,
    )


def aggregate_family_historical_period(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
) -> UsageAggregate:
    from app.repos.model_usage.reporting import historical_rollups_for_period

    return aggregate_historical_rollups(
        historical_rollups_for_period(db, family_id=family_id, period=period),
        rollup_kind=ModelUsageRollupKind.FAMILY_TOTAL,
    )


def aggregate_personal_historical_period(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    period: BillingPeriod,
) -> UsageAggregate:
    from app.repos.model_usage.reporting import (
        historical_rollups_for_period,
        require_user_subject,
    )

    subject = require_user_subject(db, family_id=family_id, user_id=user_id)
    return aggregate_historical_rollups(
        historical_rollups_for_period(db, family_id=family_id, period=period),
        rollup_kind=ModelUsageRollupKind.SUBJECT_TOTAL,
        subject_id=subject.id,
    )
