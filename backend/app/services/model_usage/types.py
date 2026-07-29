from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from types import MappingProxyType
from typing import Literal, Mapping, Sequence

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageOperationSource,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
)
from app.services.model_usage.errors import (
    ModelUsageBlocked,
    ModelUsageContractError,
    ModelUsageDispatchRecoveryRequired,
)
from app.services.model_usage.periods import BillingPeriod


@dataclass(frozen=True, slots=True)
class CapabilityMeterContract:
    capability: ModelUsageCapability
    meter: ModelUsageMeter
    canonical_unit: str
    integer_only: bool
    guardrail_eligible: bool
    requires_reservation_estimate: bool
    requires_settlement_quantity: bool


def _meter_contract(
    capability: ModelUsageCapability,
    meter: ModelUsageMeter,
    canonical_unit: str,
    *,
    integer_only: bool = True,
    guardrail_eligible: bool = True,
) -> CapabilityMeterContract:
    return CapabilityMeterContract(
        capability=capability,
        meter=meter,
        canonical_unit=canonical_unit,
        integer_only=integer_only,
        guardrail_eligible=guardrail_eligible,
        requires_reservation_estimate=True,
        requires_settlement_quantity=True,
    )


_CAPABILITY_METERS: tuple[CapabilityMeterContract, ...] = (
    _meter_contract(ModelUsageCapability.LLM, ModelUsageMeter.INPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.LLM, ModelUsageMeter.UNCACHED_INPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.LLM, ModelUsageMeter.CACHED_INPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.LLM, ModelUsageMeter.OUTPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.LLM, ModelUsageMeter.TOTAL_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.LLM, ModelUsageMeter.REQUEST_UNITS, "requests"),
    _meter_contract(ModelUsageCapability.EMBEDDING, ModelUsageMeter.EMBEDDING_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.EMBEDDING, ModelUsageMeter.REQUEST_UNITS, "requests"),
    _meter_contract(ModelUsageCapability.RERANK, ModelUsageMeter.RERANK_REQUESTS, "requests"),
    _meter_contract(ModelUsageCapability.RERANK, ModelUsageMeter.RERANK_DOCUMENTS, "documents"),
    _meter_contract(ModelUsageCapability.RERANK, ModelUsageMeter.REQUEST_UNITS, "requests"),
    _meter_contract(
        ModelUsageCapability.STT,
        ModelUsageMeter.AUDIO_INPUT_SECONDS,
        "seconds",
        integer_only=False,
    ),
    _meter_contract(ModelUsageCapability.STT, ModelUsageMeter.AUDIO_INPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.STT, ModelUsageMeter.REQUEST_UNITS, "requests"),
    _meter_contract(
        ModelUsageCapability.TTS,
        ModelUsageMeter.AUDIO_OUTPUT_SECONDS,
        "seconds",
        integer_only=False,
    ),
    _meter_contract(ModelUsageCapability.TTS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.TTS, ModelUsageMeter.TTS_CHARACTERS, "characters"),
    _meter_contract(ModelUsageCapability.TTS, ModelUsageMeter.TTS_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.TTS, ModelUsageMeter.REQUEST_UNITS, "requests"),
    _meter_contract(
        ModelUsageCapability.REALTIME_AUDIO,
        ModelUsageMeter.AUDIO_INPUT_SECONDS,
        "seconds",
        integer_only=False,
    ),
    _meter_contract(
        ModelUsageCapability.REALTIME_AUDIO,
        ModelUsageMeter.AUDIO_OUTPUT_SECONDS,
        "seconds",
        integer_only=False,
    ),
    _meter_contract(ModelUsageCapability.REALTIME_AUDIO, ModelUsageMeter.AUDIO_INPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.REALTIME_AUDIO, ModelUsageMeter.AUDIO_OUTPUT_TOKENS, "tokens"),
    _meter_contract(ModelUsageCapability.REALTIME_AUDIO, ModelUsageMeter.REQUEST_UNITS, "requests"),
    _meter_contract(
        ModelUsageCapability.IMAGE_GENERATION,
        ModelUsageMeter.GENERATED_IMAGES,
        "images",
    ),
    _meter_contract(ModelUsageCapability.IMAGE_GENERATION, ModelUsageMeter.REQUEST_UNITS, "requests"),
)

