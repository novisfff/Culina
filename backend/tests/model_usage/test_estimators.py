from decimal import Decimal

import pytest

from app.core.enums import ModelUsageMeter
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.estimators import (
    estimate_embedding,
    estimate_image_generation,
    estimate_llm,
    estimate_realtime_audio,
    estimate_rerank,
    estimate_stt,
    estimate_tts,
)


def test_llm_estimator_requires_output_cap() -> None:
    with pytest.raises(ModelUsageContractError, match="llm_output_cap_required"):
        estimate_llm(input_tokens=120, cached_input_tokens=20, max_output_tokens=None)


def test_llm_estimator_preserves_component_and_total_quantities() -> None:
    estimate = estimate_llm(input_tokens=120, cached_input_tokens=20, max_output_tokens=50)
    assert estimate.quantity(ModelUsageMeter.UNCACHED_INPUT_TOKENS) == Decimal("100.000000")
    assert estimate.quantity(ModelUsageMeter.CACHED_INPUT_TOKENS) == Decimal("20.000000")
    assert estimate.quantity(ModelUsageMeter.OUTPUT_TOKENS) == Decimal("50.000000")
    assert estimate.quantity(ModelUsageMeter.TOTAL_TOKENS) == Decimal("170.000000")


def test_realtime_estimator_reserves_only_next_seconds_lease() -> None:
    estimate = estimate_realtime_audio(
        billable_meters=frozenset(
            {ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.AUDIO_OUTPUT_SECONDS}
        ),
        lease_seconds=Decimal("30"),
        input_tokens_per_second_cap=None,
        output_tokens_per_second_cap=None,
    )
    assert estimate.quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("30.000000")
    assert estimate.quantity(ModelUsageMeter.AUDIO_OUTPUT_SECONDS) == Decimal("30.000000")


def test_realtime_token_scheme_uses_explicit_conservative_caps() -> None:
    estimate = estimate_realtime_audio(
        billable_meters=frozenset(
            {ModelUsageMeter.AUDIO_INPUT_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS}
        ),
        lease_seconds=Decimal("30"),
        input_tokens_per_second_cap=Decimal("50"),
        output_tokens_per_second_cap=Decimal("100"),
    )
    assert estimate.quantity(ModelUsageMeter.AUDIO_INPUT_TOKENS) == Decimal("1500.000000")
    assert estimate.quantity(ModelUsageMeter.AUDIO_OUTPUT_TOKENS) == Decimal("3000.000000")


def test_realtime_dashscope_scheme_reserves_seconds_and_tts_character_cap() -> None:
    estimate = estimate_realtime_audio(
        billable_meters=frozenset(
            {ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.TTS_CHARACTERS}
        ),
        lease_seconds=Decimal("30"),
        input_tokens_per_second_cap=None,
        output_tokens_per_second_cap=None,
        tts_characters_per_lease_cap=4096,
    )

    assert estimate.quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("30")
    assert estimate.quantity(ModelUsageMeter.TTS_CHARACTERS) == Decimal("4096")


def test_other_estimators_use_exact_server_known_quantities() -> None:
    assert estimate_embedding(token_count=123).quantity(ModelUsageMeter.EMBEDDING_TOKENS) == Decimal("123.000000")
    rerank = estimate_rerank(input_tokens=17)
    assert rerank.quantity(ModelUsageMeter.INPUT_TOKENS) == Decimal("17.000000")
    assert estimate_stt(duration_seconds=Decimal("2.25")).quantity(ModelUsageMeter.AUDIO_INPUT_SECONDS) == Decimal("2.250000")
    assert estimate_tts(character_count=42).quantity(ModelUsageMeter.TTS_CHARACTERS) == Decimal("42.000000")
    assert estimate_image_generation(image_count=2).quantity(ModelUsageMeter.GENERATED_IMAGES) == Decimal("2.000000")


@pytest.mark.parametrize("value", [0, -1, True])
def test_integer_estimators_reject_non_positive_counts(value: object) -> None:
    with pytest.raises(ModelUsageContractError):
        estimate_rerank(input_tokens=value)  # type: ignore[arg-type]
