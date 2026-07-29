from __future__ import annotations

import copy
import json
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.enums import ModelUsageCapability, ModelUsageMeter
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    ProviderUsageContract,
    configured_usage_variants,
    validate_configured_variant,
)
from app.services.model_usage.pricing_manifest import (
    PriceManifestError,
    load_price_manifest,
    validate_price_manifest,
)


FIXTURE = Path(__file__).parent / "fixtures" / "prices_valid.json"


def _variant(
    capability: ModelUsageCapability,
    provider: str,
    model: str,
    variant_key: str,
    billing_scheme_key: str,
    billable: set[ModelUsageMeter],
) -> ConfiguredUsageVariant:
    token_realtime = capability is ModelUsageCapability.REALTIME_AUDIO and bool(
        billable & {ModelUsageMeter.AUDIO_INPUT_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS}
    )
    return ConfiguredUsageVariant(
        provider=provider,
        billing_model=model,
        capability=capability,
        variant_key=variant_key,
        billing_scheme_key=billing_scheme_key,
        billable_meters=frozenset(billable),
        produced_meters=frozenset(billable),
        input_tokens_per_second_cap=Decimal("100") if token_realtime else None,
        output_tokens_per_second_cap=Decimal("200") if token_realtime else None,
        lease_boundary_cumulative_meters=frozenset(billable) if token_realtime else frozenset(),
        provider_contract=ProviderUsageContract(
            supports_lease_boundary_cumulative_usage=token_realtime,
        ),
    )


def configured_test_variants() -> tuple[ConfiguredUsageVariant, ...]:
    return (
        _variant(ModelUsageCapability.LLM, "openai", "gpt-test", "default", "llm-split-v1", {ModelUsageMeter.UNCACHED_INPUT_TOKENS, ModelUsageMeter.CACHED_INPUT_TOKENS, ModelUsageMeter.OUTPUT_TOKENS}),
        _variant(ModelUsageCapability.EMBEDDING, "openai", "embedding-test", "dimensions=1536", "embedding-token-v1", {ModelUsageMeter.EMBEDDING_TOKENS}),
        _variant(ModelUsageCapability.RERANK, "dashscope", "rerank-test", "top_n=20", "rerank-request-document-v1", {ModelUsageMeter.RERANK_REQUESTS, ModelUsageMeter.RERANK_DOCUMENTS}),
        _variant(ModelUsageCapability.STT, "openai", "stt-test", "format=webm", "stt-seconds-v1", {ModelUsageMeter.AUDIO_INPUT_SECONDS}),
        _variant(ModelUsageCapability.TTS, "openai", "tts-test", "voice=default", "tts-characters-v1", {ModelUsageMeter.TTS_CHARACTERS}),
        _variant(ModelUsageCapability.REALTIME_AUDIO, "dashscope", "realtime-test", "voice=default", "realtime-audio-token-v1", {ModelUsageMeter.AUDIO_INPUT_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS}),
        _variant(ModelUsageCapability.IMAGE_GENERATION, "dashscope", "image-test", "mode=text|size=1024*1024|quality=standard", "image-count-request-v1", {ModelUsageMeter.GENERATED_IMAGES, ModelUsageMeter.REQUEST_UNITS}),
    )


def load_raw() -> dict[str, object]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_valid_manifest_has_stable_checksum_and_seven_capabilities() -> None:
    first = validate_price_manifest(load_raw(), configured_variants=configured_test_variants())
    second = validate_price_manifest(load_raw(), configured_variants=configured_test_variants())

    assert first.checksum == second.checksum
    assert len(first.checksum) == 64
    assert {rate.capability for rate in first.manifest.rates} == set(ModelUsageCapability)


def test_manifest_loader_reads_json_file() -> None:
    validated = load_price_manifest(FIXTURE, configured_variants=configured_test_variants())
    assert validated.manifest.catalog_version == "test-2026-07-30"


def test_manifest_rejects_decimal_json_number() -> None:
    raw = load_raw()
    raw["rates"][0]["unitPrice"] = 1.0  # type: ignore[index]
    with pytest.raises(PriceManifestError, match="decimal_must_be_string"):
        validate_price_manifest(raw, configured_variants=configured_test_variants())


