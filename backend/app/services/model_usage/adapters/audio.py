from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageOperationSource,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
)
from app.services.ai_audio.schemas import SpeechRequest, TranscriptionRequest
from app.services.model_usage.adapters.base import MeteredProviderAdapter, MeteredProviderAttempt
from app.services.model_usage.estimators import estimate_stt, estimate_tts
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderUsageReceipt,
    UsageAttribution,
    UsageContext,
    UsageEstimate,
    UsageMeterQuantity,
)


def _stable_digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _positive_decimal(value: Decimal, *, code: str) -> Decimal:
    if not isinstance(value, Decimal) or value <= 0:
        raise ModelUsageContractError(code)
    return value


def _usage_value(raw_usage: object | None, *keys: str) -> Decimal | None:
    if raw_usage is None:
        return None
    value: object | None = None
    if isinstance(raw_usage, Mapping):
        for key in keys:
            if key in raw_usage:
                value = raw_usage[key]
                break
    else:
        for key in keys:
            candidate = getattr(raw_usage, key, None)
            if candidate is not None:
                value = candidate
                break
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value))
    except Exception as exc:
        raise ModelUsageContractError("audio_provider_usage_invalid") from exc
    if parsed < 0:
        raise ModelUsageContractError("audio_provider_usage_invalid")
    return parsed


