from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from collections.abc import Callable
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
from sqlalchemy.orm import Session

from app.services.family_model_settings.types import (
    EmbeddingUsageSnapshot,
    ResolvedSearchProfile,
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
    receipt_identity_from_permit,
)


@dataclass(frozen=True, slots=True)
class EmbeddingUsageDependencies:
    """Runtime-owned dependencies for a family-bound embedding adapter."""

    usage_facade: object
    session_factory: Callable[[], Session]
    signer: object
    clock: Callable[[], datetime] | None = None


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
    input_tokens = _value(raw_usage, "input_tokens", default=None)
    if input_tokens is not None:
        return input_tokens
    # Native DashScope embedding responses report only ``total_tokens``.
    # For a single embedding request this is the provider's billable input
    # token count, so it can be settled exactly instead of falling back to an
    # estimate (the OpenAI-compatible fields above remain authoritative when
    # present).
    return _value(raw_usage, "total_tokens", default=None)


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
    binding: ResolvedSearchProfile | None = None

    def __post_init__(self) -> None:
        if self.binding is None:
            return
        if self.binding.adapter_kind not in {"openai_compatible_http", "dashscope"}:
            raise ModelUsageContractError("embedding_binding_adapter_unsupported")
        self.provider = self.binding.provider_profile_id
        self.model = self.binding.embedding_model
        self.dimensions = self.binding.dimensions

    @classmethod
    def for_search_profile(
        cls,
        profile: ResolvedSearchProfile,
        dependencies: EmbeddingUsageDependencies,
    ) -> "EmbeddingUsageAdapter":
        kwargs = {
            "usage_facade": dependencies.usage_facade,
            "session_factory": dependencies.session_factory,
            "signer": dependencies.signer,
            "binding": profile,
        }
        if dependencies.clock is not None:
            kwargs["clock"] = dependencies.clock
        return cls(**kwargs)  # type: ignore[arg-type]

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
        usage_snapshot: EmbeddingUsageSnapshot | None = None,
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
        if self.binding is not None:
            if usage_snapshot is None:
                raise ModelUsageContractError("embedding_usage_snapshot_required")
            if usage_snapshot.candidate != (usage_snapshot.config_revision_id is None):
                raise ModelUsageContractError("embedding_usage_snapshot_invalid")
            provider = self.binding.provider_profile_id
            model = self.binding.embedding_model
            variant_key = "search"
            config_revision_id = usage_snapshot.config_revision_id
            provider_profile_id = self.binding.provider_profile_id
            provider_profile_version_id = self.binding.provider_profile_version_id
            search_profile_id = self.binding.search_profile_id
            explicit_price_version_id = usage_snapshot.price_version_id
        else:
            provider = self.provider
            model = self.model
            variant_key = f"dimensions={self.dimensions}"
            config_revision_id = None
            provider_profile_id = None
            provider_profile_version_id = None
            search_profile_id = None
            explicit_price_version_id = None
        context = UsageContext(
            attribution=attribution,
            capability=ModelUsageCapability.EMBEDDING,
            provider=provider,
            requested_model=model,
            billing_model=model,
            variant_key=variant_key,
            operation_kind=self.operation_kind,
            attempt_key=attempt_key,
            client_attempt_id=(
                f"mua_embedding_{_stable_digest(attribution.family_id, attempt_key, fingerprint)[:32]}"
            ),
            config_revision_id=config_revision_id,
            provider_profile_id=provider_profile_id,
            provider_profile_version_id=provider_profile_version_id,
            search_profile_id=search_profile_id,
            explicit_price_version_id=explicit_price_version_id,
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
        if permit.capability is not ModelUsageCapability.EMBEDDING:
            raise ModelUsageContractError("embedding_receipt_capability_mismatch")
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
