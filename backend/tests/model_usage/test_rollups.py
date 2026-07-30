from __future__ import annotations

from dataclasses import replace
from datetime import timezone

from sqlalchemy.orm import Session

from app.core.enums import ModelUsageRollupKind
from app.models.model_usage import ModelUsageEvent
from app.services.model_usage.adjustments import apply_adjustment, preview_adjustment
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.rollups import (
    rebuild_monthly_rollups,
    rollup_dimension_key,
)
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
