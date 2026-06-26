from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import decimal_text, entity_media_map, first_entity_media, register_tool
from app.ai.tools.draft_validation import normalize_inventory_operation_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import (
    DAYS_INPUT,
    INVENTORY_OPERATION_DRAFT_SCHEMA,
    LIMIT_INPUT,
    draft_input_schema,
    draft_output_schema,
)
from app.ai.tools.catalog.inventory_unit_conversion import (
    build_unit_conversion_candidate,
    build_unit_mismatch_inventory_payload,
    unit_mismatch_from_tool_payload,
)
from app.core.utils import create_id
from app.models.domain import InventoryItem
from app.services.clock import today_for_family
from app.services.inventory_usage import remaining_quantity


INVENTORY_SUMMARY_OUTPUT = {
    "type": "object",
    "required": ["queryFocus", "availableCount", "expiringCount", "lowStockCount", "items"],
    "properties": {
        "queryFocus": {
            "type": "string",
            "enum": ["overview", "available", "expiring", "expired", "low_stock"],
        },
        "availableCount": {"type": "integer", "minimum": 0},
        "expiringCount": {"type": "integer", "minimum": 0},
        "lowStockCount": {"type": "integer", "minimum": 0},
        "items": {"type": "array", "items": {"type": "object"}},
    },
}

INVENTORY_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "ingredientId", "name", "quantity", "unit", "status", "displayStatus"],
    "properties": {
        "id": {"type": "string"},
        "ingredientId": {"type": "string"},
        "name": {"type": "string"},
        "image": {"type": ["object", "null"]},
        "quantity": {"type": "string"},
        "unit": {"type": "string"},
        "status": {"type": "string"},
        "displayStatus": {"type": "string", "enum": ["available", "expiring", "expired", "low_stock"]},
        "expiryDate": {"type": ["string", "null"]},
        "daysUntilExpiry": {"type": ["integer", "null"]},
        "lowStockThreshold": {"type": ["string", "null"]},
        "purchaseDate": {"type": "string"},
        "storageLocation": {"type": ["string", "null"]},
        "suggestedAction": {"type": "string", "enum": ["consume", "dispose", "restock"]},
    },
}


def inventory_items_output_schema(query_focus: str) -> dict[str, Any]:
    return {
        "type": "object",
        "required": ["queryFocus", "count", "items"],
        "properties": {
            "queryFocus": {"type": "string", "enum": [query_focus]},
            "count": {"type": "integer", "minimum": 0},
            "items": {"type": "array", "items": INVENTORY_ITEM_OUTPUT},
        },
    }


UNIT_CONVERSION_OPERATION_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["unitMismatch", "ratioToDefault"],
    "properties": {
        "unitMismatch": {"type": "object"},
        "ratioToDefault": {"type": "number", "exclusiveMinimum": 0},
        "sourceMessage": {"type": ["string", "null"], "maxLength": 300},
    },
}

UNIT_CONVERSION_OPERATION_OUTPUT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["draft", "itemCount", "unitConversionResolution"],
    "properties": {
        "draft": INVENTORY_OPERATION_DRAFT_SCHEMA,
        "itemCount": {"type": "integer", "minimum": 0},
        "unitConversionResolution": {"type": "object"},
    },
}


def inventory_record(
    item: InventoryItem,
    media_map: dict | None = None,
    *,
    today=None,
    suggested_action: str | None = None,
) -> dict[str, Any]:
    status = item.status.value if hasattr(item.status, "value") else str(item.status)
    remaining = remaining_quantity(item)
    is_low_stock = item.low_stock_threshold is not None and item.low_stock_threshold > 0 and remaining <= item.low_stock_threshold
    resolved_today = today or today_for_family(item.family_id)
    days_until_expiry = (item.expiry_date - resolved_today).days if item.expiry_date else None
    display_status = "expired" if days_until_expiry is not None and days_until_expiry < 0 else "expiring" if days_until_expiry is not None and days_until_expiry <= 7 else "low_stock" if is_low_stock else "available"
    record = {
        "id": item.id,
        "ingredientId": item.ingredient_id,
        "name": item.ingredient.name if item.ingredient else item.ingredient_id,
        "image": first_entity_media(media_map or {}, "ingredient", item.ingredient_id),
        "quantity": decimal_text(remaining),
        "unit": item.unit,
        "status": status,
        "displayStatus": display_status,
        "expiryDate": item.expiry_date.isoformat() if item.expiry_date else None,
        "daysUntilExpiry": days_until_expiry,
        "lowStockThreshold": decimal_text(item.low_stock_threshold) if item.low_stock_threshold is not None else None,
        "purchaseDate": item.purchase_date.isoformat(),
        "storageLocation": item.storage_location,
    }
    if suggested_action:
        record["suggestedAction"] = suggested_action
    return record


