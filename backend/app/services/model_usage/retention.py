from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TypeAlias

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCorrectionStatus,
    ModelUsageIncidentRecoveryStatus,
    ModelUsageReservationStatus,
    ModelUsageRollupKind,
)
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageAlert,
    ModelUsageAlertReceipt,
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageFamilyPolicy,
    ModelUsageMeasurementIncident,
    ModelUsageMeasurementIncidentAttempt,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsageRealtimeWatermark,
    ModelUsageReservation,
    ModelUsageReservationMeter,
)
from app.services.model_usage.errors import ModelUsageStateError
from app.services.model_usage.policies import lock_family_policy
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.rollups import canonical_rollup_projection


# This order intentionally follows the foreign-key graph rather than a display
# order.  Keep it stable: an interrupted prune resumes at the next remaining
# batch without ever needing to reconstruct raw events.
RAW_DELETE_ORDER = (
    "model_usage_alert_receipts",
    "model_usage_alerts",
    "model_usage_measurement_incident_attempts",
    "model_usage_adjustments",
    "model_usage_adjustment_groups",
    "model_usage_event_meters",
    "model_usage_events",
    "model_usage_reservation_meters",
    "model_usage_reservations",
    "model_usage_realtime_watermarks",
    "model_usage_period_counters",
    "model_usage_measurement_incidents",
)


ACTIVE_RESERVATION_STATUSES = (
    ModelUsageReservationStatus.RESERVED,
    ModelUsageReservationStatus.DISPATCHING,
    ModelUsageReservationStatus.UNCERTAIN,
)


@dataclass(frozen=True, slots=True)
class RetentionTarget:
    family_id: str
    period: BillingPeriod


@dataclass(frozen=True, slots=True)
class RetentionVerification:
    old_enough: bool
    no_active_reservations: bool
    no_pending_recovery: bool
    rollups_complete: bool
    checksum_matches: bool

    @property
    def failures(self) -> tuple[str, ...]:
        checks = (
            ("old_enough", self.old_enough),
            ("active_reservations", self.no_active_reservations),
            ("pending_recovery", self.no_pending_recovery),
            ("rollups_incomplete", self.rollups_complete),
            ("rollup_checksum_mismatch", self.checksum_matches),
        )
        return tuple(name for name, passed in checks if not passed)

    @property
    def eligible(self) -> bool:
        return not self.failures


@dataclass(frozen=True, slots=True)
class RetentionPruneResult:
    target: RetentionTarget
    verification: RetentionVerification
    deleted: dict[str, int]
    status: ModelUsageCorrectionStatus
    dry_run: bool


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _month_start_at_local_months_before(now: datetime, months: int) -> datetime:
    local = _utc(now).astimezone(SHANGHAI)
    total = local.year * 12 + local.month - 1 - months
    year, zero_month = divmod(total, 12)
    return datetime(year, zero_month + 1, 1, tzinfo=SHANGHAI).astimezone(timezone.utc)


def is_complete_period_older_than(
    period: BillingPeriod,
    *,
    months: int,
    now: datetime | None = None,
) -> bool:
    if months < 1:
        raise ValueError("retention months must be positive")
    cutoff = _month_start_at_local_months_before(now or utcnow(), months)
    return _utc(period.end_at) <= cutoff


def _period_filters(model: object, target: RetentionTarget) -> tuple[object, ...]:
    return (
        getattr(model, "family_id") == target.family_id,
        getattr(model, "period_start") == target.period.start_at,
        getattr(model, "period_end") == target.period.end_at,
    )


def _family_rollups(
    db: Session,
    target: RetentionTarget,
    *,
    for_update: bool = False,
) -> tuple[ModelUsageMonthlyRollup, ...]:
    statement = (
        select(ModelUsageMonthlyRollup)
        .where(
            ModelUsageMonthlyRollup.family_id == target.family_id,
            ModelUsageMonthlyRollup.period_start == target.period.start_at,
            ModelUsageMonthlyRollup.period_end == target.period.end_at,
        )
        .order_by(ModelUsageMonthlyRollup.dimension_key)
    )
    if for_update:
        statement = statement.execution_options(populate_existing=True).with_for_update()
    return tuple(db.scalars(statement))


