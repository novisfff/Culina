from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageCorrectionStatus, ModelUsageRollupKind
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageMonthlyRollup,
    ModelUsageReservation,
    ModelUsageSubject,
)
from app.repos.model_usage.reporting import (
    historical_rollups_for_period,
    retained_subject_labels,
)
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.adjustments import apply_adjustment, preview_adjustment
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.rollups import (
    rebuild_monthly_rollups,
    rollup_dimension_key,
)
from app.services.model_usage.types import ProviderRecoveryPolicy, UsageContext
from tests.model_usage.test_adjustments import (
    meter_correction_command,
    settled_source_event,
)


pytest_plugins = ("tests.model_usage.test_reservations",)


def _period(event: ModelUsageEvent) -> BillingPeriod:
    return BillingPeriod(
        local_month=event.period_start.astimezone(SHANGHAI).strftime("%Y-%m"),
        start_at=event.period_start.replace(tzinfo=timezone.utc),
        end_at=event.period_end.replace(tzinfo=timezone.utc),
    )


def _utc_value(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def test_rebuild_generates_every_historical_dimension_from_snapshot_fields(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    settled_source_event.reported_model = "provider-alias-that-must-not-be-selected"

    result = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )

    assert {row.rollup_kind for row in result.rows} == set(ModelUsageRollupKind)
    subject = next(
        row
        for row in result.rows
        if row.rollup_kind is ModelUsageRollupKind.SUBJECT_TOTAL
        and row.subject_id == settled_source_event.subject_id
    )
    provider_model = next(
        row
        for row in result.rows
        if row.rollup_kind is ModelUsageRollupKind.PROVIDER_MODEL_TOTAL
    )
    daily = next(
        row
        for row in result.rows
        if row.rollup_kind is ModelUsageRollupKind.DAILY_CAPABILITY_COST
    )
    assert subject.subject_id == settled_source_event.subject_id
    assert subject.subject_key == settled_source_event.subject_key
    assert provider_model.billing_model == settled_source_event.billing_model
    assert provider_model.billing_model != settled_source_event.reported_model
    assert daily.local_day == settled_source_event.completed_at.astimezone(SHANGHAI).date()


def test_first_build_locks_guaranteed_family_anchor_before_period_sources(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    model_usage_db.query(ModelUsageMonthlyRollup).filter(
        ModelUsageMonthlyRollup.family_id == settled_source_event.family_id,
        ModelUsageMonthlyRollup.period_start == settled_source_event.period_start,
    ).delete(synchronize_session=False)
    model_usage_db.flush()
    statements: list[str] = []

    def record(_conn, _cursor, statement, _params, _context, _many) -> None:
        statements.append(" ".join(statement.lower().split()))

    engine = model_usage_db.get_bind()
    sqlalchemy_event.listen(engine, "before_cursor_execute", record)
    try:
        rebuild_monthly_rollups(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period=_period(settled_source_event),
        )
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record)

    first_select = next(statement for statement in statements if statement.startswith("select"))
    assert " from families " in f" {first_select} "


def test_dimension_key_is_canonical_and_independent_of_mapping_order() -> None:
    first = rollup_dimension_key(
        ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
        {"provider": "openai", "billing_model": "gpt-snapshot-v1"},
    )
    second = rollup_dimension_key(
        ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
        {"billing_model": "gpt-snapshot-v1", "provider": "openai"},
    )

    assert first == second
    assert first == (
        "provider_model_total|billing_model=gpt-snapshot-v1|provider=openai"
    )


def test_same_sources_generate_same_checksum_and_revision(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    first = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )
    second = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )

    assert second.checksum == first.checksum
    assert second.source_watermark == first.source_watermark
    assert second.revision == first.revision
    assert [(row.dimension_key, row.revision) for row in second.rows] == [
        (row.dimension_key, row.revision) for row in first.rows
    ]


def test_late_adjustment_changes_checksum_and_increments_revision_once(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
    meter_correction_command,
) -> None:
    before = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )
    command = replace(
        meter_correction_command,
        idempotency_key="rollup-late-adjustment",
        fingerprint="fp-rollup-late-adjustment",
    )
    preview = preview_adjustment(model_usage_db, command)
    apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))

    after = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )
    replay = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )

    assert after.checksum != before.checksum
    assert after.revision > before.revision
    assert replay.checksum == after.checksum
    assert replay.revision == after.revision


