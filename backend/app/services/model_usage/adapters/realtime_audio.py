from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
from types import MappingProxyType
from typing import Mapping

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
from app.services.model_usage.adapters.base import MeteredProviderAdapter, MeteredProviderAttempt
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    validate_configured_variant,
)
from app.services.model_usage.decimal_math import quantize_quantity
from app.services.model_usage.estimators import estimate_realtime_audio
from app.services.model_usage.errors import (
    ModelUsageContractError,
    ModelUsageDispatchRecoveryRequired,
    ModelUsageSettlementPending,
)
from app.services.model_usage.types import (
    DispatchPermit,
    ProviderMeterWatermark,
    ProviderUsageReceipt,
    UsageAttribution,
    UsageContext,
    UsageMeterQuantity,
    UsageSettlement,
)


LEASE_SECONDS = Decimal("30")


def realtime_attempt_key(
    session_id: str,
    turn_id: str,
    segment: str,
    lease_sequence: int,
) -> str:
    if (
        not isinstance(session_id, str)
        or not session_id
        or not isinstance(turn_id, str)
        or not turn_id
        or not isinstance(segment, str)
        or not segment
        or ":" in session_id
        or ":" in turn_id
        or ":" in segment
        or isinstance(lease_sequence, bool)
        or lease_sequence <= 0
    ):
        raise ModelUsageContractError("realtime_attempt_identity_invalid")
    return f"realtime:{session_id}:{turn_id}:{segment}:lease:{lease_sequence}"


def _stable_digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()


def _quantity(value: Decimal, *, code: str) -> Decimal:
    if not isinstance(value, Decimal):
        raise ModelUsageContractError(code)
    try:
        normalized = quantize_quantity(value)
    except (TypeError, ValueError, ArithmeticError) as exc:
        raise ModelUsageContractError(code) from exc
    if normalized != value or normalized < 0:
        raise ModelUsageContractError(code)
    return normalized


def _required_cumulative_baselines(
    *,
    required_meters: frozenset[ModelUsageMeter],
    observed: Mapping[ModelUsageMeter, Decimal],
    previous: Mapping[ModelUsageMeter, Decimal],
    first_lease: bool,
) -> Mapping[ModelUsageMeter, Decimal]:
    if not required_meters:
        return MappingProxyType({})
    values: dict[ModelUsageMeter, Decimal] = {}
    for meter in sorted(required_meters, key=lambda item: item.value):
        if meter not in observed:
            raise ModelUsageSettlementPending("realtime_watermark_missing")
        value = _quantity(observed[meter], code="realtime_watermark_quantity_invalid")
        if not first_lease:
            if meter not in previous or previous[meter] != value:
                raise ModelUsageSettlementPending("realtime_watermark_baseline_conflict")
        values[meter] = value
    return MappingProxyType(values)


@dataclass(slots=True)
class ActiveRealtimeUsageLease:
    session_id: str
    turn_id: str
    segment: str
    lease_sequence: int
    attempt_key: str
    attempt: MeteredProviderAttempt
    dispatch_permit: DispatchPermit
    started_at: datetime
    expires_at: datetime
    server_input_clock_baseline: Decimal
    server_output_clock_baseline: Decimal
    server_tts_character_baseline: Decimal
    provider_meter_baselines: Mapping[ModelUsageMeter, Decimal]
    terminal_receipt: ProviderUsageReceipt | None = None
    terminal_settlement: UsageSettlement | None = None
    terminal_state: str = "active"


