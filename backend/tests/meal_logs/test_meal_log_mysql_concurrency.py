from __future__ import annotations

import os
import threading
from collections.abc import Callable, Iterator
from typing import Any
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.deps import get_current_auth
from app.core.enums import FoodType, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import (
    Base,
    Family,
    Food,
    MealLog,
    MealLogFood,
    MealLogRecordOperation,
    Membership,
    User,
)


def _require_test_mysql_url() -> str:
    url = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not url:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    parsed = urlparse(url)
    database = (parsed.path or "").lstrip("/")
    if not database:
        pytest.fail("CULINA_TEST_MYSQL_URL must include a database name ending in _test")
    if not database.endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


def _run_barriered(
    workers: list[Callable[[], Any]],
    *,
    timeout: float = 25.0,
) -> list[Any]:
    barrier = threading.Barrier(len(workers), timeout=timeout)
    results: list[Any] = [None] * len(workers)
    errors: list[BaseException] = []

    def _wrap(index: int, worker: Callable[[], Any]) -> None:
        try:
            barrier.wait(timeout=timeout)
            results[index] = worker()
        except BaseException as exc:  # noqa: BLE001 - collect for re-raise after join
            errors.append(exc)

    threads = [
        threading.Thread(target=_wrap, args=(index, worker), daemon=True)
        for index, worker in enumerate(workers)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout + 5)
        if thread.is_alive():
            pytest.fail("barriered concurrency worker hung / deadlocked")
    if errors:
        raise errors[0]
    return results


@pytest.fixture()
def mysql_concurrency_context() -> Iterator[dict]:
    url = _require_test_mysql_url()
    engine = create_engine(url, poolclass=NullPool, future=True, pool_pre_ping=True)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    family_id = "family-meal-mysql"
    user_id = "user-meal-mysql"
    membership_id = "membership-meal-mysql"
    food_id = "food-meal-mysql"

    with SessionLocal() as db:
        family = Family(id=family_id, name="餐食并发家庭", motto="", location="")
        user = User(
            id=user_id,
            username="meal-mysql-user",
            display_name="餐食并发用户",
            avatar_seed="",
            is_active=True,
        )
        membership = Membership(
            id=membership_id,
            family_id=family.id,
            user_id=user.id,
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
        food = Food(
            id=food_id,
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
            created_by=user.id,
            updated_by=user.id,
        )
        db.add_all([family, user, membership, food])
        db.commit()

    def override_db() -> Iterator[Session]:
        with SessionLocal() as session:
            yield session

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as session:
            user_row = session.get(User, user_id)
            membership_row = session.get(Membership, membership_id)
            assert user_row is not None and membership_row is not None
            return user_row, membership_row

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield {
            "client": TestClient(app),
            "SessionLocal": SessionLocal,
            "family_id": family_id,
            "user_id": user_id,
            "food_id": food_id,
            "engine": engine,
        }
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_concurrent_identical_new_target_request_converges(mysql_concurrency_context: dict) -> None:
    ctx = mysql_concurrency_context
    client: TestClient = ctx["client"]
    payload = {
        "client_request_id": "concurrent-record-1",
        "date": "2026-07-15",
        "meal_type": "dinner",
        "target": {"kind": "new"},
        "new_foods": [{"client_food_id": "local-1", "name": "酸汤牛肉", "type": "selfMade"}],
        "entries": [
            {"food_id": ctx["food_id"], "servings": 1},
            {"client_food_id": "local-1", "servings": 2},
        ],
    }

    def worker() -> dict:
        response = client.post("/api/meal-logs/record", json=payload)
        return {"status_code": response.status_code, "body": response.json()}

    results = _run_barriered([worker, worker])
    assert all(item["status_code"] == 200 for item in results)
    meal_ids = {item["body"]["meal_log"]["id"] for item in results}
    operation_ids = {item["body"]["operation"]["id"] for item in results}
    assert len(meal_ids) == 1
    assert len(operation_ids) == 1
    winner_meal_id = next(iter(meal_ids))
    outcomes = {item["body"]["outcome"] for item in results}
    assert outcomes <= {"created", "replayed"}
    assert "created" in outcomes or "replayed" in outcomes

    with ctx["SessionLocal"]() as db:
        meal_count = int(db.scalar(select(func.count()).select_from(MealLog)) or 0)
        entry_count = int(db.scalar(select(func.count()).select_from(MealLogFood)) or 0)
        op_count = int(db.scalar(select(func.count()).select_from(MealLogRecordOperation)) or 0)
        food_count = int(db.scalar(select(func.count()).select_from(Food)) or 0)
        operations = list(db.scalars(select(MealLogRecordOperation)))
        meals = list(db.scalars(select(MealLog)))
        assert meal_count == 1
        assert entry_count == 2
        assert op_count == 1
        assert food_count == 2  # seeded + one inline
        assert operations[0].meal_log_id == meals[0].id == winner_meal_id
        # Loser must not leave an independently preallocated meal id anywhere.
        all_meal_ids = {meal.id for meal in meals}
        all_op_meal_ids = {op.meal_log_id for op in operations}
        assert all_meal_ids == {winner_meal_id}
        assert all_op_meal_ids == {winner_meal_id}
