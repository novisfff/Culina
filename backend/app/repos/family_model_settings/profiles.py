from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.family_model_settings import (
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSecretVersion,
    FamilyModelSettings,
)
from app.services.family_model_settings.errors import (
    FamilyModelProviderProfileNotFound,
    FamilyModelSettingsError,
    FamilyModelSettingsVersionConflict,
)


def get_family_model_settings(
    db: Session,
    *,
    family_id: str,
    for_update: bool = False,
) -> FamilyModelSettings | None:
    statement = select(FamilyModelSettings).where(FamilyModelSettings.family_id == family_id)
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def lock_family_model_settings(db: Session, *, family_id: str) -> FamilyModelSettings:
    settings = get_family_model_settings(db, family_id=family_id, for_update=True)
    if settings is None:
        raise FamilyModelSettingsError("family_model_settings_not_found")
    return settings


def require_settings_version(settings: FamilyModelSettings, expected_version: int) -> None:
    if settings.version_number != expected_version:
        raise FamilyModelSettingsVersionConflict(
            current_settings_version_number=settings.version_number,
            current_config_revision_id=settings.active_config_revision_id,
        )


def get_provider_profile(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    for_update: bool = False,
) -> FamilyModelProviderProfile | None:
    statement = select(FamilyModelProviderProfile).where(
        FamilyModelProviderProfile.family_id == family_id,
        FamilyModelProviderProfile.id == profile_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def require_provider_profile(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    for_update: bool = False,
) -> FamilyModelProviderProfile:
    profile = get_provider_profile(
        db,
        family_id=family_id,
        profile_id=profile_id,
        for_update=for_update,
    )
    if profile is None:
        raise FamilyModelProviderProfileNotFound()
    return profile


def lock_provider_profile(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
) -> FamilyModelProviderProfile:
    return require_provider_profile(
        db,
        family_id=family_id,
        profile_id=profile_id,
        for_update=True,
    )


def list_provider_profiles(
    db: Session,
    *,
    family_id: str,
) -> tuple[FamilyModelProviderProfile, ...]:
    return tuple(
        db.scalars(
            select(FamilyModelProviderProfile)
            .where(FamilyModelProviderProfile.family_id == family_id)
            .order_by(
                FamilyModelProviderProfile.created_at.asc(),
                FamilyModelProviderProfile.id.asc(),
            )
        )
    )


def get_provider_profile_version(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    profile_version_id: str,
    for_update: bool = False,
) -> FamilyModelProviderProfileVersion | None:
    statement = select(FamilyModelProviderProfileVersion).where(
        FamilyModelProviderProfileVersion.family_id == family_id,
        FamilyModelProviderProfileVersion.profile_id == profile_id,
        FamilyModelProviderProfileVersion.id == profile_version_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def get_current_provider_profile_version(
    db: Session,
    *,
    family_id: str,
    profile: FamilyModelProviderProfile,
    for_update: bool = False,
) -> FamilyModelProviderProfileVersion | None:
    if profile.current_profile_version_id is None:
        return None
    return get_provider_profile_version(
        db,
        family_id=family_id,
        profile_id=profile.id,
        profile_version_id=profile.current_profile_version_id,
        for_update=for_update,
    )


def get_provider_secret_version(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
    secret_version_id: str,
    for_update: bool = False,
) -> FamilyModelSecretVersion | None:
    statement = select(FamilyModelSecretVersion).where(
        FamilyModelSecretVersion.family_id == family_id,
        FamilyModelSecretVersion.profile_id == profile_id,
        FamilyModelSecretVersion.id == secret_version_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def get_current_provider_secret_version(
    db: Session,
    *,
    family_id: str,
    profile: FamilyModelProviderProfile,
    for_update: bool = False,
) -> FamilyModelSecretVersion | None:
    if profile.current_secret_version_id is None:
        return None
    return get_provider_secret_version(
        db,
        family_id=family_id,
        profile_id=profile.id,
        secret_version_id=profile.current_secret_version_id,
        for_update=for_update,
    )
