from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCounterKind,
    ModelUsageLimitKind,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
)
from app.core.utils import create_id, utcnow
from app.db.session import SessionLocal
from app.models.model_usage import (
    ModelUsageCapabilityLimit,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
    ModelUsageReservation,
    ModelUsageReservationMeter,
    ModelUsageSubject,
)
from app.repos.model_usage.ledger import lock_event_by_attempt, lock_reservation_by_attempt
from app.services.model_usage.counters import (
    contract_counter_keys,
    effective_counter_value,
    lock_or_create_counters,
)
from app.services.model_usage.decimal_math import reservation_line_cost, would_exceed_limit
from app.services.model_usage.errors import ModelUsageAttemptConflict, ModelUsageContractError
from app.services.model_usage.periods import BillingPeriod, shanghai_billing_period
from app.services.model_usage.policies import lock_current_policy, lock_family_policy
from app.services.model_usage.pricing import (
    UsagePriceRateSnapshot,
    UsagePriceSnapshot,
    select_price_snapshot,
)
from app.services.model_usage.state_machine import transition_reservation
from app.services.model_usage.subjects import resolve_subject
from app.services.model_usage.types import (
    ReservationDecision,
    UsageContext,
    UsageEstimate,
    UsageMeterQuantity,
    validate_usage_meter_quantities,
)


@dataclass(frozen=True, slots=True)
class PreparedReservationAdmission:
    context_identity: tuple[object, ...]
    meters: tuple[UsageMeterQuantity, ...]
    at: datetime
    period: BillingPeriod
    policy: ModelUsagePolicyVersion
    subject: ModelUsageSubject
    price: UsagePriceSnapshot


def _reservation_context_identity(context: UsageContext) -> tuple[object, ...]:
    attribution = context.attribution
    return (
        attribution.family_id,
        attribution.attribution_kind,
        attribution.actor_user_id,
        context.capability,
        context.provider,
        context.requested_model,
        context.billing_model,
        context.variant_key,
    )


def prepare_reservation_admission(
    *,
    context: UsageContext,
    estimate: UsageEstimate,
    at: datetime,
    policy: ModelUsagePolicyVersion,
    subject: ModelUsageSubject,
    price: UsagePriceSnapshot,
) -> PreparedReservationAdmission:
    return PreparedReservationAdmission(
        context_identity=_reservation_context_identity(context),
        meters=tuple(estimate.meters),
        at=at,
        period=shanghai_billing_period(at),
        policy=policy,
        subject=subject,
        price=price,
    )


def _replay_reservation(
    reservation: ModelUsageReservation,
    *,
    fingerprint: str,
) -> ReservationDecision:
    if reservation.fingerprint != fingerprint:
        raise ModelUsageAttemptConflict()
    return ReservationDecision(
        decision="allowed",
        reservation_id=reservation.id,
        subject_key=reservation.subject_key,
        policy_version_id=reservation.policy_version_id,
        price_version_id=reservation.price_version_id,
        pricing_status=reservation.pricing_status,
        reserved_cost_cny=reservation.reserved_cost_cny,
    )


def _rate_map(rates: tuple[UsagePriceRateSnapshot, ...]) -> dict:
    return {rate.meter: rate for rate in rates}


def _reservation_meter_rows(
    reservation_id: str,
    estimate: UsageEstimate,
    *,
    price_rates: tuple[UsagePriceRateSnapshot, ...],
    priced: bool,
) -> tuple[ModelUsageReservationMeter, ...]:
    if len({line.meter for line in estimate.meters}) != len(estimate.meters):
        raise ModelUsageContractError("duplicate_estimate_meter")
    rates = _rate_map(price_rates)
    rows: list[ModelUsageReservationMeter] = []
    for line in estimate.meters:
        rate = rates.get(line.meter)
        cost = None
        if line.meter_role is ModelUsageMeterRole.BILLABLE and priced:
            if rate is None or rate.unit_price_cny is None:
                raise ModelUsageContractError("priced_reservation_missing_rate")
            cost = reservation_line_cost(
                line.quantity,
                rate.unit_price_cny,
                rate.unit_quantity,
            )
        rows.append(
            ModelUsageReservationMeter(
                id=create_id("usage-reserved-meter"),
                reservation_id=reservation_id,
                meter_key=line.meter.value,
                meter=line.meter,
                meter_role=line.meter_role,
                reserved_quantity=line.quantity,
                unit_quantity=rate.unit_quantity if rate else None,
                source_unit_price=rate.unit_price if rate else None,
                source_currency=rate.source_currency if rate else None,
                fx_to_cny=rate.fx_to_cny if rate else None,
                unit_price_cny=rate.unit_price_cny if rate else None,
                reserved_cost_cny=cost,
            )
        )
    return tuple(rows)


