from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import (
    ActivityAction,
    ActivityHighlightKind,
    FoodType,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryConfirmationSource,
    InventoryOperationType,
    InventoryStatus,
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
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    InventoryOperationLine,
    Membership,
    ShoppingListItem,
    User,
)
from app.services.food_stock import apply_food_stock_intake, apply_food_stock_restock, merge_food_intake_expiry
from tests._transaction_failure import fail_next_commit


@dataclass(frozen=True)
class IntakeApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    family_id: str
    other_family_id: str
    user_id: str
    exact_ingredient_id: str
    presence_ingredient_id: str
    manual_expiry_ingredient_id: str
    other_ingredient_id: str
    food_id: str
    other_food_id: str
    exact_shopping_id: str
    presence_shopping_id: str
    food_shopping_id: str
    free_text_shopping_id: str
    other_shopping_id: str


@pytest.fixture()
def intake_api_context() -> Iterator[IntakeApiContext]:
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
        family = Family(id="family-intake", name="采购家庭", motto="", location="")
        other_family = Family(id="family-other-intake", name="其他家庭", motto="", location="")
        user = User(id="user-intake", username="intake-user", display_name="采购员", avatar_seed="", is_active=True)
        other_user = User(id="user-other-intake", username="other-intake", display_name="其他", avatar_seed="", is_active=True)
        membership = Membership(
            id="membership-intake",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        other_membership = Membership(
            id="membership-other-intake",
            family_id=other_family.id,
            user_id=other_user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        exact = Ingredient(
            id="ingredient-exact-egg",
            family_id=family.id,
            name="鸡蛋",
            category="蛋奶",
            default_unit="个",
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.DAYS,
            default_expiry_days=14,
            unit_conversions=[{"unit": "盒", "ratio_to_default": 10}],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        presence = Ingredient(
            id="ingredient-presence-salt",
            family_id=family.id,
            name="盐",
            category="调味",
            default_unit="袋",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        manual = Ingredient(
            id="ingredient-manual-noodle",
            family_id=family.id,
            name="面条",
            category="主食",
            default_unit="袋",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.MANUAL_DATE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        other_ingredient = Ingredient(
            id="ingredient-other-egg",
            family_id=other_family.id,
            name="其他鸡蛋",
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
        food = Food(
            id="food-braised-beef",
            family_id=family.id,
            name="卤牛肉",
            type=FoodType.READY_MADE.value,
            category="熟食",
            stock_quantity=Decimal("2"),
            stock_unit="份",
            storage_location="冷藏",
            expiry_date=date(2026, 7, 15),
            created_by=user.id,
            updated_by=user.id,
        )
        other_food = Food(
            id="food-other-yogurt",
            family_id=other_family.id,
            name="其他酸奶",
            type=FoodType.READY_MADE.value,
            category="乳品",
            stock_quantity=Decimal("1"),
            stock_unit="盒",
            storage_location="冷藏",
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        exact_shopping = ShoppingListItem(
            id="shopping-exact-egg",
            family_id=family.id,
            ingredient_id=exact.id,
            title="鸡蛋",
            quantity=Decimal("6"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="早餐",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        presence_shopping = ShoppingListItem(
            id="shopping-presence-salt",
            family_id=family.id,
            ingredient_id=presence.id,
            title="盐",
            quantity=Decimal("1"),
            unit="份",
            quantity_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            display_label="需要补充",
            reason="调味",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        food_shopping = ShoppingListItem(
            id="shopping-food-beef",
            family_id=family.id,
            food_id=food.id,
            title="卤牛肉",
            quantity=Decimal("1"),
            unit="份",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="加餐",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        free_text = ShoppingListItem(
            id="shopping-free-paper",
            family_id=family.id,
            title="厨房纸",
            quantity=Decimal("1"),
            unit="卷",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="家用",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        other_shopping = ShoppingListItem(
            id="shopping-other-egg",
            family_id=other_family.id,
            ingredient_id=other_ingredient.id,
            title="其他鸡蛋",
            quantity=Decimal("2"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="跨家庭",
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
                exact,
                presence,
                manual,
                other_ingredient,
                food,
                other_food,
                exact_shopping,
                presence_shopping,
                food_shopping,
                free_text,
                other_shopping,
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
            user = db.get(User, "user-intake")
            membership = db.get(Membership, "membership-intake")
            assert user is not None and membership is not None
            return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    try:
        yield IntakeApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            family_id="family-intake",
            other_family_id="family-other-intake",
            user_id="user-intake",
            exact_ingredient_id="ingredient-exact-egg",
            presence_ingredient_id="ingredient-presence-salt",
            manual_expiry_ingredient_id="ingredient-manual-noodle",
            other_ingredient_id="ingredient-other-egg",
            food_id="food-braised-beef",
            other_food_id="food-other-yogurt",
            exact_shopping_id="shopping-exact-egg",
            presence_shopping_id="shopping-presence-salt",
            food_shopping_id="shopping-food-beef",
            free_text_shopping_id="shopping-free-paper",
            other_shopping_id="shopping-other-egg",
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _highlight_rows(db: Session, *, family_id: str) -> list[ActivityLog]:
    return list(
        db.scalars(
            select(ActivityLog)
            .where(
                ActivityLog.family_id == family_id,
                ActivityLog.highlight_kind.is_not(None),
            )
            .order_by(ActivityLog.created_at, ActivityLog.id)
        )
    )


def _exact_payload(
    ctx: IntakeApiContext,
    *,
    shopping_id: str | None = None,
    quantity: float = 6,
    unit: str = "个",
    expected_shopping_version: int = 1,
    expected_ingredient_version: int = 1,
    expiry_date: str | None = "2026-07-20",
    client_request_id: str = "req-exact-full",
) -> dict:
    return {
        "client_request_id": client_request_id,
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": shopping_id or ctx.exact_shopping_id,
                "expected_shopping_item_row_version": expected_shopping_version,
                "action": "stock_and_fulfill",
                "target_kind": "exact_ingredient",
                "target_id": ctx.exact_ingredient_id,
                "expected_ingredient_row_version": expected_ingredient_version,
                "actual_quantity": quantity,
                "unit": unit,
                "inventory_status": InventoryStatus.FRESH.value,
                "expiry_date": expiry_date,
                "storage_location": "冷藏",
                "notes": "",
            }
        ],
    }


def test_exact_full_purchase_creates_batch_and_completes(intake_api_context: IntakeApiContext) -> None:
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=_exact_payload(intake_api_context))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["operation_type"] == InventoryOperationType.SHOPPING_INTAKE.value
    assert payload["status"] == "applied"
    assert payload["can_revert"] is True
    assert payload["items"][0]["result"] == "completed"
    assert payload["items"][0]["inventory_item_id"]

    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        assert shopping is not None and shopping.done is True
        items = list(
            db.scalars(
                select(InventoryItem).where(InventoryItem.ingredient_id == intake_api_context.exact_ingredient_id)
            )
        )
        assert len(items) == 1
        assert items[0].quantity == Decimal("6.00")
        assert items[0].unit == "个"
        operations = list(db.scalars(select(InventoryOperation)))
        assert len(operations) == 1
        activity = db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "InventoryOperation"))
        assert activity is not None
        assert "登记了本次购买" in activity.summary
        assert db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "InventoryItem")) is None


def test_exact_partial_purchase_reduces_planned_quantity(intake_api_context: IntakeApiContext) -> None:
    response = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, quantity=2, client_request_id="req-exact-partial"),
    )
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert item["result"] == "partial"
    assert Decimal(str(item["remaining_planned_quantity"])) == Decimal("4")

    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        assert shopping is not None
        assert shopping.done is False
        assert shopping.quantity == Decimal("4.00")
        assert shopping.unit == "个"
        batches = list(db.scalars(select(InventoryItem)))
        assert len(batches) == 1
        assert batches[0].quantity == Decimal("2.00")


def test_exact_over_purchase_stocks_full_actual_and_completes(intake_api_context: IntakeApiContext) -> None:
    response = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, quantity=10, client_request_id="req-exact-over"),
    )
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["result"] == "completed"
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        assert shopping is not None and shopping.done is True
        batch = db.scalar(select(InventoryItem))
        assert batch is not None and batch.quantity == Decimal("10.00")


def test_actual_zero_rejected_as_empty_or_invalid(intake_api_context: IntakeApiContext) -> None:
    payload = _exact_payload(intake_api_context, quantity=0, client_request_id="req-zero")
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 422
    with intake_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryItem)) is None
        shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        assert shopping is not None and shopping.done is False


def test_presence_purchase_updates_state_without_inventory_item(intake_api_context: IntakeApiContext) -> None:
    payload = {
        "client_request_id": "req-presence",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.presence_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "presence_ingredient",
                "target_id": intake_api_context.presence_ingredient_id,
                "expected_ingredient_row_version": 1,
                "state_id": None,
                "expected_state_row_version": None,
                "resulting_availability_level": InventoryAvailabilityLevel.SUFFICIENT.value,
                "inventory_status": InventoryStatus.FRESH.value,
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "新买",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["result"] == "stocked"
    assert response.json()["items"][0]["state_id"]

    with intake_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryItem)) is None
        state = db.scalar(select(IngredientInventoryState))
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.SUFFICIENT
        assert state.last_confirmation_source == InventoryConfirmationSource.SHOPPING_INTAKE
        shopping = db.get(ShoppingListItem, intake_api_context.presence_shopping_id)
        assert shopping is not None and shopping.done is True
        assert shopping.quantity == Decimal("1.00")


