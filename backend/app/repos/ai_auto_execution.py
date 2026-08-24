from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import AIAutoExecutionPreference, AIFamilyAutoExecutionPolicy


def get_member_preference(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    action_key: str,
    for_update: bool = False,
) -> AIAutoExecutionPreference | None:
    statement = select(AIAutoExecutionPreference).where(
        AIAutoExecutionPreference.family_id == family_id,
        AIAutoExecutionPreference.user_id == user_id,
        AIAutoExecutionPreference.action_key == action_key,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def list_member_preferences(
    db: Session,
    *,
    family_id: str,
    user_id: str,
) -> tuple[AIAutoExecutionPreference, ...]:
    return tuple(db.scalars(select(AIAutoExecutionPreference).where(
        AIAutoExecutionPreference.family_id == family_id,
        AIAutoExecutionPreference.user_id == user_id,
    )))


def get_family_policy(
    db: Session,
    *,
    family_id: str,
    action_key: str,
    for_update: bool = False,
) -> AIFamilyAutoExecutionPolicy | None:
    statement = select(AIFamilyAutoExecutionPolicy).where(
        AIFamilyAutoExecutionPolicy.family_id == family_id,
        AIFamilyAutoExecutionPolicy.action_key == action_key,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def list_family_policies(
    db: Session,
    *,
    family_id: str,
) -> tuple[AIFamilyAutoExecutionPolicy, ...]:
    return tuple(db.scalars(select(AIFamilyAutoExecutionPolicy).where(
        AIFamilyAutoExecutionPolicy.family_id == family_id,
    )))