def _has_active_reservations(db: Session, target: RetentionTarget) -> bool:
    return bool(
        db.scalar(
            select(ModelUsageReservation.id)
            .where(
                *_period_filters(ModelUsageReservation, target),
                ModelUsageReservation.status.in_(ACTIVE_RESERVATION_STATUSES),
            )
            .limit(1)
        )
    )


def _has_pending_recovery(db: Session, target: RetentionTarget) -> bool:
    unresolved_attempt = db.scalar(
        select(ModelUsageMeasurementIncidentAttempt.id)
        .join(
            ModelUsageMeasurementIncident,
            ModelUsageMeasurementIncident.id
            == ModelUsageMeasurementIncidentAttempt.incident_id,
        )
        .where(
            ModelUsageMeasurementIncidentAttempt.family_id == target.family_id,
            ModelUsageMeasurementIncident.period_start < target.period.end_at,
            ModelUsageMeasurementIncident.period_end > target.period.start_at,
            ModelUsageMeasurementIncidentAttempt.recovery_status
            == ModelUsageIncidentRecoveryStatus.UNRESOLVED,
        )
        .limit(1)
    )
    if unresolved_attempt is not None:
        return True
    # Family-less incidents are retained globally.  They are intentionally not
    # treated as a per-family deletion candidate or a blocker for every family.
    return bool(
        db.scalar(
            select(ModelUsageMeasurementIncident.id)
            .where(
                ModelUsageMeasurementIncident.family_id == target.family_id,
                ModelUsageMeasurementIncident.period_start < target.period.end_at,
                ModelUsageMeasurementIncident.period_end > target.period.start_at,
                ModelUsageMeasurementIncident.recovered_at.is_(None),
            )
            .limit(1)
        )
    )


def _rollups_complete_and_matching(
    db: Session,
    target: RetentionTarget,
) -> tuple[bool, bool]:
    rows = _family_rollups(db, target)
    family_total = next(
        (row for row in rows if row.rollup_kind is ModelUsageRollupKind.FAMILY_TOTAL),
        None,
    )
    complete = bool(rows and family_total is not None)
    if not complete:
        return False, False
    if any(
        row.correction_status is not ModelUsageCorrectionStatus.OPEN
        or not row.checksum
        or not row.source_watermark
        for row in rows
    ):
        return False, False

    persisted = {
        row.dimension_key: (row.source_watermark, row.checksum)
        for row in rows
    }
    projected = canonical_rollup_projection(
        db,
        family_id=target.family_id,
        period=target.period,
    )
    return True, persisted == projected


def retention_preflight(db: Session, target: RetentionTarget) -> RetentionVerification:
    """Return a read-only, fail-closed eligibility result for one family/month."""

    complete, checksum_matches = _rollups_complete_and_matching(db, target)
    return RetentionVerification(
        old_enough=is_complete_period_older_than(target.period, months=13),
        no_active_reservations=not _has_active_reservations(db, target),
        no_pending_recovery=not _has_pending_recovery(db, target),
        rollups_complete=complete,
        checksum_matches=checksum_matches,
    )


