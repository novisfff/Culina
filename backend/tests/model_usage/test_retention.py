from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageCorrectionStatus, ModelUsageMeter
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageMeasurementIncident,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
    ModelUsageRealtimeWatermark,
)
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.errors import ModelUsageStateError
from app.services.model_usage.retention import (
    RAW_DELETE_ORDER,
    RetentionTarget,
    RetentionVerification,
    is_complete_period_older_than,
    prune_period,
    retention_preflight,
)
from app.services.model_usage.rollups import rebuild_monthly_rollups
from app.core.enums import ModelUsageIncidentCoverage
from tests.model_usage.test_adjustments import settled_source_event


pytest_plugins = ("tests.model_usage.test_reservations",)


class SimulatedCrash(RuntimeError):
    pass


def _old_target(
    db: Session,
    settled_source_event: ModelUsageEvent,
) -> RetentionTarget:
    period = shanghai_billing_period(datetime(2025, 5, 10, tzinfo=timezone.utc))
    reservation = db.get(ModelUsageReservation, settled_source_event.reservation_id)
    assert reservation is not None
    settled_source_event.period_start = period.start_at
    settled_source_event.period_end = period.end_at
    settled_source_event.completed_at = datetime(2025, 5, 10, tzinfo=timezone.utc)
    reservation.period_start = period.start_at
    reservation.period_end = period.end_at
    for counter in db.scalars(
        select(ModelUsagePeriodCounter).where(
            ModelUsagePeriodCounter.family_id == settled_source_event.family_id
        )
    ):
        counter.period_start = period.start_at
        counter.period_end = period.end_at
    for rollup in db.scalars(
        select(ModelUsageMonthlyRollup).where(
            ModelUsageMonthlyRollup.family_id == settled_source_event.family_id
        )
    ):
        rollup.period_start = period.start_at
        rollup.period_end = period.end_at
    db.flush()
    rebuild_monthly_rollups(
        db,
        family_id=settled_source_event.family_id,
        period=period,
    )
    return RetentionTarget(settled_source_event.family_id, period)


def test_retention_keeps_thirteen_complete_months() -> None:
    now = datetime(2026, 7, 30, tzinfo=timezone.utc)
    old = shanghai_billing_period(datetime(2025, 5, 10, tzinfo=timezone.utc))
    retained = shanghai_billing_period(datetime(2025, 6, 10, tzinfo=timezone.utc))
    assert is_complete_period_older_than(old, months=13, now=now) is True
    assert is_complete_period_older_than(retained, months=13, now=now) is False


def test_verification_fail_closed_and_status_transition_contract() -> None:
    failed = RetentionVerification(
        old_enough=True,
        no_active_reservations=True,
        no_pending_recovery=False,
        rollups_complete=True,
        checksum_matches=True,
    )
    assert failed.eligible is False
    assert failed.failures == ("pending_recovery",)
    assert ModelUsageCorrectionStatus.PRUNING is not ModelUsageCorrectionStatus.OPEN


def test_raw_delete_order_is_fk_safe() -> None:
    assert RAW_DELETE_ORDER.index("model_usage_alert_receipts") < RAW_DELETE_ORDER.index(
        "model_usage_alerts"
    )
    assert RAW_DELETE_ORDER.index("model_usage_adjustments") < RAW_DELETE_ORDER.index(
        "model_usage_adjustment_groups"
    )
    assert RAW_DELETE_ORDER.index("model_usage_event_meters") < RAW_DELETE_ORDER.index(
        "model_usage_events"
    )
    assert RAW_DELETE_ORDER.index("model_usage_events") < RAW_DELETE_ORDER.index(
        "model_usage_reservations"
    )
    assert RAW_DELETE_ORDER.index("model_usage_realtime_watermarks") < RAW_DELETE_ORDER.index(
        "model_usage_period_counters"
    )