def read_inventory(context: ToolContext, *, limit: int = 80) -> list[InventoryItem]:
    return list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(InventoryItem.family_id == context.family_id)
            .order_by(InventoryItem.purchase_date.asc(), InventoryItem.id.asc())
            .limit(limit)
        )
    )


def _remaining_expression():
    return InventoryItem.quantity - InventoryItem.consumed_quantity - InventoryItem.disposed_quantity


def inventory_read_available_items(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 80)
    items = list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(InventoryItem.family_id == context.family_id, _remaining_expression() > 0)
            .order_by(
                InventoryItem.expiry_date.is_(None),
                InventoryItem.expiry_date.asc(),
                InventoryItem.purchase_date.asc(),
                InventoryItem.id.asc(),
            )
            .limit(limit)
        )
    )
    media_map = entity_media_map(context.db, family_id=context.family_id, entity_types={"ingredient"}, entity_ids=[item.ingredient_id for item in items])
    today = today_for_family(context.family_id)
    return {
        "queryFocus": "available",
        "items": [inventory_record(item, media_map, today=today) for item in items],
        "count": len(items),
    }


def inventory_read_expiring_items(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = today_for_family(context.family_id)
    days = int(payload.get("days") or 7)
    items = list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(
                InventoryItem.family_id == context.family_id,
                _remaining_expression() > 0,
                InventoryItem.expiry_date.is_not(None),
                InventoryItem.expiry_date >= today,
                InventoryItem.expiry_date <= today + timedelta(days=days),
            )
            .order_by(InventoryItem.expiry_date.asc(), InventoryItem.purchase_date.asc(), InventoryItem.id.asc())
        )
    )
    media_map = entity_media_map(context.db, family_id=context.family_id, entity_types={"ingredient"}, entity_ids=[item.ingredient_id for item in items])
    return {
        "queryFocus": "expiring",
        "items": [
            inventory_record(
                item,
                media_map,
                today=today,
                suggested_action="consume",
            )
            for item in items
        ],
        "count": len(items),
    }


def inventory_read_expired_items(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = today_for_family(context.family_id)
    limit = int(payload.get("limit") or 80)
    items = list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(
                InventoryItem.family_id == context.family_id,
                _remaining_expression() > 0,
                InventoryItem.expiry_date.is_not(None),
                InventoryItem.expiry_date < today,
            )
            .order_by(InventoryItem.expiry_date.asc(), InventoryItem.purchase_date.asc(), InventoryItem.id.asc())
            .limit(limit)
        )
    )
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"ingredient"},
        entity_ids=[item.ingredient_id for item in items],
    )
    return {
        "queryFocus": "expired",
        "items": [
            inventory_record(item, media_map, today=today, suggested_action="dispose")
            for item in items
        ],
        "count": len(items),
    }


def inventory_read_low_stock_items(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    limit = int(payload.get("limit") or 80)
    remaining = _remaining_expression()
    items = list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(
                InventoryItem.family_id == context.family_id,
                remaining > 0,
                InventoryItem.low_stock_threshold.is_not(None),
                InventoryItem.low_stock_threshold > 0,
                remaining <= InventoryItem.low_stock_threshold,
            )
            .order_by(remaining.asc(), InventoryItem.purchase_date.asc(), InventoryItem.id.asc())
            .limit(limit)
        )
    )
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"ingredient"},
        entity_ids=[item.ingredient_id for item in items],
    )
    today = today_for_family(context.family_id)
    return {
        "queryFocus": "low_stock",
        "items": [
            inventory_record(item, media_map, today=today, suggested_action="restock")
            for item in items
        ],
        "count": len(items),
    }