@pytest.mark.parametrize(
    ("status", "pruned"),
    (
        (ModelUsageCorrectionStatus.PRUNING, False),
        (ModelUsageCorrectionStatus.CLOSED, False),
        (ModelUsageCorrectionStatus.OPEN, True),
    ),
)
def test_non_open_or_pruned_rebuild_returns_persisted_rows_without_raw_reads(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
    status: ModelUsageCorrectionStatus,
    pruned: bool,
) -> None:
    period = _period(settled_source_event)
    built = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )
    family = next(
        row for row in built.rows if row.rollup_kind is ModelUsageRollupKind.FAMILY_TOTAL
    )
    family.correction_status = status
    family.raw_data_pruned_at = (
        datetime(2027, 9, 1, tzinfo=timezone.utc) if pruned else None
    )
    model_usage_db.flush()
    before = tuple(
        (
            row.id,
            row.dimension_key,
            row.revision,
            row.checksum,
            row.source_watermark,
            row.correction_status,
                _utc_value(row.adjustment_closed_at),
                _utc_value(row.raw_data_pruned_at),
                _utc_value(row.computed_at),
        )
        for row in built.rows
    )
    statements: list[str] = []

    def record(_conn, _cursor, statement, _params, _context, _many) -> None:
        statements.append(statement.lower())

    engine = model_usage_db.get_bind()
    sqlalchemy_event.listen(engine, "before_cursor_execute", record)
    try:
        result = rebuild_monthly_rollups(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period=period,
        )
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record)

    assert tuple(
        (
            row.id,
            row.dimension_key,
            row.revision,
            row.checksum,
            row.source_watermark,
            row.correction_status,
            _utc_value(row.adjustment_closed_at),
            _utc_value(row.raw_data_pruned_at),
            _utc_value(row.computed_at),
        )
        for row in result.rows
    ) == before
    raw_tables = (
        "model_usage_events",
        "model_usage_event_meters",
        "model_usage_adjustment_groups",
        "model_usage_reservations",
        "model_usage_measurement_incidents",
    )
    assert not any(any(table in statement for table in raw_tables) for statement in statements)


def test_open_rebuild_removes_obsolete_dimensions_and_preserves_lifecycle_fields(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    period = _period(settled_source_event)
    built = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )
    family = next(
        row for row in built.rows if row.rollup_kind is ModelUsageRollupKind.FAMILY_TOTAL
    )
    preserved_closed_at = datetime(2026, 8, 1, tzinfo=timezone.utc)
    family.adjustment_closed_at = preserved_closed_at
    obsolete = ModelUsageMonthlyRollup(
        id="obsolete-provider-rollup",
        family_id=family.family_id,
        period_start=family.period_start,
        period_end=family.period_end,
        rollup_kind=ModelUsageRollupKind.PROVIDER_MODEL_TOTAL,
        dimension_key="provider_model_total|billing_model=obsolete|provider=obsolete",
        subject_id=None,
        subject_key=None,
        capability=None,
        provider="obsolete",
        billing_model="obsolete",
        meter=None,
        local_day=None,
        exact_event_count=1,
        estimated_event_count=0,
        unpriced_event_count=0,
        uncertain_attempt_count=0,
        unresolved_unknown_execution_count=0,
        unresolved_known_unmeasured_count=0,
        has_unknown_measurement_gap=False,
        meter_total=None,
        cost_total_cny=Decimal("1"),
        source_event_count=1,
        source_adjustment_count=0,
        source_incident_count=0,
        revision=1,
        source_watermark="obsolete",
        checksum="f" * 64,
        correction_status=ModelUsageCorrectionStatus.OPEN,
        adjustment_closed_at=None,
        raw_data_pruned_at=None,
        computed_at=datetime(2026, 8, 1, tzinfo=timezone.utc),
    )
    model_usage_db.add(obsolete)
    model_usage_db.flush()

    result = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )

    assert obsolete not in result.rows
    assert model_usage_db.get(ModelUsageMonthlyRollup, obsolete.id) is None
    refreshed_family = model_usage_db.get(ModelUsageMonthlyRollup, family.id)
    assert refreshed_family is not None
    assert refreshed_family.correction_status is ModelUsageCorrectionStatus.OPEN
    assert _utc_value(refreshed_family.adjustment_closed_at) == preserved_closed_at
    assert refreshed_family.raw_data_pruned_at is None


def test_source_watermark_advances_without_revision_when_display_values_do_not_change(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-watermark-transition",
        at=datetime(2026, 7, 30, 3, tzinfo=timezone.utc),
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None
    period = BillingPeriod(
        local_month="2026-07",
        start_at=reservation.period_start,
        end_at=reservation.period_end,
    )
    first = rebuild_monthly_rollups(
        model_usage_db,
        family_id=reservation.family_id,
        period=period,
    )
    family_first = next(
        row for row in first.rows if row.rollup_kind is ModelUsageRollupKind.FAMILY_TOTAL
    )
    before = (family_first.source_watermark, family_first.revision, family_first.checksum)
    prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        fingerprint="fp-watermark-transition",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )

    second = rebuild_monthly_rollups(
        model_usage_db,
        family_id=reservation.family_id,
        period=period,
    )
    family_second = next(
        row for row in second.rows if row.rollup_kind is ModelUsageRollupKind.FAMILY_TOTAL
    )

    assert family_second.source_watermark != before[0]
    assert family_second.revision == before[1]
    assert family_second.checksum == before[2]


def test_naive_mysql_utc_daily_bucket_crosses_shanghai_month_boundary(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    settled_source_event.completed_at = datetime(2026, 6, 30, 16, 30)
    result = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )

    family_daily = next(
        row
        for row in result.rows
        if row.rollup_kind is ModelUsageRollupKind.DAILY_CAPABILITY_COST
        and row.subject_id is None
    )
    assert family_daily.local_day.isoformat() == "2026-07-01"


