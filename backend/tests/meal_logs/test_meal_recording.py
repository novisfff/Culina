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
    MealLogRecordTargetKind,
    MealType,
    MembershipStatus,
    UserRole,
)
from app.core.utils import utcnow
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
    RecipeCookLog,
    User,
)


@dataclass(frozen=True)
class RecordingSeed:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    user_id: str
    food_id: str
    other_food_id: str
    other_family_food_id: str


@pytest.fixture()
def seed() -> Iterator[RecordingSeed]:
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
        foreign_food = Food(
            id="food-other-family",
            family_id=other_family.id,
            name="外家庭食物",
            type=FoodType.READY_MADE,
            category="外购",
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
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        db.add_all([family, other_family, owner, other_user, membership, other_membership, food, other_food, foreign_food])
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
        yield RecordingSeed(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-main",
            other_family_id="family-other",
            user_id="user-owner",
            food_id="food-1",
            other_food_id="food-2",
            other_family_food_id="food-other-family",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _count(db: Session, model: type) -> int:
    return int(db.scalar(select(func.count()).select_from(model)) or 0)


def _count_meal_create_activities(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count()).select_from(ActivityLog).where(
                ActivityLog.entity_type == "MealLog",
                ActivityLog.action == ActivityAction.CREATE,
            )
        )
        or 0
    )


def _new_payload(seed: RecordingSeed, *, request_id: str = "record-1", servings: float = 1) -> dict:
    return {
        "client_request_id": request_id,
        "date": "2026-07-15",
        "meal_type": "dinner",
        "target": {"kind": "new"},
        "new_foods": [{"client_food_id": "local-1", "name": "酸汤牛肉", "type": "selfMade"}],
        "entries": [
            {"food_id": seed.food_id, "servings": servings},
            {"client_food_id": "local-1", "servings": 2},
        ],
    }


def test_record_creates_two_food_entries_and_inline_food_atomically(seed: RecordingSeed) -> None:
    response = seed.client.post("/api/meal-logs/record", json=_new_payload(seed))
    assert response.status_code == 200
    body = response.json()
    assert body["outcome"] == "created"
    assert len(body["meal_log"]["food_entries"]) == 2
    assert body["meal_log"]["participant_user_ids"] == ["user-owner"]
    assert body["created_foods"][0]["recipe_id"] is None
    assert body["created_foods"][0]["name"] == "酸汤牛肉"
    assert body["operation"]["can_revert"] is True
    assert body["meal_log"]["row_version"] == 1

    with seed.SessionLocal() as db:
        operation = db.get(MealLogRecordOperation, body["operation"]["id"])
        assert operation is not None
        assert operation.meal_log_id == body["meal_log"]["id"]
        assert operation.meal_log_id is not None
        assert len(operation.created_entry_ids_json) == 2
        assert len(operation.created_food_ids_json) == 1
        assert _count(db, MealLog) == 1
        assert _count(db, MealLogFood) == 2
        assert _count(db, Food) == 4  # 3 seeded + 1 inline
        assert _count(db, InventoryItem) == 0
        assert _count(db, FoodPlanItem) == 0
        assert _count(db, RecipeCookLog) == 0


def test_entry_requires_exactly_one_reference(seed: RecordingSeed) -> None:
    both = _new_payload(seed)
    both["entries"] = [{"food_id": seed.food_id, "client_food_id": "local-1", "servings": 1}]
    assert seed.client.post("/api/meal-logs/record", json=both).status_code == 422

    neither = _new_payload(seed)
    neither["entries"] = [{"servings": 1}]
    assert seed.client.post("/api/meal-logs/record", json=neither).status_code == 422


def test_duplicate_client_food_ids_rejected(seed: RecordingSeed) -> None:
    payload = _new_payload(seed)
    payload["new_foods"] = [
        {"client_food_id": "local-1", "name": "酸汤牛肉", "type": "selfMade"},
        {"client_food_id": "local-1", "name": "另一道", "type": "takeout"},
    ]
    payload["entries"] = [{"client_food_id": "local-1", "servings": 1}]
    assert seed.client.post("/api/meal-logs/record", json=payload).status_code == 422


def test_unknown_client_food_reference_rejected(seed: RecordingSeed) -> None:
    payload = _new_payload(seed)
    payload["entries"] = [{"client_food_id": "missing", "servings": 1}]
    assert seed.client.post("/api/meal-logs/record", json=payload).status_code == 422


def test_disallowed_food_type_rejected(seed: RecordingSeed) -> None:
    payload = _new_payload(seed)
    payload["new_foods"] = [{"client_food_id": "local-1", "name": "方便面", "type": "instant"}]
    payload["entries"] = [{"client_food_id": "local-1", "servings": 1}]
    assert seed.client.post("/api/meal-logs/record", json=payload).status_code == 422


