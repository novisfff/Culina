from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import ModelUsageCounterKind, ModelUsageRollupKind
from app.models.model_usage import ModelUsageMonthlyRollup, ModelUsagePeriodCounter
from app.services.model_usage.counter_audit import audit_counters_batch
from app.services.model_usage.counters import family_cost_dimension_key
from app.services.model_usage.maintenance import (
    DEFAULT_DAILY_TASKS,
    DEFAULT_INTERVAL_TASKS,
    IntervalMaintenanceTask,
    ModelUsageMaintenanceWorker,
    refresh_rollups_batch,
    repair_alerts_batch,
)
from tests.model_usage.test_adjustments import settled_source_event


pytest_plugins = ("tests.model_usage.test_reservations",)


class FakeClock:
    def __init__(self) -> None:
        self.monotonic_value = 0.0
        self.wall_value = datetime(2026, 7, 30, tzinfo=timezone.utc)

    def monotonic(self) -> float:
        return self.monotonic_value

    def now(self) -> datetime:
        return self.wall_value

    def advance(self, delta: timedelta) -> None:
        self.monotonic_value += delta.total_seconds()
        self.wall_value += delta


def test_default_frequencies_are_fixed() -> None:
    assert {task.name: task.interval for task in DEFAULT_INTERVAL_TASKS} == {
        "incident_flush": timedelta(seconds=15),
        "reservation_reconcile": timedelta(seconds=30),
        "uncertain_reconcile": timedelta(minutes=5),
        "alert_repair": timedelta(minutes=5),
        "rollup_refresh": timedelta(minutes=15),
        "counter_audit": timedelta(hours=1),
        "price_coverage": timedelta(days=1),
    }
    prune = DEFAULT_DAILY_TASKS[0]
    assert (prune.local_time.hour, prune.local_time.minute, str(prune.timezone)) == (
        3,
        30,
        "Asia/Shanghai",
    )


def test_one_task_exception_does_not_stop_worker() -> None:
    clock = FakeClock()
    calls: list[str] = []

    def fail() -> None:
        calls.append("fail")
        raise RuntimeError("test failure")

    worker = ModelUsageMaintenanceWorker(
        interval_tasks=(
            IntervalMaintenanceTask("bad", fail, timedelta(seconds=1)),
            IntervalMaintenanceTask(
                "good", lambda: calls.append("good"), timedelta(seconds=1)
            ),
        ),
        daily_tasks=(),
        monotonic=clock.monotonic,
        now=clock.now,
    )
    clock.advance(timedelta(seconds=1))
    worker.run_due_once()
    assert calls == ["fail", "good"]
    assert worker.is_stopped is False


def test_startup_task_runs_once_before_interval() -> None:
    clock = FakeClock()
    calls: list[str] = []
    worker = ModelUsageMaintenanceWorker(
        interval_tasks=(
            IntervalMaintenanceTask(
                "coverage",
                lambda: calls.append("coverage"),
                timedelta(days=1),
                run_on_startup=True,
            ),
        ),
        daily_tasks=(),
        monotonic=clock.monotonic,
        now=clock.now,
    )
    worker.run_due_once()
    worker.run_due_once()
    assert calls == ["coverage"]


def test_counter_audit_rotates_past_the_batch_limit(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    first = audit_counters_batch(model_usage_db, limit=1)
    second = audit_counters_batch(model_usage_db, limit=1)

    assert first.reports[0].counter_id != second.reports[0].counter_id


def test_alert_repair_rotates_past_the_batch_limit(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    current = model_usage_db.scalar(
        select(ModelUsagePeriodCounter).where(
            ModelUsagePeriodCounter.family_id == settled_source_event.family_id,
            ModelUsagePeriodCounter.counter_kind == ModelUsageCounterKind.FAMILY_COST,
        )
    )
    assert current is not None
    earlier = ModelUsagePeriodCounter(
        id="usage-counter-alert-rotation",
        family_id=current.family_id,
        period_start=current.period_start - timedelta(days=31),
        period_end=current.period_end - timedelta(days=31),
        counter_kind=ModelUsageCounterKind.FAMILY_COST,
        capability=None,
        meter=None,
        dimension_key=family_cost_dimension_key(),
        settled_value=current.settled_value,
        reserved_value=current.reserved_value,
        adjustment_value=current.adjustment_value,
        version=1,
        health_status="healthy",
        last_verified_at=None,
    )
    model_usage_db.add(earlier)
    model_usage_db.commit()
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)

    repair_alerts_batch(session_factory=factory, limit=1)
    repair_alerts_batch(session_factory=factory, limit=1)

    with factory() as check_db:
        rotated = tuple(
            check_db.scalars(
                select(ModelUsagePeriodCounter)
                .where(
                    ModelUsagePeriodCounter.family_id == settled_source_event.family_id,
                    ModelUsagePeriodCounter.counter_kind == ModelUsageCounterKind.FAMILY_COST,
                )
                .order_by(ModelUsagePeriodCounter.period_start)
            )
        )
    assert len(rotated) == 2
    assert all(counter.last_verified_at is not None for counter in rotated)


def test_rollup_refresh_rotates_distinct_periods_past_the_batch_limit(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    for suffix, month in (("a", 5), ("b", 6)):
        period_start = datetime(2020, month, 1, tzinfo=timezone.utc)
        model_usage_db.add(
            ModelUsagePeriodCounter(
                id=f"usage-counter-rollup-rotation-{suffix}",
                family_id=settled_source_event.family_id,
                period_start=period_start,
                period_end=datetime(2020, month + 1, 1, tzinfo=timezone.utc),
                counter_kind=ModelUsageCounterKind.FAMILY_COST,
                capability=None,
                meter=None,
                dimension_key=family_cost_dimension_key(),
                settled_value=0,
                reserved_value=0,
                adjustment_value=0,
                version=1,
                health_status="healthy",
            )
        )
    model_usage_db.commit()
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)

    refresh_rollups_batch(session_factory=factory, limit=1)
    refresh_rollups_batch(session_factory=factory, limit=1)

    with factory() as check_db:
        refreshed_periods = tuple(
            check_db.scalars(
                select(ModelUsageMonthlyRollup.period_start)
                .where(
                    ModelUsageMonthlyRollup.family_id == settled_source_event.family_id,
                    ModelUsageMonthlyRollup.rollup_kind
                    == ModelUsageRollupKind.FAMILY_TOTAL,
                    ModelUsageMonthlyRollup.period_start.in_(
                        (
                            datetime(2020, 5, 1, tzinfo=timezone.utc),
                            datetime(2020, 6, 1, tzinfo=timezone.utc),
                        )
                    ),
                )
                .order_by(ModelUsageMonthlyRollup.period_start)
            )
        )
    assert len(refreshed_periods) == 2
