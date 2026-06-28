from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, MediaSource, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import ActivityLog, Base, Family, MediaAsset, Membership, User, UserCredential
from tests._transaction_failure import fail_next_commit


@dataclass(frozen=True)
class FamilyApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    use_auth: Callable[[str, str], None]
    family_id: str
    other_family_id: str
    owner_id: str
    member_id: str
    other_user_id: str
    family_media_id: str
    owner_membership_id: str
    member_membership_id: str
    other_membership_id: str


@pytest.fixture()
def family_api_context() -> Iterator[FamilyApiContext]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )

    with SessionLocal() as db:
        family = Family(id="family-main", name="主家庭", motto="认真吃饭", location="上海", created_by="owner-main", updated_by="owner-main")
        other_family = Family(id="family-other", name="其他家庭", motto="", location="北京", created_by="owner-other", updated_by="owner-other")
        owner = User(id="owner-main", username="owner-main", display_name="主理人", avatar_seed="主理人", is_active=True)
        member = User(id="member-main", username="member-main", display_name="家庭成员", avatar_seed="家庭成员", is_active=True)
        other_user = User(id="owner-other", username="owner-other", display_name="其他家庭主理人", avatar_seed="其他", is_active=True)
        family_media = MediaAsset(
            id="photo-family",
            family_id=family.id,
            name="family.png",
            url="/media/family-main/family.png",
            file_path="family-main/family.png",
            source=MediaSource.UPLOAD,
            alt="家庭照片",
            created_by=owner.id,
        )
        owner_membership = Membership(
            id="membership-owner-main",
            family_id=family.id,
            user_id=owner.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        member_membership = Membership(
            id="membership-member-main",
            family_id=family.id,
            user_id=member.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-owner-other",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        db.add_all([family, other_family, owner, member, other_user, family_media, owner_membership, member_membership, other_membership])
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db

    def use_auth(user_id: str, membership_id: str) -> None:
        def override_auth(db: Session = Depends(get_db)) -> tuple[User, Membership]:
            user = db.get(User, user_id)
            membership = db.get(Membership, membership_id)
            assert user is not None
            assert membership is not None
            return user, membership

        app.dependency_overrides[get_current_auth] = override_auth

    use_auth("owner-main", "membership-owner-main")

    try:
        yield FamilyApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            use_auth=use_auth,
            family_id="family-main",
            other_family_id="family-other",
            owner_id="owner-main",
            member_id="member-main",
            other_user_id="owner-other",
            family_media_id="photo-family",
            owner_membership_id="membership-owner-main",
            member_membership_id="membership-member-main",
            other_membership_id="membership-owner-other",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_get_family_returns_current_family(family_api_context: FamilyApiContext) -> None:
    response = family_api_context.client.get("/api/family")

    assert response.status_code == 200
    payload = response.json()
    assert payload["id"] == family_api_context.family_id
    assert payload["name"] == "主家庭"


def test_list_members_returns_only_current_family_members(family_api_context: FamilyApiContext) -> None:
    response = family_api_context.client.get("/api/members")

    assert response.status_code == 200
    ids = {item["id"] for item in response.json()}
    assert ids == {family_api_context.owner_id, family_api_context.member_id}
    assert family_api_context.other_user_id not in ids


def test_update_family_requires_owner_and_does_not_mutate_for_member(family_api_context: FamilyApiContext) -> None:
    family_api_context.use_auth(family_api_context.member_id, family_api_context.member_membership_id)

    response = family_api_context.client.patch(
        "/api/family",
        json={"name": "成员不能改", "motto": "", "location": ""},
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Owner permission required"

    with family_api_context.SessionLocal() as db:
        family = db.get(Family, family_api_context.family_id)
        assert family is not None
        assert family.name == "主家庭"
        assert family.updated_by == family_api_context.owner_id
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "更新家庭信息 成员不能改")) is None


def test_update_family_sets_audit_fields_and_activity_log(family_api_context: FamilyApiContext) -> None:
    response = family_api_context.client.patch(
        "/api/family",
        json={"name": "新的家庭", "motto": "好好吃饭", "location": "杭州"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["id"] == family_api_context.family_id
    assert payload["name"] == "新的家庭"
    assert payload["motto"] == "好好吃饭"
    assert payload["location"] == "杭州"

    with family_api_context.SessionLocal() as db:
        family = db.get(Family, family_api_context.family_id)
        assert family is not None
        assert family.updated_by == family_api_context.owner_id
        assert family.name == "新的家庭"

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == family_api_context.family_id,
                ActivityLog.actor_id == family_api_context.owner_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "Family",
                ActivityLog.entity_id == family_api_context.family_id,
            )
        )
        assert log is not None
        assert log.summary == "更新家庭信息 新的家庭"


def test_update_family_media_binding_rolls_back_when_commit_fails(family_api_context: FamilyApiContext) -> None:
    with fail_next_commit("family media commit failed"):
        with pytest.raises(RuntimeError, match="family media commit failed"):
            family_api_context.client.patch(
                "/api/family",
                json={
                    "name": "带图家庭",
                    "motto": "保留旧值",
                    "location": "苏州",
                    "image_media_id": family_api_context.family_media_id,
                },
            )

    with family_api_context.SessionLocal() as db:
        family = db.get(Family, family_api_context.family_id)
        media = db.get(MediaAsset, family_api_context.family_media_id)
        assert family is not None
        assert media is not None
        assert family.name == "主家庭"
        assert family.motto == "认真吃饭"
        assert family.location == "上海"
        assert family.updated_by == family_api_context.owner_id
        assert media.entity_type is None
        assert media.entity_id is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "更新家庭信息 带图家庭")) is None


