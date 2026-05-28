from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.domain import Ingredient, InventoryItem, Recipe
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
    deductions: list[InventoryDeduction] = field(default_factory=list)


@dataclass(slots=True)
class InventoryShortage:
    ingredient_id: str | None
    ingredient_name: str
    required_quantity: Decimal
    available_quantity: Decimal
    missing_quantity: Decimal
    unit: str

    def as_dict(self) -> dict:
        return {
            "ingredient_id": self.ingredient_id,
            "ingredient_name": self.ingredient_name,
            "required_quantity": float(self.required_quantity),
            "available_quantity": float(self.available_quantity),
            "missing_quantity": float(self.missing_quantity),
            "unit": self.unit,
        }


def remaining_quantity(item: InventoryItem) -> Decimal:
    return max(item.quantity - item.consumed_quantity, Decimal("0"))


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


def load_available_inventory_by_ingredient(
    db: Session,
    *,
    family_id: str,
    ingredient_ids: Iterable[str],
    today: date,
) -> dict[str, list[InventoryItem]]:
    ids = list(dict.fromkeys(item for item in ingredient_ids if item))
    if not ids:
        return {}

    items = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == family_id, InventoryItem.ingredient_id.in_(ids))
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
) -> tuple[list[CookInventoryPlanItem], list[dict]]:
    scale = Decimal(str(servings)) / Decimal(str(recipe.servings or 1))
    consumption_plan: list[CookInventoryPlanItem] = []
    shortages: list[dict] = []
    reserved_quantities_by_inventory_item: dict[str, Decimal] = {}

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

        available_items = available_inventory_for_ingredient(
            db,
            family_id=family_id,
            ingredient_id=ingredient_item.ingredient_id,
            today=today,
            inventory_by_ingredient=inventory_by_ingredient,
        )
        ingredient = available_items[0].ingredient if available_items else None
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
            continue

        remaining_to_consume = requested_in_default
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
