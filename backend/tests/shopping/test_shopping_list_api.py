from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, IngredientExpiryMode, IngredientQuantityTrackingMode, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import ActivityLog, Base, Family, Ingredient, Membership, ShoppingListItem, User
from tests._transaction_failure import fail_next_commit


@dataclass(frozen=True)
class ShoppingApiContext:
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
def shopping_api_context() -> Iterator[ShoppingApiContext]:
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
        family = Family(id="family-shopping", name="购物家庭", motto="", location="")
        other_family = Family(id="family-other", name="其他家庭", motto="", location="")
        user = User(id="user-shopping", username="shopper", display_name="采购员", avatar_seed="", is_active=True)
        other_user = User(id="user-other", username="other-shopper", display_name="其他用户", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-shopping",
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
            notes="",
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        own_item = ShoppingListItem(
            id="shopping-own",
            family_id=family.id,
            ingredient_id=ingredient.id,
            title="番茄",
            quantity=Decimal("2"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="晚餐",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        other_item = ShoppingListItem(
            id="shopping-other",
            family_id=other_family.id,
            ingredient_id=other_ingredient.id,
            title="鸡蛋",
            quantity=Decimal("6"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="早餐",
            done=False,
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
            user = db.get(User, "user-shopping")
            membership = db.get(Membership, "membership-shopping")
            assert user is not None
            assert membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth

    try:
        yield ShoppingApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-shopping",
            other_family_id="family-other",
            user_id="user-shopping",
            other_user_id="user-other",
            membership_id="membership-shopping",
            ingredient_id="ingredient-own",
            other_ingredient_id="ingredient-other",
            item_id="shopping-own",
            other_item_id="shopping-other",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_list_shopping_items_returns_only_current_family(shopping_api_context: ShoppingApiContext) -> None:
    response = shopping_api_context.client.get("/api/shopping-list")

    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload] == [shopping_api_context.item_id]
    assert payload[0]["family_id"] == shopping_api_context.family_id


def test_create_shopping_item_with_current_family_ingredient_sets_audit_and_activity_log(
    shopping_api_context: ShoppingApiContext,
) -> None:
    response = shopping_api_context.client.post(
        "/api/shopping-list",
        json={
            "title": "补番茄",
            "quantity": 3,
            "unit": "个",
            "ingredient_id": shopping_api_context.ingredient_id,
            "reason": "周末备菜",
        },
    )

    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["family_id"] == shopping_api_context.family_id
    assert payload["ingredient_id"] == shopping_api_context.ingredient_id
    assert payload["title"] == "番茄"
    assert payload["unit"] == "个"
    assert payload["created_by"] == shopping_api_context.user_id
    assert payload["updated_by"] == shopping_api_context.user_id

    with shopping_api_context.SessionLocal() as db:
        item = db.get(ShoppingListItem, payload["id"])
        assert item is not None
        assert item.family_id == shopping_api_context.family_id
        assert item.created_by == shopping_api_context.user_id
        assert item.updated_by == shopping_api_context.user_id

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == shopping_api_context.family_id,
                ActivityLog.actor_id == shopping_api_context.user_id,
                ActivityLog.action == ActivityAction.CREATE,
                ActivityLog.entity_type == "ShoppingListItem",
                ActivityLog.entity_id == item.id,
            )
        )
        assert log is not None
        assert log.summary == "加入购物清单 番茄"


def test_create_shopping_item_requires_current_family_ingredient_without_side_effects(
    shopping_api_context: ShoppingApiContext,
) -> None:
    response = shopping_api_context.client.post(
        "/api/shopping-list",
        json={
            "title": "临时牛奶",
            "quantity": 1,
            "unit": "盒",
            "reason": "周末早餐",
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "采购项必须选择已有食材"

    with shopping_api_context.SessionLocal() as db:
        leaked_item = db.scalar(
            select(ShoppingListItem).where(
                ShoppingListItem.family_id == shopping_api_context.family_id,
                ShoppingListItem.title == "临时牛奶",
            )
        )
        assert leaked_item is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "加入购物清单 临时牛奶")) is None


def test_create_shopping_item_rejects_other_family_ingredient_without_side_effects(
    shopping_api_context: ShoppingApiContext,
) -> None:
    response = shopping_api_context.client.post(
        "/api/shopping-list",
        json={
            "title": "跨家庭鸡蛋",
            "quantity": 6,
            "unit": "个",
            "ingredient_id": shopping_api_context.other_ingredient_id,
            "reason": "不应创建",
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Ingredient not found"

    with shopping_api_context.SessionLocal() as db:
        leaked_item = db.scalar(
            select(ShoppingListItem).where(
                ShoppingListItem.family_id == shopping_api_context.family_id,
                ShoppingListItem.title == "跨家庭鸡蛋",
            )
        )
        assert leaked_item is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "加入购物清单 跨家庭鸡蛋")) is None


def test_patch_shopping_item_updates_current_family_item_and_activity_log(
    shopping_api_context: ShoppingApiContext,
) -> None:
    response = shopping_api_context.client.patch(f"/api/shopping-list/{shopping_api_context.item_id}", json={"done": True})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["id"] == shopping_api_context.item_id
    assert payload["done"] is True
    assert payload["updated_by"] == shopping_api_context.user_id

    with shopping_api_context.SessionLocal() as db:
        item = db.get(ShoppingListItem, shopping_api_context.item_id)
        assert item is not None
        assert item.done is True
        assert item.updated_by == shopping_api_context.user_id

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == shopping_api_context.family_id,
                ActivityLog.actor_id == shopping_api_context.user_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "ShoppingListItem",
                ActivityLog.entity_id == shopping_api_context.item_id,
            )
        )
        assert log is not None
        assert log.summary == "番茄已标记为完成"


