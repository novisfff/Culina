from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.orm.exc import StaleDataError
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import (
    ActivityAction,
    FoodType,
    MealType,
    MembershipStatus,
    UserRole,
)
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
    Membership,
    User,
)
from app.services import meal_log_versions as versions
from app.services.meal_log_versions import lock_meal_log_write_targets


@dataclass(frozen=True)
class CompositionSeed:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    user_id: str
    food_keep_id: str
    food_extra_id: str
    food_new_id: str
    other_family_food_id: str
    meal_log_id: str
    entry_keep_id: str
    entry_extra_id: str


def _make_food(
    *,
    food_id: str,
    family_id: str,
    name: str,
    user_id: str,
    food_type: FoodType = FoodType.SELF_MADE,
) -> Food:
    return Food(
        id=food_id,
        family_id=family_id,
        name=name,
        type=food_type,
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
        created_by=user_id,
        updated_by=user_id,
    )


@pytest.fixture()
def seed() -> Iterator[CompositionSeed]:
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
        other_user = User(id="user-other", username="other", display_name="Other", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-owner",
            family_id=family.id,
            user_id=owner.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-other",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        food_keep = _make_food(
            food_id="food-keep",
            family_id=family.id,
            name="番茄炒蛋",
            user_id=owner.id,
        )
        food_extra = _make_food(
            food_id="food-extra",
            family_id=family.id,
            name="紫菜汤",
            user_id=owner.id,
        )
        food_new = _make_food(
            food_id="food-new",
            family_id=family.id,
            name="清炒时蔬",
            user_id=owner.id,
        )
        foreign_food = _make_food(
            food_id="food-other-family",
            family_id=other_family.id,
            name="外家庭食物",
            user_id=other_user.id,
            food_type=FoodType.READY_MADE,
        )
        meal_log = MealLog(
            id="meal-1",
            family_id=family.id,
            date=date(2026, 7, 14),
            meal_type=MealType.DINNER,
            participant_user_ids=[owner.id],
            notes="",
            mood="",
            created_by=owner.id,
            updated_by=owner.id,
            row_version=1,
        )
        entry_keep = MealLogFood(
            id="entry-keep",
            meal_log_id=meal_log.id,
            food_id=food_keep.id,
            servings=Decimal("1"),
            note="原备注",
            rating=Decimal("4.5"),
        )
        entry_extra = MealLogFood(
            id="entry-extra",
            meal_log_id=meal_log.id,
            food_id=food_extra.id,
            servings=Decimal("1"),
            note="",
            rating=None,
        )
        db.add_all(
            [
                family,
                other_family,
                owner,
                other_user,
                membership,
                other_membership,
                food_keep,
                food_extra,
                food_new,
                foreign_food,
                meal_log,
                entry_keep,
                entry_extra,
            ]
        )
        db.commit()

    def override_db() -> Iterator[Session]:
        with SessionLocal() as session:
            yield session

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as session:
            user = session.get(User, "user-owner")
            membership_row = session.get(Membership, "membership-owner")
            assert user is not None and membership_row is not None
            return user, membership_row

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield CompositionSeed(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-main",
            other_family_id="family-other",
            user_id="user-owner",
            food_keep_id="food-keep",
            food_extra_id="food-extra",
            food_new_id="food-new",
            other_family_food_id="food-other-family",
            meal_log_id="meal-1",
            entry_keep_id="entry-keep",
            entry_extra_id="entry-extra",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _load_entry(db: Session, entry_id: str) -> MealLogFood | None:
    return db.get(MealLogFood, entry_id)


def _count(db: Session, model: type) -> int:
    return int(db.scalar(select(func.count()).select_from(model)) or 0)


def test_composition_diff_preserves_existing_identity_rating_and_created_at(seed: CompositionSeed) -> None:
    with seed.SessionLocal() as db:
        before = _load_entry(db, seed.entry_keep_id)
        assert before is not None
        before_created_at = before.created_at
        before_rating = before.rating

    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_keep_id,
                    "servings": 2,
                    "note": "多吃一点",
                },
                {"food_id": seed.food_new_id, "servings": 1, "note": ""},
            ],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["row_version"] == 2
    kept = next(item for item in body["food_entries"] if item["id"] == seed.entry_keep_id)
    assert kept["rating"] == 4.5
    assert kept["servings"] == 2
    assert kept["note"] == "多吃一点"
    assert kept["food_id"] == seed.food_keep_id
    assert seed.entry_extra_id not in {item["id"] for item in body["food_entries"]}
    new_entries = [item for item in body["food_entries"] if item["id"] != seed.entry_keep_id]
    assert len(new_entries) == 1
    assert new_entries[0]["food_id"] == seed.food_new_id

    with seed.SessionLocal() as db:
        kept_row = _load_entry(db, seed.entry_keep_id)
        assert kept_row is not None
        assert kept_row.created_at == before_created_at
        assert kept_row.rating == before_rating
        assert _load_entry(db, seed.entry_extra_id) is None
        activities = list(
            db.scalars(
                select(ActivityLog).where(
                    ActivityLog.entity_type == "MealLog",
                    ActivityLog.entity_id == seed.meal_log_id,
                    ActivityLog.action == ActivityAction.UPDATE,
                )
            )
        )
        assert any("调整了餐食内容" in item.summary for item in activities)


