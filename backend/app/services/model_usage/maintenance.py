from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from threading import Event, Thread
from time import monotonic as system_monotonic
from zoneinfo import ZoneInfo

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import (
    ModelUsageCorrectionStatus,
    ModelUsageCounterKind,
    ModelUsageReservationStatus,
    ModelUsageRollupKind,
)
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.models.model_usage import (
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
    ModelUsageReservationMeter,
)
from app.services.model_usage.alerts import repair_new_budget_revision
from app.services.model_usage.counter_audit import audit_counters_batch
from app.services.model_usage.counters import family_cost_dimension_key
from app.services.model_usage.dispatch import _lock_counters, _remove_reserved
from app.services.model_usage.incidents import flush_outage_latch
from app.services.model_usage.outage_latch import ModelUsageOutageLatch
from app.services.model_usage.policies import lock_current_policy, lock_family_policy
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.models.family_model_settings import FamilyModelSettings
from app.services.model_usage.configured_variants import configured_usage_variants
from app.services.model_usage.pricing import PriceCoverageReport, family_price_coverage
from app.services.model_usage.recovery import reconcile_uncertain_in_session
from app.services.model_usage.retention import prune_eligible_periods_batch
from app.services.model_usage.rollups import rebuild_monthly_rollups
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.state_machine import transition_reservation


logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class IntervalMaintenanceTask:
    name: str
    runner: Callable[[], object]
    interval: timedelta
    run_on_startup: bool = False


@dataclass(frozen=True, slots=True)
class DailyMaintenanceTask:
    name: str
    runner: Callable[[], object]
    local_time: time
    timezone: ZoneInfo


@dataclass(frozen=True, slots=True)
class FamilyPriceCoverageBatch:
    """Aggregate per-family immutable price coverage without a global fallback."""

    reports: tuple[PriceCoverageReport, ...]

    @property
    def healthy(self) -> bool:
        return all(report.healthy for report in self.reports)

    @property
    def price_version_id(self) -> None:
        return None

    @property
    def rows(self) -> tuple[object, ...]:
        return tuple(row for report in self.reports for row in report.rows)


def _process_outage_latch() -> ModelUsageOutageLatch:
    # Import lazily to avoid a facade -> maintenance import cycle.  The facade
    # publishes its default latch so failed-open incidents are not silently lost.
    from app.services.model_usage.facade import process_model_usage_outage_latch

    return process_model_usage_outage_latch


def flush_incidents_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    outage_latch: ModelUsageOutageLatch | None = None,
) -> int:
    latch = outage_latch or _process_outage_latch()
    with session_factory() as db:
        with db.begin():
            return len(flush_outage_latch(db, latch))


def _release_expired_reservation_in_session(
    db: Session,
    *,
    reservation_id: str,
    at: datetime,
) -> bool:
    identity = db.get(ModelUsageReservation, reservation_id)
    if identity is None:
        return False
    lock_family_policy(db, family_id=identity.family_id)
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(
            ModelUsageReservation.id == reservation_id,
            ModelUsageReservation.family_id == identity.family_id,
        )
        .execution_options(populate_existing=True)
        .with_for_update(skip_locked=True)
    )
    if (
        reservation is None
        or reservation.status is not ModelUsageReservationStatus.RESERVED
        or reservation.expires_at is None
        or reservation.expires_at > at
    ):
        return False
    meters = tuple(
        db.scalars(
            select(ModelUsageReservationMeter)
            .where(ModelUsageReservationMeter.reservation_id == reservation.id)
            .order_by(ModelUsageReservationMeter.meter_key)
        )
    )
    counters = _lock_counters(db, reservation, meters)
    _remove_reserved(reservation, meters, counters)
    reservation.status = transition_reservation(
        reservation.status,
        ModelUsageReservationStatus.RELEASED,
    )
    reservation.error_code = "reservation_expired"
    db.flush()
    return True