def test_patch_shopping_item_updates_fields_and_relinks_ingredient(shopping_api_context: ShoppingApiContext) -> None:
    response = shopping_api_context.client.patch(
        f"/api/shopping-list/{shopping_api_context.item_id}",
        json={
            "title": "番茄罐头",
            "quantity": 3,
            "unit": "罐",
            "ingredient_id": shopping_api_context.ingredient_id,
            "reason": "补做意面",
            "done": False,
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["title"] == "番茄"
    assert payload["quantity"] == 3
    assert payload["unit"] == "罐"
    assert payload["ingredient_id"] == shopping_api_context.ingredient_id
    assert payload["reason"] == "补做意面"
    assert payload["done"] is False

    with shopping_api_context.SessionLocal() as db:
        item = db.get(ShoppingListItem, shopping_api_context.item_id)
        assert item is not None
        assert item.title == "番茄"
        assert item.quantity == Decimal("3")
        assert item.unit == "罐"
        assert item.reason == "补做意面"

        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == shopping_api_context.family_id,
                ActivityLog.entity_id == shopping_api_context.item_id,
                ActivityLog.summary == "更新购物清单 番茄",
            )
        )
        assert log is not None


def test_patch_shopping_item_rejects_clearing_ingredient_on_content_update(
    shopping_api_context: ShoppingApiContext,
) -> None:
    response = shopping_api_context.client.patch(
        f"/api/shopping-list/{shopping_api_context.item_id}",
        json={
            "title": "临时采购",
            "quantity": 1,
            "unit": "盒",
            "ingredient_id": None,
            "reason": "不应解绑",
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"] == "采购项必须选择已有食材"

    with shopping_api_context.SessionLocal() as db:
        item = db.get(ShoppingListItem, shopping_api_context.item_id)
        assert item is not None
        assert item.title == "番茄"
        assert item.ingredient_id == shopping_api_context.ingredient_id
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "更新购物清单 临时采购")) is None


def test_patch_shopping_item_rejects_other_family_ingredient(shopping_api_context: ShoppingApiContext) -> None:
    response = shopping_api_context.client.patch(
        f"/api/shopping-list/{shopping_api_context.item_id}",
        json={
            "title": "跨家庭鸡蛋",
            "quantity": 2,
            "unit": "个",
            "ingredient_id": shopping_api_context.other_ingredient_id,
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Ingredient not found"

    with shopping_api_context.SessionLocal() as db:
        item = db.get(ShoppingListItem, shopping_api_context.item_id)
        assert item is not None
        assert item.title == "番茄"
        assert item.ingredient_id == shopping_api_context.ingredient_id


def test_patch_shopping_item_rolls_back_when_commit_fails(shopping_api_context: ShoppingApiContext) -> None:
    with fail_next_commit("shopping commit failed"):
        with pytest.raises(RuntimeError, match="shopping commit failed"):
            shopping_api_context.client.patch(f"/api/shopping-list/{shopping_api_context.item_id}", json={"done": True})

    with shopping_api_context.SessionLocal() as db:
        item = db.get(ShoppingListItem, shopping_api_context.item_id)
        assert item is not None
        assert item.done is False
        assert item.updated_by == shopping_api_context.user_id
        assert db.scalar(select(ActivityLog).where(ActivityLog.summary == "番茄已标记为完成")) is None


def test_patch_shopping_item_rejects_other_family_item_without_modifying_it(
    shopping_api_context: ShoppingApiContext,
) -> None:
    response = shopping_api_context.client.patch(f"/api/shopping-list/{shopping_api_context.other_item_id}", json={"done": True})

    assert response.status_code == 404
    assert response.json()["detail"] == "Shopping item not found"

    with shopping_api_context.SessionLocal() as db:
        other_item = db.get(ShoppingListItem, shopping_api_context.other_item_id)
        assert other_item is not None
        assert other_item.done is False
        assert other_item.updated_by == shopping_api_context.other_user_id
        assert (
            db.scalar(
                select(ActivityLog).where(
                    ActivityLog.family_id == shopping_api_context.family_id,
                    ActivityLog.entity_id == shopping_api_context.other_item_id,
                )
            )
            is None
        )


def test_delete_shopping_item_removes_current_family_item_and_logs_activity(
    shopping_api_context: ShoppingApiContext,
) -> None:
    response = shopping_api_context.client.delete(f"/api/shopping-list/{shopping_api_context.item_id}")

    assert response.status_code == 204, response.text

    with shopping_api_context.SessionLocal() as db:
        assert db.get(ShoppingListItem, shopping_api_context.item_id) is None
        log = db.scalar(
            select(ActivityLog).where(
                ActivityLog.family_id == shopping_api_context.family_id,
                ActivityLog.actor_id == shopping_api_context.user_id,
                ActivityLog.action == ActivityAction.UPDATE,
                ActivityLog.entity_type == "ShoppingListItem",
                ActivityLog.entity_id == shopping_api_context.item_id,
            )
        )
        assert log is not None
        assert log.summary == "删除购物清单 番茄"


def test_delete_shopping_item_rejects_other_family_item(shopping_api_context: ShoppingApiContext) -> None:
    response = shopping_api_context.client.delete(f"/api/shopping-list/{shopping_api_context.other_item_id}")

    assert response.status_code == 404
    assert response.json()["detail"] == "Shopping item not found"

    with shopping_api_context.SessionLocal() as db:
        assert db.get(ShoppingListItem, shopping_api_context.other_item_id) is not None


def test_shopping_list_requires_authentication(shopping_api_context: ShoppingApiContext) -> None:
    app.dependency_overrides.pop(get_current_auth, None)

    response = shopping_api_context.client.get("/api/shopping-list")

    assert response.status_code == 401
    assert response.json()["detail"] == "Not authenticated"
