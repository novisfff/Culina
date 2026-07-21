from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import patch

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import (
    FoodType,
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryAvailabilityLevel,
    InventoryOperationStatus,
    InventoryOperationType,
    InventoryStatus,
    MembershipStatus,
    UserRole,
)
from app.models.domain import (
    ActivityLog,
    Base,
    Family,
    Food,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    Membership,
    ShoppingListItem,
    User,
)
from app.schemas.inventory_intake import (
    InventoryIntakeRequest,
    InventoryIntakeResult,
    inventory_result_to_shopping_result,
    shopping_request_to_inventory_request,
)
from app.schemas.inventory_operations import (
    InventoryOperationDisplaySummary,
    ShoppingIntakeRequest,
)
from app.services.inventory_intake import (
    InventoryIntakeValidationError,
    apply_inventory_intake,
)
from app.services.inventory_versions import InventoryConflictError


@dataclass
class IntakeServiceContext:
    db: Session
    family: Family
    other_family: Family
    user: User
    egg_ingredient: Ingredient
    egg_shopping: ShoppingListItem
    milk_food: Food
    presence_ingredient: Ingredient
    presence_state: IngredientInventoryState
    other_egg_ingredient: Ingredient
    other_milk_food: Food
    other_presence_ingredient: Ingredient


@pytest.fixture()
def context() -> Iterator[IntakeServiceContext]:
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
    db = SessionLocal()
    try:
        family = Family(id="family-intake-svc", name="入库家庭", motto="", location="")
        other_family = Family(id="family-other-intake-svc", name="其他家庭", motto="", location="")
        user = User(
            id="user-intake-svc",
            username="intake-svc",
            display_name="入库员",
            avatar_seed="",
            is_active=True,
        )
        other_user = User(
            id="user-other-intake-svc",
            username="other-intake-svc",
            display_name="其他",
            avatar_seed="",
            is_active=True,
        )
        membership = Membership(
            id="membership-intake-svc",
            family_id=family.id,
            user_id=user.id,
            role=UserRole.MEMBER,
            status=MembershipStatus.ACTIVE,
        )
        egg_ingredient = Ingredient(
            id="ingredient-egg-svc",
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
        presence_ingredient = Ingredient(
            id="ingredient-salt-svc",
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
        presence_state = IngredientInventoryState(
            id="state-salt-svc",
            family_id=family.id,
            ingredient_id=presence_ingredient.id,
            availability_level=InventoryAvailabilityLevel.LOW,
            inventory_status=InventoryStatus.FRESH,
            purchase_date=date(2026, 7, 1),
            expiry_date=None,
            storage_location="常温",
            notes="",
            created_by=user.id,
            updated_by=user.id,
        )
        milk_food = Food(
            id="food-milk-svc",
            family_id=family.id,
            name="牛奶",
            type=FoodType.PACKAGED.value,
            category="乳品",
            stock_quantity=Decimal("0"),
            stock_unit="袋",
            storage_location="冷藏",
            created_by=user.id,
            updated_by=user.id,
        )
        egg_shopping = ShoppingListItem(
            id="shopping-egg-svc",
            family_id=family.id,
            ingredient_id=egg_ingredient.id,
            title="鸡蛋",
            quantity=Decimal("6"),
            unit="个",
            quantity_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
            reason="早餐",
            done=False,
            created_by=user.id,
            updated_by=user.id,
        )
        other_egg_ingredient = Ingredient(
            id="ingredient-other-egg-svc",
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
        other_presence_ingredient = Ingredient(
            id="ingredient-other-salt-svc",
            family_id=other_family.id,
            name="其他盐",
            category="调味",
            default_unit="袋",
            default_storage="常温",
            default_expiry_mode=IngredientExpiryMode.NONE,
            unit_conversions=[],
            quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            notes="",
            created_by=other_user.id,
            updated_by=other_user.id,
        )
        other_milk_food = Food(
            id="food-other-milk-svc",
            family_id=other_family.id,
            name="其他牛奶",
            type=FoodType.PACKAGED.value,
            category="乳品",
            stock_quantity=Decimal("1"),
            stock_unit="袋",
            storage_location="冷藏",
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
                egg_ingredient,
                presence_ingredient,
                presence_state,
                milk_food,
                egg_shopping,
                other_egg_ingredient,
                other_presence_ingredient,
                other_milk_food,
            ]
        )
        db.commit()
        db.refresh(egg_ingredient)
        db.refresh(egg_shopping)
        db.refresh(milk_food)
        db.refresh(presence_ingredient)
        db.refresh(presence_state)
        yield IntakeServiceContext(
            db=db,
            family=family,
            other_family=other_family,
            user=user,
            egg_ingredient=egg_ingredient,
            egg_shopping=egg_shopping,
            milk_food=milk_food,
            presence_ingredient=presence_ingredient,
            presence_state=presence_state,
            other_egg_ingredient=other_egg_ingredient,
            other_milk_food=other_milk_food,
            other_presence_ingredient=other_presence_ingredient,
        )
    finally:
        db.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_inventory_intake_accepts_shopping_and_direct_rows() -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "mixed-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": "shopping-eggs",
                    "expected_shopping_item_row_version": 2,
                    "target_kind": "exact_ingredient",
                    "target_id": "ingredient-eggs",
                    "expected_ingredient_row_version": 3,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": "food-milk",
                    "expected_food_row_version": 4,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    assert [item.source_kind for item in request.items] == ["shopping_item", "direct"]


@pytest.mark.parametrize(
    "source_kind,action",
    [
        ("direct", "stock_and_fulfill"),
        ("shopping_item", "stock_only"),
    ],
)
def test_inventory_intake_rejects_invalid_source_action(source_kind: str, action: str) -> None:
    row = {
        "line_id": "line-1",
        "source_kind": source_kind,
        "action": action,
        "target_kind": "food",
        "target_id": "food-milk",
        "expected_food_row_version": 1,
        "actual_quantity": "1",
        "unit": "袋",
        "storage_location": "冷藏",
    }
    if source_kind == "shopping_item":
        row.update(
            {
                "shopping_item_id": "shopping-milk",
                "expected_shopping_item_row_version": 1,
            }
        )
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "invalid-combination",
                "intake_date": "2026-07-21",
                "items": [row],
            }
        )


