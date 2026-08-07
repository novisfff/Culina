from __future__ import annotations

import secrets
from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageSubjectKind
from app.core.utils import create_id
from app.models.domain import Family
from app.models.model_usage import ModelUsageSubject


SYSTEM_DIMENSION_KEY = "system"


def new_subject_key() -> str:
    return f"mus_{secrets.token_urlsafe(24)}"


def new_user_dimension_key() -> str:
    return f"user:{secrets.token_urlsafe(24)}"


def lock_family_subjects(db: Session, *, family_id: str) -> None:
    family = db.scalar(
        select(Family).where(Family.id == family_id).with_for_update()
    )
    if family is None:
        raise ValueError("model_usage_family_not_found")


def find_user_subject(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    for_update: bool = False,
) -> ModelUsageSubject | None:
    statement = select(ModelUsageSubject).where(
        ModelUsageSubject.family_id == family_id,
        ModelUsageSubject.user_id == user_id,
        ModelUsageSubject.subject_kind == ModelUsageSubjectKind.USER,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def find_dimension_subject(
    db: Session,
    *,
    family_id: str,
    dimension_key: str,
    for_update: bool = False,
) -> ModelUsageSubject | None:
    statement = select(ModelUsageSubject).where(
        ModelUsageSubject.family_id == family_id,
        ModelUsageSubject.dimension_key == dimension_key,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def _claim_subject(
    db: Session,
    *,
    candidate: ModelUsageSubject,
    winner_loader: Callable[[], ModelUsageSubject | None],
) -> ModelUsageSubject:
    savepoint = db.begin_nested()
    try:
        db.add(candidate)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        winner = winner_loader()
        if winner is None:
            raise
        return winner
    else:
        savepoint.commit()
        return candidate


def create_user_subject(
    db: Session,
    *,
    family_id: str,
    user_id: str,
) -> ModelUsageSubject:
    lock_family_subjects(db, family_id=family_id)
    existing = find_user_subject(
        db,
        family_id=family_id,
        user_id=user_id,
        for_update=True,
    )
    if existing is not None:
        return existing
    candidate = ModelUsageSubject(
        id=create_id("usage-subject"),
        family_id=family_id,
        user_id=user_id,
        dimension_key=new_user_dimension_key(),
        subject_key=new_subject_key(),
        anonymized_label=None,
        subject_kind=ModelUsageSubjectKind.USER,
    )
    return _claim_subject(
        db,
        candidate=candidate,
        winner_loader=lambda: find_user_subject(
            db,
            family_id=family_id,
            user_id=user_id,
            for_update=True,
        ),
    )


def create_system_subject(db: Session, *, family_id: str) -> ModelUsageSubject:
    lock_family_subjects(db, family_id=family_id)
    existing = find_dimension_subject(
        db,
        family_id=family_id,
        dimension_key=SYSTEM_DIMENSION_KEY,
        for_update=True,
    )
    if existing is not None:
        if existing.subject_kind is not ModelUsageSubjectKind.SYSTEM:
            raise ValueError("model_usage_system_subject_conflict")
        return existing
    candidate = ModelUsageSubject(
        id=create_id("usage-subject"),
        family_id=family_id,
        user_id=None,
        dimension_key=SYSTEM_DIMENSION_KEY,
        subject_key=new_subject_key(),
        anonymized_label=None,
        subject_kind=ModelUsageSubjectKind.SYSTEM,
    )
    return _claim_subject(
        db,
        candidate=candidate,
        winner_loader=lambda: find_dimension_subject(
            db,
            family_id=family_id,
            dimension_key=SYSTEM_DIMENSION_KEY,
            for_update=True,
        ),
    )


def lock_subjects_for_unlink(
    db: Session,
    *,
    user_id: str,
) -> tuple[ModelUsageSubject, ...]:
    family_ids = tuple(
        db.scalars(
            select(ModelUsageSubject.family_id)
            .where(
                ModelUsageSubject.user_id == user_id,
                ModelUsageSubject.subject_kind == ModelUsageSubjectKind.USER,
            )
            .distinct()
            .order_by(ModelUsageSubject.family_id)
        )
    )
    if family_ids:
        tuple(
            db.scalars(
                select(Family)
                .where(Family.id.in_(family_ids))
                .order_by(Family.id)
                .with_for_update()
            )
        )
    return tuple(
        db.scalars(
            select(ModelUsageSubject)
            .where(
                ModelUsageSubject.user_id == user_id,
                ModelUsageSubject.subject_kind == ModelUsageSubjectKind.USER,
            )
            .order_by(ModelUsageSubject.family_id, ModelUsageSubject.id)
            .with_for_update()
        )
    )


def lock_all_family_subjects(
    db: Session,
    *,
    family_id: str,
) -> tuple[ModelUsageSubject, ...]:
    lock_family_subjects(db, family_id=family_id)
    return tuple(
        db.scalars(
            select(ModelUsageSubject)
            .where(ModelUsageSubject.family_id == family_id)
            .order_by(ModelUsageSubject.id)
            .with_for_update()
        )
    )
