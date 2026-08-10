from __future__ import annotations

from decimal import Decimal

from app.core.enums import ModelUsageReservationStatus
from app.models.model_usage import ModelUsageReservation
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.policies import (
    PolicyUpdateCommand,
    current_policy,
    update_family_policy,
)
from app.services.model_usage.subjects import ensure_user_subject
from app.services.model_usage.types import ProviderRecoveryPolicy
from tests.model_usage.test_reservation_mysql_concurrency import (
    MysqlReservationContext,
    run_barriered,
)


pytest_plugins = ("tests.model_usage.test_reservation_mysql_concurrency",)


def _reserve_one(context: MysqlReservationContext, *, attempt_key: str = "dispatch-attempt"):
    decision = context.reserve(1000, attempt_key=attempt_key, fingerprint="dispatch-fp")
    assert decision.decision == "allowed"
    assert decision.reservation_id is not None
    return decision


def _set_budget(context: MysqlReservationContext, value: Decimal) -> str:
    with context.SessionLocal() as db:
        policy = current_policy(db, family_id="family-mysql-reserve")
        subject = ensure_user_subject(
            db,
            family_id="family-mysql-reserve",
            user_id="owner-mysql-reserve",
        )
        updated = update_family_policy(
            db,
            PolicyUpdateCommand(
                family_id="family-mysql-reserve",
                base_version_number=policy.version_number,
                monthly_budget_cny=value,
                alerts_enabled=True,
                hard_limit_enabled=True,
                capability_limits=(),
                actor_subject_id=subject.id,
                active_variants=(),
            ),
        )
        db.commit()
        return updated.id


def test_policy_commit_before_dispatch_blocks_under_new_version(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    decision = _reserve_one(mysql_reservation_context)
    new_policy_id = _set_budget(mysql_reservation_context, Decimal("2"))
    with mysql_reservation_context.SessionLocal() as db:
        outcome = prepare_usage_dispatch_in_session(
            db,
            reservation_id=decision.reservation_id,
            fingerprint="dispatch-fp",
            recovery_policy=ProviderRecoveryPolicy.none(),
        )
        db.commit()
    with mysql_reservation_context.SessionLocal() as db:
        reservation = db.get(ModelUsageReservation, decision.reservation_id)
        assert reservation is not None
        assert outcome.decision == "blocked"
        assert reservation.status is ModelUsageReservationStatus.RELEASED
        assert reservation.dispatch_policy_version_id is None
        assert reservation.pre_dispatch_denial_policy_version_id == new_policy_id


def test_dispatch_commit_before_policy_update_keeps_durable_permission(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    decision = _reserve_one(mysql_reservation_context)
    with mysql_reservation_context.SessionLocal() as db:
        outcome = prepare_usage_dispatch_in_session(
            db,
            reservation_id=decision.reservation_id,
            fingerprint="dispatch-fp",
            recovery_policy=ProviderRecoveryPolicy.none(),
        )
        old_dispatch_policy_id = outcome.permit.dispatch_policy_version_id
        db.commit()
    _set_budget(mysql_reservation_context, Decimal("2"))
    with mysql_reservation_context.SessionLocal() as db:
        reservation = db.get(ModelUsageReservation, decision.reservation_id)
        assert reservation is not None
        assert outcome.decision == "allowed"
        assert reservation.status is ModelUsageReservationStatus.DISPATCHING
        assert reservation.dispatch_policy_version_id == old_dispatch_policy_id


def test_concurrent_first_dispatch_issues_one_first_send_permit(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    decision = _reserve_one(mysql_reservation_context)

    def prepare(_: int):
        with mysql_reservation_context.SessionLocal() as db:
            outcome = prepare_usage_dispatch_in_session(
                db,
                reservation_id=decision.reservation_id,
                fingerprint="dispatch-fp",
                recovery_policy=ProviderRecoveryPolicy.none(),
            )
            db.commit()
            return outcome

    results = run_barriered(50, prepare)
    assert sum(result.decision == "allowed" for result in results) == 1
    assert sum(result.decision == "recovery_required" for result in results) == 49
