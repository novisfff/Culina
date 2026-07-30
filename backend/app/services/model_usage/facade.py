from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock

from sqlalchemy.exc import DBAPIError, IntegrityError, SQLAlchemyError, TimeoutError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import ModelUsageCapability, ModelUsagePricingStatus
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.models.model_usage import ModelUsagePolicyVersion
from app.services.model_usage.errors import (
    ModelUsageLedgerUnavailable,
    ModelUsageProofConsumed,
)
from app.services.model_usage.periods import BillingPeriod, shanghai_billing_period
from app.services.model_usage.outage_latch import ModelUsageOutageLatch
from app.services.model_usage.policies import lock_family_policy
from app.services.model_usage.pricing import UsagePriceSnapshot, select_price_snapshot
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.subjects import resolve_subject
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderRecoveryPolicy,
    ReservationDecision,
    UsageContext,
    UsageEstimate,
    UsageMeterQuantity,
)


PROOF_TTL = timedelta(seconds=5)


@dataclass(frozen=True, slots=True)
class DispatchEligibilityProof:
    proof_id: str
    family_id: str
    subject_key: str
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    billing_model: str
    variant_key: str
    billing_scheme_key: str
    attempt_key: str
    client_attempt_id: str
    fingerprint: str
    policy_version_id: str
    hard_limit_enabled: bool
    issued_at: datetime
    expires_at: datetime
    period: BillingPeriod
    pricing_status: ModelUsagePricingStatus
    price_version_id: str | None
    price_snapshot: UsagePriceSnapshot
    price_snapshot_checksum: str | None
    recovery_policy: ProviderRecoveryPolicy
    required_meters: tuple[UsageMeterQuantity, ...]


class FailOpenPermitRegistry:
    def __init__(self) -> None:
        self._lock = Lock()
        self._states: dict[str, str] = {}

    def register(self, proof_id: str) -> None:
        with self._lock:
            if proof_id in self._states:
                raise ModelUsageProofConsumed()
            self._states[proof_id] = "pending"

    def consume(self, proof_id: str) -> None:
        with self._lock:
            if self._states.get(proof_id) != "pending":
                raise ModelUsageProofConsumed()
            self._states[proof_id] = "consumed"

    def consume_once(self, permit: DispatchPermit, *, at: datetime) -> DispatchPermit:
        if (
            permit.send_kind != "fail_open_single_send"
            or permit.fail_open_proof_id is None
            or permit.expires_at is None
            or at > permit.expires_at
        ):
            raise ModelUsageProofConsumed()
        self.consume(permit.fail_open_proof_id)
        return permit


process_fail_open_permit_registry = FailOpenPermitRegistry()
process_model_usage_outage_latch = ModelUsageOutageLatch()


def _monitoring_dispatch_eligibility(
    db: Session,
    *,
    context: UsageContext,
    estimate: UsageEstimate,
    fingerprint: str,
    at: datetime,
    proof_ttl: timedelta = PROOF_TTL,
) -> DispatchEligibilityProof | None:
    pointer = lock_family_policy(db, family_id=context.attribution.family_id)
    policy = db.get(ModelUsagePolicyVersion, pointer.current_policy_version_id)
    if policy is None:
        raise ModelUsageLedgerUnavailable()
    if policy.hard_limit_enabled:
        return None
    subject = resolve_subject(db, context.attribution)
    price = select_price_snapshot(db, context, estimate, at=at)
    period = shanghai_billing_period(at)
    return DispatchEligibilityProof(
        proof_id=f"mup_{secrets.token_urlsafe(24)}",
        family_id=context.attribution.family_id,
        subject_key=subject.subject_key,
        capability=context.capability,
        provider=context.provider,
        requested_model=context.requested_model,
        billing_model=price.billing_model,
        variant_key=context.variant_key,
        billing_scheme_key=price.billing_scheme_key or "unpriced",
        attempt_key=context.attempt_key,
        client_attempt_id=context.client_attempt_id,
        fingerprint=fingerprint,
        policy_version_id=policy.id,
        hard_limit_enabled=False,
        issued_at=at,
        expires_at=at + proof_ttl,
        period=period,
        pricing_status=price.pricing_status,
        price_version_id=price.price_version_id,
        price_snapshot=price,
        price_snapshot_checksum=price.checksum,
        recovery_policy=ProviderRecoveryPolicy.none(),
        required_meters=tuple(estimate.meters),
    )


def prove_monitoring_dispatch_eligibility(
    db: Session,
    *,
    context: UsageContext,
    estimate: UsageEstimate,
    fingerprint: str,
    at: datetime,
    proof_ttl: timedelta = PROOF_TTL,
) -> DispatchEligibilityProof:
    proof = _monitoring_dispatch_eligibility(
        db,
        context=context,
        estimate=estimate,
        fingerprint=fingerprint,
        at=at,
        proof_ttl=proof_ttl,
    )
    if proof is None:
        raise ModelUsageLedgerUnavailable()
    return proof