def test_create_member_sets_family_scope_audit_fields_credentials_and_activity_log(
    family_api_context: FamilyApiContext,
) -> None:
    response = family_api_context.client.post(
        "/api/members",
        json={
            "username": "new-member",
            "display_name": "新成员",
            "password": "Member123",
            "role": "Member",
            "email": "new-member@example.com",
        },
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["username"] == "new-member"
    assert payload["display_name"] == "新成员"
    assert payload["role"] == "Member"

    with family_api_context.SessionLocal() as db:
        member = db.scalar(select(User).where(User.username == "new-member"))
        assert member is not None
        membership = db.scalar(select(Membership).where(Membership.user_id == member.id))
        assert membership is not None
        credential = db.scalar(select(UserCredential).where(UserCredential.user_id == member.id))
        assert credential is not None
        assert member.created_by == family_api_context.owner_id
        assert member.updated_by == family_api_context.owner_id
        assert membership.family_id == family_api_context.family_id
        assert membership.created_by == family_api_context.owner_id
        assert membership.updated_by == family_api_context.owner_id

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == family_api_context.family_id,
                ActivityLog.actor_id == family_api_context.owner_id,
                ActivityLog.action == ActivityAction.INVITE,
                ActivityLog.entity_type == "Membership",
                ActivityLog.entity_id == membership.id,
            )
        )
        assert log is not None
        assert log.summary == "邀请 新成员 成为成员"


def test_update_member_rejects_other_family_member_without_side_effects(
    family_api_context: FamilyApiContext,
) -> None:
    response = family_api_context.client.patch(
        f"/api/members/{family_api_context.other_user_id}",
        json={"display_name": "不应修改", "email": "", "phone": ""},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Member not found"

    with family_api_context.SessionLocal() as db:
        other_user = db.get(User, family_api_context.other_user_id)
        assert other_user is not None
        assert other_user.display_name == "其他家庭主理人"
        assert other_user.updated_by is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "更新成员信息 不应修改")) is None


def test_update_member_sets_audit_fields_and_activity_log(family_api_context: FamilyApiContext) -> None:
    response = family_api_context.client.patch(
        f"/api/members/{family_api_context.member_id}",
        json={"display_name": "新的成员", "email": "member@example.com", "phone": "13900000000"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["id"] == family_api_context.member_id
    assert payload["display_name"] == "新的成员"
    assert payload["email"] == "member@example.com"
    assert payload["phone"] == "13900000000"

    with family_api_context.SessionLocal() as db:
        member = db.get(User, family_api_context.member_id)
        assert member is not None
        assert member.updated_by == family_api_context.owner_id
        assert member.display_name == "新的成员"

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == family_api_context.family_id,
                ActivityLog.actor_id == family_api_context.owner_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "User",
                ActivityLog.entity_id == family_api_context.member_id,
            )
        )
        assert log is not None
        assert log.summary == "更新成员信息 新的成员"


def test_family_routes_require_authentication(family_api_context: FamilyApiContext) -> None:
    app.dependency_overrides.pop(get_current_auth, None)

    family_response = family_api_context.client.get("/api/family")
    members_response = family_api_context.client.get("/api/members")

    assert family_response.status_code == 401
    assert members_response.status_code == 401
