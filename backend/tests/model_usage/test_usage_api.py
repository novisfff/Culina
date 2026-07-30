from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event as sqlalchemy_event, select

from app.core.enums import (
    ModelUsageMeter,
    ModelUsagePricingStatus,
    ModelUsageResolutionKind,
)
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageFamilyPolicy,
)
from app.services.model_usage.adjustments import (
    AdjustmentCommand,
    AdjustmentLineCommand,
    apply_adjustment,
    preview_adjustment,
)
from app.services.model_usage.queries import (
    get_family_usage_breakdown,
    get_family_usage_overview,
    get_personal_usage_overview,
    parse_local_month,
)
from app.services.model_usage.rollups import rebuild_monthly_rollups
from tests.model_usage.test_adjustments import (
    evidence_snapshot,
    settled_source_event,
    unpriced_source_event,
)
from tests.model_usage.test_reservations import NOW


pytest_plugins = (
    "tests.model_usage.test_reservations",
    "tests.model_usage._usage_api_support",
)


def test_parse_local_month_rejects_non_month_values() -> None:
    assert parse_local_month("2026-07").local_month == "2026-07"

    with pytest.raises(ValueError, match="model_usage_invalid_period"):
        parse_local_month("2026-7")

    with pytest.raises(ValueError, match="model_usage_invalid_period"):
        parse_local_month("9999-12")


