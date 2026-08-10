from __future__ import annotations

import hashlib
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
from app.services.model_usage.estimators import estimate_rerank
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderUsageReceipt,
    UsageAttribution,
    UsageContext,
    UsageMeterQuantity,
)


def _stable_digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


@dataclass(slots=True)
class RerankUsageAdapter(MeteredProviderAdapter):
    """Meter one physical rerank request without retaining search content."""

    provider: str = "openai-compatible"
    model: str = ""
    candidate_limit: int = 50
    operation_kind: str = "search_rerank"

    def begin(
        self,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        estimated_input_tokens: int,
        fingerprint: str,
    ) -> MeteredProviderAttempt:
        if (
            not self.provider.strip()
            or not self.model.strip()
            or isinstance(self.candidate_limit, bool)
            or not isinstance(self.candidate_limit, int)
            or self.candidate_limit <= 0
        ):
            raise ModelUsageContractError("rerank_adapter_configuration_invalid")
        if not attempt_key.strip() or not fingerprint:
            raise ModelUsageContractError("rerank_attempt_identity_required")
        if (
            isinstance(estimated_input_tokens, bool)
            or not isinstance(estimated_input_tokens, int)
            or estimated_input_tokens <= 0
        ):
            raise ModelUsageContractError("rerank_input_tokens_invalid")

        context = UsageContext(
            attribution=attribution,
            capability=ModelUsageCapability.RERANK,
            provider=self.provider,
            requested_model=self.model,
            billing_model=self.model,
            variant_key=f"top_n={self.candidate_limit}",
            operation_kind=self.operation_kind,
            attempt_key=attempt_key,
            client_attempt_id=(
                f"mua_rerank_{_stable_digest(attribution.family_id, attempt_key, fingerprint)[:32]}"
            ),
        )
        return self.start_attempt(
            context,
            estimate_rerank(input_tokens=estimated_input_tokens),
            fingerprint=fingerprint,
        )

    def receipt_from_response(
        self,
        permit: DispatchPermit,
        *,
        reported_model: str | None,
        provider_request_id: str | None,
        provider_input_tokens: int,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not ModelUsageCapability.RERANK:
            raise ModelUsageContractError("rerank_receipt_capability_mismatch")
        if (
            isinstance(provider_input_tokens, bool)
            or not isinstance(provider_input_tokens, int)
            or provider_input_tokens <= 0
        ):
            raise ModelUsageContractError("rerank_provider_usage_invalid")
        meters = tuple(
            UsageMeterQuantity(
                meter=line.meter,
                quantity=Decimal(provider_input_tokens),
                meter_role=line.meter_role,
                quantity_source=ModelUsageQuantitySource.PROVIDER,
            )
            for line in permit.required_meters
            if line.meter is ModelUsageMeter.INPUT_TOKENS
        )
        if len(meters) != len(permit.required_meters):
            raise ModelUsageContractError("rerank_meter_unsupported")
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
            )
        )

    def confirmed_not_executed_receipt(
        self,
        permit: DispatchPermit,
        *,
        stable_provider_request_id: str | None = None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not ModelUsageCapability.RERANK:
            raise ModelUsageContractError("rerank_receipt_capability_mismatch")
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
            )
        )