def test_food_purchase_merges_expiry_and_adds_stock(intake_api_context: IntakeApiContext) -> None:
    payload = {
        "client_request_id": "req-food",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.food_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "food",
                "target_id": intake_api_context.food_id,
                "expected_food_row_version": 1,
                "actual_quantity": 3,
                "unit": "份",
                "expiry_date": "2026-07-18",
                "storage_location": "冷冻",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["result"] == "stocked"
    assert response.json()["items"][0]["food_id"] == intake_api_context.food_id

    with intake_api_context.SessionLocal() as db:
        food = db.get(Food, intake_api_context.food_id)
        assert food is not None
        assert food.stock_quantity == Decimal("5.00")
        assert food.stock_unit == "份"
        assert food.storage_location == "冷冻"
        assert food.expiry_date == date(2026, 7, 15)  # min(current, incoming)
        assert food.inventory_confirmation_source == InventoryConfirmationSource.SHOPPING_INTAKE
        shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        assert shopping is not None and shopping.done is True


def test_food_partial_purchase_keeps_remaining_shopping_quantity(
    intake_api_context: IntakeApiContext,
) -> None:
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        assert shopping is not None
        shopping.quantity = Decimal("6")
        db.commit()
        db.refresh(shopping)
        shopping_version = shopping.row_version

    payload = {
        "client_request_id": "req-food-partial",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.food_shopping_id,
                "expected_shopping_item_row_version": shopping_version,
                "action": "stock_and_fulfill",
                "target_kind": "food",
                "target_id": intake_api_context.food_id,
                "expected_food_row_version": 1,
                "actual_quantity": 2,
                "unit": "份",
                "expiry_date": "2026-07-18",
                "storage_location": "冷藏",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()["items"][0]
    assert result["result"] == "partial"
    assert Decimal(str(result["remaining_planned_quantity"])) == Decimal("4")

    with intake_api_context.SessionLocal() as db:
        food = db.get(Food, intake_api_context.food_id)
        shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        assert food is not None and food.stock_quantity == Decimal("4.00")
        assert shopping is not None
        assert shopping.done is False
        assert shopping.quantity == Decimal("4.00")
        assert shopping.unit == "份"


def test_food_quantity_precision_is_rejected_before_any_intake_mutation(
    intake_api_context: IntakeApiContext,
) -> None:
    payload = _exact_payload(
        intake_api_context,
        client_request_id="req-food-invalid-precision",
    )
    payload["items"].append(
        {
            "shopping_item_id": intake_api_context.food_shopping_id,
            "expected_shopping_item_row_version": 1,
            "action": "stock_and_fulfill",
            "target_kind": "food",
            "target_id": intake_api_context.food_id,
            "expected_food_row_version": 1,
            "actual_quantity": 1.25,
            "unit": "份",
            "expiry_date": "2026-07-18",
            "storage_location": "冷藏",
        }
    )

    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_quantity"
    assert detail["field_errors"] == [
        {
            "line_id": f"shopping:{intake_api_context.food_shopping_id}",
            "shopping_item_id": intake_api_context.food_shopping_id,
            "field": "actual_quantity",
            "code": "invalid_quantity",
            "message": "库存数量最多保留 1 位小数",
        }
    ]
    with intake_api_context.SessionLocal() as db:
        exact_shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        food_shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        food = db.get(Food, intake_api_context.food_id)
        assert exact_shopping is not None and exact_shopping.done is False
        assert food_shopping is not None and food_shopping.done is False
        assert food is not None and food.stock_quantity == Decimal("2.00")
        assert db.scalar(select(InventoryItem)) is None
        assert db.scalar(select(InventoryOperation)) is None


def test_shopping_intake_schema_errors_use_the_structured_detail_contract(
    intake_api_context: IntakeApiContext,
) -> None:
    payload = {
        "client_request_id": "req-food-empty-unit",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.food_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "food",
                "target_id": intake_api_context.food_id,
                "expected_food_row_version": 1,
                "actual_quantity": 1,
                "unit": "",
                "expiry_date": "2026-07-18",
                "storage_location": "冷藏",
            }
        ],
    }

    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {
        "code": "invalid_request",
        "message": "字段不能为空",
        "conflicts": [],
        "field_errors": [
            {
                "field": "items.0.unit",
                "code": "invalid_request",
                "message": "字段不能为空",
            }
        ],
    }
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        food = db.get(Food, intake_api_context.food_id)
        assert shopping is not None and shopping.done is False
        assert food is not None and food.stock_quantity == Decimal("2.00")
        assert db.scalar(select(InventoryOperation)) is None