def test_inventory_intake_rejects_duplicate_line_ids() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "dup-line",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "same-line",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    },
                    {
                        "line_id": "same-line",
                        "source_kind": "direct",
                        "action": "stock_only",
                        "target_kind": "food",
                        "target_id": "food-milk",
                        "expected_food_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "袋",
                        "storage_location": "冷藏",
                    },
                ],
            }
        )


def test_inventory_intake_rejects_duplicate_shopping_item_ids() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "dup-shopping",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "line-1",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    },
                    {
                        "line_id": "line-2",
                        "source_kind": "shopping_item",
                        "action": "fulfill_without_stock",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "none",
                    },
                ],
            }
        )


def test_direct_source_rejects_shopping_identity() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "direct-shopping-id",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "milk",
                        "source_kind": "direct",
                        "action": "stock_only",
                        "shopping_item_id": "shopping-milk",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "food",
                        "target_id": "food-milk",
                        "expected_food_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "袋",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_direct_source_rejects_fulfill_action() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "direct-fulfill",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "milk",
                        "source_kind": "direct",
                        "action": "fulfill_without_stock",
                        "target_kind": "none",
                    }
                ],
            }
        )


def test_shopping_source_rejects_stock_only() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "shopping-stock-only",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "stock_only",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_fulfill_without_stock_rejects_inventory_target() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "fulfill-target",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "fulfill_without_stock",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "1",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_presence_target_requires_paired_state_identity_and_version() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "presence-unpaired",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "salt",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-salt",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "presence_ingredient",
                        "target_id": "ingredient-salt",
                        "expected_ingredient_row_version": 1,
                        "state_id": "state-salt",
                        "resulting_availability_level": "sufficient",
                        "inventory_status": "fresh",
                        "storage_location": "常温",
                    }
                ],
            }
        )


def test_exact_and_food_targets_require_positive_quantity_and_unit() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "zero-qty",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "stock_and_fulfill",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "exact_ingredient",
                        "target_id": "ingredient-eggs",
                        "expected_ingredient_row_version": 1,
                        "actual_quantity": "0",
                        "unit": "个",
                        "inventory_status": "fresh",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )

    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "missing-unit",
                "intake_date": "2026-07-21",
                "items": [
                    {
                        "line_id": "milk",
                        "source_kind": "direct",
                        "action": "stock_only",
                        "target_kind": "food",
                        "target_id": "food-milk",
                        "expected_food_row_version": 1,
                        "actual_quantity": "1",
                        "storage_location": "冷藏",
                    }
                ],
            }
        )