def test_manifest_rejects_alias_cycle() -> None:
    raw = load_raw()
    raw["modelAliases"] = {"openai:model-a": "model-b", "openai:model-b": "model-a"}
    with pytest.raises(PriceManifestError, match="model_alias_cycle"):
        validate_price_manifest(raw, configured_variants=configured_test_variants())


def test_manifest_rejects_duplicate_rate_identity() -> None:
    raw = load_raw()
    raw["rates"].append(copy.deepcopy(raw["rates"][0]))  # type: ignore[union-attr,index]
    with pytest.raises(PriceManifestError, match="duplicate_rate_identity"):
        validate_price_manifest(raw, configured_variants=configured_test_variants())


def test_manifest_rejects_missing_fx() -> None:
    raw = load_raw()
    raw["fxRates"].pop("USD")  # type: ignore[union-attr]
    with pytest.raises(PriceManifestError, match="missing_fx_rate"):
        validate_price_manifest(raw, configured_variants=configured_test_variants())


def test_manifest_rejects_informational_price() -> None:
    raw = load_raw()
    raw["rates"][0]["meterRole"] = "informational"  # type: ignore[index]
    with pytest.raises(PriceManifestError, match="informational_meter_has_price"):
        validate_price_manifest(raw, configured_variants=configured_test_variants())


@pytest.mark.parametrize(
    ("meter", "variant_index"),
    (
        ("total_tokens", 0),
        ("input_tokens", 0),
        ("audio_input_seconds", 8),
        ("audio_output_seconds", 9),
        ("tts_tokens", 7),
        ("audio_output_seconds", 7),
    ),
)
def test_manifest_rejects_overlapping_billable_meters(
    meter: str,
    variant_index: int,
) -> None:
    raw = load_raw()
    extra = copy.deepcopy(raw["rates"][variant_index])  # type: ignore[index]
    extra["meter"] = meter
    raw["rates"].append(extra)  # type: ignore[union-attr]
    with pytest.raises(PriceManifestError, match="overlapping_billable_meters"):
        validate_price_manifest(raw, configured_variants=configured_test_variants())


def test_manifest_rejects_adapter_billable_set_mismatch() -> None:
    raw = load_raw()
    raw["rates"] = raw["rates"][1:]  # type: ignore[index]
    with pytest.raises(PriceManifestError, match="adapter_billable_meter_mismatch"):
        validate_price_manifest(raw, configured_variants=configured_test_variants())


def test_realtime_boundary_watermark_requires_adapter_contract() -> None:
    variant = configured_test_variants()[5]
    unsupported = replace(
        variant,
        provider_contract=replace(
            variant.provider_contract,
            supports_lease_boundary_cumulative_usage=False,
        ),
    )
    with pytest.raises(PriceManifestError, match="unsupported_lease_boundary_cumulative_meter"):
        validate_configured_variant(unsupported)


def test_realtime_token_scheme_requires_positive_caps() -> None:
    variant = replace(configured_test_variants()[5], input_tokens_per_second_cap=None)
    with pytest.raises(PriceManifestError, match="realtime_token_caps_required"):
        validate_configured_variant(variant)


def test_enabled_settings_are_discovered_for_all_seven_capabilities() -> None:
    settings = SimpleNamespace(
        ai_provider="openai",
        ai_model="gpt-test",
        search_embedding_provider="openai",
        search_embedding_model="embedding-test",
        search_embedding_dimensions=1536,
        search_rerank_provider="dashscope",
        search_rerank_model="rerank-test",
        search_rerank_candidate_limit=20,
        ai_stt_provider="openai",
        ai_stt_model="stt-test",
        ai_stt_audio_format="webm",
        ai_tts_provider="openai",
        ai_tts_model="tts-test",
        ai_tts_voice="default",
        ai_realtime_provider="dashscope",
        ai_realtime_model="realtime-test",
        ai_realtime_voice="default",
        ai_image_reference_provider="disabled",
        ai_image_reference_model="",
        ai_image_text_provider="dashscope",
        ai_image_text_model="image-test",
    )

    variants = configured_usage_variants(settings)

    assert {variant.capability for variant in variants} == set(ModelUsageCapability)
