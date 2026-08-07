from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

from app.core.enums import (
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageReservationStatus,
)
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
    ModelUsageSubject,
)
from app.services.model_usage.errors import ModelUsageAttemptConflict
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.policies import (
    PolicyUpdateCommand,
    current_policy,
    update_family_policy,
)
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.recovery import recover_fail_open_receipt_in_session
from app.services.model_usage.types import ProviderUsageReceipt, UsageMeterQuantity
from tests.model_usage.test_reservation_mysql_concurrency import (
    NOW,
    MysqlReservationContext,
    run_barriered,
)


pytest_plugins = ("tests.model_usage.test_reservation_mysql_concurrency",)


def _receipt(context: MysqlReservationContext):
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    with context.SessionLocal() as db:
        policy = current_policy(db, family_id="family-mysql-reserve")
        subject = db.query(ModelUsageSubject).filter_by(
            family_id="family-mysql-reserve",
            user_id="owner-mysql-reserve",
        ).one()
        monitoring = update_family_policy(
            db,
            PolicyUpdateCommand(
                family_id="family-mysql-reserve",
                base_version_number=policy.version_number,
                monthly_budget_cny=Decimal("100"),
                alerts_enabled=True,
                hard_limit_enabled=False,
                capability_limits=(),
                actor_subject_id=subject.id,
                active_variants=(),
            ),
        )
        db.commit()
        receipt = ProviderUsageReceipt(
            reservation_id=None,
            family_id="family-mysql-reserve",
            subject_key=subject.subject_key,
            capability=context.base_context.capability,
            provider=context.base_context.provider,
            requested_model=context.base_context.requested_model,
            reported_model=context.base_context.billing_model,
            billing_model=context.base_context.billing_model,
            variant_key=context.base_context.variant_key,
            billing_scheme_key="test-cost-v1",
            attempt_key="fail-open-attempt",
            fingerprint="fail-open-fp",
            client_attempt_id="mua_fail_open",
            policy_version_id=monitoring.id,
            dispatch_policy_version_id=monitoring.id,
            provider_request_id="provider-request",
            provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            pricing_status=ModelUsagePricingStatus.UNPRICED,
            period=shanghai_billing_period(NOW),
            meters=(
                UsageMeterQuantity(
                    ModelUsageMeter.OUTPUT_TOKENS,
                    Decimal("1"),
                    ModelUsageMeterRole.BILLABLE,
                    ModelUsageQuantitySource.PROVIDER,
                ),
            ),
            meter_watermarks=(),
            dispatched_at=NOW,
            completed_at=datetime(2026, 7, 30, 3, 1, tzinfo=timezone.utc),
            price_version_id=None,
            price_snapshot=None,
            price_snapshot_checksum=None,
            fail_open_proof_id="proof-fail-open",
            integrity_key_id="",
            integrity_hmac="",
            required_meters=(
                UsageMeterQuantity(
                    ModelUsageMeter.OUTPUT_TOKENS,
                    Decimal("1"),
                    ModelUsageMeterRole.BILLABLE,
                    ModelUsageQuantitySource.ESTIMATED,
                ),
            ),
        )
    return signer, signer.sign(receipt)


def test_concurrent_fail_open_receipt_recovery_claims_one_event(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    signer, receipt = _receipt(mysql_reservation_context)

    def recover(_: int):
        with mysql_reservation_context.SessionLocal() as db:
            result = recover_fail_open_receipt_in_session(db, receipt, signer=signer)
            db.commit()
            return result

    results = run_barriered(50, recover)
    assert len({result.event_id for result in results}) == 1
    with mysql_reservation_context.SessionLocal() as db:
        assert db.query(ModelUsageEvent).filter_by(attempt_key=receipt.attempt_key).count() == 1
        assert (
            db.query(ModelUsagePeriodCounter)
            .filter_by(
                counter_kind=ModelUsageCounterKind.CAPABILITY_METER,
                meter=ModelUsageMeter.OUTPUT_TOKENS,
            )
            .one()
            .settled_value
            == Decimal("1")
        )


def test_retry_reserve_and_fail_open_recovery_share_attempt_namespace(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    signer, receipt = _receipt(mysql_reservation_context)

    def compete(index: int):
        if index == 0:
            return (
                "reserve",
                mysql_reservation_context.reserve(
                    77,
                    attempt_key=receipt.attempt_key,
                    fingerprint=receipt.fingerprint,
                ),
            )
        with mysql_reservation_context.SessionLocal() as db:
            recovered = recover_fail_open_receipt_in_session(db, receipt, signer=signer)
            db.commit()
            return "recover", recovered

    results = dict(run_barriered(2, compete))
    reserve = results["reserve"]
    recovered = results["recover"]
    replay = mysql_reservation_context.reserve(
        78,
        attempt_key=receipt.attempt_key,
        fingerprint=receipt.fingerprint,
    )
    assert reserve.decision in {"allowed", "already_accounted"}
    assert replay.decision == "already_accounted"
    assert replay.existing_event_id == recovered.event_id
    with mysql_reservation_context.SessionLocal() as db:
        assert db.query(ModelUsageEvent).filter_by(attempt_key=receipt.attempt_key).count() == 1
        reservations = (
            db.query(ModelUsageReservation)
            .filter_by(attempt_key=receipt.attempt_key)
            .all()
        )
        assert all(
            reservation.status is ModelUsageReservationStatus.SETTLED
            for reservation in reservations
        )
        assert all(
            row.reserved_value == 0
            for row in db.query(ModelUsagePeriodCounter).all()
        )
        meter_counter = (
            db.query(ModelUsagePeriodCounter)
            .filter_by(
                counter_kind=ModelUsageCounterKind.CAPABILITY_METER,
                meter=ModelUsageMeter.OUTPUT_TOKENS,
            )
            .one()
        )
        assert meter_counter.settled_value == Decimal("1")


def test_different_fingerprint_conflicts_with_recovered_event(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    signer, receipt = _receipt(mysql_reservation_context)
    with mysql_reservation_context.SessionLocal() as db:
        recover_fail_open_receipt_in_session(db, receipt, signer=signer)
        db.commit()
    conflicting = signer.sign(replace(receipt, fingerprint="other-fingerprint", integrity_hmac=""))
    with mysql_reservation_context.SessionLocal() as db:
        try:
            recover_fail_open_receipt_in_session(db, conflicting, signer=signer)
        except ModelUsageAttemptConflict as exc:
            assert exc.code == "model_usage_attempt_conflict"
        else:
            raise AssertionError("different fingerprint must conflict")
