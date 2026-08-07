from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    MembershipStatus,
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMemberBudgetState,
    ModelUsageMeter,
    ModelUsagePricingStatus,
    ModelUsageReservationStatus,
    ModelUsageRollupKind,
    ModelUsageSubjectKind,
)
from app.core.utils import utcnow
from app.models.domain import Membership, User
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageFamilyPolicy,
    ModelUsageMonthlyRollup,
    ModelUsagePolicyVersion,
    ModelUsageReservation,
    ModelUsageSubject,
)
from app.repos.model_usage.reporting import (
    adjustment_groups_for_period,
    adjustment_lines_for_period_groups,
    event_meters_for_period_events,
    family_events_for_period,
    historical_rollups_for_period,
    require_user_subject,
    subject_events_for_period,
)
from app.services.model_usage.aggregation import (
    AggregateEvent,
    AggregateReservation,
    UsageAggregate,
    aggregate_family_current_period,
    aggregate_family_historical_period,
    aggregate_personal_current_period,
    aggregate_personal_historical_period,
    aggregate_usage,
)
from app.services.model_usage.counters import family_cost_dimension_key
from app.services.model_usage.effective_state import project_effective_states
from app.services.model_usage.periods import (
    BillingPeriod,
    SHANGHAI,
    require_aware_utc,
    shanghai_billing_period,
)


_MONTH_PATTERN = re.compile(r"^(?P<year>[1-9][0-9]{3})-(?P<month>0[1-9]|1[0-2])$")
ALLOWED_BREAKDOWN_GROUP_BY = frozenset(
    {
        "capability",
        "provider_model",
        "subject",
        "meter",
        "daily_capability_cost",
    }
)


@dataclass(frozen=True, slots=True)
class UsageOverview:
    family_id: str
    scope: Literal["family", "me"]
    period: BillingPeriod
    source: Literal["raw", "rollup"]
    is_partial_period: bool
    aggregate: UsageAggregate
    monthly_budget_cny: Decimal | None
    effective_spend_cny: Decimal
    reserved_cost_cny: Decimal
    hard_limit_enabled: bool
    family_budget_state: ModelUsageMemberBudgetState | None = None
    tracking_started_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class UsageBreakdownItem:
    label: str
    aggregate: UsageAggregate
    capability: ModelUsageCapability | None = None
    provider: str | None = None
    billing_model: str | None = None
    meter: ModelUsageMeter | None = None
    meter_total: Decimal | None = None
    local_day: date | None = None


@dataclass(frozen=True, slots=True)
class UsageBreakdown:
    family_id: str
    scope: Literal["family", "me"]
    period: BillingPeriod
    source: Literal["raw", "rollup"]
    is_partial_period: bool
    group_by: str
    items: tuple[UsageBreakdownItem, ...]


def parse_local_month(value: str) -> BillingPeriod:
    match = _MONTH_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("model_usage_invalid_period")
    try:
        year = int(match.group("year"))
        month = int(match.group("month"))
        local_start = datetime(year, month, 1, tzinfo=SHANGHAI)
        next_local_start = datetime(
            year + int(month == 12),
            1 if month == 12 else month + 1,
            1,
            tzinfo=SHANGHAI,
        )
    except ValueError as exc:
        raise ValueError("model_usage_invalid_period") from exc
    return BillingPeriod(
        local_month=value,
        start_at=local_start.astimezone(timezone.utc),
        end_at=next_local_start.astimezone(timezone.utc),
    )


def _requested_period(
    period: str,
    *,
    at: datetime | None,
) -> tuple[BillingPeriod, Literal["raw", "rollup"]]:
    requested = parse_local_month(period)
    current = shanghai_billing_period(require_aware_utc(at or utcnow()))
    if requested.start_at > current.start_at:
        raise ValueError("model_usage_future_period_not_allowed")
    if requested.start_at == current.start_at:
        return requested, "raw"
    return requested, "rollup"


def _family_policy_state(
    db: Session,
    *,
    family_id: str,
) -> tuple[ModelUsageFamilyPolicy, ModelUsagePolicyVersion]:
    row = db.execute(
        select(ModelUsageFamilyPolicy, ModelUsagePolicyVersion)
        .join(
            ModelUsagePolicyVersion,
            ModelUsagePolicyVersion.id
            == ModelUsageFamilyPolicy.current_policy_version_id,
        )
        .where(ModelUsageFamilyPolicy.family_id == family_id)
    ).one_or_none()
    if row is None:
        raise ValueError("model_usage_family_policy_not_found")
    return row[0], row[1]


