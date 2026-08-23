from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import ModelUsageCapability, ModelUsageMeter
from app.models.family_model_settings import FamilyModelCapabilityBinding
from app.repos.family_model_settings.configurations import list_enabled_bindings
from app.repos.family_model_settings.profiles import get_provider_profile_version
from app.services.family_model_settings.adapter_registry import AdapterDefinition, adapter_definition
from app.services.family_model_settings.types import ResolvedCapabilityBinding
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
    tts_characters_per_lease_cap: int | None = None
    lease_boundary_cumulative_meters: frozenset[ModelUsageMeter] = frozenset()
    provider_contract: ProviderUsageContract = ProviderUsageContract()
    realtime_input_model: str | None = None
    realtime_output_model: str | None = None

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


_BILLABLE_METERS_BY_CAPABILITY: dict[
    ModelUsageCapability, frozenset[ModelUsageMeter]
] = {
    ModelUsageCapability.LLM: frozenset(
        {
            ModelUsageMeter.UNCACHED_INPUT_TOKENS,
            ModelUsageMeter.CACHED_INPUT_TOKENS,
            ModelUsageMeter.OUTPUT_TOKENS,
        }
    ),
    ModelUsageCapability.IMAGE_GENERATION: frozenset(
        {ModelUsageMeter.GENERATED_IMAGES}
    ),
    ModelUsageCapability.STT: frozenset({ModelUsageMeter.AUDIO_INPUT_SECONDS}),
    ModelUsageCapability.TTS: frozenset({ModelUsageMeter.TTS_CHARACTERS}),
    ModelUsageCapability.REALTIME_AUDIO: frozenset(
        {ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.TTS_CHARACTERS}
    ),
    ModelUsageCapability.EMBEDDING: frozenset({ModelUsageMeter.EMBEDDING_TOKENS}),
    ModelUsageCapability.RERANK: frozenset({ModelUsageMeter.INPUT_TOKENS}),
}

_PRODUCED_METERS_BY_CAPABILITY: dict[
    ModelUsageCapability, frozenset[ModelUsageMeter]
] = {
    ModelUsageCapability.LLM: frozenset(
        {
            ModelUsageMeter.INPUT_TOKENS,
            ModelUsageMeter.UNCACHED_INPUT_TOKENS,
            ModelUsageMeter.CACHED_INPUT_TOKENS,
            ModelUsageMeter.OUTPUT_TOKENS,
            ModelUsageMeter.TOTAL_TOKENS,
        }
    ),
    ModelUsageCapability.IMAGE_GENERATION: frozenset(
        {ModelUsageMeter.GENERATED_IMAGES}
    ),
    ModelUsageCapability.STT: frozenset({ModelUsageMeter.AUDIO_INPUT_SECONDS}),
    ModelUsageCapability.TTS: frozenset({ModelUsageMeter.TTS_CHARACTERS}),
    ModelUsageCapability.REALTIME_AUDIO: frozenset(
        {ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.TTS_CHARACTERS}
    ),
    ModelUsageCapability.EMBEDDING: frozenset(
        {ModelUsageMeter.EMBEDDING_TOKENS, ModelUsageMeter.REQUEST_UNITS}
    ),
    ModelUsageCapability.RERANK: frozenset({ModelUsageMeter.INPUT_TOKENS}),
}


def realtime_duplex_billing_model(*, input_model: str, output_model: str) -> str:
    if not input_model or not output_model or "|" in input_model or "|" in output_model:
        raise PriceManifestError("realtime_provider_model_identity_invalid")
    identity = f"realtime-duplex-v1|input={input_model}|output={output_model}"
    if len(identity) > 160:
        raise PriceManifestError("realtime_provider_model_identity_invalid")
    return identity


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
        if (
            variant.lease_boundary_cumulative_meters
            or any(cap is not None for cap in caps)
            or variant.tts_characters_per_lease_cap is not None
            or variant.realtime_input_model is not None
            or variant.realtime_output_model is not None
        ):
            raise PriceManifestError("realtime_contract_on_non_realtime_variant")
        return variant

    has_input_model = variant.realtime_input_model is not None
    has_output_model = variant.realtime_output_model is not None
    if has_input_model != has_output_model:
        raise PriceManifestError("realtime_provider_model_identity_invalid")
    if has_input_model and variant.billing_model != realtime_duplex_billing_model(
        input_model=variant.realtime_input_model or "",
        output_model=variant.realtime_output_model or "",
    ):
        raise PriceManifestError("realtime_composite_billing_model_invalid")

    uses_token_billing = bool(variant.billable_meters & AUDIO_TOKEN_METERS)
    uses_second_billing = bool(variant.billable_meters & AUDIO_SECOND_METERS)
    uses_tts_character_billing = (
        ModelUsageMeter.TTS_CHARACTERS in variant.billable_meters
    )
    if uses_token_billing and uses_second_billing:
        raise PriceManifestError("overlapping_billable_meters")
    if uses_token_billing:
        if any(cap is None or cap <= 0 for cap in caps):
            raise PriceManifestError("realtime_token_caps_required")
        if not AUDIO_SECOND_METERS <= variant.produced_meters:
            raise PriceManifestError("realtime_server_clock_meters_required")
    elif any(cap is not None for cap in caps):
        raise PriceManifestError("realtime_seconds_scheme_forbids_token_caps")
    if uses_tts_character_billing:
        character_cap = variant.tts_characters_per_lease_cap
        if (
            isinstance(character_cap, bool)
            or not isinstance(character_cap, int)
            or character_cap <= 0
        ):
            raise PriceManifestError("realtime_tts_character_cap_required")
    elif variant.tts_characters_per_lease_cap is not None:
        raise PriceManifestError("realtime_tts_character_cap_forbidden")

    if (
        variant.lease_boundary_cumulative_meters
        and not variant.provider_contract.supports_lease_boundary_cumulative_usage
    ):
        raise PriceManifestError("unsupported_lease_boundary_cumulative_meter")
    return variant


