from __future__ import annotations

from datetime import timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext, ToolDefinition
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
from app.services.inventory_overview import build_inventory_overview
from app.services.inventory_usage import remaining_quantity, tracks_quantity


INVENTORY_SUMMARY_OUTPUT = {
    "type": "object",
    "required": ["queryFocus", "availableCount", "expiringCount", "lowStockCount", "foodStockCount", "items", "card"],
    "additionalProperties": False,
    "properties": {
        "queryFocus": {"type": "string", "enum": ["overview"]},
        "availableCount": {"type": "integer", "minimum": 0},
        "expiringCount": {"type": "integer", "minimum": 0},
        "lowStockCount": {"type": "integer", "minimum": 0},
        "foodStockCount": {"type": "integer", "minimum": 0},
        "items": {"type": "array", "items": {"type": "object"}},
        "card": {
            "type": "object",
            "required": ["id", "type", "title", "data"],
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string", "enum": ["inventory_summary"]},
                "title": {"type": "string"},
                "data": {"type": "object"},
            },
        },
    },
}

INVENTORY_ITEM_OUTPUT = {
    "type": "object",
    "required": ["id", "sourceType", "ingredientId", "foodId", "inventoryItemId", "name", "quantity", "unit", "status", "displayStatus", "quantityTrackingMode"],
    "properties": {
        "id": {"type": "string"},
        "sourceType": {"type": "string", "enum": ["ingredient", "food"]},
        "foodId": {"type": ["string", "null"]},
        "ingredientId": {"type": ["string", "null"]},
        "inventoryItemId": {"type": ["string", "null"]},
        "name": {"type": "string"},
        "image": {"type": ["object", "null"]},
        "quantity": {"type": "string"},
        "unit": {"type": "string"},
        "quantityTrackingMode": {"type": "string", "enum": ["track_quantity", "not_track_quantity"]},
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
    quantity_tracking_mode = (
        item.ingredient.quantity_tracking_mode.value
        if item.ingredient and hasattr(item.ingredient.quantity_tracking_mode, "value")
        else str(item.ingredient.quantity_tracking_mode)
        if item.ingredient
        else "track_quantity"
    )
    is_tracked = item.ingredient is None or tracks_quantity(item.ingredient)
    is_low_stock = is_tracked and item.low_stock_threshold is not None and item.low_stock_threshold > 0 and remaining <= item.low_stock_threshold
    resolved_today = today or today_for_family(item.family_id)
    days_until_expiry = (item.expiry_date - resolved_today).days if item.expiry_date else None
    display_status = "expired" if days_until_expiry is not None and days_until_expiry < 0 else "expiring" if days_until_expiry is not None and days_until_expiry <= 7 else "low_stock" if is_low_stock else "available"
    record = {
        "id": item.id,
        "sourceType": "ingredient",
        "foodId": None,
        "ingredientId": item.ingredient_id,
        "inventoryItemId": item.id,
        "name": item.ingredient.name if item.ingredient else item.ingredient_id,
        "image": first_entity_media(media_map or {}, "ingredient", item.ingredient_id),
        "quantity": decimal_text(remaining) if is_tracked else "已有",
        "unit": item.unit,
        "quantityTrackingMode": quantity_tracking_mode,
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


def overview_inventory_record(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "sourceType": row["source_type"],
        "foodId": row["source_id"] if row["source_type"] == "food" else None,
        "ingredientId": row["source_id"] if row["source_type"] == "ingredient" else None,
        "inventoryItemId": row.get("inventory_item_id"),
        "name": row["title"],
        "image": row.get("image"),
        "quantity": row["quantity_label"],
        "unit": row["unit"],
        "quantityTrackingMode": row["quantity_tracking_mode"],
        "status": row.get("status") or "food_stock",
        "displayStatus": "expired" if row["tone"] == "danger" else "expiring" if row["tone"] == "warning" else "available",
        "expiryDate": row["expiry_date"].isoformat() if hasattr(row.get("expiry_date"), "isoformat") else row.get("expiry_date"),
        "daysUntilExpiry": row.get("days_until_expiry"),
        "lowStockThreshold": None,
        "purchaseDate": "",
        "storageLocation": row["storage_location"],
    }


def _inventory_record_key(record: dict[str, Any]) -> tuple[str, str]:
    return (
        record["sourceType"],
        str(record.get("inventoryItemId") or record.get("foodId") or record.get("ingredientId") or record["id"]),
    )


def _overview_row_key(row: dict[str, Any]) -> tuple[str, str]:
    return (row["source_type"], str(row.get("inventory_item_id") or row["source_id"]))


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
    expiring_items = list(
        context.db.scalars(
            select(InventoryItem)
            .options(selectinload(InventoryItem.ingredient))
            .where(
                InventoryItem.family_id == context.family_id,
                remaining > 0,
                InventoryItem.expiry_date.is_not(None),
                InventoryItem.expiry_date >= today,
                InventoryItem.expiry_date <= today + timedelta(days=days),
            )
            .order_by(InventoryItem.expiry_date.asc(), InventoryItem.purchase_date.asc(), InventoryItem.id.asc())
            .limit(6)
        )
    )
    overview = build_inventory_overview(
        context.db,
        family_id=context.family_id,
        scope="all",
        query="",
        today=today,
    )
    rows = overview["items"]
    expiring = [
        row
        for row in rows
        if row.get("days_until_expiry") is not None and 0 <= row["days_until_expiry"] <= days
    ]
    low_stock_items = list(
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
            .limit(6)
        )
    )
    if expiring_items:
        media_map = entity_media_map(
            context.db,
            family_id=context.family_id,
            entity_types={"ingredient"},
            entity_ids=[item.ingredient_id for item in expiring_items],
        )
        records = [inventory_record(item, media_map, today=today) for item in expiring_items]
    elif low_stock_items:
        media_map = entity_media_map(
            context.db,
            family_id=context.family_id,
            entity_types={"ingredient"},
            entity_ids=[item.ingredient_id for item in low_stock_items],
        )
        records = [inventory_record(item, media_map, today=today) for item in low_stock_items]
    else:
        records = []
    seen = {_inventory_record_key(record) for record in records}
    for row in rows:
        if len(records) >= 6:
            break
        key = _overview_row_key(row)
        if key in seen:
            continue
        records.append(overview_inventory_record(row))
        seen.add(key)
    data = {
        "queryFocus": "overview",
        "availableCount": overview["summary"]["total_count"],
        "expiringCount": len(expiring),
        "lowStockCount": len(low_stock_items),
        "foodStockCount": overview["summary"]["food_count"],
        "items": records,
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
    registry.register(
        ToolDefinition(
            name="inventory.read_summary",
            display_name="库存概览",
            description="读取当前家庭库存摘要。",
            input_schema=DAYS_INPUT,
            output_schema=INVENTORY_SUMMARY_OUTPUT,
            permission="family:read",
            side_effect="read",
            handler=inventory_read_summary,
            terminal_output=True,
            followup_hint="库存概览卡可作为库存查询的终态输出。",
            output_types=["inventory_summary"],
        )
    )
    registry.register(
        ToolDefinition(
            name="inventory.read_expiring_items",
            display_name="临期食材",
            description="读取当前家庭临期食材。",
            input_schema=DAYS_INPUT,
            output_schema=inventory_items_output_schema("expiring"),
            permission="family:read",
            side_effect="read",
            handler=inventory_read_expiring_items,
            requires_followup=True,
            followup_hint="临期列表读取后必须总结重点、请求补充信息，或生成库存处理草稿。",
        )
    )
    registry.register(
        ToolDefinition(
            name="inventory.read_expired_items",
            display_name="过期食材",
            description="读取当前家庭已经过期但仍有剩余量的库存批次。",
            input_schema=LIMIT_INPUT,
            output_schema=inventory_items_output_schema("expired"),
            permission="family:read",
            side_effect="read",
            handler=inventory_read_expired_items,
            requires_followup=True,
            followup_hint="过期列表读取后必须总结风险、请求补充信息，或生成库存处理草稿。",
        )
    )
    registry.register(
        ToolDefinition(
            name="inventory.read_low_stock_items",
            display_name="低库存食材",
            description="读取当前家庭低于补货阈值的库存批次。",
            input_schema=LIMIT_INPUT,
            output_schema=inventory_items_output_schema("low_stock"),
            permission="family:read",
            side_effect="read",
            handler=inventory_read_low_stock_items,
            requires_followup=True,
            followup_hint="低库存列表读取后必须总结补货重点、请求补充信息，或生成库存处理草稿。",
        )
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
        draft_types=["inventory_operation"],
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
        draft_types=["inventory_operation"],
    )
    registry.register(
        ToolDefinition(
            name="inventory.read_available_items",
            display_name="可用库存",
            description="读取当前家庭可用库存。",
            input_schema=LIMIT_INPUT,
            output_schema=inventory_items_output_schema("available"),
            permission="family:read",
            side_effect="read",
            handler=inventory_read_available_items,
            requires_followup=True,
            followup_hint="可用库存读取后必须总结可用食材、请求补充信息，或生成库存处理草稿。",
        )
    )
