from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import decimal_text, register_tool
from app.ai.tools.draft_validation import normalize_ingredient_profile_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import INGREDIENT_PROFILE_DRAFT_SCHEMA, READ_BY_ID_INPUT, SEARCH_INPUT, draft_input_schema, draft_output_schema
from app.models.domain import Ingredient
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.ingredient_units import get_supported_units, serialize_unit_conversions
from app.services.search.hybrid import hybrid_search
from app.services.serializers import serialize_ingredient


INGREDIENT_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "name", "category", "defaultUnit", "quantityTrackingMode", "supportedUnits"],
    "properties": {
        "id": {"type": "string"},
        "name": {"type": "string"},
        "category": {"type": "string"},
        "defaultUnit": {"type": "string"},
        "quantityTrackingMode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
        "supportedUnits": {"type": "array", "items": {"type": "string"}},
        "unitConversions": {"type": "array", "items": {"type": "object"}},
        "defaultStorage": {"type": ["string", "null"]},
        "defaultExpiryMode": {"type": ["string", "null"]},
        "defaultExpiryDays": {"type": ["integer", "null"]},
        "defaultLowStockThreshold": {"type": ["string", "null"]},
        "notes": {"type": ["string", "null"]},
        "updatedAt": {"type": ["string", "null"]},
    },
}

INGREDIENT_SEARCH_OUTPUT = {
    "type": "object",
    "required": ["count", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "hasMore": {"type": "boolean"},
        "items": {"type": "array", "items": INGREDIENT_ITEM_OUTPUT},
    },
}

INGREDIENT_READ_OUTPUT = {
    "type": "object",
    "required": ["item"],
    "properties": {"item": INGREDIENT_ITEM_OUTPUT},
}


def ingredient_search(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 50)
    offset = int(payload.get("offset") or 0)
    query = str(payload.get("query") or "").strip()
    ids = [str(item).strip() for item in payload.get("ids") or [] if str(item).strip()]
    exact = bool(payload.get("exact"))
    category = str(payload.get("category") or "").strip()
    if query and not exact and not ids:
        search_result = hybrid_search(
            context.db,
            family_id=context.family_id,
            query=query,
            scopes=["ingredient"],
            limit=max(limit + offset + 1, 80),
            offset=0,
        )
        search_ids = [item.entity_id for item in search_result.items if item.entity_type == "ingredient"]
        if not search_ids:
            ingredients: list[Ingredient] = []
        else:
            statement = select(Ingredient).where(Ingredient.family_id == context.family_id, Ingredient.id.in_(search_ids))
            if category:
                statement = statement.where(Ingredient.category == category)
            ingredients_by_id = {item.id: item for item in context.db.scalars(statement)}
            ingredients = [ingredients_by_id[item_id] for item_id in search_ids if item_id in ingredients_by_id]
            ingredients = ingredients[offset : offset + limit + 1]
        return _ingredient_search_response(ingredients, limit=limit)

    statement = select(Ingredient).where(Ingredient.family_id == context.family_id)
    if ids:
        statement = statement.where(Ingredient.id.in_(ids))
    if category:
        statement = statement.where(Ingredient.category == category)
    if query:
        if exact:
            statement = statement.where(Ingredient.name == query)
    statement = statement.order_by(Ingredient.updated_at.desc(), Ingredient.id).offset(offset).limit(limit + 1)
    ingredients = list(context.db.scalars(statement))
    return _ingredient_search_response(ingredients, limit=limit)


def _ingredient_search_response(ingredients: list[Ingredient], *, limit: int) -> dict[str, Any]:
    has_more = len(ingredients) > limit
    ingredients = ingredients[:limit]
    return {
        "items": [
            {
                "id": item.id,
                "name": item.name,
                "category": item.category,
                "defaultUnit": item.default_unit,
                "quantityTrackingMode": item.quantity_tracking_mode.value if hasattr(item.quantity_tracking_mode, "value") else str(item.quantity_tracking_mode),
                "supportedUnits": get_supported_units(item.default_unit, item.unit_conversions),
                "unitConversions": serialize_unit_conversions(item.default_unit, item.unit_conversions),
                "defaultStorage": item.default_storage,
                "defaultExpiryMode": item.default_expiry_mode.value if hasattr(item.default_expiry_mode, "value") else str(item.default_expiry_mode),
                "defaultExpiryDays": item.default_expiry_days,
                "defaultLowStockThreshold": decimal_text(item.default_low_stock_threshold) if item.default_low_stock_threshold is not None else None,
                "notes": item.notes,
                "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
            }
            for item in ingredients
        ],
        "count": len(ingredients),
        "hasMore": has_more,
    }


def ingredient_read_by_id(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    ingredient = context.db.scalar(
        select(Ingredient).where(
            Ingredient.family_id == context.family_id,
            Ingredient.id == str(payload["id"]),
        )
    )
    if ingredient is None:
        raise ValueError("食材不存在或不属于当前家庭")
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="ingredient",
            entity_ids=[ingredient.id],
        )
    )
    item = serialize_ingredient(ingredient, media_map)
    return {
        "item": {
            **item,
            "defaultUnit": ingredient.default_unit,
            "quantityTrackingMode": ingredient.quantity_tracking_mode.value if hasattr(ingredient.quantity_tracking_mode, "value") else str(ingredient.quantity_tracking_mode),
            "supportedUnits": get_supported_units(ingredient.default_unit, ingredient.unit_conversions),
            "unitConversions": serialize_unit_conversions(ingredient.default_unit, ingredient.unit_conversions),
        }
    }


def ingredient_profile_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_ingredient_profile_draft(context.db, family_id=context.family_id, payload=draft)
    return {"draft": normalized, "itemCount": 1}


def register_ingredient_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="ingredient.search",
        display_name="食材资料",
        description="搜索当前家庭食材资料。",
        side_effect="read",
        handler=ingredient_search,
        input_schema=SEARCH_INPUT,
        output_schema=INGREDIENT_SEARCH_OUTPUT,
    )
    register_tool(
        registry,
        name="ingredient.read_by_id",
        display_name="食材详情",
        description="读取当前家庭指定食材的完整资料。",
        side_effect="read",
        handler=ingredient_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema=INGREDIENT_READ_OUTPUT,
    )
    register_tool(
        registry,
        name="ingredient_profile.create_draft",
        display_name="食材档案确认表单",
        description="生成食材档案草稿，不写入业务表。",
        side_effect="draft",
        handler=ingredient_profile_create_draft,
        input_schema=draft_input_schema(INGREDIENT_PROFILE_DRAFT_SCHEMA),
        output_schema=draft_output_schema(INGREDIENT_PROFILE_DRAFT_SCHEMA),
    )