def test_inventory_intake_rejects_invalid_calendar_date() -> None:
    with pytest.raises(ValidationError):
        InventoryIntakeRequest.model_validate(
            {
                "client_request_id": "bad-date",
                "intake_date": "2026-02-30",
                "items": [
                    {
                        "line_id": "eggs",
                        "source_kind": "shopping_item",
                        "action": "fulfill_without_stock",
                        "shopping_item_id": "shopping-eggs",
                        "expected_shopping_item_row_version": 1,
                        "target_kind": "none",
                    }
                ],
            }
        )


def test_shopping_request_adapter_preserves_every_business_field() -> None:
    shopping_request = ShoppingIntakeRequest.model_validate(
        {
            "client_request_id": "shopping-adapter-1",
            "purchase_date": "2026-07-21",
            "items": [
                {
                    "shopping_item_id": "shopping-eggs",
                    "expected_shopping_item_row_version": 2,
                    "action": "stock_and_fulfill",
                    "target_kind": "exact_ingredient",
                    "target_id": "ingredient-eggs",
                    "expected_ingredient_row_version": 3,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "expiry_date": "2026-07-28",
                    "storage_location": "冷藏",
                    "notes": "盒装",
                },
                {
                    "shopping_item_id": "shopping-salt",
                    "expected_shopping_item_row_version": 4,
                    "action": "stock_and_fulfill",
                    "target_kind": "presence_ingredient",
                    "target_id": "ingredient-salt",
                    "expected_ingredient_row_version": 5,
                    "state_id": "state-salt",
                    "expected_state_row_version": 6,
                    "resulting_availability_level": "sufficient",
                    "inventory_status": "opened",
                    "storage_location": "常温",
                    "notes": "厨房",
                },
                {
                    "shopping_item_id": "shopping-milk",
                    "expected_shopping_item_row_version": 7,
                    "action": "stock_and_fulfill",
                    "target_kind": "food",
                    "target_id": "food-milk",
                    "expected_food_row_version": 8,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "expiry_date": "2026-07-25",
                    "storage_location": "冷藏",
                },
                {
                    "shopping_item_id": "shopping-bag",
                    "expected_shopping_item_row_version": 9,
                    "action": "complete_without_inventory",
                    "target_kind": "none",
                    "target_id": None,
                },
            ],
        }
    )

    inventory_request = shopping_request_to_inventory_request(shopping_request)

    assert inventory_request.client_request_id == "shopping-adapter-1"
    assert inventory_request.intake_date == date(2026, 7, 21)
    assert len(inventory_request.items) == 4

    exact, presence, food, fulfill = inventory_request.items

    assert exact.line_id == "shopping:shopping-eggs"
    assert exact.source_kind == "shopping_item"
    assert exact.action == "stock_and_fulfill"
    assert exact.shopping_item_id == "shopping-eggs"
    assert exact.expected_shopping_item_row_version == 2
    assert exact.target_kind == "exact_ingredient"
    assert exact.target_id == "ingredient-eggs"
    assert exact.expected_ingredient_row_version == 3
    assert exact.actual_quantity == Decimal("2")
    assert exact.unit == "个"
    assert exact.inventory_status is not None
    assert exact.inventory_status.value == "fresh"
    assert exact.expiry_date == date(2026, 7, 28)
    assert exact.storage_location == "冷藏"
    assert exact.notes == "盒装"

    assert presence.line_id == "shopping:shopping-salt"
    assert presence.source_kind == "shopping_item"
    assert presence.action == "stock_and_fulfill"
    assert presence.shopping_item_id == "shopping-salt"
    assert presence.expected_shopping_item_row_version == 4
    assert presence.target_kind == "presence_ingredient"
    assert presence.target_id == "ingredient-salt"
    assert presence.expected_ingredient_row_version == 5
    assert presence.state_id == "state-salt"
    assert presence.expected_state_row_version == 6
    assert presence.resulting_availability_level is not None
    assert presence.resulting_availability_level.value == "sufficient"
    assert presence.inventory_status is not None
    assert presence.inventory_status.value == "opened"
    assert presence.storage_location == "常温"
    assert presence.notes == "厨房"

    assert food.line_id == "shopping:shopping-milk"
    assert food.source_kind == "shopping_item"
    assert food.action == "stock_and_fulfill"
    assert food.shopping_item_id == "shopping-milk"
    assert food.expected_shopping_item_row_version == 7
    assert food.target_kind == "food"
    assert food.target_id == "food-milk"
    assert food.expected_food_row_version == 8
    assert food.actual_quantity == Decimal("1")
    assert food.unit == "袋"
    assert food.expiry_date == date(2026, 7, 25)
    assert food.storage_location == "冷藏"

    assert fulfill.line_id == "shopping:shopping-bag"
    assert fulfill.source_kind == "shopping_item"
    assert fulfill.action == "fulfill_without_stock"
    assert fulfill.shopping_item_id == "shopping-bag"
    assert fulfill.expected_shopping_item_row_version == 9
    assert fulfill.target_kind == "none"
    assert fulfill.target_id is None