def test_food_current_stock_unit_is_validated_before_any_intake_mutation(
    intake_api_context: IntakeApiContext,
) -> None:
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        assert shopping is not None
        shopping.unit = "盒"
        db.commit()
        db.refresh(shopping)
        shopping_version = shopping.row_version

    payload = _exact_payload(
        intake_api_context,
        client_request_id="req-food-stale-unit",
    )
    payload["items"].append(
        {
            "shopping_item_id": intake_api_context.food_shopping_id,
            "expected_shopping_item_row_version": shopping_version,
            "action": "stock_and_fulfill",
            "target_kind": "food",
            "target_id": intake_api_context.food_id,
            "expected_food_row_version": 1,
            "actual_quantity": 1,
            "unit": "盒",
            "expiry_date": "2026-07-18",
            "storage_location": "冷藏",
        }
    )

    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "incompatible_unit"
    assert detail["field_errors"] == [
        {
            "line_id": f"shopping:{intake_api_context.food_shopping_id}",
            "shopping_item_id": intake_api_context.food_shopping_id,
            "field": "unit",
            "code": "incompatible_unit",
            "message": "当前食物库存单位是 份，不能按 盒 入库",
        }
    ]
    with intake_api_context.SessionLocal() as db:
        exact_shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        food_shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        food = db.get(Food, intake_api_context.food_id)
        assert exact_shopping is not None and exact_shopping.done is False
        assert food_shopping is not None and food_shopping.done is False
        assert food is not None and food.stock_quantity == Decimal("2.00")
        assert db.scalar(select(InventoryItem)) is None
        assert db.scalar(select(InventoryOperation)) is None


