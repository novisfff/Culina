from datetime import datetime, timezone
import json
import logging

import pytest
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageIncidentCoverage,
    ModelUsageIncidentRecoveryStatus,
)
from app.models.domain import Family, User
from app.models.model_usage import (
    ModelUsageMeasurementIncident,
    ModelUsageMeasurementIncidentAttempt,
)
from app.services.model_usage.incidents import (
    IncidentAttemptCommand,
    IncidentCommand,
    flush_outage_latch,
    measurement_health,
    record_incident,
)
from app.services.model_usage.outage_latch import ModelUsageOutageLatch
from app.services.model_usage.subjects import ensure_user_subject


def aware(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def test_cross_month_unknown_gap_flushes_fragments_without_fake_counts(
    model_usage_db: Session,
) -> None:
    latch = ModelUsageOutageLatch()
    latch.open_unknown_scope(
        started_at=aware("2026-07-31T15:59:50Z"),
        source_instance="api-1",
    )
    latch.recover(at=aware("2026-07-31T16:00:10Z"))
    rows = flush_outage_latch(model_usage_db, latch)
    assert len(rows) == 2
    assert [row.period_start for row in rows] == [
        aware("2026-06-30T16:00:00Z"),
        aware("2026-07-31T16:00:00Z"),
    ]
    assert all(row.family_id is None for row in rows)
    assert model_usage_db.query(ModelUsageMeasurementIncident).count() == 2
    health = measurement_health(
        model_usage_db,
        family_id="any-family",
        period_start=aware("2026-07-31T16:00:00Z"),
        period_end=aware("2026-08-31T16:00:00Z"),
    )
    assert health.measurement_gap is True
    assert health.known_unmeasured_attempt_count == 0
    assert health.known_unmeasured_cost_cny is None


def test_latch_recovery_drain_is_idempotent() -> None:
    latch = ModelUsageOutageLatch()
    latch.open_unknown_scope(started_at=aware("2026-07-01T00:00:00Z"), source_instance="api")
    latch.recover(at=aware("2026-07-01T00:01:00Z"))
    assert len(latch.drain()) == 1
    assert latch.drain() == ()


def test_latch_category_drains_do_not_consume_each_other() -> None:
    latch = ModelUsageOutageLatch()
    latch.open_unknown_scope(started_at=aware("2026-07-01T00:00:00Z"), source_instance="api")
    latch.recover(at=aware("2026-07-01T00:01:00Z"))
    latch.record_exact_attempt(
        family_id="family-scoped",
        subject_key="mus_scoped",
        capability=ModelUsageCapability.LLM,
        client_attempt_id="mua_scoped",
        occurred_at=aware("2026-07-01T00:00:10Z"),
        source_instance="api",
    )

    assert len(latch.drain()) == 1
    assert len(latch.drain_scoped()) == 1


def test_outage_latch_keeps_fragments_when_incident_transaction_rolls_back(
    model_usage_db: Session,
) -> None:
    latch = ModelUsageOutageLatch()
    latch.open_unknown_scope(started_at=aware("2026-07-01T00:00:00Z"), source_instance="api")
    latch.recover(at=aware("2026-07-01T00:01:00Z"))

    flush_outage_latch(model_usage_db, latch)
    model_usage_db.rollback()

    assert len(latch.drain()) == 1


def test_outage_latch_does_not_ack_during_nested_commit(
    model_usage_db: Session,
) -> None:
    latch = ModelUsageOutageLatch()
    latch.open_unknown_scope(started_at=aware("2026-07-01T00:00:00Z"), source_instance="api")
    latch.recover(at=aware("2026-07-01T00:01:00Z"))

    with model_usage_db.begin():
        with model_usage_db.begin_nested():
            flush_outage_latch(model_usage_db, latch)
        assert len(latch.snapshot().fragments) == 1

    assert latch.snapshot().empty


def test_outage_latch_rollback_does_not_ack_on_a_later_commit(
    model_usage_db: Session,
) -> None:
    latch = ModelUsageOutageLatch()
    latch.open_unknown_scope(started_at=aware("2026-07-01T00:00:00Z"), source_instance="api")
    latch.recover(at=aware("2026-07-01T00:01:00Z"))

    flush_outage_latch(model_usage_db, latch)
    model_usage_db.rollback()
    model_usage_db.add(Family(id="family-later-commit", name="后续提交", motto="", location=""))
    model_usage_db.commit()

    assert len(latch.snapshot().fragments) == 1


def test_latch_logs_allowlisted_unknown_and_scoped_incident_metadata(
    caplog: pytest.LogCaptureFixture,
) -> None:
    latch = ModelUsageOutageLatch()
    caplog.set_level(
        logging.INFO,
        logger="app.services.model_usage.outage_latch",
    )

    latch.open_unknown_scope(
        started_at=aware("2026-07-01T00:00:00Z"),
        source_instance="api-privacy",
    )
    latch.record_exact_attempt(
        family_id="family-safe",
        subject_key="mus_random-subject-key",
        capability=ModelUsageCapability.LLM,
        client_attempt_id="mua_safe-attempt",
        occurred_at=aware("2026-07-01T00:00:10Z"),
        source_instance="api-privacy",
    )
    latch.recover(at=aware("2026-07-01T00:01:00Z"))

    records = [
        json.loads(record.getMessage().partition(" ")[2])
        for record in caplog.records
        if record.getMessage().startswith("model_usage_outage_latch ")
    ]
    assert [record["event"] for record in records] == [
        "unknown_scope_started",
        "exact_attempt_recorded",
        "unknown_scope_recovered",
    ]
    assert records[0] == {
        "coverage": "unknown_scope",
        "event": "unknown_scope_started",
        "source_instance": "api-privacy",
        "started_at": "2026-07-01T00:00:00+00:00",
    }
    assert records[1]["family_id"] == "family-safe"
    assert records[1]["subject_key"] == "mus_random-subject-key"
    assert records[1]["capability"] == "llm"
    serialized = json.dumps(records, ensure_ascii=False, sort_keys=True)
    assert "owner-reserve" not in serialized
    assert "user_id" not in serialized
    assert "prompt" not in serialized


def test_exact_scope_counts_only_unresolved_attempt_rows(
    model_usage_db: Session,
) -> None:
    family = Family(id="family-incident", name="计量家庭", motto="", location="")
    model_usage_db.add(family)
    model_usage_db.flush()
    period_start = aware("2026-06-30T16:00:00Z")
    period_end = aware("2026-07-31T16:00:00Z")
    incident = record_incident(
        model_usage_db,
        IncidentCommand(
            incident_key="exact-incident",
            family_id=family.id,
            subject_id=None,
            subject_key=None,
            capability=ModelUsageCapability.LLM,
            period_start=period_start,
            period_end=period_end,
            mode="monitoring_fail_open",
            cause_code="ledger_unavailable",
            started_at=aware("2026-07-01T00:00:00Z"),
            recovered_at=aware("2026-07-01T00:01:00Z"),
            coverage=ModelUsageIncidentCoverage.EXACT_SCOPE,
            source_instance="api-1",
            attempts=(
                IncidentAttemptCommand("mua_gap_1", None, ModelUsageCapability.LLM),
                IncidentAttemptCommand("mua_gap_2", None, ModelUsageCapability.LLM),
            ),
        ),
    )
    health = measurement_health(
        model_usage_db,
        family_id=family.id,
        period_start=period_start,
        period_end=period_end,
    )
    assert incident.family_id == family.id
    assert health.measurement_gap is True
    assert health.known_unmeasured_attempt_count == 2

    for attempt in model_usage_db.query(ModelUsageMeasurementIncidentAttempt):
        attempt.recovery_status = ModelUsageIncidentRecoveryStatus.RECOVERED
        attempt.resolved_at = aware("2026-07-01T00:02:00Z")
    model_usage_db.flush()

    recovered_health = measurement_health(
        model_usage_db,
        family_id=family.id,
        period_start=period_start,
        period_end=period_end,
    )
    assert recovered_health.measurement_gap is False
    assert recovered_health.known_unmeasured_attempt_count == 0


def test_unknown_scope_rejects_attempt_details(model_usage_db: Session) -> None:
    with pytest.raises(ValueError, match="unknown_scope_forbids_attempts"):
        record_incident(
            model_usage_db,
            IncidentCommand(
                incident_key="bad-unknown",
                family_id=None,
                subject_id=None,
                subject_key=None,
                capability=None,
                period_start=aware("2026-06-30T16:00:00Z"),
                period_end=aware("2026-07-31T16:00:00Z"),
                mode="monitoring_fail_open",
                cause_code="ledger_unavailable",
                started_at=aware("2026-07-01T00:00:00Z"),
                recovered_at=None,
                coverage=ModelUsageIncidentCoverage.UNKNOWN_SCOPE,
                source_instance="api-1",
                attempts=(IncidentAttemptCommand("mua_bad", None, None),),
            ),
        )


def test_scoped_incident_rejects_subject_from_another_family(
    model_usage_db: Session,
) -> None:
    first_family = Family(id="family-incident-a", name="甲家庭", motto="", location="")
    second_family = Family(id="family-incident-b", name="乙家庭", motto="", location="")
    other_user = User(
        id="user-incident-b",
        username="incident-b",
        display_name="乙用户",
        avatar_seed="乙用户",
        is_active=True,
    )
    model_usage_db.add_all([first_family, second_family, other_user])
    model_usage_db.flush()
    other_subject = ensure_user_subject(
        model_usage_db,
        family_id=second_family.id,
        user_id=other_user.id,
    )

    with pytest.raises(ValueError, match="incident_subject_family_mismatch"):
        record_incident(
            model_usage_db,
            IncidentCommand(
                incident_key="cross-family-incident",
                family_id=first_family.id,
                subject_id=other_subject.id,
                subject_key=other_subject.subject_key,
                capability=ModelUsageCapability.LLM,
                period_start=aware("2026-06-30T16:00:00Z"),
                period_end=aware("2026-07-31T16:00:00Z"),
                mode="manual",
                cause_code="operator_recorded",
                started_at=aware("2026-07-01T00:00:00Z"),
                recovered_at=None,
                coverage=ModelUsageIncidentCoverage.EXACT_SCOPE,
                source_instance="ops-cli",
            ),
        )