def _ids_for_table(
    db: Session,
    table_name: str,
    target: RetentionTarget,
    *,
    batch_size: int,
) -> tuple[str, ...]:
    if table_name == "model_usage_alert_receipts":
        statement = (
            select(ModelUsageAlertReceipt.id)
            .join(ModelUsageAlert, ModelUsageAlert.id == ModelUsageAlertReceipt.alert_id)
            .where(*_period_filters(ModelUsageAlert, target))
        )
    elif table_name == "model_usage_alerts":
        statement = select(ModelUsageAlert.id).where(*_period_filters(ModelUsageAlert, target))
    elif table_name == "model_usage_measurement_incident_attempts":
        statement = (
            select(ModelUsageMeasurementIncidentAttempt.id)
            .join(
                ModelUsageMeasurementIncident,
                ModelUsageMeasurementIncident.id
                == ModelUsageMeasurementIncidentAttempt.incident_id,
            )
            .where(
                ModelUsageMeasurementIncidentAttempt.family_id == target.family_id,
                ModelUsageMeasurementIncident.family_id == target.family_id,
                ModelUsageMeasurementIncident.period_start < target.period.end_at,
                ModelUsageMeasurementIncident.period_end > target.period.start_at,
            )
        )
    elif table_name == "model_usage_adjustments":
        statement = (
            select(ModelUsageAdjustment.id)
            .join(
                ModelUsageAdjustmentGroup,
                ModelUsageAdjustmentGroup.id == ModelUsageAdjustment.adjustment_group_id,
            )
            .where(*_period_filters(ModelUsageAdjustmentGroup, target))
        )
    elif table_name == "model_usage_adjustment_groups":
        statement = select(ModelUsageAdjustmentGroup.id).where(
            *_period_filters(ModelUsageAdjustmentGroup, target)
        )
    elif table_name == "model_usage_event_meters":
        statement = (
            select(ModelUsageEventMeter.id)
            .join(ModelUsageEvent, ModelUsageEvent.id == ModelUsageEventMeter.event_id)
            .where(*_period_filters(ModelUsageEvent, target))
        )
    elif table_name == "model_usage_events":
        statement = select(ModelUsageEvent.id).where(*_period_filters(ModelUsageEvent, target))
    elif table_name == "model_usage_reservation_meters":
        statement = (
            select(ModelUsageReservationMeter.id)
            .join(
                ModelUsageReservation,
                ModelUsageReservation.id == ModelUsageReservationMeter.reservation_id,
            )
            .where(*_period_filters(ModelUsageReservation, target))
        )
    elif table_name == "model_usage_reservations":
        statement = select(ModelUsageReservation.id).where(
            *_period_filters(ModelUsageReservation, target)
        )
    elif table_name == "model_usage_realtime_watermarks":
        statement = select(ModelUsageRealtimeWatermark.id).where(
            *_period_filters(ModelUsageRealtimeWatermark, target)
        )
    elif table_name == "model_usage_period_counters":
        statement = select(ModelUsagePeriodCounter.id).where(
            *_period_filters(ModelUsagePeriodCounter, target)
        )
    elif table_name == "model_usage_measurement_incidents":
        # Never delete family-less/global incidents in a family retention pass.
        statement = select(ModelUsageMeasurementIncident.id).where(
            ModelUsageMeasurementIncident.family_id == target.family_id,
            ModelUsageMeasurementIncident.period_start >= target.period.start_at,
            ModelUsageMeasurementIncident.period_end <= target.period.end_at,
        )
    else:  # pragma: no cover - protected by RAW_DELETE_ORDER
        raise ValueError(f"unsupported raw deletion table: {table_name}")
    return tuple(
        db.scalars(
            statement.order_by("id").limit(batch_size).with_for_update()
        )
    )


_DeletionModel: TypeAlias = (
    type[ModelUsageAlertReceipt]
    | type[ModelUsageAlert]
    | type[ModelUsageMeasurementIncidentAttempt]
    | type[ModelUsageAdjustment]
    | type[ModelUsageAdjustmentGroup]
    | type[ModelUsageEventMeter]
    | type[ModelUsageEvent]
    | type[ModelUsageReservationMeter]
    | type[ModelUsageReservation]
    | type[ModelUsageRealtimeWatermark]
    | type[ModelUsagePeriodCounter]
    | type[ModelUsageMeasurementIncident]
)


_DELETION_MODELS: dict[str, _DeletionModel] = {
    "model_usage_alert_receipts": ModelUsageAlertReceipt,
    "model_usage_alerts": ModelUsageAlert,
    "model_usage_measurement_incident_attempts": ModelUsageMeasurementIncidentAttempt,
    "model_usage_adjustments": ModelUsageAdjustment,
    "model_usage_adjustment_groups": ModelUsageAdjustmentGroup,
    "model_usage_event_meters": ModelUsageEventMeter,
    "model_usage_events": ModelUsageEvent,
    "model_usage_reservation_meters": ModelUsageReservationMeter,
    "model_usage_reservations": ModelUsageReservation,
    "model_usage_realtime_watermarks": ModelUsageRealtimeWatermark,
    "model_usage_period_counters": ModelUsagePeriodCounter,
    "model_usage_measurement_incidents": ModelUsageMeasurementIncident,
}


def _dry_run_result(
    db: Session,
    target: RetentionTarget,
    verification: RetentionVerification,
) -> RetentionPruneResult:
    existing_rows = _family_rollups(db, target)
    return RetentionPruneResult(
        target=target,
        verification=verification,
        deleted={},
        status=next(
            iter({row.correction_status for row in existing_rows}),
            ModelUsageCorrectionStatus.OPEN,
        ),
        dry_run=True,
    )


