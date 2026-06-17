from __future__ import annotations

from typing import Any

from sqlalchemy import or_, select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.draft_validation import normalize_shopping_list_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import READ_BY_ID_INPUT, SHOPPING_LIST_DRAFT_SCHEMA, draft_input_schema, draft_output_schema
from app.models.domain import ShoppingListItem
from app.services.serializers import serialize_shopping_item


SHOPPING_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "title", "quantity", "unit", "done"],
    "properties": {
        "id": {"type": "string"},
        "title": {"type": "string"},
        "quantity": {"type": "number"},
        "unit": {"type": "string"},
        "reason": {"type": ["string", "null"]},
        "done": {"type": "boolean"},
        "updatedAt": {"type": ["string", "null"]},
    },
}

SHOPPING_LIST_OUTPUT = {
    "type": "object",
    "required": ["count", "items"],
    "properties": {
        "count": {"type": "integer", "minimum": 0},
        "hasMore": {"type": "boolean"},
        "items": {"type": "array", "items": SHOPPING_ITEM_OUTPUT},
    },
}

SHOPPING_ITEM_READ_OUTPUT = {
    "type": "object",
    "required": ["item"],
    "properties": {"item": SHOPPING_ITEM_OUTPUT},
}


def shopping_read_pending(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 50)
    offset = int(payload.get("offset") or 0)
    query = str(payload.get("query") or "").strip()
    ids = [str(item).strip() for item in payload.get("ids") or [] if str(item).strip()]
    exact = bool(payload.get("exact"))
    statement = select(ShoppingListItem).where(
        ShoppingListItem.family_id == context.family_id,
        ShoppingListItem.done.is_(False),
    )
    if ids:
        statement = statement.where(ShoppingListItem.id.in_(ids))
    if query:
        if exact:
            statement = statement.where(or_(ShoppingListItem.title == query, ShoppingListItem.reason == query))
        else:
            pattern = f"%{query}%"
            statement = statement.where(or_(ShoppingListItem.title.ilike(pattern), ShoppingListItem.reason.ilike(pattern)))
    items = list(
        context.db.scalars(
            statement.order_by(ShoppingListItem.updated_at.desc(), ShoppingListItem.id).offset(offset).limit(limit + 1)
        )
    )
    has_more = len(items) > limit
    items = items[:limit]
    return {
        "items": [
            {
                "id": item.id,
                "title": item.title,
                "quantity": float(item.quantity),
                "unit": item.unit,
                "reason": item.reason,
                "done": item.done,
                "updatedAt": item.updated_at.isoformat() if item.updated_at is not None else None,
            }
            for item in items
        ],
        "count": len(items),
        "hasMore": has_more,
    }


def shopping_read_by_id(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    item = context.db.scalar(
        select(ShoppingListItem).where(
            ShoppingListItem.family_id == context.family_id,
            ShoppingListItem.id == str(payload["id"]),
        )
    )
    if item is None:
        raise ValueError("购物项不存在或不属于当前家庭")
    return {"item": serialize_shopping_item(item)}


def shopping_list_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_shopping_list_draft(
        context.db,
        family_id=context.family_id,
        conversation_id=context.conversation_id,
        payload=draft,
    )
    item_count = len(normalized.get("operations") or normalized.get("items") or [])
    return {"draft": normalized, "itemCount": item_count}


def register_shopping_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="shopping.read_pending",
        display_name="待采购清单",
        description="读取待采购购物项。",
        side_effect="read",
        handler=shopping_read_pending,
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {"type": "string", "maxLength": 100},
                "ids": {"type": "array", "maxItems": 50, "items": {"type": "string", "minLength": 1}},
                "exact": {"type": "boolean"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0, "maximum": 1000},
            },
        },
        output_schema=SHOPPING_LIST_OUTPUT,
    )
    register_tool(
        registry,
        name="shopping.read_by_id",
        display_name="购物项详情",
        description="读取当前家庭指定购物项的完整内容。",
        side_effect="read",
        handler=shopping_read_by_id,
        input_schema=READ_BY_ID_INPUT,
        output_schema=SHOPPING_ITEM_READ_OUTPUT,
    )
    register_tool(
        registry,
        name="shopping.create_draft",
        display_name="购物清单确认表单",
        description="生成购物清单草稿，不写入业务表。",
        side_effect="draft",
        handler=shopping_list_create_draft,
        input_schema=draft_input_schema(SHOPPING_LIST_DRAFT_SCHEMA),
        output_schema=draft_output_schema(SHOPPING_LIST_DRAFT_SCHEMA),
    )
