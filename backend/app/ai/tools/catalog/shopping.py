from __future__ import annotations

from typing import Any

from sqlalchemy import select

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, LIMIT_INPUT, SHOPPING_LIST_DRAFT_SCHEMA, draft_input_schema, draft_output_schema
from app.models.domain import ShoppingListItem


def shopping_read_pending(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 50)
    items = list(
        context.db.scalars(
            select(ShoppingListItem)
            .where(ShoppingListItem.family_id == context.family_id, ShoppingListItem.done.is_(False))
            .limit(limit)
        )
    )
    return {
        "items": [
            {"id": item.id, "title": item.title, "quantity": float(item.quantity), "unit": item.unit, "reason": item.reason}
            for item in items
        ],
        "count": len(items),
    }


def shopping_list_create_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    items = draft.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("购物清单草稿不能为空")
    return {"draft": draft, "itemCount": len(items)}


def register_shopping_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="shopping.read_pending",
        description="读取待采购购物项。",
        side_effect="read",
        handler=shopping_read_pending,
        input_schema=LIMIT_INPUT,
        output_schema=COUNT_OUTPUT,
    )
    for name in ["shopping.create_draft", "shopping_list.create_draft"]:
        register_tool(
            registry,
            name=name,
            description="生成购物清单草稿，不写入业务表。",
            side_effect="draft",
            handler=shopping_list_create_draft,
            input_schema=draft_input_schema(SHOPPING_LIST_DRAFT_SCHEMA),
            output_schema=draft_output_schema(SHOPPING_LIST_DRAFT_SCHEMA),
        )
