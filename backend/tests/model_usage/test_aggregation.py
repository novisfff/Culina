from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageIncidentCoverage,
    ModelUsageMeasurementStatus,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageReservationStatus,
)
from app.services.model_usage.adjustments import EffectiveUsageState
from app.services.model_usage.aggregation import (
    AggregateEvent,
    AggregateIncident,
    AggregateReservation,
    aggregate_family_current_period,
    aggregate_family_historical_period,
    aggregate_personal_current_period,
    aggregate_usage,
)
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.types import UsageContext
from app.models.model_usage import ModelUsageEvent, ModelUsageMeasurementIncident
from app.services.model_usage.rollups import rebuild_monthly_rollups
from sqlalchemy import event as sqlalchemy_event
from tests.model_usage.test_adjustments import settled_source_event


NOW = datetime(2026, 7, 30, 3, tzinfo=timezone.utc)
pytest_plugins = ("tests.model_usage.test_reservations",)


def _event(
    event_id: str,
    *,
    cost: str | None,
    measurement: ModelUsageMeasurementStatus,
    pricing: ModelUsagePricingStatus,
    certainty: ModelUsageExecutionCertainty = ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
) -> AggregateEvent:
    return AggregateEvent(
        event_id=event_id,
        subject_id="subject-1",
        capability="llm",
        provider="openai",
        billing_model="gpt-snapshot-v1",
        completed_at=NOW,
        effective=EffectiveUsageState(
            source_event_id=event_id,
            capability="llm",
            cost_cny=Decimal(cost) if cost is not None else None,
            meter_quantities={},
            execution_certainty=certainty,
            measurement_status=measurement,
            pricing_status=pricing,
            provider_outcome=(
                ModelUsageProviderOutcome.UNKNOWN
                if certainty is ModelUsageExecutionCertainty.UNKNOWN
                else ModelUsageProviderOutcome.SUCCEEDED
            ),
        ),
    )


def test_event_health_and_pricing_dimensions_remain_orthogonal() -> None:
    aggregate = aggregate_usage(
        events=(
            _event(
                "exact-priced",
                cost="1.25",
                measurement=ModelUsageMeasurementStatus.EXACT,
                pricing=ModelUsagePricingStatus.PRICED,
            ),
            _event(
                "estimated-priced-unknown",
                cost="2.50",
                measurement=ModelUsageMeasurementStatus.ESTIMATED,
                pricing=ModelUsagePricingStatus.PRICED,
                certainty=ModelUsageExecutionCertainty.UNKNOWN,
            ),
            _event(
                "exact-unpriced",
                cost=None,
                measurement=ModelUsageMeasurementStatus.EXACT,
                pricing=ModelUsagePricingStatus.UNPRICED,
            ),
        )
    )

    assert aggregate.exact_event_count == 2
    assert aggregate.estimated_event_count == 1
    assert aggregate.unpriced_event_count == 1
    assert aggregate.unresolved_unknown_execution_attempt_count == 1
    assert aggregate.known_priced_cost_cny == Decimal("3.75")
    assert aggregate.conservative_estimated_cost_cny == Decimal("2.50")
    assert aggregate.pricing_complete is False


def test_pending_and_uncertain_reservations_are_counted_separately() -> None:
    aggregate = aggregate_usage(
        reservations=(
            AggregateReservation("pending-1", ModelUsageReservationStatus.RESERVED),
            AggregateReservation("pending-2", ModelUsageReservationStatus.DISPATCHING),
            AggregateReservation("uncertain-1", ModelUsageReservationStatus.UNCERTAIN),
        )
    )

    assert aggregate.pending_attempt_count == 2
    assert aggregate.uncertain_attempt_count == 1


def test_unknown_scope_gap_does_not_fabricate_cost_or_attempt_count() -> None:
    baseline = aggregate_usage(
        events=(
            _event(
                "known",
                cost="4",
                measurement=ModelUsageMeasurementStatus.EXACT,
                pricing=ModelUsagePricingStatus.PRICED,
            ),
        ),
        incidents=(
            AggregateIncident(
                incident_id="known-gap",
                coverage=ModelUsageIncidentCoverage.PARTIAL_SCOPE,
                started_at=NOW,
                ended_at=NOW,
                scope=("capability:llm",),
                known_unmeasured_attempt_count=2,
            ),
        ),
    )
    with_unknown = aggregate_usage(
        events=(
            _event(
                "known",
                cost="4",
                measurement=ModelUsageMeasurementStatus.EXACT,
                pricing=ModelUsagePricingStatus.PRICED,
            ),
        ),
        incidents=(
            AggregateIncident(
                incident_id="known-gap",
                coverage=ModelUsageIncidentCoverage.PARTIAL_SCOPE,
                started_at=NOW,
                ended_at=NOW,
                scope=("capability:llm",),
                known_unmeasured_attempt_count=2,
            ),
            AggregateIncident(
                incident_id="unknown-gap",
                coverage=ModelUsageIncidentCoverage.UNKNOWN_SCOPE,
                started_at=NOW,
                ended_at=NOW,
                scope=("family",),
                known_unmeasured_attempt_count=0,
            ),
        ),
    )

    assert with_unknown.known_priced_cost_cny == baseline.known_priced_cost_cny
    assert (
        with_unknown.known_unmeasured_attempt_count
        == baseline.known_unmeasured_attempt_count
    )
    assert with_unknown.measurement_gap is True
    assert with_unknown.measurement_gap_scope == (
        "capability:llm",
        "family",
    )


