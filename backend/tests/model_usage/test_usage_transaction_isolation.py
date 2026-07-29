from sqlalchemy.orm import Session

from app.core.enums import ModelUsageReservationStatus
from app.models.domain import Family
from app.models.model_usage import ModelUsageReservation
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.types import ProviderRecoveryPolicy
from tests.model_usage.test_dispatch_policy_mysql_concurrency import _reserve_one
from tests.model_usage.test_reservation_mysql_concurrency import MysqlReservationContext


pytest_plugins = ("tests.model_usage.test_reservation_mysql_concurrency",)


def test_usage_commit_does_not_commit_caller_business_transaction(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    decision = _reserve_one(mysql_reservation_context)
    business_db: Session = mysql_reservation_context.SessionLocal()
    try:
        family = business_db.get(Family, "family-mysql-reserve")
        assert family is not None
        family.name = "不应提交的名称"
        business_db.flush()
        with mysql_reservation_context.SessionLocal() as usage_db:
            outcome = prepare_usage_dispatch_in_session(
                usage_db,
                reservation_id=decision.reservation_id,
                fingerprint="dispatch-fp",
                recovery_policy=ProviderRecoveryPolicy.none(),
            )
            usage_db.commit()
        business_db.rollback()
    finally:
        business_db.close()
    with mysql_reservation_context.SessionLocal() as db:
        family = db.get(Family, "family-mysql-reserve")
        reservation = db.get(ModelUsageReservation, decision.reservation_id)
        assert family is not None and family.name == "并发家庭"
        assert reservation is not None
        assert reservation.status is ModelUsageReservationStatus.DISPATCHING
        assert outcome.decision == "allowed"