def exchange_proof_for_permit(
    proof: DispatchEligibilityProof,
    *,
    registry: FailOpenPermitRegistry,
    at: datetime,
) -> DispatchPermit:
    if proof.hard_limit_enabled or at > proof.expires_at:
        raise ModelUsageProofConsumed()
    registry.register(proof.proof_id)
    return DispatchPermit(
        reservation_id=None,
        send_kind="fail_open_single_send",
        family_id=proof.family_id,
        subject_key=proof.subject_key,
        capability=proof.capability,
        provider=proof.provider,
        requested_model=proof.requested_model,
        billing_model=proof.billing_model,
        variant_key=proof.variant_key,
        billing_scheme_key=proof.billing_scheme_key,
        attempt_key=proof.attempt_key,
        fingerprint=proof.fingerprint,
        client_attempt_id=proof.client_attempt_id,
        policy_version_id=proof.policy_version_id,
        dispatch_policy_version_id=proof.policy_version_id,
        pricing_status=proof.pricing_status,
        period=proof.period,
        dispatched_at=at,
        price_version_id=proof.price_version_id,
        price_snapshot=proof.price_snapshot,
        price_snapshot_checksum=proof.price_snapshot_checksum,
        provider_idempotency_key=None,
        recovery_policy=proof.recovery_policy,
        fail_open_proof_id=proof.proof_id,
        expires_at=proof.expires_at,
        required_meters=proof.required_meters,
    )


def consume_fail_open_dispatch_permit(
    permit: DispatchPermit,
    *,
    at: datetime,
    registry: FailOpenPermitRegistry = process_fail_open_permit_registry,
) -> DispatchPermit:
    return registry.consume_once(permit, at=at)


class LedgerCommitOutcomeUnknown(SQLAlchemyError):
    pass


def is_model_usage_ledger_unavailable(exc: BaseException) -> bool:
    if isinstance(exc, (IntegrityError,)):
        return False
    if isinstance(exc, (TimeoutError, LedgerCommitOutcomeUnknown)):
        return True
    if isinstance(exc, DBAPIError):
        if exc.connection_invalidated:
            return True
        code = getattr(exc.orig, "args", (None,))[0]
        return code in {2006, 2013, 2055}
    return False


class ModelUsageFacade:
    def __init__(
        self,
        *,
        session_factory: Callable[[], Session] = SessionLocal,
        registry: FailOpenPermitRegistry | None = None,
        outage_latch: ModelUsageOutageLatch | None = None,
        source_instance: str | None = None,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._session_factory = session_factory
        self._registry = registry or FailOpenPermitRegistry()
        self._outage_latch = outage_latch or process_model_usage_outage_latch
        configured = get_settings()
        self._source_instance = source_instance or configured.model_usage_source_instance
        self._proof_ttl = timedelta(
            seconds=configured.model_usage_fail_open_proof_ttl_seconds
        )
        self._clock = clock

    def consume_fail_open_dispatch_permit(
        self,
        permit: DispatchPermit,
        *,
        at: datetime | None = None,
    ) -> DispatchPermit:
        return consume_fail_open_dispatch_permit(
            permit,
            at=at or self._clock(),
            registry=self._registry,
        )

    def reserve(
        self,
        context: UsageContext,
        estimate: UsageEstimate,
        *,
        fingerprint: str,
        at: datetime | None = None,
    ) -> ReservationDecision:
        proof: DispatchEligibilityProof | None = None
        reservation_at = at or self._clock()
        try:
            with self._session_factory() as db:
                proof = _monitoring_dispatch_eligibility(
                    db,
                    context=context,
                    estimate=estimate,
                    fingerprint=fingerprint,
                    at=reservation_at,
                    proof_ttl=self._proof_ttl,
                )
                decision = reserve_usage_in_session(
                    db,
                    context,
                    estimate,
                    fingerprint=fingerprint,
                    at=reservation_at,
                    expected_policy_version_id=(
                        proof.policy_version_id if proof is not None else None
                    ),
                )
                db.commit()
                return decision
        except ModelUsageLedgerUnavailable:
            return ReservationDecision.blocked("model_usage_ledger_unavailable")
        except SQLAlchemyError as exc:
            if proof is None or not is_model_usage_ledger_unavailable(exc):
                return ReservationDecision.blocked("model_usage_ledger_unavailable")
            dispatch_at = self._clock()
            if shanghai_billing_period(dispatch_at) != proof.period:
                return ReservationDecision.blocked("model_usage_ledger_unavailable")
            try:
                permit = exchange_proof_for_permit(
                    proof,
                    registry=self._registry,
                    at=dispatch_at,
                )
            except ModelUsageProofConsumed:
                return ReservationDecision.blocked("model_usage_ledger_unavailable")
            self._outage_latch.record_exact_attempt(
                family_id=proof.family_id,
                subject_key=proof.subject_key,
                capability=proof.capability,
                client_attempt_id=proof.client_attempt_id,
                occurred_at=dispatch_at,
                source_instance=self._source_instance,
            )
            return ReservationDecision(
                decision="fail_open",
                subject_key=proof.subject_key,
                policy_version_id=proof.policy_version_id,
                price_version_id=proof.price_version_id,
                pricing_status=proof.pricing_status,
                fail_open_permit=permit,
            )
