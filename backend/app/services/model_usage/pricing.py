from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Mapping, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
)
from app.core.utils import create_id, utcnow
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.repos.model_usage.catalog import (
    current_published_version,
    get_candidate_search_price_version,
    get_complete_active_family_price_version,
    list_active_family_price_versions,
    next_price_version_number,
    price_rates_for_variant,
    price_version_references_query,
    published_checksum_exists,
)
from app.repos.family_model_settings.profiles import lock_family_model_settings
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    configured_usage_variants,
)
from app.services.model_usage.decimal_math import CNY_QUANTUM
from app.services.model_usage.errors import ModelUsageContractError
from app.services.model_usage.pricing_manifest import (
    ManifestRate,
    ValidatedPriceManifest,
    validate_price_manifest,
)
from app.services.model_usage.types import UsageContext, UsageEstimate


class PriceCatalogConflict(ModelUsageContractError):
    default_code = "price_catalog_conflict"


@dataclass(frozen=True, slots=True)
class UsagePriceRateSnapshot:
    meter: ModelUsageMeter
    meter_role: ModelUsageMeterRole
    unit_quantity: Decimal
    unit_price: Decimal | None
    source_currency: str | None
    fx_to_cny: Decimal | None
    unit_price_cny: Decimal | None


@dataclass(frozen=True, slots=True)
class UsagePriceSnapshot:
    pricing_status: ModelUsagePricingStatus
    price_version_id: str | None
    billing_model: str
    billing_scheme_key: str | None
    rates: tuple[UsagePriceRateSnapshot, ...]
    missing_billable_meters: frozenset[ModelUsageMeter]
    checksum: str | None

    def rate_for(self, meter: ModelUsageMeter) -> UsagePriceRateSnapshot:
        for rate in self.rates:
            if rate.meter is meter:
                return rate
        raise ModelUsageContractError("price_rate_not_found")


@dataclass(frozen=True, slots=True)
class PublishPriceCommand:
    manifest: Mapping[str, object]
    configured_variants: Sequence[ConfiguredUsageVariant]
    operator: str
    change_ticket: str
    confirm_checksum: str


@dataclass(frozen=True, slots=True)
class PriceCoverageRow:
    provider: str
    billing_model: str
    capability: str
    variant_key: str
    billing_scheme_key: str
    missing_meters: frozenset[ModelUsageMeter]


@dataclass(frozen=True, slots=True)
class PriceCoverageReport:
    price_version_id: str | None
    rows: tuple[PriceCoverageRow, ...]

    @property
    def healthy(self) -> bool:
        return self.price_version_id is not None and all(
            not row.missing_meters for row in self.rows
        )


@dataclass(frozen=True, slots=True)
class ActiveModelPriceSnapshot:
    """The config/price pair observed while holding a family's settings lock."""

    family_id: str
    config_revision_id: str
    price_version_id: str
    search_profile_id: str | None


def _cny_unit_price(rate: ManifestRate, fx_rates: Mapping[str, Decimal]) -> Decimal | None:
    if rate.unit_price is None or rate.source_currency is None:
        return None
    return (rate.unit_price * fx_rates[rate.source_currency]).quantize(
        CNY_QUANTUM,
        rounding=ROUND_HALF_UP,
    )


def _reported_aliases(
    manifest: ValidatedPriceManifest,
    *,
    provider: str,
    billing_model: str,
) -> list[str]:
    prefix = f"{provider}:"
    return sorted(
        source[len(prefix) :]
        for source, target in manifest.manifest.model_aliases.items()
        if source.startswith(prefix) and target == billing_model
    )


