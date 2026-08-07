from __future__ import annotations

import json
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageOperationSource,
    ModelUsagePricingStatus,
    ModelUsageQuantitySource,
)
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.services.model_usage.pricing import (
    PriceCatalogConflict,
    PublishPriceCommand,
    cancel_price_version,
    price_coverage,
    publish_price_manifest,
    select_price_snapshot,
)
from app.services.model_usage.types import (
    UsageAttribution,
    UsageContext,
    UsageEstimate,
    UsageMeterQuantity,
)
from tests.model_usage.test_price_manifest import configured_test_variants


FIXTURE = Path(__file__).parent / "fixtures" / "prices_valid.json"
AT = datetime(2026, 7, 30, 1, 0, tzinfo=timezone.utc)


def raw_manifest() -> dict[str, object]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def publish(
    db: Session,
    raw: dict[str, object],
    *,
    confirm_checksum: str | None = None,
    configured=True,
) -> ModelUsagePriceVersion:
    from app.services.model_usage.pricing_manifest import validate_price_manifest

    variants = configured_test_variants() if configured else ()
    validated = validate_price_manifest(raw, configured_variants=variants)
    version = publish_price_manifest(
        db,
        PublishPriceCommand(
            manifest=raw,
            configured_variants=variants,
            operator="release-owner",
            change_ticket="CULINA-PRICE-1",
            confirm_checksum=confirm_checksum or validated.checksum,
        ),
    )
    db.commit()
    return version


def llm_context(*, billing_model: str = "gpt-test") -> UsageContext:
    return UsageContext(
        attribution=UsageAttribution(
            family_id="family-a",
            attribution_kind=ModelUsageAttributionKind.SYSTEM,
            actor_user_id=None,
            operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
            logical_operation_id="pricing-test",
        ),
        capability=ModelUsageCapability.LLM,
        provider="openai",
        requested_model=billing_model,
        billing_model=billing_model,
        variant_key="default",
        operation_kind="test",
        attempt_key="pricing-attempt",
        client_attempt_id="mua-pricing-test",
    )


def llm_estimate(*, include_request_units: bool = False) -> UsageEstimate:
    meters = [
        UsageMeterQuantity(
            meter=meter,
            quantity=Decimal("10"),
            meter_role=ModelUsageMeterRole.BILLABLE,
            quantity_source=ModelUsageQuantitySource.ESTIMATED,
        )
        for meter in (
            ModelUsageMeter.UNCACHED_INPUT_TOKENS,
            ModelUsageMeter.CACHED_INPUT_TOKENS,
            ModelUsageMeter.OUTPUT_TOKENS,
        )
    ]
    if include_request_units:
        meters.append(
            UsageMeterQuantity(
                meter=ModelUsageMeter.REQUEST_UNITS,
                quantity=Decimal("1"),
                meter_role=ModelUsageMeterRole.BILLABLE,
                quantity_source=ModelUsageQuantitySource.ESTIMATED,
            )
        )
    return UsageEstimate(meters=meters)


def test_publish_persists_immutable_version_and_cny_rates(model_usage_db: Session) -> None:
    version = publish(model_usage_db, raw_manifest())

    assert version.status == "published"
    assert version.version_number == 1
    assert len(version.manifest_checksum) == 64
    output = model_usage_db.scalar(
        select(ModelUsagePriceRate).where(
            ModelUsagePriceRate.price_version_id == version.id,
            ModelUsagePriceRate.meter == ModelUsageMeter.OUTPUT_TOKENS,
        )
    )
    assert output is not None
    assert output.unit_price_cny == Decimal("14.400000000000")


def test_settlement_keeps_reservation_snapshot_after_new_publish(
    model_usage_db: Session,
) -> None:
    first = publish(model_usage_db, raw_manifest())
    snapshot = select_price_snapshot(model_usage_db, llm_context(), llm_estimate(), at=AT)

    second_raw = raw_manifest()
    second_raw["catalogVersion"] = "test-v2"
    second_raw["effectiveFrom"] = "2026-07-30T02:00:00Z"
    second_raw["rates"][2]["unitPrice"] = "9.000000000000"  # type: ignore[index]
    publish(model_usage_db, second_raw)

    assert snapshot.price_version_id == first.id
    assert snapshot.rate_for(ModelUsageMeter.OUTPUT_TOKENS).unit_price == Decimal(
        "2.000000000000"
    )
    still_first = select_price_snapshot(model_usage_db, llm_context(), llm_estimate(), at=AT)
    assert still_first.price_version_id == first.id


def test_alias_mapping_selects_exact_canonical_model(model_usage_db: Session) -> None:
    publish(model_usage_db, raw_manifest())

    snapshot = select_price_snapshot(
        model_usage_db,
        llm_context(billing_model="gpt-test-2026-07-01"),
        llm_estimate(),
        at=AT,
    )

    assert snapshot.pricing_status is ModelUsagePricingStatus.PRICED
    assert snapshot.billing_model == "gpt-test"


def test_missing_billable_rate_returns_partial_unpriced_snapshot(
    model_usage_db: Session,
) -> None:
    raw = raw_manifest()
    raw["rates"] = raw["rates"][:2]  # type: ignore[index]
    publish(model_usage_db, raw, configured=False)

    snapshot = select_price_snapshot(
        model_usage_db,
        llm_context(),
        llm_estimate(),
        at=AT,
    )

    assert snapshot.pricing_status is ModelUsagePricingStatus.UNPRICED
    assert snapshot.price_version_id is not None
    assert snapshot.missing_billable_meters == frozenset(
        {ModelUsageMeter.OUTPUT_TOKENS}
    )
    assert snapshot.rate_for(ModelUsageMeter.UNCACHED_INPUT_TOKENS).unit_price is not None


def test_publish_requires_matching_confirmation_checksum(model_usage_db: Session) -> None:
    with pytest.raises(PriceCatalogConflict, match="checksum_mismatch"):
        publish(model_usage_db, raw_manifest(), confirm_checksum="0" * 64)


def test_publish_rejects_duplicate_manifest_checksum(model_usage_db: Session) -> None:
    publish(model_usage_db, raw_manifest())
    with pytest.raises(PriceCatalogConflict, match="manifest_already_published"):
        publish(model_usage_db, raw_manifest())


def test_cancel_rejects_effective_or_referenced_version(model_usage_db: Session) -> None:
    version = publish(model_usage_db, raw_manifest())
    with pytest.raises(PriceCatalogConflict, match="effective_price_version_immutable"):
        cancel_price_version(model_usage_db, version_id=version.id, at=AT)


def test_coverage_reports_every_configured_variant(model_usage_db: Session) -> None:
    publish(model_usage_db, raw_manifest())
    report = price_coverage(
        model_usage_db,
        configured_variants=configured_test_variants(),
        at=AT,
    )

    assert report.healthy is True
    assert len(report.rows) == 7
    assert all(row.missing_meters == frozenset() for row in report.rows)
