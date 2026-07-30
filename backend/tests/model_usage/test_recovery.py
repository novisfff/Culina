from __future__ import annotations

import json
import logging
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageIncidentCoverage,
    ModelUsageIncidentRecoveryStatus,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageProviderOutcome,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
)
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageMeasurementIncidentAttempt,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
    ModelUsageSubject,
)
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.receipts import (
    ProviderUsageReceiptSigner,
    provider_usage_receipt_from_log_payload,
    receipt_log_payload,
)
from app.services.model_usage.recovery import (
    can_query,
    mark_dispatch_uncertain,
    prepare_idempotent_resend_in_session,
    settle_expired_uncertain_in_session,
    recover_fail_open_receipt_in_session,
    reconcile_uncertain_in_session,
)
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.facade import (
    FailOpenPermitRegistry,
    consume_fail_open_dispatch_permit,
    exchange_proof_for_permit,
    prove_monitoring_dispatch_eligibility,
)
from app.services.model_usage.incidents import (
    IncidentAttemptCommand,
    IncidentCommand,
    record_incident,
)
from app.services.model_usage.errors import ModelUsageReceiptIntegrityError
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderRecoveryPolicy,
    ProviderUsageReceipt,
    UsageContext,
)
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW


pytest_plugins = ("tests.model_usage.test_reservations",)


def _fail_open_artifacts(
    db: Session,
    context: UsageContext,
    *,
    at: datetime = NOW,
    include_price_snapshot: bool = False,
) -> tuple[ProviderUsageReceiptSigner, DispatchPermit, ProviderUsageReceipt]:
    estimate = estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10)
    proof = prove_monitoring_dispatch_eligibility(
        db,
        context=context,
        estimate=estimate,
        fingerprint="fp-fail-open-recovery",
        at=at,
    )
    registry = FailOpenPermitRegistry()
    permit = exchange_proof_for_permit(
        proof,
        registry=registry,
        at=at,
    )
    consume_fail_open_dispatch_permit(permit, registry=registry, at=at)
    signer = ProviderUsageReceiptSigner(
        active_key_id="retained-key",
        keys={"retained-key": b"retained-secret"},
    )
    receipt = signer.sign(
        ProviderUsageReceipt(
            reservation_id=None,
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
            provider_request_id="provider-request-fail-open",
            provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            pricing_status=permit.pricing_status,
            period=permit.period,
            meters=estimate.meters,
            meter_watermarks=(),
            dispatched_at=permit.dispatched_at,
            completed_at=at + timedelta(minutes=1),
            price_version_id=permit.price_version_id,
            price_snapshot=permit.price_snapshot if include_price_snapshot else None,
            price_snapshot_checksum=permit.price_snapshot_checksum,
            fail_open_proof_id=permit.fail_open_proof_id,
            integrity_key_id="",
            integrity_hmac="",
        )
    )
    return signer, permit, receipt


def _signed_fail_open_receipt(
    db: Session,
    context: UsageContext,
    *,
    at: datetime = NOW,
    include_price_snapshot: bool = False,
) -> tuple[ProviderUsageReceiptSigner, ProviderUsageReceipt]:
    signer, _, receipt = _fail_open_artifacts(
        db,
        context,
        at=at,
        include_price_snapshot=include_price_snapshot,
    )
    return signer, receipt


def test_none_mode_never_queries_or_resends(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-none",
        at=NOW,
    )
    prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-none",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None
    assert can_query(reservation, at=NOW + timedelta(minutes=1)) is False
    assert prepare_idempotent_resend_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        fingerprint="fp-none",
        at=NOW + timedelta(minutes=1),
    ) is None

    class ForbiddenHandler:
        def query_original_attempt(self, *, client_attempt_id: str):
            raise AssertionError("none mode must not query provider")

    assert reconcile_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=NOW + timedelta(minutes=1),
        signer=ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"}),
        handler=ForbiddenHandler(),
    ) is None


