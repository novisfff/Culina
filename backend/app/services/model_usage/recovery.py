from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageIncidentRecoveryStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageMeasurementStatus,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
)
from app.core.utils import create_id, utcnow
from app.db.session import SessionLocal
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageMeasurementIncidentAttempt,
    ModelUsagePriceRate,
    ModelUsagePriceVersion,
    ModelUsageReservation,
    ModelUsageReservationMeter,
    ModelUsageSubject,
)
from app.services.model_usage.counters import (
    CounterKey,
    capability_cost_dimension_key,
    capability_meter_dimension_key,
    family_cost_dimension_key,
    lock_or_create_counter,
)
from app.services.model_usage.decimal_math import exact_line_cost
from app.services.model_usage.dispatch import _lock_counters, _permit, _remove_reserved
from app.services.model_usage.errors import (
    ModelUsageAttemptConflict,
    ModelUsageContractError,
    ModelUsageReceiptIntegrityError,
    ModelUsageStateError,
)
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.policies import lock_family_policy
from app.services.model_usage.pricing import UsagePriceRateSnapshot
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.settlement import _settlement_from_event, settle_usage_in_session
from app.services.model_usage.state_machine import transition_reservation, validate_event_outcome
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderUsageReceipt,
    UsageMeterQuantity,
    UsageSettlement,
    capability_meter_contract,
    validate_usage_meter_quantities,
)


logger = logging.getLogger(__name__)


def _log_recovery_event(**fields: object) -> None:
    logger.info(
        "model_usage_recovery %s",
        json.dumps(fields, ensure_ascii=False, sort_keys=True),
    )


CONSERVATIVE_SETTLEMENT_AFTER = timedelta(hours=24)
QUERYABLE_MODES = {
    ModelUsageRecoveryMode.QUERYABLE_REQUEST,
    ModelUsageRecoveryMode.IDEMPOTENCY_AND_QUERYABLE,
}
IDEMPOTENCY_MODES = {
    ModelUsageRecoveryMode.IDEMPOTENCY_KEY,
    ModelUsageRecoveryMode.IDEMPOTENCY_AND_QUERYABLE,
}


class ProviderRecoveryHandler(Protocol):
    def query_original_attempt(
        self,
        *,
        client_attempt_id: str,
    ) -> ProviderUsageReceipt | None: ...


@dataclass(frozen=True, slots=True)
class RecoveryAdjustmentRequired:
    source_event_id: str
    evidence_receipt: ProviderUsageReceipt
    disposition: str = "adjustment_required"
    reason: str = "late_evidence_after_conservative_settlement"


def _adjustment_required_for_late_evidence(
    settlement: UsageSettlement,
    receipt: ProviderUsageReceipt,
) -> RecoveryAdjustmentRequired | None:
    if (
        settlement.measurement_status is ModelUsageMeasurementStatus.ESTIMATED
        and receipt.measurement_status is ModelUsageMeasurementStatus.EXACT
    ):
        return RecoveryAdjustmentRequired(
            source_event_id=settlement.event_id,
            evidence_receipt=receipt,
        )
    return None