def inventory_read_summary(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = today_for_family(context.family_id)
    days = int(payload.get("days") or 7)
    remaining = _remaining_expression()
    items = list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(InventoryItem.family_id == context.family_id, remaining > 0)
            .order_by(
                InventoryItem.expiry_date.is_(None),
                InventoryItem.expiry_date.asc(),
                InventoryItem.purchase_date.asc(),
                InventoryItem.id.asc(),
            )
        )
    )
    expiring = [
        item
        for item in items
        if item.expiry_date is not None and today <= item.expiry_date <= today + timedelta(days=days)
    ]
    low_stock = [
        item
        for item in items
        if item.low_stock_threshold is not None
        and item.low_stock_threshold > 0
        and remaining_quantity(item) <= item.low_stock_threshold
    ]
    selected_items = expiring[:6] or low_stock[:6] or items[:6]
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"ingredient"},
        entity_ids=[item.ingredient_id for item in selected_items],
    )
    data = {
        "queryFocus": "overview",
        "availableCount": len(items),
        "expiringCount": len(expiring),
        "lowStockCount": len(low_stock),
        "items": [inventory_record(item, media_map, today=today) for item in selected_items],
    }
    return {
        **data,
        "card": {
            "id": create_id("ai_card"),
            "type": "inventory_summary",
            "title": "库存概览",
            "data": data,
        },
    }


def inventory_create_operation_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("draft") if isinstance(payload.get("draft"), dict) else {}
    normalized = normalize_inventory_operation_draft(context.db, family_id=context.family_id, payload=draft)
    return {"draft": normalized, "itemCount": len(normalized["operations"])}


def inventory_create_unit_conversion_operation_draft(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    unit_mismatch = unit_mismatch_from_tool_payload(payload)
    ratio_to_default = Decimal(str(payload.get("ratioToDefault")))
    if ratio_to_default <= 0:
        raise ValueError("换算比例必须大于 0")
    draft = build_unit_mismatch_inventory_payload(
        context.db,
        family_id=context.family_id,
        unit_mismatch=unit_mismatch,
        ratio_to_default=ratio_to_default,
    )
    normalized = normalize_inventory_operation_draft(context.db, family_id=context.family_id, payload=draft)
    candidate = build_unit_conversion_candidate(
        unit_mismatch=unit_mismatch,
        ratio_to_default=ratio_to_default,
        source_message=str(payload.get("sourceMessage") or ""),
    )
    return {
        "draft": normalized,
        "itemCount": len(normalized["operations"]),
        "unitConversionResolution": {"type": "unit_conversion", "payload": candidate},
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
        output_schema=inventory_items_output_schema("expiring"),
    )
    register_tool(
        registry,
        name="inventory.read_expired_items",
        display_name="过期食材",
        description="读取当前家庭已经过期但仍有剩余量的库存批次。",
        side_effect="read",
        handler=inventory_read_expired_items,
        input_schema=LIMIT_INPUT,
        output_schema=inventory_items_output_schema("expired"),
    )
    register_tool(
        registry,
        name="inventory.read_low_stock_items",
        display_name="低库存食材",
        description="读取当前家庭低于补货阈值的库存批次。",
        side_effect="read",
        handler=inventory_read_low_stock_items,
        input_schema=LIMIT_INPUT,
        output_schema=inventory_items_output_schema("low_stock"),
    )
    register_tool(
        registry,
        name="inventory.create_operation_draft",
        display_name="库存处理确认表单",
        description="生成入库、消耗或销毁库存的可编辑草稿，不直接写入库存。",
        side_effect="draft",
        handler=inventory_create_operation_draft,
        input_schema=draft_input_schema(INVENTORY_OPERATION_DRAFT_SCHEMA),
        output_schema=draft_output_schema(INVENTORY_OPERATION_DRAFT_SCHEMA),
    )
    register_tool(
        registry,
        name="inventory.create_unit_conversion_operation_draft",
        display_name="本次单位换算入库确认表单",
        description=(
            "当 human.request_input 的 resumeHint.questionType=unit_conversion 且用户已明确本次 1 个不支持单位等于多少主单位时，"
            "传入 resumeHint.unitMismatch 并按本次换算生成普通库存处理草稿；只用于本次入库，不保存食材副单位。"
        ),
        side_effect="draft",
        handler=inventory_create_unit_conversion_operation_draft,
        input_schema=UNIT_CONVERSION_OPERATION_INPUT,
        output_schema=UNIT_CONVERSION_OPERATION_OUTPUT,
    )
    register_tool(
        registry,
        name="inventory.read_available_items",
        display_name="可用库存",
        description="读取当前家庭可用库存。",
        side_effect="read",
        handler=inventory_read_available_items,
        input_schema=LIMIT_INPUT,
        output_schema=inventory_items_output_schema("available"),
    )
