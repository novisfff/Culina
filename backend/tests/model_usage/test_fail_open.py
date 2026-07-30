from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError, TimeoutError
from sqlalchemy.orm import Session

from app.services.model_usage.errors import ModelUsageLedgerUnavailable, ModelUsageProofConsumed
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.facade import (
    FailOpenPermitRegistry,
    consume_fail_open_dispatch_permit,
    exchange_proof_for_permit,
    prove_monitoring_dispatch_eligibility,
    ModelUsageFacade,
    is_model_usage_ledger_unavailable,
)
from app.services.model_usage.policies import current_policy
from app.services.model_usage.types import UsageContext
from app.services.model_usage.outage_latch import ModelUsageOutageLatch
from app.services.model_usage.incidents import flush_outage_latch
from app.models.model_usage import ModelUsageMeasurementIncidentAttempt
from tests.model_usage.test_reservations import NOW, set_policy


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


def test_facade_hard_limit_proof_failure_fails_closed(
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
    assert decision.error_code == "model_usage_ledger_unavailable"
    assert decision.fail_open_permit is None


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
