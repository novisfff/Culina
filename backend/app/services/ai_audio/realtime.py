from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from threading import RLock
from typing import Literal

from fastapi import HTTPException, status

from app.core.enums import ModelUsageMeter
from app.core.utils import utcnow
from app.services.model_usage.adapters.realtime_audio import (
    ActiveRealtimeUsageLease,
    RealtimeAudioUsageAdapter,
)
from app.services.model_usage.decimal_math import quantize_quantity
from app.services.model_usage.errors import (
    ModelUsageAttemptAlreadyAccounted,
    ModelUsageBlocked,
    ModelUsageContractError,
    ModelUsageDispatchRecoveryRequired,
    ModelUsageSettlementPending,
)
from app.services.model_usage.types import UsageSettlement


@dataclass(slots=True)
class CumulativeAudioClock:
    """Server-observed, content-free duration clock for a voice session."""

    total: Decimal = Decimal("0")

    def add(self, duration_seconds: Decimal) -> None:
        if not isinstance(duration_seconds, Decimal):
            raise ModelUsageContractError("realtime_audio_clock_invalid")
        try:
            normalized = quantize_quantity(duration_seconds)
        except (TypeError, ValueError, ArithmeticError) as exc:
            raise ModelUsageContractError("realtime_audio_clock_invalid") from exc
        if normalized != duration_seconds:
            raise ModelUsageContractError("realtime_audio_clock_invalid")
        self.total += normalized


@dataclass(slots=True)
class CumulativeCharacterClock:
    total: Decimal = Decimal("0")

    def add(self, character_count: int) -> None:
        if (
            isinstance(character_count, bool)
            or not isinstance(character_count, int)
            or character_count <= 0
        ):
            raise ModelUsageContractError("realtime_tts_character_count_invalid")
        self.total += Decimal(character_count)


@dataclass(frozen=True, slots=True)
class RealtimeLeaseOutcome:
    """The only decisions a realtime provider send may act on."""

    decision: Literal["active", "renewed", "blocked", "ended", "settlement_pending"]
    lease: ActiveRealtimeUsageLease | None = None
    settlement: UsageSettlement | None = None
    previous_settlement: UsageSettlement | None = None
    error_code: str | None = None

    @property
    def may_send_audio(self) -> bool:
        return self.decision in {"active", "renewed"} and self.lease is not None


@dataclass(slots=True)
class RealtimeProviderOperation:
    """An in-gate remote provider operation for one live realtime lease."""

    scope: RealtimeProviderScope
    outcome: RealtimeLeaseOutcome

    @property
    def decision(self) -> str:
        return self.outcome.decision

    @property
    def lease(self) -> ActiveRealtimeUsageLease | None:
        return self.outcome.lease

    @property
    def previous_settlement(self) -> UsageSettlement | None:
        return self.outcome.previous_settlement

    @property
    def error_code(self) -> str | None:
        return self.outcome.error_code

    def add_input_seconds(self, duration_seconds: Decimal) -> None:
        self._require_active().input_clock.add(duration_seconds)

    def add_output_seconds(self, duration_seconds: Decimal) -> None:
        self._require_active().output_clock.add(duration_seconds)

    def add_tts_characters(self, character_count: int) -> None:
        scope = self._require_active()
        lease = self.lease
        if lease is None:  # pragma: no cover - guarded by _require_active
            raise ModelUsageContractError("realtime_provider_send_not_authorized")
        cap = scope.usage_adapter._variant().tts_characters_per_lease_cap
        if cap is None:
            raise ModelUsageContractError("realtime_tts_character_meter_not_enabled")
        projected = scope.tts_character_clock.total + Decimal(character_count)
        if projected - lease.server_tts_character_baseline > Decimal(cap):
            raise ModelUsageContractError("realtime_tts_character_cap_exceeded")
        scope.tts_character_clock.add(character_count)

    def abort_before_provider_send(self) -> RealtimeLeaseOutcome:
        """Release a permit whose credential could not be obtained.

        ``provider_audio_operation`` holds the per-session lease lock while
        user code executes, so this is safe only from inside that context.  It
        records the known no-send outcome instead of incorrectly marking a
        dispatch-pinned credential lookup failure as an uncertain provider
        request.
        """

        lease = self.lease
        if lease is None or not self.outcome.may_send_audio:
            raise ModelUsageContractError("realtime_provider_send_not_authorized")
        self.outcome = self.scope._abort_lease_before_provider_send_locked(
            lease,
            completed_at=utcnow(),
        )
        return self.outcome

    def _require_active(self) -> RealtimeProviderScope:
        if not self.outcome.may_send_audio:
            raise ModelUsageContractError("realtime_provider_send_not_authorized")
        return self.scope