def _tracking_started_at(db: Session, *, family_id: str) -> datetime:
    policy_pointer, _policy = _family_policy_state(db, family_id=family_id)
    started_at = policy_pointer.tracking_started_at
    if started_at.tzinfo is None or started_at.utcoffset() is None:
        return started_at.replace(tzinfo=timezone.utc)
    return started_at.astimezone(timezone.utc)


def _is_tracking_start_month(*, period: BillingPeriod, tracking_started_at: datetime) -> bool:
    return period.start_at < tracking_started_at < period.end_at


def _family_counter_values(
    *,
    aggregate: UsageAggregate,
) -> tuple[Decimal, Decimal]:
    key = family_cost_dimension_key()
    effective = aggregate.counter_values.get(key, Decimal("0"))
    reserved = aggregate.counter_reserved_values.get(key, Decimal("0"))
    return effective - reserved, reserved


def _member_budget_state(
    *,
    aggregate: UsageAggregate,
    monthly_budget_cny: Decimal | None,
    effective_spend_cny: Decimal,
    reserved_cost_cny: Decimal,
    hard_limit_enabled: bool,
) -> ModelUsageMemberBudgetState:
    if aggregate.measurement_gap or aggregate.uncertain_attempt_count:
        return ModelUsageMemberBudgetState.MEASUREMENT_UNAVAILABLE
    if monthly_budget_cny is None or monthly_budget_cny <= 0:
        return ModelUsageMemberBudgetState.SUFFICIENT
    committed_or_reserved = effective_spend_cny + reserved_cost_cny
    if hard_limit_enabled and committed_or_reserved >= monthly_budget_cny:
        return ModelUsageMemberBudgetState.CAPABILITY_DEGRADED
    if effective_spend_cny >= monthly_budget_cny:
        return ModelUsageMemberBudgetState.ALERT_THRESHOLD_REACHED
    if effective_spend_cny >= monthly_budget_cny * Decimal("0.80"):
        return ModelUsageMemberBudgetState.APPROACHING_LIMIT
    return ModelUsageMemberBudgetState.SUFFICIENT


def _family_overview_for_period(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    source: Literal["raw", "rollup"],
) -> UsageOverview:
    policy_pointer, policy = _family_policy_state(db, family_id=family_id)
    tracking_started_at = policy_pointer.tracking_started_at
    if tracking_started_at.tzinfo is None or tracking_started_at.utcoffset() is None:
        tracking_started_at = tracking_started_at.replace(tzinfo=timezone.utc)
    else:
        tracking_started_at = tracking_started_at.astimezone(timezone.utc)
    aggregate = (
        aggregate_family_current_period(db, family_id=family_id, period=period)
        if source == "raw"
        else aggregate_family_historical_period(db, family_id=family_id, period=period)
    )
    effective_spend_cny, reserved_cost_cny = (
        _family_counter_values(aggregate=aggregate)
        if source == "raw"
        else (aggregate.known_priced_cost_cny, Decimal("0"))
    )
    return UsageOverview(
        family_id=family_id,
        scope="family",
        period=period,
        source=source,
        is_partial_period=_is_tracking_start_month(
            period=period,
            tracking_started_at=tracking_started_at,
        ),
        aggregate=aggregate,
        monthly_budget_cny=policy.monthly_budget_cny,
        effective_spend_cny=effective_spend_cny,
        reserved_cost_cny=reserved_cost_cny,
        hard_limit_enabled=policy.hard_limit_enabled,
        tracking_started_at=tracking_started_at,
    )


def get_family_usage_overview(
    db: Session,
    *,
    family_id: str,
    period: str,
    at: datetime | None = None,
) -> UsageOverview:
    requested, source = _requested_period(period, at=at)
    return _family_overview_for_period(
        db,
        family_id=family_id,
        period=requested,
        source=source,
    )


def get_personal_usage_overview(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    period: str,
    at: datetime | None = None,
) -> UsageOverview:
    requested, source = _requested_period(period, at=at)
    aggregate = (
        aggregate_personal_current_period(
            db,
            family_id=family_id,
            user_id=user_id,
            period=requested,
        )
        if source == "raw"
        else aggregate_personal_historical_period(
            db,
            family_id=family_id,
            user_id=user_id,
            period=requested,
        )
    )
    family = _family_overview_for_period(
        db,
        family_id=family_id,
        period=requested,
        source=source,
    )
    return UsageOverview(
        family_id=family_id,
        scope="me",
        period=requested,
        source=source,
        is_partial_period=family.is_partial_period,
        aggregate=aggregate,
        monthly_budget_cny=None,
        effective_spend_cny=Decimal("0"),
        reserved_cost_cny=Decimal("0"),
        hard_limit_enabled=False,
        tracking_started_at=family.tracking_started_at,
        family_budget_state=_member_budget_state(
            aggregate=family.aggregate,
            monthly_budget_cny=family.monthly_budget_cny,
            effective_spend_cny=family.effective_spend_cny,
            reserved_cost_cny=family.reserved_cost_cny,
            hard_limit_enabled=family.hard_limit_enabled,
        ),
    )


