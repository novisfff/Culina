from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.core.enums import ModelUsageCapability, ModelUsageMeter
from app.services.model_usage.errors import ModelUsageContractError


class PriceManifestError(ModelUsageContractError):
    default_code = "invalid_price_manifest"


@dataclass(frozen=True, slots=True)
class ProviderUsageContract:
    supports_lease_boundary_cumulative_usage: bool = False


@dataclass(frozen=True, slots=True)
class ConfiguredUsageVariant:
    provider: str
    billing_model: str
    capability: ModelUsageCapability
    variant_key: str
    billing_scheme_key: str
    billable_meters: frozenset[ModelUsageMeter]
    produced_meters: frozenset[ModelUsageMeter]
    input_tokens_per_second_cap: Decimal | None = None
    output_tokens_per_second_cap: Decimal | None = None
    lease_boundary_cumulative_meters: frozenset[ModelUsageMeter] = frozenset()
    provider_contract: ProviderUsageContract = ProviderUsageContract()

    @property
    def identity(self) -> tuple[str, str, ModelUsageCapability, str, str]:
        return (
            self.provider,
            self.billing_model,
            self.capability,
            self.variant_key,
            self.billing_scheme_key,
        )


AUDIO_TOKEN_METERS = frozenset(
    {ModelUsageMeter.AUDIO_INPUT_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS}
)
AUDIO_SECOND_METERS = frozenset(
    {ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.AUDIO_OUTPUT_SECONDS}
)


def validate_configured_variant(
    variant: ConfiguredUsageVariant,
) -> ConfiguredUsageVariant:
    if not variant.provider or not variant.billing_model or not variant.variant_key:
        raise PriceManifestError("configured_variant_identity_required")
    if not variant.billing_scheme_key or not variant.billable_meters:
        raise PriceManifestError("configured_variant_scheme_required")
    if not variant.billable_meters <= variant.produced_meters:
        raise PriceManifestError("billable_meter_not_produced")
    if not variant.lease_boundary_cumulative_meters <= variant.produced_meters:
        raise PriceManifestError("unsupported_lease_boundary_cumulative_meter")

    caps = (
        variant.input_tokens_per_second_cap,
        variant.output_tokens_per_second_cap,
    )
    if variant.capability is not ModelUsageCapability.REALTIME_AUDIO:
        if variant.lease_boundary_cumulative_meters or any(cap is not None for cap in caps):
            raise PriceManifestError("realtime_contract_on_non_realtime_variant")
        return variant

    uses_token_billing = bool(variant.billable_meters & AUDIO_TOKEN_METERS)
    uses_second_billing = bool(variant.billable_meters & AUDIO_SECOND_METERS)
    if uses_token_billing and uses_second_billing:
        raise PriceManifestError("overlapping_billable_meters")
    if uses_token_billing:
        if any(cap is None or cap <= 0 for cap in caps):
            raise PriceManifestError("realtime_token_caps_required")
        if not AUDIO_SECOND_METERS <= variant.produced_meters:
            raise PriceManifestError("realtime_server_clock_meters_required")
    elif any(cap is not None for cap in caps):
        raise PriceManifestError("realtime_seconds_scheme_forbids_token_caps")

    if (
        variant.lease_boundary_cumulative_meters
        and not variant.provider_contract.supports_lease_boundary_cumulative_usage
    ):
        raise PriceManifestError("unsupported_lease_boundary_cumulative_meter")
    return variant


