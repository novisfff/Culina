from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import IngredientQuantityTrackingMode
from app.models.domain import Ingredient, IngredientInventoryState, InventoryItem, Recipe
from app.services.ingredient_units import UnitConversionError, convert_quantity_from_default_unit, convert_quantity_to_default_unit


@dataclass(slots=True)
class InventoryDeduction:
    item: InventoryItem
    quantity: Decimal
    quantity_in_default: Decimal


@dataclass(slots=True)
class CookInventoryPlanItem:
    ingredient: Ingredient
    ingredient_item: object
    requested_quantity: Decimal
    requested_in_default: Decimal
    quantity_tracking_mode: str = IngredientQuantityTrackingMode.TRACK_QUANTITY.value
    deduction_note: str | None = None
    deductions: list[InventoryDeduction] = field(default_factory=list)


@dataclass(slots=True)
class InventoryShortage:
    ingredient_id: str | None
    ingredient_name: str
    required_quantity: Decimal
    available_quantity: Decimal
    missing_quantity: Decimal
    unit: str
    shortage_type: str = "quantity"

    def as_dict(self) -> dict:
        return {
            "ingredient_id": self.ingredient_id,
            "ingredient_name": self.ingredient_name,
            "required_quantity": float(self.required_quantity),
            "available_quantity": float(self.available_quantity),
            "missing_quantity": float(self.missing_quantity),
            "unit": self.unit,
            "shortage_type": self.shortage_type,
        }


def tracks_quantity(ingredient: Ingredient) -> bool:
    mode = getattr(ingredient, "quantity_tracking_mode", IngredientQuantityTrackingMode.TRACK_QUANTITY)
    value = mode.value if hasattr(mode, "value") else str(mode)
    return value != IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY.value


def remaining_quantity(item: InventoryItem) -> Decimal:
    return max(
        item.quantity - item.consumed_quantity - getattr(item, "disposed_quantity", Decimal("0")),
        Decimal("0"),
    )


def is_presence_available(item: InventoryItem, *, today: date) -> bool:
    """Legacy placeholder helper; presence truth now lives on IngredientInventoryState."""
    if item.expiry_date is not None and item.expiry_date < today:
        return False
    return item.quantity - getattr(item, "disposed_quantity", Decimal("0")) > 0


def expiry_sort_key(expiry_date: date | None) -> tuple[int, date]:
    return (1, date.max) if expiry_date is None else (0, expiry_date)


def inventory_remaining_in_default(item: InventoryItem, ingredient: Ingredient) -> Decimal:
    if item.unit == ingredient.default_unit:
        return remaining_quantity(item)
    return convert_quantity_to_default_unit(remaining_quantity(item), ingredient.default_unit, ingredient.unit_conversions, item.unit)


def convert_default_to_item_unit(quantity: Decimal, item: InventoryItem, ingredient: Ingredient) -> Decimal:
    if item.unit == ingredient.default_unit:
        return quantity
    return convert_quantity_from_default_unit(quantity, ingredient.default_unit, ingredient.unit_conversions, item.unit)


def load_presence_states_for_ingredients(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: Iterable[str],
) -> dict[str, IngredientInventoryState]:
    ids = list(dict.fromkeys(item for item in ingredient_ids if item))
    if not ids:
        return {}
    states = list(
        db.scalars(
            select(IngredientInventoryState).where(
                IngredientInventoryState.family_id == family_id,
                IngredientInventoryState.ingredient_id.in_(ids),
            )
        )
    )
    return {state.ingredient_id: state for state in states}


