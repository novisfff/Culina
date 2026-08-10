from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
)
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
)
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.recovery import (
    RecoveryAdjustmentRequired,
    mark_dispatch_uncertain,
    reconcile_uncertain_in_session,
    settle_expired_uncertain_in_session,
)
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.settlement import settle_usage_in_session
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderRecoveryPolicy,
    ProviderUsageReceipt,
    UsageContext,
    UsageMeterQuantity,
)
from tests.model_usage.test_reservations import NOW


pytest_plugins = ("tests.model_usage.test_reservations",)


def _reserve(
    db: Session,
    context: UsageContext,
    *,
    fingerprint: str,
) -> ModelUsageReservation:
    decision = reserve_usage_in_session(
        db,
        context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint=fingerprint,
        at=NOW,
    )
    reservation = db.get(ModelUsageReservation, decision.reservation_id)
    assert decision.decision == "allowed" and reservation is not None
    return reservation


def _dispatch(
    db: Session,
    reservation: ModelUsageReservation,
    *,
    fingerprint: str,
) -> DispatchPermit:
    outcome = prepare_usage_dispatch_in_session(
        db,
        reservation_id=reservation.id,
        fingerprint=fingerprint,
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    assert outcome.decision == "allowed" and outcome.permit is not None
    return outcome.permit


def _signed_exact_receipt(
    permit: DispatchPermit,
    signer: ProviderUsageReceiptSigner,
) -> ProviderUsageReceipt:
    return signer.sign(
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
            provider_request_id="provider-crash-window",
            provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            pricing_status=permit.pricing_status,
            period=permit.period,
            meters=(
                UsageMeterQuantity(
                    ModelUsageMeter.INPUT_TOKENS,
                    Decimal("10"),
                    ModelUsageMeterRole.INFORMATIONAL,
                    ModelUsageQuantitySource.PROVIDER,
                ),
                UsageMeterQuantity(
                    ModelUsageMeter.CACHED_INPUT_TOKENS,
                    Decimal("0"),
                    ModelUsageMeterRole.BILLABLE,
                    ModelUsageQuantitySource.PROVIDER,
                ),
                UsageMeterQuantity(
                    ModelUsageMeter.OUTPUT_TOKENS,
                    Decimal("10"),
                    ModelUsageMeterRole.BILLABLE,
                    ModelUsageQuantitySource.PROVIDER,
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


def _assert_non_negative_counters(db: Session) -> None:
    assert all(
        row.reserved_value >= 0
        and row.settled_value >= 0
        and row.adjustment_value >= 0
        for row in db.query(ModelUsagePeriodCounter)
    )


def test_crash_after_reserve_replays_one_reserved_attempt(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    reservation = _reserve(model_usage_db, reservation_context, fingerprint="fp-after-reserve")

    replay = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-after-reserve",
        at=NOW,
    )

    assert replay.reservation_id == reservation.id
    assert reservation.status is ModelUsageReservationStatus.RESERVED
    assert model_usage_db.query(ModelUsageReservation).count() == 1
    assert model_usage_db.query(ModelUsageEvent).count() == 0
    _assert_non_negative_counters(model_usage_db)


def test_crash_after_dispatch_commit_requires_recovery_not_a_second_send(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    reservation = _reserve(model_usage_db, reservation_context, fingerprint="fp-after-dispatch")
    _dispatch(model_usage_db, reservation, fingerprint="fp-after-dispatch")

    replay = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        fingerprint="fp-after-dispatch",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )

    assert replay.decision == "recovery_required"
    assert replay.permit is None
    assert reservation.status is ModelUsageReservationStatus.DISPATCHING
    assert model_usage_db.query(ModelUsageEvent).count() == 0
    _assert_non_negative_counters(model_usage_db)


def test_ambiguous_provider_send_conservatively_settles_one_event_after_24_hours(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    reservation = _reserve(model_usage_db, reservation_context, fingerprint="fp-ambiguous-send")
    _dispatch(model_usage_db, reservation, fingerprint="fp-ambiguous-send")
    mark_dispatch_uncertain(model_usage_db, reservation_id=reservation.id)
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})

    first = settle_expired_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=reservation.dispatching_at + timedelta(hours=24),
        signer=signer,
    )
    replay = settle_expired_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=reservation.dispatching_at + timedelta(hours=25),
        signer=signer,
    )

    assert first is not None and replay is not None
    assert replay.event_id == first.event_id
    event = model_usage_db.get(ModelUsageEvent, first.event_id)
    assert event is not None
    assert event.measurement_status is ModelUsageMeasurementStatus.ESTIMATED
    assert event.estimation_reason == "provider_execution_unresolved_after_24h"
    assert reservation.status is ModelUsageReservationStatus.SETTLED
    assert model_usage_db.query(ModelUsageEvent).count() == 1
    _assert_non_negative_counters(model_usage_db)


def test_provider_success_before_settlement_replays_the_same_exact_event(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    reservation = _reserve(model_usage_db, reservation_context, fingerprint="fp-provider-success")
    permit = _dispatch(model_usage_db, reservation, fingerprint="fp-provider-success")
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    receipt = _signed_exact_receipt(permit, signer)

    first = settle_usage_in_session(model_usage_db, receipt, signer=signer)
    replay = settle_usage_in_session(model_usage_db, receipt, signer=signer)

    assert replay.event_id == first.event_id
    event = model_usage_db.get(ModelUsageEvent, first.event_id)
    assert event is not None
    assert event.measurement_status is ModelUsageMeasurementStatus.EXACT
    assert reservation.status is ModelUsageReservationStatus.SETTLED
    assert model_usage_db.query(ModelUsageEvent).count() == 1
    _assert_non_negative_counters(model_usage_db)


def test_lost_receipt_with_late_exact_evidence_requires_adjustment(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    reservation = _reserve(model_usage_db, reservation_context, fingerprint="fp-lost-receipt")
    permit = _dispatch(model_usage_db, reservation, fingerprint="fp-lost-receipt")
    mark_dispatch_uncertain(model_usage_db, reservation_id=reservation.id)
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    conservative = settle_expired_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=reservation.dispatching_at + timedelta(hours=24),
        signer=signer,
    )
    assert conservative is not None
    reservation.recovery_mode = ModelUsageRecoveryMode.QUERYABLE_REQUEST
    reservation.query_window_seconds = 48 * 60 * 60
    model_usage_db.flush()

    class LateEvidenceHandler:
        def query_original_attempt(self, *, client_attempt_id: str) -> ProviderUsageReceipt:
            assert client_attempt_id == permit.client_attempt_id
            return _signed_exact_receipt(permit, signer)

    result = reconcile_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=reservation.dispatching_at + timedelta(hours=25),
        signer=signer,
        handler=LateEvidenceHandler(),
    )

    assert isinstance(result, RecoveryAdjustmentRequired)
    assert result.source_event_id == conservative.event_id
    assert model_usage_db.query(ModelUsageEvent).count() == 1
    _assert_non_negative_counters(model_usage_db)
