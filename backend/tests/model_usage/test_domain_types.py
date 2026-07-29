from __future__ import annotations

from dataclasses import fields
from decimal import Decimal

import pytest

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageBudgetState,
    ModelUsageCapability,
    ModelUsageCorrectionStatus,
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageIncidentCoverage,
    ModelUsageIncidentRecoveryStatus,
    ModelUsageLimitKind,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageOperationSource,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
    ModelUsageResolutionKind,
    ModelUsageRollupKind,
    ModelUsageSubjectKind,
)
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageError
from app.services.model_usage.types import (
    CapabilityMeterContract,
    DispatchGateOutcome,
    DispatchPermit,
    ProviderMeterWatermark,
    ProviderRecoveryPolicy,
    ProviderUsageReceipt,
    ReservationDecision,
    UsageAttribution,
    UsageContext,
    UsageEstimate,
    UsageMeterQuantity,
    UsageSettlement,
    capability_meter_contract,
    new_client_attempt_id,
)


def test_capabilities_and_meters_are_closed_sets() -> None:
    assert {item.value for item in ModelUsageCapability} == {
        "llm",
        "embedding",
        "rerank",
        "stt",
        "tts",
        "realtime_audio",
        "image_generation",
    }
    assert {item.value for item in ModelUsageMeter} == {
        "input_tokens",
        "uncached_input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "total_tokens",
        "embedding_tokens",
        "rerank_requests",
        "rerank_documents",
        "audio_input_seconds",
        "audio_output_seconds",
        "audio_input_tokens",
        "audio_output_tokens",
        "tts_characters",
        "tts_tokens",
        "generated_images",
        "request_units",
    }
    assert {item.value for item in ModelUsageMeterRole} == {"billable", "informational"}


def test_operation_sources_and_member_budget_states_are_stable() -> None:
    assert {item.value for item in ModelUsageOperationSource} == {
        "interactive",
        "background_index",
        "image_job",
    }


@pytest.mark.parametrize(
    ("enum_type", "expected"),
    (
        (ModelUsagePricingStatus, {"priced", "unpriced"}),
        (
            ModelUsageReservationStatus,
            {"reserved", "dispatching", "settled", "released", "uncertain"},
        ),
        (
            ModelUsageProviderOutcome,
            {"succeeded", "failed_billed", "not_billed", "unknown"},
        ),
        (
            ModelUsageExecutionCertainty,
            {"confirmed_executed", "confirmed_not_executed", "unknown"},
        ),
        (ModelUsageMeasurementStatus, {"exact", "estimated"}),
        (
            ModelUsageRecoveryMode,
            {
                "idempotency_key",
                "queryable_request",
                "idempotency_and_queryable",
                "none",
            },
        ),
        (ModelUsageAttributionKind, {"user", "system"}),
        (ModelUsageSubjectKind, {"user", "system"}),
        (
            ModelUsageCounterKind,
            {"family_cost", "capability_cost", "capability_meter"},
        ),
        (ModelUsageLimitKind, {"cost", "meter"}),
        (
            ModelUsageResolutionKind,
            {"meter_correction", "pricing_correction", "execution_resolution"},
        ),
        (
            ModelUsageRollupKind,
            {
                "family_total",
                "subject_total",
                "capability_total",
                "provider_model_total",
                "meter_total",
                "daily_capability_cost",
            },
        ),
        (ModelUsageCorrectionStatus, {"open", "pruning", "closed"}),
        (
            ModelUsageIncidentCoverage,
            {"exact_scope", "partial_scope", "unknown_scope"},
        ),
        (ModelUsageIncidentRecoveryStatus, {"unresolved", "recovered"}),
        (
            ModelUsageQuantitySource,
            {"provider", "server_measured", "estimated"},
        ),
    ),
)
def test_controlled_domain_enums_are_closed_sets(enum_type: type, expected: set[str]) -> None:
    assert {item.value for item in enum_type} == expected
    assert {item.value for item in ModelUsageBudgetState} == {
        "sufficient",
        "approaching_limit",
        "alert_threshold_reached",
        "capability_degraded",
        "measurement_unavailable",
    }


