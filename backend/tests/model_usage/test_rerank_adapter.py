from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
)
from app.models.model_usage import ModelUsageEvent
from app.services.model_usage.adapters.rerank import RerankUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageContractError
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.policies import CapabilityLimitCommand
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW, set_policy


pytest_plugins = ("tests.model_usage.test_reservations",)


@pytest.fixture()
def receipt_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="rerank-test-key",
        keys={"rerank-test-key": b"rerank-test-secret"},
    )


@pytest.fixture()
def rerank_adapter(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
) -> RerankUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return RerankUsageAdapter(
        provider="dashscope",
        model="rerank-test",
        candidate_limit=20,
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=receipt_signer,
        clock=lambda: NOW,
    )


def test_rerank_exact_candidate_count_and_content_free_receipt(
    rerank_adapter: RerankUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    publish(model_usage_db, raw_manifest())

    attempt = rerank_adapter.begin(
        attribution=reservation_context.attribution,
        attempt_key="search-1:rerank",
        document_count=17,
        fingerprint="hmac:rerank-request",
    )

    assert attempt.estimate.quantity(ModelUsageMeter.RERANK_REQUESTS) == Decimal("1")
    assert attempt.estimate.quantity(ModelUsageMeter.RERANK_DOCUMENTS) == Decimal("17")

    permit = attempt.prepare_dispatch()
    assert permit.recovery_policy.mode is ModelUsageRecoveryMode.NONE
    receipt = rerank_adapter.receipt_from_response(
        permit,
        reported_model="rerank-test-2026-07-01",
        provider_request_id="rerank-request-1",
        completed_at=NOW + timedelta(seconds=1),
    )

    by_meter = {line.meter: line for line in receipt.meters}
    assert receipt.measurement_status is ModelUsageMeasurementStatus.EXACT
    assert by_meter[ModelUsageMeter.RERANK_REQUESTS].quantity == Decimal("1")
    assert by_meter[ModelUsageMeter.RERANK_DOCUMENTS].quantity == Decimal("17")
    assert all(line.quantity_source is ModelUsageQuantitySource.SERVER_MEASURED for line in receipt.meters)
    assert "鸡肉" not in repr(receipt)

    settlement = attempt.settle(receipt)

    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.capability is ModelUsageCapability.RERANK
    assert event.reported_model == "rerank-test-2026-07-01"
    assert event.fingerprint == "hmac:rerank-request"


def test_rerank_rejects_empty_document_count_without_a_reservation(
    rerank_adapter: RerankUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    with pytest.raises(ModelUsageContractError, match="rerank_document_count_invalid"):
        rerank_adapter.begin(
            attribution=reservation_context.attribution,
            attempt_key="search-empty:rerank",
            document_count=0,
            fingerprint="hmac:rerank-empty",
        )

    assert model_usage_db.query(ModelUsageEvent).count() == 0


def test_rerank_budget_block_happens_before_dispatch(
    rerank_adapter: RerankUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    publish(model_usage_db, raw_manifest())
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
        limits=(
            CapabilityLimitCommand(
                capability=ModelUsageCapability.RERANK,
                limit_kind=ModelUsageLimitKind.METER,
                meter=ModelUsageMeter.RERANK_DOCUMENTS,
                limit_value=Decimal("1"),
            ),
        ),
    )

    with pytest.raises(ModelUsageBlocked, match="model_usage_capability_limit_exceeded"):
        rerank_adapter.begin(
            attribution=reservation_context.attribution,
            attempt_key="search-blocked:rerank",
            document_count=2,
            fingerprint="hmac:rerank-blocked",
        )