def reconcile_reservations_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    limit: int = 100,
    at: datetime | None = None,
) -> int:
    """Release only expired pre-send reservations; no provider call is possible."""

    now = at or utcnow()
    with session_factory() as db:
        ids = tuple(
            db.scalars(
                select(ModelUsageReservation.id)
                .where(
                    ModelUsageReservation.status == ModelUsageReservationStatus.RESERVED,
                    ModelUsageReservation.expires_at.is_not(None),
                    ModelUsageReservation.expires_at <= now,
                )
                .order_by(ModelUsageReservation.expires_at, ModelUsageReservation.id)
                .limit(limit)
            )
        )
    released = 0
    for reservation_id in ids:
        with session_factory() as db:
            with db.begin():
                released += int(
                    _release_expired_reservation_in_session(
                        db,
                        reservation_id=reservation_id,
                        at=now,
                    )
                )
    return released


def query_uncertain_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    limit: int = 100,
    at: datetime | None = None,
) -> int:
    """Reconcile existing durable attempts only; this function never resends."""

    now = at or utcnow()
    settings = get_settings()
    try:
        signer = decode_receipt_integrity_keyring(settings, now=now).signer()
    except Exception:
        logger.warning("model usage uncertain reconciliation skipped: receipt keyring unhealthy")
        return 0
    with session_factory() as db:
        ids = tuple(
            db.scalars(
                select(ModelUsageReservation.id)
                .where(ModelUsageReservation.status == ModelUsageReservationStatus.UNCERTAIN)
                .order_by(ModelUsageReservation.dispatching_at, ModelUsageReservation.id)
                .limit(limit)
            )
        )
    reconciled = 0
    for reservation_id in ids:
        with session_factory() as db:
            with db.begin():
                outcome = reconcile_uncertain_in_session(
                    db,
                    reservation_id=reservation_id,
                    at=now,
                    signer=signer,
                    handler=None,
                )
                reconciled += int(outcome is not None)
    return reconciled


def _repair_alert_for_counter_in_session(
    db: Session,
    *,
    counter_id: str,
) -> int:
    identity = db.get(ModelUsagePeriodCounter, counter_id)
    if identity is None:
        return 0
    try:
        _, policy = lock_current_policy(db, family_id=identity.family_id)
    except ValueError:
        return 0
    counter = db.scalar(
        select(ModelUsagePeriodCounter)
        .where(
            ModelUsagePeriodCounter.id == counter_id,
            ModelUsagePeriodCounter.family_id == identity.family_id,
            ModelUsagePeriodCounter.counter_kind == ModelUsageCounterKind.FAMILY_COST,
            ModelUsagePeriodCounter.dimension_key == family_cost_dimension_key(),
        )
        .execution_options(populate_existing=True)
        .with_for_update(skip_locked=True)
    )
    if counter is None:
        return 0
    # Treat an alert repair attempt as maintenance verification so the bounded
    # scanner rotates across family/month counters instead of selecting the
    # same first page forever.
    counter.last_verified_at = utcnow()
    rollup = db.scalar(
        select(ModelUsageMonthlyRollup)
        .where(
            ModelUsageMonthlyRollup.family_id == counter.family_id,
            ModelUsageMonthlyRollup.period_start == counter.period_start,
            ModelUsageMonthlyRollup.rollup_kind == ModelUsageRollupKind.FAMILY_TOTAL,
        )
        .with_for_update()
    )
    if (
        rollup is None
        or rollup.correction_status is not ModelUsageCorrectionStatus.OPEN
        or rollup.raw_data_pruned_at is not None
    ):
        return 0
    return len(repair_new_budget_revision(db, policy=policy, counter=counter))