@dataclass(slots=True)
class RealtimeAudioUsageAdapter(MeteredProviderAdapter):
    """Reserve and terminalize one non-overlapping realtime provider lease."""

    billing_variant: ConfiguredUsageVariant | None = None
    operation_kind: str = "realtime_audio_lease"

    def validate_provider_model(self, *, direction: str, provider_model: str) -> None:
        variant = self._variant()
        if direction == "input":
            expected = variant.realtime_input_model or variant.billing_model
        elif direction == "output":
            expected = variant.realtime_output_model or variant.billing_model
        else:
            raise ModelUsageContractError("realtime_provider_model_direction_invalid")
        if not provider_model or provider_model != expected:
            raise ModelUsageContractError("realtime_provider_model_identity_mismatch")

    def begin_lease(
        self,
        *,
        family_id: str,
        user_id: str,
        session_id: str,
        turn_id: str,
        segment: str,
        lease_sequence: int,
        at: datetime,
        server_input_total: Decimal,
        server_output_total: Decimal,
        provider_cumulative: Mapping[ModelUsageMeter, Decimal],
        previous_provider_watermarks: Mapping[ModelUsageMeter, Decimal],
        server_tts_character_total: Decimal = Decimal("0"),
    ) -> ActiveRealtimeUsageLease:
        variant = self._variant()
        input_baseline = _quantity(
            server_input_total,
            code="realtime_server_input_clock_invalid",
        )
        output_baseline = _quantity(
            server_output_total,
            code="realtime_server_output_clock_invalid",
        )
        tts_character_baseline = _quantity(
            server_tts_character_total,
            code="realtime_server_tts_character_clock_invalid",
        )
        attempt_key = realtime_attempt_key(session_id, turn_id, segment, lease_sequence)
        baselines = _required_cumulative_baselines(
            required_meters=variant.lease_boundary_cumulative_meters,
            observed=provider_cumulative,
            previous=previous_provider_watermarks,
            first_lease=lease_sequence == 1,
        )
        attribution = UsageAttribution(
            family_id=family_id,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=user_id,
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id=turn_id,
        )
        context = UsageContext(
            attribution=attribution,
            capability=ModelUsageCapability.REALTIME_AUDIO,
            provider=variant.provider,
            requested_model=variant.billing_model,
            billing_model=variant.billing_model,
            variant_key=variant.variant_key,
            operation_kind=self.operation_kind,
            attempt_key=attempt_key,
            client_attempt_id=(
                f"mua_realtime_{_stable_digest(family_id, attempt_key)[:32]}"
            ),
        )
        attempt = self.start_attempt(
            context,
            estimate_realtime_audio(
                billable_meters=variant.billable_meters,
                lease_seconds=LEASE_SECONDS,
                input_tokens_per_second_cap=variant.input_tokens_per_second_cap,
                output_tokens_per_second_cap=variant.output_tokens_per_second_cap,
                tts_characters_per_lease_cap=variant.tts_characters_per_lease_cap,
            ),
            fingerprint=self.signer.request_fingerprint(attempt_key.encode("utf-8")),
            at=at,
        )
        permit = attempt.prepare_dispatch(at=at)
        if permit.send_kind not in {"first_send", "fail_open_single_send"}:
            raise ModelUsageDispatchRecoveryRequired()
        return ActiveRealtimeUsageLease(
            session_id=session_id,
            turn_id=turn_id,
            segment=segment,
            lease_sequence=lease_sequence,
            attempt_key=attempt_key,
            attempt=attempt,
            dispatch_permit=permit,
            started_at=permit.dispatched_at,
            expires_at=permit.dispatched_at + timedelta(seconds=int(LEASE_SECONDS)),
            server_input_clock_baseline=input_baseline,
            server_output_clock_baseline=output_baseline,
            server_tts_character_baseline=tts_character_baseline,
            provider_meter_baselines=baselines,
        )

    def finish_lease(
        self,
        lease: ActiveRealtimeUsageLease,
        *,
        server_input_total: Decimal,
        server_output_total: Decimal,
        provider_cumulative: Mapping[ModelUsageMeter, Decimal],
        server_tts_character_total: Decimal = Decimal("0"),
        completed_at: datetime | None = None,
    ) -> UsageSettlement:
        if lease.terminal_settlement is not None:
            return lease.terminal_settlement
        if lease.terminal_state == "settlement_pending":
            raise ModelUsageSettlementPending("realtime_lease_settlement_pending")
        try:
            if lease.terminal_receipt is None:
                lease.terminal_receipt = self._receipt_for_terminal_lease(
                    lease,
                    server_input_total=server_input_total,
                    server_output_total=server_output_total,
                    server_tts_character_total=server_tts_character_total,
                    provider_cumulative=provider_cumulative,
                    completed_at=completed_at,
                )
            settlement = lease.attempt.settle(lease.terminal_receipt)
        except ModelUsageSettlementPending:
            lease.terminal_state = "settlement_pending"
            raise
        lease.terminal_settlement = settlement
        lease.terminal_state = "terminal"
        return settlement

    def abort_lease_before_provider_send(
        self,
        lease: ActiveRealtimeUsageLease,
        *,
        completed_at: datetime | None = None,
    ) -> UsageSettlement:
        """Settle a dispatched permit that expired before any provider byte.

        Reserving and dispatching are deliberately durable before the provider
        boundary.  If the physical clock shows that a fixed lease elapsed
        before the context body can begin, this particular attempt is known not
        to have reached the provider.  It must therefore release its estimate
        through a signed `not_billed` receipt instead of becoming an ambiguous
        provider result.
        """

        if lease.terminal_settlement is not None:
            return lease.terminal_settlement
        if lease.terminal_state == "settlement_pending":
            raise ModelUsageSettlementPending("realtime_lease_settlement_pending")
        try:
            if lease.terminal_receipt is None:
                permit = lease.dispatch_permit
                lease.terminal_receipt = self.signer.sign(
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
                        provider_request_id=None,
                        provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
                        execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
                        measurement_status=ModelUsageMeasurementStatus.EXACT,
                        pricing_status=permit.pricing_status,
                        period=permit.period,
                        meters=tuple(
                            UsageMeterQuantity(
                                meter=line.meter,
                                quantity=Decimal("0"),
                                meter_role=line.meter_role,
                                quantity_source=ModelUsageQuantitySource.PROVIDER,
                            )
                            for line in permit.required_meters
                        ),
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
            settlement = lease.attempt.settle(lease.terminal_receipt)
        except ModelUsageSettlementPending:
            lease.terminal_state = "settlement_pending"
            raise
        lease.terminal_settlement = settlement
        lease.terminal_state = "terminal"
        return settlement

    def _variant(self) -> ConfiguredUsageVariant:
        variant = self.billing_variant
        if variant is None:
            raise ModelUsageContractError("realtime_billing_variant_required")
        try:
            validated = validate_configured_variant(variant)
        except ModelUsageContractError:
            raise
        if validated.capability is not ModelUsageCapability.REALTIME_AUDIO:
            raise ModelUsageContractError("realtime_billing_variant_capability_invalid")
        return validated

    def _receipt_for_terminal_lease(
        self,
        lease: ActiveRealtimeUsageLease,
        *,
        server_input_total: Decimal,
        server_output_total: Decimal,
        provider_cumulative: Mapping[ModelUsageMeter, Decimal],
        server_tts_character_total: Decimal = Decimal("0"),
        completed_at: datetime | None = None,
    ) -> ProviderUsageReceipt:
        input_delta = _quantity(
            server_input_total - lease.server_input_clock_baseline,
            code="realtime_server_input_clock_decreased",
        )
        output_delta = _quantity(
            server_output_total - lease.server_output_clock_baseline,
            code="realtime_server_output_clock_decreased",
        )
        tts_character_delta = _quantity(
            server_tts_character_total - lease.server_tts_character_baseline,
            code="realtime_server_tts_character_clock_decreased",
        )
        cumulative: dict[ModelUsageMeter, Decimal] = {}
        watermarks: list[ProviderMeterWatermark] = []
        for meter, baseline in lease.provider_meter_baselines.items():
            if meter not in provider_cumulative:
                raise ModelUsageSettlementPending("realtime_watermark_missing")
            value = _quantity(
                provider_cumulative[meter],
                code="realtime_watermark_quantity_invalid",
            )
            if value < baseline:
                raise ModelUsageSettlementPending("realtime_watermark_decreased")
            cumulative[meter] = value
            watermarks.append(
                ProviderMeterWatermark(
                    meter=meter,
                    lease_sequence=lease.lease_sequence,
                    baseline_quantity=baseline,
                    cumulative_quantity=value,
                )
            )
        meters: list[UsageMeterQuantity] = []
        exact = True
        for line in lease.dispatch_permit.required_meters:
            if line.meter is ModelUsageMeter.AUDIO_INPUT_SECONDS:
                quantity = input_delta
                source = ModelUsageQuantitySource.SERVER_MEASURED
            elif line.meter is ModelUsageMeter.AUDIO_OUTPUT_SECONDS:
                quantity = output_delta
                source = ModelUsageQuantitySource.SERVER_MEASURED
            elif line.meter is ModelUsageMeter.TTS_CHARACTERS:
                quantity = tts_character_delta
                source = ModelUsageQuantitySource.SERVER_MEASURED
            elif line.meter in cumulative:
                quantity = cumulative[line.meter] - lease.provider_meter_baselines[line.meter]
                source = ModelUsageQuantitySource.PROVIDER
            else:
                quantity = line.quantity
                source = ModelUsageQuantitySource.ESTIMATED
                exact = False
            meters.append(
                UsageMeterQuantity(
                    meter=line.meter,
                    quantity=quantity,
                    meter_role=line.meter_role,
                    quantity_source=source,
                )
            )
        permit = lease.dispatch_permit
        variant = self._variant()
        return self.signer.sign(
            ProviderUsageReceipt(
                reservation_id=permit.reservation_id,
                family_id=permit.family_id,
                subject_key=permit.subject_key,
                capability=permit.capability,
                provider=permit.provider,
                requested_model=permit.requested_model,
                # A duplex lease may cover distinct input/output provider
                # models.  Their explicit composite mapping is the immutable
                # billing model; there is no truthful single reported model.
                reported_model=(
                    variant.realtime_input_model
                    if variant.realtime_input_model is not None
                    and variant.realtime_input_model == variant.realtime_output_model
                    else (
                        None
                        if variant.realtime_input_model is not None
                        else permit.requested_model
                    )
                ),
                billing_model=permit.billing_model,
                variant_key=permit.variant_key,
                billing_scheme_key=permit.billing_scheme_key,
                attempt_key=permit.attempt_key,
                fingerprint=permit.fingerprint,
                client_attempt_id=permit.client_attempt_id,
                policy_version_id=permit.policy_version_id,
                dispatch_policy_version_id=permit.dispatch_policy_version_id,
                provider_request_id=None,
                provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
                execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
                measurement_status=(
                    ModelUsageMeasurementStatus.EXACT
                    if exact
                    else ModelUsageMeasurementStatus.ESTIMATED
                ),
                pricing_status=permit.pricing_status,
                period=permit.period,
                meters=tuple(meters),
                meter_watermarks=tuple(watermarks),
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
