from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageIncidentCoverage,
    ModelUsageIncidentRecoveryStatus,
)
from app.core.utils import create_id
from app.models.model_usage import (
    ModelUsageFamilyPolicy,
    ModelUsageMeasurementIncident,
    ModelUsageMeasurementIncidentAttempt,
    ModelUsageSubject,
)
from app.repos.model_usage.incidents import overlapping_incidents
from app.services.model_usage.outage_latch import ModelUsageOutageLatch
from app.services.model_usage.rollups import require_open_rollup_windows_for_range


@dataclass(frozen=True, slots=True)
class MeasurementHealth:
    measurement_gap: bool
    known_unmeasured_attempt_count: int
    known_unmeasured_cost_cny: Decimal | None


@dataclass(frozen=True, slots=True)
class IncidentAttemptCommand:
    client_attempt_id: str
    subject_id: str | None
    capability: ModelUsageCapability | None


@dataclass(frozen=True, slots=True)
class IncidentCommand:
    incident_key: str
    family_id: str | None
    subject_id: str | None
    subject_key: str | None
    capability: ModelUsageCapability | None
    period_start: datetime
    period_end: datetime
    mode: str
    cause_code: str
    started_at: datetime
    recovered_at: datetime | None
    coverage: ModelUsageIncidentCoverage
    source_instance: str
    attempts: tuple[IncidentAttemptCommand, ...] = ()


def _validate_scoped_incident_subjects(db: Session, command: IncidentCommand) -> None:
    if command.family_id is None:
        return
    if (command.subject_id is None) != (command.subject_key is None):
        raise ValueError("incident_subject_identity_incomplete")
    if command.subject_id is not None:
        subject = db.scalar(
            select(ModelUsageSubject).where(
                ModelUsageSubject.id == command.subject_id,
                ModelUsageSubject.family_id == command.family_id,
            )
        )
        if subject is None or subject.subject_key != command.subject_key:
            raise ValueError("incident_subject_family_mismatch")
    for attempt in command.attempts:
        if attempt.subject_id is None:
            continue
        subject = db.scalar(
            select(ModelUsageSubject).where(
                ModelUsageSubject.id == attempt.subject_id,
                ModelUsageSubject.family_id == command.family_id,
            )
        )
        if subject is None:
            raise ValueError("incident_attempt_subject_family_mismatch")


def _lock_incident_family_window(db: Session, command: IncidentCommand) -> None:
    if command.family_id is None:
        return
    # Legacy/bootstrap fixtures may not have a model-usage pointer yet.  When
    # one exists, take it before the rollup rows to match receipt settlement
    # and retention's lock order.
    db.scalar(
        select(ModelUsageFamilyPolicy)
        .where(ModelUsageFamilyPolicy.family_id == command.family_id)
        .with_for_update()
    )
    require_open_rollup_windows_for_range(
        db,
        family_id=command.family_id,
        period_start=command.period_start,
        period_end=command.period_end,
    )


def record_incident(
    db: Session,
    command: IncidentCommand,
) -> ModelUsageMeasurementIncident:
    if command.coverage is ModelUsageIncidentCoverage.UNKNOWN_SCOPE:
        if command.family_id is not None:
            raise ValueError("unknown_scope_forbids_family")
        if command.attempts:
            raise ValueError("unknown_scope_forbids_attempts")
    elif command.family_id is None:
        raise ValueError("scoped_incident_requires_family")
    if command.period_end <= command.period_start:
        raise ValueError("incident_period_invalid")
    _validate_scoped_incident_subjects(db, command)
    existing = db.scalar(
        select(ModelUsageMeasurementIncident).where(
            ModelUsageMeasurementIncident.incident_key == command.incident_key
        )
    )
    if existing is not None:
        if (
            existing.family_id != command.family_id
            or existing.coverage is not command.coverage
            or existing.started_at != command.started_at
        ):
            raise ValueError("incident_key_conflict")
        return existing
    _lock_incident_family_window(db, command)
    incident = ModelUsageMeasurementIncident(
        id=create_id("usage-incident"),
        incident_key=command.incident_key,
        family_id=command.family_id,
        subject_id=command.subject_id,
        subject_key=command.subject_key,
        capability=command.capability,
        period_start=command.period_start,
        period_end=command.period_end,
        mode=command.mode,
        cause_code=command.cause_code,
        started_at=command.started_at,
        recovered_at=command.recovered_at,
        coverage=command.coverage,
        source_instance=command.source_instance,
    )
    db.add(incident)
    db.flush()
    assert command.family_id is not None or not command.attempts
    db.add_all(
        [
            ModelUsageMeasurementIncidentAttempt(
                id=create_id("usage-gap-attempt"),
                incident_id=incident.id,
                family_id=command.family_id,
                subject_id=attempt.subject_id,
                capability=attempt.capability,
                client_attempt_id=attempt.client_attempt_id,
                recovery_status=ModelUsageIncidentRecoveryStatus.UNRESOLVED,
                recovered_event_id=None,
                resolved_at=None,
            )
            for attempt in command.attempts
        ]
    )
    db.flush()
    return incident


