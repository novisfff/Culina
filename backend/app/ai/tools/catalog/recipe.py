from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.ai.kitchen.recipe_drafts import RECIPE_DRAFT_JSON_SCHEMA
from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import entity_media_map, first_entity_media, register_tool
from app.ai.tools.draft_validation import normalize_recipe_draft_for_tools
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, LIMIT_INPUT, draft_input_schema, draft_output_schema
from app.models.domain import Recipe

RECIPE_TOOL_DRAFT_SCHEMA = {
    **RECIPE_DRAFT_JSON_SCHEMA,
    "properties": {
        **RECIPE_DRAFT_JSON_SCHEMA["properties"],
        "media_ids": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
    },
}


def recipe_search(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 24)
    recipes = list(
        context.db.scalars(
            select(Recipe)
            .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.foods))
            .where(Recipe.family_id == context.family_id)
            .limit(limit)
        )
    )
    media_map = entity_media_map(context.db, family_id=context.family_id, entity_types={"recipe"}, entity_ids=[item.id for item in recipes])
    return {
        "items": [
            {
                "id": item.id,
                "title": item.title,
                "image": first_entity_media(media_map, "recipe", item.id),
                "servings": item.servings,
                "prepMinutes": item.prep_minutes,
                "difficulty": item.difficulty.value if hasattr(item.difficulty, "value") else str(item.difficulty),
                "sceneTags": item.scene_tags or [],
                "foodIds": [food.id for food in item.foods],
                "ingredients": [
                    {
                        "ingredientId": ingredient.ingredient_id,
                        "name": ingredient.ingredient_name,
                        "quantity": float(ingredient.quantity),
                        "unit": ingredient.unit,
                        "note": ingredient.note,
                    }
                    for ingredient in item.ingredient_items
                ],
            }
            for item in recipes
        ],
        "count": len(recipes),
    }


def recipe_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_recipe_draft_for_tools(context.db, family_id=context.family_id, payload=draft)
    return {"draft": normalized, "itemCount": len(normalized.get("ingredient_items", []) or [])}


def register_recipe_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="recipe.search",
        display_name="菜谱库",
        description="搜索当前家庭菜谱。",
        side_effect="read",
        handler=recipe_search,
        input_schema=LIMIT_INPUT,
        output_schema=COUNT_OUTPUT,
    )
    register_tool(
        registry,
        name="recipe.create_draft",
        display_name="菜谱确认表单",
        description="生成菜谱草稿，不写入业务表。",
        side_effect="draft",
        handler=recipe_create_draft,
        input_schema=draft_input_schema(RECIPE_TOOL_DRAFT_SCHEMA),
        output_schema=draft_output_schema(RECIPE_TOOL_DRAFT_SCHEMA),
    )