def test_trimmed_and_overlong_name(seed: RecordingSeed) -> None:
    payload = _new_payload(seed)
    payload["new_foods"] = [{"client_food_id": "local-1", "name": "  酸汤牛肉  ", "type": "selfMade"}]
    payload["entries"] = [{"client_food_id": "local-1", "servings": 1}]
    ok = seed.client.post("/api/meal-logs/record", json=payload)
    assert ok.status_code == 200
    assert ok.json()["created_foods"][0]["name"] == "酸汤牛肉"

    overlong = _new_payload(seed, request_id="record-overlong")
    overlong["new_foods"] = [{"client_food_id": "local-1", "name": "菜" * 121, "type": "selfMade"}]
    overlong["entries"] = [{"client_food_id": "local-1", "servings": 1}]
    assert seed.client.post("/api/meal-logs/record", json=overlong).status_code == 422


def test_extra_fields_forbidden(seed: RecordingSeed) -> None:
    payload = _new_payload(seed)
    payload["notes"] = "不应接受"
    assert seed.client.post("/api/meal-logs/record", json=payload).status_code == 422

    payload = _new_payload(seed, request_id="record-media")
    payload["media_ids"] = ["photo-1"]
    assert seed.client.post("/api/meal-logs/record", json=payload).status_code == 422

    payload = _new_payload(seed, request_id="record-rating")
    payload["entries"] = [{"food_id": seed.food_id, "servings": 1, "rating": 5}]
    assert seed.client.post("/api/meal-logs/record", json=payload).status_code == 422


def test_cross_family_food_rejected(seed: RecordingSeed) -> None:
    payload = {
        "client_request_id": "record-cross-food",
        "date": "2026-07-15",
        "meal_type": "dinner",
        "target": {"kind": "new"},
        "new_foods": [],
        "entries": [{"food_id": seed.other_family_food_id, "servings": 1}],
    }
    response = seed.client.post("/api/meal-logs/record", json=payload)
    assert response.status_code == 404


def test_duplicate_final_food_on_existing_target_rejected(seed: RecordingSeed) -> None:
    create = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-base",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {"kind": "new"},
            "new_foods": [],
            "entries": [{"food_id": seed.food_id, "servings": 1}],
        },
    )
    assert create.status_code == 200
    meal = create.json()["meal_log"]

    dup = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-dup",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {
                "kind": "existing",
                "meal_log_id": meal["id"],
                "expected_row_version": meal["row_version"],
            },
            "new_foods": [],
            "entries": [{"food_id": seed.food_id, "servings": 1}],
        },
    )
    assert dup.status_code == 422
    assert dup.json()["detail"]["code"] == "duplicate_meal_log_food"


def test_append_to_existing_target(seed: RecordingSeed) -> None:
    create = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-create",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {"kind": "new"},
            "new_foods": [],
            "entries": [{"food_id": seed.food_id, "servings": 1}],
        },
    )
    meal = create.json()["meal_log"]
    append = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-append",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {
                "kind": "existing",
                "meal_log_id": meal["id"],
                "expected_row_version": meal["row_version"],
            },
            "new_foods": [{"client_food_id": "local-2", "name": "凉拌黄瓜", "type": "selfMade"}],
            "entries": [{"client_food_id": "local-2", "servings": 1}],
        },
    )
    assert append.status_code == 200
    body = append.json()
    assert body["outcome"] == "appended"
    assert len(body["meal_log"]["food_entries"]) == 2
    assert body["meal_log"]["row_version"] == 2


def test_target_date_type_mismatch(seed: RecordingSeed) -> None:
    create = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-create-mismatch",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {"kind": "new"},
            "new_foods": [],
            "entries": [{"food_id": seed.food_id, "servings": 1}],
        },
    )
    meal = create.json()["meal_log"]
    response = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-mismatch",
            "date": "2026-07-16",
            "meal_type": "dinner",
            "target": {
                "kind": "existing",
                "meal_log_id": meal["id"],
                "expected_row_version": meal["row_version"],
            },
            "new_foods": [],
            "entries": [{"food_id": seed.other_food_id, "servings": 1}],
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "meal_log_date_mismatch"


def test_stale_target_rejected(seed: RecordingSeed) -> None:
    create = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-create-stale",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {"kind": "new"},
            "new_foods": [],
            "entries": [{"food_id": seed.food_id, "servings": 1}],
        },
    )
    meal = create.json()["meal_log"]
    response = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-stale",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {
                "kind": "existing",
                "meal_log_id": meal["id"],
                "expected_row_version": meal["row_version"] + 1,
            },
            "new_foods": [],
            "entries": [{"food_id": seed.other_food_id, "servings": 1}],
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "meal_log_stale"
    assert response.json()["detail"]["current"]["id"] == meal["id"]


