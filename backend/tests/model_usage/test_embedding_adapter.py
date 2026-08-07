from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageOperationSource,
    ModelUsagePricingStatus,
)
from app.models.domain import Base
from app.models.model_usage import ModelUsageEvent, ModelUsageReservation
from app.services.model_usage.adapters.embedding import EmbeddingUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageContractError
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.policies import CapabilityLimitCommand
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import UsageAttribution
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW, set_policy


pytest_plugins = ("tests.model_usage.test_reservations",)


@pytest.fixture()
def receipt_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="embedding-test-key",
        keys={"embedding-test-key": b"embedding-test-secret"},
    )


@pytest.fixture()
def embedding_adapter(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
) -> EmbeddingUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return EmbeddingUsageAdapter(
        provider="openai",
        model="embedding-test",
        dimensions=1536,
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=receipt_signer,
        clock=lambda: NOW,
    )


def test_embedding_attempt_uses_stable_key_and_exact_provider_usage(
    embedding_adapter: EmbeddingUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    publish(model_usage_db, raw_manifest())

    first = embedding_adapter.begin_embedding_batch(
        attribution=reservation_context.attribution,
        attempt_key="search-request:embedding:query",
        text_token_estimates=[5, 7],
        fingerprint="hmac:embedding-query",
    )
    replay = embedding_adapter.begin_embedding_batch(
        attribution=reservation_context.attribution,
        attempt_key="search-request:embedding:query",
        text_token_estimates=[5, 7],
        fingerprint="hmac:embedding-query",
    )

    assert first.attempt_key == replay.attempt_key
    assert first.reservation_id == replay.reservation_id
    assert first.context.capability is ModelUsageCapability.EMBEDDING
    assert first.estimate.quantity(ModelUsageMeter.EMBEDDING_TOKENS) == Decimal("12")

    permit = first.prepare_dispatch()
    settlement = first.settle(
        embedding_adapter.receipt_from_openai_response(
            permit,
            raw_usage={"prompt_tokens": 9},
            reported_model="embedding-test-2026-07-01",
            provider_request_id="embedding-request-1",
            completed_at=NOW + timedelta(seconds=1),
        )
    )

    assert settlement.measurement_status is ModelUsageMeasurementStatus.EXACT
    assert settlement.pricing_status is ModelUsagePricingStatus.PRICED
    assert settlement.quantity(ModelUsageMeter.EMBEDDING_TOKENS) == Decimal("9")
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    reservation = model_usage_db.get(ModelUsageReservation, first.reservation_id)
    assert reservation is not None
    assert reservation.operation_source is ModelUsageOperationSource.INTERACTIVE
    assert event.reported_model == "embedding-test-2026-07-01"


def test_embedding_uses_estimated_meter_when_provider_omits_usage(
    embedding_adapter: EmbeddingUsageAdapter,
    reservation_context,
) -> None:
    attempt = embedding_adapter.begin_embedding_batch(
        attribution=reservation_context.attribution,
        attempt_key="search-request:embedding:estimated",
        text_token_estimates=[11],
        fingerprint="hmac:embedding-estimated",
    )

    permit = attempt.prepare_dispatch()
    settlement = attempt.settle(
        embedding_adapter.receipt_from_openai_response(
            permit,
            raw_usage=None,
            reported_model="embedding-test",
            provider_request_id="embedding-request-estimated",
        )
    )

    assert settlement.measurement_status is ModelUsageMeasurementStatus.ESTIMATED
    assert settlement.pricing_status is ModelUsagePricingStatus.UNPRICED
    assert settlement.quantity(ModelUsageMeter.EMBEDDING_TOKENS) == Decimal("11")


def test_embedding_uses_estimated_meter_when_provider_returns_empty_usage_object(
    embedding_adapter: EmbeddingUsageAdapter,
    reservation_context,
) -> None:
    attempt = embedding_adapter.begin_embedding_batch(
        attribution=reservation_context.attribution,
        attempt_key="search-request:embedding:empty-usage",
        text_token_estimates=[13],
        fingerprint="hmac:embedding-empty-usage",
    )

    permit = attempt.prepare_dispatch()
    settlement = attempt.settle(
        embedding_adapter.receipt_from_openai_response(
            permit,
            raw_usage={},
            reported_model="embedding-test",
            provider_request_id="embedding-request-empty-usage",
        )
    )

    assert settlement.measurement_status is ModelUsageMeasurementStatus.ESTIMATED
    assert settlement.quantity(ModelUsageMeter.EMBEDDING_TOKENS) == Decimal("13")


def test_embedding_budget_block_happens_before_dispatch(
    embedding_adapter: EmbeddingUsageAdapter,
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
                capability=ModelUsageCapability.EMBEDDING,
                limit_kind=ModelUsageLimitKind.METER,
                meter=ModelUsageMeter.EMBEDDING_TOKENS,
                limit_value=Decimal("1"),
            ),
        ),
    )

    with pytest.raises(ModelUsageBlocked, match="model_usage_capability_limit_exceeded"):
        embedding_adapter.begin_embedding_batch(
            attribution=reservation_context.attribution,
            attempt_key="search-request:embedding:blocked",
            text_token_estimates=[2],
            fingerprint="hmac:embedding-blocked",
        )


def test_embedding_adapter_rejects_cross_family_batch(
    embedding_adapter: EmbeddingUsageAdapter,
    reservation_context,
) -> None:
    other_family = UsageAttribution(
        family_id="other-family",
        attribution_kind=ModelUsageAttributionKind.SYSTEM,
        actor_user_id=None,
        operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
        logical_operation_id="other-index",
    )

    with pytest.raises(ModelUsageContractError, match="embedding_batch_crosses_family"):
        embedding_adapter.validate_batch_family((reservation_context.attribution, other_family))


def test_embedding_background_batch_uses_system_attribution(
    embedding_adapter: EmbeddingUsageAdapter,
    model_usage_db: Session,
    reservation_context,
) -> None:
    attribution = UsageAttribution(
        family_id=reservation_context.attribution.family_id,
        attribution_kind=ModelUsageAttributionKind.SYSTEM,
        actor_user_id=None,
        operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
        logical_operation_id="search-index-job-1",
    )

    attempt = embedding_adapter.begin_embedding_batch(
        attribution=attribution,
        attempt_key="search-index-job-1:embedding",
        text_token_estimates=[3, 4],
        fingerprint="hmac:embedding-system-batch",
    )

    reservation = model_usage_db.get(ModelUsageReservation, attempt.reservation_id)
    assert reservation is not None
    assert reservation.attribution_kind is ModelUsageAttributionKind.SYSTEM
    assert reservation.operation_source is ModelUsageOperationSource.BACKGROUND_INDEX
    assert attempt.estimate.quantity(ModelUsageMeter.EMBEDDING_TOKENS) == Decimal("7")


def test_search_usage_handoff_columns_exist() -> None:
    document_columns = Base.metadata.tables["search_documents"].c
    assert {
        "pending_vector",
        "pending_vector_content_hash",
        "pending_vector_model",
        "pending_vector_dimensions",
    } <= set(document_columns.keys())
    job_columns = Base.metadata.tables["search_index_jobs"].c
    assert {
        "usage_attempt_key",
        "usage_event_id",
        "budget_blocked_period_start",
        "budget_blocked_policy_version_id",
        "error_code",
    } <= set(job_columns.keys())
    assert list(job_columns.usage_event_id.foreign_keys) == []
