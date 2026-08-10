from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
)
from app.services.model_usage.adapters.base import MeteredProviderAdapter, MeteredProviderAttempt
from app.services.model_usage.estimators import estimate_embedding
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderUsageReceipt,
    UsageAttribution,
    UsageContext,
    UsageMeterQuantity,
)


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


def _reported_embedding_tokens(raw_usage: object) -> object | None:
    prompt_tokens = _value(raw_usage, "prompt_tokens", default=None)
    if prompt_tokens is not None:
        return prompt_tokens
    return _value(raw_usage, "input_tokens", default=None)


def _stable_digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def normalize_openai_embedding_usage(
    raw_usage: object,
    *,
    billing_scheme_key: str,
) -> tuple[UsageMeterQuantity, ...]:
    """Normalize an OpenAI-compatible embedding response into stable meters."""

    if billing_scheme_key not in {"embedding-token-v1", "unpriced"}:
        raise ModelUsageContractError("unsupported_embedding_billing_scheme")
    raw_tokens = _reported_embedding_tokens(raw_usage)
    if raw_tokens is None:
        raise ModelUsageContractError("provider_embedding_tokens_missing")
    prompt_tokens = _integer(raw_tokens, field="provider_embedding_tokens")
    total_tokens = _value(raw_usage, "total_tokens", default=None)
    if total_tokens is not None and _integer(
        total_tokens,
        field="provider_embedding_total_tokens",
    ) != prompt_tokens:
        raise ModelUsageContractError("embedding_total_tokens_mismatch")
    provider = ModelUsageQuantitySource.PROVIDER
    return (
        UsageMeterQuantity(
            meter=ModelUsageMeter.EMBEDDING_TOKENS,
            quantity=Decimal(prompt_tokens),
            meter_role=ModelUsageMeterRole.BILLABLE,
            quantity_source=provider,
        ),
        UsageMeterQuantity(
            meter=ModelUsageMeter.REQUEST_UNITS,
            quantity=Decimal("1"),
            meter_role=ModelUsageMeterRole.INFORMATIONAL,
            quantity_source=provider,
        ),
    )


@dataclass(slots=True)
class EmbeddingUsageAdapter(MeteredProviderAdapter):
    """Meter exactly one physical, single-family embedding HTTP batch."""

    provider: str = "openai"
    model: str = ""
    dimensions: int = 0
    operation_kind: str = "embedding_batch"

    @staticmethod
    def validate_batch_family(attributions: Sequence[UsageAttribution]) -> str:
        family_ids = {item.family_id for item in attributions}
        if not family_ids:
            raise ModelUsageContractError("embedding_batch_empty")
        if len(family_ids) != 1:
            raise ModelUsageContractError("embedding_batch_crosses_family")
        return next(iter(family_ids))

    def request_fingerprint(self, *, texts: Sequence[str]) -> str:
        """Return an opaque HMAC fingerprint without retaining text content."""

        encoded = json.dumps(
            {
                "dimensions": self.dimensions,
                "model": self.model,
                "texts": list(texts),
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return self.signer.request_fingerprint(encoded)

    def begin_embedding_batch(
        self,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        text_token_estimates: Sequence[int],
        fingerprint: str,
    ) -> MeteredProviderAttempt:
        if not self.provider.strip() or not self.model.strip() or self.dimensions <= 0:
            raise ModelUsageContractError("embedding_adapter_configuration_invalid")
        if not attempt_key.strip() or not fingerprint:
            raise ModelUsageContractError("embedding_attempt_identity_required")
        if not text_token_estimates:
            raise ModelUsageContractError("embedding_batch_empty")
        total_tokens = 0
        for estimate in text_token_estimates:
            if isinstance(estimate, bool) or not isinstance(estimate, int) or estimate <= 0:
                raise ModelUsageContractError("embedding_token_estimate_invalid")
            total_tokens += estimate
        context = UsageContext(
            attribution=attribution,
            capability=ModelUsageCapability.EMBEDDING,
            provider=self.provider,
            requested_model=self.model,
            billing_model=self.model,
            variant_key=f"dimensions={self.dimensions}",
            operation_kind=self.operation_kind,
            attempt_key=attempt_key,
            client_attempt_id=(
                f"mua_embedding_{_stable_digest(attribution.family_id, attempt_key, fingerprint)[:32]}"
            ),
        )
        return self.start_attempt(
            context,
            estimate_embedding(token_count=total_tokens),
            fingerprint=fingerprint,
        )

    def receipt_from_openai_response(
        self,
        permit: DispatchPermit,
        *,
        raw_usage: object | None,
        reported_model: str | None,
        provider_request_id: str | None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not ModelUsageCapability.EMBEDDING:
            raise ModelUsageContractError("embedding_receipt_capability_mismatch")
        if _reported_embedding_tokens(raw_usage) is None:
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
            meters = normalize_openai_embedding_usage(
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
                reported_model=reported_model or self.model,
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
            )
        )
