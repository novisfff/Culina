from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
)
from app.core.utils import utcnow
from app.services.model_usage.adapters.base import (
    MeteredProviderAdapter,
    MeteredProviderAttempt,
)
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderUsageReceipt,
    UsageAttribution,
    UsageContext,
    UsageMeterQuantity,
    receipt_identity_from_permit,
)
from app.services.family_model_settings.types import ResolvedCapabilityBinding


def _integer(value: object, *, field: str) -> int:
    if isinstance(value, bool):
        raise ModelUsageContractError(f"{field}_invalid")
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise ModelUsageContractError(f"{field}_invalid") from exc
    if result < 0 or (isinstance(value, float) and value != result):
        raise ModelUsageContractError(f"{field}_invalid")
    return result


def _value(raw: object, name: str, *, default: object = 0) -> object:
    if isinstance(raw, Mapping):
        return raw.get(name, default)
    return getattr(raw, name, default)


def _nested_value(raw: object, name: str, nested: str, *, default: object = 0) -> object:
    return _value(_value(raw, name, default={}), nested, default=default)


def normalize_openai_token_usage(
    raw_usage: object,
    *,
    billing_scheme_key: str,
) -> tuple[UsageMeterQuantity, ...]:
    """Convert Chat/Responses token usage into the canonical LLM meter set."""

    # A monitoring-policy family may reserve before its price catalogue is
    # available.  It still needs the canonical LLM meter set, while pricing is
    # recorded as ``unpriced`` by the ledger.
    if billing_scheme_key not in {"llm-split-v1", "unpriced"}:
        raise ModelUsageContractError("unsupported_llm_billing_scheme")
    input_tokens = _integer(
        _value(raw_usage, "input_tokens", default=_value(raw_usage, "prompt_tokens")),
        field="provider_input_tokens",
    )
    output_tokens = _integer(
        _value(raw_usage, "output_tokens", default=_value(raw_usage, "completion_tokens")),
        field="provider_output_tokens",
    )
    cached_tokens = _integer(
        _nested_value(
            raw_usage,
            "input_token_details",
            "cache_read",
            default=_nested_value(
                raw_usage,
                "prompt_tokens_details",
                "cached_tokens",
                default=0,
            ),
        ),
        field="provider_cached_input_tokens",
    )
    if cached_tokens > input_tokens:
        raise ModelUsageContractError("cached_input_exceeds_input")
    uncached_tokens = input_tokens - cached_tokens
    total_tokens = input_tokens + output_tokens
    provider = ModelUsageQuantitySource.PROVIDER
    return (
        UsageMeterQuantity(
            ModelUsageMeter.INPUT_TOKENS,
            Decimal(input_tokens),
            ModelUsageMeterRole.INFORMATIONAL,
            provider,
        ),
        UsageMeterQuantity(
            ModelUsageMeter.UNCACHED_INPUT_TOKENS,
            Decimal(uncached_tokens),
            ModelUsageMeterRole.BILLABLE,
            provider,
        ),
        UsageMeterQuantity(
            ModelUsageMeter.CACHED_INPUT_TOKENS,
            Decimal(cached_tokens),
            ModelUsageMeterRole.BILLABLE,
            provider,
        ),
        UsageMeterQuantity(
            ModelUsageMeter.OUTPUT_TOKENS,
            Decimal(output_tokens),
            ModelUsageMeterRole.BILLABLE,
            provider,
        ),
        UsageMeterQuantity(
            ModelUsageMeter.TOTAL_TOKENS,
            Decimal(total_tokens),
            ModelUsageMeterRole.INFORMATIONAL,
            provider,
        ),
    )


def _stable_digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