def repair_alerts_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    limit: int = 100,
) -> int:
    with session_factory() as db:
        ids = tuple(
            db.scalars(
                select(ModelUsagePeriodCounter.id)
                .where(
                    ModelUsagePeriodCounter.counter_kind == ModelUsageCounterKind.FAMILY_COST,
                    ModelUsagePeriodCounter.dimension_key == family_cost_dimension_key(),
                )
                .order_by(
                    ModelUsagePeriodCounter.last_verified_at.is_not(None),
                    ModelUsagePeriodCounter.last_verified_at,
                    ModelUsagePeriodCounter.period_start,
                    ModelUsagePeriodCounter.family_id,
                )
                .limit(limit)
            )
        )
    repaired = 0
    for counter_id in ids:
        with session_factory() as db:
            with db.begin():
                repaired += _repair_alert_for_counter_in_session(db, counter_id=counter_id)
    return repaired


def refresh_rollups_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    limit: int = 100,
) -> int:
    with session_factory() as db:
        period_candidates = (
            select(
                ModelUsagePeriodCounter.family_id.label("family_id"),
                ModelUsagePeriodCounter.period_start.label("period_start"),
                ModelUsagePeriodCounter.period_end.label("period_end"),
                func.min(ModelUsageMonthlyRollup.computed_at).label("computed_at"),
            )
            .outerjoin(
                ModelUsageMonthlyRollup,
                and_(
                    ModelUsageMonthlyRollup.family_id
                    == ModelUsagePeriodCounter.family_id,
                    ModelUsageMonthlyRollup.period_start
                    == ModelUsagePeriodCounter.period_start,
                    ModelUsageMonthlyRollup.period_end
                    == ModelUsagePeriodCounter.period_end,
                    ModelUsageMonthlyRollup.rollup_kind
                    == ModelUsageRollupKind.FAMILY_TOTAL,
                ),
            )
            .where(
                or_(
                    ModelUsageMonthlyRollup.id.is_(None),
                    ModelUsageMonthlyRollup.correction_status
                    == ModelUsageCorrectionStatus.OPEN,
                )
            )
            .group_by(
                ModelUsagePeriodCounter.family_id,
                ModelUsagePeriodCounter.period_start,
                ModelUsagePeriodCounter.period_end,
            )
            .subquery()
        )
        candidates = tuple(
            db.execute(
                select(
                    period_candidates.c.family_id,
                    period_candidates.c.period_start,
                    period_candidates.c.period_end,
                )
                .order_by(
                    period_candidates.c.computed_at.is_not(None),
                    period_candidates.c.computed_at,
                    period_candidates.c.period_start,
                    period_candidates.c.family_id,
                )
                .limit(limit)
            )
        )
    refreshed = 0
    for family_id, period_start, period_end in candidates:
        with session_factory() as db:
            with db.begin():
                rebuild_monthly_rollups(
                    db,
                    family_id=family_id,
                    period=BillingPeriod(
                        local_month=(
                            period_start.replace(tzinfo=timezone.utc)
                            if period_start.tzinfo is None
                            else period_start
                        ).astimezone(SHANGHAI).strftime("%Y-%m"),
                        start_at=(
                            period_start.replace(tzinfo=timezone.utc)
                            if period_start.tzinfo is None
                            else period_start.astimezone(timezone.utc)
                        ),
                        end_at=(
                            period_end.replace(tzinfo=timezone.utc)
                            if period_end.tzinfo is None
                            else period_end.astimezone(timezone.utc)
                        ),
                    ),
                )
                refreshed += 1
    return refreshed


def audit_counters_maintenance_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    limit: int = 100,
) -> object:
    with session_factory() as db:
        with db.begin():
            return audit_counters_batch(db, repair=True, limit=limit, fail_closed=True)


def check_price_coverage_batch(
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    at: datetime | None = None,
) -> FamilyPriceCoverageBatch:
    with session_factory() as db:
        pointers = tuple(
            db.scalars(
                select(FamilyModelSettings).where(
                    FamilyModelSettings.active_config_revision_id.is_not(None)
                )
            )
        )
        reports = tuple(
            family_price_coverage(
                db,
                family_id=pointer.family_id,
                config_revision_id=pointer.active_config_revision_id or "",
                price_version_id=pointer.active_price_version_id,
                configured_variants=configured_usage_variants(
                    db,
                    family_id=pointer.family_id,
                    config_revision_id=pointer.active_config_revision_id or "",
                ),
            )
            for pointer in pointers
        )
        return FamilyPriceCoverageBatch(reports=reports)


