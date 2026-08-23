from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageOperationSource,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
)
from app.services.model_usage.adapters.base import MeteredProviderAdapter, MeteredProviderAttempt
from app.services.model_usage.estimators import estimate_image_generation
from app.services.model_usage.errors import ModelUsageContractError
from app.services.family_model_settings.types import ResolvedCapabilityBinding
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderUsageReceipt,
    UsageAttribution,
    UsageContext,
    UsageMeterQuantity,
    receipt_identity_from_permit,
)


def _stable_digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


@dataclass(slots=True)
class ImageGenerationUsageAdapter(MeteredProviderAdapter):
    """Meter one image provider request without retaining image content.

    The image job owns the durable provider-attempt sequence.  This adapter
    accepts only that sequence plus billing dimensions; callers HMAC the
    transient prompt/reference payload before passing it as ``fingerprint``.
    """

    provider: str = "dashscope"
    model: str = ""
    operation_kind: str = "image_generation_job"
    include_request_fee_by_default: bool = False
    binding: ResolvedCapabilityBinding | None = None

    def __post_init__(self) -> None:
        if self.binding is None:
            return
        if self.binding.capability != "image_generation":
            raise ModelUsageContractError("image_binding_required")
        self.provider = self.binding.provider_profile_id
        self.model = self.binding.requested_model

    def request_fingerprint(self, payload: object) -> str:
        """HMAC request material without storing its prompt or media bytes."""

        if isinstance(payload, bytes):
            encoded = payload
        else:
            encoded = json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            ).encode("utf-8")
        return self.signer.request_fingerprint(encoded)

    def begin(
        self,
        *,
        attribution: UsageAttribution,
        attempt_key: str,
        mode: str,
        image_count: int,
        size: str,
        quality: str,
        fingerprint: str,
        include_request_fee: bool | None = None,
        binding: ResolvedCapabilityBinding | None = None,
    ) -> MeteredProviderAttempt:
        resolved_binding = binding or self.binding
        if resolved_binding is not None:
            if resolved_binding.capability != "image_generation":
                raise ModelUsageContractError("image_binding_required")
            if resolved_binding.variant_key != str(mode or "").strip().lower():
                raise ModelUsageContractError("image_binding_variant_mismatch")
            provider = resolved_binding.provider_profile_id
            model = resolved_binding.requested_model
            billing_model = resolved_binding.billing_model
            variant_key = resolved_binding.variant_key
        else:
            provider = self.provider
            model = self.model
            billing_model = self.model
            variant_key = ""
        if not provider.strip() or not model.strip():
            raise ModelUsageContractError("image_adapter_configuration_invalid")
        if not attempt_key.strip() or not fingerprint:
            raise ModelUsageContractError("image_attempt_identity_required")
        if attribution.attribution_kind is not ModelUsageAttributionKind.USER or not attribution.actor_user_id:
            raise ModelUsageContractError("image_job_user_attribution_required")
        if attribution.operation_source is not ModelUsageOperationSource.IMAGE_JOB:
            raise ModelUsageContractError("image_job_operation_source_required")
        normalized_mode = str(mode or "").strip().lower()
        normalized_size = str(size or "").strip()
        normalized_quality = str(quality or "").strip().lower()
        if normalized_mode not in {"text", "reference"}:
            raise ModelUsageContractError("image_generation_mode_invalid")
        if not normalized_size or not normalized_quality:
            raise ModelUsageContractError("image_generation_variant_invalid")
        include_fee = (
            self.include_request_fee_by_default
            if include_request_fee is None
            else include_request_fee
        )
        if not isinstance(include_fee, bool):
            raise ModelUsageContractError("image_request_fee_flag_invalid")

        context = UsageContext(
            attribution=attribution,
            capability=ModelUsageCapability.IMAGE_GENERATION,
            provider=provider,
            requested_model=model,
            billing_model=billing_model,
            variant_key=(
                variant_key
                if resolved_binding is not None
                else f"mode={normalized_mode}|size={normalized_size}|quality={normalized_quality}"
            ),
            operation_kind=self.operation_kind,
            attempt_key=attempt_key,
            client_attempt_id=(
                f"mua_image_{_stable_digest(attribution.family_id, attempt_key, fingerprint)[:32]}"
            ),
            config_revision_id=(
                resolved_binding.config_revision_id if resolved_binding is not None else None
            ),
            provider_profile_id=(
                resolved_binding.provider_profile_id if resolved_binding is not None else None
            ),
            provider_profile_version_id=(
                resolved_binding.provider_profile_version_id if resolved_binding is not None else None
            ),
        )
        return self.start_attempt(
            context,
            estimate_image_generation(
                image_count=image_count,
                include_request_fee=include_fee,
            ),
            fingerprint=fingerprint,
        )

    def begin_image(
        self,
        *,
        attribution: UsageAttribution,
        binding: ResolvedCapabilityBinding,
        attempt_key: str,
        request: object,
        fingerprint: str,
        image_count: int = 1,
        include_request_fee: bool | None = None,
    ) -> MeteredProviderAttempt:
        """Convenience boundary for family-bound image job callers.

        ``request`` is intentionally duck-typed to avoid coupling the ledger
        adapter back to the image runtime module.  Only its normalized billing
        dimensions are read here; prompt and media content remain outside the
        usage context.
        """

        mode = getattr(getattr(request, "mode", None), "value", getattr(request, "mode", ""))
        return self.begin(
            attribution=attribution,
            attempt_key=attempt_key,
            mode=str(mode),
            image_count=image_count,
            size=str(getattr(request, "size", "")),
            quality=str(getattr(request, "quality", "")),
            fingerprint=fingerprint,
            include_request_fee=include_request_fee,
            binding=binding,
        )

    def receipt_from_provider_success(
        self,
        permit: DispatchPermit,
        *,
        reported_model: str | None,
        provider_request_id: str | None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not ModelUsageCapability.IMAGE_GENERATION:
            raise ModelUsageContractError("image_receipt_capability_mismatch")
        meters = tuple(
            UsageMeterQuantity(
                meter=line.meter,
                quantity=line.quantity,
                meter_role=line.meter_role,
                # The worker fixes ``n`` and confirms that exactly one result
                # was obtained before constructing this receipt.
                quantity_source=ModelUsageQuantitySource.SERVER_MEASURED,
            )
            for line in permit.required_meters
        )
        return self._signed_receipt(
            permit,
            reported_model=reported_model or permit.requested_model,
            provider_request_id=provider_request_id,
            provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            meters=meters,
            completed_at=completed_at,
        )

    def confirmed_not_executed_receipt(
        self,
        permit: DispatchPermit,
        *,
        stable_provider_request_id: str | None = None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not ModelUsageCapability.IMAGE_GENERATION:
            raise ModelUsageContractError("image_receipt_capability_mismatch")
        meters = tuple(
            UsageMeterQuantity(
                meter=line.meter,
                quantity=Decimal("0"),
                meter_role=line.meter_role,
                quantity_source=ModelUsageQuantitySource.PROVIDER,
            )
            for line in permit.required_meters
        )
        return self._signed_receipt(
            permit,
            reported_model=None,
            provider_request_id=stable_provider_request_id,
            provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            meters=meters,
            completed_at=completed_at,
        )

    def _signed_receipt(
        self,
        permit: DispatchPermit,
        *,
        reported_model: str | None,
        provider_request_id: str | None,
        provider_outcome: ModelUsageProviderOutcome,
        execution_certainty: ModelUsageExecutionCertainty,
        measurement_status: ModelUsageMeasurementStatus,
        meters: tuple[UsageMeterQuantity, ...],
        completed_at: datetime | None,
    ) -> ProviderUsageReceipt:
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
                provider_outcome=provider_outcome,
                execution_certainty=execution_certainty,
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
