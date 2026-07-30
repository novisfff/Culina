from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.utils import utcnow
from app.services.model_usage.dispatch import prepare_usage_dispatch
from app.services.model_usage.errors import (
    ModelUsageAttemptAlreadyAccounted,
    ModelUsageBlocked,
    ModelUsageContractError,
    ModelUsageDispatchRecoveryRequired,
)
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.recovery import (
    RecoveryAdjustmentRequired,
    record_usage_uncertain,
    recover_fail_open_receipt_in_session,
)
from app.services.model_usage.settlement import settle_usage
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderRecoveryPolicy,
    ProviderUsageReceipt,
    UsageContext,
    UsageEstimate,
    UsageSettlement,
)


@dataclass(slots=True)
class MeteredProviderAttempt:
    """One durable provider-send attempt.

    A fresh instance represents one physical provider send.  Replays with the
    same attempt key/fingerprint resolve to the existing reservation, but a
    caller must still obtain a dispatch permit before it can send anything.
    """

    usage_facade: ModelUsageFacade
    session_factory: Callable[[], Session]
    signer: ProviderUsageReceiptSigner
    context: UsageContext
    estimate: UsageEstimate
    fingerprint: str
    reservation_id: str | None
    fail_open_permit: DispatchPermit | None
    clock: Callable[[], datetime]
    _permit: DispatchPermit | None = None
    _dispatched: bool = False

    @property
    def attempt_key(self) -> str:
        return self.context.attempt_key

    @property
    def client_attempt_id(self) -> str:
        return self.context.client_attempt_id

    def prepare_dispatch(self) -> DispatchPermit:
        """Atomically move the reservation into dispatching before a send."""

        if self._dispatched or self._permit is not None:
            raise ModelUsageDispatchRecoveryRequired()
        if self.reservation_id is not None:
            permit = prepare_usage_dispatch(
                self.reservation_id,
                fingerprint=self.fingerprint,
                recovery_policy=ProviderRecoveryPolicy.none(),
                session_factory=self.session_factory,
            )
        elif self.fail_open_permit is not None:
            permit = self.usage_facade.consume_fail_open_dispatch_permit(
                self.fail_open_permit,
                at=self.clock(),
            )
        else:  # defensive: construction is private to MeteredProviderAdapter.
            raise ModelUsageContractError("provider_attempt_missing_dispatch_identity")
        self._permit = permit
        self._dispatched = True
        return permit

    def settle(self, receipt: ProviderUsageReceipt) -> UsageSettlement:
        """Persist a terminal receipt exactly once.

        Fail-open receipts deliberately use the recovery path because they have
        no reservation row.  The consumed permit is supplied so recovery can
        verify that this process actually authorised the one remote send.
        """

        if not self._dispatched or self._permit is None:
            raise ModelUsageContractError("provider_attempt_not_dispatched")
        if self.reservation_id is not None:
            return settle_usage(
                receipt,
                signer=self.signer,
                session_factory=self.session_factory,
            )
        with self.session_factory() as db:
            with db.begin():
                result = recover_fail_open_receipt_in_session(
                    db,
                    receipt,
                    signer=self.signer,
                    consumed_permit=self._permit,
                )
        if isinstance(result, RecoveryAdjustmentRequired):
            raise ModelUsageContractError("provider_attempt_requires_adjustment")
        return result

    def mark_uncertain(self, stable_error_code: str) -> None:
        """Record an ambiguous post-dispatch outcome and prohibit auto-resend."""

        if not self._dispatched:
            raise ModelUsageContractError("provider_attempt_not_dispatched")
        if self.reservation_id is None:
            # A fail-open permit was already registered as an exact outage
            # attempt.  It has no reservation row to transition, and a retry
            # would risk an unaccounted duplicate external send.
            return
        record_usage_uncertain(
            self.reservation_id,
            stable_error_code=stable_error_code,
            session_factory=self.session_factory,
        )


@dataclass(slots=True)
class MeteredProviderAdapter:
    """Common reserve/dispatch lifecycle for a concrete provider adapter."""

    usage_facade: ModelUsageFacade
    session_factory: Callable[[], Session]
    signer: ProviderUsageReceiptSigner
    clock: Callable[[], datetime] = utcnow

    def start_attempt(
        self,
        context: UsageContext,
        estimate: UsageEstimate,
        *,
        fingerprint: str,
    ) -> MeteredProviderAttempt:
        decision = self.usage_facade.reserve(context, estimate, fingerprint=fingerprint)
        if decision.decision == "blocked":
            raise ModelUsageBlocked(
                decision.error_code or "model_usage_blocked",
                period_start=decision.period_start,
                policy_version_id=decision.policy_version_id,
            )
        if decision.decision == "already_accounted":
            error = ModelUsageAttemptAlreadyAccounted()
            error.existing_event_id = decision.existing_event_id  # type: ignore[attr-defined]
            raise error
        if decision.decision == "allowed" and decision.reservation_id is None:
            raise ModelUsageContractError("provider_attempt_reservation_missing")
        if decision.decision == "fail_open" and decision.fail_open_permit is None:
            raise ModelUsageContractError("provider_attempt_fail_open_permit_missing")
        return MeteredProviderAttempt(
            usage_facade=self.usage_facade,
            session_factory=self.session_factory,
            signer=self.signer,
            context=context,
            estimate=estimate,
            fingerprint=fingerprint,
            reservation_id=decision.reservation_id,
            fail_open_permit=decision.fail_open_permit,
            clock=self.clock,
        )
