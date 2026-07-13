from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, ActivityHighlightKind, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import ActivityLog, Base, Family, Membership, User
from app.services.clock import activity_week_window_utc


@dataclass(frozen=True)
class HighlightsApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    user_id: str
    membership_id: str
    other_family_activity_id: str


@pytest.fixture()
def highlights_api_context(monkeypatch: pytest.MonkeyPatch) -> Iterator[HighlightsApiContext]:
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

    # Frozen "now" = Shanghai Monday 00:30 → naive UTC window [2026-07-12 16:00, 2026-07-12 16:30]
    frozen_now = datetime(2026, 7, 13, 0, 30, tzinfo=ZoneInfo("Asia/Shanghai"))
    monkeypatch.setattr(
        "app.services.activity_highlights.now_for_family",
        lambda family_id=None, *, at=None, timezone_name="Asia/Shanghai": frozen_now,
    )

    with SessionLocal() as db:
        equal_time = datetime(2026, 7, 12, 16, 15)
        monday_time = datetime(2026, 7, 12, 16, 0)
        sunday_time = datetime(2026, 7, 12, 15, 59, 59)
        future_time = datetime(2026, 7, 12, 16, 31)

        family = Family(id="family-highlights", name="高亮家庭", motto="", location="")
        other_family = Family(id="family-other-highlights", name="其他高亮家庭", motto="", location="")
        user = User(
            id="user-highlights",
            username="highlights-user",
            display_name="当前成员",
            avatar_seed="",
            is_active=True,
        )
        other_user = User(
            id="user-other-highlights",
            username="other-highlights-user",
            display_name="其他家庭用户",
            avatar_seed="",
            is_active=True,
        )
        membership = Membership(
            id="membership-highlights",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-other-highlights",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )

        # Equal timestamps: id DESC → activity-z before activity-a.
        # activity-a actor belongs only to the other family → "家庭成员".
        activity_z = ActivityLog(
            id="activity-z",
            family_id=family.id,
            actor_id=user.id,
            action=ActivityAction.UPDATE,
            entity_type="InventoryOperation",
            entity_id="op-z",
            summary="审计：完成采购入库",
            highlight_kind=ActivityHighlightKind.SHOPPING,
            highlight_summary="完成 5 项采购入库",
            created_at=equal_time,
        )
        activity_a = ActivityLog(
            id="activity-a",
            family_id=family.id,
            actor_id=other_user.id,
            action=ActivityAction.UPDATE,
            entity_type="InventoryOperation",
            entity_id="op-a",
            summary="审计：完成库存盘点",
            highlight_kind=ActivityHighlightKind.INVENTORY,
            highlight_summary="完成库存盘点",
            created_at=equal_time,
        )
        # Monday boundary (week start) — third in-week highlight for week_count == 3.
        activity_monday = ActivityLog(
            id="activity-monday",
            family_id=family.id,
            actor_id=user.id,
            action=ActivityAction.CREATE,
            entity_type="MealPlan",
            entity_id="plan-monday",
            summary="审计：创建周计划",
            highlight_kind=ActivityHighlightKind.MEAL_PLAN,
            highlight_summary="创建本周用餐计划",
            created_at=monday_time,
        )
        # Sunday just before week start — eligible for items, excluded from week_count.
        activity_sunday = ActivityLog(
            id="activity-sunday",
            family_id=family.id,
            actor_id=user.id,
            action=ActivityAction.CREATE,
            entity_type="MealLog",
            entity_id="meal-sunday",
            summary="审计：记录周日用餐",
            highlight_kind=ActivityHighlightKind.MEAL,
            highlight_summary="记录周日晚餐",
            created_at=sunday_time,
        )
        # Future relative to frozen now — eligible for items, excluded from week_count.
        activity_future = ActivityLog(
            id="activity-future",
            family_id=family.id,
            actor_id=user.id,
            action=ActivityAction.CREATE,
            entity_type="Family",
            entity_id="invite-future",
            summary="审计：邀请成员",
            highlight_kind=ActivityHighlightKind.FAMILY,
            highlight_summary="邀请新成员加入家庭",
            created_at=future_time,
        )
        # Audit-only row must never appear in highlights.
        activity_audit = ActivityLog(
            id="activity-audit",
            family_id=family.id,
            actor_id=user.id,
            action=ActivityAction.UPDATE,
            entity_type="Family",
            entity_id=family.id,
            summary="仅审计：更新家庭资料",
            highlight_kind=None,
            highlight_summary=None,
            created_at=equal_time,
        )
        other_family_activity = ActivityLog(
            id="activity-other-family",
            family_id=other_family.id,
            actor_id=other_user.id,
            action=ActivityAction.UPDATE,
            entity_type="InventoryOperation",
            entity_id="op-other",
            summary="其他家庭高亮",
            highlight_kind=ActivityHighlightKind.SHOPPING,
            highlight_summary="其他家庭完成采购",
            created_at=equal_time,
        )

        db.add_all(
            [
                family,
                other_family,
                user,
                other_user,
                membership,
                other_membership,
                activity_z,
                activity_a,
                activity_monday,
                activity_sunday,
                activity_future,
                activity_audit,
                other_family_activity,
            ]
        )
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as db:
            user = db.get(User, "user-highlights")
            membership = db.get(Membership, "membership-highlights")
            assert user is not None
            assert membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield HighlightsApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-highlights",
            other_family_id="family-other-highlights",
            user_id="user-highlights",
            membership_id="membership-highlights",
            other_family_activity_id="activity-other-family",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_activity_week_window_converts_shanghai_monday_to_naive_utc() -> None:
    at = datetime(2026, 7, 13, 0, 30, tzinfo=ZoneInfo("Asia/Shanghai"))
    week_start, now = activity_week_window_utc(at=at)
    assert week_start == datetime(2026, 7, 12, 16, 0)
    assert now == datetime(2026, 7, 12, 16, 30)
    assert week_start.tzinfo is None
    assert now.tzinfo is None


def test_highlights_are_family_scoped_stably_sorted_and_minimal(
    highlights_api_context: HighlightsApiContext,
) -> None:
    response = highlights_api_context.client.get("/api/activity-highlights", params={"limit": 5})
    assert response.status_code == 200
    payload = response.json()
    # Items are not week-window filtered; limit=5 returns all five eligible current-family rows.
    # Equal-timestamp pair sorts by id DESC: activity-z before activity-a.
    assert [item["id"] for item in payload["items"]] == [
        "activity-future",
        "activity-z",
        "activity-a",
        "activity-monday",
        "activity-sunday",
    ]
    assert payload["items"][1]["actor_name"] == "当前成员"
    assert payload["items"][2]["actor_name"] == "家庭成员"
    assert set(payload["items"][0]) == {
        "id", "kind", "summary", "actor_id", "actor_name", "created_at"
    }
    assert highlights_api_context.other_family_activity_id not in {
        item["id"] for item in payload["items"]
    }
    # audit-only row is excluded; external-family actor never leaks display name
    assert "activity-audit" not in {item["id"] for item in payload["items"]}
    assert all(item["actor_name"] != "其他家庭用户" for item in payload["items"])


def test_week_count_is_not_limited_and_excludes_future_records(
    highlights_api_context: HighlightsApiContext,
) -> None:
    response = highlights_api_context.client.get("/api/activity-highlights", params={"limit": 1})
    assert response.status_code == 200
    assert len(response.json()["items"]) == 1
    assert response.json()["week_highlight_count"] == 3


@pytest.mark.parametrize(
    ("limit", "status_code"),
    [(None, 200), (1, 200), (20, 200), (0, 422), (21, 422)],
)
def test_highlight_limit_contract(
    highlights_api_context: HighlightsApiContext,
    limit: int | None,
    status_code: int,
) -> None:
    params = {} if limit is None else {"limit": limit}
    assert highlights_api_context.client.get(
        "/api/activity-highlights",
        params=params,
    ).status_code == status_code


def test_activity_highlights_require_authentication(
    highlights_api_context: HighlightsApiContext,
) -> None:
    app.dependency_overrides.pop(get_current_auth, None)
    response = highlights_api_context.client.get("/api/activity-highlights")
    assert response.status_code == 401