@dataclass(slots=True)
class RealtimeVoiceSessionState:
    session_id: str
    family_id: str
    user_id: str
    # A realtime session is pinned to one immutable family configuration
    # revision.  It does not remember a provider label selected by a client.
    config_revision_id: str
    provider_profile_id: str
    provider_profile_version_id: str
    requested_model: str
    binding_identity_checksum: str
    adapter_kind: str
    recipe_id: str
    cook_session_id: str
    session_revision: int
    subject: dict
    created_at: datetime
    expires_at: datetime
    status: str = "listening"
    current_provider_attempt_key: str | None = None
    last_user_transcript: str = ""
    last_ai_run_id: str = ""
    next_lease_sequence: int = 1
    provider_meter_watermarks: dict[ModelUsageMeter, Decimal] = field(default_factory=dict)
    active_usage_lease: ActiveRealtimeUsageLease | None = None
    realtime_usage_scope: RealtimeProviderScope | None = None
    remote_voice_ended: bool = False
    connection_ticket_id: str = ""
    connection_ticket_consumed: bool = False
    usage_lease_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


@dataclass(slots=True)
class RealtimeProviderScope:
    """Serialize metered remote-audio sends for one authenticated session.

    A scope owns no business text or media.  It only carries server duration
    clocks, opaque provider cumulative quantities, and the durable lease
    identity needed to make a provider send safe.
    """

    session: RealtimeVoiceSessionState
    usage_adapter: RealtimeAudioUsageAdapter
    input_clock: CumulativeAudioClock = field(default_factory=CumulativeAudioClock)
    output_clock: CumulativeAudioClock = field(default_factory=CumulativeAudioClock)
    tts_character_clock: CumulativeCharacterClock = field(
        default_factory=CumulativeCharacterClock
    )
    schedule_deadlines: bool = False
    _deadline_task: asyncio.Task[None] | None = field(default=None, init=False, repr=False)

    @asynccontextmanager
    async def provider_audio_operation(
        self,
        *,
        turn_id: str,
        segment: str,
        direction: Literal["input", "output"],
        provider_model: str,
        at: datetime | None = None,
        provider_cumulative: Mapping[ModelUsageMeter, Decimal] | None = None,
    ) -> AsyncIterator[RealtimeProviderOperation]:
        """Hold the session gate throughout one actual remote audio send."""

        self.usage_adapter.validate_provider_model(
            direction=direction,
            provider_model=provider_model,
        )
        async with self.session.usage_lease_lock:
            operation_at = at or utcnow()
            outcome = self._ensure_active_lease_locked(
                turn_id=turn_id,
                segment=segment,
                at=operation_at,
                provider_cumulative=provider_cumulative or {},
            )
            operation = RealtimeProviderOperation(scope=self, outcome=outcome)
            timeout_seconds: float | None = None
            if outcome.may_send_audio:
                lease = outcome.lease
                if lease is None:  # pragma: no cover - guarded by may_send_audio
                    raise ModelUsageContractError("realtime_provider_send_not_authorized")
                deadline = min(lease.expires_at, self.session.expires_at)
                # In production `at` is omitted, so re-read the trusted clock
                # after the durable reserve/dispatch transaction.  A slow DB
                # path must not grant a full new lease to a provider send that
                # starts after the permit's persisted deadline.  Explicit
                # timestamps remain deterministic for ledger tests.
                timeout_reference = utcnow() if at is None else operation_at
                timeout_seconds = (deadline - timeout_reference).total_seconds()
                if timeout_seconds <= 0:
                    self._abort_lease_before_provider_send_locked(
                        lease,
                        completed_at=timeout_reference,
                    )
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail={
                            "code": "realtime_lease_expired",
                            "message": "本次语音会话已结束，可以继续使用文字。",
                        },
                    )
            try:
                if timeout_seconds is None:
                    yield operation
                else:
                    # A provider stream must not keep a fixed-duration permit
                    # alive past its lease.  Cancelling at this boundary leaves
                    # the already-dispatched attempt conservatively uncertain;
                    # it never creates an overlapping N+1 lease.
                    async with asyncio.timeout(timeout_seconds):
                        yield operation
            except TimeoutError as exc:
                if outcome.may_send_audio and outcome.lease is not None:
                    self._mark_provider_failure_locked(outcome.lease)
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail={
                        "code": "realtime_lease_expired",
                        "message": "本次语音会话已结束，可以继续使用文字。",
                    },
                ) from exc
            except asyncio.CancelledError:
                if outcome.may_send_audio and outcome.lease is not None:
                    self._mark_provider_failure_locked(outcome.lease)
                raise
            except Exception:
                if outcome.may_send_audio and outcome.lease is not None:
                    self._mark_provider_failure_locked(outcome.lease)
                raise

    async def finish_current_lease_once(
        self,
        *,
        at: datetime | None = None,
        provider_cumulative: Mapping[ModelUsageMeter, Decimal] | None = None,
        completion_reason: str,
    ) -> RealtimeLeaseOutcome:
        """Terminalize the current lease under the same gate as provider sends."""

        del completion_reason  # Receipt identity is intentionally content-free.
        async with self.session.usage_lease_lock:
            return self._finish_active_lease_locked(
                at=at or utcnow(),
                provider_cumulative=provider_cumulative or {},
            )

    def cancel_deadline(self) -> None:
        """Cancel an already-terminal lease's quiet-session deadline task."""

        self._cancel_deadline_task()

    def _ensure_active_lease_locked(
        self,
        *,
        turn_id: str,
        segment: str,
        at: datetime,
        provider_cumulative: Mapping[ModelUsageMeter, Decimal],
    ) -> RealtimeLeaseOutcome:
        if self.session.remote_voice_ended:
            return RealtimeLeaseOutcome(decision="ended")

        if at >= self.session.expires_at:
            active = self.session.active_usage_lease
            if active is not None:
                terminal = self._finish_active_lease_locked(
                    at=at,
                    provider_cumulative=provider_cumulative,
                )
                if terminal.decision != "ended":
                    return terminal
            else:
                terminal = None
            self.session.remote_voice_ended = True
            self._cancel_deadline_task()
            return RealtimeLeaseOutcome(
                decision="ended",
                lease=active,
                settlement=terminal.settlement if terminal is not None else None,
            )

        previous_settlement: UsageSettlement | None = None
        active = self.session.active_usage_lease
        if active is not None:
            if active.terminal_state == "settlement_pending":
                self.session.remote_voice_ended = True
                return RealtimeLeaseOutcome(
                    decision="settlement_pending",
                    lease=active,
                    error_code="realtime_lease_settlement_pending",
                )
            if at < active.expires_at:
                return RealtimeLeaseOutcome(decision="active", lease=active)
            terminal = self._finish_active_lease_locked(
                at=at,
                provider_cumulative=provider_cumulative,
            )
            if terminal.decision != "ended":
                return terminal
            previous_settlement = terminal.settlement

        try:
            lease = self.usage_adapter.begin_lease(
                family_id=self.session.family_id,
                user_id=self.session.user_id,
                session_id=self.session.session_id,
                turn_id=turn_id,
                segment=segment,
                lease_sequence=self.session.next_lease_sequence,
                at=at,
                server_input_total=self.input_clock.total,
                server_output_total=self.output_clock.total,
                provider_cumulative=provider_cumulative,
                previous_provider_watermarks=self.session.provider_meter_watermarks,
                server_tts_character_total=self.tts_character_clock.total,
            )
        except ModelUsageBlocked as exc:
            self.session.remote_voice_ended = True
            return RealtimeLeaseOutcome(decision="blocked", error_code=exc.code)
        except ModelUsageSettlementPending as exc:
            self.session.remote_voice_ended = True
            return RealtimeLeaseOutcome(decision="settlement_pending", error_code=exc.code)
        except (ModelUsageAttemptAlreadyAccounted, ModelUsageDispatchRecoveryRequired) as exc:
            self.session.remote_voice_ended = True
            return RealtimeLeaseOutcome(decision="ended", error_code=exc.code)

        self.session.active_usage_lease = lease
        self.session.current_provider_attempt_key = lease.attempt_key
        self.session.next_lease_sequence += 1
        self._schedule_deadline(lease)
        return RealtimeLeaseOutcome(
            decision="renewed" if previous_settlement is not None else "active",
            lease=lease,
            previous_settlement=previous_settlement,
        )

    def _finish_active_lease_locked(
        self,
        *,
        at: datetime,
        provider_cumulative: Mapping[ModelUsageMeter, Decimal],
    ) -> RealtimeLeaseOutcome:
        lease = self.session.active_usage_lease
        if lease is None:
            return RealtimeLeaseOutcome(decision="ended")
        if lease.terminal_state == "settlement_pending":
            self.session.remote_voice_ended = True
            self._cancel_deadline_task()
            return RealtimeLeaseOutcome(
                decision="settlement_pending",
                lease=lease,
                error_code="realtime_lease_settlement_pending",
            )
        try:
            settlement = self.usage_adapter.finish_lease(
                lease,
                server_input_total=self.input_clock.total,
                server_output_total=self.output_clock.total,
                provider_cumulative=provider_cumulative,
                server_tts_character_total=self.tts_character_clock.total,
                completed_at=at,
            )
        except ModelUsageSettlementPending as exc:
            self.session.remote_voice_ended = True
            self._cancel_deadline_task()
            return RealtimeLeaseOutcome(
                decision="settlement_pending",
                lease=lease,
                error_code=exc.code,
            )
        if lease.terminal_receipt is not None:
            self.session.provider_meter_watermarks.update(
                {
                    item.meter: item.cumulative_quantity
                    for item in lease.terminal_receipt.meter_watermarks
                }
            )
        self.session.active_usage_lease = None
        if self.session.current_provider_attempt_key == lease.attempt_key:
            self.session.current_provider_attempt_key = None
        self._cancel_deadline_task()
        return RealtimeLeaseOutcome(
            decision="ended",
            lease=lease,
            settlement=settlement,
        )

    def _abort_lease_before_provider_send_locked(
        self,
        lease: ActiveRealtimeUsageLease,
        *,
        completed_at: datetime,
    ) -> RealtimeLeaseOutcome:
        """Close an expired permit that did not enter a provider operation."""

        try:
            settlement = self.usage_adapter.abort_lease_before_provider_send(
                lease,
                completed_at=completed_at,
            )
        except ModelUsageSettlementPending as exc:
            self.session.remote_voice_ended = True
            self._cancel_deadline_task()
            return RealtimeLeaseOutcome(
                decision="settlement_pending",
                lease=lease,
                error_code=exc.code,
            )
        self.session.active_usage_lease = None
        if self.session.current_provider_attempt_key == lease.attempt_key:
            self.session.current_provider_attempt_key = None
        self.session.remote_voice_ended = True
        self._cancel_deadline_task()
        return RealtimeLeaseOutcome(
            decision="ended",
            lease=lease,
            settlement=settlement,
        )

    def _mark_provider_failure_locked(self, lease: ActiveRealtimeUsageLease) -> None:
        """Preserve an ambiguous dispatched lease for normal uncertain recovery."""

        if self.session.active_usage_lease is not lease:
            return
        try:
            lease.attempt.mark_uncertain("realtime_provider_result_unavailable")
        finally:
            lease.terminal_state = "settlement_pending"
            if self.session.current_provider_attempt_key == lease.attempt_key:
                self.session.current_provider_attempt_key = None
            self.session.remote_voice_ended = True
            self._cancel_deadline_task()

    def _schedule_deadline(self, lease: ActiveRealtimeUsageLease) -> None:
        if not self.schedule_deadlines:
            return
        self._cancel_deadline_task()

        async def terminalize_at_deadline() -> None:
            deadline = min(lease.expires_at, self.session.expires_at)
            delay = max(0.0, (deadline - utcnow()).total_seconds())
            await asyncio.sleep(delay)
            if self.session.active_usage_lease is lease:
                await self.finish_current_lease_once(completion_reason="deadline")

        self._deadline_task = asyncio.get_running_loop().create_task(
            terminalize_at_deadline(),
            name=f"realtime-usage-lease-{lease.attempt_key}",
        )

    def _cancel_deadline_task(self) -> None:
        task = self._deadline_task
        if task is None:
            return
        try:
            current = asyncio.current_task()
        except RuntimeError:
            # Session-store expiry and process cleanup can run after the loop
            # that created a completed deadline task has already closed.
            current = None
        if task is not current and not task.done():
            task.cancel()
        self._deadline_task = None


class RealtimeVoiceSessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, RealtimeVoiceSessionState] = {}
        self._lock = RLock()

    def put(self, state: RealtimeVoiceSessionState) -> None:
        with self._lock:
            self._cleanup_locked()
            stale_session_ids = [
                session_id
                for session_id, existing in self._sessions.items()
                if existing.family_id == state.family_id and existing.user_id == state.user_id
            ]
            for session_id in stale_session_ids:
                self._sessions.pop(session_id, None)
            self._sessions[state.session_id] = state

    def get(self, session_id: str) -> RealtimeVoiceSessionState:
        with self._lock:
            return self._get_locked(session_id)

    def require_owner(self, session_id: str, *, family_id: str, user_id: str) -> RealtimeVoiceSessionState:
        state = self.get(session_id)
        if state.family_id != family_id or state.user_id != user_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Voice session is not available")
        return state

    def consume_connection_ticket(
        self,
        session_id: str,
        *,
        family_id: str,
        user_id: str,
        ticket_id: str,
    ) -> RealtimeVoiceSessionState:
        with self._lock:
            state = self._get_locked(session_id)
            if state.family_id != family_id or state.user_id != user_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Voice session is not available",
                )
            if (
                not ticket_id
                or ticket_id != state.connection_ticket_id
                or state.connection_ticket_consumed
            ):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Voice connection ticket is invalid",
                )
            state.connection_ticket_consumed = True
            return state

    def close(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def clear(self) -> None:
        with self._lock:
            self._sessions.clear()

    def _cleanup_locked(self) -> None:
        now = utcnow()
        expired = [session_id for session_id, state in self._sessions.items() if state.expires_at <= now]
        for session_id in expired:
            self._sessions.pop(session_id, None)

    def _get_locked(self, session_id: str) -> RealtimeVoiceSessionState:
        self._cleanup_locked()
        state = self._sessions.get(session_id)
        if state is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Voice session not found",
            )
        return state


realtime_voice_session_store = RealtimeVoiceSessionStore()
