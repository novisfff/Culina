from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from app.core.enums import ModelUsageCapability, ModelUsageMeter, ModelUsageMeterRole
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    PriceManifestError,
    validate_configured_variant,
)


TOKEN_COMPONENT_METERS = frozenset(
    {
        ModelUsageMeter.INPUT_TOKENS,
        ModelUsageMeter.UNCACHED_INPUT_TOKENS,
        ModelUsageMeter.CACHED_INPUT_TOKENS,
        ModelUsageMeter.OUTPUT_TOKENS,
    }
)

FORBIDDEN_BILLABLE_PAIRS = (
    (ModelUsageMeter.INPUT_TOKENS, ModelUsageMeter.UNCACHED_INPUT_TOKENS),
    (ModelUsageMeter.INPUT_TOKENS, ModelUsageMeter.CACHED_INPUT_TOKENS),
    (ModelUsageMeter.AUDIO_INPUT_SECONDS, ModelUsageMeter.AUDIO_INPUT_TOKENS),
    (ModelUsageMeter.AUDIO_OUTPUT_SECONDS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS),
    (ModelUsageMeter.TTS_CHARACTERS, ModelUsageMeter.TTS_TOKENS),
    (ModelUsageMeter.TTS_CHARACTERS, ModelUsageMeter.AUDIO_OUTPUT_SECONDS),
    (ModelUsageMeter.TTS_CHARACTERS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS),
    (ModelUsageMeter.TTS_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_SECONDS),
    (ModelUsageMeter.TTS_TOKENS, ModelUsageMeter.AUDIO_OUTPUT_TOKENS),
)


class ManifestRate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    provider: str
    billing_model: str = Field(alias="billingModel")
    capability: ModelUsageCapability
    variant_key: str = Field(alias="variant")
    billing_scheme_key: str = Field(alias="billingSchemeKey")
    meter: ModelUsageMeter
    meter_role: ModelUsageMeterRole = Field(alias="meterRole")
    unit_quantity: Decimal = Field(alias="unitQuantity")
    unit_price: Decimal | None = Field(alias="unitPrice", default=None)
    source_currency: str | None = Field(alias="sourceCurrency", default=None)

    @field_validator("provider", "billing_model", "variant_key", "billing_scheme_key")
    @classmethod
    def require_nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value cannot be empty")
        return value.strip()

    @property
    def identity(self) -> tuple[str, str, ModelUsageCapability, str, str, ModelUsageMeter]:
        return (
            self.provider,
            self.billing_model,
            self.capability,
            self.variant_key,
            self.billing_scheme_key,
            self.meter,
        )

    @property
    def scheme_identity(self) -> tuple[str, str, ModelUsageCapability, str, str]:
        return self.identity[:-1]


