from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import entity_media_map, first_entity_media, register_tool
from app.ai.tools.draft_validation import normalize_food_profile_draft_for_tools
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import FOOD_PROFILE_DRAFT_SCHEMA, READ_BY_ID_INPUT, SEARCH_INPUT, draft_input_schema, draft_output_schema
from app.models.domain import Food
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.serializers import serialize_food


FOOD_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "name", "type", "category"],
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "image": {"type": ["object", "null"]},
        "type": {"type": "string"},
        "category": {"type": "string"},
        "flavorTags": {"type": "array", "items": {"type": "string"}},
        "sceneTags": {"type": "array", "items": {"type": "string"}},
        "suitableMealTypes": {"type": "array", "items": {"type": "string"}},
        "scene": {"type": ["string", "null"]},
        "recipeId": {"type": ["string", "null"]},
        "routineNote": {"type": ["string", "null"]},
        "updatedAt": {"type": ["string", "null"]},
    },
}

FOOD_SEARCH_OUTPUT = {
    "type": "object",
    "required": ["count", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "hasMore": {"type": "boolean"},
        "items": {"type": "array", "items": FOOD_ITEM_OUTPUT},
    },
}

FOOD_READ_OUTPUT = {
    "type": "object",
    "required": ["item"],
    "properties": {"item": FOOD_ITEM_OUTPUT},
}


def food_search(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 24)
    offset = int(payload.get("offset") or 0)
    query = str(payload.get("query") or "").strip()
    ids = [str(item).strip() for item in payload.get("ids") or [] if str(item).strip()]
    exact = bool(payload.get("exact"))
    category = str(payload.get("category") or "").strip()
    statement = select(Food).where(Food.family_id == context.family_id)
    if ids:
        statement = statement.where(Food.id.in_(ids))
    if category:
        statement = statement.where(Food.category == category)
    if query:
        if exact:
            statement = statement.where(Food.name == query)
        else:
            pattern = f"%{query}%"
            statement = statement.where(or_(Food.name.ilike(pattern), Food.category.ilike(pattern), Food.scene.ilike(pattern)))
    foods = list(context.db.scalars(statement.order_by(Food.updated_at.desc(), Food.id).offset(offset).limit(limit + 1)))
    has_more = len(foods) > limit
    foods = foods[:limit]
    media_map = entity_media_map(context.db, family_id=context.family_id, entity_types={"food"}, entity_ids=[item.id for item in foods])
    return {
        "items": [
            {
                "id": item.id,
                "name": item.name,
                "image": first_entity_media(media_map, "food", item.id),
                "type": item.type.value if hasattr(item.type, "value") else str(item.type),
                "category": item.category,
                "flavorTags": item.flavor_tags or [],
                "sceneTags": item.scene_tags or [],
                "suitableMealTypes": item.suitable_meal_types or [],
                "scene": item.scene,
                "recipeId": item.recipe_id,
                "routineNote": item.routine_note,
                "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
            }
            for item in foods
        ],
        "count": len(foods),
        "hasMore": has_more,
    }


def food_read_by_id(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    food = context.db.scalar(select(Food).where(Food.family_id == context.family_id, Food.id == str(payload["id"])))
    if food is None:
        raise ValueError("食物不存在或不属于当前家庭")
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="food",
            entity_ids=[food.id],
        )
    )
    return {"item": serialize_food(food, media_map)}


def food_profile_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_food_profile_draft_for_tools(context.db, family_id=context.family_id, payload=draft)
    return {"draft": normalized, "itemCount": 1}


def register_food_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="food.search",
        display_name="食物资料",
        description="搜索当前家庭食物资料。",
        side_effect="read",
        handler=food_search,
        input_schema=SEARCH_INPUT,
        output_schema=FOOD_SEARCH_OUTPUT,
    )
    register_tool(
        registry,
        name="food.read_by_id",
        display_name="食物详情",
        description="读取当前家庭指定食物的完整资料。",
        side_effect="read",
        handler=food_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema=FOOD_READ_OUTPUT,
    )
    register_tool(
        registry,
        name="food_profile.create_draft",
        display_name="食物资料确认表单",
        description=(
            "生成食物资料草稿，不写入业务表。创建食物资料时必须提供 name、type、category；"
            "用户原话可推断时必须填入，例如“盒装牛奶，类型是即食，适合早餐”应填 name=盒装牛奶、type=readyMade、category=饮品、suitable_meal_types=[breakfast]。"
            "确实缺少名称或类型时不要调用本工具，改用 intent.request_clarification。"
        ),
        side_effect="draft",
        handler=food_profile_create_draft,
        input_schema=draft_input_schema(FOOD_PROFILE_DRAFT_SCHEMA),
        output_schema=draft_output_schema(FOOD_PROFILE_DRAFT_SCHEMA),
    )
