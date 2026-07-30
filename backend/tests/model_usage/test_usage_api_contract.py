from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.core.enums import (
    ModelUsageIncidentCoverage,
    ModelUsageMemberBudgetState,
    ModelUsageMeter,
)

from app.schemas.model_usage import (
    ModelUsageFamilyBreakdownOut,
    ModelUsageFamilyOverviewOut,
    ModelUsageMeasurementHealthOut,
    ModelUsagePersonalBreakdownOut,
    ModelUsagePersonalOverviewOut,
)
from app.services.model_usage.aggregation import UsageAggregate, UsageGapInterval
from app.services.model_usage.queries import (
    UsageBreakdown,
    UsageBreakdownItem,
    UsageOverview,
    parse_local_month,
)
from app.services.model_usage.serializers import (
    decimal_text,
    serialize_family_overview,
    serialize_personal_overview,
    serialize_usage_breakdown,
    serialize_cost_summary,
    serialize_measurement_health,
)


def test_personal_overview_schema_cannot_expose_owner_only_fields() -> None:
    forbidden = {
        "monthly_budget_cny",
        "family_total_cost_cny",
        "budget_percent",
        "capability_limits",
        "members",
        "system_usage",
        "effective_spend_cny",
        "reserved_cost_cny",
        "hard_limit_enabled",
    }

    assert forbidden.isdisjoint(ModelUsagePersonalOverviewOut.model_fields)
    assert {"monthly_budget_cny", "effective_spend_cny", "reserved_cost_cny", "hard_limit_enabled"}.issubset(
        ModelUsageFamilyOverviewOut.model_fields
    )


def test_usage_overview_contract_includes_the_tracking_start_time() -> None:
    assert "tracking_started_at" in ModelUsagePersonalOverviewOut.model_fields
    assert "tracking_started_at" in ModelUsageFamilyOverviewOut.model_fields


def test_decimal_text_preserves_sub_cent_precision_as_a_string() -> None:
    assert decimal_text(Decimal("0.001")) == "0.001000000000"
    assert decimal_text(Decimal("12.345")) == "12.345000000000"


def test_cost_summary_omits_total_when_any_event_is_unpriced() -> None:
    payload = serialize_cost_summary(
        UsageAggregate(
            known_priced_cost_cny=Decimal("0.001"),
            unpriced_event_count=1,
        )
    )

    assert payload == {
        "known_priced_cost_cny": "0.001000000000",
        "pricing_complete": False,
        "unpriced_event_count": 1,
    }


def test_cost_summary_includes_total_only_when_pricing_is_complete() -> None:
    payload = serialize_cost_summary(
        UsageAggregate(known_priced_cost_cny=Decimal("0.001"))
    )

    assert payload["total_cost_cny"] == "0.001000000000"
    assert payload["pricing_complete"] is True


def test_measurement_health_keeps_all_orthogonal_states() -> None:
    aggregate = UsageAggregate(
        exact_event_count=2,
        estimated_event_count=3,
        unpriced_event_count=4,
        uncertain_attempt_count=5,
        pending_attempt_count=6,
        unresolved_unknown_execution_attempt_count=7,
        conservative_estimated_cost_cny=Decimal("8.009"),
        known_unmeasured_attempt_count=9,
        measurement_gap=True,
        measurement_gap_scope=("family", "capability:llm"),
        gap_intervals=(
            UsageGapInterval(
                started_at=datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc),
                ended_at=datetime(2026, 7, 1, 1, 0, tzinfo=timezone.utc),
                scope=("family",),
                coverage=ModelUsageIncidentCoverage.UNKNOWN_SCOPE,
            ),
        ),
    )

    payload = serialize_measurement_health(aggregate)
    validated = ModelUsageMeasurementHealthOut.model_validate(payload)

    assert validated.model_dump(mode="json") == {
        "exact_event_count": 2,
        "estimated_event_count": 3,
        "unpriced_event_count": 4,
        "uncertain_attempt_count": 5,
        "pending_attempt_count": 6,
        "unresolved_unknown_execution_attempt_count": 7,
        "conservative_estimated_cost_cny": "8.009000000000",
        "known_unmeasured_attempt_count": 9,
        "measurement_gap": True,
        "measurement_gap_scope": ["unknown_scope"],
        "gap_intervals": [
            {
                "started_at": "2026-07-01T00:00:00Z",
                "ended_at": "2026-07-01T01:00:00Z",
                "scope": ["unknown_scope"],
                "coverage": "unknown_scope",
            }
        ],
    }


