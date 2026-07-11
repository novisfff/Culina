from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, IngredientExpiryMode, IngredientQuantityTrackingMode, InventoryStatus, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import ActivityLog, Base, Family, Ingredient, InventoryItem, Membership, User
from app.services.clock import today_for_family
from tests._transaction_failure import fail_next_commit


@dataclass(frozen=True)
class InventoryApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    user_id: str
    other_user_id: str
    membership_id: str
    ingredient_id: str
    other_ingredient_id: str
    item_id: str
    other_item_id: str


@pytest.fixture()
def inventory_api_context() -> Iterator[InventoryApiContext]:
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
    today = today_for_family("family-inventory")

    with SessionLocal() as db:
        family = Family(id="family-inventory", name="库存家庭", motto="", location="")
        other_family = Family(id="family-other", name="其他家庭", motto="", location="")
        user = User(id="user-inventory", username="inventory-user", display_name="库存用户", avatar_seed="", is_active=True)
        other_user = User(id="user-other", username="other-inventory-user", display_name="其他用户", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-inventory",
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
        ingredient = Ingredient(
            id="ingredient-own",
            family_id=family.id,
            name="番茄",
            category="蔬菜",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        other_ingredient = Ingredient(
            id="ingredient-other",
            family_id=other_family.id,
            name="鸡蛋",
            category="蛋奶",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        own_item = InventoryItem(
            id="inventory-own",
            family_id=family.id,
            ingredient_id=ingredient.id,
            ingredient=ingredient,
            quantity=Decimal("10"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("10"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today,
            expiry_date=today + timedelta(days=5),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("2"),
            created_by=user.id,
            updated_by=user.id,
        )
        other_item = InventoryItem(
            id="inventory-other",
            family_id=other_family.id,
            ingredient_id=other_ingredient.id,
            ingredient=other_ingredient,
            quantity=Decimal("12"),
            consumed_quantity=Decimal("0"),
            disposed_quantity=Decimal("0"),
            unit="个",
            entered_quantity=Decimal("12"),
            entered_unit="个",
            status=InventoryStatus.FRESH,
            purchase_date=today,
            expiry_date=today + timedelta(days=5),
            storage_location="冷藏",
            notes="",
            low_stock_threshold=Decimal("2"),
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        db.add_all(
            [
                family,
                other_family,
                user,
                other_user,
                membership,
                other_membership,
                ingredient,
                other_ingredient,
                own_item,
                other_item,
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
            user = db.get(User, "user-inventory")
            membership = db.get(Membership, "membership-inventory")
            assert user is not None
            assert membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield InventoryApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-inventory",
            other_family_id="family-other",
            user_id="user-inventory",
            other_user_id="user-other",
            membership_id="membership-inventory",
            ingredient_id="ingredient-own",
            other_ingredient_id="ingredient-other",
            item_id="inventory-own",
            other_item_id="inventory-other",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_list_inventory_returns_only_current_family_items(inventory_api_context: InventoryApiContext) -> None:
    response = inventory_api_context.client.get("/api/inventory")

    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload] == [inventory_api_context.item_id]
    assert payload[0]["family_id"] == inventory_api_context.family_id
    assert payload[0]["ingredient_name"] == "番茄"
    assert payload[0]["row_version"] == 1
    assert payload[0]["expiry_alert_snoozed_until"] is None
    assert payload[0]["expiry_reviewed_at"] is None
    assert payload[0]["expiry_reviewed_by"] is None


def test_create_inventory_item_sets_audit_fields_and_activity_log(inventory_api_context: InventoryApiContext) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "quantity": 4,
            "unit": "个",
            "status": "fresh",
            "purchase_date": "2026-06-28",
            "expiry_date": "2026-07-03",
            "storage_location": "冷藏",
            "notes": "周末采购",
            "low_stock_threshold": 1,
        },
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["family_id"] == inventory_api_context.family_id
    assert payload["ingredient_id"] == inventory_api_context.ingredient_id
    assert payload["created_by"] == inventory_api_context.user_id
    assert payload["updated_by"] == inventory_api_context.user_id
    assert payload["row_version"] == 1
    assert payload["expiry_alert_snoozed_until"] is None
    assert payload["expiry_reviewed_at"] is None
    assert payload["expiry_reviewed_by"] is None

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, payload["id"])
        assert item is not None
        assert item.family_id == inventory_api_context.family_id
        assert item.created_by == inventory_api_context.user_id
        assert item.updated_by == inventory_api_context.user_id

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == inventory_api_context.family_id,
                ActivityLog.actor_id == inventory_api_context.user_id,
                ActivityLog.action == ActivityAction.CREATE,
                ActivityLog.entity_type == "InventoryItem",
                ActivityLog.entity_id == item.id,
            )
        )
        assert log is not None
        assert log.summary == "录入库存 番茄 4个"


def test_create_inventory_item_rejects_other_family_ingredient_without_side_effects(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory",
        json={
            "ingredient_id": inventory_api_context.other_ingredient_id,
            "quantity": 6,
            "unit": "个",
            "status": "fresh",
            "purchase_date": "2026-06-28",
            "expiry_date": "2026-07-03",
            "storage_location": "冷藏",
            "notes": "不应创建",
            "low_stock_threshold": 1,
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Ingredient not found"

    with inventory_api_context.SessionLocal() as db:
        created = db.scalar(
            select(InventoryItem).where(
                InventoryItem.family_id == inventory_api_context.family_id,
                InventoryItem.ingredient_id == inventory_api_context.other_ingredient_id,
            )
        )
        assert created is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "录入库存 鸡蛋 6个")) is None


def test_consume_inventory_updates_current_family_batch_and_activity_log(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/consume",
        json={
            "ingredient_id": inventory_api_context.ingredient_id,
            "quantity": 3,
            "unit": "个",
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "ingredient_id": inventory_api_context.ingredient_id,
        "unit": "个",
        "consumed_quantity": 3.0,
        "affected_item_ids": [inventory_api_context.item_id],
    }

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        assert item.consumed_quantity == Decimal("3")
        assert item.updated_by == inventory_api_context.user_id

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == inventory_api_context.family_id,
                ActivityLog.actor_id == inventory_api_context.user_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "Ingredient",
                ActivityLog.entity_id == inventory_api_context.ingredient_id,
            )
        )
        assert log is not None
        assert log.summary == "消费食材 番茄 3个"


def test_consume_inventory_rolls_back_deduction_when_commit_fails(inventory_api_context: InventoryApiContext) -> None:
    with fail_next_commit("inventory commit failed"):
        with pytest.raises(RuntimeError, match="inventory commit failed"):
            inventory_api_context.client.post(
                "/api/inventory/consume",
                json={
                    "ingredient_id": inventory_api_context.ingredient_id,
                    "quantity": 3,
                    "unit": "个",
                },
            )

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        assert item.consumed_quantity == Decimal("0")
        assert item.updated_by == inventory_api_context.user_id
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "消费食材 番茄 3个")) is None


