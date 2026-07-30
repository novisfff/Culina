from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import Select, or_, select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageIncidentRecoveryStatus,
    ModelUsageReservationStatus,
)
from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageMeasurementIncident,
    ModelUsageMeasurementIncidentAttempt,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
    ModelUsageSubject,
)
from app.services.model_usage.periods import BillingPeriod


ACTIVE_REPORTING_RESERVATION_STATUSES = (
    ModelUsageReservationStatus.RESERVED,
    ModelUsageReservationStatus.DISPATCHING,
    ModelUsageReservationStatus.UNCERTAIN,
)


def family_events_statement(*, family_id: str, period: BillingPeriod) -> Select:
    return (
        select(ModelUsageEvent)
        .with_hint(
            ModelUsageEvent,
            "FORCE INDEX (ix_model_usage_event_family_period)",
            dialect_name="mysql",
        )
        .where(
            ModelUsageEvent.family_id == family_id,
            ModelUsageEvent.period_start == period.start_at,
            ModelUsageEvent.completed_at >= period.start_at,
            ModelUsageEvent.completed_at < period.end_at,
        )
        .order_by(ModelUsageEvent.created_at, ModelUsageEvent.id)
    )


def subject_events_statement(
    *, family_id: str, subject_id: str, period: BillingPeriod
) -> Select:
    return family_events_statement(family_id=family_id, period=period).where(
        ModelUsageEvent.subject_id == subject_id
    )


def family_counters_statement(*, family_id: str, period: BillingPeriod) -> Select:
    return (
        select(ModelUsagePeriodCounter)
        .with_hint(
            ModelUsagePeriodCounter,
            "FORCE INDEX (ix_model_usage_counter_family_period)",
            dialect_name="mysql",
        )
        .where(
            ModelUsagePeriodCounter.family_id == family_id,
            ModelUsagePeriodCounter.period_start == period.start_at,
            ModelUsagePeriodCounter.period_end == period.end_at,
        )
        .order_by(ModelUsagePeriodCounter.dimension_key)
    )


def historical_rollups_statement(*, family_id: str, period: BillingPeriod) -> Select:
    return (
        select(ModelUsageMonthlyRollup)
        .with_hint(
            ModelUsageMonthlyRollup,
            "FORCE INDEX (ix_model_usage_rollup_family_period)",
            dialect_name="mysql",
        )
        .where(
            ModelUsageMonthlyRollup.family_id == family_id,
            ModelUsageMonthlyRollup.period_start == period.start_at,
            ModelUsageMonthlyRollup.period_end == period.end_at,
        )
        .order_by(ModelUsageMonthlyRollup.rollup_kind, ModelUsageMonthlyRollup.dimension_key)
    )


def family_events_for_period(
    db: Session, *, family_id: str, period: BillingPeriod
) -> tuple[ModelUsageEvent, ...]:
    return tuple(db.scalars(family_events_statement(family_id=family_id, period=period)))


def subject_events_for_period(
    db: Session,
    *,
    family_id: str,
    subject_id: str,
    period: BillingPeriod,
) -> tuple[ModelUsageEvent, ...]:
    return tuple(
        db.scalars(
            subject_events_statement(
                family_id=family_id,
                subject_id=subject_id,
                period=period,
            )
        )
    )


def event_meters_for_period_events(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    event_ids: Sequence[str],
    subject_id: str | None = None,
) -> tuple[ModelUsageEventMeter, ...]:
    if not event_ids:
        return ()
    statement = select(ModelUsageEventMeter).join(
        ModelUsageEvent, ModelUsageEvent.id == ModelUsageEventMeter.event_id
    ).where(
        ModelUsageEvent.family_id == family_id,
        ModelUsageEvent.period_start == period.start_at,
    )
    if subject_id is not None:
        statement = statement.where(ModelUsageEvent.subject_id == subject_id)
    return tuple(
        db.scalars(
            statement.order_by(
                ModelUsageEventMeter.event_id, ModelUsageEventMeter.meter_key
            )
        )
    )


def adjustment_groups_for_period(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    event_ids: Sequence[str],
    subject_id: str | None = None,
) -> tuple[ModelUsageAdjustmentGroup, ...]:
    if not event_ids:
        return ()
    statement = select(ModelUsageAdjustmentGroup).where(
        ModelUsageAdjustmentGroup.family_id == family_id,
        ModelUsageAdjustmentGroup.period_start == period.start_at,
    )
    if subject_id is not None:
        statement = statement.where(ModelUsageAdjustmentGroup.subject_id == subject_id)
    return tuple(
        db.scalars(
            statement.order_by(
                ModelUsageAdjustmentGroup.created_at, ModelUsageAdjustmentGroup.id
            )
        )
    )