def _checkpointed_pruning_verification() -> RetentionVerification:
    """Represent the preflight that was durably accepted before pruning began."""

    return RetentionVerification(
        old_enough=True,
        no_active_reservations=True,
        no_pending_recovery=True,
        rollups_complete=True,
        checksum_matches=True,
    )


def _lock_retention_policy(
    db: Session,
    *,
    family_id: str,
    skip_locked: bool,
) -> bool:
    if not skip_locked:
        lock_family_policy(db, family_id=family_id)
        return True
    pointer = db.scalar(
        select(ModelUsageFamilyPolicy)
        .where(ModelUsageFamilyPolicy.family_id == family_id)
        .with_for_update(skip_locked=True)
    )
    return pointer is not None


def _locked_retention_rollups(
    db: Session,
    target: RetentionTarget,
) -> tuple[ModelUsageMonthlyRollup, ...]:
    rows = _family_rollups(db, target, for_update=True)
    if not rows:
        raise ModelUsageStateError("model_usage_rollup_missing")
    return rows


def _start_or_resume_pruning_in_session(
    db: Session,
    target: RetentionTarget,
    *,
    skip_locked: bool,
) -> tuple[RetentionVerification, ModelUsageCorrectionStatus] | None:
    if not _lock_retention_policy(db, family_id=target.family_id, skip_locked=skip_locked):
        return None
    rows = _locked_retention_rollups(db, target)
    statuses = {row.correction_status for row in rows}
    if ModelUsageCorrectionStatus.CLOSED in statuses:
        if statuses != {ModelUsageCorrectionStatus.CLOSED}:
            raise ModelUsageStateError("model_usage_retention_state_invalid")
        return _checkpointed_pruning_verification(), ModelUsageCorrectionStatus.CLOSED
    if statuses == {ModelUsageCorrectionStatus.PRUNING}:
        return _checkpointed_pruning_verification(), ModelUsageCorrectionStatus.PRUNING
    if statuses != {ModelUsageCorrectionStatus.OPEN}:
        raise ModelUsageStateError("model_usage_retention_state_invalid")

    verification = retention_preflight(db, target)
    if not verification.eligible:
        raise ModelUsageStateError(
            "model_usage_retention_preflight_failed:" + ",".join(verification.failures)
        )
    checkpointed_at = utcnow()
    for row in rows:
        row.correction_status = ModelUsageCorrectionStatus.PRUNING
        row.adjustment_closed_at = row.adjustment_closed_at or checkpointed_at
    db.flush()
    return verification, ModelUsageCorrectionStatus.PRUNING


def _delete_next_pruning_batch_in_session(
    db: Session,
    target: RetentionTarget,
    *,
    batch_size: int,
    skip_locked: bool,
) -> tuple[bool, str | None, int]:
    if not _lock_retention_policy(db, family_id=target.family_id, skip_locked=skip_locked):
        return False, None, 0
    rows = _locked_retention_rollups(db, target)
    statuses = {row.correction_status for row in rows}
    if statuses == {ModelUsageCorrectionStatus.CLOSED}:
        return True, None, 0
    if statuses != {ModelUsageCorrectionStatus.PRUNING}:
        raise ModelUsageStateError("model_usage_retention_state_invalid")
    for table_name in RAW_DELETE_ORDER:
        ids = _ids_for_table(db, table_name, target, batch_size=batch_size)
        if not ids:
            continue
        model = _DELETION_MODELS[table_name]
        result = db.execute(delete(model).where(model.id.in_(ids)))
        deleted = result.rowcount or len(ids)
        db.flush()
        return True, table_name, deleted
    return True, None, 0


def _close_pruning_period_in_session(
    db: Session,
    target: RetentionTarget,
    *,
    skip_locked: bool,
) -> tuple[bool, ModelUsageCorrectionStatus]:
    if not _lock_retention_policy(db, family_id=target.family_id, skip_locked=skip_locked):
        return False, ModelUsageCorrectionStatus.PRUNING
    rows = _locked_retention_rollups(db, target)
    statuses = {row.correction_status for row in rows}
    if statuses == {ModelUsageCorrectionStatus.CLOSED}:
        return True, ModelUsageCorrectionStatus.CLOSED
    if statuses != {ModelUsageCorrectionStatus.PRUNING}:
        raise ModelUsageStateError("model_usage_retention_state_invalid")
    if any(_ids_for_table(db, table_name, target, batch_size=1) for table_name in RAW_DELETE_ORDER):
        return True, ModelUsageCorrectionStatus.PRUNING
    pruned_at = utcnow()
    for row in rows:
        row.correction_status = ModelUsageCorrectionStatus.CLOSED
        row.raw_data_pruned_at = pruned_at
    db.flush()
    return True, ModelUsageCorrectionStatus.CLOSED