def test_inventory_result_adapter_rejects_direct_rows() -> None:
    applied_at = datetime(2026, 7, 21, 12, 0, tzinfo=timezone.utc)
    inventory_result = InventoryIntakeResult.model_validate(
        {
            "operation_id": "op-1",
            "operation_type": InventoryOperationType.SHOPPING_INTAKE,
            "status": InventoryOperationStatus.APPLIED,
            "applied_at": applied_at,
            "revertible_until": applied_at,
            "can_revert": True,
            "summary": InventoryOperationDisplaySummary(
                title="登记本次购买",
                description="完成 1 项",
                completed_count=1,
                confirmed_count=1,
            ),
            "items": [
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "shopping_item_id": None,
                    "result": "direct_stocked",
                    "inventory_item_id": None,
                    "state_id": None,
                    "food_id": "food-milk",
                }
            ],
        }
    )

    with pytest.raises(ValueError):
        inventory_result_to_shopping_result(inventory_result)


def test_direct_exact_ingredient_creates_batch_without_shopping_change(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "direct-exact-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs-direct",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "exact_ingredient",
                    "target_id": context.egg_ingredient.id,
                    "expected_ingredient_row_version": context.egg_ingredient.row_version,
                    "actual_quantity": "3",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    result = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert [item.result for item in result.items] == ["direct_stocked"]
    assert result.items[0].inventory_item_id
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).quantity == Decimal("6")
    batches = list(
        context.db.scalars(
            select(InventoryItem).where(InventoryItem.ingredient_id == context.egg_ingredient.id)
        )
    )
    assert len(batches) == 1
    assert batches[0].quantity == Decimal("3.00")


def test_direct_presence_ingredient_updates_state_without_shopping_change(
    context: IntakeServiceContext,
) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "direct-presence-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "salt-direct",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "presence_ingredient",
                    "target_id": context.presence_ingredient.id,
                    "expected_ingredient_row_version": context.presence_ingredient.row_version,
                    "state_id": context.presence_state.id,
                    "expected_state_row_version": context.presence_state.row_version,
                    "resulting_availability_level": "sufficient",
                    "inventory_status": "fresh",
                    "storage_location": "常温",
                }
            ],
        }
    )
    result = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert [item.result for item in result.items] == ["direct_stocked"]
    assert result.items[0].state_id == context.presence_state.id
    state = context.db.get(IngredientInventoryState, context.presence_state.id)
    assert state is not None
    assert state.availability_level is InventoryAvailabilityLevel.SUFFICIENT
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False