def _current_period_events(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    subject_id: str | None,
) -> tuple[
    tuple[ModelUsageEvent, ...],
    tuple[AggregateEvent, ...],
    tuple[ModelUsageReservation, ...],
]:
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
    states = project_effective_states(
        events=events,
        event_meters=meters,
        adjustment_groups=groups,
        adjustment_lines=lines,
    )
    from app.repos.model_usage.reporting import active_reservations_for_period

    reservations = active_reservations_for_period(
        db,
        family_id=family_id,
        period=period,
        subject_id=subject_id,
    )
    return (
        events,
        tuple(
            AggregateEvent(
                event_id=event.id,
                subject_id=event.subject_id,
                capability=event.capability,
                provider=event.provider,
                billing_model=event.billing_model,
                completed_at=event.completed_at,
                effective=states[event.id],
            )
            for event in events
        ),
        reservations,
    )


def _database_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _event_group_key(event: AggregateEvent, group_by: str) -> tuple[object, ...]:
    if group_by == "capability":
        return (event.capability,)
    if group_by == "provider_model":
        return event.provider, event.billing_model
    if group_by == "subject":
        return (event.subject_id,)
    if group_by == "daily_capability_cost":
        return (
            _database_utc(event.completed_at).astimezone(SHANGHAI).date(),
            event.capability,
        )
    raise ValueError("model_usage_invalid_group_by")


def _reservation_group_key(
    reservation: ModelUsageReservation,
    group_by: str,
) -> tuple[object, ...] | None:
    if group_by == "capability":
        return (reservation.capability,)
    if group_by == "provider_model":
        return reservation.provider, reservation.billing_model
    if group_by == "subject":
        return (reservation.subject_id,)
    return None


def _subject_labels(
    db: Session,
    *,
    family_id: str,
    subject_ids: set[str],
) -> dict[str, str]:
    if not subject_ids:
        return {}
    subjects = tuple(
        db.scalars(
            select(ModelUsageSubject).where(
                ModelUsageSubject.family_id == family_id,
                ModelUsageSubject.id.in_(subject_ids),
            )
        )
    )
    user_ids = tuple(
        subject.user_id
        for subject in subjects
        if subject.user_id is not None
    )
    active_user_ids = set(
        db.scalars(
            select(Membership.user_id).where(
                Membership.family_id == family_id,
                Membership.user_id.in_(user_ids),
                Membership.status == MembershipStatus.ACTIVE,
            )
        )
    )
    users = {
        user.id: user.display_name
        for user in db.scalars(
            select(User).where(User.id.in_(user_ids))
        )
    }
    labels: dict[str, str] = {}
    for subject in subjects:
        if subject.subject_kind is ModelUsageSubjectKind.SYSTEM:
            labels[subject.id] = "系统"
        elif subject.anonymized_label:
            labels[subject.id] = subject.anonymized_label
        elif subject.user_id not in active_user_ids:
            labels[subject.id] = "已退出成员"
        else:
            labels[subject.id] = users.get(subject.user_id or "", "家庭成员")
    return labels


def _item_from_current_group(
    *,
    key: tuple[object, ...],
    group_by: str,
    events: tuple[AggregateEvent, ...],
    reservations: tuple[ModelUsageReservation, ...],
    subject_labels: dict[str, str],
    personal_scope: bool,
) -> UsageBreakdownItem:
    aggregate = aggregate_usage(
        events=events,
        reservations=tuple(
            AggregateReservation(reservation_id=row.id, status=row.status)
            for row in reservations
        ),
    )
    if group_by == "capability":
        capability = key[0]
        assert isinstance(capability, ModelUsageCapability)
        return UsageBreakdownItem(
            label=capability.value,
            capability=capability,
            aggregate=aggregate,
        )
    if group_by == "provider_model":
        provider, billing_model = key
        assert isinstance(provider, str) and isinstance(billing_model, str)
        return UsageBreakdownItem(
            label=f"{provider} / {billing_model}",
            provider=provider,
            billing_model=billing_model,
            aggregate=aggregate,
        )
    if group_by == "subject":
        subject_id = key[0]
        assert isinstance(subject_id, str)
        return UsageBreakdownItem(
            label="我" if personal_scope else subject_labels.get(subject_id, "家庭成员"),
            aggregate=aggregate,
        )
    if group_by == "daily_capability_cost":
        local_day, capability = key
        assert isinstance(local_day, date) and isinstance(capability, ModelUsageCapability)
        return UsageBreakdownItem(
            label=f"{local_day.isoformat()} / {capability.value}",
            local_day=local_day,
            capability=capability,
            aggregate=aggregate,
        )
    raise ValueError("model_usage_invalid_group_by")