def load_available_inventory_by_ingredient(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: Iterable[str],
    today: date,
) -> dict[str, list[InventoryItem]]:
    """Return usable precise InventoryItem batches only.

    Presence ingredients no longer contribute placeholder InventoryItem rows here.
    Callers that need presence readiness must use load_presence_states_for_ingredients
    + state_is_usable.
    """
    ids = list(dict.fromkeys(item for item in ingredient_ids if item))
    if not ids:
        return {}

    ingredients = {
        ingredient.id: ingredient
        for ingredient in db.scalars(
            select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id.in_(ids))
        )
    }
    tracked_ids = [ingredient_id for ingredient_id, ingredient in ingredients.items() if tracks_quantity(ingredient)]
    if not tracked_ids:
        return {}

    items = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == family_id, InventoryItem.ingredient_id.in_(tracked_ids))
            .options(selectinload(InventoryItem.ingredient))
        )
    )
    items_by_ingredient: dict[str, list[InventoryItem]] = {}
    for item in items:
        if item.expiry_date is not None and item.expiry_date < today:
            continue
        if remaining_quantity(item) <= 0:
            continue
        items_by_ingredient.setdefault(item.ingredient_id, []).append(item)

    for available_items in items_by_ingredient.values():
        available_items.sort(key=lambda item: (*expiry_sort_key(item.expiry_date), item.purchase_date, item.created_at))
    return items_by_ingredient


def available_inventory_for_ingredient(
    db: Session,
    *,
    family_id: str,
    ingredient_id: str,
    today: date,
    inventory_by_ingredient: dict[str, list[InventoryItem]] | None = None,
) -> list[InventoryItem]:
    if inventory_by_ingredient is not None:
        return list(inventory_by_ingredient.get(ingredient_id, []))
    return load_available_inventory_by_ingredient(
        db,
        family_id=family_id,
        ingredient_ids=[ingredient_id],
        today=today,
    ).get(ingredient_id, [])