def configured_variant_from_binding(
    binding: FamilyModelCapabilityBinding,
    definition: AdapterDefinition,
) -> ConfiguredUsageVariant:
    """Build one stable ledger variant from an immutable capability binding.

    A provider profile's opaque, family-owned ID is deliberately the ledger
    provider identity.  Endpoint and credential changes therefore cannot
    accidentally merge usage from two families or two provider profiles that
    happen to use the same adapter kind.
    """

    if (
        not binding.enabled
        or binding.provider_profile_id is None
        or binding.provider_profile_version_id is None
        or not binding.requested_model
        or not binding.billing_scheme_key
    ):
        raise PriceManifestError("configured_binding_identity_required")
    if (
        binding.capability.value not in definition.capabilities
        or binding.billing_scheme_key
        not in definition.billing_schemes.get(binding.capability.value, ())
    ):
        # The caller validates the actual profile auth mode as well.  Keeping
        # this structural check here makes a corrupted immutable binding fail
        # closed even when no provider request is attempted.
        raise PriceManifestError("configured_binding_adapter_unsupported")

    billable = _BILLABLE_METERS_BY_CAPABILITY[binding.capability]
    produced = _PRODUCED_METERS_BY_CAPABILITY[binding.capability]
    realtime_options = binding.options_json if isinstance(binding.options_json, dict) else {}
    realtime_cap = realtime_options.get("max_tts_characters")
    if not isinstance(realtime_cap, int) or isinstance(realtime_cap, bool):
        realtime_cap = 4096
    return ConfiguredUsageVariant(
        provider=binding.provider_profile_id,
        billing_model=binding.requested_model,
        capability=binding.capability,
        variant_key=binding.variant_key,
        billing_scheme_key=binding.billing_scheme_key,
        billable_meters=billable,
        produced_meters=produced,
        tts_characters_per_lease_cap=(
            realtime_cap
            if binding.capability is ModelUsageCapability.REALTIME_AUDIO
            else None
        ),
    )


def configured_variant_from_resolved_binding(
    binding: ResolvedCapabilityBinding,
) -> ConfiguredUsageVariant:
    """Build a ledger variant from request-scoped immutable binding metadata.

    Runtime adapters receive ``ResolvedCapabilityBinding`` rather than ORM rows
    so that they never re-read a mutable active pointer after a session or job
    has selected its configuration revision.
    """

    if binding.capability != "realtime_audio":
        raise PriceManifestError("configured_binding_capability_invalid")
    definition = adapter_definition(binding.adapter_kind)
    if not definition.supports(
        capability=binding.capability,
        auth_mode=binding.auth_mode,
        billing_scheme_key=binding.billing_scheme_key,
    ):
        raise PriceManifestError("configured_binding_adapter_unsupported")
    # ``ResolvedCapabilityBinding.options`` deliberately uses the Mapping
    # contract.  A resolver may hand us an immutable mapping, which is just as
    # valid as the mutable ORM JSON dict used while publishing a revision.
    options = binding.options if isinstance(binding.options, Mapping) else {}
    raw_cap = options.get("max_tts_characters", 4096)
    if isinstance(raw_cap, bool) or not isinstance(raw_cap, int) or raw_cap <= 0:
        raise PriceManifestError("realtime_tts_character_cap_required")
    return validate_configured_variant(
        ConfiguredUsageVariant(
            provider=binding.provider_profile_id,
            billing_model=binding.billing_model,
            capability=ModelUsageCapability.REALTIME_AUDIO,
            variant_key=binding.variant_key,
            billing_scheme_key=binding.billing_scheme_key,
            billable_meters=_BILLABLE_METERS_BY_CAPABILITY[ModelUsageCapability.REALTIME_AUDIO],
            produced_meters=_PRODUCED_METERS_BY_CAPABILITY[ModelUsageCapability.REALTIME_AUDIO],
            tts_characters_per_lease_cap=raw_cap,
        )
    )


def configured_usage_variants(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
) -> tuple[ConfiguredUsageVariant, ...]:
    """Return enabled family variants for one immutable configuration revision.

    The function intentionally accepts neither ``Settings`` nor a provider
    environment name.  Runtime callers must choose a family/revision before
    they can obtain a billable provider identity.
    """

    variants: list[ConfiguredUsageVariant] = []
    for binding in list_enabled_bindings(
        db,
        family_id=family_id,
        config_revision_id=config_revision_id,
    ):
        if (
            binding.provider_profile_id is None
            or binding.provider_profile_version_id is None
        ):
            raise PriceManifestError("configured_binding_identity_required")
        profile_version = get_provider_profile_version(
            db,
            family_id=family_id,
            profile_id=binding.provider_profile_id,
            profile_version_id=binding.provider_profile_version_id,
        )
        if profile_version is None:
            raise PriceManifestError("configured_binding_profile_not_found")
        definition = adapter_definition(profile_version.adapter_kind)
        if not definition.supports(
            capability=binding.capability.value,
            auth_mode=profile_version.auth_mode,
            billing_scheme_key=binding.billing_scheme_key,
        ):
            raise PriceManifestError("configured_binding_adapter_unsupported")
        variants.append(
            validate_configured_variant(configured_variant_from_binding(binding, definition))
        )
    return tuple(variants)
