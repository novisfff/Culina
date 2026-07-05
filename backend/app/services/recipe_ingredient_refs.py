from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import IngredientQuantityTrackingMode
from app.models.domain import Ingredient


class RecipeIngredientReferenceError(ValueError):
    code = "recipe_unresolved_ingredients"

    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items
        names = "、".join(item.get("ingredient_name") or f"第 {item.get('index', 0) + 1} 项" for item in items[:5])
        suffix = "等" if len(items) > 5 else ""
        super().__init__(f"菜谱中有未解析的食材：{names}{suffix}")


def normalize_recipe_ingredient_items(
    db: Session,
    *,
    family_id: str,
    items: list[Any],
) -> list[dict[str, Any]]:
    raw_items = [_coerce_item(item) for item in items]
    ingredient_ids = list(
        dict.fromkeys(
            ingredient_id
            for item in raw_items
            if (ingredient_id := _ingredient_id(item))
        )
    )
    ingredients_by_id = {
        item.id: item
        for item in db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == family_id,
                Ingredient.id.in_(ingredient_ids),
            )
        )
    } if ingredient_ids else {}

    unresolved: list[dict[str, Any]] = []
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(raw_items):
        ingredient_id = _ingredient_id(item)
        if not ingredient_id:
            unresolved.append(_unresolved_item(index, item, reason="missing_ingredient_id"))
            continue
        ingredient = ingredients_by_id.get(ingredient_id)
        if ingredient is None:
            unresolved.append(_unresolved_item(index, item, reason="ingredient_not_found"))
            continue
        quantity = _normalized_quantity(item, ingredient)
        if quantity is None:
            unresolved.append(_unresolved_item(index, item, reason="quantity_required"))
            continue
        normalized.append(
            {
                **item,
                "ingredient_id": ingredient.id,
                "ingredient_name": ingredient.name,
                "quantity": quantity,
                "unit": ingredient.default_unit,
                "note": str(item.get("note") or ""),
            }
        )

    if unresolved:
        raise RecipeIngredientReferenceError(unresolved)
    return normalized


def recipe_ingredient_reference_error_detail(exc: RecipeIngredientReferenceError) -> dict[str, Any]:
    return {
        "code": exc.code,
        "message": str(exc),
        "items": exc.items,
    }


def _coerce_item(item: Any) -> dict[str, Any]:
    if hasattr(item, "model_dump"):
        return item.model_dump(mode="json")
    if isinstance(item, dict):
        return dict(item)
    return {}


def _ingredient_id(item: dict[str, Any]) -> str:
    return str(item.get("ingredient_id") or item.get("ingredientId") or "").strip()


def _tracks_quantity(ingredient: Ingredient) -> bool:
    mode = ingredient.quantity_tracking_mode
    value = mode.value if hasattr(mode, "value") else str(mode)
    return value != IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY.value


def _normalized_quantity(item: dict[str, Any], ingredient: Ingredient) -> float | None:
    raw_quantity = item.get("quantity")
    try:
        quantity = float(raw_quantity)
    except (TypeError, ValueError):
        quantity = 0
    if quantity > 0:
        return quantity
    if not _tracks_quantity(ingredient):
        return 1
    return None


def _unresolved_item(index: int, item: dict[str, Any], *, reason: str) -> dict[str, Any]:
    return {
        "index": index,
        "ingredient_id": _ingredient_id(item) or None,
        "ingredient_name": str(item.get("ingredient_name") or item.get("ingredientName") or "").strip(),
        "quantity": item.get("quantity"),
        "unit": str(item.get("unit") or "").strip(),
        "note": str(item.get("note") or "").strip(),
        "reason": reason,
    }