def adjustment_lines_for_period_groups(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    group_ids: Sequence[str],
    subject_id: str | None = None,
) -> tuple[ModelUsageAdjustment, ...]:
    if not group_ids:
        return ()
    statement = select(ModelUsageAdjustment).join(
        ModelUsageAdjustmentGroup,
        ModelUsageAdjustmentGroup.id == ModelUsageAdjustment.adjustment_group_id,
    ).where(
        ModelUsageAdjustmentGroup.family_id == family_id,
        ModelUsageAdjustmentGroup.period_start == period.start_at,
    )
    if subject_id is not None:
        statement = statement.where(ModelUsageAdjustmentGroup.subject_id == subject_id)
    return tuple(
        db.scalars(
            statement.order_by(
                ModelUsageAdjustmentGroup.created_at,
                ModelUsageAdjustmentGroup.id,
                ModelUsageAdjustment.line_sequence,
                ModelUsageAdjustment.id,
            )
        )
    )


def active_reservations_for_period(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    subject_id: str | None = None,
) -> tuple[ModelUsageReservation, ...]:
    statement = select(ModelUsageReservation).where(
        ModelUsageReservation.family_id == family_id,
        ModelUsageReservation.period_start == period.start_at,
        ModelUsageReservation.period_end == period.end_at,
        ModelUsageReservation.status.in_(ACTIVE_REPORTING_RESERVATION_STATUSES),
    )
    if subject_id is not None:
        statement = statement.where(ModelUsageReservation.subject_id == subject_id)
    return tuple(db.scalars(statement.order_by(ModelUsageReservation.id)))


def incidents_for_period(
    db: Session,
    *,
    family_id: str,
    period: BillingPeriod,
    subject_id: str | None = None,
) -> tuple[ModelUsageMeasurementIncident, ...]:
    statement = select(ModelUsageMeasurementIncident).where(
        ModelUsageMeasurementIncident.period_start < period.end_at,
        ModelUsageMeasurementIncident.period_end > period.start_at,
        or_(
            ModelUsageMeasurementIncident.family_id == family_id,
            ModelUsageMeasurementIncident.family_id.is_(None),
        ),
    )
    if subject_id is not None:
        statement = statement.where(
            or_(
                ModelUsageMeasurementIncident.subject_id == subject_id,
                ModelUsageMeasurementIncident.subject_id.is_(None),
            )
        )
    return tuple(
        db.scalars(
            statement.order_by(
                ModelUsageMeasurementIncident.started_at,
                ModelUsageMeasurementIncident.id,
            )
        )
    )


def unresolved_incident_attempts(
    db: Session,
    *,
    family_id: str,
    incident_ids: Sequence[str],
    subject_id: str | None = None,
) -> tuple[ModelUsageMeasurementIncidentAttempt, ...]:
    if not incident_ids:
        return ()
    statement = select(ModelUsageMeasurementIncidentAttempt).where(
        ModelUsageMeasurementIncidentAttempt.family_id == family_id,
        ModelUsageMeasurementIncidentAttempt.incident_id.in_(tuple(incident_ids)),
        ModelUsageMeasurementIncidentAttempt.recovery_status
        == ModelUsageIncidentRecoveryStatus.UNRESOLVED,
    )
    if subject_id is not None:
        statement = statement.where(
            ModelUsageMeasurementIncidentAttempt.subject_id == subject_id
        )
    return tuple(db.scalars(statement.order_by(ModelUsageMeasurementIncidentAttempt.id)))


def family_counters_for_period(
    db: Session, *, family_id: str, period: BillingPeriod
) -> tuple[ModelUsagePeriodCounter, ...]:
    return tuple(db.scalars(family_counters_statement(family_id=family_id, period=period)))


def historical_rollups_for_period(
    db: Session, *, family_id: str, period: BillingPeriod
) -> tuple[ModelUsageMonthlyRollup, ...]:
    return tuple(db.scalars(historical_rollups_statement(family_id=family_id, period=period)))


def require_user_subject(
    db: Session, *, family_id: str, user_id: str
) -> ModelUsageSubject:
    subject = db.scalar(
        select(ModelUsageSubject).where(
            ModelUsageSubject.family_id == family_id,
            ModelUsageSubject.user_id == user_id,
        )
    )
    if subject is None:
        raise LookupError("model_usage_subject_not_found")
    return subject


def family_subjects_for_reporting(
    db: Session, *, family_id: str
) -> tuple[ModelUsageSubject, ...]:
    return tuple(
        db.scalars(
            select(ModelUsageSubject)
            .where(ModelUsageSubject.family_id == family_id)
            .order_by(ModelUsageSubject.subject_key, ModelUsageSubject.id)
        )
    )