def test_retention_prunes_realtime_watermarks_before_closing_period(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    target = _old_target(model_usage_db, settled_source_event)
    watermark = ModelUsageRealtimeWatermark(
        id="retention-realtime-watermark",
        family_id=target.family_id,
        period_start=target.period.start_at,
        period_end=target.period.end_at,
        session_key="voice-session-retention",
        provider="dashscope",
        meter=ModelUsageMeter.AUDIO_INPUT_TOKENS,
        cumulative_quantity=Decimal("100"),
        sequence=1,
    )
    model_usage_db.add(watermark)
    model_usage_db.flush()

    result = prune_period(model_usage_db, target, batch_size=1)

    assert result.status is ModelUsageCorrectionStatus.CLOSED
    assert result.deleted["model_usage_realtime_watermarks"] == 1
    assert model_usage_db.get(ModelUsageRealtimeWatermark, watermark.id) is None


def test_prune_transitions_to_closed_only_after_fk_safe_raw_deletion(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    target = _old_target(model_usage_db, settled_source_event)

    result = prune_period(model_usage_db, target, batch_size=1)

    assert result.verification.eligible is True
    assert result.status is ModelUsageCorrectionStatus.CLOSED
    assert model_usage_db.get(ModelUsageEvent, settled_source_event.id) is None
    assert model_usage_db.get(ModelUsageReservation, settled_source_event.reservation_id) is None
    family_rollup = model_usage_db.scalar(
        select(ModelUsageMonthlyRollup).where(
            ModelUsageMonthlyRollup.family_id == target.family_id,
            ModelUsageMonthlyRollup.period_start == target.period.start_at,
            ModelUsageMonthlyRollup.dimension_key == "family_total",
        )
    )
    assert family_rollup is not None
    assert family_rollup.correction_status is ModelUsageCorrectionStatus.CLOSED
    assert family_rollup.raw_data_pruned_at is not None


def test_retention_preflight_rejects_rollup_checksum_drift_before_any_delete(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    target = _old_target(model_usage_db, settled_source_event)
    meter = model_usage_db.scalar(
        select(ModelUsageEventMeter).where(
            ModelUsageEventMeter.event_id == settled_source_event.id
        )
    )
    assert meter is not None
    meter.quantity += Decimal("1")
    model_usage_db.flush()

    verification = retention_preflight(model_usage_db, target)

    assert verification.eligible is False
    assert verification.checksum_matches is False
    with pytest.raises(ModelUsageStateError, match="model_usage_retention_preflight_failed"):
        prune_period(model_usage_db, target, batch_size=1)
    assert model_usage_db.get(ModelUsageEvent, settled_source_event.id) is not None


def test_pruning_state_is_monotonic_and_resumes_after_interrupted_batch(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    target = _old_target(model_usage_db, settled_source_event)

    def fail_after_events(table_name: str) -> None:
        if table_name == "model_usage_events":
            raise SimulatedCrash()

    with pytest.raises(SimulatedCrash):
        prune_period(
            model_usage_db,
            target,
            batch_size=1,
            on_batch=fail_after_events,
        )
    in_progress = model_usage_db.scalar(
        select(ModelUsageMonthlyRollup).where(
            ModelUsageMonthlyRollup.family_id == target.family_id,
            ModelUsageMonthlyRollup.period_start == target.period.start_at,
            ModelUsageMonthlyRollup.dimension_key == "family_total",
        )
    )
    assert in_progress is not None
    assert in_progress.correction_status is ModelUsageCorrectionStatus.PRUNING

    resumed = prune_period(model_usage_db, target, batch_size=1)

    assert resumed.status is ModelUsageCorrectionStatus.CLOSED


def test_global_incident_is_preserved_while_family_raw_rows_are_pruned(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    target = _old_target(model_usage_db, settled_source_event)
    global_incident = ModelUsageMeasurementIncident(
        id="retention-global-incident",
        incident_key="retention-global-incident-key",
        family_id=None,
        subject_id=None,
        subject_key=None,
        capability=None,
        period_start=target.period.start_at,
        period_end=target.period.end_at,
        mode="monitoring_fail_open",
        cause_code="model_usage_ledger_unavailable",
        started_at=target.period.start_at,
        recovered_at=target.period.end_at,
        coverage=ModelUsageIncidentCoverage.UNKNOWN_SCOPE,
        source_instance="test",
    )
    model_usage_db.add(global_incident)
    model_usage_db.flush()
    rebuild_monthly_rollups(
        model_usage_db,
        family_id=target.family_id,
        period=target.period,
    )

    assert retention_preflight(model_usage_db, target).eligible is True
    prune_period(model_usage_db, target, batch_size=1)

    assert model_usage_db.get(ModelUsageMeasurementIncident, global_incident.id) is not None
