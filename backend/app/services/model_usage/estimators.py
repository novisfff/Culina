from __future__ import annotations

from decimal import Decimal

from app.core.enums import (
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageQuantitySource,
)
from app.services.model_usage.decimal_math import quantize_quantity
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.types import UsageEstimate, UsageMeterQuantity


def _positive_integer(value: int, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ModelUsageContractError(f"{field}_must_be_positive_integer")
    return value


def _non_negative_integer(value: int, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ModelUsageContractError(f"{field}_must_be_non_negative_integer")
    return value


def _quantity(
    meter: ModelUsageMeter,
    value: Decimal | int,
    *,
    role: ModelUsageMeterRole,
) -> UsageMeterQuantity:
    decimal = value if isinstance(value, Decimal) else Decimal(value)
    try:
        normalized = quantize_quantity(decimal)
    except (TypeError, ValueError) as exc:
        raise ModelUsageContractError("invalid_estimate_quantity") from exc
    return UsageMeterQuantity(
        meter=meter,
        quantity=normalized,
        meter_role=role,
        quantity_source=ModelUsageQuantitySource.ESTIMATED,
    )


def estimate_llm(
    *,
    input_tokens: int,
    cached_input_tokens: int,
    max_output_tokens: int | None,
) -> UsageEstimate:
    _positive_integer(input_tokens, field="input_tokens")
    _non_negative_integer(cached_input_tokens, field="cached_input_tokens")
    if cached_input_tokens > input_tokens:
        raise ModelUsageContractError("cached_input_exceeds_input")
    if max_output_tokens is None:
        raise ModelUsageContractError("llm_output_cap_required")
    _positive_integer(max_output_tokens, field="max_output_tokens")
    uncached = input_tokens - cached_input_tokens
    return UsageEstimate(
        meters=(
            _quantity(
                ModelUsageMeter.INPUT_TOKENS,
                input_tokens,
                role=ModelUsageMeterRole.INFORMATIONAL,
            ),
            _quantity(
                ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                uncached,
                role=ModelUsageMeterRole.BILLABLE,
            ),
            _quantity(
                ModelUsageMeter.CACHED_INPUT_TOKENS,
                cached_input_tokens,
                role=ModelUsageMeterRole.BILLABLE,
            ),
            _quantity(
                ModelUsageMeter.OUTPUT_TOKENS,
                max_output_tokens,
                role=ModelUsageMeterRole.BILLABLE,
            ),
            _quantity(
                ModelUsageMeter.TOTAL_TOKENS,
                input_tokens + max_output_tokens,
                role=ModelUsageMeterRole.INFORMATIONAL,
            ),
        )
    )


def estimate_embedding(*, token_count: int) -> UsageEstimate:
    _positive_integer(token_count, field="token_count")
    return UsageEstimate(
        meters=(
            _quantity(ModelUsageMeter.EMBEDDING_TOKENS, token_count, role=ModelUsageMeterRole.BILLABLE),
            _quantity(ModelUsageMeter.REQUEST_UNITS, 1, role=ModelUsageMeterRole.INFORMATIONAL),
        )
    )


def estimate_rerank(*, document_count: int) -> UsageEstimate:
    _positive_integer(document_count, field="document_count")
    return UsageEstimate(
        meters=(
            _quantity(ModelUsageMeter.RERANK_REQUESTS, 1, role=ModelUsageMeterRole.BILLABLE),
            _quantity(ModelUsageMeter.RERANK_DOCUMENTS, document_count, role=ModelUsageMeterRole.BILLABLE),
        )
    )


def estimate_stt(*, duration_seconds: Decimal) -> UsageEstimate:
    if not isinstance(duration_seconds, Decimal) or duration_seconds <= 0:
        raise ModelUsageContractError("duration_seconds_must_be_positive")
    return UsageEstimate(
        meters=(
            _quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS, duration_seconds, role=ModelUsageMeterRole.BILLABLE),
        )
    )


def estimate_tts(*, character_count: int) -> UsageEstimate:
    _positive_integer(character_count, field="character_count")
    return UsageEstimate(
        meters=(
            _quantity(ModelUsageMeter.TTS_CHARACTERS, character_count, role=ModelUsageMeterRole.BILLABLE),
        )
    )


def estimate_image_generation(*, image_count: int) -> UsageEstimate:
    _positive_integer(image_count, field="image_count")
    return UsageEstimate(
        meters=(
            _quantity(ModelUsageMeter.GENERATED_IMAGES, image_count, role=ModelUsageMeterRole.BILLABLE),
            _quantity(ModelUsageMeter.REQUEST_UNITS, 1, role=ModelUsageMeterRole.BILLABLE),
        )
    )


def estimate_realtime_audio(
    *,
    billable_meters: frozenset[ModelUsageMeter],
    lease_seconds: Decimal,
    input_tokens_per_second_cap: Decimal | None,
    output_tokens_per_second_cap: Decimal | None,
) -> UsageEstimate:
    if not isinstance(lease_seconds, Decimal) or lease_seconds <= 0:
        raise ModelUsageContractError("lease_seconds_must_be_positive")
    seconds = {
        ModelUsageMeter.AUDIO_INPUT_SECONDS,
        ModelUsageMeter.AUDIO_OUTPUT_SECONDS,
    }
    tokens = {
        ModelUsageMeter.AUDIO_INPUT_TOKENS,
        ModelUsageMeter.AUDIO_OUTPUT_TOKENS,
    }
    if billable_meters and billable_meters <= seconds:
        return UsageEstimate(
            meters=tuple(
                _quantity(meter, lease_seconds, role=ModelUsageMeterRole.BILLABLE)
                for meter in sorted(billable_meters, key=lambda item: item.value)
            )
        )
    if billable_meters and billable_meters <= tokens:
        if (
            input_tokens_per_second_cap is None
            or input_tokens_per_second_cap <= 0
            or output_tokens_per_second_cap is None
            or output_tokens_per_second_cap <= 0
        ):
            raise ModelUsageContractError("realtime_token_caps_required")
        caps = {
            ModelUsageMeter.AUDIO_INPUT_TOKENS: input_tokens_per_second_cap,
            ModelUsageMeter.AUDIO_OUTPUT_TOKENS: output_tokens_per_second_cap,
        }
        return UsageEstimate(
            meters=tuple(
                (
                    _quantity(
                        meter,
                        lease_seconds,
                        role=ModelUsageMeterRole.INFORMATIONAL,
                    )
                    if meter in seconds
                    else _quantity(
                        meter,
                        lease_seconds * caps[meter],
                        role=ModelUsageMeterRole.BILLABLE,
                    )
                )
                for meter in sorted(
                    billable_meters | seconds,
                    key=lambda item: item.value,
                )
            )
        )
    raise ModelUsageContractError("invalid_realtime_billable_meter_set")
