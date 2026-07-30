from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageReservationStatus,
)
from app.core.utils import create_id
from app.db.session import SessionLocal
from app.models.model_usage import (
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsagePolicyVersion,
    ModelUsageReservation,
    ModelUsageReservationMeter,
)
from app.repos.model_usage.ledger import lock_event_by_attempt
from app.services.model_usage.decimal_math import exact_line_cost, quantize_quantity
from app.services.model_usage.dispatch import _lock_counters, _remove_reserved
from app.services.model_usage.alerts import evaluate_budget_alerts_with_focus
from app.services.model_usage.errors import (
    ModelUsageAttemptConflict,
    ModelUsageContractError,
    ModelUsageReceiptIntegrityError,
    ModelUsageSettlementPending,
    ModelUsageStateError,
)
from app.services.model_usage.policies import lock_family_policy
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.state_machine import transition_reservation, validate_event_outcome
from app.services.model_usage.types import (
    ProviderUsageReceipt,
    UsageMeterQuantity,
    UsageSettlement,
    validate_usage_meter_quantities,
)


def _normalize_meters(receipt: ProviderUsageReceipt) -> tuple[UsageMeterQuantity, ...]:
    try:
        validated = validate_usage_meter_quantities(
            receipt.capability,
            receipt.meters,
        )
    except ModelUsageContractError as exc:
        raise ModelUsageSettlementPending("receipt_meter_quantity_invalid") from exc
    by_meter = {line.meter: line for line in validated}
    if receipt.capability.value == "llm" and {
        ModelUsageMeter.INPUT_TOKENS,
        ModelUsageMeter.CACHED_INPUT_TOKENS,
        ModelUsageMeter.OUTPUT_TOKENS,
    } <= set(by_meter):
        input_line = by_meter[ModelUsageMeter.INPUT_TOKENS]
        cached_line = by_meter[ModelUsageMeter.CACHED_INPUT_TOKENS]
        output_line = by_meter[ModelUsageMeter.OUTPUT_TOKENS]
        if cached_line.quantity > input_line.quantity:
            raise ModelUsageSettlementPending("cached_input_exceeds_input")
        uncached = UsageMeterQuantity(
            meter=ModelUsageMeter.UNCACHED_INPUT_TOKENS,
            quantity=quantize_quantity(input_line.quantity - cached_line.quantity),
            meter_role=ModelUsageMeterRole.BILLABLE,
            quantity_source=input_line.quantity_source,
        )
        total = UsageMeterQuantity(
            meter=ModelUsageMeter.TOTAL_TOKENS,
            quantity=quantize_quantity(input_line.quantity + output_line.quantity),
            meter_role=ModelUsageMeterRole.INFORMATIONAL,
            quantity_source=input_line.quantity_source,
        )
        by_meter[ModelUsageMeter.UNCACHED_INPUT_TOKENS] = uncached
        by_meter[ModelUsageMeter.TOTAL_TOKENS] = total
    return tuple(sorted(by_meter.values(), key=lambda item: item.meter.value))


def _same_time(left: datetime, right: datetime) -> bool:
    if left.tzinfo is None or right.tzinfo is None:
        return left.replace(tzinfo=None) == right.replace(tzinfo=None)
    return left == right


def _validate_identity(
    reservation: ModelUsageReservation,
    receipt: ProviderUsageReceipt,
) -> None:
    is_not_billed = receipt.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED
    pricing_identity_matches = (
        (
            receipt.price_version_id is None
            and receipt.price_snapshot_checksum is None
        )
        or (
            reservation.price_version_id == receipt.price_version_id
            and reservation.price_snapshot_checksum == receipt.price_snapshot_checksum
        )
        if is_not_billed
        else (
            reservation.pricing_status is receipt.pricing_status
            and reservation.price_version_id == receipt.price_version_id
            and reservation.price_snapshot_checksum == receipt.price_snapshot_checksum
        )
    )
    checks = (
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
        reservation.dispatch_policy_version_id == receipt.dispatch_policy_version_id,
        pricing_identity_matches,
        _same_time(reservation.period_start, receipt.period.start_at),
        _same_time(reservation.period_end, receipt.period.end_at),
        reservation.dispatching_at is not None
        and _same_time(reservation.dispatching_at, receipt.dispatched_at),
        receipt.fail_open_proof_id is None,
        not receipt.meter_watermarks or receipt.capability.value == "realtime_audio",
    )
    if not all(checks):
        raise ModelUsageReceiptIntegrityError("receipt_reservation_mismatch")