def publish_price_manifest(
    db: Session,
    command: PublishPriceCommand,
) -> ModelUsagePriceVersion:
    if not command.operator.strip():
        raise PriceCatalogConflict("operator_required")
    if not command.change_ticket.strip():
        raise PriceCatalogConflict("change_ticket_required")
    validated = validate_price_manifest(
        command.manifest,
        configured_variants=command.configured_variants,
    )
    if validated.checksum != command.confirm_checksum:
        raise PriceCatalogConflict("checksum_mismatch")
    if published_checksum_exists(db, checksum=validated.checksum):
        raise PriceCatalogConflict("manifest_already_published")

    manifest = validated.manifest
    version = ModelUsagePriceVersion(
        id=create_id("model-usage-price"),
        version_number=next_price_version_number(db),
        status="published",
        effective_from=manifest.effective_from.astimezone(timezone.utc),
        reviewed_at=manifest.reviewed_at.astimezone(timezone.utc),
        source_ref=manifest.source_ref,
        change_note=manifest.change_note,
        operator=command.operator.strip(),
        change_ticket=command.change_ticket.strip(),
        manifest_checksum=validated.checksum,
        model_aliases_json=dict(manifest.model_aliases),
        fx_rates_json={key: str(value) for key, value in manifest.fx_rates.items()},
    )
    db.add(version)
    db.flush()

    for rate in manifest.rates:
        fx = (
            manifest.fx_rates[rate.source_currency]
            if rate.source_currency is not None
            else None
        )
        db.add(
            ModelUsagePriceRate(
                id=create_id("model-usage-rate"),
                price_version_id=version.id,
                provider=rate.provider,
                billing_model=rate.billing_model,
                capability=rate.capability,
                variant_key=rate.variant_key,
                billing_scheme_key=rate.billing_scheme_key,
                meter=rate.meter,
                meter_role=rate.meter_role,
                unit_quantity=rate.unit_quantity,
                unit_price=rate.unit_price,
                source_currency=rate.source_currency,
                fx_to_cny=fx,
                unit_price_cny=_cny_unit_price(rate, manifest.fx_rates),
                reported_model_aliases=_reported_aliases(
                    validated,
                    provider=rate.provider,
                    billing_model=rate.billing_model,
                ),
            )
        )
    db.flush()
    return version


def _canonical_billing_model(
    version: ModelUsagePriceVersion,
    *,
    provider: str,
    billing_model: str,
) -> str:
    return version.model_aliases_json.get(
        f"{provider}:{billing_model}",
        billing_model,
    )


def _required_billable_meters(estimate: UsageEstimate) -> frozenset[ModelUsageMeter]:
    return frozenset(
        line.meter
        for line in estimate.meters
        if line.meter_role is ModelUsageMeterRole.BILLABLE
    )


def _unpriced_snapshot(
    context: UsageContext,
    *,
    required: frozenset[ModelUsageMeter],
) -> UsagePriceSnapshot:
    return UsagePriceSnapshot(
        pricing_status=ModelUsagePricingStatus.UNPRICED,
        price_version_id=None,
        billing_model=context.billing_model,
        billing_scheme_key=None,
        rates=(),
        missing_billable_meters=required,
        checksum=None,
    )


def _snapshot_from_version(
    db: Session,
    *,
    version: ModelUsagePriceVersion,
    context: UsageContext,
    required: frozenset[ModelUsageMeter],
) -> UsagePriceSnapshot:
    billing_model = _canonical_billing_model(
        version,
        provider=context.provider,
        billing_model=context.billing_model,
    )
    rows = price_rates_for_variant(
        db,
        price_version_id=version.id,
        provider=context.provider,
        billing_model=billing_model,
        capability=context.capability,
        variant_key=context.variant_key,
    )
    scheme_keys = {row.billing_scheme_key for row in rows}
    if len(scheme_keys) > 1:
        raise ModelUsageContractError("ambiguous_billing_scheme")
    available = {
        row.meter
        for row in rows
        if row.meter_role is ModelUsageMeterRole.BILLABLE
        and row.unit_price_cny is not None
    }
    missing = required - available
    snapshots = tuple(
        UsagePriceRateSnapshot(
            meter=row.meter,
            meter_role=row.meter_role,
            unit_quantity=row.unit_quantity,
            unit_price=row.unit_price,
            source_currency=row.source_currency,
            fx_to_cny=row.fx_to_cny,
            unit_price_cny=row.unit_price_cny,
        )
        for row in rows
    )
    return UsagePriceSnapshot(
        pricing_status=(
            ModelUsagePricingStatus.UNPRICED
            if missing
            else ModelUsagePricingStatus.PRICED
        ),
        price_version_id=version.id,
        billing_model=billing_model,
        billing_scheme_key=next(iter(scheme_keys), None),
        rates=snapshots,
        missing_billable_meters=frozenset(missing),
        checksum=version.manifest_checksum,
    )


