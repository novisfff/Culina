from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCounterKind,
    ModelUsageLimitKind,
    ModelUsagePricingStatus,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
)
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.models.model_usage import (
    ModelUsageCapabilityLimit,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
    ModelUsageReservation,
    ModelUsageReservationMeter,
)
from app.services.model_usage.counters import (
    capability_cost_dimension_key,
    capability_meter_dimension_key,
    effective_counter_value,
    family_cost_dimension_key,
)
from app.services.model_usage.errors import (
    ModelUsageAttemptConflict,
    ModelUsageContractError,
    ModelUsageStateError,
)
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.policies import lock_family_policy
from app.services.model_usage.pricing import UsagePriceRateSnapshot, UsagePriceSnapshot
from app.services.model_usage.state_machine import transition_reservation
from app.services.model_usage.types import (
    DispatchGateOutcome,
    DispatchPermit,
    ProviderRecoveryPolicy,
    UsageMeterQuantity,
)


def _database_utc(value: datetime) -> datetime:
    """Treat timezone-less MySQL datetime values as stored UTC instants."""

    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _validate_recovery_policy(policy: ProviderRecoveryPolicy) -> None:
    if policy.mode is ModelUsageRecoveryMode.NONE:
        if any(
            value is not None
            for value in (
                policy.idempotency_window_seconds,
                policy.query_window_seconds,
                policy.automatic_resend_deadline_seconds,
            )
        ):
            raise ModelUsageContractError("none_recovery_forbids_windows")
        return
    if policy.mode in {
        ModelUsageRecoveryMode.IDEMPOTENCY_KEY,
        ModelUsageRecoveryMode.IDEMPOTENCY_AND_QUERYABLE,
    } and (policy.idempotency_window_seconds or 0) <= 0:
        raise ModelUsageContractError("idempotency_window_required")
    if policy.mode in {
        ModelUsageRecoveryMode.QUERYABLE_REQUEST,
        ModelUsageRecoveryMode.IDEMPOTENCY_AND_QUERYABLE,
    } and (policy.query_window_seconds or 0) <= 0:
        raise ModelUsageContractError("query_window_required")


def _lock_counters(
    db: Session,
    reservation: ModelUsageReservation,
    meters: tuple[ModelUsageReservationMeter, ...],
) -> tuple[ModelUsagePeriodCounter, ...]:
    dimensions = [
        family_cost_dimension_key(),
        capability_cost_dimension_key(reservation.capability),
        *[
            capability_meter_dimension_key(reservation.capability, row.meter)
            for row in sorted(meters, key=lambda item: item.meter.value)
        ],
    ]
    rows = tuple(
        db.scalars(
            select(ModelUsagePeriodCounter)
            .where(
                ModelUsagePeriodCounter.family_id == reservation.family_id,
                ModelUsagePeriodCounter.period_start == reservation.period_start,
                ModelUsagePeriodCounter.dimension_key.in_(dimensions),
            )
            .order_by(ModelUsagePeriodCounter.dimension_key)
            .with_for_update()
        )
    )
    by_dimension = {row.dimension_key: row for row in rows}
    try:
        return tuple(by_dimension[dimension] for dimension in dimensions)
    except KeyError as exc:
        raise ModelUsageStateError("reservation_counter_missing") from exc


def _current_policy_error(
    policy: ModelUsagePolicyVersion,
    reservation: ModelUsageReservation,
    meters: tuple[ModelUsageReservationMeter, ...],
    counters: tuple[ModelUsagePeriodCounter, ...],
    limits: tuple[ModelUsageCapabilityLimit, ...],
) -> str | None:
    if not policy.hard_limit_enabled:
        return None
    if reservation.pricing_status is ModelUsagePricingStatus.UNPRICED:
        return "model_usage_price_unavailable"
    by_dimension = {row.dimension_key: row for row in counters}
    family = by_dimension[family_cost_dimension_key()]
    if policy.monthly_budget_cny is None:
        return "model_usage_price_unavailable"
    if effective_counter_value(family) > policy.monthly_budget_cny:
        return "model_usage_budget_exceeded"
    quantities = {row.meter: row.reserved_quantity for row in meters}
    for limit in limits:
        if not limit.enabled or limit.capability is not reservation.capability:
            continue
        dimension = (
            capability_cost_dimension_key(reservation.capability)
            if limit.limit_kind is ModelUsageLimitKind.COST
            else capability_meter_dimension_key(reservation.capability, limit.meter)
        )
        counter = by_dimension.get(dimension)
        if counter is None or (
            limit.limit_kind is ModelUsageLimitKind.METER and limit.meter not in quantities
        ):
            return "model_usage_guardrail_quantity_unavailable"
        if effective_counter_value(counter) > limit.limit_value:
            return "model_usage_capability_limit_exceeded"
    return None