def test_free_text_link_rejects_incompatible_units_atomically(
    intake_api_context: IntakeApiContext,
) -> None:
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        shopping.quantity = Decimal("2")
        shopping.unit = "袋"
        db.commit()
        db.refresh(shopping)
        shopping_version = shopping.row_version

    payload = {
        "client_request_id": "req-free-incompatible-unit",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.free_text_shopping_id,
                "expected_shopping_item_row_version": shopping_version,
                "action": "stock_and_fulfill",
                "target_kind": "exact_ingredient",
                "target_id": intake_api_context.exact_ingredient_id,
                "expected_ingredient_row_version": 1,
                "actual_quantity": 500,
                "unit": "克",
                "inventory_status": InventoryStatus.FRESH.value,
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
                "notes": "",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "incompatible_unit"
    assert any(error["code"] == "incompatible_unit" for error in detail["field_errors"])

    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        assert shopping.done is False
        assert shopping.quantity == Decimal("2.00")
        assert shopping.unit == "袋"
        assert shopping.ingredient_id is None
        assert db.scalar(select(InventoryItem)) is None
        assert db.scalar(select(InventoryOperation)) is None


@pytest.mark.parametrize(
    ("current_qty", "current_expiry", "incoming", "expected"),
    [
        (Decimal("0"), date(2026, 7, 10), date(2026, 7, 20), date(2026, 7, 20)),
        (Decimal("2"), date(2026, 7, 10), date(2026, 7, 20), date(2026, 7, 10)),
        (Decimal("2"), None, date(2026, 7, 20), date(2026, 7, 20)),
        (Decimal("2"), date(2026, 7, 10), None, date(2026, 7, 10)),
        (Decimal("2"), None, None, None),
    ],
)
def test_merge_food_intake_expiry_matrix(current_qty, current_expiry, incoming, expected) -> None:
    assert (
        merge_food_intake_expiry(
            current_quantity=current_qty,
            current_expiry=current_expiry,
            incoming_expiry=incoming,
        )
        == expected
    )


def test_ordinary_food_restock_still_overwrites_expiry(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        food = db.get(Food, intake_api_context.food_id)
        assert food is not None
        apply_food_stock_restock(
            db,
            family_id=intake_api_context.family_id,
            user_id=intake_api_context.user_id,
            food=food,
            quantity=Decimal("1"),
            unit="份",
            expiry_date=date(2026, 8, 1),
            purchase_source=None,
            storage_location="冷藏",
        )
        db.commit()
        db.refresh(food)
        assert food.expiry_date == date(2026, 8, 1)


def test_food_intake_zero_stock_uses_incoming_expiry(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        food = db.get(Food, intake_api_context.food_id)
        assert food is not None
        food.stock_quantity = Decimal("0")
        food.expiry_date = date(2026, 7, 1)
        db.commit()
        apply_food_stock_intake(
            db,
            family_id=intake_api_context.family_id,
            user_id=intake_api_context.user_id,
            food=food,
            quantity=Decimal("2"),
            unit="份",
            expiry_date=date(2026, 7, 25),
            storage_location="冷藏",
        )
        db.commit()
        db.refresh(food)
        assert food.stock_quantity == Decimal("2.00")
        assert food.expiry_date == date(2026, 7, 25)


def test_free_text_complete_without_inventory(intake_api_context: IntakeApiContext) -> None:
    payload = {
        "client_request_id": "req-free-complete",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.free_text_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "complete_without_inventory",
                "target_kind": "none",
                "target_id": None,
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["items"][0]["result"] == "completed_without_inventory"
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        assert shopping.done is True


def test_complete_without_inventory_rejects_inventory_target_fields(
    intake_api_context: IntakeApiContext,
) -> None:
    payload = {
        "client_request_id": "req-free-complete-extra-target",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.free_text_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "complete_without_inventory",
                "target_kind": "none",
                "target_id": None,
                "actual_quantity": "2",
                "unit": "份",
            }
        ],
    }

    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)

    assert response.status_code == 422, response.text
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        assert shopping.done is False
        assert db.scalar(select(InventoryOperation)) is None
        assert shopping.ingredient_id is None
        assert shopping.food_id is None
        assert db.scalar(select(InventoryItem)) is None


def test_free_text_bind_to_ingredient_in_same_transaction(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        shopping.quantity = Decimal("2")
        shopping.unit = "个"
        db.commit()
        db.refresh(shopping)
        shopping_version = shopping.row_version

    payload = {
        "client_request_id": "req-free-bind-exact",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.free_text_shopping_id,
                "expected_shopping_item_row_version": shopping_version,
                "action": "stock_and_fulfill",
                "target_kind": "exact_ingredient",
                "target_id": intake_api_context.exact_ingredient_id,
                "expected_ingredient_row_version": 1,
                "actual_quantity": 2,
                "unit": "个",
                "inventory_status": InventoryStatus.FRESH.value,
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
                "notes": "",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 200, response.text
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        assert shopping.ingredient_id == intake_api_context.exact_ingredient_id
        assert shopping.food_id is None
        assert shopping.title == "鸡蛋"
        assert shopping.done is True
        assert db.scalar(select(InventoryItem)) is not None


def test_cross_family_target_fails_atomically(intake_api_context: IntakeApiContext) -> None:
    payload = _exact_payload(intake_api_context, client_request_id="req-cross")
    payload["items"][0]["target_id"] = intake_api_context.other_ingredient_id
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code in {404, 422}
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        assert shopping is not None and shopping.done is False
        assert db.scalar(select(InventoryItem)) is None
        assert db.scalar(select(InventoryOperation)) is None
        assert _highlight_rows(db, family_id=intake_api_context.family_id) == []


def test_incompatible_unit_fails(intake_api_context: IntakeApiContext) -> None:
    response = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, unit="公斤", client_request_id="req-unit"),
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "incompatible_unit"
    with intake_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryItem)) is None


