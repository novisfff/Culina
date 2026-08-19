from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import FamilyModelConfigRevisionStatus
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigDraft,
    FamilyModelConfigRevision,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.services.family_model_settings.errors import (
    FamilyModelConfigDraftNotFound,
    FamilyModelSettingsVersionConflict,
)


def get_config_draft(
    db: Session,
    *,
    family_id: str,
    for_update: bool = False,
) -> FamilyModelConfigDraft | None:
    statement = select(FamilyModelConfigDraft).where(
        FamilyModelConfigDraft.family_id == family_id
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def require_config_draft(
    db: Session,
    *,
    family_id: str,
    for_update: bool = False,
) -> FamilyModelConfigDraft:
    draft = get_config_draft(db, family_id=family_id, for_update=for_update)
    if draft is None:
        raise FamilyModelConfigDraftNotFound()
    return draft


def lock_config_draft(db: Session, *, family_id: str) -> FamilyModelConfigDraft:
    return require_config_draft(db, family_id=family_id, for_update=True)


def require_draft_version(
    draft: FamilyModelConfigDraft,
    expected_version_number: int,
) -> None:
    if draft.draft_version_number != expected_version_number:
        raise FamilyModelSettingsVersionConflict(
            current_draft_version_number=draft.draft_version_number
        )


def get_config_revision(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
    for_update: bool = False,
) -> FamilyModelConfigRevision | None:
    statement = select(FamilyModelConfigRevision).where(
        FamilyModelConfigRevision.family_id == family_id,
        FamilyModelConfigRevision.id == config_revision_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def list_config_revisions(
    db: Session,
    *,
    family_id: str,
    statuses: Sequence[FamilyModelConfigRevisionStatus] | None = None,
) -> tuple[FamilyModelConfigRevision, ...]:
    statement = select(FamilyModelConfigRevision).where(
        FamilyModelConfigRevision.family_id == family_id
    )
    if statuses is not None:
        statement = statement.where(FamilyModelConfigRevision.status.in_(statuses))
    return tuple(
        db.scalars(
            statement.order_by(
                FamilyModelConfigRevision.version_number.desc(),
                FamilyModelConfigRevision.id.desc(),
            )
        )
    )


def get_capability_binding(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
    capability: str,
    variant_key: str,
    for_update: bool = False,
) -> FamilyModelCapabilityBinding | None:
    statement = select(FamilyModelCapabilityBinding).where(
        FamilyModelCapabilityBinding.family_id == family_id,
        FamilyModelCapabilityBinding.config_revision_id == config_revision_id,
        FamilyModelCapabilityBinding.capability == capability,
        FamilyModelCapabilityBinding.variant_key == variant_key,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def list_capability_bindings(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
    enabled_only: bool = False,
) -> tuple[FamilyModelCapabilityBinding, ...]:
    statement = select(FamilyModelCapabilityBinding).where(
        FamilyModelCapabilityBinding.family_id == family_id,
        FamilyModelCapabilityBinding.config_revision_id == config_revision_id,
    )
    if enabled_only:
        statement = statement.where(FamilyModelCapabilityBinding.enabled.is_(True))
    return tuple(
        db.scalars(
            statement.order_by(
                FamilyModelCapabilityBinding.capability,
                FamilyModelCapabilityBinding.variant_key,
            )
        )
    )


def list_enabled_bindings(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
) -> tuple[FamilyModelCapabilityBinding, ...]:
    """Return the enabled bindings of one family-owned immutable revision."""

    return list_capability_bindings(
        db,
        family_id=family_id,
        config_revision_id=config_revision_id,
        enabled_only=True,
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


def get_search_profile(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str,
    for_update: bool = False,
) -> FamilySearchProfile | None:
    statement = select(FamilySearchProfile).where(
        FamilySearchProfile.family_id == family_id,
        FamilySearchProfile.id == search_profile_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def get_search_profile_by_identity(
    db: Session,
    *,
    family_id: str,
    index_identity_checksum: str,
    for_update: bool = False,
) -> FamilySearchProfile | None:
    statement = select(FamilySearchProfile).where(
        FamilySearchProfile.family_id == family_id,
        FamilySearchProfile.index_identity_checksum == index_identity_checksum,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)