class PriceManifest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    catalog_version: str = Field(alias="catalogVersion")
    effective_from: datetime = Field(alias="effectiveFrom")
    reviewed_at: datetime = Field(alias="reviewedAt")
    source_ref: str = Field(alias="sourceRef")
    change_note: str = Field(alias="changeNote")
    fx_rates: dict[str, Decimal] = Field(alias="fxRates")
    model_aliases: dict[str, str] = Field(alias="modelAliases")
    rates: tuple[ManifestRate, ...]

    @field_validator("effective_from", "reviewed_at")
    @classmethod
    def require_aware_datetime(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("datetime must be timezone-aware")
        return value


class ValidatedPriceManifest(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    manifest: PriceManifest
    checksum: str


def _validate_decimal_encoding(raw: Mapping[str, Any]) -> None:
    fx_rates = raw.get("fxRates")
    if not isinstance(fx_rates, Mapping):
        raise PriceManifestError("invalid_fx_rates")
    if any(not isinstance(value, str) for value in fx_rates.values()):
        raise PriceManifestError("decimal_must_be_string")
    rates = raw.get("rates")
    if not isinstance(rates, list):
        raise PriceManifestError("invalid_rates")
    for rate in rates:
        if not isinstance(rate, Mapping):
            raise PriceManifestError("invalid_rate")
        if not isinstance(rate.get("unitQuantity"), str):
            raise PriceManifestError("decimal_must_be_string")
        if "unitPrice" in rate and rate["unitPrice"] is not None and not isinstance(
            rate["unitPrice"], str
        ):
            raise PriceManifestError("decimal_must_be_string")


def _canonical_checksum(manifest: PriceManifest) -> str:
    payload = manifest.model_dump(by_alias=True, mode="json")
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_aliases(aliases: Mapping[str, str]) -> None:
    for source in aliases:
        if ":" not in source:
            raise PriceManifestError("invalid_model_alias")
        provider, model = source.split(":", 1)
        seen = {model}
        target = aliases[source]
        while f"{provider}:{target}" in aliases:
            if target in seen:
                raise PriceManifestError("model_alias_cycle")
            seen.add(target)
            target = aliases[f"{provider}:{target}"]


def validate_billable_scheme(
    rates: Sequence[ManifestRate],
    configured: ConfiguredUsageVariant,
) -> None:
    billable = {
        rate.meter
        for rate in rates
        if rate.meter_role is ModelUsageMeterRole.BILLABLE
    }
    if ModelUsageMeter.TOTAL_TOKENS in billable and billable & TOKEN_COMPONENT_METERS:
        raise PriceManifestError("overlapping_billable_meters")
    if any(left in billable and right in billable for left, right in FORBIDDEN_BILLABLE_PAIRS):
        raise PriceManifestError("overlapping_billable_meters")
    if billable != configured.billable_meters:
        raise PriceManifestError("adapter_billable_meter_mismatch")


def _validate_scheme_overlap(rates: Sequence[ManifestRate]) -> None:
    billable = {
        rate.meter
        for rate in rates
        if rate.meter_role is ModelUsageMeterRole.BILLABLE
    }
    if ModelUsageMeter.TOTAL_TOKENS in billable and billable & TOKEN_COMPONENT_METERS:
        raise PriceManifestError("overlapping_billable_meters")
    if any(left in billable and right in billable for left, right in FORBIDDEN_BILLABLE_PAIRS):
        raise PriceManifestError("overlapping_billable_meters")


def validate_price_manifest(
    raw: Mapping[str, Any],
    *,
    configured_variants: Sequence[ConfiguredUsageVariant],
) -> ValidatedPriceManifest:
    _validate_decimal_encoding(raw)
    try:
        manifest = PriceManifest.model_validate(raw)
    except ValidationError as exc:
        raise PriceManifestError("invalid_price_manifest", message=str(exc)) from exc

    if not manifest.catalog_version.strip() or not manifest.rates:
        raise PriceManifestError("empty_price_manifest")
    if any(rate.unit_quantity <= 0 for rate in manifest.rates):
        raise PriceManifestError("invalid_unit_quantity")
    if any(value <= 0 for value in manifest.fx_rates.values()):
        raise PriceManifestError("invalid_fx_rate")
    _validate_aliases(manifest.model_aliases)

    seen: set[tuple[str, str, ModelUsageCapability, str, str, ModelUsageMeter]] = set()
    grouped: dict[
        tuple[str, str, ModelUsageCapability, str, str], list[ManifestRate]
    ] = defaultdict(list)
    for rate in manifest.rates:
        if rate.identity in seen:
            raise PriceManifestError("duplicate_rate_identity")
        seen.add(rate.identity)
        grouped[rate.scheme_identity].append(rate)
        if rate.meter_role is ModelUsageMeterRole.INFORMATIONAL:
            if rate.unit_price is not None or rate.source_currency is not None:
                raise PriceManifestError("informational_meter_has_price")
            continue
        if rate.unit_price is None or rate.unit_price < 0 or not rate.source_currency:
            raise PriceManifestError("billable_meter_price_required")
        if rate.source_currency not in manifest.fx_rates:
            raise PriceManifestError("missing_fx_rate")

    configured_by_identity = {}
    for variant in configured_variants:
        validate_configured_variant(variant)
        if variant.identity in configured_by_identity:
            raise PriceManifestError("duplicate_configured_variant")
        configured_by_identity[variant.identity] = variant

    for rates in grouped.values():
        _validate_scheme_overlap(rates)

    for identity, variant in configured_by_identity.items():
        rates = grouped.get(identity)
        if rates is None:
            raise PriceManifestError("adapter_billable_meter_mismatch")
        validate_billable_scheme(rates, variant)

    return ValidatedPriceManifest(
        manifest=manifest,
        checksum=_canonical_checksum(manifest),
    )


def load_price_manifest(
    path: str | Path,
    *,
    configured_variants: Sequence[ConfiguredUsageVariant],
) -> ValidatedPriceManifest:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PriceManifestError("invalid_price_manifest_file") from exc
    if not isinstance(raw, Mapping):
        raise PriceManifestError("invalid_price_manifest")
    return validate_price_manifest(raw, configured_variants=configured_variants)