def configured_usage_variants(settings: object) -> tuple[ConfiguredUsageVariant, ...]:
    """Return enabled production variants from settings without reading credentials."""

    variants: list[ConfiguredUsageVariant] = []

    ai_provider = str(getattr(settings, "ai_provider", "disabled") or "disabled")
    ai_model = str(getattr(settings, "ai_model", "") or "")
    if ai_provider not in {"", "disabled", "mock"} and ai_model:
        variants.append(
            ConfiguredUsageVariant(
                provider=ai_provider,
                billing_model=ai_model,
                capability=ModelUsageCapability.LLM,
                variant_key="default",
                billing_scheme_key="llm-split-v1",
                billable_meters=frozenset(
                    {
                        ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                        ModelUsageMeter.CACHED_INPUT_TOKENS,
                        ModelUsageMeter.OUTPUT_TOKENS,
                    }
                ),
                produced_meters=frozenset(
                    {
                        ModelUsageMeter.INPUT_TOKENS,
                        ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                        ModelUsageMeter.CACHED_INPUT_TOKENS,
                        ModelUsageMeter.OUTPUT_TOKENS,
                        ModelUsageMeter.TOTAL_TOKENS,
                    }
                ),
            )
        )

    embedding_provider = str(
        getattr(settings, "search_embedding_provider", "disabled") or "disabled"
    )
    embedding_model = str(getattr(settings, "search_embedding_model", "") or "")
    embedding_dimensions = int(getattr(settings, "search_embedding_dimensions", 0) or 0)
    if embedding_provider not in {"", "disabled", "mock"} and embedding_model:
        variants.append(
            ConfiguredUsageVariant(
                provider=embedding_provider,
                billing_model=embedding_model,
                capability=ModelUsageCapability.EMBEDDING,
                variant_key=f"dimensions={embedding_dimensions}",
                billing_scheme_key="embedding-token-v1",
                billable_meters=frozenset({ModelUsageMeter.EMBEDDING_TOKENS}),
                produced_meters=frozenset(
                    {
                        ModelUsageMeter.EMBEDDING_TOKENS,
                        ModelUsageMeter.REQUEST_UNITS,
                    }
                ),
            )
        )

    rerank_provider = str(
        getattr(settings, "search_rerank_provider", "disabled") or "disabled"
    )
    rerank_model = str(getattr(settings, "search_rerank_model", "") or "")
    rerank_limit = int(getattr(settings, "search_rerank_candidate_limit", 50) or 50)
    if rerank_provider not in {"", "disabled", "mock"} and rerank_model:
        variants.append(
            ConfiguredUsageVariant(
                provider=rerank_provider,
                billing_model=rerank_model,
                capability=ModelUsageCapability.RERANK,
                variant_key=f"top_n={rerank_limit}",
                billing_scheme_key="rerank-request-document-v1",
                billable_meters=frozenset(
                    {ModelUsageMeter.RERANK_REQUESTS, ModelUsageMeter.RERANK_DOCUMENTS}
                ),
                produced_meters=frozenset(
                    {ModelUsageMeter.RERANK_REQUESTS, ModelUsageMeter.RERANK_DOCUMENTS}
                ),
            )
        )

    stt_provider = str(getattr(settings, "ai_stt_provider", "disabled") or "disabled")
    stt_model = str(getattr(settings, "ai_stt_model", "") or "")
    stt_format = str(getattr(settings, "ai_stt_audio_format", "auto") or "auto")
    if stt_provider not in {"", "disabled", "mock"} and stt_model:
        variants.append(
            ConfiguredUsageVariant(
                provider=stt_provider,
                billing_model=stt_model,
                capability=ModelUsageCapability.STT,
                variant_key=f"format={stt_format}",
                billing_scheme_key="stt-seconds-v1",
                billable_meters=frozenset({ModelUsageMeter.AUDIO_INPUT_SECONDS}),
                produced_meters=frozenset({ModelUsageMeter.AUDIO_INPUT_SECONDS}),
            )
        )

    tts_provider = str(getattr(settings, "ai_tts_provider", "disabled") or "disabled")
    tts_model = str(getattr(settings, "ai_tts_model", "") or "")
    tts_voice = str(getattr(settings, "ai_tts_voice", "default") or "default")
    if tts_provider not in {"", "disabled", "mock"} and tts_model:
        variants.append(
            ConfiguredUsageVariant(
                provider=tts_provider,
                billing_model=tts_model,
                capability=ModelUsageCapability.TTS,
                variant_key=f"voice={tts_voice}",
                billing_scheme_key="tts-characters-v1",
                billable_meters=frozenset({ModelUsageMeter.TTS_CHARACTERS}),
                produced_meters=frozenset({ModelUsageMeter.TTS_CHARACTERS}),
            )
        )

    realtime_provider = str(
        getattr(settings, "ai_realtime_provider", "disabled") or "disabled"
    )
    realtime_model = str(getattr(settings, "ai_realtime_model", "") or "")
    realtime_voice = str(
        getattr(settings, "ai_realtime_voice", "default") or "default"
    )
    if realtime_provider not in {"", "disabled", "mock"} and realtime_model:
        variants.append(
            ConfiguredUsageVariant(
                provider=realtime_provider,
                billing_model=realtime_model,
                capability=ModelUsageCapability.REALTIME_AUDIO,
                variant_key=f"voice={realtime_voice}",
                billing_scheme_key="realtime-audio-seconds-v1",
                billable_meters=frozenset(
                    {
                        ModelUsageMeter.AUDIO_INPUT_SECONDS,
                        ModelUsageMeter.AUDIO_OUTPUT_SECONDS,
                    }
                ),
                produced_meters=frozenset(
                    {
                        ModelUsageMeter.AUDIO_INPUT_SECONDS,
                        ModelUsageMeter.AUDIO_OUTPUT_SECONDS,
                    }
                ),
            )
        )

    image_modes = (
        (
            "reference",
            str(
                getattr(settings, "ai_image_reference_provider", "disabled")
                or "disabled"
            ),
            str(getattr(settings, "ai_image_reference_model", "") or ""),
        ),
        (
            "text",
            str(getattr(settings, "ai_image_text_provider", "disabled") or "disabled"),
            str(getattr(settings, "ai_image_text_model", "") or ""),
        ),
    )
    for mode, provider, model in image_modes:
        if provider in {"", "disabled", "mock"} or not model:
            continue
        variants.append(
            ConfiguredUsageVariant(
                provider=provider,
                billing_model=model,
                capability=ModelUsageCapability.IMAGE_GENERATION,
                variant_key=f"mode={mode}|size=1536*1152|quality=standard",
                billing_scheme_key="image-count-request-v1",
                billable_meters=frozenset(
                    {ModelUsageMeter.GENERATED_IMAGES, ModelUsageMeter.REQUEST_UNITS}
                ),
                produced_meters=frozenset(
                    {ModelUsageMeter.GENERATED_IMAGES, ModelUsageMeter.REQUEST_UNITS}
                ),
            )
        )

    return tuple(validate_configured_variant(variant) for variant in variants)