def prune_period(
    target: RetentionTarget,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    batch_size: int = 500,
    dry_run: bool = False,
    verify_only: bool = False,
    on_batch: Callable[[str], None] | None = None,
    skip_locked: bool = False,
) -> RetentionPruneResult | None:
    """Prune one period through durable checkpoint and short delete transactions."""

    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    if dry_run or verify_only:
        with session_factory() as db:
            return _dry_run_result(db, target, retention_preflight(db, target))

    with session_factory() as db:
        with db.begin():
            checkpoint = _start_or_resume_pruning_in_session(
                db,
                target,
                skip_locked=skip_locked,
            )
    if checkpoint is None:
        return None
    verification, initial_status = checkpoint
    if initial_status is ModelUsageCorrectionStatus.CLOSED:
        return RetentionPruneResult(
            target=target,
            verification=verification,
            deleted={},
            status=ModelUsageCorrectionStatus.CLOSED,
            dry_run=False,
        )

    deleted = {table_name: 0 for table_name in RAW_DELETE_ORDER}
    while True:
        with session_factory() as db:
            with db.begin():
                acquired, table_name, deleted_count = _delete_next_pruning_batch_in_session(
                    db,
                    target,
                    batch_size=batch_size,
                    skip_locked=skip_locked,
                )
        if not acquired:
            return None
        if table_name is None:
            break
        deleted[table_name] += deleted_count
        # This intentionally runs after the batch commits so a process crash
        # cannot roll the durable PRUNING checkpoint back to OPEN.
        if on_batch is not None:
            on_batch(table_name)

    with session_factory() as db:
        with db.begin():
            acquired, status = _close_pruning_period_in_session(
                db,
                target,
                skip_locked=skip_locked,
            )
    if not acquired:
        return None
    if status is not ModelUsageCorrectionStatus.CLOSED:
        # Another short-lived worker may have observed remaining rows before
        # this finalization transaction.  Leave the durable checkpoint intact.
        return RetentionPruneResult(
            target=target,
            verification=verification,
            deleted=deleted,
            status=ModelUsageCorrectionStatus.PRUNING,
            dry_run=False,
        )
    return RetentionPruneResult(
        target=target,
        verification=verification,
        deleted=deleted,
        status=ModelUsageCorrectionStatus.CLOSED,
        dry_run=False,
    )


def prune_eligible_periods_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    batch_size: int = 500,
    limit: int = 20,
) -> tuple[RetentionPruneResult, ...]:
    """Run a bounded set of family periods; each period gets its own transaction."""

    with session_factory() as db:
        candidate_rows = tuple(
            db.scalars(
                select(ModelUsageMonthlyRollup)
                .where(
                    ModelUsageMonthlyRollup.rollup_kind
                    == ModelUsageRollupKind.FAMILY_TOTAL,
                    ModelUsageMonthlyRollup.correction_status.in_(
                        (
                            ModelUsageCorrectionStatus.OPEN,
                            ModelUsageCorrectionStatus.PRUNING,
                        )
                    ),
                )
                .order_by(ModelUsageMonthlyRollup.period_start, ModelUsageMonthlyRollup.family_id)
                .limit(limit)
            )
        )
        candidates = tuple(
            (
                row.correction_status,
                RetentionTarget(
                    family_id=row.family_id,
                    period=BillingPeriod(
                        local_month=_utc(row.period_start).astimezone(SHANGHAI).strftime("%Y-%m"),
                        start_at=_utc(row.period_start),
                        end_at=_utc(row.period_end),
                    ),
                ),
            )
            for row in candidate_rows
        )
    results: list[RetentionPruneResult] = []
    for status, target in candidates:
        if status is not ModelUsageCorrectionStatus.PRUNING:
            with session_factory() as db:
                verification = retention_preflight(db, target)
            if not verification.old_enough or not verification.eligible:
                continue
        result = prune_period(
            target,
            session_factory=session_factory,
            batch_size=batch_size,
            skip_locked=True,
        )
        if result is not None:
            results.append(result)
    return tuple(results)
