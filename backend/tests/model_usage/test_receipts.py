from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
from threading import Event, Thread

import pytest

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
)
from app.services.model_usage.errors import ModelUsageReceiptIntegrityError
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.receipts import (
    PROVIDER_USAGE_RECEIPT_LOG_FIELDS,
    ProviderUsageReceiptQueue,
    ProviderUsageReceiptSigner,
    receipt_log_payload,
)
from app.services.model_usage.types import ProviderUsageReceipt, UsageMeterQuantity


NOW = datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc)


def receipt() -> ProviderUsageReceipt:
    return ProviderUsageReceipt(
        reservation_id="reservation-a",
        family_id="family-a",
        subject_key="mus_random",
        capability=ModelUsageCapability.LLM,
        provider="provider",
        requested_model="model",
        reported_model="model-2026",
        billing_model="model",
        variant_key="default",
        billing_scheme_key="llm-v1",
        attempt_key="attempt-a",
        fingerprint="fp-a",
        client_attempt_id="mua_a",
        policy_version_id="policy-a",
        dispatch_policy_version_id="policy-a",
        provider_request_id="provider-request-a",
        provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
        execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
        measurement_status=ModelUsageMeasurementStatus.EXACT,
        pricing_status=ModelUsagePricingStatus.PRICED,
        period=shanghai_billing_period(NOW),
        meters=(
            UsageMeterQuantity(
                meter=ModelUsageMeter.OUTPUT_TOKENS,
                quantity=Decimal("10"),
                meter_role=ModelUsageMeterRole.BILLABLE,
                quantity_source=ModelUsageQuantitySource.PROVIDER,
            ),
        ),
        meter_watermarks=(),
        dispatched_at=NOW,
        completed_at=NOW,
        price_version_id="price-a",
        price_snapshot=None,
        price_snapshot_checksum="checksum",
        fail_open_proof_id=None,
        integrity_key_id="",
        integrity_hmac="",
    )


def test_signer_detects_tampering_and_retains_key_ids() -> None:
    signer = ProviderUsageReceiptSigner(active_key_id="key-2", keys={"key-1": b"old", "key-2": b"current"})
    signed = signer.sign(receipt())
    signer.verify(signed)
    assert signed.integrity_key_id == "key-2"
    with pytest.raises(ModelUsageReceiptIntegrityError, match="receipt_integrity_invalid"):
        signer.verify(replace(signed, capability=ModelUsageCapability.IMAGE_GENERATION))


def test_receipt_log_is_strictly_allowlisted_and_content_free() -> None:
    signed = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"}).sign(receipt())
    payload = receipt_log_payload(signed)
    assert set(payload) == PROVIDER_USAGE_RECEIPT_LOG_FIELDS
    assert "user_id" not in payload
    assert "prompt" not in payload
    assert "integrity_hmac" in payload


def test_bounded_queue_evicts_oldest_and_retries_exact_receipt() -> None:
    queue = ProviderUsageReceiptQueue(max_size=2)
    first = receipt()
    second = replace(first, attempt_key="attempt-b")
    third = replace(first, attempt_key="attempt-c")
    queue.enqueue(first)
    queue.enqueue(second)
    queue.enqueue(third)
    seen: list[str] = []
    queue.retry(lambda item: seen.append(item.attempt_key))
    assert seen == ["attempt-b", "attempt-c"]
    assert len(queue) == 0


def test_retry_preserves_receipt_enqueued_while_current_batch_is_handled() -> None:
    queue = ProviderUsageReceiptQueue(max_size=2)
    first = receipt()
    second = replace(first, attempt_key="attempt-b")
    handler_started = Event()
    allow_first_to_finish = Event()
    seen: list[str] = []

    def handler(item: ProviderUsageReceipt) -> None:
        seen.append(item.attempt_key)
        if item.attempt_key == first.attempt_key:
            handler_started.set()
            assert allow_first_to_finish.wait(timeout=1)

    queue.enqueue(first)
    worker = Thread(target=lambda: queue.retry(handler))
    worker.start()
    assert handler_started.wait(timeout=1)
    queue.enqueue(second)
    allow_first_to_finish.set()
    worker.join(timeout=1)

    assert not worker.is_alive()
    assert seen == [first.attempt_key]
    assert len(queue) == 1