def _recoverable_price_rates(
    db: Session,
    receipt: ProviderUsageReceipt,
) -> dict[ModelUsageMeter, UsagePriceRateSnapshot] | None:
    snapshot = receipt.price_snapshot
    if (
        snapshot is None
        or receipt.pricing_status is not ModelUsagePricingStatus.PRICED
        or snapshot.pricing_status is not ModelUsagePricingStatus.PRICED
        or snapshot.price_version_id is None
        or snapshot.price_version_id != receipt.price_version_id
        or snapshot.billing_model != receipt.billing_model
        or snapshot.billing_scheme_key != receipt.billing_scheme_key
        or snapshot.checksum is None
        or snapshot.checksum != receipt.price_snapshot_checksum
        or snapshot.missing_billable_meters
    ):
        return None
    price_version = db.get(ModelUsagePriceVersion, snapshot.price_version_id)
    if price_version is None or price_version.manifest_checksum != snapshot.checksum:
        return None
    catalog_rates = tuple(
        db.scalars(
            select(ModelUsagePriceRate)
            .where(
                ModelUsagePriceRate.price_version_id == snapshot.price_version_id,
                ModelUsagePriceRate.provider == receipt.provider,
                ModelUsagePriceRate.billing_model == receipt.billing_model,
                ModelUsagePriceRate.capability == receipt.capability,
                ModelUsagePriceRate.variant_key == receipt.variant_key,
                ModelUsagePriceRate.billing_scheme_key == receipt.billing_scheme_key,
            )
            .order_by(ModelUsagePriceRate.meter)
        )
    )
    snapshot_rates = {rate.meter: rate for rate in snapshot.rates}
    catalog_by_meter = {rate.meter: rate for rate in catalog_rates}
    if (
        len(snapshot_rates) != len(snapshot.rates)
        or len(catalog_by_meter) != len(catalog_rates)
        or set(snapshot_rates) != set(catalog_by_meter)
    ):
        return None
    for meter, catalog_rate in catalog_by_meter.items():
        rate = snapshot_rates[meter]
        if (
            rate.meter_role is not catalog_rate.meter_role
            or rate.unit_quantity != catalog_rate.unit_quantity
            or rate.unit_price != catalog_rate.unit_price
            or rate.source_currency != catalog_rate.source_currency
            or rate.fx_to_cny != catalog_rate.fx_to_cny
            or rate.unit_price_cny != catalog_rate.unit_price_cny
        ):
            return None
    expected_billable = {
        line.meter
        for line in receipt.required_meters
        if line.meter_role is ModelUsageMeterRole.BILLABLE
    }
    catalog_billable = {
        rate.meter
        for rate in catalog_rates
        if rate.meter_role is ModelUsageMeterRole.BILLABLE
        and rate.unit_price_cny is not None
    }
    if expected_billable != catalog_billable:
        return None
    return snapshot_rates


def _validate_consumed_fail_open_permit(
    permit: DispatchPermit,
    receipt: ProviderUsageReceipt,
) -> None:
    permit_required_meters = {line.meter: line for line in permit.required_meters}
    receipt_required_meters = {line.meter: line for line in receipt.required_meters}
    required_meter_contract_matches = (
        len(permit_required_meters) == len(permit.required_meters)
        and len(receipt_required_meters) == len(receipt.required_meters)
        and permit_required_meters == receipt_required_meters
    )
    checks = (
        permit.send_kind == "fail_open_single_send",
        permit.reservation_id is None,
        permit.fail_open_proof_id == receipt.fail_open_proof_id,
        permit.family_id == receipt.family_id,
        permit.subject_key == receipt.subject_key,
        permit.capability is receipt.capability,
        permit.provider == receipt.provider,
        permit.requested_model == receipt.requested_model,
        permit.billing_model == receipt.billing_model,
        permit.variant_key == receipt.variant_key,
        permit.billing_scheme_key == receipt.billing_scheme_key,
        permit.attempt_key == receipt.attempt_key,
        permit.fingerprint == receipt.fingerprint,
        permit.client_attempt_id == receipt.client_attempt_id,
        permit.policy_version_id == receipt.policy_version_id,
        permit.dispatch_policy_version_id == receipt.dispatch_policy_version_id,
        permit.pricing_status is receipt.pricing_status,
        permit.price_version_id == receipt.price_version_id,
        permit.price_snapshot_checksum == receipt.price_snapshot_checksum,
        _utc(permit.period.start_at) == _utc(receipt.period.start_at),
        _utc(permit.period.end_at) == _utc(receipt.period.end_at),
        _utc(permit.dispatched_at) == _utc(receipt.dispatched_at),
        required_meter_contract_matches,
    )
    if not all(checks):
        raise ModelUsageReceiptIntegrityError(
            "fail_open_permit_receipt_mismatch"
        )


