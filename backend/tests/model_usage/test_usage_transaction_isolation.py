from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageReservationStatus,
)
from app.models.domain import Family, User
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
)
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.settlement import settle_usage_in_session
from app.services.model_usage.types import (
    ProviderRecoveryPolicy,
    ProviderUsageReceipt,
    UsageMeterQuantity,
)
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


def test_provider_settlement_survives_caller_business_rollback(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    decision = _reserve_one(mysql_reservation_context, attempt_key="settlement-isolation")
    assert decision.reservation_id is not None
    business_db: Session = mysql_reservation_context.SessionLocal()
    try:
        # Keep a flushed caller-side write open on an entity that the usage
        # settlement does not reference.  Updating the family itself would
        # intentionally block the event insert: MySQL must acquire a shared
        # foreign-key lock on `families` for that insert.
        user = business_db.get(User, "owner-mysql-reserve")
        assert user is not None
        user.display_name = "不应提交的结算业务名称"
        business_db.flush()

        with mysql_reservation_context.SessionLocal() as usage_db:
            dispatch = prepare_usage_dispatch_in_session(
                usage_db,
                reservation_id=decision.reservation_id,
                fingerprint="dispatch-fp",
                recovery_policy=ProviderRecoveryPolicy.none(),
            )
            usage_db.commit()
        permit = dispatch.permit
        assert permit is not None
        signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
        receipt = signer.sign(
            ProviderUsageReceipt(
                reservation_id=permit.reservation_id,
                family_id=permit.family_id,
                subject_key=permit.subject_key,
                capability=permit.capability,
                provider=permit.provider,
                requested_model=permit.requested_model,
                reported_model=permit.billing_model,
                billing_model=permit.billing_model,
                variant_key=permit.variant_key,
                billing_scheme_key=permit.billing_scheme_key,
                attempt_key=permit.attempt_key,
                fingerprint=permit.fingerprint,
                client_attempt_id=permit.client_attempt_id,
                policy_version_id=permit.policy_version_id,
                dispatch_policy_version_id=permit.dispatch_policy_version_id,
                provider_request_id="provider-settlement-isolation",
                provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
                execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
                measurement_status=ModelUsageMeasurementStatus.EXACT,
                pricing_status=ModelUsagePricingStatus.PRICED,
                period=permit.period,
                meters=(
                    UsageMeterQuantity(
                        meter=ModelUsageMeter.OUTPUT_TOKENS,
                        quantity=Decimal("1"),
                        meter_role=ModelUsageMeterRole.BILLABLE,
                        quantity_source=ModelUsageQuantitySource.PROVIDER,
                    ),
                ),
                meter_watermarks=(),
                dispatched_at=permit.dispatched_at,
                completed_at=permit.dispatched_at + timedelta(minutes=1),
                price_version_id=permit.price_version_id,
                price_snapshot=permit.price_snapshot,
                price_snapshot_checksum=permit.price_snapshot_checksum,
                fail_open_proof_id=None,
                integrity_key_id="",
                integrity_hmac="",
            )
        )
        with mysql_reservation_context.SessionLocal() as usage_db:
            settlement = settle_usage_in_session(usage_db, receipt, signer=signer)
            usage_db.commit()

        business_db.rollback()
    finally:
        business_db.close()

    with mysql_reservation_context.SessionLocal() as db:
        user = db.get(User, "owner-mysql-reserve")
        reservation = db.get(ModelUsageReservation, decision.reservation_id)
        event = db.get(ModelUsageEvent, settlement.event_id)
        counters = tuple(
            db.scalars(
                select(ModelUsagePeriodCounter).where(
                    ModelUsagePeriodCounter.family_id == "family-mysql-reserve"
                )
            )
        )

        assert user is not None and user.display_name == "Owner"
        assert reservation is not None
        assert reservation.status is ModelUsageReservationStatus.SETTLED
        assert event is not None and event.reservation_id == reservation.id
        assert all(counter.reserved_value == 0 for counter in counters)