def test_consume_inventory_rejects_other_family_ingredient_without_side_effects(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/consume",
        json={
            "ingredient_id": inventory_api_context.other_ingredient_id,
            "quantity": 3,
            "unit": "个",
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Ingredient not found"

    with inventory_api_context.SessionLocal() as db:
        other_item = db.get(InventoryItem, inventory_api_context.other_item_id)
        assert other_item is not None
        assert other_item.consumed_quantity == Decimal("0")
        assert other_item.updated_by == inventory_api_context.other_user_id
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "消费食材 鸡蛋 3个")) is None


def test_dispose_inventory_updates_current_family_batch_and_activity_log(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": inventory_api_context.item_id,
            "quantity": 2,
            "unit": "个",
            "reason": "坏掉",
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload == {
        "ingredient_id": inventory_api_context.ingredient_id,
        "inventory_item_id": inventory_api_context.item_id,
        "unit": "个",
        "disposed_quantity": 2.0,
        "remaining_quantity": 8.0,
    }

    with inventory_api_context.SessionLocal() as db:
        item = db.get(InventoryItem, inventory_api_context.item_id)
        assert item is not None
        assert item.disposed_quantity == Decimal("2")
        assert item.updated_by == inventory_api_context.user_id

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == inventory_api_context.family_id,
                ActivityLog.actor_id == inventory_api_context.user_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "InventoryItem",
                ActivityLog.entity_id == inventory_api_context.item_id,
            )
        )
        assert log is not None
        assert log.summary == "销毁库存 番茄 2个：坏掉"


def test_dispose_inventory_rejects_other_family_item_without_modifying_it(
    inventory_api_context: InventoryApiContext,
) -> None:
    response = inventory_api_context.client.post(
        "/api/inventory/dispose",
        json={
            "inventory_item_id": inventory_api_context.other_item_id,
            "quantity": 2,
            "unit": "个",
            "reason": "坏掉",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "库存批次不存在或不属于当前家庭"

    with inventory_api_context.SessionLocal() as db:
        other_item = db.get(InventoryItem, inventory_api_context.other_item_id)
        assert other_item is not None
        assert other_item.disposed_quantity == Decimal("0")
        assert other_item.updated_by == inventory_api_context.other_user_id
        assert (
            db.scalar(
                select(ActivityLog).where(
                    ActivityLog.family_id == inventory_api_context.family_id,
                    ActivityLog.entity_id == inventory_api_context.other_item_id,
                )
            )
            is None
        )


def test_inventory_requires_authentication(inventory_api_context: InventoryApiContext) -> None:
    app.dependency_overrides.pop(get_current_auth, None)

    response = inventory_api_context.client.get("/api/inventory")

    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"
