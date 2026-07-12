from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.ai.tools.base import ToolContext, ToolDefinition
from app.ai.tools.catalog.common import decimal_text, entity_media_map, first_entity_media, register_tool
from app.ai.tools.draft_validation import normalize_inventory_operation_draft
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.schemas import (
    DAYS_INPUT,
    DAYS_LIMIT_INPUT,
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
from app.core.enums import IngredientQuantityTrackingMode, InventoryAvailabilityLevel
from app.models.domain import Ingredient, IngredientInventoryState, InventoryItem
from app.services.clock import today_for_family
from app.services.ingredient_inventory_state import state_is_physically_present, state_is_usable
from app.services.inventory_overview import build_inventory_overview
from app.services.inventory_usage import remaining_quantity, tracks_quantity


INVENTORY_SUMMARY_OUTPUT = {
    "type": "object",
    "required": ["queryFocus", "availableCount", "expiringCount", "expiredCount", "lowStockCount", "foodStockCount", "items", "card"],
    "additionalProperties": False,
    "properties": {
        "queryFocus": {"type": "string", "enum": ["overview"]},
        "availableCount": {"type": "integer", "minimum": 0},
        "expiringCount": {"type": "integer", "minimum": 0},
        "expiredCount": {"type": "integer", "minimum": 0},
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
        "required": ["queryFocus", "count", "items", "card"],
        "properties": {
            "queryFocus": {"type": "string", "enum": [query_focus]},
            "count": {"type": "integer", "minimum": 0},
            "items": {"type": "array", "items": INVENTORY_ITEM_OUTPUT},
            "card": INVENTORY_SUMMARY_OUTPUT["properties"]["card"],
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



def inventory_state_record(
    state: IngredientInventoryState,
    ingredient: Ingredient,
    media_map: dict | None = None,
    *,
    today=None,
    suggested_action: str | None = None,
) -> dict[str, Any]:
    status = state.inventory_status.value if hasattr(state.inventory_status, "value") else str(state.inventory_status)
    resolved_today = today or today_for_family(state.family_id)
    days_until_expiry = (state.expiry_date - resolved_today).days if state.expiry_date else None
    if days_until_expiry is not None and days_until_expiry < 0:
        display_status = "expired"
    elif days_until_expiry is not None and days_until_expiry <= 7:
        display_status = "expiring"
    elif state.availability_level is InventoryAvailabilityLevel.LOW:
        display_status = "low_stock"
    else:
        display_status = "available"
    quantity_label = {
        InventoryAvailabilityLevel.LOW: "偏低",
        InventoryAvailabilityLevel.SUFFICIENT: "充足",
        InventoryAvailabilityLevel.ABSENT: "没有",
    }.get(state.availability_level, "已有")
    record = {
        "id": f"ingredient-state:{state.id}",
        "sourceType": "ingredient",
        "foodId": None,
        "ingredientId": ingredient.id,
        "inventoryItemId": None,
        "name": ingredient.name,
        "image": first_entity_media(media_map or {}, "ingredient", ingredient.id),
        "quantity": quantity_label,
        "unit": ingredient.default_unit,
        "quantityTrackingMode": "not_track_quantity",
        "status": status,
        "displayStatus": display_status,
        "expiryDate": state.expiry_date.isoformat() if state.expiry_date else None,
        "daysUntilExpiry": days_until_expiry,
        "lowStockThreshold": None,
        "purchaseDate": state.purchase_date.isoformat() if state.purchase_date else "",
        "storageLocation": state.storage_location,
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


def _with_suggested_action(record: dict[str, Any], suggested_action: str | None) -> dict[str, Any]:
    if suggested_action is None:
        return record
    return {**record, "suggestedAction": suggested_action}


def _inventory_summary_card(data: dict[str, Any], *, title: str) -> dict[str, Any]:
    focus = str(data["queryFocus"])
    items = list(data.get("items") or [])
    count = int(data.get("count") or len(items))
    card_data = {
        "queryFocus": focus,
        "availableCount": (
            int(data["availableCount"])
            if focus == "overview"
            else count if focus == "available" else 0
        ),
        "expiringCount": (
            int(data["expiringCount"])
            if focus == "overview"
            else count if focus == "expiring" else 0
        ),
        "expiredCount": (
            int(data["expiredCount"])
            if focus == "overview"
            else count if focus == "expired" else 0
        ),
        "lowStockCount": (
            int(data["lowStockCount"])
            if focus == "overview"
            else count if focus == "low_stock" else 0
        ),
        "foodStockCount": (
            int(data["foodStockCount"])
            if focus == "overview"
            else sum(item.get("sourceType") == "food" for item in items)
        ),
        "items": items,
    }
    return {
        "id": create_id("ai_card"),
        "type": "inventory_summary",
        "title": title,
        "data": card_data,
    }


def _with_inventory_card(data: dict[str, Any], *, title: str) -> dict[str, Any]:
    return {**data, "card": _inventory_summary_card(data, title=title)}


def _contextual_record_sort_key(record: dict[str, Any]) -> tuple[bool, str, str, str]:
    expiry_date = record.get("expiryDate")
    purchase_date = record.get("purchaseDate") or "9999-12-31"
    return (expiry_date is None, expiry_date or "9999-12-31", purchase_date, str(record["id"]))


def _food_contextual_records(
    context: ToolContext,
    *,
    today: date,
    limit: int,
    predicate,
    suggested_action: str | None = None,
) -> list[dict[str, Any]]:
    overview = build_inventory_overview(
        context.db,
        family_id=context.family_id,
        scope="food",
        query="",
        today=today,
    )
    rows = [row for row in overview["items"] if predicate(row)]
    rows.sort(
        key=lambda row: (
            row.get("expiry_date") is None,
            row.get("expiry_date") or date.max,
            str(row["id"]),
        )
    )
    return [
        _with_suggested_action(overview_inventory_record(row), suggested_action)
        for row in rows[:limit]
    ]



def _is_tracked_inventory_item(item: InventoryItem) -> bool:
    return item.ingredient is None or tracks_quantity(item.ingredient)


def _presence_low_stock_records(
    context: ToolContext,
    *,
    today: date,
    suggested_action: str | None = None,
) -> list[dict[str, Any]]:
    states = list(
        context.db.scalars(
            select(IngredientInventoryState)
            .where(
                IngredientInventoryState.family_id == context.family_id,
                IngredientInventoryState.availability_level == InventoryAvailabilityLevel.LOW,
            )
            .order_by(
                IngredientInventoryState.updated_at.desc(),
                IngredientInventoryState.ingredient_id.asc(),
            )
        )
    )
    if not states:
        return []
    ingredients = {
        ingredient.id: ingredient
        for ingredient in context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                Ingredient.id.in_([state.ingredient_id for state in states]),
            )
        )
    }
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"ingredient"},
        entity_ids=list(ingredients),
    )
    records = [
        inventory_state_record(
            state,
            ingredient,
            media_map,
            today=today,
            suggested_action=suggested_action,
        )
        for state in states
        if (ingredient := ingredients.get(state.ingredient_id)) is not None
        and not tracks_quantity(ingredient)
    ]
    records.sort(key=lambda record: (str(record["name"]), str(record["id"])))
    return records


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
    today = today_for_family(context.family_id)
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
        )
    )
    items = [item for item in items if _is_tracked_inventory_item(item)]
    states = list(
        context.db.scalars(
            select(IngredientInventoryState)
            .where(IngredientInventoryState.family_id == context.family_id)
            .order_by(IngredientInventoryState.updated_at.desc(), IngredientInventoryState.ingredient_id.asc())
        )
    )
    ingredients = {
        ingredient.id: ingredient
        for ingredient in context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                Ingredient.id.in_([*[item.ingredient_id for item in items], *[state.ingredient_id for state in states]]),
            )
        )
    } if (items or states) else {}
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"ingredient"},
        entity_ids=list(ingredients),
    )
    ingredient_records = [inventory_record(item, media_map, today=today) for item in items]
    for state in states:
        ingredient = ingredients.get(state.ingredient_id)
        if ingredient is None or tracks_quantity(ingredient):
            continue
        if not state_is_usable(state, business_date=today):
            continue
        ingredient_records.append(inventory_state_record(state, ingredient, media_map, today=today))
    food_records = _food_contextual_records(
        context,
        today=today,
        limit=limit,
        predicate=lambda row: True,
    )
    records = sorted([*ingredient_records, *food_records], key=_contextual_record_sort_key)[:limit]
    return _with_inventory_card(
        {"queryFocus": "available", "items": records, "count": len(records)},
        title="可用库存",
    )