def test_missing_manual_expiry_fails(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        shopping = ShoppingListItem(
            id="shopping-manual-noodle",
            family_id=intake_api_context.family_id,
            ingredient_id=intake_api_context.manual_expiry_ingredient_id,
            title="面条",
            quantity=Decimal("2"),
            unit="袋",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="主食",
            done=False,
            created_by=intake_api_context.user_id,
            updated_by=intake_api_context.user_id,
        )
        db.add(shopping)
        db.commit()

    payload = {
        "client_request_id": "req-manual-expiry",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": "shopping-manual-noodle",
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "exact_ingredient",
                "target_id": intake_api_context.manual_expiry_ingredient_id,
                "expected_ingredient_row_version": 1,
                "actual_quantity": 2,
                "unit": "袋",
                "inventory_status": InventoryStatus.FRESH.value,
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "manual_expiry_required"


def test_duplicate_shopping_item_rejected(intake_api_context: IntakeApiContext) -> None:
    payload = _exact_payload(intake_api_context, client_request_id="req-dup")
    payload["items"].append(payload["items"][0].copy())
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 422


def test_stale_version_fails(intake_api_context: IntakeApiContext) -> None:
    response = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, expected_shopping_version=99, client_request_id="req-stale"),
    )
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "stale_version"
    with intake_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryItem)) is None
        assert _highlight_rows(db, family_id=intake_api_context.family_id) == []


