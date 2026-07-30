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
from threading import Lock

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
from app.services.model_usage.periods import BillingPeriod, SHANGHAI
from app.services.model_usage.pricing import UsagePriceRateSnapshot, UsagePriceSnapshot
from app.services.model_usage.types import (
    ProviderMeterWatermark,
    ProviderUsageReceipt,
    UsageMeterQuantity,
)


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
        "required_meters",
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
        "required_meters": _safe_value(receipt.required_meters),
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


def _parse_datetime(value: object) -> datetime:
    if not isinstance(value, str):
        raise ModelUsageReceiptIntegrityError("receipt_log_datetime_invalid")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ModelUsageReceiptIntegrityError("receipt_log_datetime_invalid") from exc


def _required_string(payload: Mapping[str, object], field: str) -> str:
    value = payload[field]
    if not isinstance(value, str) or not value:
        raise TypeError
    return value


def _optional_string(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise TypeError
    return value


def provider_usage_receipt_from_log_payload(
    payload: Mapping[str, object],
) -> ProviderUsageReceipt:
    if set(payload) != PROVIDER_USAGE_RECEIPT_LOG_FIELDS:
        raise ModelUsageReceiptIntegrityError("receipt_log_schema_invalid")
    try:
        required_strings = {
            field: _required_string(payload, field)
            for field in (
                "family_id",
                "subject_key",
                "provider",
                "requested_model",
                "billing_model",
                "variant_key",
                "billing_scheme_key",
                "attempt_key",
                "fingerprint",
                "client_attempt_id",
                "policy_version_id",
                "dispatch_policy_version_id",
                "integrity_key_id",
                "integrity_hmac",
            )
        }
        meter_payloads = payload["meters"]
        required_meter_payloads = payload["required_meters"]
        watermark_payloads = payload["meter_watermarks"]
        if (
            not isinstance(meter_payloads, list)
            or not isinstance(required_meter_payloads, list)
            or not isinstance(watermark_payloads, list)
        ):
            raise TypeError
        meters = tuple(
            UsageMeterQuantity(
                meter=ModelUsageMeter(item["meter"]),
                quantity=Decimal(item["quantity"]),
                meter_role=ModelUsageMeterRole(item["meter_role"]),
                quantity_source=ModelUsageQuantitySource(item["quantity_source"]),
            )
            for item in meter_payloads
            if isinstance(item, dict)
        )
        if len(meters) != len(meter_payloads):
            raise TypeError
        required_meters = tuple(
            UsageMeterQuantity(
                meter=ModelUsageMeter(item["meter"]),
                quantity=Decimal(item["quantity"]),
                meter_role=ModelUsageMeterRole(item["meter_role"]),
                quantity_source=ModelUsageQuantitySource(item["quantity_source"]),
            )
            for item in required_meter_payloads
            if isinstance(item, dict)
        )
        if len(required_meters) != len(required_meter_payloads):
            raise TypeError
        watermarks = tuple(
            ProviderMeterWatermark(
                meter=ModelUsageMeter(item["meter"]),
                lease_sequence=int(item["lease_sequence"]),
                baseline_quantity=Decimal(item["baseline_quantity"]),
                cumulative_quantity=Decimal(item["cumulative_quantity"]),
            )
            for item in watermark_payloads
            if isinstance(item, dict)
        )
        if len(watermarks) != len(watermark_payloads):
            raise TypeError
        raw_snapshot = payload["price_snapshot"]
        price_snapshot = None
        if raw_snapshot is not None:
            if not isinstance(raw_snapshot, dict):
                raise TypeError
            raw_rates = raw_snapshot["rates"]
            if not isinstance(raw_rates, list):
                raise TypeError
            rates = tuple(
                UsagePriceRateSnapshot(
                    meter=ModelUsageMeter(item["meter"]),
                    meter_role=ModelUsageMeterRole(item["meter_role"]),
                    unit_quantity=Decimal(item["unit_quantity"]),
                    unit_price=(
                        Decimal(item["unit_price"])
                        if item["unit_price"] is not None
                        else None
                    ),
                    source_currency=item["source_currency"],
                    fx_to_cny=Decimal(item["fx_to_cny"]) if item["fx_to_cny"] is not None else None,
                    unit_price_cny=(
                        Decimal(item["unit_price_cny"])
                        if item["unit_price_cny"] is not None
                        else None
                    ),
                )
                for item in raw_rates
                if isinstance(item, dict)
            )
            if len(rates) != len(raw_rates):
                raise TypeError
            price_snapshot = UsagePriceSnapshot(
                pricing_status=ModelUsagePricingStatus(raw_snapshot["pricing_status"]),
                price_version_id=_optional_string(raw_snapshot["price_version_id"]),
                billing_model=_required_string(raw_snapshot, "billing_model"),
                billing_scheme_key=_optional_string(raw_snapshot["billing_scheme_key"]),
                rates=rates,
                missing_billable_meters=frozenset(
                    ModelUsageMeter(value)
                    for value in raw_snapshot["missing_billable_meters"]
                ),
                checksum=_optional_string(raw_snapshot["checksum"]),
            )
        period_start = _parse_datetime(payload["period_start"])
        period_end = _parse_datetime(payload["period_end"])
        return ProviderUsageReceipt(
            reservation_id=_optional_string(payload["reservation_id"]),
            family_id=required_strings["family_id"],
            subject_key=required_strings["subject_key"],
            capability=ModelUsageCapability(payload["capability"]),
            provider=required_strings["provider"],
            requested_model=required_strings["requested_model"],
            reported_model=_optional_string(payload["reported_model"]),
            billing_model=required_strings["billing_model"],
            variant_key=required_strings["variant_key"],
            billing_scheme_key=required_strings["billing_scheme_key"],
            attempt_key=required_strings["attempt_key"],
            fingerprint=required_strings["fingerprint"],
            client_attempt_id=required_strings["client_attempt_id"],
            policy_version_id=required_strings["policy_version_id"],
            dispatch_policy_version_id=required_strings["dispatch_policy_version_id"],
            provider_request_id=_optional_string(payload["provider_request_id"]),
            provider_outcome=ModelUsageProviderOutcome(payload["provider_outcome"]),
            execution_certainty=ModelUsageExecutionCertainty(payload["execution_certainty"]),
            measurement_status=ModelUsageMeasurementStatus(payload["measurement_status"]),
            pricing_status=ModelUsagePricingStatus(payload["pricing_status"]),
            period=BillingPeriod(
                local_month=period_start.astimezone(SHANGHAI).strftime("%Y-%m"),
                start_at=period_start,
                end_at=period_end,
            ),
            meters=meters,
            meter_watermarks=watermarks,
            dispatched_at=_parse_datetime(payload["dispatched_at"]),
            completed_at=_parse_datetime(payload["completed_at"]),
            price_version_id=_optional_string(payload["price_version_id"]),
            price_snapshot=price_snapshot,
            price_snapshot_checksum=_optional_string(payload["price_snapshot_checksum"]),
            fail_open_proof_id=_optional_string(payload["fail_open_proof_id"]),
            integrity_key_id=required_strings["integrity_key_id"],
            integrity_hmac=required_strings["integrity_hmac"],
            required_meters=required_meters,
        )
    except (KeyError, TypeError, ValueError, ArithmeticError) as exc:
        raise ModelUsageReceiptIntegrityError("receipt_log_payload_invalid") from exc


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
        self._max_size = max_size
        self._items: deque[ProviderUsageReceipt] = deque()
        self._lock = Lock()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def _append_locked(self, receipt: ProviderUsageReceipt) -> ProviderUsageReceipt | None:
        evicted = self._items.popleft() if len(self._items) >= self._max_size else None
        self._items.append(receipt)
        return evicted

    @staticmethod
    def _log_evicted(receipt: ProviderUsageReceipt) -> None:
        logger.error(
            "model_usage_receipt_queue_evicted %s",
            json.dumps(receipt_log_payload(receipt), ensure_ascii=False, sort_keys=True),
        )

    def enqueue(self, receipt: ProviderUsageReceipt) -> None:
        with self._lock:
            evicted = self._append_locked(receipt)
        if evicted is not None:
            self._log_evicted(evicted)
        logger.warning(
            "model_usage_receipt_pending %s",
            json.dumps(receipt_log_payload(receipt), ensure_ascii=False, sort_keys=True),
        )

    def retry(self, handler: Callable[[ProviderUsageReceipt], object]) -> None:
        with self._lock:
            batch = tuple(self._items)
            self._items.clear()
        remaining: list[ProviderUsageReceipt] = []
        for receipt in batch:
            try:
                handler(receipt)
            except Exception:
                remaining.append(receipt)
        with self._lock:
            concurrent_items = tuple(self._items)
            self._items.clear()
            evicted = [
                dropped
                for item in (*remaining, *concurrent_items)
                if (dropped := self._append_locked(item)) is not None
            ]
        for dropped in evicted:
            self._log_evicted(dropped)
