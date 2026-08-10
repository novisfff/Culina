from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError, TimeoutError
from sqlalchemy.orm import Session

from app.services.model_usage.errors import ModelUsageLedgerUnavailable, ModelUsageProofConsumed
from app.services.model_usage.adapters.base import MeteredProviderAttempt
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.facade import (
    FailOpenPermitRegistry,
    consume_fail_open_dispatch_permit,
    exchange_proof_for_permit,
    prove_monitoring_dispatch_eligibility,
    ModelUsageFacade,
    is_model_usage_ledger_unavailable,
    process_fail_open_permit_registry,
)
from app.services.model_usage.policies import current_policy
from app.services.model_usage.types import UsageContext
from app.services.model_usage.outage_latch import ModelUsageOutageLatch
from app.services.model_usage.incidents import flush_outage_latch
from app.models.model_usage import ModelUsageMeasurementIncidentAttempt, ModelUsageReservation
from tests.model_usage.test_reservations import NOW, set_policy
from tests.model_usage.test_pricing_service import publish, raw_manifest


pytest_plugins = ("tests.model_usage.test_reservations",)


def test_current_monitoring_policy_produces_single_use_fail_open_permit(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    proof = prove_monitoring_dispatch_eligibility(
        model_usage_db,
        context=reservation_context,
        estimate=estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-proof",
        at=NOW,
    )
    registry = FailOpenPermitRegistry()
    permit = exchange_proof_for_permit(proof, registry=registry, at=NOW)
    consumed = consume_fail_open_dispatch_permit(permit, registry=registry, at=NOW)
    assert consumed.send_kind == "fail_open_single_send"
    assert consumed.policy_version_id == current_policy(
        model_usage_db, family_id=reservation_context.attribution.family_id
    ).id
    with pytest.raises(ModelUsageProofConsumed):
        consume_fail_open_dispatch_permit(permit, registry=registry, at=NOW)


def test_facade_consumes_permit_from_its_own_registry(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    proof = prove_monitoring_dispatch_eligibility(
        model_usage_db,
        context=reservation_context,
        estimate=estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-facade-consume",
        at=NOW,
    )
    registry = FailOpenPermitRegistry()
    permit = exchange_proof_for_permit(proof, registry=registry, at=NOW)
    facade = ModelUsageFacade(
        session_factory=lambda: model_usage_db,
        registry=registry,
        outage_latch=ModelUsageOutageLatch(),
        clock=lambda: NOW,
    )

    consumed = facade.consume_fail_open_dispatch_permit(permit, at=NOW)

    assert consumed == permit
    with pytest.raises(ModelUsageProofConsumed):
        facade.consume_fail_open_dispatch_permit(permit, at=NOW)


def test_public_consume_uses_process_registry_by_default(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    proof = prove_monitoring_dispatch_eligibility(
        model_usage_db,
        context=reservation_context,
        estimate=estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-process-consume",
        at=NOW,
    )
    permit = exchange_proof_for_permit(
        proof,
        registry=process_fail_open_permit_registry,
        at=NOW,
    )

    assert consume_fail_open_dispatch_permit(permit, at=NOW) == permit


def test_hard_limit_cannot_issue_fail_open_proof(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
    )
    with pytest.raises(ModelUsageLedgerUnavailable, match="model_usage_ledger_unavailable"):
        prove_monitoring_dispatch_eligibility(
            model_usage_db,
            context=reservation_context,
            estimate=estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
            fingerprint="fp-hard-proof",
            at=NOW,
        )


def test_facade_hard_limit_without_price_is_blocked_by_admission(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
    )
    facade = ModelUsageFacade(
        session_factory=lambda: model_usage_db,
        registry=FailOpenPermitRegistry(),
        outage_latch=ModelUsageOutageLatch(),
        source_instance="api-test",
        clock=lambda: NOW,
    )

    decision = facade.reserve(
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-hard-facade",
    )

    assert decision.decision == "blocked"
    assert decision.error_code == "model_usage_price_unavailable"
    assert decision.fail_open_permit is None


def test_facade_hard_limit_uses_normal_reservation_when_ledger_is_healthy(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
    )
    facade = ModelUsageFacade(
        session_factory=lambda: model_usage_db,
        registry=FailOpenPermitRegistry(),
        outage_latch=ModelUsageOutageLatch(),
        source_instance="api-test",
        clock=lambda: NOW,
    )

    decision = facade.reserve(
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-hard-facade-healthy",
    )

    assert decision.decision == "allowed"
    assert decision.reservation_id is not None
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None
    assert reservation.pricing_status.value == "priced"


def test_expired_proof_cannot_be_exchanged(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    proof = prove_monitoring_dispatch_eligibility(
        model_usage_db,
        context=reservation_context,
        estimate=estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-expired",
        at=NOW,
    )
    with pytest.raises(ModelUsageProofConsumed, match="model_usage_proof_consumed"):
        exchange_proof_for_permit(
            proof,
            registry=FailOpenPermitRegistry(),
            at=proof.expires_at + timedelta(microseconds=1),
        )


def test_closed_ledger_failure_classifier_never_treats_constraint_as_outage() -> None:
    assert is_model_usage_ledger_unavailable(TimeoutError("pool exhausted")) is True
    assert (
        is_model_usage_ledger_unavailable(
            IntegrityError("insert", {}, Exception("duplicate"))
        )
        is False
    )


def test_facade_fail_opens_only_after_complete_proof(
    model_usage_db: Session,
    reservation_context: UsageContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_usage_db.commit()

    def fail_write(*args, **kwargs):
        raise TimeoutError("pool exhausted after proof")

    monkeypatch.setattr("app.services.model_usage.facade.reserve_usage_in_session", fail_write)
    latch = ModelUsageOutageLatch()
    facade = ModelUsageFacade(
        session_factory=lambda: model_usage_db,
        registry=FailOpenPermitRegistry(),
        outage_latch=latch,
        source_instance="api-test",
        clock=lambda: NOW,
    )
    decision = facade.reserve(
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-facade-fail-open",
    )
    assert decision.decision == "fail_open"
    assert decision.fail_open_permit is not None
    assert decision.fail_open_permit.send_kind == "fail_open_single_send"
    assert latch.pending_scoped_count == 1
    incidents = flush_outage_latch(model_usage_db, latch)
    assert len(incidents) == 1
    assert model_usage_db.query(ModelUsageMeasurementIncidentAttempt).count() == 1


@pytest.mark.parametrize("delay_seconds", [1, 6])
def test_facade_does_not_reuse_a_prior_period_fail_open_proof_after_its_deadline(
    model_usage_db: Session,
    reservation_context: UsageContext,
    monkeypatch: pytest.MonkeyPatch,
    delay_seconds: int,
) -> None:
    """A delayed failure cannot authorise a new-month remote send."""

    model_usage_db.commit()
    proof_at = datetime(2026, 7, 31, 15, 59, 59, tzinfo=timezone.utc)
    delayed_dispatch_at = proof_at + timedelta(seconds=delay_seconds)

    def fail_write(*args, **kwargs):
        raise TimeoutError("pool exhausted after proof")

    monkeypatch.setattr("app.services.model_usage.facade.reserve_usage_in_session", fail_write)
    latch = ModelUsageOutageLatch()
    facade = ModelUsageFacade(
        session_factory=lambda: model_usage_db,
        registry=FailOpenPermitRegistry(),
        outage_latch=latch,
        source_instance="api-test",
        clock=lambda: delayed_dispatch_at,
    )

    decision = facade.reserve(
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-fail-open-cross-month",
        at=proof_at,
    )

    assert decision.decision == "blocked"
    assert decision.error_code == "model_usage_ledger_unavailable"
    assert decision.fail_open_permit is None
    assert latch.pending_scoped_count == 0


def test_fail_open_attempt_consumes_its_permit_at_actual_send_time(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    proof = prove_monitoring_dispatch_eligibility(
        model_usage_db,
        context=reservation_context,
        estimate=estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-fail-open-send-time",
        at=NOW,
    )
    registry = FailOpenPermitRegistry()
    permit = exchange_proof_for_permit(proof, registry=registry, at=NOW)
    actual_send_at = proof.expires_at + timedelta(microseconds=1)
    facade = ModelUsageFacade(
        session_factory=lambda: model_usage_db,
        registry=registry,
        outage_latch=ModelUsageOutageLatch(),
        clock=lambda: actual_send_at,
    )
    attempt = MeteredProviderAttempt(
        usage_facade=facade,
        session_factory=lambda: model_usage_db,
        signer=None,  # type: ignore[arg-type] - dispatch does not access receipt signing
        context=reservation_context,
        estimate=estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-fail-open-send-time",
        reservation_id=None,
        fail_open_permit=permit,
        clock=lambda: actual_send_at,
    )

    with pytest.raises(ModelUsageProofConsumed):
        attempt.prepare_dispatch(at=NOW)
