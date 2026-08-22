from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageReservationStatus
from app.core.enums import ModelUsageRecoveryMode
from app.models.model_usage import ModelUsagePeriodCounter, ModelUsageReservation
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.types import ProviderRecoveryPolicy, UsageContext
from app.services.model_usage.errors import ModelUsageContractError
from tests.model_usage.test_reservations import NOW, reservation_context, set_policy


def test_first_dispatch_persists_intent_and_replay_requires_recovery(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-dispatch",
        at=NOW,
    )
    first = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-dispatch",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    replay = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-dispatch",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert first.decision == "allowed"
    assert first.permit is not None and first.permit.send_kind == "first_send"
    assert replay.decision == "recovery_required"
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.DISPATCHING
    assert reservation.dispatch_policy_version_id is not None


def test_monitoring_dispatch_skips_counter_and_limit_queries(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-monitoring-fast-path",
        at=NOW,
    )
    statements: list[str] = []
    engine = model_usage_db.get_bind()

    def capture_statement(_conn, _cursor, statement, _parameters, _context, _executemany) -> None:
        statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", capture_statement)
    try:
        outcome = prepare_usage_dispatch_in_session(
            model_usage_db,
            reservation_id=decision.reservation_id or "",
            fingerprint="fp-monitoring-fast-path",
            recovery_policy=ProviderRecoveryPolicy.none(),
        )
    finally:
        event.remove(engine, "before_cursor_execute", capture_statement)

    assert outcome.decision == "allowed"
    assert not any("model_usage_period_counters" in statement for statement in statements)
    assert not any("model_usage_capability_limits" in statement for statement in statements)


def test_new_hard_limit_releases_old_unpriced_reservation_before_send(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-block",
        at=NOW,
    )
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
    )
    outcome = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-block",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    counters = model_usage_db.query(ModelUsagePeriodCounter).all()
    assert outcome.decision == "blocked"
    assert outcome.error_code == "model_usage_price_unavailable"
    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.RELEASED
    assert reservation.dispatch_policy_version_id is None
    assert reservation.pre_dispatch_denial_policy_version_id is not None
    assert all(counter.reserved_value == 0 for counter in counters)


def test_caller_cannot_upgrade_current_none_recovery_contract(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-untrusted-recovery",
        at=NOW,
    )
    with pytest.raises(ModelUsageContractError, match="untrusted_recovery_policy"):
        prepare_usage_dispatch_in_session(
            model_usage_db,
            reservation_id=decision.reservation_id or "",
            fingerprint="fp-untrusted-recovery",
            recovery_policy=ProviderRecoveryPolicy(
                mode=ModelUsageRecoveryMode.IDEMPOTENCY_KEY,
                idempotency_window_seconds=3600,
                query_window_seconds=None,
                automatic_resend_deadline_seconds=60,
            ),
        )