def build_cook_inventory_plan(
    db: Session,
    *,
    family_id: str,
    recipe: Recipe,
    servings: float,
    today: date,
    inventory_by_ingredient: dict[str, list[InventoryItem]] | None = None,
    allow_partial_deduction: bool = False,
    presence_states_by_ingredient: dict[str, IngredientInventoryState] | None = None,
) -> tuple[list[CookInventoryPlanItem], list[dict]]:
    from app.services.ingredient_inventory_state import state_is_usable

    scale = Decimal(str(servings)) / Decimal(str(recipe.servings or 1))
    consumption_plan: list[CookInventoryPlanItem] = []
    shortages: list[dict] = []
    reserved_quantities_by_inventory_item: dict[str, Decimal] = {}
    ingredient_ids = [item.ingredient_id for item in recipe.ingredient_items if item.ingredient_id]
    ingredients_by_id = {
        ingredient.id: ingredient
        for ingredient in db.scalars(
            select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id.in_(ingredient_ids))
        )
    } if ingredient_ids else {}
    if presence_states_by_ingredient is None:
        presence_ids = [
            ingredient_id
            for ingredient_id, ingredient in ingredients_by_id.items()
            if not tracks_quantity(ingredient)
        ]
        presence_states_by_ingredient = load_presence_states_for_ingredients(
            db,
            family_id=family_id,
            ingredient_ids=presence_ids,
        )

    for ingredient_item in recipe.ingredient_items:
        requested_quantity = Decimal(str(ingredient_item.quantity)) * scale
        if requested_quantity <= 0:
            continue
        if not ingredient_item.ingredient_id:
            shortages.append(
                InventoryShortage(
                    ingredient_id=None,
                    ingredient_name=ingredient_item.ingredient_name,
                    required_quantity=requested_quantity,
                    available_quantity=Decimal("0"),
                    missing_quantity=requested_quantity,
                    unit=ingredient_item.unit,
                ).as_dict()
            )
            continue

        ingredient = ingredients_by_id.get(ingredient_item.ingredient_id)
        available_items = available_inventory_for_ingredient(
            db,
            family_id=family_id,
            ingredient_id=ingredient_item.ingredient_id,
            today=today,
            inventory_by_ingredient=inventory_by_ingredient,
        )
        ingredient = ingredient or (available_items[0].ingredient if available_items else None)
        if ingredient is None:
            shortages.append(
                InventoryShortage(
                    ingredient_id=ingredient_item.ingredient_id,
                    ingredient_name=ingredient_item.ingredient_name,
                    required_quantity=requested_quantity,
                    available_quantity=Decimal("0"),
                    missing_quantity=requested_quantity,
                    unit=ingredient_item.unit,
                ).as_dict()
            )
            continue

        if not tracks_quantity(ingredient):
            state = presence_states_by_ingredient.get(ingredient.id)
            if state is None or not state_is_usable(state, business_date=today):
                shortages.append(
                    InventoryShortage(
                        ingredient_id=ingredient_item.ingredient_id,
                        ingredient_name=ingredient_item.ingredient_name,
                        required_quantity=requested_quantity,
                        available_quantity=Decimal("0"),
                        missing_quantity=requested_quantity,
                        unit=ingredient_item.unit,
                        shortage_type="presence",
                    ).as_dict()
                )
                continue
            consumption_plan.append(
                CookInventoryPlanItem(
                    ingredient=ingredient,
                    ingredient_item=ingredient_item,
                    requested_quantity=requested_quantity,
                    requested_in_default=Decimal("0"),
                    quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY.value,
                    deduction_note="仅确认有库存，未扣减数量",
                    deductions=[],
                )
            )
            continue

        requested_in_default = convert_quantity_to_default_unit(
            requested_quantity,
            ingredient.default_unit,
            ingredient.unit_conversions,
            ingredient_item.unit,
        )
        available_in_default = sum(
            max(inventory_remaining_in_default(item, ingredient) - reserved_quantities_by_inventory_item.get(item.id, Decimal("0")), Decimal("0"))
            for item in available_items
        )

        if available_in_default < requested_in_default:
            try:
                available_in_requested_unit = convert_quantity_from_default_unit(
                    available_in_default,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    ingredient_item.unit,
                )
            except UnitConversionError:
                available_in_requested_unit = available_in_default
            available_quantity = Decimal(str(available_in_requested_unit))
            shortages.append(
                InventoryShortage(
                    ingredient_id=ingredient_item.ingredient_id,
                    ingredient_name=ingredient_item.ingredient_name,
                    required_quantity=requested_quantity,
                    available_quantity=available_quantity,
                    missing_quantity=max(requested_quantity - available_quantity, Decimal("0")),
                    unit=ingredient_item.unit,
                ).as_dict()
            )
            if not allow_partial_deduction or available_in_default <= 0:
                continue
            remaining_to_consume = available_in_default
            deduction_note = "库存不足，已扣减现有库存，缺少部分仅记录提醒"
        else:
            remaining_to_consume = requested_in_default
            deduction_note = None

        deductions: list[InventoryDeduction] = []
        for item in available_items:
            if remaining_to_consume <= 0:
                break
            remaining_in_default = max(
                inventory_remaining_in_default(item, ingredient) - reserved_quantities_by_inventory_item.get(item.id, Decimal("0")),
                Decimal("0"),
            )
            deduction_in_default = min(remaining_in_default, remaining_to_consume)
            if deduction_in_default <= 0:
                continue
            deduction_in_item_unit = convert_default_to_item_unit(deduction_in_default, item, ingredient)
            reserved_quantities_by_inventory_item[item.id] = reserved_quantities_by_inventory_item.get(item.id, Decimal("0")) + deduction_in_default
            deductions.append(InventoryDeduction(item=item, quantity=deduction_in_item_unit, quantity_in_default=deduction_in_default))
            remaining_to_consume -= deduction_in_default

        consumption_plan.append(
            CookInventoryPlanItem(
                ingredient=ingredient,
                ingredient_item=ingredient_item,
                requested_quantity=requested_quantity,
                requested_in_default=requested_in_default,
                quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY.value,
                deduction_note=deduction_note,
                deductions=deductions,
            )
        )

    return consumption_plan, shortages


