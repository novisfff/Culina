from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageQuantitySource,
)
from app.models.model_usage import ModelUsageEvent
from app.services.model_usage.adapters.llm import (
    LLMUsageAdapter,
    normalize_openai_token_usage,
)
from app.services.model_usage.errors import ModelUsageDispatchRecoveryRequired
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import UsageAttribution
from tests.model_usage.test_reservations import NOW


pytest_plugins = ("tests.model_usage.test_reservations",)


@pytest.fixture()
def receipt_signer() -> ProviderUsageReceiptSigner:
    return ProviderUsageReceiptSigner(
        active_key_id="llm-test-key",
        keys={"llm-test-key": b"llm-test-secret"},
    )


@pytest.fixture()
def llm_adapter(
    model_usage_db: Session,
    receipt_signer: ProviderUsageReceiptSigner,
) -> LLMUsageAdapter:
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)
    return LLMUsageAdapter(
        provider="openai",
        usage_facade=ModelUsageFacade(session_factory=factory, clock=lambda: NOW),
        session_factory=factory,
        signer=receipt_signer,
        clock=lambda: NOW,
    )


def test_round_attempt_key_is_stable_and_distinct(
    llm_adapter: LLMUsageAdapter,
    reservation_context,
) -> None:
    attribution = reservation_context.attribution

    first = llm_adapter.start_round(
        attribution,
        provider_round=1,
        attempt_index=1,
        model="gpt-test",
        input_estimate=40,
        output_cap=100,
        fingerprint="hmac:round-1",
    )
    replay = llm_adapter.start_round(
        attribution,
        provider_round=1,
        attempt_index=1,
        model="gpt-test",
        input_estimate=40,
        output_cap=100,
        fingerprint="hmac:round-1",
    )
    second = llm_adapter.start_round(
        attribution,
        provider_round=2,
        attempt_index=1,
        model="gpt-test",
        input_estimate=20,
        output_cap=100,
        fingerprint="hmac:round-2",
    )

    assert first.attempt_key == replay.attempt_key
    assert first.reservation_id == replay.reservation_id
    assert first.attempt_key != second.attempt_key
    assert first.estimate.quantity(ModelUsageMeter.OUTPUT_TOKENS) == Decimal("100")


def test_normalizes_openai_usage_into_exact_llm_meters() -> None:
    meters = normalize_openai_token_usage(
        {
            "prompt_tokens": 12,
            "completion_tokens": 4,
            "prompt_tokens_details": {"cached_tokens": 3},
        },
        billing_scheme_key="llm-split-v1",
    )

    by_meter = {line.meter: line for line in meters}
    assert by_meter[ModelUsageMeter.INPUT_TOKENS].quantity == Decimal("12")
    assert by_meter[ModelUsageMeter.INPUT_TOKENS].meter_role is ModelUsageMeterRole.INFORMATIONAL
    assert by_meter[ModelUsageMeter.UNCACHED_INPUT_TOKENS].quantity == Decimal("9")
    assert by_meter[ModelUsageMeter.CACHED_INPUT_TOKENS].quantity == Decimal("3")
    assert by_meter[ModelUsageMeter.OUTPUT_TOKENS].quantity == Decimal("4")
    assert by_meter[ModelUsageMeter.TOTAL_TOKENS].quantity == Decimal("16")
    assert all(line.quantity_source is ModelUsageQuantitySource.PROVIDER for line in meters)


def test_adapter_settles_an_empty_but_executed_round_from_provider_usage(
    llm_adapter: LLMUsageAdapter,
    reservation_context,
    model_usage_db: Session,
) -> None:
    attempt = llm_adapter.start_round(
        reservation_context.attribution,
        provider_round=1,
        attempt_index=1,
        model="gpt-test",
        input_estimate=10,
        output_cap=20,
        fingerprint="hmac:empty-but-executed",
    )
    permit = attempt.prepare_dispatch()
    receipt = llm_adapter.receipt_from_openai_usage(
        permit,
        raw_usage={"input_tokens": 10, "output_tokens": 0},
        reported_model="provider-alias",
        provider_request_id="request-empty-but-executed",
        completed_at=NOW + timedelta(seconds=1),
    )

    settlement = attempt.settle(receipt)

    assert settlement.event_id
    assert settlement.quantity(ModelUsageMeter.OUTPUT_TOKENS) == Decimal("0")
    assert settlement.reservation_id == attempt.reservation_id
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.reported_model == "provider-alias"


def test_adapter_marks_ambiguous_attempt_uncertain_without_a_retry(
    llm_adapter: LLMUsageAdapter,
    reservation_context,
) -> None:
    attempt = llm_adapter.start_round(
        reservation_context.attribution,
        provider_round=1,
        attempt_index=1,
        model="gpt-test",
        input_estimate=10,
        output_cap=20,
        fingerprint="hmac:ambiguous",
    )
    attempt.prepare_dispatch()

    attempt.mark_uncertain("provider_stream_transport_ambiguous")

    assert attempt.reservation_id is not None


def test_adapter_refuses_a_second_dispatch_for_the_same_attempt(
    llm_adapter: LLMUsageAdapter,
    reservation_context,
) -> None:
    attempt = llm_adapter.start_round(
        reservation_context.attribution,
        provider_round=1,
        attempt_index=1,
        model="gpt-test",
        input_estimate=10,
        output_cap=20,
        fingerprint="hmac:no-second-send",
    )

    attempt.prepare_dispatch()

    with pytest.raises(ModelUsageDispatchRecoveryRequired):
        attempt.prepare_dispatch()