def test_current_family_overview_uses_raw_health_and_strong_counter_values(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    overview = get_family_usage_overview(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period="2026-07",
        at=NOW,
    )

    assert overview.source == "raw"
    assert overview.is_partial_period is True
    assert overview.aggregate.source_event_count == 1
    assert overview.aggregate.known_priced_cost_cny == settled_source_event.cost_cny
    assert overview.effective_spend_cny == settled_source_event.cost_cny
    assert overview.reserved_cost_cny == Decimal("0")


def test_current_usage_period_keeps_an_event_that_settles_after_the_boundary(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    """The durable billing period, rather than response completion time, owns the event."""

    settled_source_event.completed_at = settled_source_event.period_end
    model_usage_db.flush()

    overview = get_family_usage_overview(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period="2026-07",
        at=NOW,
    )

    assert overview.aggregate.source_event_count == 1
    assert overview.aggregate.known_priced_cost_cny == settled_source_event.cost_cny


def test_tracking_start_marks_only_its_start_month_as_partial(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    tracking_started_at = datetime(2026, 7, 10, 3, 0, tzinfo=timezone.utc)
    policy_pointer = model_usage_db.get(
        ModelUsageFamilyPolicy,
        settled_source_event.family_id,
    )
    assert policy_pointer is not None
    policy_pointer.tracking_started_at = tracking_started_at
    model_usage_db.flush()

    start_month = get_family_usage_overview(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period="2026-07",
        at=NOW,
    )
    later_current_month = get_family_usage_overview(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period="2026-08",
        at=datetime(2026, 8, 15, tzinfo=timezone.utc),
    )

    assert start_month.is_partial_period is True
    assert later_current_month.is_partial_period is False
    assert start_month.tracking_started_at == tracking_started_at


def test_current_personal_overview_is_scoped_to_the_authenticated_user_subject(
    model_usage_db,
    reservation_context,
    settled_source_event: ModelUsageEvent,
) -> None:
    overview = get_personal_usage_overview(
        model_usage_db,
        family_id=settled_source_event.family_id,
        user_id=reservation_context.attribution.actor_user_id or "",
        period="2026-07",
        at=NOW,
    )

    assert overview.scope == "me"
    assert overview.source == "raw"
    assert overview.aggregate.source_event_count == 1
    assert overview.aggregate.known_priced_cost_cny == settled_source_event.cost_cny


def test_historical_overview_reads_rollups_without_querying_raw_events(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    period = parse_local_month("2026-07")
    rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )
    statements: list[str] = []

    def record_statement(_conn, _cursor, statement, _parameters, _context, _many) -> None:
        statements.append(statement.lower())

    engine = model_usage_db.get_bind()
    sqlalchemy_event.listen(engine, "before_cursor_execute", record_statement)
    try:
        overview = get_family_usage_overview(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period="2026-07",
            at=datetime(2026, 8, 2, tzinfo=timezone.utc),
        )
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record_statement)

    assert overview.source == "rollup"
    assert overview.is_partial_period is True
    assert overview.tracking_started_at is not None
    assert overview.aggregate.known_priced_cost_cny == settled_source_event.cost_cny
    assert any("model_usage_monthly_rollups" in statement for statement in statements)
    assert not any("model_usage_events" in statement for statement in statements)


def test_historical_breakdown_reads_rollups_without_querying_raw_events(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    period = parse_local_month("2026-07")
    rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )
    statements: list[str] = []

    def record_statement(_conn, _cursor, statement, _parameters, _context, _many) -> None:
        statements.append(statement.lower())

    engine = model_usage_db.get_bind()
    sqlalchemy_event.listen(engine, "before_cursor_execute", record_statement)
    try:
        breakdown = get_family_usage_breakdown(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period="2026-07",
            group_by="capability",
            at=datetime(2026, 8, 2, tzinfo=timezone.utc),
        )
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record_statement)

    assert breakdown.source == "rollup"
    assert len(breakdown.items) == 1
    assert breakdown.items[0].capability is not None
    assert any("model_usage_monthly_rollups" in statement for statement in statements)
    assert not any("model_usage_events" in statement for statement in statements)


def test_breakdown_allows_only_the_public_grouping_whitelist(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    breakdown = get_family_usage_breakdown(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period="2026-07",
        group_by="provider_model",
        at=NOW,
    )

    assert breakdown.source == "raw"
    assert breakdown.group_by == "provider_model"
    assert len(breakdown.items) == 1
    assert breakdown.items[0].provider == "openai"
    assert breakdown.items[0].billing_model == "gpt-test"

    with pytest.raises(ValueError, match="model_usage_invalid_group_by"):
        get_family_usage_breakdown(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period="2026-07",
            group_by="request_payload",
            at=NOW,
        )


def test_current_meter_breakdown_uses_each_meter_line_cost_not_the_event_total(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    expected_costs = {
        row.meter: row.cost_cny or Decimal("0")
        for row in model_usage_db.scalars(
            select(ModelUsageEventMeter).where(
                ModelUsageEventMeter.event_id == settled_source_event.id
            )
        )
    }

    breakdown = get_family_usage_breakdown(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period="2026-07",
        group_by="meter",
        at=NOW,
    )

    assert {
        item.meter: item.aggregate.known_priced_cost_cny
        for item in breakdown.items
    } == expected_costs


def _apply_complete_pricing_correction(model_usage_db, event: ModelUsageEvent) -> None:
    command = AdjustmentCommand(
        family_id=event.family_id,
        source_event_id=event.id,
        source_reservation_id=event.reservation_id,
        idempotency_key="usage-api-pricing-correction-meter-costs",
        fingerprint="fp-usage-api-pricing-correction-meter-costs",
        reason_code="provider_price_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-API-METER-PRICING",
        evidence_ref="provider:invoice:meter-costs",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.PRICING_CORRECTION,
                cost_delta_cny=Decimal("110"),
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
                price_snapshot=evidence_snapshot(
                    complete=True,
                    billing_scheme_key=event.billing_scheme_key,
                ),
                resolved_cost_cny=Decimal("110"),
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)
    apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))


def _pricing_correction_meter_costs(model_usage_db, event: ModelUsageEvent) -> dict:
    billable_costs = {
        ModelUsageMeter.UNCACHED_INPUT_TOKENS: Decimal("60"),
        ModelUsageMeter.CACHED_INPUT_TOKENS: Decimal("40"),
        ModelUsageMeter.OUTPUT_TOKENS: Decimal("10"),
    }
    return {
        row.meter: billable_costs.get(row.meter, Decimal("0"))
        for row in model_usage_db.scalars(
            select(ModelUsageEventMeter).where(ModelUsageEventMeter.event_id == event.id)
        )
    }


def test_current_meter_breakdown_projects_pricing_correction_line_costs(
    model_usage_db,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    _apply_complete_pricing_correction(model_usage_db, unpriced_source_event)

    breakdown = get_family_usage_breakdown(
        model_usage_db,
        family_id=unpriced_source_event.family_id,
        period="2026-07",
        group_by="meter",
        at=NOW,
    )

    assert {
        item.meter: item.aggregate.known_priced_cost_cny
        for item in breakdown.items
    } == _pricing_correction_meter_costs(model_usage_db, unpriced_source_event)


def test_historical_meter_breakdown_preserves_each_meter_line_cost(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    expected_costs = {
        row.meter: row.cost_cny or Decimal("0")
        for row in model_usage_db.scalars(
            select(ModelUsageEventMeter).where(
                ModelUsageEventMeter.event_id == settled_source_event.id
            )
        )
    }
    period = parse_local_month("2026-07")
    rebuild_monthly_rollups(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )

    breakdown = get_family_usage_breakdown(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period="2026-07",
        group_by="meter",
        at=datetime(2026, 8, 2, tzinfo=timezone.utc),
    )

    assert {
        item.meter: item.aggregate.known_priced_cost_cny
        for item in breakdown.items
    } == expected_costs


def test_historical_meter_breakdown_projects_pricing_correction_line_costs(
    model_usage_db,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    _apply_complete_pricing_correction(model_usage_db, unpriced_source_event)
    period = parse_local_month("2026-07")
    rebuild_monthly_rollups(
        model_usage_db,
        family_id=unpriced_source_event.family_id,
        period=period,
    )

    breakdown = get_family_usage_breakdown(
        model_usage_db,
        family_id=unpriced_source_event.family_id,
        period="2026-07",
        group_by="meter",
        at=datetime(2026, 8, 2, tzinfo=timezone.utc),
    )

    assert {
        item.meter: item.aggregate.known_priced_cost_cny
        for item in breakdown.items
    } == _pricing_correction_meter_costs(model_usage_db, unpriced_source_event)


def test_future_usage_period_is_rejected_instead_of_falling_back_to_empty_history(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    with pytest.raises(ValueError, match="model_usage_future_period_not_allowed"):
        get_family_usage_overview(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period="2026-08",
            at=NOW,
        )


def test_usage_overview_routes_expose_scoped_current_period_aggregates(
    usage_api_context,
) -> None:
    personal = usage_api_context.client.get(
        "/api/model-usage/me/overview",
        params={"period": usage_api_context.period},
    )
    family = usage_api_context.client.get(
        "/api/model-usage/family/overview",
        params={"period": usage_api_context.period},
    )

    assert personal.status_code == 200, personal.text
    assert family.status_code == 200, family.text
    assert personal.json()["scope"] == "me"
    assert personal.json()["known_priced_cost_cny"] == "12.345000000000"
    assert family.json()["scope"] == "family"
    assert family.json()["effective_spend_cny"] == "14.346000000000"


def test_usage_breakdown_returns_only_public_dimensions_and_never_subject_keys(
    usage_api_context,
) -> None:
    response = usage_api_context.client.get(
        "/api/model-usage/family/breakdown",
        params={"period": usage_api_context.period, "group_by": "subject"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert usage_api_context.deleted_subject_label in {
        item["label"] for item in payload["items"]
    }
    assert usage_api_context.secret_subject_key not in response.text
    assert all("subject_id" not in item and "subject_key" not in item for item in payload["items"])


def test_usage_api_omits_total_cost_when_one_family_event_is_unpriced(
    usage_api_context,
) -> None:
    with usage_api_context.SessionLocal() as db:
        event = db.get(ModelUsageEvent, "usage-event-deleted-a")
        assert event is not None
        event.pricing_status = ModelUsagePricingStatus.UNPRICED
        event.cost_cny = None
        db.commit()

    response = usage_api_context.client.get(
        "/api/model-usage/family/overview",
        params={"period": usage_api_context.period},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["known_priced_cost_cny"] == "12.346000000000"
    assert payload["pricing_complete"] is False
    assert payload["unpriced_event_count"] == 1
    assert "total_cost_cny" not in payload


def test_usage_api_returns_stable_codes_for_invalid_period_and_grouping(
    usage_api_context,
) -> None:
    invalid_period = usage_api_context.client.get(
        "/api/model-usage/me/overview",
        params={"period": "2026-7"},
    )
    invalid_group = usage_api_context.client.get(
        "/api/model-usage/family/breakdown",
        params={"period": usage_api_context.period, "group_by": "prompt"},
    )

    assert invalid_period.status_code == 422
    assert invalid_period.json()["detail"] == {"code": "model_usage_invalid_period"}
    assert invalid_group.status_code == 422
    assert invalid_group.json()["detail"] == {"code": "model_usage_invalid_group_by"}
