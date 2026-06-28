from __future__ import annotations

from datetime import date
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import Session, sessionmaker

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.main import app
from app.core.enums import FoodType, MealType
from app.models.domain import Base, Family, Food, FoodPlanItem, Ingredient, User
from app.services.search.documents import build_ingredient_search_document, build_meal_plan_search_document
from app.services.search.indexing import upsert_search_document


def _search_test_client() -> tuple[TestClient, sessionmaker[Session]]:
    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True, class_=Session)

    with SessionLocal() as db:
        family = Family(id="family-1", name="一号家庭")
        other_family = Family(id="family-2", name="二号家庭")
        user = User(id="user-1", username="user1", display_name="用户一", email="user1@example.com")
        other_user = User(id="user-2", username="user2", display_name="用户二", email="user2@example.com")
        ingredient = Ingredient(
            id="ingredient-tomato",
            family_id=family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            default_storage="冷藏",
            notes="适合快手晚餐",
        )
        other_ingredient = Ingredient(
            id="ingredient-other",
            family_id=other_family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            default_storage="冷藏",
        )
        food = Food(
            id="food-noodle",
            family_id=family.id,
            name="番茄面",
            type=FoodType.SELF_MADE,
            category="主食",
        )
        own_plan = FoodPlanItem(
            id="plan-own",
            family_id=family.id,
            user_id=user.id,
            food_id=food.id,
            food=food,
            plan_date=date(2026, 6, 29),
            meal_type=MealType.DINNER,
            note="晚餐安排",
            status="planned",
        )
        other_user_plan = FoodPlanItem(
            id="plan-other-user",
            family_id=family.id,
            user_id=other_user.id,
            food_id=food.id,
            food=food,
            plan_date=date(2026, 6, 29),
            meal_type=MealType.DINNER,
            note="晚餐安排",
            status="planned",
        )
        db.add_all([family, other_family, user, other_user, ingredient, other_ingredient, food, own_plan, other_user_plan])
        db.flush()
        upsert_search_document(db, build_ingredient_search_document(ingredient))
        upsert_search_document(db, build_ingredient_search_document(other_ingredient))
        upsert_search_document(db, build_meal_plan_search_document(own_plan))
        upsert_search_document(db, build_meal_plan_search_document(other_user_plan))
        db.commit()

    def override_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth():
        return SimpleNamespace(id="user-1"), SimpleNamespace(family_id="family-1")

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    return TestClient(app), SessionLocal


def test_search_api_returns_family_scoped_keyword_results() -> None:
    client, _ = _search_test_client()
    try:
        response = client.get("/api/search", params={"q": "番茄", "scopes": "ingredients"})
        ingredient_list_response = client.get("/api/ingredients", params={"q": "快手晚餐", "limit": 10})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["search_mode"] == "hybrid"
    assert payload["degraded"] is True
    assert payload["total"] == 1
    assert payload["items"][0]["entity_type"] == "ingredient"
    assert payload["items"][0]["entity_id"] == "ingredient-tomato"
    assert payload["items"][0]["entity"]["name"] == "番茄"
    assert payload["items"][0]["match_reason"][:1] == ["名称匹配"]

    assert ingredient_list_response.status_code == 200
    assert [item["id"] for item in ingredient_list_response.json()] == ["ingredient-tomato"]


def test_search_api_rejects_unknown_scope() -> None:
    client, _ = _search_test_client()
    try:
        response = client.get("/api/search", params={"q": "番茄", "scopes": "recipes,unknown"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 400
    assert response.json()["detail"] == "不支持的搜索范围：unknown"


def test_search_api_returns_only_current_user_meal_plan_results() -> None:
    client, _ = _search_test_client()
    try:
        response = client.get("/api/search", params={"q": "晚餐安排", "scopes": "meal_plan"})
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert [item["entity_id"] for item in payload["items"]] == ["plan-own"]
    assert payload["items"][0]["entity_type"] == "meal_plan"
    assert payload["items"][0]["entity"]["food_name"] == "番茄面"


def test_search_api_enforces_pagination_bounds() -> None:
    client, _ = _search_test_client()
    try:
        too_large_limit = client.get("/api/search", params={"q": "番茄", "limit": 51})
        too_large_offset = client.get("/api/search", params={"q": "番茄", "offset": 501})
    finally:
        app.dependency_overrides.clear()

    assert too_large_limit.status_code == 422
    assert too_large_offset.status_code == 422
