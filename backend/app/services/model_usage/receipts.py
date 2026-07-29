from __future__ import annotations

import hashlib
import hmac
import json
import logging
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import fields, is_dataclass, replace
from datetime import datetime
from decimal import Decimal
from enum import Enum

from app.services.model_usage.errors import ModelUsageReceiptIntegrityError
from app.services.model_usage.types import ProviderUsageReceipt


logger = logging.getLogger(__name__)


PROVIDER_USAGE_RECEIPT_LOG_FIELDS = frozenset(
    {
        "reservation_id",
        "family_id",
        "subject_key",
        "capability",
        "provider",
        "requested_model",
        "reported_model",
        "billing_model",
        "variant_key",
        "billing_scheme_key",
        "attempt_key",
        "fingerprint",
        "client_attempt_id",
        "period_start",
        "period_end",
        "policy_version_id",
        "dispatch_policy_version_id",
        "provider_request_id",
        "provider_outcome",
        "execution_certainty",
        "measurement_status",
        "pricing_status",
        "meters",
        "meter_watermarks",
        "dispatched_at",
        "completed_at",
        "price_version_id",
        "price_snapshot",
        "price_snapshot_checksum",
        "fail_open_proof_id",
        "integrity_key_id",
        "integrity_hmac",
    }
)


def _safe_value(value: object) -> object:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (tuple, list, frozenset)):
        return [_safe_value(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _safe_value(item) for key, item in sorted(value.items())}
    if is_dataclass(value):
        return {field.name: _safe_value(getattr(value, field.name)) for field in fields(value)}
    raise TypeError(f"receipt field type is not allowlisted: {type(value).__name__}")


def receipt_log_payload(receipt: ProviderUsageReceipt) -> dict[str, object]:
    payload = {
        "reservation_id": receipt.reservation_id,
        "family_id": receipt.family_id,
        "subject_key": receipt.subject_key,
        "capability": receipt.capability.value,
        "provider": receipt.provider,
        "requested_model": receipt.requested_model,
        "reported_model": receipt.reported_model,
        "billing_model": receipt.billing_model,
        "variant_key": receipt.variant_key,
        "billing_scheme_key": receipt.billing_scheme_key,
        "attempt_key": receipt.attempt_key,
        "fingerprint": receipt.fingerprint,
        "client_attempt_id": receipt.client_attempt_id,
        "period_start": receipt.period.start_at.isoformat(),
        "period_end": receipt.period.end_at.isoformat(),
        "policy_version_id": receipt.policy_version_id,
        "dispatch_policy_version_id": receipt.dispatch_policy_version_id,
        "provider_request_id": receipt.provider_request_id,
        "provider_outcome": receipt.provider_outcome.value,
        "execution_certainty": receipt.execution_certainty.value,
        "measurement_status": receipt.measurement_status.value,
        "pricing_status": receipt.pricing_status.value,
        "meters": _safe_value(receipt.meters),
        "meter_watermarks": _safe_value(receipt.meter_watermarks),
        "dispatched_at": receipt.dispatched_at.isoformat(),
        "completed_at": receipt.completed_at.isoformat(),
        "price_version_id": receipt.price_version_id,
        "price_snapshot": _safe_value(receipt.price_snapshot),
        "price_snapshot_checksum": receipt.price_snapshot_checksum,
        "fail_open_proof_id": receipt.fail_open_proof_id,
        "integrity_key_id": receipt.integrity_key_id,
        "integrity_hmac": receipt.integrity_hmac,
    }
    if set(payload) != PROVIDER_USAGE_RECEIPT_LOG_FIELDS:
        raise ModelUsageReceiptIntegrityError("receipt_log_schema_invalid")
    return payload


def _canonical_unsigned(receipt: ProviderUsageReceipt) -> bytes:
    payload = receipt_log_payload(replace(receipt, integrity_hmac=""))
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


class ProviderUsageReceiptSigner:
    def __init__(self, *, active_key_id: str, keys: Mapping[str, bytes]) -> None:
        if active_key_id not in keys or not active_key_id:
            raise ValueError("active receipt integrity key is required")
        if any(not key for key in keys.values()):
            raise ValueError("receipt integrity keys cannot be empty")
        self._active_key_id = active_key_id
        self._keys = dict(keys)

    def sign(self, receipt: ProviderUsageReceipt) -> ProviderUsageReceipt:
        unsigned = replace(
            receipt,
            integrity_key_id=self._active_key_id,
            integrity_hmac="",
        )
        digest = hmac.new(
            self._keys[self._active_key_id],
            b"culina:model-usage-receipt:v1\0" + _canonical_unsigned(unsigned),
            hashlib.sha256,
        ).hexdigest()
        return replace(unsigned, integrity_hmac=digest)

    def verify(self, receipt: ProviderUsageReceipt) -> None:
        key = self._keys.get(receipt.integrity_key_id)
        if key is None:
            raise ModelUsageReceiptIntegrityError("receipt_integrity_key_unknown")
        expected = hmac.new(
            key,
            b"culina:model-usage-receipt:v1\0" + _canonical_unsigned(receipt),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(expected, receipt.integrity_hmac):
            raise ModelUsageReceiptIntegrityError("receipt_integrity_invalid")


class ProviderUsageReceiptQueue:
    def __init__(self, *, max_size: int) -> None:
        if max_size <= 0:
            raise ValueError("receipt queue max_size must be positive")
        self._items: deque[ProviderUsageReceipt] = deque(maxlen=max_size)

    def __len__(self) -> int:
        return len(self._items)

    def enqueue(self, receipt: ProviderUsageReceipt) -> None:
        if len(self._items) == self._items.maxlen:
            evicted = self._items[0]
            logger.error(
                "model_usage_receipt_queue_evicted %s",
                json.dumps(receipt_log_payload(evicted), ensure_ascii=False, sort_keys=True),
            )
        self._items.append(receipt)
        logger.warning(
            "model_usage_receipt_pending %s",
            json.dumps(receipt_log_payload(receipt), ensure_ascii=False, sort_keys=True),
        )

    def retry(self, handler: Callable[[ProviderUsageReceipt], object]) -> None:
        remaining: deque[ProviderUsageReceipt] = deque(maxlen=self._items.maxlen)
        while self._items:
            receipt = self._items.popleft()
            try:
                handler(receipt)
            except Exception:
                remaining.append(receipt)
        self._items = remaining