def _current_breakdown(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    group_by: str,
    subject_id: str | None,
) -> tuple[UsageBreakdownItem, ...]:
    _, raw_events, reservations = _current_period_events(
        db,
        family_id=family_id,
        period=period,
        subject_id=subject_id,
    )
    if group_by == "meter":
        meters: dict[ModelUsageMeter, list[AggregateEvent]] = defaultdict(list)
        for event in raw_events:
            for meter in event.effective.meter_quantities:
                meters[meter].append(event)
        return tuple(
            UsageBreakdownItem(
                label=meter.value,
                meter=meter,
                meter_total=sum(
                    (
                        event.effective.meter_quantities[meter]
                        for event in events
                    ),
                    Decimal("0"),
                ),
                aggregate=aggregate_usage(
                    events=tuple(
                        replace(
                            event,
                            effective=replace(
                                event.effective,
                                cost_cny=(
                                    None
                                    if event.effective.pricing_status
                                    is ModelUsagePricingStatus.UNPRICED
                                    else event.effective.meter_cost(meter)
                                    or Decimal("0")
                                ),
                                meter_quantities={
                                    meter: event.effective.meter_quantities[meter]
                                },
                            ),
                        )
                        for event in events
                    )
                ),
            )
            for meter, events in sorted(meters.items(), key=lambda item: item[0].value)
        )
    grouped_events: dict[tuple[object, ...], list[AggregateEvent]] = defaultdict(list)
    grouped_reservations: dict[tuple[object, ...], list[ModelUsageReservation]] = defaultdict(list)
    for event in raw_events:
        grouped_events[_event_group_key(event, group_by)].append(event)
    for reservation in reservations:
        key = _reservation_group_key(reservation, group_by)
        if key is not None:
            grouped_reservations[key].append(reservation)
    labels = (
        _subject_labels(
            db,
            family_id=family_id,
            subject_ids={key[0] for key in grouped_events | grouped_reservations}
            if group_by == "subject"
            else set(),
        )
        if group_by == "subject"
        else {}
    )
    return tuple(
        _item_from_current_group(
            key=key,
            group_by=group_by,
            events=tuple(grouped_events.get(key, ())),
            reservations=tuple(grouped_reservations.get(key, ())),
            subject_labels=labels,
            personal_scope=subject_id is not None,
        )
        for key in sorted(grouped_events | grouped_reservations, key=lambda item: tuple(map(str, item)))
    )


def _aggregate_from_rollup(row: ModelUsageMonthlyRollup) -> UsageAggregate:
    has_gap = (
        row.has_unknown_measurement_gap
        or row.unresolved_known_unmeasured_count > 0
    )
    return UsageAggregate(
        known_priced_cost_cny=row.cost_total_cny or Decimal("0"),
        exact_event_count=row.exact_event_count,
        estimated_event_count=row.estimated_event_count,
        unpriced_event_count=row.unpriced_event_count,
        uncertain_attempt_count=row.uncertain_attempt_count,
        pending_attempt_count=0,
        unresolved_unknown_execution_attempt_count=(
            row.unresolved_unknown_execution_count
        ),
        conservative_estimated_cost_cny=None,
        known_unmeasured_attempt_count=row.unresolved_known_unmeasured_count,
        measurement_gap=has_gap,
        measurement_gap_scope=("unknown_scope",) if has_gap else (),
        gap_intervals=(),
        meter_totals=(
            {row.meter: row.meter_total}
            if row.meter is not None and row.meter_total is not None
            else {}
        ),
        source_event_count=row.source_event_count,
        source_reservation_count=row.uncertain_attempt_count,
        source_incident_count=row.source_incident_count,
    )


def _historical_row_matches_scope(
    row: ModelUsageMonthlyRollup,
    *,
    rollup_kind: ModelUsageRollupKind,
    subject_id: str | None,
) -> bool:
    if row.rollup_kind is not rollup_kind:
        return False
    if rollup_kind is ModelUsageRollupKind.SUBJECT_TOTAL:
        return row.subject_id is not None and (
            subject_id is None or row.subject_id == subject_id
        )
    if subject_id is None:
        return row.subject_id is None
    return row.subject_id == subject_id


