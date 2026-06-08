from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, DRAFT_INPUT, DRAFT_OUTPUT, LIMIT_INPUT
from app.models.domain import Food


def food_search(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 24)
    foods = list(context.db.scalars(select(Food).where(Food.family_id == context.family_id).limit(limit)))
    return {
        "items": [
            {
                "id": item.id,
                "name": item.name,
                "type": item.type.value if hasattr(item.type, "value") else str(item.type),
                "category": item.category,
                "flavorTags": item.flavor_tags or [],
                "sceneTags": item.scene_tags or [],
                "suitableMealTypes": item.suitable_meal_types or [],
                "scene": item.scene,
                "recipeId": item.recipe_id,
                "routineNote": item.routine_note,
            }
            for item in foods
        ],
        "count": len(foods),
    }


def food_profile_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    return {"draft": draft, "itemCount": len(draft.get("items", []) or [])}


def register_food_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="food.search",
        description="搜索当前家庭食物资料。",
        side_effect="read",
        handler=food_search,
        input_schema=LIMIT_INPUT,
        output_schema=COUNT_OUTPUT,
    )
    register_tool(
        registry,
        name="food_profile.create_draft",
        description="生成食物资料草稿，不写入业务表。",
        side_effect="draft",
        handler=food_profile_create_draft,
        input_schema=DRAFT_INPUT,
        output_schema=DRAFT_OUTPUT,
    )