def test_measurement_health_strips_internal_subject_keys_from_partial_gap_scopes() -> None:
    secret_subject_key = "CULINA_USAGE_SECRET_SUBJECT_KEY"
    aggregate = UsageAggregate(
        measurement_gap=True,
        gap_intervals=(
            UsageGapInterval(
                started_at=datetime(2026, 7, 1, 0, 0, tzinfo=timezone.utc),
                ended_at=datetime(2026, 7, 1, 1, 0, tzinfo=timezone.utc),
                scope=(f"subject:{secret_subject_key}", "capability:llm"),
                coverage=ModelUsageIncidentCoverage.PARTIAL_SCOPE,
            ),
        ),
    )

    payload = serialize_measurement_health(aggregate)

    assert payload["measurement_gap_scope"] == ["capability:llm"]
    assert payload["gap_intervals"][0]["scope"] == ["capability:llm"]
    assert secret_subject_key not in str(payload)


def test_measurement_health_keeps_unknown_scope_without_raw_gap_intervals() -> None:
    payload = serialize_measurement_health(
        UsageAggregate(
            measurement_gap=True,
            measurement_gap_scope=("unknown_scope",),
        )
    )

    assert payload["measurement_gap_scope"] == ["unknown_scope"]


def test_personal_overview_serialization_never_contains_family_amounts_or_limits() -> None:
    overview = UsageOverview(
        family_id="family-1",
        scope="me",
        period=parse_local_month("2026-07"),
        source="raw",
        is_partial_period=True,
        aggregate=UsageAggregate(
            known_priced_cost_cny=Decimal("0.001"),
            meter_totals={ModelUsageMeter.TOTAL_TOKENS: Decimal("12")},
        ),
        monthly_budget_cny=None,
        effective_spend_cny=Decimal("0"),
        reserved_cost_cny=Decimal("0"),
        hard_limit_enabled=False,
        family_budget_state=ModelUsageMemberBudgetState.APPROACHING_LIMIT,
    )

    payload = serialize_personal_overview(overview)
    validated = ModelUsagePersonalOverviewOut.model_validate(payload)

    assert validated.model_dump(mode="json", exclude_none=True)["meter_totals"] == [
        {"meter": "total_tokens", "quantity": "12.000000000000"}
    ]
    assert validated.family_budget_state is ModelUsageMemberBudgetState.APPROACHING_LIMIT
    forbidden = {
        "monthly_budget_cny",
        "effective_spend_cny",
        "reserved_cost_cny",
        "hard_limit_enabled",
        "capability_limits",
        "members",
        "system_usage",
    }
    assert forbidden.isdisjoint(payload)


def test_family_overview_serialization_contains_owner_budget_values() -> None:
    overview = UsageOverview(
        family_id="family-1",
        scope="family",
        period=parse_local_month("2026-07"),
        source="raw",
        is_partial_period=True,
        aggregate=UsageAggregate(known_priced_cost_cny=Decimal("12.345")),
        monthly_budget_cny=Decimal("80"),
        effective_spend_cny=Decimal("12.345"),
        reserved_cost_cny=Decimal("0.005"),
        hard_limit_enabled=True,
    )

    payload = serialize_family_overview(overview)
    validated = ModelUsageFamilyOverviewOut.model_validate(payload)

    assert validated.monthly_budget_cny == "80.000000000000"
    assert validated.effective_spend_cny == "12.345000000000"
    assert validated.reserved_cost_cny == "0.005000000000"
    assert validated.hard_limit_enabled is True


def test_breakdown_serialization_has_no_internal_subject_identity_fields() -> None:
    breakdown = UsageBreakdown(
        family_id="family-1",
        scope="family",
        period=parse_local_month("2026-07"),
        source="raw",
        is_partial_period=True,
        group_by="subject",
        items=(
            UsageBreakdownItem(
                label="已删除成员 1",
                aggregate=UsageAggregate(known_priced_cost_cny=Decimal("1.5")),
            ),
        ),
    )

    payload = serialize_usage_breakdown(breakdown)
    validated = ModelUsageFamilyBreakdownOut.model_validate(payload)

    assert validated.items[0].label == "已删除成员 1"
    assert "subject_id" not in payload["items"][0]
    assert "subject_key" not in payload["items"][0]
    assert ModelUsagePersonalBreakdownOut.model_fields["scope"].annotation is not None