def test_stale_version_is_first_business_check_after_locks(seed: CompositionSeed) -> None:
    with seed.SessionLocal() as db:
        meal = db.get(MealLog, seed.meal_log_id)
        assert meal is not None
        meal.row_version = 2
        db.commit()

    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_keep_id,
                    "servings": 1,
                    "note": "",
                }
            ],
        },
    )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "meal_log_stale"
    assert detail["current"]["row_version"] == 2
    assert detail["current"]["food_entries"][0]["id"] in {seed.entry_keep_id, seed.entry_extra_id}
    assert "food_name" in detail["current"]["food_entries"][0]
    assert "deduction_suggestions" in detail["current"]
    assert detail["recovery_hint"] == "refresh_and_review"


def test_empty_final_list_rejected(seed: CompositionSeed) -> None:
    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={"expected_row_version": 1, "food_entries": []},
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "meal_log_food_required"
    else:
        assert "food" in str(detail).lower() or "食物" in str(detail)


def test_foreign_entry_id_rejected(seed: CompositionSeed) -> None:
    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": "entry-not-on-meal",
                    "food_id": seed.food_keep_id,
                    "servings": 1,
                    "note": "",
                }
            ],
        },
    )
    assert response.status_code in {400, 422}, response.text
    body = response.json()
    detail = body["detail"]
    if isinstance(detail, dict):
        assert detail["code"] in {
            "meal_log_entry_not_found",
            "meal_food_entry_not_found",
            "meal_log_food_entry_not_found",
        }


def test_cross_family_food_rejected(seed: CompositionSeed) -> None:
    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_keep_id,
                    "servings": 1,
                    "note": "",
                },
                {"food_id": seed.other_family_food_id, "servings": 1, "note": ""},
            ],
        },
    )
    assert response.status_code == 404, response.text
    detail = response.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "meal_log_food_not_found"


def test_changed_food_id_on_existing_entry_rejected(seed: CompositionSeed) -> None:
    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_new_id,
                    "servings": 1,
                    "note": "",
                }
            ],
        },
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] in {
            "meal_log_entry_food_mismatch",
            "meal_log_food_id_mismatch",
            "meal_entry_food_mismatch",
        }


def test_duplicate_final_food_rejected(seed: CompositionSeed) -> None:
    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_keep_id,
                    "servings": 1,
                    "note": "",
                },
                {"food_id": seed.food_keep_id, "servings": 1, "note": "重复"},
            ],
        },
    )
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "duplicate_meal_log_food"


def test_invalid_servings_rejected(seed: CompositionSeed) -> None:
    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_keep_id,
                    "servings": 0,
                    "note": "",
                }
            ],
        },
    )
    assert response.status_code == 422, response.text