def flush_outage_latch(
    db: Session,
    latch: ModelUsageOutageLatch,
) -> tuple[ModelUsageMeasurementIncident, ...]:
    batch = latch.snapshot()
    rows: list[ModelUsageMeasurementIncident] = []
    for fragment in batch.fragments:
        existing = db.scalar(
            select(ModelUsageMeasurementIncident).where(
                ModelUsageMeasurementIncident.incident_key == fragment.incident_key
            )
        )
        if existing is not None:
            rows.append(existing)
            continue
        incident = ModelUsageMeasurementIncident(
            id=create_id("usage-incident"),
            incident_key=fragment.incident_key,
            family_id=None,
            subject_id=None,
            subject_key=None,
            capability=None,
            period_start=fragment.period.start_at,
            period_end=fragment.period.end_at,
            mode="monitoring_fail_open",
            cause_code="model_usage_ledger_unavailable",
            started_at=fragment.started_at,
            recovered_at=fragment.recovered_at,
            coverage=ModelUsageIncidentCoverage.UNKNOWN_SCOPE,
            source_instance=fragment.source_instance,
        )
        db.add(incident)
        rows.append(incident)
    for attempt in batch.scoped_attempts:
        subject = db.scalar(
            select(ModelUsageSubject).where(
                ModelUsageSubject.family_id == attempt.family_id,
                ModelUsageSubject.subject_key == attempt.subject_key,
            )
        )
        if subject is None:
            raise ValueError("scoped_incident_subject_missing")
        rows.append(
            record_incident(
                db,
                IncidentCommand(
                    incident_key=attempt.incident_key,
                    family_id=attempt.family_id,
                    subject_id=subject.id,
                    subject_key=subject.subject_key,
                    capability=attempt.capability,
                    period_start=attempt.period.start_at,
                    period_end=attempt.period.end_at,
                    mode="monitoring_fail_open",
                    cause_code="model_usage_ledger_unavailable",
                    started_at=attempt.occurred_at,
                    recovered_at=None,
                    coverage=ModelUsageIncidentCoverage.EXACT_SCOPE,
                    source_instance=attempt.source_instance,
                    attempts=(
                        IncidentAttemptCommand(
                            client_attempt_id=attempt.client_attempt_id,
                            subject_id=subject.id,
                            capability=attempt.capability,
                        ),
                    ),
                ),
            )
        )
    db.flush()
    if not batch.empty:
        # `after_commit` also fires for SAVEPOINT commits.  Bind this batch to
        # the transaction that wrote it and only acknowledge after every
        # relevant transaction layer has committed.  The callbacks intentionally
        # stay attached to this Session instance after completion: a Session is
        # request/operation scoped, and retaining the closure avoids mutating an
        # event listener collection while SQLAlchemy is iterating it.
        outer_transaction = db.get_transaction()
        write_transaction = db.get_nested_transaction() or outer_transaction
        assert outer_transaction is not None and write_transaction is not None
        state = {"write_committed": write_transaction is outer_transaction, "discarded": False}

        def _after_commit(session: Session) -> None:
            nested = session.get_nested_transaction()
            if write_transaction is not outer_transaction and nested is write_transaction:
                state["write_committed"] = True
                return
            if (
                nested is None
                and session.get_transaction() is outer_transaction
                and state["write_committed"]
                and not state["discarded"]
            ):
                latch.acknowledge(batch)
                state["discarded"] = True

        def _after_rollback(session: Session) -> None:
            nested = session.get_nested_transaction()
            if (
                (write_transaction is not outer_transaction and nested is write_transaction)
                or (nested is None and session.get_transaction() is outer_transaction)
            ):
                state["discarded"] = True

        event.listen(db, "after_commit", _after_commit)
        event.listen(db, "after_rollback", _after_rollback)
    return tuple(rows)


def measurement_health(
    db: Session,
    *,
    family_id: str,
    period_start: datetime,
    period_end: datetime,
) -> MeasurementHealth:
    incidents = overlapping_incidents(
        db,
        family_id=family_id,
        period_start=period_start,
        period_end=period_end,
    )
    exact_ids = [
        incident.id
        for incident in incidents
        if incident.family_id == family_id
        and incident.coverage
        in {ModelUsageIncidentCoverage.EXACT_SCOPE, ModelUsageIncidentCoverage.PARTIAL_SCOPE}
    ]
    count = 0
    if exact_ids:
        count = int(
            db.scalar(
                select(func.count())
                .select_from(ModelUsageMeasurementIncidentAttempt)
                .where(
                    ModelUsageMeasurementIncidentAttempt.incident_id.in_(exact_ids),
                    ModelUsageMeasurementIncidentAttempt.recovery_status
                    == ModelUsageIncidentRecoveryStatus.UNRESOLVED,
                )
            )
            or 0
        )
    has_irreducible_gap = any(
        incident.coverage
        in {
            ModelUsageIncidentCoverage.UNKNOWN_SCOPE,
            ModelUsageIncidentCoverage.PARTIAL_SCOPE,
        }
        for incident in incidents
    )
    return MeasurementHealth(
        measurement_gap=has_irreducible_gap or count > 0,
        known_unmeasured_attempt_count=count,
        known_unmeasured_cost_cny=None,
    )