def _family_price_version_is_complete(
    db: Session,
    *,
    version: ModelUsagePriceVersion,
) -> bool:
    """Check full active-config coverage without relying on a mutable pointer."""

    if version.config_revision_id is None:
        return False
    variants = configured_usage_variants(
        db,
        family_id=version.family_id or "",
        config_revision_id=version.config_revision_id,
    )
    for variant in variants:
        rows = price_rates_for_variant(
            db,
            price_version_id=version.id,
            provider=variant.provider,
            billing_model=variant.billing_model,
            capability=variant.capability,
            variant_key=variant.variant_key,
        )
        available = {
            row.meter
            for row in rows
            if row.meter_role is ModelUsageMeterRole.BILLABLE
            and row.billing_scheme_key == variant.billing_scheme_key
            and row.unit_price_cny is not None
        }
        if available != variant.billable_meters:
            return False
    return True


def require_complete_active_price_version(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
    price_version_id: str,
) -> ModelUsagePriceVersion:
    version = get_complete_active_family_price_version(
        db,
        family_id=family_id,
        config_revision_id=config_revision_id,
        price_version_id=price_version_id,
    )
    if version is None:
        raise ModelUsageContractError("family_model_price_version_not_found")
    if not _family_price_version_is_complete(db, version=version):
        raise ModelUsageContractError("family_model_price_incomplete")
    return version


def require_candidate_price_for_search_profile(
    db: Session,
    *,
    family_id: str,
    price_version_id: str,
    search_profile_id: str,
) -> ModelUsagePriceVersion:
    version = get_candidate_search_price_version(
        db,
        family_id=family_id,
        search_profile_id=search_profile_id,
        price_version_id=price_version_id,
    )
    if version is None:
        raise ModelUsageContractError("candidate_price_scope_mismatch")
    return version


def family_price_version_for_context(
    db: Session,
    context: UsageContext,
) -> ModelUsagePriceVersion | None:
    """Resolve a family/candidate price without falling back across scopes."""

    family_id = context.attribution.family_id
    if context.config_revision_id is None:
        if context.explicit_price_version_id is None:
            if context.search_profile_id is not None:
                raise ModelUsageContractError("candidate_price_scope_mismatch")
            return None
        if (
            context.search_profile_id is None
            or context.capability is not ModelUsageCapability.EMBEDDING
        ):
            raise ModelUsageContractError("candidate_price_scope_mismatch")
        return require_candidate_price_for_search_profile(
            db,
            family_id=family_id,
            price_version_id=context.explicit_price_version_id,
            search_profile_id=context.search_profile_id,
        )

    if context.explicit_price_version_id is not None:
        return require_complete_active_price_version(
            db,
            family_id=family_id,
            config_revision_id=context.config_revision_id,
            price_version_id=context.explicit_price_version_id,
        )

    # The current revision is linearized by the same stable settings lock used
    # by price-only publication.  A historical revision intentionally avoids
    # this pointer and instead keeps its own latest complete price version.
    settings = lock_family_model_settings(db, family_id=family_id)
    if settings.active_config_revision_id == context.config_revision_id:
        if settings.active_price_version_id is None:
            return None
        version = get_complete_active_family_price_version(
            db,
            family_id=family_id,
            config_revision_id=context.config_revision_id,
            price_version_id=settings.active_price_version_id,
        )
        if version is None:
            raise ModelUsageContractError("family_model_price_pointer_invalid")
        return version

    for version in list_active_family_price_versions(
        db,
        family_id=family_id,
        config_revision_id=context.config_revision_id,
    ):
        if _family_price_version_is_complete(db, version=version):
            return version
    return None


def lock_active_model_price_snapshot(
    db: Session,
    *,
    family_id: str,
) -> ActiveModelPriceSnapshot:
    """Lock and return the active config/price pair for durable active work."""

    settings = lock_family_model_settings(db, family_id=family_id)
    if (
        settings.active_config_revision_id is None
        or settings.active_price_version_id is None
    ):
        raise ModelUsageContractError("family_model_settings_not_configured")
    require_complete_active_price_version(
        db,
        family_id=family_id,
        config_revision_id=settings.active_config_revision_id,
        price_version_id=settings.active_price_version_id,
    )
    return ActiveModelPriceSnapshot(
        family_id=family_id,
        config_revision_id=settings.active_config_revision_id,
        price_version_id=settings.active_price_version_id,
        search_profile_id=settings.active_search_profile_id,
    )