def test_direct_food_increases_stock_without_shopping_change(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "direct-food-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "milk-direct",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "2",
                    "unit": "袋",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    result = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert [item.result for item in result.items] == ["direct_stocked"]
    assert result.items[0].food_id == context.milk_food.id
    food = context.db.get(Food, context.milk_food.id)
    assert food is not None
    assert food.stock_quantity == Decimal("2")
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False


def test_food_expiry_before_intake_date_is_rejected(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "food-expiry-before-intake-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "milk-expired",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "expiry_date": "2026-07-20",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    with pytest.raises(InventoryIntakeValidationError) as exc_info:
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=request,
        )
    assert exc_info.value.code == "invalid_date_range"
    assert exc_info.value.field_errors
    assert exc_info.value.field_errors[0]["field"] == "expiry_date"
    context.db.rollback()
    food = context.db.get(Food, context.milk_food.id)
    assert food is not None
    assert food.stock_quantity == Decimal("0")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0


def test_fulfill_without_stock_completes_only_shopping_item(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "fulfill-only-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs-fulfill",
                    "source_kind": "shopping_item",
                    "action": "fulfill_without_stock",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version,
                    "target_kind": "none",
                }
            ],
        }
    )
    result = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert [item.result for item in result.items] == ["completed_without_inventory"]
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is True
    assert context.db.scalar(select(func.count()).select_from(InventoryItem)) == 0
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("0")


def test_mixed_intake_stocks_shopping_and_direct_rows_in_one_operation(
    context: IntakeServiceContext,
) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "mixed-receipt-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version,
                    "target_kind": "exact_ingredient",
                    "target_id": context.egg_ingredient.id,
                    "expected_ingredient_row_version": context.egg_ingredient.row_version,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    result = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert [item.result for item in result.items] == ["partial", "direct_stocked"]
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).quantity == Decimal("4")
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("1")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 1


def test_partial_purchase_updates_remaining_quantity(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "partial-eggs-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version,
                    "target_kind": "exact_ingredient",
                    "target_id": context.egg_ingredient.id,
                    "expected_ingredient_row_version": context.egg_ingredient.row_version,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    result = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert result.items[0].result == "partial"
    assert result.items[0].remaining_planned_quantity == Decimal("4")
    shopping = context.db.get(ShoppingListItem, context.egg_shopping.id)
    assert shopping is not None
    assert shopping.done is False
    assert shopping.quantity == Decimal("4")


def test_same_request_id_same_hash_replays_original_result(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "replay-same-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    first = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    context.db.flush()
    second = apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=request,
    )
    assert second.operation_id == first.operation_id
    assert [item.result for item in second.items] == ["direct_stocked"]
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("1")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 1


def test_same_request_id_different_hash_conflicts(context: IntakeServiceContext) -> None:
    first_request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "replay-conflict-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    apply_inventory_intake(
        context.db,
        family_id=context.family.id,
        user_id=context.user.id,
        user_role=UserRole.MEMBER,
        business_date=date(2026, 7, 21),
        request=first_request,
    )
    context.db.flush()
    second_request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "replay-conflict-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "2",
                    "unit": "袋",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    with pytest.raises(InventoryConflictError) as exc_info:
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=second_request,
        )
    assert exc_info.value.code == "idempotency_key_reused"


def test_shopping_version_conflict_rolls_back_every_row(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "stale-shopping-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version + 5,
                    "target_kind": "exact_ingredient",
                    "target_id": context.egg_ingredient.id,
                    "expected_ingredient_row_version": context.egg_ingredient.row_version,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    with pytest.raises(InventoryConflictError):
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=request,
        )
    context.db.rollback()
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("0")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0
    assert context.db.scalar(select(func.count()).select_from(InventoryItem)) == 0


def test_ingredient_version_conflict_rolls_back_every_row(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "stale-ingredient-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version,
                    "target_kind": "exact_ingredient",
                    "target_id": context.egg_ingredient.id,
                    "expected_ingredient_row_version": context.egg_ingredient.row_version + 3,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    with pytest.raises(InventoryConflictError):
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=request,
        )
    context.db.rollback()
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("0")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0


def test_food_version_conflict_rolls_back_every_row(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "stale-food-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version,
                    "target_kind": "exact_ingredient",
                    "target_id": context.egg_ingredient.id,
                    "expected_ingredient_row_version": context.egg_ingredient.row_version,
                    "actual_quantity": "6",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version + 4,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    with pytest.raises(InventoryConflictError):
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=request,
        )
    context.db.rollback()
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("0")
    assert context.db.scalar(select(func.count()).select_from(InventoryItem)) == 0
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0


