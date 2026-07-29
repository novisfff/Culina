from __future__ import annotations

from sqlalchemy import Numeric, Table, UniqueConstraint

from app.db.base import Base


EXPECTED_TABLES = {
    "model_usage_price_versions",
    "model_usage_price_rates",
    "model_usage_subjects",
    "model_usage_family_policies",
    "model_usage_policy_versions",
    "model_usage_capability_limits",
    "model_usage_period_counters",
    "model_usage_reservations",
    "model_usage_reservation_meters",
    "model_usage_events",
    "model_usage_event_meters",
    "model_usage_adjustment_groups",
    "model_usage_adjustments",
    "model_usage_monthly_rollups",
    "model_usage_alerts",
    "model_usage_alert_receipts",
    "model_usage_measurement_incidents",
    "model_usage_measurement_incident_attempts",
}


def unique_columns(table: Table, name: str) -> set[str]:
    constraint = next(
        item
        for item in table.constraints
        if isinstance(item, UniqueConstraint) and item.name == name
    )
    return {column.name for column in constraint.columns}


def assert_numeric(column_name: str, table_name: str, precision: int, scale: int) -> None:
    column_type = Base.metadata.tables[table_name].c[column_name].type
    assert isinstance(column_type, Numeric)
    assert column_type.precision == precision
    assert column_type.scale == scale


def test_model_usage_metadata_has_all_foundational_tables() -> None:
    assert EXPECTED_TABLES <= set(Base.metadata.tables)
    assert "model_usage_realtime_watermarks" not in Base.metadata.tables


def test_ledger_claims_use_non_nullable_unique_dimensions() -> None:
    reservations = Base.metadata.tables["model_usage_reservations"]
    events = Base.metadata.tables["model_usage_events"]
    groups = Base.metadata.tables["model_usage_adjustment_groups"]
    counters = Base.metadata.tables["model_usage_period_counters"]

    assert unique_columns(reservations, "uq_model_usage_reservation_attempt") == {
        "family_id",
        "attempt_key",
    }
    assert unique_columns(events, "uq_model_usage_event_attempt") == {
        "family_id",
        "attempt_key",
    }
    assert unique_columns(groups, "uq_model_usage_adjustment_group_key") == {
        "family_id",
        "idempotency_key",
    }
    assert unique_columns(counters, "uq_model_usage_counter_dimension") == {
        "family_id",
        "period_start",
        "dimension_key",
    }
    assert all(
        not table.c[column].nullable
        for table, column in (
            (reservations, "family_id"),
            (reservations, "attempt_key"),
            (events, "family_id"),
            (events, "attempt_key"),
            (groups, "family_id"),
            (groups, "idempotency_key"),
            (counters, "dimension_key"),
        )
    )


def test_subject_identity_and_policy_pointer_constraints_are_explicit() -> None:
    subjects = Base.metadata.tables["model_usage_subjects"]
    policies = Base.metadata.tables["model_usage_family_policies"]

    assert unique_columns(subjects, "uq_model_usage_subject_user") == {
        "family_id",
        "user_id",
    }
    assert unique_columns(subjects, "uq_model_usage_subject_dimension") == {
        "family_id",
        "dimension_key",
    }
    assert unique_columns(subjects, "uq_model_usage_subject_anonymized_label") == {
        "family_id",
        "anonymized_label",
    }
    assert policies.c.current_policy_version_id.nullable is False

    user_fk = next(
        fk for fk in subjects.c.user_id.foreign_keys if fk.target_fullname == "users.id"
    )
    assert user_fk.ondelete == "SET NULL"


def test_event_owns_the_only_reservation_event_foreign_key() -> None:
    reservations = Base.metadata.tables["model_usage_reservations"]
    events = Base.metadata.tables["model_usage_events"]

    assert "usage_event_id" not in reservations.c
    assert events.c.reservation_id.nullable is True
    assert events.c.reservation_id.unique is True


def test_model_usage_decimal_columns_use_ledger_precision() -> None:
    for table_name, column_name in (
        ("model_usage_price_rates", "unit_price"),
        ("model_usage_price_rates", "fx_to_cny"),
        ("model_usage_price_rates", "unit_price_cny"),
        ("model_usage_policy_versions", "monthly_budget_cny"),
        ("model_usage_capability_limits", "limit_value"),
        ("model_usage_period_counters", "settled_value"),
        ("model_usage_period_counters", "reserved_value"),
        ("model_usage_period_counters", "adjustment_value"),
        ("model_usage_reservations", "reserved_cost_cny"),
        ("model_usage_events", "cost_cny"),
        ("model_usage_adjustments", "cost_delta_cny"),
        ("model_usage_monthly_rollups", "cost_total_cny"),
    ):
        assert_numeric(column_name, table_name, 30, 12)

    for table_name, column_name in (
        ("model_usage_price_rates", "unit_quantity"),
        ("model_usage_reservation_meters", "reserved_quantity"),
        ("model_usage_event_meters", "quantity"),
        ("model_usage_adjustments", "meter_delta"),
        ("model_usage_monthly_rollups", "meter_total"),
    ):
        assert_numeric(column_name, table_name, 30, 6)


def test_adjustment_lines_and_alert_receipts_have_scoped_uniques() -> None:
    adjustments = Base.metadata.tables["model_usage_adjustments"]
    receipts = Base.metadata.tables["model_usage_alert_receipts"]

    assert unique_columns(
        adjustments,
        "uq_model_usage_adjustment_line_sequence",
    ) == {"adjustment_group_id", "line_sequence"}
    assert unique_columns(receipts, "uq_model_usage_alert_receipt_owner") == {
        "alert_id",
        "user_id",
    }
