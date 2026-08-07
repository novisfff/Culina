from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from threading import Lock

from app.core.enums import ModelUsageCapability
from app.services.model_usage.periods import BillingPeriod, shanghai_billing_period
from app.services.model_usage.receipts import model_usage_log_payload


logger = logging.getLogger(__name__)


def _log_latch_event(**fields: object) -> None:
    logger.info(
        "model_usage_outage_latch %s",
        json.dumps(model_usage_log_payload(fields), ensure_ascii=False, sort_keys=True),
    )


@dataclass(frozen=True, slots=True)
class OutageFragment:
    incident_key: str
    source_instance: str
    started_at: datetime
    recovered_at: datetime
    period: BillingPeriod


@dataclass(frozen=True, slots=True)
class ScopedOutageAttempt:
    incident_key: str
    family_id: str
    subject_key: str
    capability: ModelUsageCapability
    client_attempt_id: str
    source_instance: str
    occurred_at: datetime
    period: BillingPeriod


@dataclass(frozen=True, slots=True)
class OutageLatchBatch:
    fragments: tuple[OutageFragment, ...]
    scoped_attempts: tuple[ScopedOutageAttempt, ...]

    @property
    def empty(self) -> bool:
        return not self.fragments and not self.scoped_attempts


def incident_fragment_key(
    source_instance: str,
    started_at: datetime,
    period_start: datetime,
) -> str:
    raw = f"{source_instance}|{started_at.isoformat()}|{period_start.isoformat()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class ModelUsageOutageLatch:
    def __init__(self) -> None:
        self._lock = Lock()
        self._open: tuple[datetime, str] | None = None
        self._closed: list[OutageFragment] = []
        self._scoped: list[ScopedOutageAttempt] = []

    @property
    def pending_scoped_count(self) -> int:
        with self._lock:
            return len(self._scoped)

    def record_exact_attempt(
        self,
        *,
        family_id: str,
        subject_key: str,
        capability: ModelUsageCapability,
        client_attempt_id: str,
        occurred_at: datetime,
        source_instance: str,
    ) -> None:
        period = shanghai_billing_period(occurred_at)
        raw = f"{source_instance}|{family_id}|{client_attempt_id}"
        attempt = ScopedOutageAttempt(
            incident_key=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            family_id=family_id,
            subject_key=subject_key,
            capability=capability,
            client_attempt_id=client_attempt_id,
            source_instance=source_instance,
            occurred_at=occurred_at,
            period=period,
        )
        with self._lock:
            if all(item.incident_key != attempt.incident_key for item in self._scoped):
                self._scoped.append(attempt)
                _log_latch_event(
                    event="exact_attempt_recorded",
                    coverage="exact_scope",
                    incident_key=attempt.incident_key,
                    family_id=attempt.family_id,
                    subject_key=attempt.subject_key,
                    capability=attempt.capability.value,
                    client_attempt_id=attempt.client_attempt_id,
                    occurred_at=attempt.occurred_at.isoformat(),
                    period_start=attempt.period.start_at.isoformat(),
                    period_end=attempt.period.end_at.isoformat(),
                    source_instance=attempt.source_instance,
                )

    def open_unknown_scope(self, *, started_at: datetime, source_instance: str) -> None:
        if not source_instance:
            raise ValueError("source_instance is required")
        with self._lock:
            if self._open is None or started_at < self._open[0]:
                self._open = (started_at, source_instance)
                _log_latch_event(
                    event="unknown_scope_started",
                    coverage="unknown_scope",
                    source_instance=source_instance,
                    started_at=started_at.isoformat(),
                )

    def recover(self, *, at: datetime) -> None:
        with self._lock:
            if self._open is None:
                return
            started_at, source_instance = self._open
            if at < started_at:
                raise ValueError("outage recovery cannot precede start")
            cursor = started_at
            recovered_fragments: list[OutageFragment] = []
            while cursor < at:
                period = shanghai_billing_period(cursor)
                fragment = OutageFragment(
                    incident_key=incident_fragment_key(
                        source_instance,
                        started_at,
                        period.start_at,
                    ),
                    source_instance=source_instance,
                    started_at=max(started_at, period.start_at),
                    recovered_at=min(at, period.end_at),
                    period=period,
                )
                self._closed.append(fragment)
                recovered_fragments.append(fragment)
                cursor = period.end_at
                if cursor == at:
                    break
                if cursor <= started_at:
                    cursor += timedelta(microseconds=1)
            self._open = None
            _log_latch_event(
                event="unknown_scope_recovered",
                coverage="unknown_scope",
                source_instance=source_instance,
                started_at=started_at.isoformat(),
                recovered_at=at.isoformat(),
                incident_keys=[
                    fragment.incident_key for fragment in recovered_fragments
                ],
            )

    def drain(self) -> tuple[OutageFragment, ...]:
        with self._lock:
            drained = tuple(self._closed)
            self._closed.clear()
            return drained

    def drain_scoped(self) -> tuple[ScopedOutageAttempt, ...]:
        with self._lock:
            drained = tuple(self._scoped)
            self._scoped.clear()
            return drained

    def snapshot(self) -> OutageLatchBatch:
        with self._lock:
            return OutageLatchBatch(
                fragments=tuple(self._closed),
                scoped_attempts=tuple(self._scoped),
            )

    def acknowledge(self, batch: OutageLatchBatch) -> None:
        fragment_keys = {fragment.incident_key for fragment in batch.fragments}
        attempt_keys = {attempt.incident_key for attempt in batch.scoped_attempts}
        with self._lock:
            self._closed = [
                fragment
                for fragment in self._closed
                if fragment.incident_key not in fragment_keys
            ]
            self._scoped = [
                attempt
                for attempt in self._scoped
                if attempt.incident_key not in attempt_keys
            ]