def _validate_retry_reservation_meter_contract(
    db: Session,
    *,
    reservation: ModelUsageReservation,
    receipt: ProviderUsageReceipt,
    receipt_meters: tuple[UsageMeterQuantity, ...],
) -> None:
    identity_matches = (
        reservation.family_id == receipt.family_id,
        reservation.subject_key == receipt.subject_key,
        reservation.capability is receipt.capability,
        reservation.provider == receipt.provider,
        reservation.requested_model == receipt.requested_model,
        reservation.billing_model == receipt.billing_model,
        reservation.variant_key == receipt.variant_key,
        reservation.billing_scheme_key == receipt.billing_scheme_key,
        reservation.attempt_key == receipt.attempt_key,
        reservation.fingerprint == receipt.fingerprint,
        reservation.client_attempt_id == receipt.client_attempt_id,
        reservation.policy_version_id == receipt.policy_version_id,
    )
    if not all(identity_matches):
        raise ModelUsageReceiptIntegrityError("fail_open_retry_reservation_mismatch")
    reservation_meters = tuple(
        db.scalars(
            select(ModelUsageReservationMeter)
            .where(ModelUsageReservationMeter.reservation_id == reservation.id)
            .order_by(ModelUsageReservationMeter.meter_key)
        )
    )
    expected_by_meter = {row.meter: row for row in reservation_meters}
    actual_by_meter = {line.meter: line for line in receipt_meters}
    if set(expected_by_meter) != set(actual_by_meter):
        raise ModelUsageReceiptIntegrityError("fail_open_receipt_meter_set_mismatch")
    if receipt.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED:
        return
    if any(
        actual_by_meter[meter].meter_role is not expected.meter_role
        for meter, expected in expected_by_meter.items()
    ):
        raise ModelUsageReceiptIntegrityError("fail_open_receipt_meter_role_mismatch")


def _validate_fail_open_required_meter_contract(
    receipt: ProviderUsageReceipt,
    receipt_meters: tuple[UsageMeterQuantity, ...],
) -> None:
    required_by_meter = {line.meter: line for line in receipt.required_meters}
    if not required_by_meter or len(required_by_meter) != len(receipt.required_meters):
        raise ModelUsageReceiptIntegrityError("fail_open_required_meter_contract_missing")
    actual_by_meter = {line.meter: line for line in receipt_meters}
    if set(required_by_meter) != set(actual_by_meter):
        raise ModelUsageReceiptIntegrityError("fail_open_receipt_meter_set_mismatch")
    for line in receipt.required_meters:
        try:
            capability_meter_contract(receipt.capability, line.meter)
        except KeyError as exc:
            raise ModelUsageReceiptIntegrityError(
                "fail_open_meter_contract_invalid"
            ) from exc
    if receipt.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED:
        return
    if any(
        actual_by_meter[meter].meter_role is not required.meter_role
        for meter, required in required_by_meter.items()
    ):
        raise ModelUsageReceiptIntegrityError("fail_open_receipt_meter_role_mismatch")


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def can_query(reservation: ModelUsageReservation, *, at: datetime) -> bool:
    return bool(
        reservation.recovery_mode in QUERYABLE_MODES
        and reservation.query_window_seconds is not None
        and reservation.dispatching_at is not None
        and _utc(at)
        <= _utc(reservation.dispatching_at)
        + timedelta(seconds=reservation.query_window_seconds)
    )