def test_second_completion_fails_atomically(intake_api_context: IntakeApiContext) -> None:
    first = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, client_request_id="req-first-done"),
    )
    assert first.status_code == 200, first.text
    second = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(
            intake_api_context,
            expected_shopping_version=2,
            expected_ingredient_version=2,
            client_request_id="req-second-done",
        ),
    )
    assert second.status_code == 409
    with intake_api_context.SessionLocal() as db:
        assert len(list(db.scalars(select(InventoryItem)))) == 1
        assert len(list(db.scalars(select(InventoryOperation)))) == 1


def test_same_request_id_and_hash_replays_without_duplicate_stock(intake_api_context: IntakeApiContext) -> None:
    payload = _exact_payload(intake_api_context, client_request_id="req-idempotent")
    first = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert first.status_code == 200, first.text
    second = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert second.status_code == 200, second.text
    assert second.json()["operation_id"] == first.json()["operation_id"]
    assert second.json()["items"][0]["inventory_item_id"] == first.json()["items"][0]["inventory_item_id"]
    with intake_api_context.SessionLocal() as db:
        assert len(list(db.scalars(select(InventoryItem)))) == 1
        assert len(list(db.scalars(select(InventoryOperation)))) == 1


def test_shopping_intake_writes_one_highlight_and_replay_does_not_duplicate(
    intake_api_context: IntakeApiContext,
) -> None:
    payload = _exact_payload(intake_api_context, client_request_id="intake-highlight-1")
    first = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    replay = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert first.status_code == 200, first.text
    assert replay.status_code == 200, replay.text
    with intake_api_context.SessionLocal() as db:
        highlights = _highlight_rows(db, family_id=intake_api_context.family_id)
        assert len(highlights) == 1
        assert highlights[0].highlight_kind is ActivityHighlightKind.SHOPPING
        assert highlights[0].highlight_summary == "完成 1 项采购入库"
        assert len(list(db.scalars(select(InventoryOperation)))) == 1


def test_idempotent_intake_replay_computes_can_revert_for_requesting_member(
    intake_api_context: IntakeApiContext,
) -> None:
    payload = _exact_payload(intake_api_context, client_request_id="req-idempotent-permission")
    first = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["can_revert"] is True

    with intake_api_context.SessionLocal() as db:
        second_user = User(
            id="user-intake-second",
            username="intake-second",
            display_name="另一成员",
            avatar_seed="",
            is_active=True,
        )
        second_membership = Membership(
            id="membership-intake-second",
            family_id=intake_api_context.family_id,
            user_id=second_user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        db.add_all([second_user, second_membership])
        db.commit()

    def override_second_auth() -> tuple[User, Membership]:
        with intake_api_context.SessionLocal() as db:
            user = db.get(User, "user-intake-second")
            membership = db.get(Membership, "membership-intake-second")
            assert user is not None and membership is not None
            return user, membership

    app.dependency_overrides[get_current_auth] = override_second_auth
    member_replay = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert member_replay.status_code == 200, member_replay.text
    assert member_replay.json()["can_revert"] is False

    with intake_api_context.SessionLocal() as db:
        membership = db.get(Membership, "membership-intake-second")
        assert membership is not None
        membership.role = UserRole.OWNER
        db.commit()

    owner_replay = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert owner_replay.status_code == 200, owner_replay.text
    assert owner_replay.json()["can_revert"] is True


def test_same_request_id_different_payload_returns_409(intake_api_context: IntakeApiContext) -> None:
    first = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, quantity=6, client_request_id="req-hash-conflict"),
    )
    assert first.status_code == 200, first.text
    second = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, quantity=3, client_request_id="req-hash-conflict"),
    )
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "idempotency_key_reused"
    with intake_api_context.SessionLocal() as db:
        assert len(list(db.scalars(select(InventoryItem)))) == 1


def test_forced_commit_failure_leaves_no_partial_write(intake_api_context: IntakeApiContext) -> None:
    with fail_next_commit("intake commit failed"):
        with pytest.raises(RuntimeError, match="intake commit failed"):
            intake_api_context.client.post(
                "/api/shopping-list/intakes",
                json=_exact_payload(intake_api_context, client_request_id="req-rollback"),
            )
    with intake_api_context.SessionLocal() as db:
        assert db.scalar(select(InventoryItem)) is None
        shopping = db.get(ShoppingListItem, intake_api_context.exact_shopping_id)
        assert shopping is not None and shopping.done is False
        assert db.scalar(select(InventoryOperation)) is None
        assert db.scalar(select(ActivityLog).where(ActivityLog.entity_type == "InventoryOperation")) is None
        assert _highlight_rows(db, family_id=intake_api_context.family_id) == []


