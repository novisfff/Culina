from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import ActivityLog, Base, Family, Membership, User


@dataclass(frozen=True)
class ActivityApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    user_id: str
    membership_id: str
    own_log_id: str
    other_log_id: str
    external_actor_log_id: str


@pytest.fixture()
def activity_api_context() -> Iterator[ActivityApiContext]:
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
        older_time = datetime(2026, 6, 28, 9, 0, tzinfo=timezone.utc)
        recent_time = datetime(2026, 7, 1, 10, 30, tzinfo=timezone.utc)
        other_time = datetime(2026, 7, 2, 8, 0, tzinfo=timezone.utc)
        family = Family(id="family-activity", name="活动家庭", motto="", location="")
        other_family = Family(id="family-other", name="其他家庭", motto="", location="")
        user = User(id="user-activity", username="activity-user", display_name="活动用户", avatar_seed="", is_active=True)
        other_user = User(id="user-other", username="other-user", display_name="其他用户", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-activity",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-other",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        own_log = ActivityLog(
            id="activity-own",
            family_id=family.id,
            actor_id=user.id,
            action=ActivityAction.UPDATE,
            entity_type="Family",
            entity_id=family.id,
            summary="更新家庭信息 活动家庭",
            created_at=recent_time,
        )
        external_actor_log = ActivityLog(
            id="activity-external-actor",
            family_id=family.id,
            actor_id=other_user.id,
            action=ActivityAction.CREATE,
            entity_type="InventoryItem",
            entity_id="inventory-external",
            summary="历史导入库存",
            created_at=older_time,
        )
        other_log = ActivityLog(
            id="activity-other",
            family_id=other_family.id,
            actor_id=other_user.id,
            action=ActivityAction.UPDATE,
            entity_type="Family",
            entity_id=other_family.id,
            summary="其他家庭动态",
            created_at=other_time,
        )
        db.add_all([family, other_family, user, other_user, membership, other_membership, own_log, external_actor_log, other_log])
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as db:
            user = db.get(User, "user-activity")
            membership = db.get(Membership, "membership-activity")
            assert user is not None
            assert membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield ActivityApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-activity",
            other_family_id="family-other",
            user_id="user-activity",
            membership_id="membership-activity",
            own_log_id="activity-own",
            other_log_id="activity-other",
            external_actor_log_id="activity-external-actor",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_activity_logs_return_only_current_family_logs(activity_api_context: ActivityApiContext) -> None:
    response = activity_api_context.client.get("/api/activity-logs")

    assert response.status_code == 200
    payload = response.json()
    ids = {item["id"] for item in payload}
    assert ids == {activity_api_context.own_log_id, activity_api_context.external_actor_log_id}
    assert activity_api_context.other_log_id not in ids
    assert {item["family_id"] for item in payload} == {activity_api_context.family_id}


def test_activity_logs_resolve_actor_name_only_from_current_family_members(
    activity_api_context: ActivityApiContext,
) -> None:
    response = activity_api_context.client.get("/api/activity-logs")

    assert response.status_code == 200
    payload_by_id = {item["id"]: item for item in response.json()}
    assert payload_by_id[activity_api_context.own_log_id]["actor_name"] == "活动用户"
    assert payload_by_id[activity_api_context.external_actor_log_id]["actor_name"] is None


def test_activity_logs_filter_by_date_actor_action_and_entity(activity_api_context: ActivityApiContext) -> None:
    response = activity_api_context.client.get(
        "/api/activity-logs",
        params={
            "start_date": "2026-07-01",
            "end_date": "2026-07-01",
            "actor_id": activity_api_context.user_id,
            "action": "update",
            "entity_type": "Family",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload] == [activity_api_context.own_log_id]


def test_activity_logs_support_limit_and_offset_in_descending_order(activity_api_context: ActivityApiContext) -> None:
    response = activity_api_context.client.get("/api/activity-logs", params={"limit": 1, "offset": 1})

    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload] == [activity_api_context.external_actor_log_id]


def test_activity_logs_require_authentication(activity_api_context: ActivityApiContext) -> None:
    app.dependency_overrides.pop(get_current_auth, None)

    response = activity_api_context.client.get("/api/activity-logs")

    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"