def _remove_reserved(
    reservation: ModelUsageReservation,
    meters: tuple[ModelUsageReservationMeter, ...],
    counters: tuple[ModelUsagePeriodCounter, ...],
) -> None:
    quantities = {row.meter: row.reserved_quantity for row in meters}
    for counter in counters:
        delta = (
            reservation.reserved_cost_cny
            if counter.counter_kind
            in {ModelUsageCounterKind.FAMILY_COST, ModelUsageCounterKind.CAPABILITY_COST}
            else quantities[counter.meter]
        )
        if delta is not None:
            if counter.reserved_value < delta:
                raise ModelUsageStateError("reserved_counter_underflow")
            counter.reserved_value -= delta
            counter.version += 1


def _price_snapshot(
    reservation: ModelUsageReservation,
    meters: tuple[ModelUsageReservationMeter, ...],
) -> UsagePriceSnapshot:
    rates = tuple(
        UsagePriceRateSnapshot(
            meter=row.meter,
            meter_role=row.meter_role,
            unit_quantity=row.unit_quantity or Decimal("1"),
            unit_price=row.source_unit_price,
            source_currency=row.source_currency,
            fx_to_cny=row.fx_to_cny,
            unit_price_cny=row.unit_price_cny,
        )
        for row in meters
        if row.unit_quantity is not None
    )
    return UsagePriceSnapshot(
        pricing_status=reservation.pricing_status,
        price_version_id=reservation.price_version_id,
        billing_model=reservation.billing_model,
        billing_scheme_key=reservation.billing_scheme_key,
        rates=rates,
        missing_billable_meters=frozenset(),
        checksum=reservation.price_snapshot_checksum,
    )


def _permit(
    reservation: ModelUsageReservation,
    meters: tuple[ModelUsageReservationMeter, ...],
) -> DispatchPermit:
    if reservation.dispatching_at is None:
        raise ModelUsageStateError("reservation_dispatch_time_missing")
    period_start = _database_utc(reservation.period_start)
    period_end = _database_utc(reservation.period_end)
    dispatched_at = _database_utc(reservation.dispatching_at)
    return DispatchPermit(
        reservation_id=reservation.id,
        send_kind="first_send",
        family_id=reservation.family_id,
        subject_key=reservation.subject_key,
        capability=reservation.capability,
        provider=reservation.provider,
        requested_model=reservation.requested_model,
        billing_model=reservation.billing_model,
        variant_key=reservation.variant_key,
        billing_scheme_key=reservation.billing_scheme_key,
        attempt_key=reservation.attempt_key,
        fingerprint=reservation.fingerprint,
        client_attempt_id=reservation.client_attempt_id,
        policy_version_id=reservation.policy_version_id,
        dispatch_policy_version_id=reservation.dispatch_policy_version_id or "",
        pricing_status=reservation.pricing_status,
        period=BillingPeriod(
            local_month=period_start.astimezone(SHANGHAI).strftime("%Y-%m"),
            start_at=period_start,
            end_at=period_end,
        ),
        dispatched_at=dispatched_at,
        price_version_id=reservation.price_version_id,
        price_snapshot=_price_snapshot(reservation, meters),
        price_snapshot_checksum=reservation.price_snapshot_checksum,
        provider_idempotency_key=reservation.provider_idempotency_key,
        recovery_policy=ProviderRecoveryPolicy(
            mode=reservation.recovery_mode,
            idempotency_window_seconds=reservation.idempotency_window_seconds,
            query_window_seconds=reservation.query_window_seconds,
            automatic_resend_deadline_seconds=(
                int((reservation.automatic_resend_deadline_at - reservation.dispatching_at).total_seconds())
                if reservation.automatic_resend_deadline_at and reservation.dispatching_at
                else None
            ),
        ),
        required_meters=tuple(
            UsageMeterQuantity(
                meter=row.meter,
                quantity=row.reserved_quantity,
                meter_role=row.meter_role,
                quantity_source=ModelUsageQuantitySource.ESTIMATED,
            )
            for row in meters
        ),
    )