def test_cross_family_target_not_found(seed: RecordingSeed) -> None:
    with seed.SessionLocal() as db:
        meal = MealLog(
            id="meal-other",
            family_id=seed.other_family_id,
            date=date(2026, 7, 15),
            meal_type=MealType.DINNER,
            participant_user_ids=["user-other"],
            notes="",
            mood="",
            created_by="user-other",
            updated_by="user-other",
        )
        db.add(meal)
        db.commit()

    response = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-cross-target",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {
                "kind": "existing",
                "meal_log_id": "meal-other",
                "expected_row_version": 1,
            },
            "new_foods": [],
            "entries": [{"food_id": seed.food_id, "servings": 1}],
        },
    )
    assert response.status_code == 404


def test_same_request_and_hash_replays_without_new_side_effects(seed: RecordingSeed) -> None:
    payload = _new_payload(seed)
    first = seed.client.post("/api/meal-logs/record", json=payload)
    second = seed.client.post("/api/meal-logs/record", json=payload)
    assert first.status_code == second.status_code == 200
    assert second.json()["outcome"] == "replayed"
    assert second.json()["meal_log"]["id"] == first.json()["meal_log"]["id"]
    assert second.json()["operation"]["id"] == first.json()["operation"]["id"]

    with seed.SessionLocal() as db:
        assert _count(db, MealLog) == 1
        assert _count(db, MealLogFood) == 2
        assert _count(db, MealLogRecordOperation) == 1
        assert _count_meal_create_activities(db) == 1
        # inline food created once
        assert _count(db, Food) == 4


def test_same_request_id_different_hash_conflicts(seed: RecordingSeed) -> None:
    first = seed.client.post("/api/meal-logs/record", json=_new_payload(seed, servings=1))
    assert first.status_code == 200
    second = seed.client.post("/api/meal-logs/record", json=_new_payload(seed, servings=3))
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "idempotency_key_reused"

    with seed.SessionLocal() as db:
        assert _count(db, MealLog) == 1
        assert _count(db, MealLogFood) == 2
        assert _count(db, MealLogRecordOperation) == 1


def test_replay_after_revert_rejected(seed: RecordingSeed) -> None:
    payload = _new_payload(seed, request_id="record-revert")
    first = seed.client.post("/api/meal-logs/record", json=payload)
    assert first.status_code == 200
    operation_id = first.json()["operation"]["id"]

    with seed.SessionLocal() as db:
        operation = db.get(MealLogRecordOperation, operation_id)
        assert operation is not None
        operation.status = MealLogRecordStatus.REVERTED
        operation.reverted_at = utcnow()
        operation.reverted_by = seed.user_id
        db.commit()

    second = seed.client.post("/api/meal-logs/record", json=payload)
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "record_operation_reverted"

    with seed.SessionLocal() as db:
        assert _count(db, MealLog) == 1
        assert _count(db, MealLogRecordOperation) == 1
        assert _count_meal_create_activities(db) == 1


def test_failed_validation_rolls_back_inline_food(seed: RecordingSeed) -> None:
    create = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-base-rollback",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {"kind": "new"},
            "new_foods": [],
            "entries": [{"food_id": seed.food_id, "servings": 1}],
        },
    )
    meal = create.json()["meal_log"]

    with seed.SessionLocal() as db:
        foods_before = _count(db, Food)
        ops_before = _count(db, MealLogRecordOperation)

    # Append with stale version after attempting to create an inline food.
    failed = seed.client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "record-rollback",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {
                "kind": "existing",
                "meal_log_id": meal["id"],
                "expected_row_version": meal["row_version"] + 5,
            },
            "new_foods": [{"client_food_id": "local-x", "name": "临时菜", "type": "selfMade"}],
            "entries": [{"client_food_id": "local-x", "servings": 1}],
        },
    )
    assert failed.status_code == 409

    with seed.SessionLocal() as db:
        assert _count(db, Food) == foods_before
        assert _count(db, MealLogRecordOperation) == ops_before
        assert _count(db, MealLogFood) == 1


def test_committed_operations_always_have_meal_log_id(seed: RecordingSeed) -> None:
    response = seed.client.post("/api/meal-logs/record", json=_new_payload(seed, request_id="record-nonnull"))
    assert response.status_code == 200
    with seed.SessionLocal() as db:
        ops = list(db.scalars(select(MealLogRecordOperation)))
        assert ops
        assert all(op.meal_log_id for op in ops)
