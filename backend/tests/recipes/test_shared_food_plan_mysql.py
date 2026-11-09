from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date
from threading import Barrier
from unittest.mock import patch

import pytest
from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import FoodType, MealType, MembershipStatus, UserRole
from app.models.domain import Family, Food, FoodPlanItem, MealLog, Membership, User
from app.services import food_plan_completion
from app.services.food_plan_completion import CompleteFoodPlanItemCommand, complete_food_plan_item
from app.services.food_plan_locking import FoodPlanConflict
from tests.model_usage.test_migration_mysql import MySqlAlembicDatabase, require_model_usage_mysql_url


pytestmark = pytest.mark.mysql


@pytest.fixture()
def shared_plan_database():
    database = MySqlAlembicDatabase.from_test_url(require_model_usage_mysql_url())
    database.recreate()
    try:
        database.upgrade("c5d6e7f8a9b0")
        engine = database.engine
        sessions = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
        with sessions() as db:
            db.add(Family(id="shared-family", name="共享家庭"))
            db.add_all([
                User(id=actor_id, username=actor_id, display_name=actor_id)
                for actor_id in ("creator", "member")
            ])
            db.flush()
            db.add_all([
                Membership(
                    id=f"membership-{actor_id}", family_id="shared-family", user_id=actor_id,
                    role=UserRole.MEMBER, status=MembershipStatus.ACTIVE,
                )
                for actor_id in ("creator", "member")
            ])
            db.add(Food(id="shared-food", family_id="shared-family", name="牛奶", type=FoodType.INSTANT))
            db.flush()
            db.add(FoodPlanItem(
                id="shared-plan", family_id="shared-family", user_id="creator", food_id="shared-food",
                plan_date=date(2099, 5, 20), meal_type=MealType.DINNER,
                note="历史家庭安排", status="planned", created_by="creator", updated_by="creator",
            ))
            db.commit()
        yield database, sessions, engine
    finally:
        if "engine" in locals():
            engine.dispose()
        database.dispose()


def test_shared_plan_migration_preserves_legacy_data_and_creator_deletion(shared_plan_database) -> None:
    database, sessions, engine = shared_plan_database
    database.upgrade("head")
    database.upgrade("head")
    assert database.current_revision() == "d6e7f8a9b0c1"
    creator_column = next(column for column in inspect(engine).get_columns("food_plan_items") if column["name"] == "user_id")
    assert creator_column["nullable"]
    creator_fk = next(fk for fk in inspect(engine).get_foreign_keys("food_plan_items") if fk["constrained_columns"] == ["user_id"])
    assert creator_fk["options"]["ondelete"] == "SET NULL"
    with engine.begin() as connection:
        connection.execute(text("DELETE FROM users WHERE id = 'creator'"))
    with sessions() as db:
        item = db.get(FoodPlanItem, "shared-plan")
        assert item is not None
        assert item.user_id is None
        assert item.created_by == "creator"
        assert item.note == "历史家庭安排"
    with pytest.raises(RuntimeError, match="no creator"):
        database.downgrade("c5d6e7f8a9b0")
    assert database.current_revision() == "d6e7f8a9b0c1"


def test_shared_plan_migration_round_trip_keeps_existing_plan(shared_plan_database) -> None:
    database, sessions, engine = shared_plan_database
    database.upgrade("head")
    database.downgrade("c5d6e7f8a9b0")
    creator_column = next(column for column in inspect(engine).get_columns("food_plan_items") if column["name"] == "user_id")
    assert not creator_column["nullable"]
    with sessions() as db:
        assert db.get(FoodPlanItem, "shared-plan").user_id == "creator"
    database.upgrade("head")


def test_two_family_members_completing_one_plan_never_create_two_meals(shared_plan_database) -> None:
    database, sessions, _ = shared_plan_database
    database.upgrade("head")
    with sessions() as db:
        base_updated_at = db.get(FoodPlanItem, "shared-plan").updated_at
    command = CompleteFoodPlanItemCommand(
        family_id="shared-family", actor_user_id="creator", item_id="shared-plan",
        food_plan_item_base_updated_at=base_updated_at,
    )
    barrier = Barrier(2, timeout=15)
    original_discover = food_plan_completion._load_plan_item_unlocked

    def synchronized_discover(db: Session, **kwargs):
        item = original_discover(db, **kwargs)
        barrier.wait()
        return item

    def complete_as(actor_id: str) -> str:
        with sessions() as db:
            try:
                result = complete_food_plan_item(db, replace(command, actor_user_id=actor_id))
                db.commit()
                return result["id"]
            except FoodPlanConflict as exc:
                db.rollback()
                assert exc.code == "food_plan_item_already_completed"
                assert exc.meal_log_id is not None
                return exc.meal_log_id

    with patch.object(food_plan_completion, "_load_plan_item_unlocked", side_effect=synchronized_discover):
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(complete_as, actor_id) for actor_id in ("creator", "member")]
            meal_ids = [future.result(timeout=25) for future in futures]

    assert len(set(meal_ids)) == 1
    with sessions() as db:
        assert db.scalar(select(func.count(MealLog.id))) == 1
        assert db.get(FoodPlanItem, "shared-plan").meal_log_id == meal_ids[0]
        assert complete_food_plan_item(db, replace(command, actor_user_id="member"))["id"] == meal_ids[0]