def prepare_idempotent_resend_in_session(
    db: Session,
    *,
    reservation_id: str,
    fingerprint: str,
    at: datetime,
) -> DispatchPermit | None:
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(ModelUsageReservation.id == reservation_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if reservation is None:
        raise ModelUsageStateError("reservation_not_found")
    if reservation.fingerprint != fingerprint:
        raise ModelUsageAttemptConflict()
    if reservation.status not in {
        ModelUsageReservationStatus.DISPATCHING,
        ModelUsageReservationStatus.UNCERTAIN,
    }:
        return None
    if (
        reservation.recovery_mode not in IDEMPOTENCY_MODES
        or not reservation.provider_idempotency_key
        or reservation.idempotency_window_seconds is None
        or reservation.dispatching_at is None
        or _utc(at)
        > _utc(reservation.dispatching_at)
        + timedelta(seconds=reservation.idempotency_window_seconds)
        or reservation.automatic_resend_deadline_at is None
        or _utc(at) > _utc(reservation.automatic_resend_deadline_at)
    ):
        return None
    meters = tuple(
        db.scalars(
            select(ModelUsageReservationMeter)
            .where(ModelUsageReservationMeter.reservation_id == reservation.id)
            .order_by(ModelUsageReservationMeter.meter_key)
        )
    )
    return replace(_permit(reservation, meters), send_kind="idempotent_resend")


def mark_dispatch_uncertain(
    db: Session,
    *,
    reservation_id: str,
) -> ModelUsageReservation:
    record_usage_uncertain_in_session(
        db,
        reservation_id=reservation_id,
        stable_error_code="provider_execution_uncertain",
    )
    reservation = db.get(ModelUsageReservation, reservation_id)
    if reservation is None:
        raise ModelUsageStateError("reservation_not_found")
    return reservation


def _validate_stable_error_code(stable_error_code: str) -> None:
    if (
        not isinstance(stable_error_code, str)
        or not stable_error_code
        or len(stable_error_code) > 120
        or re.fullmatch(r"[a-z0-9_]+", stable_error_code) is None
    ):
        raise ModelUsageContractError("invalid_stable_error_code")


def record_usage_uncertain_in_session(
    db: Session,
    *,
    reservation_id: str,
    stable_error_code: str,
) -> None:
    _validate_stable_error_code(stable_error_code)
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(ModelUsageReservation.id == reservation_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if reservation is None:
        raise ModelUsageStateError("reservation_not_found")
    if reservation.status is ModelUsageReservationStatus.UNCERTAIN:
        if reservation.error_code != stable_error_code:
            raise ModelUsageStateError("uncertain_error_code_conflict")
        return
    if reservation.status is not ModelUsageReservationStatus.DISPATCHING:
        raise ModelUsageStateError("reservation_not_markable_uncertain")
    reservation.status = transition_reservation(
        reservation.status,
        ModelUsageReservationStatus.UNCERTAIN,
    )
    reservation.error_code = stable_error_code
    db.flush()


def record_usage_uncertain(
    reservation_id: str,
    *,
    stable_error_code: str,
    session_factory: Callable[[], Session] = SessionLocal,
) -> None:
    with session_factory() as db:
        with db.begin():
            record_usage_uncertain_in_session(
                db,
                reservation_id=reservation_id,
                stable_error_code=stable_error_code,
            )


def _estimated_receipt(
    reservation: ModelUsageReservation,
    meters: tuple[ModelUsageReservationMeter, ...],
    *,
    at: datetime,
) -> ProviderUsageReceipt:
    return ProviderUsageReceipt(
        reservation_id=reservation.id,
        family_id=reservation.family_id,
        subject_key=reservation.subject_key,
        capability=reservation.capability,
        provider=reservation.provider,
        requested_model=reservation.requested_model,
        reported_model=None,
        billing_model=reservation.billing_model,
        variant_key=reservation.variant_key,
        billing_scheme_key=reservation.billing_scheme_key,
        attempt_key=reservation.attempt_key,
        fingerprint=reservation.fingerprint,
        client_attempt_id=reservation.client_attempt_id,
        policy_version_id=reservation.policy_version_id,
        dispatch_policy_version_id=reservation.dispatch_policy_version_id or "",
        provider_request_id=reservation.provider_request_id,
        provider_outcome=ModelUsageProviderOutcome.UNKNOWN,
        execution_certainty=ModelUsageExecutionCertainty.UNKNOWN,
        measurement_status=ModelUsageMeasurementStatus.ESTIMATED,
        pricing_status=reservation.pricing_status,
        period=BillingPeriod(
            local_month=reservation.period_start.astimezone(SHANGHAI).strftime("%Y-%m"),
            start_at=reservation.period_start,
            end_at=reservation.period_end,
        ),
        meters=tuple(
            UsageMeterQuantity(
                meter=row.meter,
                quantity=row.reserved_quantity,
                meter_role=row.meter_role,
                quantity_source=ModelUsageQuantitySource.ESTIMATED,
            )
            for row in meters
        ),
        meter_watermarks=(),
        dispatched_at=reservation.dispatching_at,
        completed_at=at,
        price_version_id=reservation.price_version_id,
        price_snapshot=None,
        price_snapshot_checksum=reservation.price_snapshot_checksum,
        fail_open_proof_id=None,
        integrity_key_id="",
        integrity_hmac="",
    )


def settle_expired_uncertain_in_session(
    db: Session,
    *,
    reservation_id: str,
    at: datetime,
    signer: ProviderUsageReceiptSigner,
) -> UsageSettlement | None:
    identity = db.get(ModelUsageReservation, reservation_id)
    if identity is None:
        raise ModelUsageStateError("reservation_not_found")
    lock_family_policy(db, family_id=identity.family_id)
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(ModelUsageReservation.id == reservation_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if reservation is None:
        raise ModelUsageStateError("reservation_not_found")
    if reservation.dispatching_at is None:
        return None
    if reservation.status not in {
        ModelUsageReservationStatus.UNCERTAIN,
        ModelUsageReservationStatus.SETTLED,
    }:
        return None
    if _utc(at) < _utc(reservation.dispatching_at) + CONSERVATIVE_SETTLEMENT_AFTER:
        return None
    meters = tuple(
        db.scalars(
            select(ModelUsageReservationMeter)
            .where(ModelUsageReservationMeter.reservation_id == reservation.id)
            .order_by(ModelUsageReservationMeter.meter_key)
        )
    )
    receipt = signer.sign(_estimated_receipt(reservation, meters, at=at))
    settlement = settle_usage_in_session(db, receipt, signer=signer)
    event = db.get(ModelUsageEvent, settlement.event_id)
    if event is not None and event.estimation_reason is None:
        event.estimation_reason = "provider_execution_unresolved_after_24h"
        db.flush()
    return settlement


def reconcile_uncertain_in_session(
    db: Session,
    *,
    reservation_id: str,
    at: datetime,
    signer: ProviderUsageReceiptSigner,
    handler: ProviderRecoveryHandler | None = None,
) -> UsageSettlement | RecoveryAdjustmentRequired | None:
    reservation = db.get(ModelUsageReservation, reservation_id)
    if reservation is None:
        raise ModelUsageStateError("reservation_not_found")
    if can_query(reservation, at=at):
        if handler is None:
            return None
        receipt = handler.query_original_attempt(
            client_attempt_id=reservation.client_attempt_id
        )
        if receipt is not None:
            settlement = settle_usage_in_session(db, receipt, signer=signer)
            adjustment_required = _adjustment_required_for_late_evidence(
                settlement,
                receipt,
            )
            if adjustment_required is not None:
                return adjustment_required
            return settlement
    if (
        reservation.status is ModelUsageReservationStatus.UNCERTAIN
        and reservation.dispatching_at is not None
        and _utc(at)
        >= _utc(reservation.dispatching_at) + CONSERVATIVE_SETTLEMENT_AFTER
    ):
        return settle_expired_uncertain_in_session(
            db,
            reservation_id=reservation_id,
            at=at,
            signer=signer,
        )
    return None


def recover_fail_open_receipt_in_session(
    db: Session,
    receipt: ProviderUsageReceipt,
    *,
    signer: ProviderUsageReceiptSigner,
    consumed_permit: DispatchPermit | None = None,
) -> UsageSettlement | RecoveryAdjustmentRequired:
    signer.verify(receipt)
    if receipt.reservation_id is not None or not receipt.fail_open_proof_id:
        raise ModelUsageReceiptIntegrityError("fail_open_receipt_identity_invalid")
    if consumed_permit is not None:
        _validate_consumed_fail_open_permit(consumed_permit, receipt)
    validate_event_outcome(receipt.provider_outcome, receipt.execution_certainty)
    try:
        normalized_meters = validate_usage_meter_quantities(
            receipt.capability,
            receipt.meters,
        )
    except ModelUsageContractError as exc:
        if str(exc) == "duplicate_usage_meter":
            code = "fail_open_receipt_duplicate_meter"
        elif str(exc) == "meter_not_supported_for_capability":
            code = "fail_open_meter_contract_invalid"
        else:
            code = "fail_open_receipt_meter_quantity_invalid"
        raise ModelUsageReceiptIntegrityError(code) from exc
    contracts = {
        line.meter: capability_meter_contract(receipt.capability, line.meter)
        for line in normalized_meters
    }
    lock_family_policy(db, family_id=receipt.family_id)
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(
            ModelUsageReservation.family_id == receipt.family_id,
            ModelUsageReservation.attempt_key == receipt.attempt_key,
        )
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if reservation is not None:
        _validate_retry_reservation_meter_contract(
            db,
            reservation=reservation,
            receipt=receipt,
            receipt_meters=normalized_meters,
        )
    else:
        _validate_fail_open_required_meter_contract(
            receipt,
            normalized_meters,
        )
    existing = db.scalar(
        select(ModelUsageEvent)
        .where(
            ModelUsageEvent.family_id == receipt.family_id,
            ModelUsageEvent.attempt_key == receipt.attempt_key,
        )
        .with_for_update()
    )
    if existing is not None:
        if existing.fingerprint != receipt.fingerprint:
            raise ModelUsageAttemptConflict()
        settlement = _settlement_from_event(db, existing)
        adjustment_required = _adjustment_required_for_late_evidence(
            settlement,
            receipt,
        )
        return adjustment_required or settlement
    if reservation is not None and reservation.fingerprint != receipt.fingerprint:
        raise ModelUsageAttemptConflict()
    subject = db.scalar(
        select(ModelUsageSubject).where(
            ModelUsageSubject.family_id == receipt.family_id,
            ModelUsageSubject.subject_key == receipt.subject_key,
        )
    )
    if subject is None:
        raise ModelUsageReceiptIntegrityError("fail_open_subject_missing")
    rates = _recoverable_price_rates(db, receipt)
    if rates is None:
        pricing_status = ModelUsagePricingStatus.UNPRICED
        rates = {}
        price_version_id = None
        price_checksum = None
    else:
        pricing_status = ModelUsagePricingStatus.PRICED
        price_version_id = receipt.price_version_id
        price_checksum = receipt.price_snapshot_checksum
    not_billed = receipt.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED
    event_id = create_id("usage-event")
    event_meters: list[ModelUsageEventMeter] = []
    for line in normalized_meters:
        role = ModelUsageMeterRole.INFORMATIONAL if not_billed else line.meter_role
        quantity = (
            line.quantity
            if receipt.execution_certainty
            is not ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
            else line.quantity * 0
        )
        rate = rates.get(line.meter)
        cost = None
        if (
            pricing_status is ModelUsagePricingStatus.PRICED
            and role is ModelUsageMeterRole.BILLABLE
            and not not_billed
        ):
            if rate is None or rate.unit_price_cny is None:
                pricing_status = ModelUsagePricingStatus.UNPRICED
                price_version_id = None
                price_checksum = None
            else:
                cost = exact_line_cost(quantity, rate.unit_price_cny, rate.unit_quantity)
        event_meters.append(
            ModelUsageEventMeter(
                id=create_id("usage-event-meter"),
                event_id=event_id,
                meter_key=line.meter.value,
                meter=line.meter,
                meter_role=role,
                quantity=quantity,
                quantity_source=line.quantity_source,
                unit_quantity=rate.unit_quantity if rate else None,
                source_unit_price=rate.unit_price if rate else None,
                source_currency=rate.source_currency if rate else None,
                fx_to_cny=rate.fx_to_cny if rate else None,
                unit_price_cny=rate.unit_price_cny if rate else None,
                cost_cny=cost,
            )
        )
    if pricing_status is ModelUsagePricingStatus.UNPRICED:
        for row in event_meters:
            row.cost_cny = None
    event_cost = (
        Decimal("0")
        if not_billed
        else (
            sum((row.cost_cny for row in event_meters if row.cost_cny is not None), Decimal("0"))
            if pricing_status is ModelUsagePricingStatus.PRICED
            else None
        )
    )
    event = ModelUsageEvent(
        id=event_id,
        reservation_id=reservation.id if reservation is not None else None,
        recovery_source="fail_open_receipt",
        attempt_key=receipt.attempt_key,
        fingerprint=receipt.fingerprint,
        client_attempt_id=receipt.client_attempt_id,
        family_id=receipt.family_id,
        subject_id=subject.id,
        subject_key=subject.subject_key,
        capability=receipt.capability,
        provider=receipt.provider,
        requested_model=receipt.requested_model,
        reported_model=receipt.reported_model,
        billing_model=receipt.billing_model,
        variant_key=receipt.variant_key,
        billing_scheme_key=receipt.billing_scheme_key,
        pricing_status=pricing_status,
        price_version_id=price_version_id,
        price_snapshot_checksum=price_checksum,
        policy_version_id=receipt.policy_version_id,
        dispatch_policy_version_id=receipt.dispatch_policy_version_id,
        period_start=receipt.period.start_at,
        period_end=receipt.period.end_at,
        provider_outcome=receipt.provider_outcome,
        execution_certainty=receipt.execution_certainty,
        measurement_status=receipt.measurement_status,
        provider_reported_source_cost=None,
        provider_reported_source_currency=None,
        cost_cny=event_cost,
        provider_request_id=receipt.provider_request_id,
        dispatched_at=receipt.dispatched_at,
        completed_at=receipt.completed_at,
        estimation_reason=None,
        stable_error_code=None,
        fail_open_proof_id=receipt.fail_open_proof_id,
    )
    db.add(event)
    db.flush()
    if reservation is not None:
        reserved_meters = tuple(
            db.scalars(
                select(ModelUsageReservationMeter).where(
                    ModelUsageReservationMeter.reservation_id == reservation.id
                )
            )
        )
        reserved_counters = _lock_counters(db, reservation, reserved_meters)
        _remove_reserved(reservation, reserved_meters, reserved_counters)
        reservation.status = ModelUsageReservationStatus.SETTLED
    period = BillingPeriod(
        local_month=receipt.period.local_month,
        start_at=receipt.period.start_at,
        end_at=receipt.period.end_at,
    )
    counter_keys = [
        CounterKey(
            receipt.family_id,
            period,
            ModelUsageCounterKind.FAMILY_COST,
            None,
            None,
            family_cost_dimension_key(),
        ),
        CounterKey(
            receipt.family_id,
            period,
            ModelUsageCounterKind.CAPABILITY_COST,
            receipt.capability,
            None,
            capability_cost_dimension_key(receipt.capability),
        ),
        *[
            CounterKey(
                receipt.family_id,
                period,
                ModelUsageCounterKind.CAPABILITY_METER,
                receipt.capability,
                row.meter,
                capability_meter_dimension_key(receipt.capability, row.meter),
            )
            for row in sorted(event_meters, key=lambda item: item.meter.value)
            if contracts[row.meter].guardrail_eligible
        ],
    ]
    counters = tuple(lock_or_create_counter(db, key) for key in counter_keys)
    db.add_all(event_meters)
    quantities = {row.meter: row.quantity for row in event_meters}
    for counter in counters:
        delta = (
            event_cost
            if counter.counter_kind
            in {ModelUsageCounterKind.FAMILY_COST, ModelUsageCounterKind.CAPABILITY_COST}
            else quantities[counter.meter]
        )
        if delta is not None:
            counter.settled_value += delta
            counter.version += 1
    incident_attempt = db.scalar(
        select(ModelUsageMeasurementIncidentAttempt)
        .where(
            ModelUsageMeasurementIncidentAttempt.family_id == receipt.family_id,
            ModelUsageMeasurementIncidentAttempt.client_attempt_id
            == receipt.client_attempt_id,
        )
        .with_for_update()
    )
    if incident_attempt is not None:
        incident_attempt.recovery_status = ModelUsageIncidentRecoveryStatus.RECOVERED
        incident_attempt.recovered_event_id = event.id
        incident_attempt.resolved_at = utcnow()
    db.flush()
    _log_recovery_event(
        event="fail_open_receipt_recovered",
        family_id=receipt.family_id,
        subject_key=receipt.subject_key,
        capability=receipt.capability.value,
        attempt_key=receipt.attempt_key,
        client_attempt_id=receipt.client_attempt_id,
        event_id=event.id,
        incident_attempt_linked=incident_attempt is not None,
    )
    return _settlement_from_event(db, event)
