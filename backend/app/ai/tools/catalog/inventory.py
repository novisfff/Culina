from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import decimal_text, register_tool
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import COUNT_OUTPUT, DAYS_INPUT, LIMIT_INPUT
from app.models.domain import InventoryItem


INVENTORY_SUMMARY_OUTPUT = {
    "type": "object",
    "required": ["availableCount", "expiringCount", "lowStockCount", "items"],
    "properties": {
        "availableCount": {"type": "integer", "minimum": 0},
        "expiringCount": {"type": "integer", "minimum": 0},
        "lowStockCount": {"type": "integer", "minimum": 0},
        "items": {"type": "array", "items": {"type": "object"}},
    },
}


def remaining_quantity(item: InventoryItem) -> Decimal:
    return max(Decimal(item.quantity or 0) - Decimal(item.consumed_quantity or 0), Decimal("0"))


def inventory_record(item: InventoryItem) -> dict[str, Any]:
    status = item.status.value if hasattr(item.status, "value") else str(item.status)
    return {
        "id": item.id,
        "ingredientId": item.ingredient_id,
        "label": item.ingredient.name if item.ingredient else item.ingredient_id,
        "quantity": decimal_text(remaining_quantity(item)),
        "unit": item.unit,
        "status": status,
        "expiryDate": item.expiry_date.isoformat() if item.expiry_date else None,
        "lowStockThreshold": decimal_text(item.low_stock_threshold) if item.low_stock_threshold is not None else None,
    }


def read_inventory(context: ToolContext, *, limit: int = 80) -> list[InventoryItem]:
    return list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(InventoryItem.family_id == context.family_id)
            .limit(limit)
        )
    )


def inventory_read_available_items(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 80)
    items = [item for item in read_inventory(context, limit=limit) if remaining_quantity(item) > 0]
    return {"items": [inventory_record(item) for item in items], "count": len(items)}


def inventory_read_expiring_items(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = date.today()
    days = int(payload.get("days") or 7)
    items = [
        item
        for item in read_inventory(context)
        if remaining_quantity(item) > 0 and item.expiry_date is not None and (item.expiry_date - today).days <= days
    ]
    items.sort(key=lambda item: item.expiry_date or today)
    return {"items": [inventory_record(item) for item in items], "count": len(items)}


def inventory_read_summary(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = date.today()
    items = [item for item in read_inventory(context) if remaining_quantity(item) > 0]
    expiring = [item for item in items if item.expiry_date is not None and (item.expiry_date - today).days <= int(payload.get("days") or 7)]
    low_stock = [
        item
        for item in items
        if item.low_stock_threshold is not None and item.low_stock_threshold > 0 and remaining_quantity(item) <= item.low_stock_threshold
    ]
    return {
        "availableCount": len(items),
        "expiringCount": len(expiring),
        "lowStockCount": len(low_stock),
        "items": [inventory_record(item) for item in (expiring[:6] or low_stock[:6] or items[:6])],
    }


def register_inventory_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="inventory.read_summary",
        display_name="库存概览",
        description="读取当前家庭库存摘要。",
        side_effect="read",
        handler=inventory_read_summary,
        input_schema=DAYS_INPUT,
        output_schema=INVENTORY_SUMMARY_OUTPUT,
    )
    register_tool(
        registry,
        name="inventory.read_expiring_items",
        display_name="临期食材",
        description="读取当前家庭临期食材。",
        side_effect="read",
        handler=inventory_read_expiring_items,
        input_schema=DAYS_INPUT,
        output_schema=COUNT_OUTPUT,
    )
    register_tool(
        registry,
        name="inventory.read_available_items",
        display_name="可用库存",
        description="读取当前家庭可用库存。",
        side_effect="read",
        handler=inventory_read_available_items,
        input_schema=LIMIT_INPUT,
        output_schema=COUNT_OUTPUT,
    )