CAPABILITY_METER_CONTRACTS: Mapping[
    tuple[ModelUsageCapability, ModelUsageMeter], CapabilityMeterContract
] = MappingProxyType(
    {(contract.capability, contract.meter): contract for contract in _CAPABILITY_METERS}
)


def capability_meter_contract(
    capability: ModelUsageCapability,
    meter: ModelUsageMeter,
) -> CapabilityMeterContract:
    return CAPABILITY_METER_CONTRACTS[(capability, meter)]


@dataclass(frozen=True, slots=True)
class UsageAttribution:
    family_id: str
    attribution_kind: ModelUsageAttributionKind
    actor_user_id: str | None
    operation_source: ModelUsageOperationSource
    logical_operation_id: str

    def __post_init__(self) -> None:
        if self.attribution_kind is ModelUsageAttributionKind.USER and not self.actor_user_id:
            raise ValueError("user attribution requires actor_user_id")
        if (
            self.attribution_kind is ModelUsageAttributionKind.SYSTEM
            and self.actor_user_id is not None
        ):
            raise ValueError("system attribution cannot carry actor_user_id")


@dataclass(frozen=True, slots=True)
class UsageContext:
    attribution: UsageAttribution
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    billing_model: str
    variant_key: str
    operation_kind: str
    attempt_key: str
    client_attempt_id: str


@dataclass(frozen=True, slots=True)
class UsageMeterQuantity:
    meter: ModelUsageMeter
    quantity: Decimal
    meter_role: ModelUsageMeterRole
    quantity_source: ModelUsageQuantitySource


@dataclass(frozen=True, slots=True)
class UsageEstimate:
    meters: Sequence[UsageMeterQuantity]

    def __post_init__(self) -> None:
        object.__setattr__(self, "meters", tuple(self.meters))

    def quantity(self, meter: ModelUsageMeter) -> Decimal:
        return sum(
            (line.quantity for line in self.meters if line.meter is meter),
            Decimal("0"),
        )


@dataclass(frozen=True, slots=True)
class ProviderRecoveryPolicy:
    mode: ModelUsageRecoveryMode
    idempotency_window_seconds: int | None
    query_window_seconds: int | None
    automatic_resend_deadline_seconds: int | None

    @classmethod
    def none(cls) -> ProviderRecoveryPolicy:
        return cls(
            mode=ModelUsageRecoveryMode.NONE,
            idempotency_window_seconds=None,
            query_window_seconds=None,
            automatic_resend_deadline_seconds=None,
        )


@dataclass(frozen=True, slots=True)
class ProviderMeterWatermark:
    meter: ModelUsageMeter
    lease_sequence: int
    baseline_quantity: Decimal
    cumulative_quantity: Decimal


@dataclass(frozen=True, slots=True)
class ProviderUsageReceipt:
    reservation_id: str | None
    family_id: str
    subject_key: str
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    reported_model: str | None
    billing_model: str
    variant_key: str
    billing_scheme_key: str
    attempt_key: str
    fingerprint: str
    client_attempt_id: str
    policy_version_id: str
    dispatch_policy_version_id: str
    provider_request_id: str | None
    provider_outcome: ModelUsageProviderOutcome
    execution_certainty: ModelUsageExecutionCertainty
    measurement_status: ModelUsageMeasurementStatus
    pricing_status: ModelUsagePricingStatus
    period: BillingPeriod
    meters: Sequence[UsageMeterQuantity]
    meter_watermarks: Sequence[ProviderMeterWatermark]
    dispatched_at: datetime
    completed_at: datetime
    price_version_id: str | None
    price_snapshot: UsagePriceSnapshot | None
    price_snapshot_checksum: str | None
    fail_open_proof_id: str | None
    integrity_key_id: str
    integrity_hmac: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "meters", tuple(self.meters))
        object.__setattr__(self, "meter_watermarks", tuple(self.meter_watermarks))