def _historical_item(
    *,
    row: ModelUsageMonthlyRollup,
    group_by: str,
    subject_labels: dict[str, str],
    personal_scope: bool,
) -> UsageBreakdownItem:
    aggregate = _aggregate_from_rollup(row)
    if group_by == "capability":
        return UsageBreakdownItem(
            label=row.capability.value if row.capability is not None else "未知能力",
            capability=row.capability,
            aggregate=aggregate,
        )
    if group_by == "provider_model":
        provider = row.provider or "未知服务商"
        billing_model = row.billing_model or "未知模型"
        return UsageBreakdownItem(
            label=f"{provider} / {billing_model}",
            provider=row.provider,
            billing_model=row.billing_model,
            aggregate=aggregate,
        )
    if group_by == "subject":
        return UsageBreakdownItem(
            label="我" if personal_scope else subject_labels.get(row.subject_id or "", "家庭成员"),
            aggregate=aggregate,
        )
    if group_by == "meter":
        return UsageBreakdownItem(
            label=row.meter.value if row.meter is not None else "未知计量项",
            meter=row.meter,
            meter_total=row.meter_total,
            aggregate=aggregate,
        )
    if group_by == "daily_capability_cost":
        day = row.local_day
        capability = row.capability
        label = (
            f"{day.isoformat()} / {capability.value}"
            if day is not None and capability is not None
            else "未知日期"
        )
        return UsageBreakdownItem(
            label=label,
            local_day=day,
            capability=capability,
            aggregate=aggregate,
        )
    raise ValueError("model_usage_invalid_group_by")


def _historical_breakdown(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    group_by: str,
    subject_id: str | None,
) -> tuple[UsageBreakdownItem, ...]:
    rollup_kind = {
        "capability": ModelUsageRollupKind.CAPABILITY_TOTAL,
        "provider_model": ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
        "subject": ModelUsageRollupKind.SUBJECT_TOTAL,
        "meter": ModelUsageRollupKind.METER_TOTAL,
        "daily_capability_cost": ModelUsageRollupKind.DAILY_CAPABILITY_COST,
    }[group_by]
    rows = tuple(
        row
        for row in historical_rollups_for_period(db, family_id=family_id, period=period)
        if _historical_row_matches_scope(
            row,
            rollup_kind=rollup_kind,
            subject_id=subject_id,
        )
    )
    labels = _subject_labels(
        db,
        family_id=family_id,
        subject_ids={row.subject_id for row in rows if row.subject_id is not None},
    ) if group_by == "subject" and subject_id is None else {}
    return tuple(
        _historical_item(
            row=row,
            group_by=group_by,
            subject_labels=labels,
            personal_scope=subject_id is not None,
        )
        for row in rows
    )


def _usage_breakdown(
    db: Session,
    *,
    family_id: str,
    scope: Literal["family", "me"],
    user_id: str | None,
    period: str,
    group_by: str,
    at: datetime | None,
) -> UsageBreakdown:
    if group_by not in ALLOWED_BREAKDOWN_GROUP_BY:
        raise ValueError("model_usage_invalid_group_by")
    requested, source = _requested_period(period, at=at)
    tracking_started_at = _tracking_started_at(db, family_id=family_id)
    subject_id = (
        require_user_subject(db, family_id=family_id, user_id=user_id or "").id
        if scope == "me"
        else None
    )
    items = (
        _current_breakdown(
            db,
            family_id=family_id,
            period=requested,
            group_by=group_by,
            subject_id=subject_id,
        )
        if source == "raw"
        else _historical_breakdown(
            db,
            family_id=family_id,
            period=requested,
            group_by=group_by,
            subject_id=subject_id,
        )
    )
    return UsageBreakdown(
        family_id=family_id,
        scope=scope,
        period=requested,
        source=source,
        is_partial_period=_is_tracking_start_month(
            period=requested,
            tracking_started_at=tracking_started_at,
        ),
        group_by=group_by,
        items=items,
    )


def get_family_usage_breakdown(
    db: Session,
    *,
    family_id: str,
    period: str,
    group_by: str,
    at: datetime | None = None,
) -> UsageBreakdown:
    return _usage_breakdown(
        db,
        family_id=family_id,
        scope="family",
        user_id=None,
        period=period,
        group_by=group_by,
        at=at,
    )


def get_personal_usage_breakdown(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    period: str,
    group_by: str,
    at: datetime | None = None,
) -> UsageBreakdown:
    return _usage_breakdown(
        db,
        family_id=family_id,
        scope="me",
        user_id=user_id,
        period=period,
        group_by=group_by,
        at=at,
    )