def _blocked_by_policy(
    *,
    policy: ModelUsagePolicyVersion,
    limits: tuple[ModelUsageCapabilityLimit, ...],
    context: UsageContext,
    estimate: UsageEstimate,
    counters: tuple[ModelUsagePeriodCounter, ...],
    requested_cost: Decimal | None,
) -> str | None:
    if not policy.hard_limit_enabled:
        return None
    if requested_cost is None:
        return "model_usage_price_unavailable"
    by_kind = {counter.counter_kind: counter for counter in counters if counter.meter is None}
    budget = policy.monthly_budget_cny
    if budget is None:
        return "model_usage_price_unavailable"
    family_counter = by_kind[ModelUsageCounterKind.FAMILY_COST]
    if would_exceed_limit(effective_counter_value(family_counter), requested_cost, budget):
        return "model_usage_budget_exceeded"
    quantity_by_meter = {line.meter: line.quantity for line in estimate.meters}
    for limit in limits:
        if not limit.enabled or limit.capability is not context.capability:
            continue
        if limit.limit_kind is ModelUsageLimitKind.COST:
            capability_counter = by_kind[ModelUsageCounterKind.CAPABILITY_COST]
            current = effective_counter_value(capability_counter)
            increment = requested_cost
        else:
            matching = next((item for item in counters if item.meter is limit.meter), None)
            if matching is None or limit.meter not in quantity_by_meter:
                return "model_usage_guardrail_quantity_unavailable"
            current = effective_counter_value(matching)
            increment = quantity_by_meter[limit.meter]
        if would_exceed_limit(current, increment, limit.limit_value):
            return "model_usage_capability_limit_exceeded"
    return None


def reserve_usage_in_session(
    db: Session,
    context: UsageContext,
    estimate: UsageEstimate,
    *,
    fingerprint: str,
    at: datetime,
    expected_policy_version_id: str | None = None,
    prepared_admission: PreparedReservationAdmission | None = None,
) -> ReservationDecision:
    if not fingerprint:
        raise ModelUsageContractError("reservation_fingerprint_required")
    if not estimate.meters:
        raise ModelUsageContractError("reservation_estimate_required")
    estimate = UsageEstimate(
        meters=validate_usage_meter_quantities(context.capability, estimate.meters)
    )
    family_id = context.attribution.family_id
    if prepared_admission is not None:
        if (
            prepared_admission.context_identity != _reservation_context_identity(context)
            or prepared_admission.meters != tuple(estimate.meters)
            or prepared_admission.at != at
            or prepared_admission.policy.family_id != family_id
            or prepared_admission.subject.family_id != family_id
        ):
            raise ModelUsageContractError("prepared_reservation_admission_mismatch")
        period = prepared_admission.period
        policy = prepared_admission.policy
    else:
        period = shanghai_billing_period(at)
        try:
            _, policy = lock_current_policy(db, family_id=family_id)
        except ValueError as exc:
            raise ModelUsageContractError("current_policy_missing") from exc
    if expected_policy_version_id is not None and policy.id != expected_policy_version_id:
        return ReservationDecision.blocked(
            "model_usage_policy_conflict",
            period_start=period.start_at,
            policy_version_id=policy.id,
        )

    event = lock_event_by_attempt(db, family_id=family_id, attempt_key=context.attempt_key)
    if event is not None:
        if event.fingerprint != fingerprint:
            raise ModelUsageAttemptConflict()
        return ReservationDecision.already_accounted(event.id)
    existing = lock_reservation_by_attempt(
        db,
        family_id=family_id,
        attempt_key=context.attempt_key,
    )
    if existing is not None:
        return _replay_reservation(existing, fingerprint=fingerprint)

    if prepared_admission is not None:
        subject = prepared_admission.subject
        price = prepared_admission.price
    else:
        subject = resolve_subject(db, context.attribution)
        price = select_price_snapshot(db, context, estimate, at=at)
    reservation_id = create_id("usage-reservation")
    meter_rows = _reservation_meter_rows(
        reservation_id,
        estimate,
        price_rates=price.rates,
        priced=price.pricing_status is ModelUsagePricingStatus.PRICED,
    )
    reserved_cost = (
        sum(
            (row.reserved_cost_cny for row in meter_rows if row.reserved_cost_cny is not None),
            Decimal("0"),
        )
        if price.pricing_status is ModelUsagePricingStatus.PRICED
        else None
    )
    if policy.hard_limit_enabled and reserved_cost is None:
        return ReservationDecision.blocked(
            "model_usage_price_unavailable",
            period_start=period.start_at,
            policy_version_id=policy.id,
        )

    reservation = ModelUsageReservation(
        id=reservation_id,
        attempt_key=context.attempt_key,
        client_attempt_id=context.client_attempt_id,
        fingerprint=fingerprint,
        family_id=family_id,
        subject_id=subject.id,
        subject_key=subject.subject_key,
        attribution_kind=context.attribution.attribution_kind,
        operation_source=context.attribution.operation_source,
        logical_operation_id=context.attribution.logical_operation_id,
        operation_kind=context.operation_kind,
        capability=context.capability,
        provider=context.provider,
        requested_model=context.requested_model,
        billing_model=price.billing_model,
        variant_key=context.variant_key,
        billing_scheme_key=price.billing_scheme_key or "unpriced",
        recovery_mode=ModelUsageRecoveryMode.NONE,
        idempotency_window_seconds=None,
        query_window_seconds=None,
        automatic_resend_deadline_at=None,
        provider_idempotency_key=None,
        policy_version_id=policy.id,
        dispatch_policy_version_id=None,
        pre_dispatch_denial_policy_version_id=None,
        pricing_status=price.pricing_status,
        price_version_id=price.price_version_id,
        price_snapshot_checksum=price.checksum,
        period_start=period.start_at,
        period_end=period.end_at,
        reserved_cost_cny=reserved_cost,
        status=ModelUsageReservationStatus.RESERVED,
        provider_request_id=None,
        reserved_at=at,
        dispatching_at=None,
        provider_acknowledged_at=None,
        expires_at=at + timedelta(hours=24),
        error_code=None,
    )
    savepoint = db.begin_nested()
    try:
        db.add(reservation)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        winner = lock_reservation_by_attempt(
            db,
            family_id=family_id,
            attempt_key=context.attempt_key,
        )
        if winner is None:
            raise
        return _replay_reservation(winner, fingerprint=fingerprint)
    else:
        savepoint.commit()

    counters = lock_or_create_counters(
        db,
        contract_counter_keys(context, estimate, period),
    )
    limits = tuple(
        db.scalars(
            select(ModelUsageCapabilityLimit).where(
                ModelUsageCapabilityLimit.policy_version_id == policy.id
            )
        )
    )
    error_code = _blocked_by_policy(
        policy=policy,
        limits=limits,
        context=context,
        estimate=estimate,
        counters=counters,
        requested_cost=reserved_cost,
    )
    if error_code:
        db.delete(reservation)
        db.flush()
        return ReservationDecision.blocked(
            error_code,
            period_start=period.start_at,
            policy_version_id=policy.id,
        )

    db.add_all(meter_rows)
    quantities = {line.meter: line.quantity for line in estimate.meters}
    for counter in counters:
        delta = (
            reserved_cost
            if counter.counter_kind
            in {ModelUsageCounterKind.FAMILY_COST, ModelUsageCounterKind.CAPABILITY_COST}
            else quantities[counter.meter]
        )
        if delta is not None:
            counter.reserved_value += delta
            counter.version += 1
    db.flush()
    return _replay_reservation(reservation, fingerprint=fingerprint)