@dataclass(slots=True)
class AudioUsageAdapter(MeteredProviderAdapter):
    """Durably meter one synchronous STT or TTS provider request.

    The adapter intentionally accepts only aggregate server measurements and an
    opaque request fingerprint.  Audio bytes and speech text therefore never
    enter usage contexts, receipts, reservation metadata, or logs.
    """

    provider: str = "openai"
    model: str = ""
    capability: ModelUsageCapability = ModelUsageCapability.STT
    variant_key: str = ""
    operation_kind: str = "audio_provider_request"

    def request_fingerprint(self, payload: object) -> str:
        """HMAC transient provider input without retaining its raw content."""

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

    def begin_stt(
        self,
        request: TranscriptionRequest,
        *,
        duration_seconds: Decimal,
        fingerprint: str,
    ) -> MeteredProviderAttempt:
        if self.capability is not ModelUsageCapability.STT:
            raise ModelUsageContractError("audio_stt_capability_mismatch")
        duration = _positive_decimal(duration_seconds, code="audio_stt_duration_invalid")
        return self._begin(
            request=request,
            attempt_suffix="stt",
            estimate=estimate_stt(duration_seconds=duration),
            fingerprint=fingerprint,
        )

    def begin_tts(
        self,
        request: SpeechRequest,
        *,
        sanitized_text: str,
        fingerprint: str,
    ) -> MeteredProviderAttempt:
        if self.capability is not ModelUsageCapability.TTS:
            raise ModelUsageContractError("audio_tts_capability_mismatch")
        if not isinstance(sanitized_text, str) or not sanitized_text:
            raise ModelUsageContractError("audio_tts_text_empty")
        return self._begin(
            request=request,
            attempt_suffix="tts",
            estimate=estimate_tts(character_count=len(sanitized_text)),
            fingerprint=fingerprint,
        )

    def stt_receipt(
        self,
        permit: DispatchPermit,
        *,
        duration_seconds: Decimal,
        reported_model: str | None,
        provider_request_id: str | None,
        provider_usage: object | None = None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not ModelUsageCapability.STT:
            raise ModelUsageContractError("audio_stt_receipt_capability_mismatch")
        duration = _positive_decimal(duration_seconds, code="audio_stt_duration_invalid")
        meters, measurement_status = self._stt_meters(
            permit,
            duration_seconds=duration,
            provider_usage=provider_usage,
        )
        return self._success_receipt(
            permit,
            meters=meters,
            measurement_status=measurement_status,
            reported_model=reported_model or self.model,
            provider_request_id=provider_request_id,
            completed_at=completed_at,
        )

    def tts_receipt(
        self,
        permit: DispatchPermit,
        *,
        sanitized_text: str,
        reported_model: str | None,
        provider_request_id: str | None,
        provider_usage: object | None = None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not ModelUsageCapability.TTS:
            raise ModelUsageContractError("audio_tts_receipt_capability_mismatch")
        if not isinstance(sanitized_text, str) or not sanitized_text:
            raise ModelUsageContractError("audio_tts_text_empty")
        meters, measurement_status = self._tts_meters(
            permit,
            character_count=len(sanitized_text),
            provider_usage=provider_usage,
        )
        return self._success_receipt(
            permit,
            meters=meters,
            measurement_status=measurement_status,
            reported_model=reported_model or self.model,
            provider_request_id=provider_request_id,
            completed_at=completed_at,
        )

    def confirmed_not_executed_receipt(
        self,
        permit: DispatchPermit,
        *,
        stable_provider_request_id: str | None = None,
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        if permit.capability is not self.capability:
            raise ModelUsageContractError("audio_receipt_capability_mismatch")
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

    def _begin(
        self,
        *,
        request: TranscriptionRequest | SpeechRequest,
        attempt_suffix: str,
        estimate: UsageEstimate,
        fingerprint: str,
    ) -> MeteredProviderAttempt:
        if (
            not self.provider.strip()
            or not self.model.strip()
            or not self.variant_key.strip()
            or not request.family_id
            or not request.user_id
            or not request.operation_id
            or not fingerprint
        ):
            raise ModelUsageContractError("audio_attempt_identity_required")
        attribution = UsageAttribution(
            family_id=request.family_id,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=request.user_id,
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id=request.operation_id,
        )
        attempt_key = f"{request.operation_id}:{attempt_suffix}"
        context = UsageContext(
            attribution=attribution,
            capability=self.capability,
            provider=self.provider,
            requested_model=self.model,
            billing_model=self.model,
            variant_key=self.variant_key,
            operation_kind=self.operation_kind,
            attempt_key=attempt_key,
            client_attempt_id=(
                f"mua_audio_{_stable_digest(request.family_id, attempt_key, fingerprint)[:32]}"
            ),
        )
        return self.start_attempt(context, estimate, fingerprint=fingerprint)

    def _stt_meters(
        self,
        permit: DispatchPermit,
        *,
        duration_seconds: Decimal,
        provider_usage: object | None,
    ) -> tuple[tuple[UsageMeterQuantity, ...], ModelUsageMeasurementStatus]:
        meters: list[UsageMeterQuantity] = []
        all_exact = True
        for line in permit.required_meters:
            if line.meter is ModelUsageMeter.AUDIO_INPUT_SECONDS:
                quantity = duration_seconds
                source = ModelUsageQuantitySource.SERVER_MEASURED
            elif line.meter is ModelUsageMeter.REQUEST_UNITS:
                quantity = Decimal("1")
                source = ModelUsageQuantitySource.SERVER_MEASURED
            elif line.meter is ModelUsageMeter.AUDIO_INPUT_TOKENS:
                value = _usage_value(provider_usage, "audio_input_tokens", "input_audio_tokens")
                if value is None:
                    quantity = line.quantity
                    source = ModelUsageQuantitySource.ESTIMATED
                    all_exact = False
                else:
                    quantity = value
                    source = ModelUsageQuantitySource.PROVIDER
            else:
                raise ModelUsageContractError("audio_stt_meter_unsupported")
            meters.append(
                UsageMeterQuantity(
                    meter=line.meter,
                    quantity=quantity,
                    meter_role=line.meter_role,
                    quantity_source=source,
                )
            )
        return tuple(meters), (
            ModelUsageMeasurementStatus.EXACT if all_exact else ModelUsageMeasurementStatus.ESTIMATED
        )

    def _tts_meters(
        self,
        permit: DispatchPermit,
        *,
        character_count: int,
        provider_usage: object | None,
    ) -> tuple[tuple[UsageMeterQuantity, ...], ModelUsageMeasurementStatus]:
        meters: list[UsageMeterQuantity] = []
        all_exact = True
        provider_keys = {
            ModelUsageMeter.TTS_TOKENS: ("tts_tokens", "output_text_tokens"),
            ModelUsageMeter.AUDIO_OUTPUT_SECONDS: ("audio_output_seconds", "output_audio_seconds"),
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: ("audio_output_tokens", "output_audio_tokens"),
        }
        for line in permit.required_meters:
            if line.meter is ModelUsageMeter.TTS_CHARACTERS:
                quantity = Decimal(character_count)
                source = ModelUsageQuantitySource.SERVER_MEASURED
            elif line.meter is ModelUsageMeter.REQUEST_UNITS:
                quantity = Decimal("1")
                source = ModelUsageQuantitySource.SERVER_MEASURED
            elif line.meter in provider_keys:
                value = _usage_value(provider_usage, *provider_keys[line.meter])
                if value is None:
                    quantity = line.quantity
                    source = ModelUsageQuantitySource.ESTIMATED
                    all_exact = False
                else:
                    quantity = value
                    source = ModelUsageQuantitySource.PROVIDER
            else:
                raise ModelUsageContractError("audio_tts_meter_unsupported")
            meters.append(
                UsageMeterQuantity(
                    meter=line.meter,
                    quantity=quantity,
                    meter_role=line.meter_role,
                    quantity_source=source,
                )
            )
        return tuple(meters), (
            ModelUsageMeasurementStatus.EXACT if all_exact else ModelUsageMeasurementStatus.ESTIMATED
        )

    def _success_receipt(
        self,
        permit: DispatchPermit,
        *,
        meters: tuple[UsageMeterQuantity, ...],
        measurement_status: ModelUsageMeasurementStatus,
        reported_model: str | None,
        provider_request_id: str | None,
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