def test_guardrail_eligibility_is_independent_from_price_role() -> None:
    contract = capability_meter_contract(
        ModelUsageCapability.LLM,
        ModelUsageMeter.TOTAL_TOKENS,
    )

    assert contract.guardrail_eligible is True
    assert contract.requires_reservation_estimate is True
    assert contract.requires_settlement_quantity is True
    assert "meter_role" not in contract.__dataclass_fields__


def test_meter_registry_is_capability_scoped() -> None:
    llm_total = capability_meter_contract(
        ModelUsageCapability.LLM,
        ModelUsageMeter.TOTAL_TOKENS,
    )

    assert llm_total.capability is ModelUsageCapability.LLM
    with pytest.raises(KeyError):
        capability_meter_contract(
            ModelUsageCapability.EMBEDDING,
            ModelUsageMeter.TOTAL_TOKENS,
        )


def test_usage_attribution_validates_user_and_system_identity() -> None:
    user = UsageAttribution(
        family_id="family-a",
        attribution_kind=ModelUsageAttributionKind.USER,
        actor_user_id="user-a",
        operation_source=ModelUsageOperationSource.INTERACTIVE,
        logical_operation_id="run-a",
    )
    assert user.actor_user_id == "user-a"

    with pytest.raises(ValueError, match="requires actor_user_id"):
        UsageAttribution(
            family_id="family-a",
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=None,
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id="run-a",
        )

    with pytest.raises(ValueError, match="cannot carry actor_user_id"):
        UsageAttribution(
            family_id="family-a",
            attribution_kind=ModelUsageAttributionKind.SYSTEM,
            actor_user_id="user-a",
            operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
            logical_operation_id="job-a",
        )


def test_usage_contracts_have_no_business_content_fields() -> None:
    forbidden = {
        "prompt",
        "response",
        "query",
        "text",
        "document",
        "media_url",
        "user_id",
    }
    contracts = (
        CapabilityMeterContract,
        UsageAttribution,
        UsageContext,
        UsageMeterQuantity,
        UsageEstimate,
        ProviderRecoveryPolicy,
        ProviderMeterWatermark,
        ProviderUsageReceipt,
        DispatchPermit,
        ReservationDecision,
        DispatchGateOutcome,
        UsageSettlement,
    )

    for contract in contracts:
        assert forbidden.isdisjoint(field.name for field in fields(contract))


def test_usage_estimate_sums_matching_meter() -> None:
    estimate = UsageEstimate(
        meters=(
            UsageMeterQuantity(
                meter=ModelUsageMeter.TOTAL_TOKENS,
                quantity=Decimal("2"),
                meter_role=ModelUsageMeterRole.INFORMATIONAL,
                quantity_source=ModelUsageQuantitySource.ESTIMATED,
            ),
            UsageMeterQuantity(
                meter=ModelUsageMeter.TOTAL_TOKENS,
                quantity=Decimal("3"),
                meter_role=ModelUsageMeterRole.INFORMATIONAL,
                quantity_source=ModelUsageQuantitySource.ESTIMATED,
            ),
        )
    )

    assert estimate.quantity(ModelUsageMeter.TOTAL_TOKENS) == Decimal("5")
    assert estimate.quantity(ModelUsageMeter.INPUT_TOKENS) == Decimal("0")


def test_recovery_policy_none_has_no_recovery_windows() -> None:
    policy = ProviderRecoveryPolicy.none()

    assert policy.mode is ModelUsageRecoveryMode.NONE
    assert policy.idempotency_window_seconds is None
    assert policy.query_window_seconds is None
    assert policy.automatic_resend_deadline_seconds is None


def test_client_attempt_ids_are_prefixed_and_unique() -> None:
    first = new_client_attempt_id()
    second = new_client_attempt_id()

    assert first.startswith("mua_")
    assert second.startswith("mua_")
    assert first != second


def test_model_usage_errors_expose_stable_codes() -> None:
    error = ModelUsageBlocked("model_usage_budget_exceeded")

    assert isinstance(error, ModelUsageError)
    assert error.code == "model_usage_budget_exceeded"
    assert str(error) == "model_usage_budget_exceeded"


def test_model_usage_error_requires_a_stable_code() -> None:
    with pytest.raises(ValueError, match="stable code"):
        ModelUsageError()
