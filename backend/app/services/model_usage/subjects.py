from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageAttributionKind, ModelUsageSubjectKind
from app.core.utils import utcnow
from app.models.model_usage import ModelUsageSubject
from app.repos.model_usage.identity import (
    create_system_subject,
    create_user_subject,
    find_dimension_subject,
    find_user_subject,
    lock_all_family_subjects,
    lock_subjects_for_unlink,
)
from app.services.model_usage.types import UsageAttribution


_DELETED_LABEL = re.compile(r"^已删除成员 (\d+)$")


def ensure_user_subject(
    db: Session,
    *,
    family_id: str,
    user_id: str,
) -> ModelUsageSubject:
    existing = find_user_subject(db, family_id=family_id, user_id=user_id)
    if existing is not None:
        return existing
    return create_user_subject(db, family_id=family_id, user_id=user_id)


def ensure_system_subject(db: Session, *, family_id: str) -> ModelUsageSubject:
    existing = find_dimension_subject(
        db,
        family_id=family_id,
        dimension_key="system",
    )
    if existing is not None:
        if existing.subject_kind is not ModelUsageSubjectKind.SYSTEM:
            raise ValueError("model_usage_system_subject_conflict")
        return existing
    return create_system_subject(db, family_id=family_id)


def resolve_subject(
    db: Session,
    attribution: UsageAttribution,
) -> ModelUsageSubject:
    if attribution.attribution_kind is ModelUsageAttributionKind.USER:
        assert attribution.actor_user_id is not None
        return ensure_user_subject(
            db,
            family_id=attribution.family_id,
            user_id=attribution.actor_user_id,
        )
    return ensure_system_subject(db, family_id=attribution.family_id)


def require_family_subject(
    db: Session,
    *,
    family_id: str,
    subject_id: str,
) -> ModelUsageSubject:
    subject = db.scalar(
        select(ModelUsageSubject).where(
            ModelUsageSubject.id == subject_id,
            ModelUsageSubject.family_id == family_id,
        )
    )
    if subject is None:
        raise ValueError("model_usage_subject_not_found")
    return subject


def _next_deleted_label(subjects: tuple[ModelUsageSubject, ...]) -> str:
    used = {
        int(match.group(1))
        for subject in subjects
        if subject.anonymized_label
        if (match := _DELETED_LABEL.fullmatch(subject.anonymized_label))
    }
    candidate = 1
    while candidate in used:
        candidate += 1
    return f"已删除成员 {candidate}"


def unlink_user_subjects(
    db: Session,
    *,
    user_id: str,
) -> list[ModelUsageSubject]:
    subjects = lock_subjects_for_unlink(db, user_id=user_id)
    for subject in subjects:
        family_subjects = lock_all_family_subjects(db, family_id=subject.family_id)
        subject.anonymized_label = _next_deleted_label(family_subjects)
        subject.user_id = None
        subject.unlinked_at = utcnow()
        db.flush()
    return sorted(subjects, key=lambda item: item.id)
