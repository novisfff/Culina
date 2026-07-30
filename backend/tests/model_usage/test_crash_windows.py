from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy.orm import Session

from app.models.model_usage import ModelUsageEvent, ModelUsagePeriodCounter, ModelUsageReservation
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.recovery import (
    mark_dispatch_uncertain,
    settle_expired_uncertain_in_session,
)
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.types import ProviderRecoveryPolicy, UsageContext
from tests.model_usage.test_reservations import NOW


pytest_plugins = ("tests.model_usage.test_reservations",)


@pytest.mark.parametrize(
    "crash_point",
    [
        "after_reserve",
        "after_dispatch_commit",
        "after_provider_send",
        "after_provider_success_before_settle",
        "after_settle_commit",
        "after_business_rollback",
    ],
)
def test_crash_recovery_never_duplicates_ledger_attempt(
    model_usage_db: Session,
    reservation_context: UsageContext,
    crash_point: str,
) -> None:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-crash",
        at=NOW,
    )
    if crash_point != "after_reserve":
        prepare_usage_dispatch_in_session(
            model_usage_db,
            reservation_id=decision.reservation_id or "",
            fingerprint="fp-crash",
            recovery_policy=ProviderRecoveryPolicy.none(),
        )
        mark_dispatch_uncertain(
            model_usage_db,
            reservation_id=decision.reservation_id or "",
        )
        reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
        assert reservation is not None and reservation.dispatching_at is not None
        signer = ProviderUsageReceiptSigner(
            active_key_id="key",
            keys={"key": b"secret"},
        )
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
        assert first.event_id == replay.event_id
    assert model_usage_db.query(ModelUsageReservation).count() == 1
    assert model_usage_db.query(ModelUsageEvent).count() <= 1
    assert all(
        row.reserved_value >= 0
        and row.settled_value >= 0
        and row.adjustment_value >= 0
        for row in model_usage_db.query(ModelUsagePeriodCounter)
    )
