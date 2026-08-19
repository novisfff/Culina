from __future__ import annotations

from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.core.enums import FamilyModelPricePurpose, ModelUsageCapability
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion


def current_published_version(
    db: Session,
    *,
    at: datetime,
) -> ModelUsagePriceVersion | None:
    return db.scalar(
        select(ModelUsagePriceVersion)
        .where(
            ModelUsagePriceVersion.status == "published",
            ModelUsagePriceVersion.effective_from <= at,
        )
        .order_by(
            ModelUsagePriceVersion.effective_from.desc(),
            ModelUsagePriceVersion.version_number.desc(),
        )
        .limit(1)
    )


def get_family_price_version(
    db: Session,
    *,
    family_id: str,
    price_version_id: str,
    for_update: bool = False,
) -> ModelUsagePriceVersion | None:
    statement = select(ModelUsagePriceVersion).where(
        ModelUsagePriceVersion.family_id == family_id,
        ModelUsagePriceVersion.id == price_version_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def get_complete_active_family_price_version(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
    price_version_id: str,
) -> ModelUsagePriceVersion | None:
    return db.scalar(
        select(ModelUsagePriceVersion).where(
            ModelUsagePriceVersion.id == price_version_id,
            ModelUsagePriceVersion.family_id == family_id,
            ModelUsagePriceVersion.config_revision_id == config_revision_id,
            ModelUsagePriceVersion.search_profile_id.is_(None),
            ModelUsagePriceVersion.purpose == FamilyModelPricePurpose.ACTIVE,
            ModelUsagePriceVersion.status == "published",
        )
    )


def list_active_family_price_versions(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
) -> tuple[ModelUsagePriceVersion, ...]:
    """Newest immutable active prices for a particular config revision first."""

    return tuple(
        db.scalars(
            select(ModelUsagePriceVersion)
            .where(
                ModelUsagePriceVersion.family_id == family_id,
                ModelUsagePriceVersion.config_revision_id == config_revision_id,
                ModelUsagePriceVersion.search_profile_id.is_(None),
                ModelUsagePriceVersion.purpose == FamilyModelPricePurpose.ACTIVE,
                ModelUsagePriceVersion.status == "published",
            )
            .order_by(
                ModelUsagePriceVersion.version_number.desc(),
                ModelUsagePriceVersion.id.desc(),
            )
        )
    )


def get_candidate_search_price_version(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    price_version_id: str,
) -> ModelUsagePriceVersion | None:
    return db.scalar(
        select(ModelUsagePriceVersion).where(
            ModelUsagePriceVersion.id == price_version_id,
            ModelUsagePriceVersion.family_id == family_id,
            ModelUsagePriceVersion.config_revision_id.is_(None),
            ModelUsagePriceVersion.search_profile_id == search_profile_id,
            ModelUsagePriceVersion.purpose
            == FamilyModelPricePurpose.SEARCH_REBUILD_CANDIDATE,
            ModelUsagePriceVersion.status == "published",
        )
    )


def list_family_price_versions(
    db: Session,
    *,
    family_id: str,
    limit: int | None = None,
) -> tuple[ModelUsagePriceVersion, ...]:
    statement = (
        select(ModelUsagePriceVersion)
        .where(ModelUsagePriceVersion.family_id == family_id)
        .order_by(
            ModelUsagePriceVersion.version_number.desc(),
            ModelUsagePriceVersion.id.desc(),
        )
    )
    if limit is not None:
        statement = statement.limit(limit)
    return tuple(db.scalars(statement))


def price_rates_for_variant(
    db: Session,
    *,
    price_version_id: str,
    provider: str,
    billing_model: str,
    capability: ModelUsageCapability,
    variant_key: str,
) -> tuple[ModelUsagePriceRate, ...]:
    return tuple(
        db.scalars(
            select(ModelUsagePriceRate)
            .where(
                ModelUsagePriceRate.price_version_id == price_version_id,
                ModelUsagePriceRate.provider == provider,
                ModelUsagePriceRate.billing_model == billing_model,
                ModelUsagePriceRate.capability == capability,
                ModelUsagePriceRate.variant_key == variant_key,
            )
            .order_by(ModelUsagePriceRate.billing_scheme_key, ModelUsagePriceRate.meter)
        ).all()
    )


def next_price_version_number(db: Session) -> int:
    current = db.scalar(
        select(ModelUsagePriceVersion.version_number)
        .order_by(ModelUsagePriceVersion.version_number.desc())
        .with_for_update()
        .limit(1)
    )
    return int(current or 0) + 1


def published_checksum_exists(db: Session, *, checksum: str) -> bool:
    return (
        db.scalar(
            select(func.count())
            .select_from(ModelUsagePriceVersion)
            .where(ModelUsagePriceVersion.manifest_checksum == checksum)
        )
        or 0
    ) > 0


def price_version_references_query(version_id: str) -> Select[tuple[int]]:
    from app.models.model_usage import ModelUsageEvent, ModelUsageReservation

    reservation_count = (
        select(func.count())
        .select_from(ModelUsageReservation)
        .where(ModelUsageReservation.price_version_id == version_id)
        .scalar_subquery()
    )
    event_count = (
        select(func.count())
        .select_from(ModelUsageEvent)
        .where(ModelUsageEvent.price_version_id == version_id)
        .scalar_subquery()
    )
    return select(reservation_count + event_count)
