from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.domain import (
    Food,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    ShoppingListItem,
)


class InventoryTargetNotFoundError(ValueError):
    """Raised when a family-scoped lock set is incomplete (missing or cross-family)."""


@dataclass(slots=True)
class LockedInventoryTargets:
    ingredients: dict[str, Ingredient]
    foods: dict[str, Food]
    states_by_ingredient_id: dict[str, IngredientInventoryState]
    inventory_items: dict[str, InventoryItem]
    shopping_items: dict[str, ShoppingListItem]


def _unique_sorted_ids(ids: Iterable[str]) -> list[str]:
    return sorted({item_id for item_id in ids if item_id})


def lock_inventory_targets(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: Iterable[str] = (),
    food_ids: Iterable[str] = (),
    state_ingredient_ids: Iterable[str] = (),
    optional_state_ingredient_ids: Iterable[str] = (),
    inventory_item_ids: Iterable[str] = (),
    shopping_item_ids: Iterable[str] = (),
) -> LockedInventoryTargets:
    """Lock inventory-related rows in the global parent-first order.

    Order: Ingredient → Food → IngredientInventoryState → InventoryItem → ShoppingListItem.
    InventoryOperation locking is handled by undo/history callers separately.
    """
    ordered_ingredient_ids = _unique_sorted_ids(ingredient_ids)
    ordered_food_ids = _unique_sorted_ids(food_ids)
    required_state_ingredient_ids = _unique_sorted_ids(state_ingredient_ids)
    ordered_state_ingredient_ids = sorted(
        {
            *required_state_ingredient_ids,
            *_unique_sorted_ids(optional_state_ingredient_ids),
        }
    )
    ordered_inventory_item_ids = _unique_sorted_ids(inventory_item_ids)
    ordered_shopping_item_ids = _unique_sorted_ids(shopping_item_ids)

    ingredients: dict[str, Ingredient] = {}
    if ordered_ingredient_ids:
        locked_ingredients = list(
            db.scalars(
                select(Ingredient)
                .where(
                    Ingredient.family_id == family_id,
                    Ingredient.id.in_(ordered_ingredient_ids),
                )
                .order_by(Ingredient.id.asc())
                .with_for_update()
            )
        )
        if len(locked_ingredients) != len(ordered_ingredient_ids):
            raise InventoryTargetNotFoundError("食材不存在或不属于当前家庭")
        ingredients = {item.id: item for item in locked_ingredients}

    foods: dict[str, Food] = {}
    if ordered_food_ids:
        locked_foods = list(
            db.scalars(
                select(Food)
                .where(Food.family_id == family_id, Food.id.in_(ordered_food_ids))
                .order_by(Food.id.asc())
                .with_for_update()
            )
        )
        if len(locked_foods) != len(ordered_food_ids):
            raise InventoryTargetNotFoundError("食物不存在或不属于当前家庭")
        foods = {item.id: item for item in locked_foods}

    states_by_ingredient_id: dict[str, IngredientInventoryState] = {}
    if ordered_state_ingredient_ids:
        locked_states = list(
            db.scalars(
                select(IngredientInventoryState)
                .where(
                    IngredientInventoryState.family_id == family_id,
                    IngredientInventoryState.ingredient_id.in_(ordered_state_ingredient_ids),
                )
                .order_by(IngredientInventoryState.ingredient_id.asc())
                .with_for_update()
            )
        )
        states_by_ingredient_id = {item.ingredient_id: item for item in locked_states}
        if any(
            ingredient_id not in states_by_ingredient_id
            for ingredient_id in required_state_ingredient_ids
        ):
            raise InventoryTargetNotFoundError("库存状态不存在或不属于当前家庭")

    inventory_items: dict[str, InventoryItem] = {}
    if ordered_inventory_item_ids:
        locked_items = list(
            db.scalars(
                select(InventoryItem)
                .where(
                    InventoryItem.family_id == family_id,
                    InventoryItem.id.in_(ordered_inventory_item_ids),
                )
                .options(selectinload(InventoryItem.ingredient))
                .order_by(InventoryItem.id.asc())
                .with_for_update()
            )
        )
        if len(locked_items) != len(ordered_inventory_item_ids):
            raise InventoryTargetNotFoundError("库存批次不存在或不属于当前家庭")
        inventory_items = {item.id: item for item in locked_items}

    shopping_items: dict[str, ShoppingListItem] = {}
    if ordered_shopping_item_ids:
        locked_shopping = list(
            db.scalars(
                select(ShoppingListItem)
                .where(
                    ShoppingListItem.family_id == family_id,
                    ShoppingListItem.id.in_(ordered_shopping_item_ids),
                )
                .order_by(ShoppingListItem.id.asc())
                .with_for_update()
            )
        )
        if len(locked_shopping) != len(ordered_shopping_item_ids):
            raise InventoryTargetNotFoundError("采购项不存在或不属于当前家庭")
        shopping_items = {item.id: item for item in locked_shopping}

    return LockedInventoryTargets(
        ingredients=ingredients,
        foods=foods,
        states_by_ingredient_id=states_by_ingredient_id,
        inventory_items=inventory_items,
        shopping_items=shopping_items,
    )
