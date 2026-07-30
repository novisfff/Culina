from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageCounterKind, ModelUsageMeter
from app.models.model_usage import ModelUsagePeriodCounter
from app.services.model_usage.counter_audit import (
    CounterValues,
    audit_counter,
    audit_counters_batch,
    expected_counter_values,
)
from tests.model_usage.test_adjustments import settled_source_event, unpriced_source_event


pytest_plugins = ("tests.model_usage.test_reservations",)


def _counter(
    db: Session,
    *,
    kind: ModelUsageCounterKind,
    meter: ModelUsageMeter | None = None,
) -> ModelUsagePeriodCounter:
    statement = select(ModelUsagePeriodCounter).where(
        ModelUsagePeriodCounter.counter_kind == kind
    )
    if meter is not None:
        statement = statement.where(ModelUsagePeriodCounter.meter == meter)
    row = db.scalar(statement)
    assert row is not None
    return row


def test_cost_and_meter_expectations_use_separate_ledger_formulas(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    family = _counter(model_usage_db, kind=ModelUsageCounterKind.FAMILY_COST)
    capability = _counter(model_usage_db, kind=ModelUsageCounterKind.CAPABILITY_COST)
    meter = _counter(
        model_usage_db,
        kind=ModelUsageCounterKind.CAPABILITY_METER,
        meter=ModelUsageMeter.INPUT_TOKENS,
    )

    assert expected_counter_values(model_usage_db, family) == CounterValues(
        settled_value=settled_source_event.cost_cny,
        reserved_value=Decimal("0"),
        adjustment_value=Decimal("0"),
    )
    assert expected_counter_values(model_usage_db, capability) == expected_counter_values(
        model_usage_db, family
    )
    assert expected_counter_values(model_usage_db, meter).settled_value == Decimal("100")


def test_unpriced_informational_quantity_is_audited_into_meter_counter(
    model_usage_db: Session,
    unpriced_source_event,
) -> None:
    meter = _counter(
        model_usage_db,
        kind=ModelUsageCounterKind.CAPABILITY_METER,
        meter=ModelUsageMeter.INPUT_TOKENS,
    )
    assert expected_counter_values(model_usage_db, meter).settled_value == Decimal("100")


def test_counter_audit_repairs_only_after_locked_recheck(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    counter = _counter(model_usage_db, kind=ModelUsageCounterKind.FAMILY_COST)
    counter.settled_value += Decimal("9")
    model_usage_db.flush()

    report = audit_counter(model_usage_db, counter.id, repair=True)

    assert report.drift_detected is True
    assert report.rechecked_under_lock is True
    assert report.repaired is True
    assert report.after == report.expected
    assert counter.version > 1


def test_read_only_audit_marks_unhealthy_without_repair(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    counter = _counter(model_usage_db, kind=ModelUsageCounterKind.FAMILY_COST)
    counter.adjustment_value = Decimal("2")
    report = audit_counter(model_usage_db, counter.id, repair=False)
    assert report.repaired is False
    assert report.after != report.expected
    assert counter.health_status == "drifted"


def test_verify_only_audit_does_not_persist_health_metadata(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    counter = _counter(model_usage_db, kind=ModelUsageCounterKind.FAMILY_COST)
    previous_health_status = counter.health_status
    previous_last_verified_at = counter.last_verified_at
    counter.adjustment_value = Decimal("2")
    model_usage_db.flush()

    report = audit_counter(
        model_usage_db,
        counter.id,
        repair=False,
        record_verification=False,
    )

    assert report.repaired is False
    assert report.after != report.expected
    assert counter.health_status == previous_health_status
    assert counter.last_verified_at == previous_last_verified_at


def test_batch_health_is_explicitly_fail_closed_or_fail_open(
    model_usage_db: Session,
    settled_source_event,
) -> None:
    counter = _counter(
        model_usage_db,
        kind=ModelUsageCounterKind.CAPABILITY_METER,
        meter=ModelUsageMeter.INPUT_TOKENS,
    )
    counter.meter = ModelUsageMeter.GENERATED_IMAGES
    model_usage_db.flush()

    fail_closed = audit_counters_batch(model_usage_db, fail_closed=True)
    fail_open = audit_counters_batch(model_usage_db, fail_closed=False)

    assert fail_closed.healthy is False
    assert fail_open.healthy is True
    assert any("guardrail_meter_not_supported" in error for error in fail_open.errors)