@dataclass(frozen=True, slots=True)
class DispatchPermit:
    reservation_id: str | None
    send_kind: Literal["first_send", "idempotent_resend", "fail_open_single_send"]
    family_id: str
    subject_key: str
    capability: ModelUsageCapability
    provider: str
    requested_model: str
    billing_model: str
    variant_key: str
    billing_scheme_key: str
    attempt_key: str
    fingerprint: str
    client_attempt_id: str
    policy_version_id: str
    dispatch_policy_version_id: str
    pricing_status: ModelUsagePricingStatus
    period: BillingPeriod
    dispatched_at: datetime
    price_version_id: str | None
    price_snapshot: UsagePriceSnapshot | None
    price_snapshot_checksum: str | None
    provider_idempotency_key: str | None
    recovery_policy: ProviderRecoveryPolicy
    fail_open_proof_id: str | None = None
    expires_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class ReservationDecision:
    decision: Literal["allowed", "blocked", "fail_open", "already_accounted"]
    reservation_id: str | None = None
    existing_event_id: str | None = None
    subject_key: str | None = None
    policy_version_id: str | None = None
    price_version_id: str | None = None
    pricing_status: ModelUsagePricingStatus | None = None
    reserved_cost_cny: Decimal | None = None
    fail_open_permit: DispatchPermit | None = None
    error_code: str | None = None

    @classmethod
    def blocked(cls, error_code: str) -> ReservationDecision:
        return cls(decision="blocked", error_code=error_code)

    @classmethod
    def already_accounted(cls, event_id: str) -> ReservationDecision:
        return cls(decision="already_accounted", existing_event_id=event_id)


@dataclass(frozen=True, slots=True)
class DispatchGateOutcome:
    decision: Literal["allowed", "blocked", "recovery_required"]
    permit: DispatchPermit | None = None
    existing_dispatch_id: str | None = None
    error_code: str | None = None

    @classmethod
    def blocked(cls, error_code: str) -> DispatchGateOutcome:
        return cls(decision="blocked", error_code=error_code)

    def require_first_send_permit(self) -> DispatchPermit:
        if self.permit is None:
            if self.decision == "recovery_required":
                raise ModelUsageDispatchRecoveryRequired()
            if not self.error_code:
                raise ModelUsageContractError("missing_dispatch_error_code")
            raise ModelUsageBlocked(self.error_code)
        if self.permit.send_kind != "first_send":
            raise ModelUsageContractError("first_send_permit_required")
        return self.permit


@dataclass(frozen=True, slots=True)
class UsageSettlement:
    event_id: str
    reservation_id: str | None
    measurement_status: ModelUsageMeasurementStatus
    pricing_status: ModelUsagePricingStatus
    execution_certainty: ModelUsageExecutionCertainty
    cost_cny: Decimal | None
    meters: Sequence[UsageMeterQuantity]
    billable_line_costs: Sequence[Decimal]

    def __post_init__(self) -> None:
        object.__setattr__(self, "meters", tuple(self.meters))
        object.__setattr__(self, "billable_line_costs", tuple(self.billable_line_costs))

    def quantity(self, meter: ModelUsageMeter) -> Decimal:
        return sum(
            (line.quantity for line in self.meters if line.meter is meter),
            Decimal("0"),
        )

    def informational_quantity(self, meter: ModelUsageMeter) -> Decimal:
        return sum(
            (
                line.quantity
                for line in self.meters
                if line.meter is meter
                and line.meter_role is ModelUsageMeterRole.INFORMATIONAL
            ),
            Decimal("0"),
        )


def new_client_attempt_id() -> str:
    return f"mua_{secrets.token_urlsafe(24)}"