def test_persisted_idempotency_contract_allows_only_original_key_inside_window(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-idempotent",
        at=NOW,
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None
    reservation.status = ModelUsageReservationStatus.DISPATCHING
    reservation.dispatch_policy_version_id = reservation.policy_version_id
    reservation.dispatching_at = NOW
    reservation.recovery_mode = ModelUsageRecoveryMode.IDEMPOTENCY_KEY
    reservation.idempotency_window_seconds = 3600
    reservation.provider_idempotency_key = reservation.client_attempt_id
    reservation.automatic_resend_deadline_at = NOW + timedelta(minutes=5)
    model_usage_db.flush()
    permit = prepare_idempotent_resend_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        fingerprint="fp-idempotent",
        at=NOW + timedelta(minutes=1),
    )
    assert permit is not None
    assert permit.send_kind == "idempotent_resend"
    assert permit.provider_idempotency_key == reservation.client_attempt_id
    assert prepare_idempotent_resend_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        fingerprint="fp-idempotent",
        at=NOW + timedelta(minutes=6),
    ) is None


def test_queryable_mode_only_queries_original_client_attempt(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-query",
        at=NOW,
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None
    reservation.status = ModelUsageReservationStatus.UNCERTAIN
    reservation.dispatch_policy_version_id = reservation.policy_version_id
    reservation.dispatching_at = NOW
    reservation.recovery_mode = ModelUsageRecoveryMode.QUERYABLE_REQUEST
    reservation.query_window_seconds = 3600
    model_usage_db.flush()

    class QueryHandler:
        called_with: str | None = None

        def query_original_attempt(self, *, client_attempt_id: str):
            self.called_with = client_attempt_id
            return None

    handler = QueryHandler()
    result = reconcile_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=NOW + timedelta(minutes=1),
        signer=ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"}),
        handler=handler,
    )
    assert result is None
    assert handler.called_with == reservation.client_attempt_id