def test_cross_family_target_is_rejected_before_mutation(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "cross-family-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version,
                    "target_kind": "exact_ingredient",
                    "target_id": context.other_egg_ingredient.id,
                    "expected_ingredient_row_version": context.other_egg_ingredient.row_version,
                    "actual_quantity": "2",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                }
            ],
        }
    )
    with pytest.raises(InventoryIntakeValidationError) as exc_info:
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=request,
        )
    assert exc_info.value.code == "invalid_target"
    context.db.rollback()
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False
    assert context.db.scalar(select(func.count()).select_from(InventoryItem)) == 0
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0


def test_duplicate_presence_target_is_rejected(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "dup-presence-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "salt-1",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "presence_ingredient",
                    "target_id": context.presence_ingredient.id,
                    "expected_ingredient_row_version": context.presence_ingredient.row_version,
                    "state_id": context.presence_state.id,
                    "expected_state_row_version": context.presence_state.row_version,
                    "resulting_availability_level": "sufficient",
                    "inventory_status": "fresh",
                    "storage_location": "常温",
                },
                {
                    "line_id": "salt-2",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "presence_ingredient",
                    "target_id": context.presence_ingredient.id,
                    "expected_ingredient_row_version": context.presence_ingredient.row_version,
                    "state_id": context.presence_state.id,
                    "expected_state_row_version": context.presence_state.row_version,
                    "resulting_availability_level": "low",
                    "inventory_status": "fresh",
                    "storage_location": "常温",
                },
            ],
        }
    )
    with pytest.raises(InventoryIntakeValidationError) as exc_info:
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=request,
        )
    assert exc_info.value.code == "duplicate_request_item"
    context.db.rollback()
    state = context.db.get(IngredientInventoryState, context.presence_state.id)
    assert state is not None
    assert state.availability_level is InventoryAvailabilityLevel.LOW
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0


def test_duplicate_food_target_is_rejected(context: IntakeServiceContext) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "dup-food-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "milk-1",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk-2",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "2",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    with pytest.raises(InventoryIntakeValidationError) as exc_info:
        apply_inventory_intake(
            context.db,
            family_id=context.family.id,
            user_id=context.user.id,
            user_role=UserRole.MEMBER,
            business_date=date(2026, 7, 21),
            request=request,
        )
    assert exc_info.value.code == "duplicate_request_item"
    context.db.rollback()
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("0")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0


def test_failure_after_first_row_rolls_back_inventory_shopping_history_and_activity(
    context: IntakeServiceContext,
) -> None:
    request = InventoryIntakeRequest.model_validate(
        {
            "client_request_id": "rollback-after-first-1",
            "intake_date": "2026-07-21",
            "items": [
                {
                    "line_id": "eggs",
                    "source_kind": "shopping_item",
                    "action": "stock_and_fulfill",
                    "shopping_item_id": context.egg_shopping.id,
                    "expected_shopping_item_row_version": context.egg_shopping.row_version,
                    "target_kind": "exact_ingredient",
                    "target_id": context.egg_ingredient.id,
                    "expected_ingredient_row_version": context.egg_ingredient.row_version,
                    "actual_quantity": "6",
                    "unit": "个",
                    "inventory_status": "fresh",
                    "storage_location": "冷藏",
                },
                {
                    "line_id": "milk",
                    "source_kind": "direct",
                    "action": "stock_only",
                    "target_kind": "food",
                    "target_id": context.milk_food.id,
                    "expected_food_row_version": context.milk_food.row_version,
                    "actual_quantity": "1",
                    "unit": "袋",
                    "storage_location": "冷藏",
                },
            ],
        }
    )
    with patch(
        "app.services.inventory_intake.apply_food_stock_intake",
        side_effect=RuntimeError("injected failure after first row"),
    ):
        with pytest.raises(RuntimeError, match="injected failure after first row"):
            apply_inventory_intake(
                context.db,
                family_id=context.family.id,
                user_id=context.user.id,
                user_role=UserRole.MEMBER,
                business_date=date(2026, 7, 21),
                request=request,
            )
    context.db.rollback()
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).done is False
    assert context.db.get(ShoppingListItem, context.egg_shopping.id).quantity == Decimal("6")
    assert context.db.scalar(select(func.count()).select_from(InventoryItem)) == 0
    assert context.db.get(Food, context.milk_food.id).stock_quantity == Decimal("0")
    assert context.db.scalar(select(func.count()).select_from(InventoryOperation)) == 0
    assert context.db.scalar(select(func.count()).select_from(ActivityLog)) == 0