def test_presence_absent_rejected(intake_api_context: IntakeApiContext) -> None:
    payload = {
        "client_request_id": "req-absent",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.presence_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "presence_ingredient",
                "target_id": intake_api_context.presence_ingredient_id,
                "expected_ingredient_row_version": 1,
                "resulting_availability_level": InventoryAvailabilityLevel.ABSENT.value,
                "inventory_status": InventoryStatus.FRESH.value,
                "storage_location": "常温",
                "notes": "",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 422


def test_operation_lines_include_shopping_replay_metadata(intake_api_context: IntakeApiContext) -> None:
    response = intake_api_context.client.post(
        "/api/shopping-list/intakes",
        json=_exact_payload(intake_api_context, quantity=2, client_request_id="req-meta"),
    )
    assert response.status_code == 200, response.text
    with intake_api_context.SessionLocal() as db:
        lines = list(db.scalars(select(InventoryOperationLine).order_by(InventoryOperationLine.sequence.asc())))
        shopping_lines = [line for line in lines if line.entity_type.value == "shopping_list_item"]
        assert len(shopping_lines) == 1
        metadata = shopping_lines[0].change_metadata
        assert metadata is not None
        assert metadata["result"] == "partial"
        assert metadata["remaining_planned_quantity"] in {"4", "4.0", "4.00"}
        assert metadata["inventory_item_id"]
        guard_lines = [line for line in lines if line.entity_type.value == "ingredient"]
        assert len(guard_lines) == 1


def test_duplicate_food_target_rejected(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        second_food_shopping = ShoppingListItem(
            id="shopping-food-beef-2",
            family_id=intake_api_context.family_id,
            food_id=intake_api_context.food_id,
            title="卤牛肉 加购",
            quantity=Decimal("1"),
            unit="份",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="再买一份",
            done=False,
            created_by=intake_api_context.user_id,
            updated_by=intake_api_context.user_id,
        )
        db.add(second_food_shopping)
        db.commit()

    payload = {
        "client_request_id": "req-dup-food",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.food_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "food",
                "target_id": intake_api_context.food_id,
                "expected_food_row_version": 1,
                "actual_quantity": 1,
                "unit": "份",
                "expiry_date": "2026-07-18",
                "storage_location": "冷藏",
            },
            {
                "shopping_item_id": "shopping-food-beef-2",
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "food",
                "target_id": intake_api_context.food_id,
                "expected_food_row_version": 1,
                "actual_quantity": 2,
                "unit": "份",
                "expiry_date": "2026-07-18",
                "storage_location": "冷藏",
            },
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "duplicate_request_item"
    with intake_api_context.SessionLocal() as db:
        food = db.get(Food, intake_api_context.food_id)
        assert food is not None
        assert food.stock_quantity == Decimal("2.00")
        shopping = db.get(ShoppingListItem, intake_api_context.food_shopping_id)
        assert shopping is not None and shopping.done is False
        assert db.scalar(select(InventoryOperation)) is None


def test_duplicate_presence_target_rejected(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        second_presence_shopping = ShoppingListItem(
            id="shopping-presence-salt-2",
            family_id=intake_api_context.family_id,
            ingredient_id=intake_api_context.presence_ingredient_id,
            title="盐 加购",
            quantity=Decimal("1"),
            unit="份",
            quantity_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            display_label="需要补充",
            reason="再买",
            done=False,
            created_by=intake_api_context.user_id,
            updated_by=intake_api_context.user_id,
        )
        db.add(second_presence_shopping)
        db.commit()

    def _presence_item(shopping_id: str) -> dict:
        return {
            "shopping_item_id": shopping_id,
            "expected_shopping_item_row_version": 1,
            "action": "stock_and_fulfill",
            "target_kind": "presence_ingredient",
            "target_id": intake_api_context.presence_ingredient_id,
            "expected_ingredient_row_version": 1,
            "state_id": None,
            "expected_state_row_version": None,
            "resulting_availability_level": InventoryAvailabilityLevel.SUFFICIENT.value,
            "inventory_status": InventoryStatus.FRESH.value,
            "expiry_date": None,
            "storage_location": "常温",
            "notes": "",
        }

    payload = {
        "client_request_id": "req-dup-presence",
        "purchase_date": "2026-07-12",
        "items": [
            _presence_item(intake_api_context.presence_shopping_id),
            _presence_item("shopping-presence-salt-2"),
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "duplicate_request_item"
    with intake_api_context.SessionLocal() as db:
        assert db.scalar(select(IngredientInventoryState)) is None
        shopping = db.get(ShoppingListItem, intake_api_context.presence_shopping_id)
        assert shopping is not None and shopping.done is False
        assert db.scalar(select(InventoryOperation)) is None


def test_free_text_exact_partial_preserves_planned_unit(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        shopping.quantity = Decimal("6")
        shopping.unit = "个"
        shopping.title = "鸡蛋（手写）"
        db.commit()
        db.refresh(shopping)
        shopping_version = shopping.row_version

    payload = {
        "client_request_id": "req-free-partial",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.free_text_shopping_id,
                "expected_shopping_item_row_version": shopping_version,
                "action": "stock_and_fulfill",
                "target_kind": "exact_ingredient",
                "target_id": intake_api_context.exact_ingredient_id,
                "expected_ingredient_row_version": 1,
                "actual_quantity": 2,
                "unit": "个",
                "inventory_status": InventoryStatus.FRESH.value,
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
                "notes": "",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert item["result"] == "partial"
    assert Decimal(str(item["remaining_planned_quantity"])) == Decimal("4")

    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        assert shopping.done is False
        assert shopping.quantity == Decimal("4.00")
        assert shopping.unit == "个"
        assert shopping.ingredient_id == intake_api_context.exact_ingredient_id
        assert shopping.title == "鸡蛋"
        batch = db.scalar(select(InventoryItem))
        assert batch is not None
        assert batch.quantity == Decimal("2.00")
        assert batch.unit == "个"


def test_free_text_food_link_with_matching_unit_stocks_and_preserves_partial_plan(
    intake_api_context: IntakeApiContext,
) -> None:
    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        assert shopping is not None
        shopping.title = "手写卤牛肉"
        shopping.quantity = Decimal("6")
        shopping.unit = "份"
        db.commit()
        db.refresh(shopping)
        shopping_version = shopping.row_version

    payload = {
        "client_request_id": "req-free-food-partial",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.free_text_shopping_id,
                "expected_shopping_item_row_version": shopping_version,
                "action": "stock_and_fulfill",
                "target_kind": "food",
                "target_id": intake_api_context.food_id,
                "expected_food_row_version": 1,
                "actual_quantity": 2,
                "unit": "份",
                "expiry_date": "2026-07-20",
                "storage_location": "冷藏",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert item["result"] == "partial"
    assert Decimal(str(item["remaining_planned_quantity"])) == Decimal("4")

    with intake_api_context.SessionLocal() as db:
        shopping = db.get(ShoppingListItem, intake_api_context.free_text_shopping_id)
        food = db.get(Food, intake_api_context.food_id)
        assert shopping is not None and food is not None
        assert shopping.done is False
        assert shopping.food_id == intake_api_context.food_id
        assert shopping.title == "卤牛肉"
        assert shopping.quantity == Decimal("4.00")
        assert shopping.unit == "份"
        assert food.stock_quantity == Decimal("4.00")


def test_stale_presence_state_version_fails(intake_api_context: IntakeApiContext) -> None:
    with intake_api_context.SessionLocal() as db:
        state = IngredientInventoryState(
            id="state-salt",
            family_id=intake_api_context.family_id,
            ingredient_id=intake_api_context.presence_ingredient_id,
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.FRESH,
            storage_location="常温",
            notes="",
            created_by=intake_api_context.user_id,
            updated_by=intake_api_context.user_id,
        )
        db.add(state)
        db.flush()
        # Bump past the default so expected_state_row_version=1 is stale.
        state.row_version = 3
        db.commit()
        db.refresh(state)
        assert state.row_version == 3

    payload = {
        "client_request_id": "req-stale-state",
        "purchase_date": "2026-07-12",
        "items": [
            {
                "shopping_item_id": intake_api_context.presence_shopping_id,
                "expected_shopping_item_row_version": 1,
                "action": "stock_and_fulfill",
                "target_kind": "presence_ingredient",
                "target_id": intake_api_context.presence_ingredient_id,
                "expected_ingredient_row_version": 1,
                "state_id": "state-salt",
                "expected_state_row_version": 1,
                "resulting_availability_level": InventoryAvailabilityLevel.SUFFICIENT.value,
                "inventory_status": InventoryStatus.FRESH.value,
                "expiry_date": None,
                "storage_location": "常温",
                "notes": "",
            }
        ],
    }
    response = intake_api_context.client.post("/api/shopping-list/intakes", json=payload)
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "stale_version"
    with intake_api_context.SessionLocal() as db:
        state = db.get(IngredientInventoryState, "state-salt")
        assert state is not None
        assert state.availability_level == InventoryAvailabilityLevel.LOW
        assert state.row_version == 3
        shopping = db.get(ShoppingListItem, intake_api_context.presence_shopping_id)
        assert shopping is not None and shopping.done is False
        assert db.scalar(select(InventoryOperation)) is None
