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


def test_record_append_versus_revert_no_deadlock(mysql_concurrency_context: dict) -> None:
    """One transaction appends while another reverts an operation touching the same MealLog/Food."""
    ctx = mysql_concurrency_context
    client: TestClient = ctx["client"]

    base = client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "mysql-base-for-race",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {"kind": "new"},
            "new_foods": [],
            "entries": [{"food_id": ctx["food_id"], "servings": 1}],
        },
    )
    assert base.status_code == 200, base.text
    meal = base.json()["meal_log"]

    append = client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "mysql-append-for-race",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {
                "kind": "existing",
                "meal_log_id": meal["id"],
                "expected_row_version": meal["row_version"],
            },
            "new_foods": [{"client_food_id": "local-race", "name": "并发菜", "type": "selfMade"}],
            "entries": [{"client_food_id": "local-race", "servings": 1}],
        },
    )
    assert append.status_code == 200, append.text
    operation_id = append.json()["operation"]["id"]
    meal_id = append.json()["meal_log"]["id"]
    version = append.json()["meal_log"]["row_version"]
    created_food_id = append.json()["created_foods"][0]["id"]

    # Seed a second existing Food so append can race without depending on the created food.
    with ctx["SessionLocal"]() as db:
        extra = Food(
            id="food-meal-mysql-extra",
            family_id=ctx["family_id"],
            name="并发追加菜",
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
            created_by=ctx["user_id"],
            updated_by=ctx["user_id"],
        )
        db.add(extra)
        db.commit()

    def append_worker() -> dict:
        response = client.post(
            "/api/meal-logs/record",
            json={
                "client_request_id": "mysql-append-race-worker",
                "date": "2026-07-15",
                "meal_type": "dinner",
                "target": {
                    "kind": "existing",
                    "meal_log_id": meal_id,
                    "expected_row_version": version,
                },
                "new_foods": [],
                "entries": [{"food_id": "food-meal-mysql-extra", "servings": 1}],
            },
        )
        return {"name": "append", "status_code": response.status_code, "body": response.json()}

    def revert_worker() -> dict:
        response = client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
        return {"name": "revert", "status_code": response.status_code, "body": response.json()}

    results = _run_barriered([append_worker, revert_worker])
    by_name = {item["name"]: item for item in results}
    assert by_name["append"]["status_code"] in {200, 409}, results
    assert by_name["revert"]["status_code"] == 200, results

    with ctx["SessionLocal"]() as db:
        meal_row = db.get(MealLog, meal_id)
        assert meal_row is not None
        entries = list(db.scalars(select(MealLogFood).where(MealLogFood.meal_log_id == meal_id)))
        # Base entry must remain; append effect entries removed; concurrent append may or may not land.
        food_ids = {entry.food_id for entry in entries}
        assert ctx["food_id"] in food_ids
        # Every remaining entry Food must exist.
        for entry in entries:
            assert db.get(Food, entry.food_id) is not None
        op = db.get(MealLogRecordOperation, operation_id)
        assert op is not None
        assert op.status.value == "reverted" or str(op.status) == "reverted"
        # Created Food may be deleted only if unused; if concurrent append reused it (it doesn't),
        # remaining entries must not reference a missing Food.
        if created_food_id in food_ids:
            assert db.get(Food, created_food_id) is not None


def test_reuse_created_food_versus_revert_no_deadlock(mysql_concurrency_context: dict) -> None:
    """One transaction reuses a just-created minimal Food while another reverts its creator."""
    ctx = mysql_concurrency_context
    client: TestClient = ctx["client"]

    created = client.post(
        "/api/meal-logs/record",
        json={
            "client_request_id": "mysql-create-for-reuse",
            "date": "2026-07-15",
            "meal_type": "dinner",
            "target": {"kind": "new"},
            "new_foods": [{"client_food_id": "local-reuse", "name": "可复用菜", "type": "selfMade"}],
            "entries": [{"client_food_id": "local-reuse", "servings": 1}],
        },
    )
    assert created.status_code == 200, created.text
    operation_id = created.json()["operation"]["id"]
    meal_id = created.json()["meal_log"]["id"]
    created_food_id = created.json()["created_foods"][0]["id"]

    def reuse_worker() -> dict:
        response = client.post(
            "/api/meal-logs/record",
            json={
                "client_request_id": "mysql-reuse-worker",
                "date": "2026-07-16",
                "meal_type": "lunch",
                "target": {"kind": "new"},
                "new_foods": [],
                "entries": [{"food_id": created_food_id, "servings": 1}],
            },
        )
        return {"name": "reuse", "status_code": response.status_code, "body": response.json()}

    def revert_worker() -> dict:
        response = client.post(f"/api/meal-logs/record-operations/{operation_id}/revert")
        return {"name": "revert", "status_code": response.status_code, "body": response.json()}

    results = _run_barriered([reuse_worker, revert_worker])
    by_name = {item["name"]: item for item in results}
    assert by_name["reuse"]["status_code"] in {200, 404, 409}, results
    assert by_name["revert"]["status_code"] == 200, results

    with ctx["SessionLocal"]() as db:
        # All remaining MealLogFood rows must reference existing Foods.
        entries = list(db.scalars(select(MealLogFood)))
        for entry in entries:
            assert db.get(Food, entry.food_id) is not None, entry.id

        reuse_ok = by_name["reuse"]["status_code"] == 200
        food = db.get(Food, created_food_id)
        if reuse_ok:
            # Food reused by the winning record must never be deleted.
            assert food is not None
            reuse_meal_id = by_name["reuse"]["body"]["meal_log"]["id"]
            reuse_entries = list(
                db.scalars(select(MealLogFood).where(MealLogFood.meal_log_id == reuse_meal_id))
            )
            assert any(entry.food_id == created_food_id for entry in reuse_entries)
        else:
            # Revert may have deleted the Food before reuse, causing 404; original meal should be gone
            # or emptied of the effect entries.
            original = db.get(MealLog, meal_id)
            if original is not None:
                original_entries = list(
                    db.scalars(select(MealLogFood).where(MealLogFood.meal_log_id == meal_id))
                )
                assert all(entry.food_id != created_food_id or food is not None for entry in original_entries)

        op = db.get(MealLogRecordOperation, operation_id)
        assert op is not None
        assert op.status.value == "reverted" or str(op.status) == "reverted"