def reserve_usage(
    context: UsageContext,
    estimate: UsageEstimate,
    *,
    fingerprint: str,
    session_factory: Callable[[], Session] = SessionLocal,
) -> ReservationDecision:
    with session_factory() as db:
        with db.begin():
            return reserve_usage_in_session(
                db,
                context,
                estimate,
                fingerprint=fingerprint,
                at=utcnow(),
            )


def release_undispatched_reservation_in_session(
    db: Session,
    *,
    reservation_id: str,
    error_code: str,
) -> bool:
    """Release only a reservation proven not to have entered dispatching.

    Recovery callers use this before creating a fresh logical attempt.  The
    family pointer, reservation and counters are locked in the same order as
    normal dispatch, so a concurrent dispatch wins deterministically instead
    of racing a budget release against a provider send.
    """

    identity = db.get(ModelUsageReservation, reservation_id)
    if identity is None:
        return False
    lock_family_policy(db, family_id=identity.family_id)
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(
            ModelUsageReservation.id == reservation_id,
            ModelUsageReservation.family_id == identity.family_id,
        )
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if reservation is None or reservation.status is not ModelUsageReservationStatus.RESERVED:
        return False
    meters = tuple(
        db.scalars(
            select(ModelUsageReservationMeter)
            .where(ModelUsageReservationMeter.reservation_id == reservation.id)
            .order_by(ModelUsageReservationMeter.meter_key)
        )
    )
    # Reuse the shared deterministic counter lock/release implementation.  It
    # does not call back into this module, so the import remains acyclic.
    from app.services.model_usage.dispatch import _lock_counters, _remove_reserved

    counters = _lock_counters(db, reservation, meters)
    _remove_reserved(reservation, meters, counters)
    reservation.status = transition_reservation(
        reservation.status,
        ModelUsageReservationStatus.RELEASED,
    )
    reservation.error_code = error_code
    db.flush()
    return True