def family_price_coverage(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
    price_version_id: str | None,
    configured_variants: Sequence[ConfiguredUsageVariant],
) -> PriceCoverageReport:
    version = (
        get_complete_active_family_price_version(
            db,
            family_id=family_id,
            config_revision_id=config_revision_id,
            price_version_id=price_version_id,
        )
        if price_version_id is not None
        else None
    )
    rows: list[PriceCoverageRow] = []
    for variant in configured_variants:
        rates = (
            price_rates_for_variant(
                db,
                price_version_id=version.id,
                provider=variant.provider,
                billing_model=variant.billing_model,
                capability=variant.capability,
                variant_key=variant.variant_key,
            )
            if version is not None
            else ()
        )
        available = {
            rate.meter
            for rate in rates
            if rate.meter_role is ModelUsageMeterRole.BILLABLE
            and rate.unit_price_cny is not None
            and rate.billing_scheme_key == variant.billing_scheme_key
        }
        rows.append(
            PriceCoverageRow(
                provider=variant.provider,
                billing_model=variant.billing_model,
                capability=variant.capability.value,
                variant_key=variant.variant_key,
                billing_scheme_key=variant.billing_scheme_key,
                missing_meters=frozenset(variant.billable_meters - available),
            )
        )
    return PriceCoverageReport(
        price_version_id=version.id if version is not None else None,
        rows=tuple(rows),
    )


def select_price_snapshot(
    db: Session,
    context: UsageContext,
    estimate: UsageEstimate,
    *,
    at: datetime,
) -> UsagePriceSnapshot:
    required = _required_billable_meters(estimate)
    if (
        context.config_revision_id is not None
        or context.explicit_price_version_id is not None
        or context.search_profile_id is not None
    ):
        version = family_price_version_for_context(db, context)
    else:
        # Retained only for rows/callers that predate family-managed model
        # settings.  New family contexts must carry an immutable revision.
        version = current_published_version(db, at=at)
    if version is None:
        return _unpriced_snapshot(context, required=required)
    return _snapshot_from_version(
        db,
        version=version,
        context=context,
        required=required,
    )


def price_coverage(
    db: Session,
    *,
    configured_variants: Sequence[ConfiguredUsageVariant],
    at: datetime,
) -> PriceCoverageReport:
    version = current_published_version(db, at=at)
    rows: list[PriceCoverageRow] = []
    for variant in configured_variants:
        rates = (
            price_rates_for_variant(
                db,
                price_version_id=version.id,
                provider=variant.provider,
                billing_model=variant.billing_model,
                capability=variant.capability,
                variant_key=variant.variant_key,
            )
            if version is not None
            else ()
        )
        available = {
            rate.meter
            for rate in rates
            if rate.meter_role is ModelUsageMeterRole.BILLABLE
            and rate.unit_price_cny is not None
            and rate.billing_scheme_key == variant.billing_scheme_key
        }
        rows.append(
            PriceCoverageRow(
                provider=variant.provider,
                billing_model=variant.billing_model,
                capability=variant.capability.value,
                variant_key=variant.variant_key,
                billing_scheme_key=variant.billing_scheme_key,
                missing_meters=frozenset(variant.billable_meters - available),
            )
        )
    return PriceCoverageReport(
        price_version_id=version.id if version is not None else None,
        rows=tuple(rows),
    )


def cancel_price_version(
    db: Session,
    *,
    version_id: str,
    at: datetime,
) -> ModelUsagePriceVersion:
    version = db.scalar(
        select(ModelUsagePriceVersion)
        .where(ModelUsagePriceVersion.id == version_id)
        .with_for_update()
    )
    if version is None:
        raise PriceCatalogConflict("price_version_not_found")
    effective = version.effective_from
    if effective.tzinfo is None:
        effective = effective.replace(tzinfo=timezone.utc)
    if effective <= at.astimezone(timezone.utc):
        raise PriceCatalogConflict("effective_price_version_immutable")
    references = db.scalar(price_version_references_query(version.id)) or 0
    if references:
        raise PriceCatalogConflict("referenced_price_version_immutable")
    if version.status != "published":
        raise PriceCatalogConflict("price_version_not_cancellable")
    version.status = "cancelled"
    version.updated_at = utcnow()
    db.flush()
    return version
