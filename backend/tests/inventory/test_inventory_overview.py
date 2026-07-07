from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Membership, User


@dataclass(frozen=True)
class InventoryOverviewApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    user_id: str


@pytest.fixture()
def inventory_overview_api_context() -> Iterator[InventoryOverviewApiContext]:
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
        family = Family(id="family-overview", name="库存总览家庭", motto="", location="")
        user = User(id="user-overview", username="overview-user", display_name="库存总览用户", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-overview",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        db.add_all([family, user, membership])
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    def override_auth() -> tuple[User, Membership]:
        with SessionLocal() as db:
            user = db.get(User, "user-overview")
            membership = db.get(Membership, "membership-overview")
            assert user is not None
            assert membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield InventoryOverviewApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-overview",
            user_id="user-overview",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_inventory_overview_returns_ingredient_and_ready_food_stock(
    inventory_overview_api_context: InventoryOverviewApiContext,
) -> None:
    from app.core.enums import InventoryStatus
    from app.models.domain import Food, Ingredient, InventoryItem

    with inventory_overview_api_context.SessionLocal() as db:
        tomato = Ingredient(
            id="ingredient-overview-tomato",
            family_id=inventory_overview_api_context.family_id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode="none",
            notes="",
            created_by=inventory_overview_api_context.user_id,
            updated_by=inventory_overview_api_context.user_id,
        )
        tomato_batch = InventoryItem(
            id="inventory-overview-tomato",
            family_id=inventory_overview_api_context.family_id,
            ingredient_id=tomato.id,
            quantity=Decimal("3"),
            consumed_quantity=Decimal("1"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("3"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 1),
            expiry_date=date(2026, 7, 10),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("1"),
            created_by=inventory_overview_api_context.user_id,
            updated_by=inventory_overview_api_context.user_id,
        )
        yogurt = Food(
            id="food-overview-yogurt",
            family_id=inventory_overview_api_context.family_id,
            name="蓝莓酸奶",
            type="readyMade",
            category="饮品",
            flavor_tags=[],
            scene_tags=["早餐"],
            suitable_meal_types=["breakfast"],
            source_name="超市",
            purchase_source="盒马",
            scene="",
            notes="",
            routine_note="早餐备用",
            stock_quantity=Decimal("2"),
            stock_unit="盒",
            expiry_date=date(2026, 7, 8),
            favorite=False,
            created_by=inventory_overview_api_context.user_id,
            updated_by=inventory_overview_api_context.user_id,
        )
        takeout = Food(
            id="food-overview-takeout",
            family_id=inventory_overview_api_context.family_id,
            name="常点牛肉饭",
            type="takeout",
            category="外卖",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["lunch"],
            source_name="楼下店",
            purchase_source="美团",
            scene="",
            notes="",
            routine_note="",
            stock_quantity=Decimal("3"),
            stock_unit="份",
            expiry_date=date(2026, 7, 8),
            favorite=False,
            created_by=inventory_overview_api_context.user_id,
            updated_by=inventory_overview_api_context.user_id,
        )
        db.add_all([tomato, tomato_batch, yogurt, takeout])
        db.commit()

    response = inventory_overview_api_context.client.get("/api/inventory/overview?scope=all")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["summary"]["total_count"] == 2
    assert payload["summary"]["ingredient_count"] == 1
    assert payload["summary"]["food_count"] == 1
    assert [item["source_type"] for item in payload["items"]] == ["food", "ingredient"]
    assert payload["items"][0]["source_id"] == "food-overview-yogurt"
    assert payload["items"][0]["title"] == "蓝莓酸奶"
    assert payload["items"][0]["quantity_label"] == "2盒"
    assert payload["items"][0]["primary_action"] == "record_meal"
    assert payload["items"][1]["source_id"] == "ingredient-overview-tomato"
    assert payload["items"][1]["quantity_label"] == "2个"


def test_inventory_overview_filters_scope_and_query(
    inventory_overview_api_context: InventoryOverviewApiContext,
) -> None:
    from app.models.domain import Food

    with inventory_overview_api_context.SessionLocal() as db:
        yogurt = Food(
            id="food-overview-query-yogurt",
            family_id=inventory_overview_api_context.family_id,
            name="蓝莓酸奶",
            type="instant",
            category="速食",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["breakfast"],
            source_name="便利店",
            purchase_source="便利店",
            scene="",
            notes="",
            routine_note="",
            stock_quantity=Decimal("1"),
            stock_unit="盒",
            expiry_date=date.today() + timedelta(days=3),
            favorite=False,
            created_by=inventory_overview_api_context.user_id,
            updated_by=inventory_overview_api_context.user_id,
        )
        freezer = Food(
            id="food-overview-query-dumpling",
            family_id=inventory_overview_api_context.family_id,
            name="速冻饺子",
            type="instant",
            category="速冻食品",
            flavor_tags=[],
            scene_tags=[],
            suitable_meal_types=["dinner"],
            source_name="超市",
            purchase_source="超市",
            scene="",
            notes="",
            routine_note="",
            stock_quantity=Decimal("2"),
            stock_unit="袋",
            expiry_date=date.today() + timedelta(days=20),
            favorite=False,
            created_by=inventory_overview_api_context.user_id,
            updated_by=inventory_overview_api_context.user_id,
        )
        db.add_all([yogurt, freezer])
        db.commit()

    response = inventory_overview_api_context.client.get("/api/inventory/overview?scope=food&q=酸奶")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["summary"]["total_count"] == 1
    assert payload["items"][0]["source_type"] == "food"
    assert payload["items"][0]["source_id"] == "food-overview-query-yogurt"