def serialize_cook_preview_item(plan: CookInventoryPlanItem) -> dict:
    return {
        "ingredient_id": plan.ingredient.id,
        "ingredient_name": plan.ingredient_item.ingredient_name,
        "requested_quantity": float(plan.requested_quantity),
        "unit": plan.ingredient_item.unit,
        "quantity_tracking_mode": plan.quantity_tracking_mode,
        "deduction_note": plan.deduction_note,
        "batches": [
            {
                "inventory_item_id": deduction.item.id,
                "quantity": float(deduction.quantity),
                "unit": deduction.item.unit,
                "purchase_date": deduction.item.purchase_date,
                "expiry_date": deduction.item.expiry_date,
                "storage_location": deduction.item.storage_location,
            }
            for deduction in plan.deductions
        ],
    }


def recipe_availability_summary(
    db: Session,
    *,
    family_id: str,
    recipe: Recipe,
    today: date,
    inventory_by_ingredient: dict[str, list[InventoryItem]] | None = None,
) -> dict:
    plan, shortages = build_cook_inventory_plan(
        db,
        family_id=family_id,
        recipe=recipe,
        servings=recipe.servings or 1,
        today=today,
        inventory_by_ingredient=inventory_by_ingredient,
    )
    total_count = len(recipe.ingredient_items)
    ready_count = max(total_count - len(shortages), 0)
    availability_score = 0 if total_count == 0 else ready_count / total_count
    if not shortages:
        availability = "ready"
    elif availability_score >= 0.5:
        availability = "partial"
    else:
        availability = "missing"
    return {
        "recipe_id": recipe.id,
        "availability": availability,
        "availability_score": availability_score,
        "ready_count": ready_count,
        "total_count": total_count,
        "shortages": shortages,
        "plan_count": len(plan),
    }


def recipe_availability_rank(value: str) -> int:
    return {"ready": 0, "partial": 1, "missing": 2}.get(value, 3)


def build_ingredient_consumption_plan(
    *,
    ingredient: Ingredient,
    items: list[InventoryItem],
    requested_quantity: Decimal,
    unit: str,
    today: date,
) -> tuple[Decimal, Decimal, list[InventoryDeduction]]:
    if not tracks_quantity(ingredient):
        return Decimal("0"), Decimal("0"), []

    requested_quantity_in_default = convert_quantity_to_default_unit(
        requested_quantity,
        ingredient.default_unit,
        ingredient.unit_conversions,
        unit,
    )
    available_items: list[tuple[InventoryItem, Decimal]] = []
    for item in items:
        if item.expiry_date is not None and item.expiry_date < today:
            continue
        try:
            remaining_in_default = inventory_remaining_in_default(item, ingredient)
        except UnitConversionError:
            continue
        if remaining_in_default > 0:
            available_items.append((item, remaining_in_default))
    available_items.sort(key=lambda entry: (*expiry_sort_key(entry[0].expiry_date), entry[0].purchase_date, entry[0].created_at))

    available_total = sum((remaining for _, remaining in available_items), Decimal("0"))
    remaining_to_consume = requested_quantity_in_default
    deductions: list[InventoryDeduction] = []
    if available_total < requested_quantity_in_default:
        return requested_quantity_in_default, available_total, deductions

    for item, remaining_quantity_in_default in available_items:
        if remaining_to_consume <= 0:
            break
        deduction_in_default = min(remaining_quantity_in_default, remaining_to_consume)
        if deduction_in_default <= 0:
            continue
        deduction_in_item_unit = convert_default_to_item_unit(deduction_in_default, item, ingredient)
        deductions.append(InventoryDeduction(item=item, quantity=deduction_in_item_unit, quantity_in_default=deduction_in_default))
        remaining_to_consume -= deduction_in_default
    return requested_quantity_in_default, available_total, deductions