@dataclass(slots=True)
class LLMUsageAdapter(MeteredProviderAdapter):
    provider: str = "openai"
    variant_key: str = "default"
    operation_kind: str = "chat_provider_round"
    binding: ResolvedCapabilityBinding | None = None

    def __post_init__(self) -> None:
        if self.binding is None:
            return
        if self.binding.capability != "llm":
            raise ModelUsageContractError("llm_binding_required")
        self.provider = self.binding.provider_profile_id
        self.variant_key = self.binding.variant_key

    def request_fingerprint(self, payload: object) -> str:
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        return self.signer.request_fingerprint(encoded)

    def start_round(
        self,
        attribution: UsageAttribution,
        *,
        provider_round: int,
        attempt_index: int,
        model: str,
        input_estimate: int,
        output_cap: int,
        fingerprint: str,
        billing_model: str | None = None,
    ) -> MeteredProviderAttempt:
        if provider_round <= 0 or attempt_index <= 0:
            raise ModelUsageContractError("provider_round_and_attempt_index_must_be_positive")
        if not model:
            raise ModelUsageContractError("llm_model_required")
        if self.binding is not None and model != self.binding.requested_model:
            raise ModelUsageContractError("llm_binding_model_mismatch")
        logical_digest = _stable_digest(
            attribution.family_id,
            attribution.logical_operation_id,
            self.provider,
            model,
        )[:32]
        attempt_key = (
            f"llm:{logical_digest}:round:{provider_round}:attempt:{attempt_index}"
        )
        client_attempt_id = f"mua_llm_{_stable_digest(attempt_key, fingerprint)[:32]}"
        context = UsageContext(
            attribution=attribution,
            capability=ModelUsageCapability.LLM,
            provider=self.provider,
            requested_model=model,
            billing_model=billing_model or model,
            variant_key=self.variant_key,
            operation_kind=self.operation_kind,
            attempt_key=attempt_key,
            client_attempt_id=client_attempt_id,
            config_revision_id=(
                self.binding.config_revision_id if self.binding is not None else None
            ),
            provider_profile_id=(
                self.binding.provider_profile_id if self.binding is not None else None
            ),
            provider_profile_version_id=(
                self.binding.provider_profile_version_id if self.binding is not None else None
            ),
        )
        estimate = estimate_llm(
            input_tokens=input_estimate,
            cached_input_tokens=0,
            max_output_tokens=output_cap,
        )
        return self.start_attempt(context, estimate, fingerprint=fingerprint)

    def receipt_from_openai_usage(
        self,
        permit: DispatchPermit,
        *,
        raw_usage: object | None,
        reported_model: str | None,
        provider_request_id: str | None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if raw_usage is None:
            meters = tuple(
                UsageMeterQuantity(
                    meter=line.meter,
                    quantity=line.quantity,
                    meter_role=line.meter_role,
                    quantity_source=ModelUsageQuantitySource.ESTIMATED,
                )
                for line in permit.required_meters
            )
            measurement_status = ModelUsageMeasurementStatus.ESTIMATED
        else:
            meters = normalize_openai_token_usage(
                raw_usage,
                billing_scheme_key=permit.billing_scheme_key,
            )
            measurement_status = ModelUsageMeasurementStatus.EXACT
        return self.signer.sign(
            ProviderUsageReceipt(
                reservation_id=permit.reservation_id,
                family_id=permit.family_id,
                subject_key=permit.subject_key,
                capability=permit.capability,
                provider=permit.provider,
                requested_model=permit.requested_model,
                reported_model=reported_model,
                billing_model=permit.billing_model,
                variant_key=permit.variant_key,
                billing_scheme_key=permit.billing_scheme_key,
                attempt_key=permit.attempt_key,
                fingerprint=permit.fingerprint,
                client_attempt_id=permit.client_attempt_id,
                policy_version_id=permit.policy_version_id,
                dispatch_policy_version_id=permit.dispatch_policy_version_id,
                provider_request_id=provider_request_id,
                provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
                execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
                measurement_status=measurement_status,
                pricing_status=permit.pricing_status,
                period=permit.period,
                meters=meters,
                meter_watermarks=(),
                dispatched_at=permit.dispatched_at,
                completed_at=completed_at or self.clock(),
                price_version_id=permit.price_version_id,
                price_snapshot=permit.price_snapshot,
                price_snapshot_checksum=permit.price_snapshot_checksum,
                fail_open_proof_id=permit.fail_open_proof_id,
                integrity_key_id="",
                integrity_hmac="",
                required_meters=permit.required_meters,
                **receipt_identity_from_permit(permit),
            )
        )

    def confirmed_not_executed_receipt(
        self,
        permit: DispatchPermit,
        *,
        stable_provider_request_id: str | None = None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        meters = tuple(
            UsageMeterQuantity(
                meter=line.meter,
                quantity=Decimal("0"),
                meter_role=line.meter_role,
                quantity_source=ModelUsageQuantitySource.PROVIDER,
            )
            for line in permit.required_meters
        )
        return self.signer.sign(
            ProviderUsageReceipt(
                reservation_id=permit.reservation_id,
                family_id=permit.family_id,
                subject_key=permit.subject_key,
                capability=permit.capability,
                provider=permit.provider,
                requested_model=permit.requested_model,
                reported_model=None,
                billing_model=permit.billing_model,
                variant_key=permit.variant_key,
                billing_scheme_key=permit.billing_scheme_key,
                attempt_key=permit.attempt_key,
                fingerprint=permit.fingerprint,
                client_attempt_id=permit.client_attempt_id,
                policy_version_id=permit.policy_version_id,
                dispatch_policy_version_id=permit.dispatch_policy_version_id,
                provider_request_id=stable_provider_request_id,
                provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
                execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
                measurement_status=ModelUsageMeasurementStatus.EXACT,
                pricing_status=permit.pricing_status,
                period=permit.period,
                meters=meters,
                meter_watermarks=(),
                dispatched_at=permit.dispatched_at,
                completed_at=completed_at or self.clock(),
                price_version_id=permit.price_version_id,
                price_snapshot=permit.price_snapshot,
                price_snapshot_checksum=permit.price_snapshot_checksum,
                fail_open_proof_id=permit.fail_open_proof_id,
                integrity_key_id="",
                integrity_hmac="",
                required_meters=permit.required_meters,
                **receipt_identity_from_permit(permit),
            )
        )
