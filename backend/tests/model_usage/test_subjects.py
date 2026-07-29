from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageAttributionKind
from app.models.domain import Family, User
from app.models.model_usage import ModelUsageSubject
from app.services.model_usage.subjects import (
    ensure_system_subject,
    ensure_user_subject,
    resolve_subject,
    unlink_user_subjects,
)
from app.services.model_usage.types import UsageAttribution
from app.core.enums import ModelUsageOperationSource


@pytest.fixture()
def subject_families(model_usage_db: Session) -> tuple[Family, Family, User, User]:
    first_family = Family(id="family-a", name="甲家庭", motto="", location="")
    second_family = Family(id="family-b", name="乙家庭", motto="", location="")
    first_user = User(
        id="user-a",
        username="user-a",
        display_name="甲",
        avatar_seed="甲",
        is_active=True,
    )
    second_user = User(
        id="user-b",
        username="user-b",
        display_name="乙",
        avatar_seed="乙",
        is_active=True,
    )
    model_usage_db.add_all([first_family, second_family, first_user, second_user])
    model_usage_db.flush()
    return first_family, second_family, first_user, second_user


def test_user_subject_reuses_family_identity_without_leaking_user_id(
    model_usage_db: Session,
    subject_families: tuple[Family, Family, User, User],
) -> None:
    first = ensure_user_subject(model_usage_db, family_id="family-a", user_id="user-a")
    second = ensure_user_subject(model_usage_db, family_id="family-a", user_id="user-a")
    other = ensure_user_subject(model_usage_db, family_id="family-b", user_id="user-a")

    assert first.id == second.id
    assert first.subject_key != other.subject_key
    assert first.dimension_key != other.dimension_key
    assert first.subject_key != first.dimension_key
    assert "user-a" not in first.subject_key
    assert "user-a" not in first.dimension_key


def test_exactly_one_system_subject_is_reused(
    model_usage_db: Session,
    subject_families: tuple[Family, Family, User, User],
) -> None:
    first = ensure_system_subject(model_usage_db, family_id="family-a")
    second = ensure_system_subject(model_usage_db, family_id="family-a")

    assert first.id == second.id
    assert first.user_id is None
    assert model_usage_db.query(ModelUsageSubject).filter_by(family_id="family-a").count() == 1


def test_resolve_subject_uses_trusted_attribution_kind(
    model_usage_db: Session,
    subject_families: tuple[Family, Family, User, User],
) -> None:
    user_subject = resolve_subject(
        model_usage_db,
        UsageAttribution(
            family_id="family-a",
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id="user-a",
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id="operation-a",
        ),
    )
    system_subject = resolve_subject(
        model_usage_db,
        UsageAttribution(
            family_id="family-a",
            attribution_kind=ModelUsageAttributionKind.SYSTEM,
            actor_user_id=None,
            operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
            logical_operation_id="operation-b",
        ),
    )

    assert user_subject.user_id == "user-a"
    assert system_subject.user_id is None
    assert user_subject.id != system_subject.id


def test_unlink_keeps_deleted_subjects_distinct(
    model_usage_db: Session,
    subject_families: tuple[Family, Family, User, User],
) -> None:
    first = ensure_user_subject(model_usage_db, family_id="family-a", user_id="user-a")
    second = ensure_user_subject(model_usage_db, family_id="family-a", user_id="user-b")

    unlink_user_subjects(model_usage_db, user_id="user-a")
    unlink_user_subjects(model_usage_db, user_id="user-b")

    assert first.user_id is None and second.user_id is None
    assert first.subject_key != second.subject_key
    assert {first.anonymized_label, second.anonymized_label} == {
        "已删除成员 1",
        "已删除成员 2",
    }
    assert first.unlinked_at is not None and second.unlinked_at is not None


def test_unlink_allocates_labels_independently_per_family(
    model_usage_db: Session,
    subject_families: tuple[Family, Family, User, User],
) -> None:
    first = ensure_user_subject(model_usage_db, family_id="family-a", user_id="user-a")
    second = ensure_user_subject(model_usage_db, family_id="family-b", user_id="user-a")

    unlinked = unlink_user_subjects(model_usage_db, user_id="user-a")

    assert [item.id for item in unlinked] == sorted([first.id, second.id])
    assert first.anonymized_label == "已删除成员 1"
    assert second.anonymized_label == "已删除成员 1"


def test_every_user_delete_unlinks_model_usage_subjects_first() -> None:
    for source_path in Path("app").rglob("*.py"):
        source = source_path.read_text()
        if "db.delete(user)" not in source:
            continue
        assert "unlink_user_subjects(db, user_id=user.id)" in source
        assert source.index("unlink_user_subjects(db, user_id=user.id)") < source.index(
            "db.delete(user)"
        )


def test_subject_dimension_lookup_remains_unique_after_unlink(
    model_usage_db: Session,
    subject_families: tuple[Family, Family, User, User],
) -> None:
    subject = ensure_user_subject(model_usage_db, family_id="family-a", user_id="user-a")
    dimension_key = subject.dimension_key
    unlink_user_subjects(model_usage_db, user_id="user-a")

    loaded = model_usage_db.scalar(
        select(ModelUsageSubject).where(
            ModelUsageSubject.family_id == "family-a",
            ModelUsageSubject.dimension_key == dimension_key,
        )
    )
    assert loaded is subject