def test_daily_trend_rolls_family_and_subject_costs_across_shanghai_days(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    first_instant = datetime(2026, 6, 30, 16, 30)
    second_instant = datetime(2026, 7, 1, 16, 30, tzinfo=timezone.utc)
    settled_source_event.completed_at = first_instant
    values = {
        column.name: getattr(settled_source_event, column.name)
        for column in ModelUsageEvent.__table__.columns
    }
    values.update(
        {
            "id": "usage-event-second-shanghai-day",
            "reservation_id": None,
            "attempt_key": "second-shanghai-day",
            "fingerprint": "fp-second-shanghai-day",
            "client_attempt_id": "client-second-shanghai-day",
            "dispatched_at": second_instant,
            "completed_at": second_instant,
            "created_at": second_instant,
        }
    )
    model_usage_db.add(ModelUsageEvent(**values))
    model_usage_db.flush()

    first = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )
    second = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )

    family_daily = tuple(
        row
        for row in first.rows
        if row.rollup_kind is ModelUsageRollupKind.DAILY_CAPABILITY_COST
        and row.subject_id is None
    )
    subject_daily = tuple(
        row
        for row in first.rows
        if row.rollup_kind is ModelUsageRollupKind.DAILY_CAPABILITY_COST
        and row.subject_id == settled_source_event.subject_id
    )
    assert [row.local_day.isoformat() for row in family_daily] == [
        "2026-07-01",
        "2026-07-02",
    ]
    assert [row.local_day.isoformat() for row in subject_daily] == [
        "2026-07-01",
        "2026-07-02",
    ]
    assert all(row.exact_event_count == 1 for row in (*family_daily, *subject_daily))
    assert all(row.source_event_count == 1 for row in (*family_daily, *subject_daily))
    assert all(
        row.cost_total_cny == settled_source_event.cost_cny
        for row in (*family_daily, *subject_daily)
    )
    assert [row.dimension_key for row in family_daily] == [
        rollup_dimension_key(
            ModelUsageRollupKind.DAILY_CAPABILITY_COST,
            {"capability": "llm", "local_day": local_day},
        )
        for local_day in ("2026-07-01", "2026-07-02")
    ]
    assert [(row.dimension_key, row.checksum) for row in second.rows] == [
        (row.dimension_key, row.checksum) for row in first.rows
    ]


def test_naive_and_aware_utc_source_datetimes_have_same_canonical_watermark(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    instant = datetime(2026, 6, 30, 16, 30)
    settled_source_event.completed_at = instant
    first = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )
    settled_source_event.completed_at = instant.replace(tzinfo=timezone.utc)

    second = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=_period(settled_source_event),
    )

    assert second.source_watermark == first.source_watermark
    assert second.checksum == first.checksum
    assert second.revision == first.revision


def test_deleted_subject_label_resolves_from_retained_subject_without_raw_join(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
) -> None:
    subject = model_usage_db.get(ModelUsageSubject, settled_source_event.subject_id)
    assert subject is not None
    subject.user_id = None
    subject.anonymized_label = "已删除成员"
    model_usage_db.flush()
    period = _period(settled_source_event)
    built = rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )
    family = next(
        row for row in built.rows if row.rollup_kind is ModelUsageRollupKind.FAMILY_TOTAL
    )
    family.correction_status = ModelUsageCorrectionStatus.CLOSED
    family.adjustment_closed_at = datetime(2026, 8, 31, tzinfo=timezone.utc)
    family.raw_data_pruned_at = datetime(2027, 9, 1, tzinfo=timezone.utc)
    model_usage_db.flush()
    statements: list[tuple[str, object]] = []

    def record(_conn, _cursor, statement, params, _context, _many) -> None:
        statements.append((statement.lower(), params))

    engine = model_usage_db.get_bind()
    sqlalchemy_event.listen(engine, "before_cursor_execute", record)
    try:
        historical = historical_rollups_for_period(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period=period,
        )
        subject_ids = tuple(
            sorted({row.subject_id for row in historical if row.subject_id is not None})
        )
        labels = retained_subject_labels(
            model_usage_db,
            family_id=settled_source_event.family_id,
            subject_ids=subject_ids,
        )
        wrong_family = retained_subject_labels(
            model_usage_db,
            family_id="other-family",
            subject_ids=subject_ids,
        )
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record)

    assert labels == {subject.id: "已删除成员"}
    assert wrong_family == {}
    sql = [statement for statement, _params in statements]
    assert any("model_usage_monthly_rollups" in statement for statement in sql)
    assert any("model_usage_subjects" in statement for statement in sql)
    forbidden = (
        "model_usage_events",
        "model_usage_event_meters",
        " users ",
        " foods ",
        " recipes ",
    )
    assert not any(any(table in statement for table in forbidden) for statement in sql)
    assert all(
        "family_id" in statement
        for statement in sql
        if "model_usage_monthly_rollups" in statement
        or "model_usage_subjects" in statement
    )