def test_delete_add_update_without_stock_or_plan_compensation(seed: CompositionSeed) -> None:
    with seed.SessionLocal() as db:
        food = db.get(Food, seed.food_keep_id)
        assert food is not None
        food.stock_quantity = Decimal("3")
        food.stock_unit = "份"
        plan_item = FoodPlanItem(
            id="plan-1",
            family_id=seed.family_id,
            user_id=seed.user_id,
            food_id=seed.food_keep_id,
            plan_date=date(2026, 7, 14),
            meal_type=MealType.DINNER,
            note="",
            status="cooked",
            meal_log_id=seed.meal_log_id,
            created_by=seed.user_id,
            updated_by=seed.user_id,
        )
        db.add(plan_item)
        db.commit()
        before_stock = food.stock_quantity
        before_inventory_count = _count(db, InventoryItem)
        before_plan_status = plan_item.status
        before_plan_meal_log_id = plan_item.meal_log_id

    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_keep_id,
                    "servings": 3,
                    "note": "改份数",
                },
                {"food_id": seed.food_new_id, "servings": 1, "note": "新菜"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["row_version"] == 2
    assert {item["id"] for item in body["food_entries"]} >= {seed.entry_keep_id}
    assert seed.entry_extra_id not in {item["id"] for item in body["food_entries"]}
    assert any(item["food_id"] == seed.food_new_id for item in body["food_entries"])

    with seed.SessionLocal() as db:
        food = db.get(Food, seed.food_keep_id)
        plan_item = db.get(FoodPlanItem, "plan-1")
        assert food is not None and plan_item is not None
        assert food.stock_quantity == before_stock
        assert _count(db, InventoryItem) == before_inventory_count
        assert plan_item.status == before_plan_status
        assert plan_item.meal_log_id == before_plan_meal_log_id
        assert db.get(MealLog, seed.meal_log_id) is not None


def test_composition_does_not_create_record_operation(seed: CompositionSeed) -> None:
    with seed.SessionLocal() as db:
        before_ops = _count(db, MealLogRecordOperation)

    response = seed.client.patch(
        f"/api/meal-logs/{seed.meal_log_id}/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [
                {
                    "id": seed.entry_keep_id,
                    "food_id": seed.food_keep_id,
                    "servings": 1,
                    "note": "",
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    with seed.SessionLocal() as db:
        assert _count(db, MealLogRecordOperation) == before_ops


def test_stale_data_error_returns_complete_current_payload(seed: CompositionSeed) -> None:
    with patch(
        "app.api.meal_logs.commit_session",
        side_effect=StaleDataError("UPDATE meal_logs"),
    ):
        response = seed.client.patch(
            f"/api/meal-logs/{seed.meal_log_id}/composition",
            json={
                "expected_row_version": 1,
                "food_entries": [
                    {
                        "id": seed.entry_keep_id,
                        "food_id": seed.food_keep_id,
                        "servings": 2,
                        "note": "冲突",
                    }
                ],
            },
        )
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "meal_log_stale"
    assert detail["current"] is not None
    assert detail["current"]["id"] == seed.meal_log_id
    assert "food_entries" in detail["current"]
    assert "deduction_suggestions" in detail["current"]
    assert "photos" in detail["current"]
    assert detail["recovery_hint"] == "refresh_and_review"


def test_target_set_change_returns_targets_changed_without_reverse_locks(seed: CompositionSeed) -> None:
    lock_calls: list[str] = []
    original_inventory_lock = versions.lock_inventory_targets
    original_scalar = Session.scalar

    def tracking_inventory_lock(*args, **kwargs):
        lock_calls.append("food")
        return original_inventory_lock(*args, **kwargs)

    def tracking_scalar(self, statement, *args, **kwargs):
        compiled = str(statement)
        if "FOR UPDATE" in compiled.upper() and "meal_logs" in compiled.lower():
            lock_calls.append("meal_log")
            # Mutate entry set after Food locks / before MealLog lock returns.
            with seed.SessionLocal() as concurrent:
                meal = concurrent.get(MealLog, seed.meal_log_id)
                assert meal is not None
                concurrent.add(
                    MealLogFood(
                        id="entry-raced",
                        meal_log_id=seed.meal_log_id,
                        food_id=seed.food_new_id,
                        servings=Decimal("1"),
                        note="",
                        rating=None,
                    )
                )
                concurrent.commit()
        return original_scalar(self, statement, *args, **kwargs)

    with patch.object(versions, "lock_inventory_targets", side_effect=tracking_inventory_lock):
        with patch.object(Session, "scalar", tracking_scalar):
            response = seed.client.patch(
                f"/api/meal-logs/{seed.meal_log_id}/composition",
                json={
                    "expected_row_version": 1,
                    "food_entries": [
                        {
                            "id": seed.entry_keep_id,
                            "food_id": seed.food_keep_id,
                            "servings": 1,
                            "note": "",
                        }
                    ],
                },
            )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "meal_log_targets_changed"
    assert detail["recovery_hint"] == "refresh_and_review"
    # Food locks then MealLog lock; never reverse-lock Food after MealLog.
    assert lock_calls == ["food", "meal_log"]
    assert lock_calls.count("food") == 1


def test_missing_meal_log_returns_404(seed: CompositionSeed) -> None:
    response = seed.client.patch(
        "/api/meal-logs/meal-missing/composition",
        json={
            "expected_row_version": 1,
            "food_entries": [{"food_id": seed.food_keep_id, "servings": 1, "note": ""}],
        },
    )
    assert response.status_code == 404, response.text


def test_lock_helper_accepts_additional_food_ids_for_composition(seed: CompositionSeed) -> None:
    with seed.SessionLocal() as db:
        locked = lock_meal_log_write_targets(
            db,
            family_id=seed.family_id,
            meal_log_id=seed.meal_log_id,
            additional_food_ids=[seed.food_new_id],
        )
        assert seed.food_new_id in locked.foods_by_id
        assert set(locked.discovered_food_ids) == {seed.food_keep_id, seed.food_extra_id}
