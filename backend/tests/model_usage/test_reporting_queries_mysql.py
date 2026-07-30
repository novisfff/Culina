from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Iterator

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.dialects import mysql
from sqlalchemy.engine import make_url

from app.services.model_usage.periods import BillingPeriod, shanghai_billing_period
from app.db.base import Base
from app.models.domain import Family
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
    ModelUsageSubject,
)
from tests.model_usage.test_migration_mysql import MySqlAlembicDatabase
from app.repos.model_usage.reporting import (
    family_counters_statement,
    family_events_statement,
    historical_rollups_statement,
    subject_events_statement,
)


PERIOD = BillingPeriod(
    local_month="2026-07",
    start_at=datetime(2026, 6, 30, 16, tzinfo=timezone.utc),
    end_at=datetime(2026, 7, 31, 16, tzinfo=timezone.utc),
)


def _sql(statement) -> str:
    return str(
        statement.compile(
            dialect=mysql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )


def test_reporting_statements_always_scope_family_period_and_subject() -> None:
    family_sql = _sql(family_events_statement(family_id="family-a", period=PERIOD))
    subject_sql = _sql(
        subject_events_statement(
            family_id="family-a",
            subject_id="subject-a",
            period=PERIOD,
        )
    )
    counter_sql = _sql(family_counters_statement(family_id="family-a", period=PERIOD))
    rollup_sql = _sql(historical_rollups_statement(family_id="family-a", period=PERIOD))

    for sql in (family_sql, subject_sql, counter_sql, rollup_sql):
        assert "family_id = 'family-a'" in sql
        assert "period_start = '2026-06-30 16:00:00+00:00'" in sql
    assert "subject_id = 'subject-a'" in subject_sql


def _mysql_url():
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not url.database or not url.database.endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


@pytest.fixture(scope="module")
def mysql_reporting_engine() -> Iterator[object]:
    database = MySqlAlembicDatabase.from_test_url(_mysql_url())
    database.recreate()
    engine = create_engine(database.url, pool_pre_ping=True)
    try:
        Base.metadata.create_all(engine)
        _seed_reference_scale(engine, events_in_current_period=100_000)
        yield engine
    finally:
        engine.dispose()
        database.dispose()


def _seed_reference_scale(engine, *, events_in_current_period: int) -> None:
    now = PERIOD.start_at
    with engine.begin() as connection:
        connection.execute(
            Family.__table__.insert(),
            {
                "id": "family-a",
                "name": "Reference family",
                "motto": "",
                "location": "",
                "food_preferences": [],
                "food_avoidances": [],
                "created_at": now,
                "updated_at": now,
                "created_by": None,
                "updated_by": None,
            },
        )
        connection.execute(
            ModelUsageSubject.__table__.insert(),
            {
                "id": "subject-a",
                "subject_key": "mus_reference_subject",
                "family_id": "family-a",
                "user_id": None,
                "subject_kind": "system",
                "dimension_key": "system",
                "anonymized_label": "系统",
                "created_at": now,
                "unlinked_at": None,
            },
        )
        connection.execute(
            ModelUsagePolicyVersion.__table__.insert(),
            {
                "id": "policy-a",
                "family_id": "family-a",
                "version_number": 1,
                "monthly_budget_cny": Decimal("100000"),
                "alerts_enabled": True,
                "hard_limit_enabled": False,
                "budget_alert_revision": 1,
                "policy_checksum": "0" * 64,
                "created_by_subject_id": "subject-a",
                "created_at": now,
                "effective_at": now,
            },
        )
        connection.execute(
            ModelUsagePeriodCounter.__table__.insert(),
            {
                "id": "counter-a",
                "family_id": "family-a",
                "period_start": PERIOD.start_at,
                "period_end": PERIOD.end_at,
                "counter_kind": "family_cost",
                "capability": None,
                "meter": None,
                "dimension_key": "family_cost",
                "settled_value": Decimal("100"),
                "reserved_value": Decimal("0"),
                "adjustment_value": Decimal("0"),
                "version": 1,
                "health_status": "healthy",
                "last_verified_at": now,
                "created_at": now,
                "updated_at": now,
            },
        )
        retained_periods = []
        for offset in range(13):
            zero_based = 2026 * 12 + 6 - offset
            year, month_index = divmod(zero_based, 12)
            retained_periods.append(
                shanghai_billing_period(
                    datetime(year, month_index + 1, 15, tzinfo=timezone.utc)
                )
            )
        connection.execute(
            ModelUsageMonthlyRollup.__table__.insert(),
            [
                {
                "id": f"rollup-a-{index}",
                "family_id": "family-a",
                "period_start": retained.start_at,
                "period_end": retained.end_at,
                "rollup_kind": "family_total",
                "dimension_key": "family_total",
                "subject_id": None,
                "subject_key": None,
                "capability": None,
                "provider": None,
                "billing_model": None,
                "meter": None,
                "local_day": None,
                "exact_event_count": events_in_current_period,
                "estimated_event_count": 0,
                "unpriced_event_count": 0,
                "uncertain_attempt_count": 0,
                "unresolved_unknown_execution_count": 0,
                "unresolved_known_unmeasured_count": 0,
                "has_unknown_measurement_gap": False,
                "meter_total": None,
                "cost_total_cny": Decimal("100"),
                "source_event_count": events_in_current_period,
                "source_adjustment_count": 0,
                "source_incident_count": 0,
                "revision": 1,
                "source_watermark": "reference",
                "checksum": "1" * 64,
                "correction_status": "open",
                "adjustment_closed_at": None,
                "raw_data_pruned_at": None,
                "computed_at": now,
                }
                for index, retained in enumerate(retained_periods)
            ],
        )
        meter_names = (
            "input_tokens",
            "uncached_input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "total_tokens",
        )
        for start in range(0, events_in_current_period, 1000):
            stop = min(start + 1000, events_in_current_period)
            event_rows = []
            meter_rows = []
            for index in range(start, stop):
                event_id = f"event-{index:06d}"
                event_rows.append(
                    {
                        "id": event_id,
                        "reservation_id": None,
                        "recovery_source": "normal",
                        "attempt_key": f"attempt-{index:06d}",
                        "fingerprint": f"fp-{index:06d}",
                        "client_attempt_id": f"client-{index:06d}",
                        "family_id": "family-a",
                        "subject_id": "subject-a",
                        "subject_key": "mus_reference_subject",
                        "capability": "llm",
                        "provider": "openai",
                        "requested_model": "gpt-reference",
                        "reported_model": "gpt-reference-alias",
                        "billing_model": "gpt-reference-snapshot",
                        "variant_key": "reference",
                        "billing_scheme_key": "tokens-v1",
                        "pricing_status": "priced",
                        "price_version_id": None,
                        "price_snapshot_checksum": "2" * 64,
                        "policy_version_id": "policy-a",
                        "dispatch_policy_version_id": "policy-a",
                        "period_start": PERIOD.start_at,
                        "period_end": PERIOD.end_at,
                        "provider_outcome": "succeeded",
                        "execution_certainty": "confirmed_executed",
                        "measurement_status": "exact",
                        "provider_reported_source_cost": None,
                        "provider_reported_source_currency": None,
                        "cost_cny": Decimal("0.001"),
                        "provider_request_id": None,
                        "dispatched_at": now,
                        "completed_at": now,
                        "estimation_reason": None,
                        "stable_error_code": None,
                        "fail_open_proof_id": None,
                        "created_at": now,
                    }
                )
                for meter_index, meter in enumerate(meter_names[: 3 + index % 3]):
                    meter_rows.append(
                        {
                            "id": f"meter-{index:06d}-{meter_index}",
                            "event_id": event_id,
                            "meter_key": meter,
                            "meter": meter,
                            "meter_role": "informational",
                            "quantity": Decimal("1"),
                            "quantity_source": "provider",
                            "unit_quantity": None,
                            "source_unit_price": None,
                            "source_currency": None,
                            "fx_to_cny": None,
                            "unit_price_cny": None,
                            "cost_cny": None,
                        }
                    )
            connection.execute(ModelUsageEvent.__table__.insert(), event_rows)
            connection.execute(ModelUsageEventMeter.__table__.insert(), meter_rows)


def _explain(engine, statement) -> list[dict[str, object]]:
    sql = _sql(statement)
    with engine.connect() as connection:
        return [dict(row) for row in connection.execute(text(f"EXPLAIN {sql}")).mappings()]


def _assert_indexed(plan: list[dict[str, object]], expected: str) -> None:
    assert plan
    keys = {str(row.get("key") or "") for row in plan}
    assert expected in keys
    assert all(str(row.get("type") or "").upper() != "ALL" for row in plan)


def test_current_overview_uses_counter_family_period_index(mysql_reporting_engine) -> None:
    _assert_indexed(
        _explain(mysql_reporting_engine, family_counters_statement(family_id="family-a", period=PERIOD)),
        "ix_model_usage_counter_family_period",
    )


def test_current_breakdown_uses_event_family_period_index(mysql_reporting_engine) -> None:
    _assert_indexed(
        _explain(mysql_reporting_engine, family_events_statement(family_id="family-a", period=PERIOD)),
        "ix_model_usage_event_family_period",
    )


def test_personal_breakdown_stays_on_family_period_index(mysql_reporting_engine) -> None:
    _assert_indexed(
        _explain(
            mysql_reporting_engine,
            subject_events_statement(
                family_id="family-a", subject_id="subject-a", period=PERIOD
            )
        ),
        "ix_model_usage_event_family_period",
    )


def test_historical_breakdown_uses_rollup_family_period_index(mysql_reporting_engine) -> None:
    _assert_indexed(
        _explain(mysql_reporting_engine, historical_rollups_statement(family_id="family-a", period=PERIOD)),
        "ix_model_usage_rollup_family_period",
    )


@dataclass(frozen=True)
class ReportingBenchmarkStats:
    current_overview_query_count: int
    historical_rollup_query_count: int
    current_overview_wall_ms: float
    historical_rollup_wall_ms: float


def run_reporting_reference_benchmark(
    engine,
    *,
    family_count: int,
    periods: int,
    events_in_current_period: int,
    meters_per_event: tuple[int, int],
) -> ReportingBenchmarkStats:
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT COUNT(*) FROM families")) == family_count
        assert (
            connection.scalar(text("SELECT COUNT(*) FROM model_usage_events"))
            == events_in_current_period
        )
        meter_count = int(
            connection.scalar(text("SELECT COUNT(*) FROM model_usage_event_meters")) or 0
        )
        assert events_in_current_period * meters_per_event[0] <= meter_count
        assert meter_count <= events_in_current_period * meters_per_event[1]
        assert periods == 13  # Documents the retained-history benchmark horizon.
        assert (
            connection.scalar(
                text("SELECT COUNT(DISTINCT period_start) FROM model_usage_monthly_rollups")
            )
            == periods
        )
    query_count = 0

    def count_query(*_args) -> None:
        nonlocal query_count
        query_count += 1

    event.listen(engine, "before_cursor_execute", count_query)
    try:
        started = time.perf_counter()
        with engine.connect() as connection:
            connection.execute(
                family_counters_statement(family_id="family-a", period=PERIOD)
            ).all()
        current_wall_ms = (time.perf_counter() - started) * 1000
        current_count = query_count

        query_count = 0
        started = time.perf_counter()
        with engine.connect() as connection:
            connection.execute(
                historical_rollups_statement(family_id="family-a", period=PERIOD)
            ).all()
        historical_wall_ms = (time.perf_counter() - started) * 1000
    finally:
        event.remove(engine, "before_cursor_execute", count_query)
    return ReportingBenchmarkStats(
        current_overview_query_count=current_count,
        historical_rollup_query_count=query_count,
        current_overview_wall_ms=current_wall_ms,
        historical_rollup_wall_ms=historical_wall_ms,
    )


def test_reference_scale_query_budget_and_wall_time_metric(
    mysql_reporting_engine,
    record_property,
) -> None:
    stats = run_reporting_reference_benchmark(
        mysql_reporting_engine,
        family_count=1,
        periods=13,
        events_in_current_period=100_000,
        meters_per_event=(3, 5),
    )

    record_property("current_overview_wall_ms", stats.current_overview_wall_ms)
    record_property("historical_rollup_wall_ms", stats.historical_rollup_wall_ms)
    assert stats.current_overview_query_count <= 8
    assert stats.historical_rollup_query_count <= 3