def _settlement_from_event(
    db: Session,
    event: ModelUsageEvent,
    *,
    notification_focus_threshold: Decimal | None = None,
) -> UsageSettlement:
    rows = tuple(
        db.scalars(
            select(ModelUsageEventMeter)
            .where(ModelUsageEventMeter.event_id == event.id)
            .order_by(ModelUsageEventMeter.meter_key)
        )
    )
    meters = tuple(
        UsageMeterQuantity(row.meter, row.quantity, row.meter_role, row.quantity_source)
        for row in rows
    )
    return UsageSettlement(
        event_id=event.id,
        reservation_id=event.reservation_id,
        measurement_status=event.measurement_status,
        pricing_status=event.pricing_status,
        execution_certainty=event.execution_certainty,
        cost_cny=event.cost_cny,
        meters=meters,
        billable_line_costs=tuple(
            row.cost_cny for row in rows if row.cost_cny is not None
        ),
        notification_focus_threshold=notification_focus_threshold,
    )


def settle_usage_in_session(
    db: Session,
    receipt: ProviderUsageReceipt,
    *,
    signer: ProviderUsageReceiptSigner,
) -> UsageSettlement:
    signer.verify(receipt)
    if receipt.reservation_id is None:
        raise ModelUsageSettlementPending("fail_open_receipt_requires_recovery")
    validate_event_outcome(receipt.provider_outcome, receipt.execution_certainty)
    identity = db.get(ModelUsageReservation, receipt.reservation_id)
    if identity is None:
        raise ModelUsageSettlementPending("reservation_not_found")
    pointer = lock_family_policy(db, family_id=identity.family_id)
    current_policy = db.get(ModelUsagePolicyVersion, pointer.current_policy_version_id)
    if current_policy is None:
        raise ModelUsageStateError("current_policy_missing")
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(
            ModelUsageReservation.id == receipt.reservation_id,
            ModelUsageReservation.family_id == identity.family_id,
        )
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if reservation is None:
        raise ModelUsageSettlementPending("reservation_not_found")
    _validate_identity(reservation, receipt)
    existing = lock_event_by_attempt(
        db,
        family_id=reservation.family_id,
        attempt_key=reservation.attempt_key,
    )
    if existing is not None:
        if existing.fingerprint != receipt.fingerprint:
            raise ModelUsageAttemptConflict()
        return _settlement_from_event(db, existing)
    if reservation.status not in {
        ModelUsageReservationStatus.DISPATCHING,
        ModelUsageReservationStatus.UNCERTAIN,
    }:
        raise ModelUsageStateError("reservation_not_settleable")
    reserved_rows = tuple(
        db.scalars(
            select(ModelUsageReservationMeter)
            .where(ModelUsageReservationMeter.reservation_id == reservation.id)
            .order_by(ModelUsageReservationMeter.meter_key)
        )
    )
    normalized = _normalize_meters(receipt)
    reserved_by_meter = {row.meter: row for row in reserved_rows}
    if set(reserved_by_meter) != {line.meter for line in normalized}:
        raise ModelUsageSettlementPending("receipt_meter_set_mismatch")
    not_billed = receipt.provider_outcome is ModelUsageProviderOutcome.NOT_BILLED
    confirmed_not_executed = (
        receipt.execution_certainty is ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
    )
    event_id = create_id("usage-event")
    event_rows: list[ModelUsageEventMeter] = []
    for line in normalized:
        snapshot = reserved_by_meter[line.meter]
        role = ModelUsageMeterRole.INFORMATIONAL if not_billed else snapshot.meter_role
        quantity = Decimal("0") if confirmed_not_executed else line.quantity
        cost = None
        if (
            not not_billed
            and receipt.pricing_status is ModelUsagePricingStatus.PRICED
            and role is ModelUsageMeterRole.BILLABLE
        ):
            if snapshot.unit_price_cny is None or snapshot.unit_quantity is None:
                raise ModelUsageSettlementPending("settlement_price_snapshot_missing")
            cost = exact_line_cost(quantity, snapshot.unit_price_cny, snapshot.unit_quantity)
        event_rows.append(
            ModelUsageEventMeter(
                id=create_id("usage-event-meter"),
                event_id=event_id,
                meter_key=line.meter.value,
                meter=line.meter,
                meter_role=role,
                quantity=quantity,
                quantity_source=line.quantity_source,
                unit_quantity=snapshot.unit_quantity,
                source_unit_price=snapshot.source_unit_price,
                source_currency=snapshot.source_currency,
                fx_to_cny=snapshot.fx_to_cny,
                unit_price_cny=snapshot.unit_price_cny,
                cost_cny=cost,
            )
        )
    pricing_status = (
        ModelUsagePricingStatus.PRICED if not_billed else receipt.pricing_status
    )
    event_cost = (
        Decimal("0")
        if not_billed
        else (
            sum((row.cost_cny for row in event_rows if row.cost_cny is not None), Decimal("0"))
            if pricing_status is ModelUsagePricingStatus.PRICED
            else None
        )
    )
    event = ModelUsageEvent(
        id=event_id,
        reservation_id=reservation.id,
        recovery_source="reservation",
        attempt_key=reservation.attempt_key,
        fingerprint=receipt.fingerprint,
        client_attempt_id=reservation.client_attempt_id,
        family_id=reservation.family_id,
        subject_id=reservation.subject_id,
        subject_key=reservation.subject_key,
        capability=reservation.capability,
        provider=reservation.provider,
        requested_model=reservation.requested_model,
        reported_model=receipt.reported_model,
        billing_model=reservation.billing_model,
        variant_key=reservation.variant_key,
        billing_scheme_key=reservation.billing_scheme_key,
        pricing_status=pricing_status,
        price_version_id=None if not_billed else reservation.price_version_id,
        price_snapshot_checksum=None if not_billed else reservation.price_snapshot_checksum,
        policy_version_id=reservation.policy_version_id,
        dispatch_policy_version_id=reservation.dispatch_policy_version_id,
        period_start=reservation.period_start,
        period_end=reservation.period_end,
        provider_outcome=receipt.provider_outcome,
        execution_certainty=receipt.execution_certainty,
        measurement_status=receipt.measurement_status,
        provider_reported_source_cost=None,
        provider_reported_source_currency=None,
        cost_cny=event_cost,
        provider_request_id=receipt.provider_request_id,
        dispatched_at=reservation.dispatching_at,
        completed_at=receipt.completed_at,
        estimation_reason=None,
        stable_error_code=None,
        fail_open_proof_id=None,
    )
    savepoint = db.begin_nested()
    try:
        db.add(event)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        winner = lock_event_by_attempt(
            db,
            family_id=reservation.family_id,
            attempt_key=reservation.attempt_key,
        )
        if winner is None or winner.fingerprint != receipt.fingerprint:
            raise ModelUsageAttemptConflict()
        return _settlement_from_event(db, winner)
    else:
        savepoint.commit()
    counters = _lock_counters(db, reservation, reserved_rows)
    _remove_reserved(reservation, reserved_rows, counters)
    db.add_all(event_rows)
    quantities = {row.meter: row.quantity for row in event_rows}
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
    reservation.status = transition_reservation(
        reservation.status,
        ModelUsageReservationStatus.SETTLED,
    )
    reservation.provider_request_id = receipt.provider_request_id
    family_counter = next(
        counter
        for counter in counters
        if counter.counter_kind is ModelUsageCounterKind.FAMILY_COST
    )
    alert_evaluation = evaluate_budget_alerts_with_focus(
        db,
        policy=current_policy,
        counter=family_counter,
    )
    db.flush()
    return _settlement_from_event(
        db,
        event,
        notification_focus_threshold=(
            alert_evaluation.notification_focus.threshold
            if alert_evaluation.notification_focus is not None
            else None
        ),
    )


def settle_usage(
    receipt: ProviderUsageReceipt,
    *,
    signer: ProviderUsageReceiptSigner,
    session_factory: Callable[[], Session] = SessionLocal,
) -> UsageSettlement:
    with session_factory() as db:
        with db.begin():
            return settle_usage_in_session(db, receipt, signer=signer)