def test_partial_pricing_never_promotes_known_cost_to_complete_total() -> None:
    aggregate = aggregate_usage(
        events=(
            _event(
                "priced",
                cost="0.001",
                measurement=ModelUsageMeasurementStatus.EXACT,
                pricing=ModelUsagePricingStatus.PRICED,
            ),
            _event(
                "unpriced",
                cost=None,
                measurement=ModelUsageMeasurementStatus.ESTIMATED,
                pricing=ModelUsagePricingStatus.UNPRICED,
            ),
        )
    )

    assert aggregate.known_priced_cost_cny == Decimal("0.001")
    assert aggregate.total_cost_cny is None


def test_current_family_uses_strong_counters_and_raw_rows_for_health(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    period = BillingPeriod(
        local_month=settled_source_event.period_start.astimezone(SHANGHAI).strftime("%Y-%m"),
        start_at=settled_source_event.period_start,
        end_at=settled_source_event.period_end,
    )

    aggregate = aggregate_family_current_period(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )

    assert aggregate.source_event_count == 1
    assert aggregate.exact_event_count == 1
    assert aggregate.counter_values["family_cost"] == settled_source_event.cost_cny


def test_personal_current_period_resolves_exactly_one_stable_subject(
    model_usage_db,
    reservation_context: UsageContext,
    settled_source_event: ModelUsageEvent,
) -> None:
    period = BillingPeriod(
        local_month=settled_source_event.period_start.astimezone(SHANGHAI).strftime("%Y-%m"),
        start_at=settled_source_event.period_start,
        end_at=settled_source_event.period_end,
    )

    aggregate = aggregate_personal_current_period(
        model_usage_db,
        family_id=settled_source_event.family_id,
        user_id=reservation_context.attribution.actor_user_id or "",
        period=period,
    )

    assert aggregate.source_event_count == 1
    assert aggregate.known_priced_cost_cny == settled_source_event.cost_cny


def test_historical_family_aggregation_reads_rollups_without_raw_dependency(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    period = BillingPeriod(
        local_month=settled_source_event.period_start.astimezone(SHANGHAI).strftime("%Y-%m"),
        start_at=settled_source_event.period_start,
        end_at=settled_source_event.period_end,
    )
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
        aggregate = aggregate_family_historical_period(
            model_usage_db,
            family_id=settled_source_event.family_id,
            period=period,
        )
    finally:
        sqlalchemy_event.remove(engine, "before_cursor_execute", record_statement)

    assert aggregate.known_priced_cost_cny == settled_source_event.cost_cny
    assert not any("model_usage_events" in statement for statement in statements)
    assert any("model_usage_monthly_rollups" in statement for statement in statements)


def test_current_aggregation_normalizes_naive_mysql_incident_timestamps_as_utc(
    model_usage_db,
    settled_source_event: ModelUsageEvent,
) -> None:
    period = BillingPeriod(
        local_month="2026-07",
        start_at=settled_source_event.period_start,
        end_at=settled_source_event.period_end,
    )
    model_usage_db.add(
        ModelUsageMeasurementIncident(
            id="naive-incident",
            incident_key="naive-incident",
            family_id=settled_source_event.family_id,
            subject_id=settled_source_event.subject_id,
            subject_key=settled_source_event.subject_key,
            capability=settled_source_event.capability,
            period_start=period.start_at,
            period_end=period.end_at,
            mode="fail_open",
            cause_code="test",
            started_at=datetime(2026, 6, 30, 16, 30),
            recovered_at=None,
            coverage=ModelUsageIncidentCoverage.PARTIAL_SCOPE,
            source_instance="test",
            created_at=datetime(2026, 6, 30, 16, 30),
            updated_at=datetime(2026, 6, 30, 16, 30),
        )
    )
    model_usage_db.flush()

    aggregate = aggregate_family_current_period(
        model_usage_db,
        family_id=settled_source_event.family_id,
        period=period,
    )

    interval = next(
        item for item in aggregate.gap_intervals if item.scope[-1] == "capability:llm"
    )
    assert interval.started_at == datetime(2026, 6, 30, 16, 30, tzinfo=timezone.utc)
