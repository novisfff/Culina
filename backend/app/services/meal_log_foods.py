from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import FoodType
from app.core.utils import create_id
from app.models.domain import Food, FoodPlanItem, MealLogFood, MediaAsset, ShoppingListItem
from app.services.search.jobs import enqueue_search_index_job

QUICK_RECORD_FOOD_TYPES = {
    FoodType.SELF_MADE,
    FoodType.TAKEOUT,
    FoodType.DINING_OUT,
    FoodType.READY_MADE,
}

MINIMAL_FOOD_CATEGORIES = {
    FoodType.SELF_MADE: "家常菜",
    FoodType.TAKEOUT: "外卖",
    FoodType.DINING_OUT: "外食",
    FoodType.READY_MADE: "即食",
}

_MINIMAL_NAME_MAX_LENGTH = 120


def _normalize_food_type(food_type: FoodType | str) -> FoodType:
    if isinstance(food_type, FoodType):
        return food_type
    try:
        return FoodType(food_type)
    except ValueError as exc:
        raise ValueError("不支持的快速记录食物类型") from exc


def _normalize_minimal_food_name(name: str) -> str:
    normalized = (name or "").strip()
    if not normalized:
        raise ValueError("食物名称不能为空")
    if len(normalized) > _MINIMAL_NAME_MAX_LENGTH:
        raise ValueError(f"食物名称不能超过 {_MINIMAL_NAME_MAX_LENGTH} 个字符")
    return normalized


def create_minimal_meal_food(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    name: str,
    food_type: FoodType | str,
) -> Food:
    """Create a current-family minimal Food for quick meal recording.

    This is the only path that may create ``selfMade`` Food with ``recipe_id=None``.
    Ordinary ``POST /api/foods`` continues to reject synced self-made payloads.
    """
    resolved_type = _normalize_food_type(food_type)
    if resolved_type not in QUICK_RECORD_FOOD_TYPES:
        raise ValueError("不支持的快速记录食物类型")
    resolved_name = _normalize_minimal_food_name(name)

    food = Food(
        id=create_id("food"),
        family_id=family_id,
        name=resolved_name,
        type=resolved_type.value,
        category=MINIMAL_FOOD_CATEGORIES[resolved_type],
        flavor_tags=[],
        scene_tags=[],
        suitable_meal_types=[],
        source_name="",
        purchase_source="",
        scene="",
        notes="",
        routine_note="",
        price=None,
        rating=None,
        repurchase=None,
        expiry_date=None,
        stock_quantity=None,
        stock_unit="",
        storage_location="",
        favorite=False,
        recipe_id=None,
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(food)
    db.flush()
    enqueue_search_index_job(
        db,
        family_id=family_id,
        user_id=user_id,
        entity_type="food",
        entity_id=food.id,
        target_name=food.name,
    )
    return food


def is_food_recommendation_eligible(food: Food, distinct_meal_count: int) -> bool:
    """Return whether a Food may enter homepage recommendations.

    Eligibility is derived from current facts only: repeated meals, favorite,
    positive stock, linked recipe, or non-empty external source fields.
    """
    if int(distinct_meal_count) >= 2:
        return True
    if food.favorite:
        return True
    if food.recipe_id:
        return True
    stock_quantity = food.stock_quantity
    if stock_quantity is not None and Decimal(str(stock_quantity)) > 0:
        return True
    if (food.source_name or "").strip() or (food.purchase_source or "").strip():
        return True
    return False


def _matches_minimal_creation_defaults(food: Food) -> bool:
    try:
        food_type = FoodType(food.type.value if hasattr(food.type, "value") else food.type)
    except ValueError:
        return False
    if food_type not in QUICK_RECORD_FOOD_TYPES:
        return False
    if food.category != MINIMAL_FOOD_CATEGORIES[food_type]:
        return False
    if food.recipe_id is not None:
        return False
    if food.favorite:
        return False
    if food.stock_quantity is not None:
        return False
    if (food.stock_unit or "").strip():
        return False
    if food.expiry_date is not None:
        return False
    if food.price is not None or food.rating is not None or food.repurchase is not None:
        return False
    if food.inventory_last_confirmed_at is not None or food.inventory_last_confirmed_by is not None:
        return False
    if food.inventory_confirmation_source is not None:
        return False
    if (food.source_name or "").strip() or (food.purchase_source or "").strip():
        return False
    if (food.scene or "").strip() or (food.notes or "").strip() or (food.routine_note or "").strip():
        return False
    if (food.storage_location or "").strip():
        return False
    if food.flavor_tags or food.scene_tags or food.suitable_meal_types:
        return False
    return True


def can_delete_record_created_food(db: Session, food: Food) -> bool:
    """Return whether a record-created Food may be deleted during revert.

    Callers must already hold a lock on ``food``. The Food is deleted only when it
    still matches creation defaults, has ``row_version == 1``, and has no remaining
    MealLog, plan, shopping, inventory, or media references.
    """
    if int(food.row_version) != 1:
        return False
    if not _matches_minimal_creation_defaults(food):
        return False

    has_meal = (
        db.scalar(select(MealLogFood.id).where(MealLogFood.food_id == food.id).limit(1)) is not None
    )
    if has_meal:
        return False

    has_plan = (
        db.scalar(select(FoodPlanItem.id).where(FoodPlanItem.food_id == food.id).limit(1)) is not None
    )
    if has_plan:
        return False

    has_shopping = (
        db.scalar(select(ShoppingListItem.id).where(ShoppingListItem.food_id == food.id).limit(1))
        is not None
    )
    if has_shopping:
        return False

    has_media = (
        db.scalar(
            select(MediaAsset.id).where(
                MediaAsset.family_id == food.family_id,
                MediaAsset.entity_type == "food",
                MediaAsset.entity_id == food.id,
            ).limit(1)
        )
        is not None
    )
    if has_media:
        return False

    return True