def test_uncertain_after_24_hours_settles_one_conservative_event(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-uncertain",
        at=NOW,
    )
    prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-uncertain",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None
    mark_dispatch_uncertain(model_usage_db, reservation_id=reservation.id)
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    settlement = settle_expired_uncertain_in_session(
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
    assert settlement is not None and replay is not None
    assert settlement.event_id == replay.event_id
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.estimation_reason == "provider_execution_unresolved_after_24h"
    assert model_usage_db.query(ModelUsageEvent).count() == 1


def test_signed_fail_open_receipt_recovers_without_process_registry_or_reservation(
    model_usage_db: Session,
    reservation_context: UsageContext,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        logging.getLogger("app.services.model_usage.recovery"),
        "disabled",
        False,
    )
    caplog.set_level(
        logging.INFO,
        logger="app.services.model_usage.recovery",
    )
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    logged = json.loads(json.dumps(receipt_log_payload(receipt)))
    restarted_receipt = provider_usage_receipt_from_log_payload(logged)
    recovered = recover_fail_open_receipt_in_session(
        model_usage_db, restarted_receipt, signer=signer
    )
    replay = recover_fail_open_receipt_in_session(
        model_usage_db, restarted_receipt, signer=signer
    )
    assert recovered.event_id == replay.event_id
    event = model_usage_db.get(ModelUsageEvent, recovered.event_id)
    assert event is not None
    assert event.reservation_id is None
    assert event.pricing_status.value == "unpriced"
    recovery_logs = [
        json.loads(record.getMessage().partition(" ")[2])
        for record in caplog.records
        if record.getMessage().startswith("model_usage_recovery ")
    ]
    assert len(recovery_logs) == 1
    assert recovery_logs[0]["event"] == "fail_open_receipt_recovered"
    assert recovery_logs[0]["family_id"] == receipt.family_id
    assert recovery_logs[0]["subject_key"] == receipt.subject_key
    serialized = json.dumps(recovery_logs, ensure_ascii=False, sort_keys=True)
    assert "user_id" not in serialized
    assert "prompt" not in serialized


def test_live_fail_open_recovery_validates_consumed_permit_identity(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    signer, consumed_permit, receipt = _fail_open_artifacts(
        model_usage_db,
        reservation_context,
    )

    with pytest.raises(
        ModelUsageReceiptIntegrityError,
        match="fail_open_permit_receipt_mismatch",
    ):
        recover_fail_open_receipt_in_session(
            model_usage_db,
            receipt,
            signer=signer,
            consumed_permit=replace(consumed_permit, subject_key="other-subject"),
        )

    settlement = recover_fail_open_receipt_in_session(
        model_usage_db,
        receipt,
        signer=signer,
        consumed_permit=consumed_permit,
    )
    assert settlement.event_id is not None


def test_fail_open_recovery_links_matching_measurement_incident_attempt(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    subject = model_usage_db.scalar(
        select(ModelUsageSubject).where(
            ModelUsageSubject.family_id == receipt.family_id,
            ModelUsageSubject.subject_key == receipt.subject_key,
        )
    )
    assert subject is not None
    record_incident(
        model_usage_db,
        IncidentCommand(
            incident_key="incident-for-recovery",
            family_id=receipt.family_id,
            subject_id=subject.id,
            subject_key=subject.subject_key,
            capability=receipt.capability,
            period_start=receipt.period.start_at,
            period_end=receipt.period.end_at,
            mode="monitoring_fail_open",
            cause_code="model_usage_ledger_unavailable",
            started_at=receipt.dispatched_at,
            recovered_at=None,
            coverage=ModelUsageIncidentCoverage.EXACT_SCOPE,
            source_instance="api-test",
            attempts=(
                IncidentAttemptCommand(
                    client_attempt_id=receipt.client_attempt_id,
                    subject_id=subject.id,
                    capability=receipt.capability,
                ),
            ),
        ),
    )

    settlement = recover_fail_open_receipt_in_session(
        model_usage_db,
        receipt,
        signer=signer,
    )
    attempt = model_usage_db.query(ModelUsageMeasurementIncidentAttempt).one()

    assert attempt.recovery_status is ModelUsageIncidentRecoveryStatus.RECOVERED
    assert attempt.recovered_event_id == settlement.event_id
    assert attempt.resolved_at is not None


def test_logged_receipt_reconstructs_shanghai_billing_month(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    august_start = datetime(2026, 7, 31, 16, 0, tzinfo=timezone.utc)
    receipt = signer.sign(
        replace(
            receipt,
            period=shanghai_billing_period(august_start),
            integrity_hmac="",
        )
    )

    reconstructed = provider_usage_receipt_from_log_payload(receipt_log_payload(receipt))

    assert reconstructed.period.local_month == "2026-08"


@pytest.mark.parametrize(
    "field",
    [
        "family_id",
        "subject_key",
        "provider",
        "requested_model",
        "billing_model",
        "variant_key",
        "billing_scheme_key",
        "attempt_key",
        "fingerprint",
        "client_attempt_id",
        "policy_version_id",
        "dispatch_policy_version_id",
        "integrity_key_id",
        "integrity_hmac",
    ],
)
def test_logged_receipt_rejects_non_string_required_identity(
    model_usage_db: Session,
    reservation_context: UsageContext,
    field: str,
) -> None:
    _, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    payload = receipt_log_payload(receipt)
    payload[field] = None

    with pytest.raises(
        ModelUsageReceiptIntegrityError,
        match="receipt_log_payload_invalid",
    ):
        provider_usage_receipt_from_log_payload(payload)


def test_logged_receipt_rejects_empty_required_identity(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    _, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    payload = receipt_log_payload(receipt)
    payload["family_id"] = ""

    with pytest.raises(
        ModelUsageReceiptIntegrityError,
        match="receipt_log_payload_invalid",
    ):
        provider_usage_receipt_from_log_payload(payload)


def test_fail_open_recovery_rejects_meter_outside_capability_contract(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    invalid = signer.sign(
        replace(
            receipt,
            meters=(
                replace(
                    receipt.meters[0],
                    meter=ModelUsageMeter.EMBEDDING_TOKENS,
                ),
            ),
            integrity_hmac="",
        )
    )

    with pytest.raises(
        ModelUsageReceiptIntegrityError,
        match="fail_open_meter_contract_invalid",
    ):
        recover_fail_open_receipt_in_session(model_usage_db, invalid, signer=signer)


def test_fail_open_recovery_rejects_duplicate_receipt_meter(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    duplicate = signer.sign(
        replace(
            receipt,
            meters=(receipt.meters[0], receipt.meters[0]),
            integrity_hmac="",
        )
    )

    with pytest.raises(
        ModelUsageReceiptIntegrityError,
        match="fail_open_receipt_duplicate_meter",
    ):
        recover_fail_open_receipt_in_session(model_usage_db, duplicate, signer=signer)


@pytest.mark.parametrize("quantity", [Decimal("-1"), Decimal("1.5")])
def test_fail_open_recovery_rejects_invalid_meter_quantity(
    model_usage_db: Session,
    reservation_context: UsageContext,
    quantity: Decimal,
) -> None:
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    invalid = signer.sign(
        replace(
            receipt,
            meters=(replace(receipt.meters[0], quantity=quantity),),
            integrity_hmac="",
        )
    )

    with pytest.raises(
        ModelUsageReceiptIntegrityError,
        match="fail_open_receipt_meter_quantity_invalid",
    ):
        recover_fail_open_receipt_in_session(model_usage_db, invalid, signer=signer)


def test_confirmed_not_executed_fail_open_receipt_records_zero_quantities(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    not_executed = signer.sign(
        replace(
            receipt,
            provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
            integrity_hmac="",
        )
    )

    settlement = recover_fail_open_receipt_in_session(
        model_usage_db,
        not_executed,
        signer=signer,
    )
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    meters = model_usage_db.query(ModelUsageEventMeter).filter_by(event_id=settlement.event_id)

    assert event is not None
    assert event.cost_cny == Decimal("0")
    assert {row.quantity for row in meters} == {Decimal("0")}


def test_fail_open_receipt_reconciles_retry_reservation_with_different_meter_set(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-fail-open-recovery",
        at=NOW,
    )
    signer, receipt = _signed_fail_open_receipt(model_usage_db, reservation_context)
    receipt = signer.sign(
        replace(
            receipt,
            meters=(receipt.meters[0],),
            integrity_hmac="",
        )
    )

    settlement = recover_fail_open_receipt_in_session(
        model_usage_db,
        receipt,
        signer=signer,
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    input_counter = model_usage_db.scalar(
        select(ModelUsagePeriodCounter).where(
            ModelUsagePeriodCounter.counter_kind
            == ModelUsageCounterKind.CAPABILITY_METER,
            ModelUsagePeriodCounter.meter == ModelUsageMeter.INPUT_TOKENS,
        )
    )

    assert reservation is not None
    assert reservation.status is ModelUsageReservationStatus.SETTLED
    assert settlement.event_id is not None
    assert all(
        counter.reserved_value == 0
        for counter in model_usage_db.query(ModelUsagePeriodCounter)
    )
    assert input_counter is not None
    assert input_counter.settled_value == Decimal("10")


def test_priced_fail_open_event_cost_equals_billable_line_sum(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    signer, receipt = _signed_fail_open_receipt(
        model_usage_db,
        reservation_context,
        include_price_snapshot=True,
    )

    settlement = recover_fail_open_receipt_in_session(
        model_usage_db,
        receipt,
        signer=signer,
    )
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    line_costs = tuple(
        model_usage_db.scalars(
            select(ModelUsageEventMeter.cost_cny).where(
                ModelUsageEventMeter.event_id == settlement.event_id,
                ModelUsageEventMeter.cost_cny.is_not(None),
            )
        )
    )

    assert event is not None
    assert event.pricing_status.value == "priced"
    assert event.cost_cny == sum(line_costs, Decimal("0"))


@pytest.mark.parametrize("mismatch", ["price_version", "billing_model"])
def test_inconsistent_fail_open_price_snapshot_recovers_unpriced(
    model_usage_db: Session,
    reservation_context: UsageContext,
    mismatch: str,
) -> None:
    publish(model_usage_db, raw_manifest())
    signer, receipt = _signed_fail_open_receipt(
        model_usage_db,
        reservation_context,
        include_price_snapshot=True,
    )
    assert receipt.price_snapshot is not None
    if mismatch == "price_version":
        inconsistent = replace(receipt, price_version_id="missing-price-version")
    else:
        inconsistent = replace(
            receipt,
            price_snapshot=replace(receipt.price_snapshot, billing_model="other-model"),
        )
    inconsistent = signer.sign(replace(inconsistent, integrity_hmac=""))

    settlement = recover_fail_open_receipt_in_session(
        model_usage_db,
        inconsistent,
        signer=signer,
    )
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)

    assert event is not None
    assert event.pricing_status.value == "unpriced"
    assert event.price_version_id is None
    assert event.price_snapshot_checksum is None
    assert event.cost_cny is None


def test_late_exact_evidence_after_conservative_event_requires_adjustment(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-late-evidence",
        at=NOW,
    )
    prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-late-evidence",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None and reservation.dispatching_at is not None
    reservation.recovery_mode = ModelUsageRecoveryMode.QUERYABLE_REQUEST
    reservation.query_window_seconds = 48 * 60 * 60
    model_usage_db.flush()
    mark_dispatch_uncertain(model_usage_db, reservation_id=reservation.id)
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    estimated = settle_expired_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=reservation.dispatching_at + timedelta(hours=24),
        signer=signer,
    )
    assert estimated is not None
    fail_open_signer, fail_open_receipt = _signed_fail_open_receipt(
        model_usage_db,
        reservation_context,
        at=NOW,
    )
    exact_receipt = signer.sign(
        replace(
            fail_open_receipt,
            reservation_id=reservation.id,
            fingerprint=reservation.fingerprint,
            policy_version_id=reservation.policy_version_id,
            dispatch_policy_version_id=reservation.dispatch_policy_version_id or "",
            dispatched_at=reservation.dispatching_at,
            completed_at=reservation.dispatching_at + timedelta(hours=25),
            provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            pricing_status=reservation.pricing_status,
            price_version_id=reservation.price_version_id,
            price_snapshot_checksum=reservation.price_snapshot_checksum,
            fail_open_proof_id=None,
            integrity_hmac="",
        )
    )

    class QueryHandler:
        def query_original_attempt(self, *, client_attempt_id: str):
            assert client_attempt_id == reservation.client_attempt_id
            return exact_receipt

    result = reconcile_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=reservation.dispatching_at + timedelta(hours=25),
        signer=signer,
        handler=QueryHandler(),
    )

    assert getattr(result, "disposition", None) == "adjustment_required"
    assert getattr(result, "source_event_id", None) == estimated.event_id
    late_fail_open_receipt = fail_open_signer.sign(
        replace(
            fail_open_receipt,
            fingerprint=reservation.fingerprint,
            policy_version_id=reservation.policy_version_id,
            dispatch_policy_version_id=reservation.dispatch_policy_version_id or "",
            completed_at=NOW + timedelta(hours=25),
            integrity_hmac="",
        )
    )
    fail_open_result = recover_fail_open_receipt_in_session(
        model_usage_db,
        late_fail_open_receipt,
        signer=fail_open_signer,
    )
    assert getattr(fail_open_result, "disposition", None) == "adjustment_required"
    assert getattr(fail_open_result, "source_event_id", None) == estimated.event_id
    assert model_usage_db.query(ModelUsageEvent).count() == 1