def prepare_usage_dispatch_in_session(
    db: Session,
    *,
    reservation_id: str,
    fingerprint: str,
    recovery_policy: ProviderRecoveryPolicy,
    at: datetime | None = None,
) -> DispatchGateOutcome:
    _validate_recovery_policy(recovery_policy)
    # All currently configured production adapters explicitly use recovery_mode=none.
    # A caller may not upgrade that trusted contract by supplying wider windows.
    if recovery_policy != ProviderRecoveryPolicy.none():
        raise ModelUsageContractError("untrusted_recovery_policy")
    identity = db.get(ModelUsageReservation, reservation_id)
    if identity is None:
        raise ModelUsageStateError("reservation_not_found")
    pointer = lock_family_policy(db, family_id=identity.family_id)
    policy = db.get(ModelUsagePolicyVersion, pointer.current_policy_version_id)
    reservation = db.scalar(
        select(ModelUsageReservation)
        .where(
            ModelUsageReservation.id == reservation_id,
            ModelUsageReservation.family_id == identity.family_id,
        )
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    if reservation is None or policy is None:
        raise ModelUsageStateError("dispatch_identity_missing")
    if reservation.fingerprint != fingerprint:
        raise ModelUsageAttemptConflict()
    if reservation.status is ModelUsageReservationStatus.DISPATCHING:
        return DispatchGateOutcome(
            decision="recovery_required",
            existing_dispatch_id=reservation.client_attempt_id,
            error_code="model_usage_dispatch_recovery_required",
        )
    if reservation.status is not ModelUsageReservationStatus.RESERVED:
        raise ModelUsageStateError("reservation_not_dispatchable")
    meters = tuple(
        db.scalars(
            select(ModelUsageReservationMeter)
            .where(ModelUsageReservationMeter.reservation_id == reservation.id)
            .order_by(ModelUsageReservationMeter.meter_key)
        )
    )
    counters = _lock_counters(db, reservation, meters)
    limits = tuple(
        db.scalars(
            select(ModelUsageCapabilityLimit).where(
                ModelUsageCapabilityLimit.policy_version_id == policy.id
            )
        )
    )
    error = _current_policy_error(policy, reservation, meters, counters, limits)
    if error:
        _remove_reserved(reservation, meters, counters)
        reservation.status = transition_reservation(
            reservation.status,
            ModelUsageReservationStatus.RELEASED,
        )
        reservation.pre_dispatch_denial_policy_version_id = policy.id
        reservation.dispatch_policy_version_id = None
        reservation.error_code = error
        db.flush()
        return DispatchGateOutcome.blocked(
            error,
            period_start=reservation.period_start,
            policy_version_id=policy.id,
        )
    reservation.status = transition_reservation(
        reservation.status,
        ModelUsageReservationStatus.DISPATCHING,
    )
    reservation.dispatch_policy_version_id = policy.id
    reservation.pre_dispatch_denial_policy_version_id = None
    reservation.recovery_mode = recovery_policy.mode
    reservation.idempotency_window_seconds = recovery_policy.idempotency_window_seconds
    reservation.query_window_seconds = recovery_policy.query_window_seconds
    # The initial governance schema stores MySQL datetimes at whole-second
    # precision.  Persist the same normalized timestamp carried by the permit
    # so a signed receipt can be verified after the reservation is reloaded.
    reservation.dispatching_at = (at or utcnow()).replace(microsecond=0)
    reservation.provider_idempotency_key = (
        reservation.client_attempt_id
        if recovery_policy.mode
        in {ModelUsageRecoveryMode.IDEMPOTENCY_KEY, ModelUsageRecoveryMode.IDEMPOTENCY_AND_QUERYABLE}
        else None
    )
    reservation.automatic_resend_deadline_at = (
        reservation.dispatching_at + timedelta(seconds=recovery_policy.automatic_resend_deadline_seconds)
        if recovery_policy.automatic_resend_deadline_seconds is not None
        else None
    )
    db.flush()
    return DispatchGateOutcome(decision="allowed", permit=_permit(reservation, meters))


def prepare_usage_dispatch(
    reservation_id: str,
    *,
    fingerprint: str,
    recovery_policy: ProviderRecoveryPolicy,
    session_factory: Callable[[], Session] = SessionLocal,
    at: datetime | None = None,
) -> DispatchPermit:
    with session_factory() as db:
        with db.begin():
            outcome = prepare_usage_dispatch_in_session(
                db,
                reservation_id=reservation_id,
                fingerprint=fingerprint,
                recovery_policy=recovery_policy,
                at=at,
            )
    return outcome.require_first_send_permit()