def inventory_read_expiring_items(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    today = today_for_family(context.family_id)
    days = int(payload.get("days") or 7)
    limit = int(payload.get("limit") or 80)
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
            .limit(limit)
        )
    )
    items = [item for item in items if _is_tracked_inventory_item(item)]
    media_map = entity_media_map(context.db, family_id=context.family_id, entity_types={"ingredient"}, entity_ids=[item.ingredient_id for item in items])
    ingredient_records = [
        inventory_record(
            item,
            media_map,
            today=today,
            suggested_action="consume",
        )
        for item in items
    ]
    # Presence expiring states
    states = list(
        context.db.scalars(
            select(IngredientInventoryState).where(IngredientInventoryState.family_id == context.family_id)
        )
    )
    ingredients = {
        ingredient.id: ingredient
        for ingredient in context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                Ingredient.id.in_([state.ingredient_id for state in states]),
            )
        )
    } if states else {}
    state_media = entity_media_map(context.db, family_id=context.family_id, entity_types={"ingredient"}, entity_ids=list(ingredients))
    for state in states:
        ingredient = ingredients.get(state.ingredient_id)
        if ingredient is None or tracks_quantity(ingredient):
            continue
        if state.expiry_date is None:
            continue
        if not (today <= state.expiry_date <= today + timedelta(days=days)):
            continue
        if not state_is_physically_present(state):
            continue
        ingredient_records.append(
            inventory_state_record(state, ingredient, state_media, today=today, suggested_action="consume")
        )
    food_records = _food_contextual_records(
        context,
        today=today,
        limit=limit,
        predicate=lambda row: row.get("days_until_expiry") is not None and 0 <= row["days_until_expiry"] <= days,
    )
    records = sorted([*ingredient_records, *food_records], key=_contextual_record_sort_key)[:limit]
    return _with_inventory_card(
        {"queryFocus": "expiring", "items": records, "count": len(records)},
        title="临期库存",
    )


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
    items = [item for item in items if _is_tracked_inventory_item(item)]
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"ingredient"},
        entity_ids=[item.ingredient_id for item in items],
    )
    ingredient_records = [
        inventory_record(item, media_map, today=today, suggested_action="dispose")
        for item in items
    ]
    states = list(
        context.db.scalars(
            select(IngredientInventoryState).where(IngredientInventoryState.family_id == context.family_id)
        )
    )
    ingredients = {
        ingredient.id: ingredient
        for ingredient in context.db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == context.family_id,
                Ingredient.id.in_([state.ingredient_id for state in states]),
            )
        )
    } if states else {}
    state_media = entity_media_map(context.db, family_id=context.family_id, entity_types={"ingredient"}, entity_ids=list(ingredients))
    for state in states:
        ingredient = ingredients.get(state.ingredient_id)
        if ingredient is None or tracks_quantity(ingredient):
            continue
        if state.expiry_date is None or state.expiry_date >= today:
            continue
        if not state_is_physically_present(state):
            continue
        ingredient_records.append(
            inventory_state_record(state, ingredient, state_media, today=today, suggested_action="dispose")
        )
    food_records = _food_contextual_records(
        context,
        today=today,
        limit=limit,
        predicate=lambda row: row.get("days_until_expiry") is not None and row["days_until_expiry"] < 0,
    )
    records = sorted([*ingredient_records, *food_records], key=_contextual_record_sort_key)[:limit]
    return _with_inventory_card(
        {"queryFocus": "expired", "items": records, "count": len(records)},
        title="过期库存",
    )


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
        )
    )
    items = [item for item in items if _is_tracked_inventory_item(item)]
    configured_ingredients = list(
        context.db.scalars(
            select(Ingredient)
            .where(
                Ingredient.family_id == context.family_id,
                Ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY,
                Ingredient.default_low_stock_threshold.is_not(None),
                Ingredient.default_low_stock_threshold > 0,
            )
            .order_by(Ingredient.name.asc(), Ingredient.id.asc())
        )
    )
    remaining_by_ingredient = {
        ingredient_id: Decimal(str(total or 0))
        for ingredient_id, total in context.db.execute(
            select(
                InventoryItem.ingredient_id,
                func.coalesce(func.sum(remaining), 0),
            )
            .where(InventoryItem.family_id == context.family_id)
            .group_by(InventoryItem.ingredient_id)
        ).all()
    }
    media_map = entity_media_map(
        context.db,
        family_id=context.family_id,
        entity_types={"ingredient"},
        entity_ids=[
            *[item.ingredient_id for item in items],
            *[ingredient.id for ingredient in configured_ingredients],
        ],
    )
    today = today_for_family(context.family_id)
    records = [
        inventory_record(item, media_map, today=today, suggested_action="restock")
        for item in items
    ]
    presence_records = _presence_low_stock_records(
        context,
        today=today,
        suggested_action="restock",
    )
    represented_ingredient_ids = {str(item.ingredient_id) for item in items}
    depleted_records = [
        {
            "id": f"ingredient:{ingredient.id}",
            "sourceType": "ingredient",
            "inventoryItemId": None,
            "ingredientId": ingredient.id,
            "foodId": None,
            "name": ingredient.name,
            "image": first_entity_media(media_map, "ingredient", ingredient.id),
            "quantity": "0",
            "unit": ingredient.default_unit,
            "quantityTrackingMode": "track_quantity",
            "status": "out_of_stock",
            "displayStatus": "low_stock",
            "expiryDate": None,
            "daysUntilExpiry": None,
            "lowStockThreshold": decimal_text(ingredient.default_low_stock_threshold),
            "purchaseDate": "",
            "storageLocation": ingredient.default_storage,
            "suggestedAction": "restock",
        }
        for ingredient in configured_ingredients
        if ingredient.id not in represented_ingredient_ids
        and remaining_by_ingredient.get(ingredient.id, Decimal("0")) <= 0
    ]
    records = [*depleted_records, *presence_records, *records][:limit]
    return _with_inventory_card(
        {"queryFocus": "low_stock", "items": records, "count": len(records)},
        title="低库存提醒",
    )


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
    expiring_items = [item for item in expiring_items if _is_tracked_inventory_item(item)]
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
        )
    )
    low_stock_items = [item for item in low_stock_items if _is_tracked_inventory_item(item)]
    presence_low_records = _presence_low_stock_records(context, today=today)
    if expiring_items:
        media_map = entity_media_map(
            context.db,
            family_id=context.family_id,
            entity_types={"ingredient"},
            entity_ids=[item.ingredient_id for item in expiring_items],
        )
        records = [inventory_record(item, media_map, today=today) for item in expiring_items]
    elif low_stock_items or presence_low_records:
        media_map = entity_media_map(
            context.db,
            family_id=context.family_id,
            entity_types={"ingredient"},
            entity_ids=[item.ingredient_id for item in low_stock_items],
        )
        records = [
            *[inventory_record(item, media_map, today=today) for item in low_stock_items],
            *presence_low_records,
        ][:6]
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
        "expiredCount": sum(
            row.get("days_until_expiry") is not None and row["days_until_expiry"] < 0
            for row in rows
        ),
        "lowStockCount": len(low_stock_items) + len(presence_low_records),
        "foodStockCount": overview["summary"]["food_count"],
        "items": records,
    }
    return {**data, "card": _inventory_summary_card(data, title="库存概览")}


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
            input_schema=DAYS_LIMIT_INPUT,
            output_schema=inventory_items_output_schema("expiring"),
            permission="family:read",
            side_effect="read",
            handler=inventory_read_expiring_items,
            terminal_output=True,
            followup_hint="临期库存卡可作为临期查询的终态输出。",
            output_types=["inventory_summary"],
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
            terminal_output=True,
            followup_hint="过期库存卡可作为过期查询的终态输出。",
            output_types=["inventory_summary"],
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
            terminal_output=True,
            followup_hint="低库存卡可作为补货查询的终态输出。",
            output_types=["inventory_summary"],
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
            terminal_output=True,
            followup_hint="可用库存卡可作为库存查询的终态输出。",
            output_types=["inventory_summary"],
        )
    )
