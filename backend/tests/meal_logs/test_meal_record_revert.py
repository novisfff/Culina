from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import (
    ActivityAction,
    FoodType,
    MealLogRecordStatus,
    MealType,
    MediaSource,
    MembershipStatus,
    UserRole,
)
from app.core.utils import create_id, utcnow
from app.db.session import get_db
from app.main import app
from app.models.domain import (
    ActivityLog,
    Base,
    Family,
    Food,
    FoodPlanItem,
    InventoryItem,
    MealLog,
    MealLogFood,
    MealLogRecordOperation,
    MediaAsset,
    Membership,
    RecipeCookLog,
    SearchIndexJob,
    ShoppingListItem,
    User,
)


@dataclass
class RevertSeed:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    owner_id: str
    member_id: str
    food_id: str
    other_food_id: str
    later_food_id: str


@pytest.fixture()
def seed() -> Iterator[RevertSeed]:
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
        family = Family(id="family-main", name="主家庭", motto="", location="")
        other_family = Family(id="family-other", name="其他家庭", motto="", location="")
        owner = User(id="user-owner", username="owner", display_name="Owner", avatar_seed="", is_active=True)
        member = User(id="user-member", username="member", display_name="Member", avatar_seed="", is_active=True)
        other_user = User(id="user-other", username="other", display_name="Other", avatar_seed="", is_active=True)
        owner_membership = Membership(
            id="membership-owner",
            family_id=family.id,
            user_id=owner.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        member_membership = Membership(
            id="membership-member",
            family_id=family.id,
            user_id=member.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-other",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        food = Food(
            id="food-1",
            family_id=family.id,
            name="番茄炒蛋",
            type=FoodType.SELF_MADE,
            category="家常",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=owner.id,
            updated_by=owner.id,
        )
        other_food = Food(
            id="food-2",
            family_id=family.id,
            name="紫菜汤",
            type=FoodType.SELF_MADE,
            category="汤",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=owner.id,
            updated_by=owner.id,
        )
        later_food = Food(
            id="food-later",
            family_id=family.id,
            name="后来加的菜",
            type=FoodType.SELF_MADE,
            category="家常",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="",
            purchase_source="",
            scene="",
            notes="",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=owner.id,
            updated_by=owner.id,
        )
        db.add_all(
            [
                family,
                other_family,
                owner,
                member,
                other_user,
                owner_membership,
                member_membership,
                other_membership,
                food,
                other_food,
                later_food,
            ]
        )
        db.commit()

    auth_user_id = {"value": "user-owner"}

    def override_db() -> Iterator[Session]:
        with SessionLocal() as session:
            yield session

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as session:
            user = session.get(User, auth_user_id["value"])
            membership_id = (
                "membership-owner" if auth_user_id["value"] == "user-owner" else "membership-member"
            )
            membership_row = session.get(Membership, membership_id)
            assert user is not None and membership_row is not None
            return user, membership_row

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    seed_obj = RevertSeed(
        client=TestClient(app),
        SessionLocal=SessionLocal,
        family_id="family-main",
        other_family_id="family-other",
        owner_id="user-owner",
        member_id="user-member",
        food_id="food-1",
        other_food_id="food-2",
        later_food_id="food-later",
    )
    seed_obj.auth_user_id = auth_user_id  # type: ignore[attr-defined]

    try:
        yield seed_obj
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _as_owner(seed: RevertSeed) -> None:
    seed.auth_user_id["value"] = seed.owner_id  # type: ignore[attr-defined]


def _as_member(seed: RevertSeed) -> None:
    seed.auth_user_id["value"] = seed.member_id  # type: ignore[attr-defined]


def _count(db: Session, model: type) -> int:
    return int(db.scalar(select(func.count()).select_from(model)) or 0)


def _load_entry_ids(db: Session, meal_log_id: str) -> set[str]:
    return set(
        db.scalars(select(MealLogFood.id).where(MealLogFood.meal_log_id == meal_log_id))
    )


def _add_family_entry(db: Session, meal_log_id: str, food_id: str) -> MealLogFood:
    entry = MealLogFood(
        id=create_id("meal-food"),
        meal_log_id=meal_log_id,
        food_id=food_id,
        servings=Decimal("1"),
        note="",
    )
    meal = db.get(MealLog, meal_log_id)
    assert meal is not None
    meal.row_version += 1
    meal.updated_by = "user-owner"
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def _record_new(
    seed: RevertSeed,
    *,
    request_id: str,
    with_inline: bool = True,
    food_id: str | None = None,
) -> dict:
    payload: dict = {
        "client_request_id": request_id,
        "date": "2026-07-15",
        "meal_type": "dinner",
        "target": {"kind": "new"},
        "new_foods": [],
        "entries": [],
    }
    if with_inline:
        payload["new_foods"] = [{"client_food_id": "local-1", "name": "酸汤牛肉", "type": "selfMade"}]
        payload["entries"] = [
            {"food_id": food_id or seed.food_id, "servings": 1},
            {"client_food_id": "local-1", "servings": 2},
        ]
    else:
        payload["entries"] = [{"food_id": food_id or seed.food_id, "servings": 1}]
    response = seed.client.post("/api/meal-logs/record", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _record_append(
    seed: RevertSeed,
    *,
    request_id: str,
    meal_log_id: str,
    expected_row_version: int,
    food_id: str | None = None,
    with_inline: bool = False,
    inline_name: str = "凉拌黄瓜",
) -> dict:
    payload: dict = {
        "client_request_id": request_id,
        "date": "2026-07-15",
        "meal_type": "dinner",
        "target": {
            "kind": "existing",
            "meal_log_id": meal_log_id,
            "expected_row_version": expected_row_version,
        },
        "new_foods": [],
        "entries": [],
    }
    if with_inline:
        payload["new_foods"] = [{"client_food_id": "local-append", "name": inline_name, "type": "selfMade"}]
        payload["entries"] = [{"client_food_id": "local-append", "servings": 1}]
    else:
        payload["entries"] = [{"food_id": food_id or seed.other_food_id, "servings": 1}]
    response = seed.client.post("/api/meal-logs/record", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_revert_append_removes_only_operation_entries(seed: RevertSeed) -> None:
    base = _record_new(seed, request_id="base-append", with_inline=False)
    before_entry_id = base["meal_log"]["food_entries"][0]["id"]
    appended = _record_append(
        seed,
        request_id="append-op",
        meal_log_id=base["meal_log"]["id"],
        expected_row_version=base["meal_log"]["row_version"],
        with_inline=True,
    )
    operation_id = appended["operation"]["id"]
    meal_log_id = appended["meal_log"]["id"]

    with seed.SessionLocal() as db:
        later_entry = _add_family_entry(db, meal_log_id, seed.later_food_id)

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "reverted"
    assert body["replayed"] is False
    assert body["meal_log"] is not None
    # base create=1, append=2, later family entry=3, revert bump=4
    assert body["meal_log"]["row_version"] == 4

    with seed.SessionLocal() as db:
        remaining = _load_entry_ids(db, meal_log_id)
        assert remaining == {before_entry_id, later_entry.id}
        meal = db.get(MealLog, meal_log_id)
        assert meal is not None
        assert int(meal.row_version) == 4


def test_revert_new_empty_meal_log_deletes_meal(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="new-empty")
    operation_id = created["operation"]["id"]
    meal_log_id = created["meal_log"]["id"]
    created_food_id = created["created_foods"][0]["id"]

    with seed.SessionLocal() as db:
        photo = MediaAsset(
            id="meal-photo-1",
            family_id=seed.family_id,
            name="meal.png",
            url="/media/meal.png",
            file_path="meal.png",
            source=MediaSource.UPLOAD,
            alt="meal",
            entity_type="meal_log",
            entity_id=meal_log_id,
            created_by=seed.owner_id,
        )
        db.add(photo)
        db.commit()

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "reverted"
    assert body["meal_log"] is None
    assert created_food_id in body["removed_food_ids"]

    with seed.SessionLocal() as db:
        assert db.get(MealLog, meal_log_id) is None
        assert db.get(Food, created_food_id) is None
        photo = db.get(MediaAsset, "meal-photo-1")
        assert photo is not None
        assert photo.entity_id is None
        assert photo.entity_type is None
        jobs = list(
            db.scalars(
                select(SearchIndexJob).where(
                    SearchIndexJob.family_id == seed.family_id,
                    SearchIndexJob.entity_type == "food",
                    SearchIndexJob.entity_id == created_food_id,
                )
            )
        )
        assert len(jobs) >= 1


def test_revert_new_meal_with_later_family_entry_preserves_meal(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="new-with-later", with_inline=False)
    operation_id = created["operation"]["id"]
    meal_log_id = created["meal_log"]["id"]
    original_entry_id = created["meal_log"]["food_entries"][0]["id"]

    with seed.SessionLocal() as db:
        later = _add_family_entry(db, meal_log_id, seed.later_food_id)

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["meal_log"] is not None
    assert body["meal_log"]["id"] == meal_log_id
    remaining_ids = {item["id"] for item in body["meal_log"]["food_entries"]}
    assert remaining_ids == {later.id}
    assert original_entry_id not in remaining_ids

    with seed.SessionLocal() as db:
        assert db.get(MealLog, meal_log_id) is not None
        assert _load_entry_ids(db, meal_log_id) == {later.id}


def test_original_actor_and_owner_can_revert_member_denied(seed: RevertSeed) -> None:
    _as_member(seed)
    created = _record_new(seed, request_id="member-record", with_inline=False)
    operation_id = created["operation"]["id"]

    # Another member cannot revert.
    # Seed only has one member; use owner first for owner path then member denial on owner's op.
    _as_owner(seed)
    owner_created = _record_new(seed, request_id="owner-record", with_inline=False)
    owner_op = owner_created["operation"]["id"]

    _as_member(seed)
    denied = seed.client.post(f"/api/meal-logs/record-operations/{owner_op}/revert")
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "record_operation_forbidden"

    # Original actor (member) can revert own op.
    allowed = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert allowed.status_code == 200
    assert allowed.json()["status"] == "reverted"

    # Owner can revert another member's remaining... already reverted. Create another.
    _as_member(seed)
    member_second = _record_new(seed, request_id="member-record-2", with_inline=False)
    _as_owner(seed)
    owner_revert = seed.client.post(
        f"/api/meal-logs/record-operations/{member_second['operation']['id']}/revert"
    )
    assert owner_revert.status_code == 200
    assert owner_revert.json()["status"] == "reverted"


def test_member_cannot_replay_owner_already_reverted_operation(seed: RevertSeed) -> None:
    """Already-REVERTED replay must still enforce actor/Owner authorization."""
    _as_owner(seed)
    created = _record_new(seed, request_id="owner-for-replay-auth", with_inline=False)
    operation_id = created["operation"]["id"]

    first = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert first.status_code == 200, first.text
    assert first.json()["replayed"] is False

    # Owner may replay own already-reverted op.
    owner_replay = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert owner_replay.status_code == 200, owner_replay.text
    assert owner_replay.json()["replayed"] is True

    # Member must not receive the stored snapshot on replay of Owner's op.
    _as_member(seed)
    denied = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert denied.status_code == 403
    assert denied.json()["detail"]["code"] == "record_operation_forbidden"


def test_cross_family_operation_not_found(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="cross-family", with_inline=False)
    operation_id = created["operation"]["id"]

    with seed.SessionLocal() as db:
        op = db.get(MealLogRecordOperation, operation_id)
        assert op is not None
        op.family_id = seed.other_family_id
        db.commit()

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "record_operation_not_found"


def test_exact_15_minute_boundary_and_expired(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="boundary", with_inline=False)
    operation_id = created["operation"]["id"]

    with seed.SessionLocal() as db:
        op = db.get(MealLogRecordOperation, operation_id)
        assert op is not None
        applied = op.applied_at
        if applied.tzinfo is None:
            applied = applied.replace(tzinfo=timezone.utc)
        deadline = applied + timedelta(minutes=15)
        op.revertible_until = deadline
        db.commit()

    # At exact deadline: allowed.
    from app.core import utils as core_utils

    original_utcnow = core_utils.utcnow
    try:
        core_utils.utcnow = lambda: deadline  # type: ignore[assignment]
        # Also patch the route import path
        import app.api.meal_log_recording as recording_api
        import app.services.meal_log_record_history as history

        recording_api.utcnow = lambda: deadline  # type: ignore[assignment]
        ok = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
        assert ok.status_code == 200, ok.text
    finally:
        core_utils.utcnow = original_utcnow  # type: ignore[assignment]
        import app.api.meal_log_recording as recording_api

        recording_api.utcnow = original_utcnow  # type: ignore[assignment]

    # Fresh op for expired case.
    created2 = _record_new(seed, request_id="expired", with_inline=False)
    op2 = created2["operation"]["id"]
    with seed.SessionLocal() as db:
        op = db.get(MealLogRecordOperation, op2)
        assert op is not None
        applied = op.applied_at
        if applied.tzinfo is None:
            applied = applied.replace(tzinfo=timezone.utc)
        op.revertible_until = applied - timedelta(seconds=1)
        db.commit()

    expired = seed.client.post(f"/api/meal-logs/record-operations/{op2}/revert")
    assert expired.status_code == 409
    assert expired.json()["detail"]["code"] == "record_operation_expired"


def test_missing_effect_ids_still_succeed(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="missing-effects", with_inline=False)
    operation_id = created["operation"]["id"]
    meal_log_id = created["meal_log"]["id"]
    entry_id = created["meal_log"]["food_entries"][0]["id"]

    with seed.SessionLocal() as db:
        entry = db.get(MealLogFood, entry_id)
        assert entry is not None
        db.delete(entry)
        later = MealLogFood(
            id=create_id("meal-food"),
            meal_log_id=meal_log_id,
            food_id=seed.later_food_id,
            servings=Decimal("1"),
            note="",
        )
        meal = db.get(MealLog, meal_log_id)
        assert meal is not None
        meal.row_version += 1
        db.add(later)
        db.commit()

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "reverted"
    assert body["meal_log"] is not None

    with seed.SessionLocal() as db:
        assert db.get(MealLog, meal_log_id) is not None
        remaining = _load_entry_ids(db, meal_log_id)
        assert len(remaining) == 1


def test_revert_does_not_touch_inventory_plan_or_cooklog(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="no-side-effects", with_inline=False)
    operation_id = created["operation"]["id"]

    with seed.SessionLocal() as db:
        before_inventory = _count(db, InventoryItem)
        before_plan = _count(db, FoodPlanItem)
        before_cook = _count(db, RecipeCookLog)

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 200

    with seed.SessionLocal() as db:
        assert _count(db, InventoryItem) == before_inventory
        assert _count(db, FoodPlanItem) == before_plan
        assert _count(db, RecipeCookLog) == before_cook


def test_repeated_revert_replays_stored_result_without_mutation(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="replay-revert", with_inline=True)
    operation_id = created["operation"]["id"]
    meal_log_id = created["meal_log"]["id"]
    created_food_id = created["created_foods"][0]["id"]

    with seed.SessionLocal() as db:
        later = _add_family_entry(db, meal_log_id, seed.later_food_id)

    first = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert first.status_code == 200, first.text
    first_body = first.json()
    assert first_body["replayed"] is False
    assert first_body["meal_log"] is not None
    first_meal = first_body["meal_log"]
    first_removed = list(first_body["removed_food_ids"])

    with seed.SessionLocal() as db:
        meal = db.get(MealLog, meal_log_id)
        assert meal is not None
        meal.notes = "家人后来改了备注"
        meal.row_version += 1
        retained_food = db.get(Food, seed.food_id)
        assert retained_food is not None
        retained_food.notes = "后来补充描述"
        retained_food.row_version += 1
        # created food may have been deleted; if retained for any reason, mutate it
        created_food = db.get(Food, created_food_id)
        if created_food is not None:
            created_food.favorite = True
            created_food.row_version += 1
        create_activities = int(
            db.scalar(
                select(func.count()).select_from(ActivityLog).where(
                    ActivityLog.entity_type == "MealLog",
                    ActivityLog.action == ActivityAction.CREATE,
                )
            )
            or 0
        )
        revert_activities = int(
            db.scalar(
                select(func.count()).select_from(ActivityLog).where(
                    ActivityLog.action == ActivityAction.REVERT,
                )
            )
            or 0
        )
        meal_row_version = int(meal.row_version)
        later_ids = _load_entry_ids(db, meal_log_id)
        db.commit()

    second = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert second.status_code == 200, second.text
    second_body = second.json()
    assert second_body["replayed"] is True
    assert second_body["status"] == first_body["status"]
    assert second_body["meal_log"] == first_meal
    assert second_body["removed_food_ids"] == first_removed

    with seed.SessionLocal() as db:
        meal = db.get(MealLog, meal_log_id)
        assert meal is not None
        assert meal.notes == "家人后来改了备注"
        assert int(meal.row_version) == meal_row_version
        assert _load_entry_ids(db, meal_log_id) == later_ids
        assert later.id in later_ids
        assert int(
            db.scalar(
                select(func.count()).select_from(ActivityLog).where(
                    ActivityLog.action == ActivityAction.REVERT,
                )
            )
            or 0
        ) == revert_activities
        assert int(
            db.scalar(
                select(func.count()).select_from(ActivityLog).where(
                    ActivityLog.entity_type == "MealLog",
                    ActivityLog.action == ActivityAction.CREATE,
                )
            )
            or 0
        ) == create_activities


def test_minimal_food_deleted_when_unreferenced(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="delete-food", with_inline=True)
    operation_id = created["operation"]["id"]
    food_id = created["created_foods"][0]["id"]

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 200
    assert food_id in response.json()["removed_food_ids"]

    with seed.SessionLocal() as db:
        assert db.get(Food, food_id) is None
        jobs = list(
            db.scalars(
                select(SearchIndexJob).where(
                    SearchIndexJob.entity_type == "food",
                    SearchIndexJob.entity_id == food_id,
                )
            )
        )
        assert len(jobs) >= 1


def test_edited_or_referenced_food_is_retained(seed: RevertSeed) -> None:
    cases = [
        ("favorite", lambda food: setattr(food, "favorite", True)),
        ("stocked", lambda food: setattr(food, "stock_quantity", Decimal("1"))),
        ("notes", lambda food: setattr(food, "notes", "补充了描述")),
        ("row_version", lambda food: setattr(food, "row_version", 2)),
    ]
    for label, mutator in cases:
        created = _record_new(seed, request_id=f"retain-{label}", with_inline=True)
        operation_id = created["operation"]["id"]
        food_id = created["created_foods"][0]["id"]
        with seed.SessionLocal() as db:
            food = db.get(Food, food_id)
            assert food is not None
            mutator(food)
            db.commit()

        response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
        assert response.status_code == 200, label
        assert food_id not in response.json()["removed_food_ids"], label
        with seed.SessionLocal() as db:
            assert db.get(Food, food_id) is not None, label


def test_media_bound_planned_shopped_or_reused_food_retained(seed: RevertSeed) -> None:
    # media-bound
    created = _record_new(seed, request_id="retain-media", with_inline=True)
    op_media = created["operation"]["id"]
    food_media = created["created_foods"][0]["id"]
    with seed.SessionLocal() as db:
        db.add(
            MediaAsset(
                id="food-photo-1",
                family_id=seed.family_id,
                name="food.png",
                url="/media/food.png",
                file_path="food.png",
                source=MediaSource.UPLOAD,
                alt="food",
                entity_type="food",
                entity_id=food_media,
                created_by=seed.owner_id,
            )
        )
        db.commit()
    resp = seed.client.post(f"/api/meal-logs/record-operations/{op_media}/revert")
    assert resp.status_code == 200
    assert food_media not in resp.json()["removed_food_ids"]

    # planned
    created = _record_new(seed, request_id="retain-plan", with_inline=True)
    op_plan = created["operation"]["id"]
    food_plan = created["created_foods"][0]["id"]
    with seed.SessionLocal() as db:
        db.add(
            FoodPlanItem(
                id="plan-1",
                family_id=seed.family_id,
                user_id=seed.owner_id,
                food_id=food_plan,
                plan_date=date(2026, 7, 16),
                meal_type=MealType.DINNER,
                note="",
                status="planned",
                created_by=seed.owner_id,
                updated_by=seed.owner_id,
            )
        )
        db.commit()
    resp = seed.client.post(f"/api/meal-logs/record-operations/{op_plan}/revert")
    assert resp.status_code == 200
    assert food_plan not in resp.json()["removed_food_ids"]

    # shopped
    created = _record_new(seed, request_id="retain-shop", with_inline=True)
    op_shop = created["operation"]["id"]
    food_shop = created["created_foods"][0]["id"]
    with seed.SessionLocal() as db:
        db.add(
            ShoppingListItem(
                id="shop-1",
                family_id=seed.family_id,
                food_id=food_shop,
                title="酸汤牛肉",
                quantity=Decimal("1"),
                unit="份",
                done=False,
                created_by=seed.owner_id,
                updated_by=seed.owner_id,
            )
        )
        db.commit()
    resp = seed.client.post(f"/api/meal-logs/record-operations/{op_shop}/revert")
    assert resp.status_code == 200
    assert food_shop not in resp.json()["removed_food_ids"]

    # reused in another meal
    created = _record_new(seed, request_id="retain-reuse", with_inline=True)
    op_reuse = created["operation"]["id"]
    food_reuse = created["created_foods"][0]["id"]
    with seed.SessionLocal() as db:
        other_meal = MealLog(
            id="meal-other-reuse",
            family_id=seed.family_id,
            date=date(2026, 7, 16),
            meal_type=MealType.LUNCH,
            participant_user_ids=[seed.owner_id],
            notes="",
            mood="",
            created_by=seed.owner_id,
            updated_by=seed.owner_id,
        )
        db.add(other_meal)
        db.flush()
        db.add(
            MealLogFood(
                id="entry-reuse",
                meal_log_id=other_meal.id,
                food_id=food_reuse,
                servings=Decimal("1"),
                note="",
            )
        )
        db.commit()
    resp = seed.client.post(f"/api/meal-logs/record-operations/{op_reuse}/revert")
    assert resp.status_code == 200
    assert food_reuse not in resp.json()["removed_food_ids"]
    with seed.SessionLocal() as db:
        assert db.get(Food, food_reuse) is not None
        assert db.get(MealLogFood, "entry-reuse") is not None


def test_active_operations_list_contract(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="active-1", with_inline=True)
    operation_id = created["operation"]["id"]
    meal_log_id = created["meal_log"]["id"]

    # Member's own op should not appear for owner list when created by member
    _as_member(seed)
    member_created = _record_new(seed, request_id="active-member", with_inline=False)

    _as_owner(seed)
    response = seed.client.get("/api/meal-logs/record-operations", params={"active": "true"})
    assert response.status_code == 200, response.text
    items = response.json()
    assert isinstance(items, list)
    assert len(items) >= 1
    ids = {item["id"] for item in items}
    assert operation_id in ids
    assert member_created["operation"]["id"] not in ids
    top = next(item for item in items if item["id"] == operation_id)
    assert top["meal_log_id"] == meal_log_id
    assert top["can_revert"] is True
    assert "revertible_until" in top
    assert "foods" in top
    assert all("name" in food for food in top["foods"])
    # Never expose internal entry IDs
    assert "created_entry_ids" not in top
    assert "created_entry_ids_json" not in top
    for food in top["foods"]:
        assert "entry_id" not in food

    # Newest first
    older = _record_new(seed, request_id="active-2", with_inline=False)
    response = seed.client.get("/api/meal-logs/record-operations", params={"active": "true"})
    items = response.json()
    owner_ids = [item["id"] for item in items]
    assert owner_ids[0] == older["operation"]["id"]

    # Expired not listed
    with seed.SessionLocal() as db:
        op = db.get(MealLogRecordOperation, operation_id)
        assert op is not None
        op.revertible_until = utcnow() - timedelta(minutes=1)
        db.commit()
    response = seed.client.get("/api/meal-logs/record-operations", params={"active": "true"})
    ids = {item["id"] for item in response.json()}
    assert operation_id not in ids

    # Reverted not listed
    seed.client.post(f"/api/meal-logs/record-operations/{older['operation']['id']}/revert")
    response = seed.client.get("/api/meal-logs/record-operations", params={"active": "true"})
    ids = {item["id"] for item in response.json()}
    assert older["operation"]["id"] not in ids


def test_revert_preserves_original_activity_and_adds_revert_activity(seed: RevertSeed) -> None:
    created = _record_new(seed, request_id="activity", with_inline=False)
    operation_id = created["operation"]["id"]
    meal_log_id = created["meal_log"]["id"]

    with seed.SessionLocal() as db:
        create_count = int(
            db.scalar(
                select(func.count()).select_from(ActivityLog).where(
                    ActivityLog.entity_type == "MealLog",
                    ActivityLog.entity_id == meal_log_id,
                    ActivityLog.action == ActivityAction.CREATE,
                )
            )
            or 0
        )
        assert create_count == 1

    response = seed.client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
    assert response.status_code == 200

    with seed.SessionLocal() as db:
        assert int(
            db.scalar(
                select(func.count()).select_from(ActivityLog).where(
                    ActivityLog.entity_type == "MealLog",
                    ActivityLog.entity_id == meal_log_id,
                    ActivityLog.action == ActivityAction.CREATE,
                )
            )
            or 0
        ) == 1
        reverts = list(
            db.scalars(
                select(ActivityLog).where(
                    ActivityLog.action == ActivityAction.REVERT,
                    ActivityLog.entity_type == "MealLog",
                    ActivityLog.entity_id == meal_log_id,
                )
            )
        )
        assert len(reverts) == 1
        assert "撤销" in reverts[0].summary