DEFAULT_INTERVAL_TASKS = (
    IntervalMaintenanceTask("incident_flush", flush_incidents_batch, timedelta(seconds=15)),
    IntervalMaintenanceTask(
        "reservation_reconcile", reconcile_reservations_batch, timedelta(seconds=30)
    ),
    IntervalMaintenanceTask("uncertain_reconcile", query_uncertain_batch, timedelta(minutes=5)),
    IntervalMaintenanceTask("alert_repair", repair_alerts_batch, timedelta(minutes=5)),
    IntervalMaintenanceTask("rollup_refresh", refresh_rollups_batch, timedelta(minutes=15)),
    IntervalMaintenanceTask("counter_audit", audit_counters_maintenance_batch, timedelta(hours=1)),
    IntervalMaintenanceTask(
        "price_coverage",
        check_price_coverage_batch,
        timedelta(days=1),
        run_on_startup=True,
    ),
)

DEFAULT_DAILY_TASKS = (
    DailyMaintenanceTask(
        "retention_prune",
        prune_eligible_periods_batch,
        time(hour=3, minute=30),
        ZoneInfo("Asia/Shanghai"),
    ),
)


class ModelUsageMaintenanceWorker:
    """Small, crash-isolated scheduler for short model-usage maintenance batches."""

    def __init__(
        self,
        *,
        interval_tasks: tuple[IntervalMaintenanceTask, ...] = DEFAULT_INTERVAL_TASKS,
        daily_tasks: tuple[DailyMaintenanceTask, ...] = DEFAULT_DAILY_TASKS,
        monotonic: Callable[[], float] = system_monotonic,
        now: Callable[[], datetime] = utcnow,
        poll_interval_seconds: float = 1.0,
    ) -> None:
        self._interval_tasks = interval_tasks
        self._daily_tasks = daily_tasks
        self._monotonic = monotonic
        self._now = now
        self._poll_interval_seconds = poll_interval_seconds
        current = monotonic()
        self._next_interval_at = {
            task.name: current + task.interval.total_seconds() for task in interval_tasks
        }
        self._startup_completed: set[str] = set()
        self._daily_completed: dict[str, date] = {}
        self._stop_event = Event()
        self._thread: Thread | None = None

    @property
    def is_stopped(self) -> bool:
        return self._stop_event.is_set()

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive() and not self.is_stopped

    def _run_task(self, name: str, runner: Callable[[], object]) -> None:
        try:
            runner()
        except Exception:
            # A failed batch is retried at its next bounded interval.  Do not
            # let one family or provider issue stop unrelated maintenance.
            logger.exception("model usage maintenance task failed task=%s", name)

    def run_due_once(self) -> None:
        current = self._monotonic()
        for task in self._interval_tasks:
            startup_due = task.run_on_startup and task.name not in self._startup_completed
            interval_due = current >= self._next_interval_at[task.name]
            if not startup_due and not interval_due:
                continue
            self._run_task(task.name, task.runner)
            self._startup_completed.add(task.name)
            self._next_interval_at[task.name] = current + task.interval.total_seconds()

        current_wall = self._now()
        for task in self._daily_tasks:
            local = current_wall.astimezone(task.timezone)
            if local.timetz().replace(tzinfo=None) < task.local_time:
                continue
            if self._daily_completed.get(task.name) == local.date():
                continue
            self._run_task(task.name, task.runner)
            self._daily_completed[task.name] = local.date()

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            self.run_due_once()
            self._stop_event.wait(self._poll_interval_seconds)

    def start(self) -> None:
        if self.is_running:
            return
        self._stop_event.clear()
        self._thread = Thread(
            target=self._run_loop,
            name="model-usage-maintenance",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self._poll_interval_seconds * 3))
