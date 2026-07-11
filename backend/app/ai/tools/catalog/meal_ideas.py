from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.core.utils import create_id
from app.models.domain import Ingredient
from app.services.clock import today_for_family
from app.services.ingredient_inventory_state import state_is_usable
from app.services.inventory_usage import (
    inventory_remaining_in_default,
    load_available_inventory_by_ingredient,
    load_presence_states_for_ingredients,
    tracks_quantity,
)


MEAL_IDEA_INPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["title", "ingredientIds", "reason"],
    "properties": {
        "title": {"type": "string", "minLength": 1, "maxLength": 120},
        "ingredientIds": {
            "type": "array",
            "minItems": 1,
            "maxItems": 30,
            "items": {"type": "string", "minLength": 1, "maxLength": 64},
        },
        "reason": {"type": "string", "minLength": 1, "maxLength": 500},
        "preparationSummary": {"type": ["string", "null"], "maxLength": 500},
    },
}

MEAL_IDEA_INGREDIENT_OUTPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ingredientId", "name", "quantityMode", "availableQuantity", "unit", "available"],
    "properties": {
        "ingredientId": {"type": "string"},
        "name": {"type": "string"},
        "quantityMode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
        "availableQuantity": {"type": ["string", "null"]},
        "unit": {"type": ["string", "null"]},
        "available": {"type": "boolean"},
    },
}

MEAL_IDEA_OUTPUT: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["card"],
    "properties": {
        "card": {
            "type": "object",
            "additionalProperties": False,
            "required": ["id", "type", "title", "data"],
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string", "enum": ["meal_idea_proposal"]},
                "title": {"type": "string"},
                "data": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["title", "reason", "ingredientIds", "ingredients", "preparationSummary"],
                    "properties": {
                        "title": {"type": "string"},
                        "reason": {"type": "string"},
                        "ingredientIds": {"type": "array", "items": {"type": "string"}},
                        "ingredients": {"type": "array", "items": MEAL_IDEA_INGREDIENT_OUTPUT},
                        "preparationSummary": {"type": ["string", "null"]},
                    },
                },
            },
        }
    },
}


def _decimal_text(value: Decimal) -> str:
    return format(value.normalize(), "f")


def _require_empty_library_searches(context: ToolContext) -> None:
    latest_results = {}
    for result in reversed(context.tool_results):
        if result.name in {"food.search", "recipe.search"} and result.name not in latest_results:
            latest_results[result.name] = result
    if set(latest_results) != {"food.search", "recipe.search"}:
        raise ValueError("library_search_required")
    if any(
        result.status != "completed"
        or type(result.output.get("count")) is not int
        or result.output["count"] < 0
        for result in latest_results.values()
    ):
        raise ValueError("library_search_required")
    if any(result.output["count"] > 0 for result in latest_results.values()):
        raise ValueError("library_candidates_available")


def execute_propose_meal_idea(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    ingredient_ids = list(
        dict.fromkeys(str(ingredient_id).strip() for ingredient_id in payload.get("ingredientIds") or [] if str(ingredient_id).strip())
    )
    ingredients = list(
        context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                Ingredient.id.in_(ingredient_ids),
            )
        )
    )
    ingredients_by_id = {ingredient.id: ingredient for ingredient in ingredients}
    if set(ingredients_by_id) != set(ingredient_ids):
        raise ValueError("ingredient_not_found")
    _require_empty_library_searches(context)
    today = today_for_family(context.family_id)
    inventory_by_ingredient = load_available_inventory_by_ingredient(
        context.db,
        family_id=context.family_id,
        ingredient_ids=ingredient_ids,
        today=today,
    )
    presence_states = load_presence_states_for_ingredients(
        context.db,
        family_id=context.family_id,
        ingredient_ids=[
            ingredient_id
            for ingredient_id, ingredient in ingredients_by_id.items()
            if not tracks_quantity(ingredient)
        ],
    )
    summaries: list[dict[str, Any]] = []
    for ingredient_id in ingredient_ids:
        ingredient = ingredients_by_id[ingredient_id]
        available_items = inventory_by_ingredient.get(ingredient.id, [])
        is_tracked = tracks_quantity(ingredient)
        if is_tracked:
            available_quantity = sum(
                (inventory_remaining_in_default(item, ingredient) for item in available_items),
                Decimal("0"),
            )
            available = bool(available_items) and available_quantity > 0
        else:
            state = presence_states.get(ingredient.id)
            available_quantity = None
            available = state is not None and state_is_usable(state, business_date=today)
        summaries.append(
            {
                "ingredientId": ingredient.id,
                "name": ingredient.name,
                "quantityMode": "track_quantity" if is_tracked else "not_track_quantity",
                "availableQuantity": _decimal_text(available_quantity) if available_quantity is not None else None,
                "unit": ingredient.default_unit,
                "available": available,
            }
        )
    if not any(summary["available"] for summary in summaries):
        raise ValueError("inventory_not_available")
    title = str(payload.get("title") or "").strip()
    return {
        "card": {
            "id": create_id("meal_idea_proposal"),
            "type": "meal_idea_proposal",
            "title": title,
            "data": {
                "title": title,
                "reason": str(payload.get("reason") or "").strip(),
                "ingredientIds": ingredient_ids,
                "ingredients": summaries,
                "preparationSummary": str(payload.get("preparationSummary") or "").strip() or None,
            },
        }
    }


def register_meal_idea_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="meal_plan.propose_from_inventory",
        display_name="库存餐食想法",
        description="仅当本轮 food.search 和 recipe.search 都返回空结果时，基于当前家庭真实 Ingredient ID 返回餐食想法卡，不创建 Food、Recipe 或计划。",
        side_effect="read",
        handler=execute_propose_meal_idea,
        input_schema=MEAL_IDEA_INPUT,
        output_schema=MEAL_IDEA_OUTPUT,
        terminal_output=True,
        output_types=["meal_idea_proposal"],
    )
