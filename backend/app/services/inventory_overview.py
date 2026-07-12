from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import FoodType, IngredientQuantityTrackingMode, InventoryAvailabilityLevel
from app.models.domain import Food, Ingredient, IngredientInventoryState, InventoryItem
from app.services.food_stock_quantity import format_food_stock_quantity
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.ingredient_inventory_state import state_is_physically_present
from app.services.inventory_usage import remaining_quantity, tracks_quantity
from app.services.serializers import serialize_media

InventoryOverviewScope = Literal["all", "ingredient", "food"]

READY_LIKE_FOOD_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}
_TONE_PRIORITY = {"danger": 0, "warning": 1, "stable": 2, "empty": 3}
_SOURCE_PRIORITY = {"food": 0, "ingredient": 1}


def is_ready_like_food(food: Food) -> bool:
    food_type = food.type.value if hasattr(food.type, "value") else str(food.type)
    return food_type in READY_LIKE_FOOD_TYPES


def _format_quantity(value: Decimal | None, unit: str, fallback: str) -> str:
    return format_food_stock_quantity(value, unit, fallback=fallback)


def _days_until(value: date | None, today: date) -> int | None:
    return None if value is None else (value - today).days


def _tone_for_stock(quantity: Decimal | None, expiry_date: date | None, today: date) -> str:
    days = _days_until(expiry_date, today)
    if quantity is not None and quantity <= 0:
        return "empty"
    if days is not None and days < 0:
        return "danger"
    if days is not None and days <= 7:
        return "warning"
    return "stable"


def _serialize_first_media(
    media_map: dict[tuple[str, str], list[Any]],
    entity_type: str,
    entity_id: str,
) -> dict | None:
    media = media_map.get((entity_type, entity_id), [])
    return serialize_media(media[0]) if media else None


def _matches_query(row: dict[str, Any], query: str) -> bool:
    if not query:
        return True
    return query in row["search_text"]


def _quantity_label_for_presence(level: InventoryAvailabilityLevel) -> str:
    if level is InventoryAvailabilityLevel.LOW:
        return "偏低"
    if level is InventoryAvailabilityLevel.SUFFICIENT:
        return "充足"
    if level is InventoryAvailabilityLevel.ABSENT:
        return "没有"
    return "已有"


def _tone_for_presence(
    level: InventoryAvailabilityLevel,
    expiry_date: date | None,
    today: date,
) -> str:
    tone = _tone_for_stock(Decimal("1"), expiry_date, today)
    if tone == "stable" and level is InventoryAvailabilityLevel.LOW:
        return "warning"
    return tone


def _ingredient_rows(
    db: Session,
    *,
    family_id: str,
    today: date,
    query: str,
) -> list[dict[str, Any]]:
    items = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == family_id)
            .options(selectinload(InventoryItem.ingredient))
            .order_by(InventoryItem.updated_at.desc(), InventoryItem.id)
        )
    )
    states = list(
        db.scalars(
            select(IngredientInventoryState)
            .where(IngredientInventoryState.family_id == family_id)
            .order_by(IngredientInventoryState.updated_at.desc(), IngredientInventoryState.ingredient_id.asc())
        )
    )
    state_ingredient_ids = [state.ingredient_id for state in states]
    ingredients_by_id = {
        ingredient.id: ingredient
        for ingredient in db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == family_id,
                Ingredient.id.in_(list({*state_ingredient_ids, *[item.ingredient_id for item in items]})),
            )
        )
    } if (states or items) else {}
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="ingredient",
            entity_ids=list(ingredients_by_id),
        )
    )
    rows: list[dict[str, Any]] = []

    for item in items:
        ingredient = item.ingredient or ingredients_by_id.get(item.ingredient_id)
        if ingredient is None or ingredient.family_id != family_id:
            continue
        if not tracks_quantity(ingredient):
            # Historical presence placeholders must not appear in overview.
            continue
        remaining = remaining_quantity(item)
        if remaining <= 0:
            continue
        days = _days_until(item.expiry_date, today)
        tone = _tone_for_stock(remaining, item.expiry_date, today)
        row = {
            "id": f"ingredient:{item.id}",
            "source_type": "ingredient",
            "source_id": ingredient.id,
            "row_version": item.row_version,
            "inventory_item_id": item.id,
            "title": ingredient.name,
            "category": ingredient.category,
            "image": _serialize_first_media(media_map, "ingredient", ingredient.id),
            "quantity": float(remaining),
            "unit": item.unit,
            "quantity_label": _format_quantity(remaining, item.unit, "已有"),
            "quantity_tracking_mode": (
                ingredient.quantity_tracking_mode.value
                if hasattr(ingredient.quantity_tracking_mode, "value")
                else ingredient.quantity_tracking_mode
            ),
            "status": item.status.value if hasattr(item.status, "value") else item.status,
            "tone": tone,
            "expiry_date": item.expiry_date,
            "days_until_expiry": days,
            "storage_location": item.storage_location or ingredient.default_storage or "常温",
            "purchase_source": None,
            "updated_at": item.updated_at.isoformat(),
            "primary_action": "dispose" if tone == "danger" else "consume",
            "search_text": " ".join(
                [
                    ingredient.name,
                    ingredient.category,
                    ingredient.notes,
                    item.storage_location,
                    item.notes,
                ]
            ),
        }
        if _matches_query(row, query):
            rows.append(row)

    for state in states:
        ingredient = ingredients_by_id.get(state.ingredient_id)
        if ingredient is None or ingredient.family_id != family_id:
            continue
        if tracks_quantity(ingredient):
            continue
        if not state_is_physically_present(state):
            continue
        days = _days_until(state.expiry_date, today)
        tone = _tone_for_presence(state.availability_level, state.expiry_date, today)
        status = state.inventory_status.value if hasattr(state.inventory_status, "value") else state.inventory_status
        storage = state.storage_location or ingredient.default_storage or "常温"
        row = {
            "id": f"ingredient-state:{state.id}",
            "source_type": "ingredient",
            "source_id": ingredient.id,
            "row_version": state.row_version,
            "inventory_item_id": None,
            "title": ingredient.name,
            "category": ingredient.category,
            "image": _serialize_first_media(media_map, "ingredient", ingredient.id),
            "quantity": None,
            "unit": ingredient.default_unit,
            "quantity_label": _quantity_label_for_presence(state.availability_level),
            "quantity_tracking_mode": (
                ingredient.quantity_tracking_mode.value
                if hasattr(ingredient.quantity_tracking_mode, "value")
                else ingredient.quantity_tracking_mode
            ),
            "status": status,
            "tone": tone,
            "expiry_date": state.expiry_date,
            "days_until_expiry": days,
            "storage_location": storage,
            "purchase_source": None,
            "updated_at": state.updated_at.isoformat(),
            "primary_action": "dispose" if tone == "danger" else "restock",
            "search_text": " ".join(
                [
                    ingredient.name,
                    ingredient.category,
                    ingredient.notes,
                    storage or "",
                    state.notes or "",
                ]
            ),
        }
        if _matches_query(row, query):
            rows.append(row)
    return rows


def _food_rows(
    db: Session,
    *,
    family_id: str,
    today: date,
    query: str,
) -> list[dict[str, Any]]:
    foods = list(
        db.scalars(
            select(Food)
            .where(Food.family_id == family_id, Food.type.in_(READY_LIKE_FOOD_TYPES))
            .order_by(Food.updated_at.desc(), Food.id)
        )
    )
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="food",
            entity_ids=[food.id for food in foods],
        )
    )
    rows: list[dict[str, Any]] = []
    for food in foods:
        if not is_ready_like_food(food):
            continue
        quantity = food.stock_quantity
        is_pending = quantity is None or quantity <= 0
        days = _days_until(food.expiry_date, today)
        tone = "empty" if is_pending else _tone_for_stock(quantity, food.expiry_date, today)
        storage_location = food.storage_location or "常温"
        unit = food.stock_unit or "份"
        row = {
            "id": f"food:{food.id}",
            "source_type": "food",
            "source_id": food.id,
            "row_version": food.row_version,
            "inventory_item_id": None,
            "title": food.name,
            "category": food.category,
            "image": _serialize_first_media(media_map, "food", food.id),
            "quantity": float(quantity) if quantity is not None else None,
            "unit": unit,
            "quantity_label": "未入库" if is_pending else _format_quantity(quantity, unit, "未记录"),
            "quantity_tracking_mode": IngredientQuantityTrackingMode.TRACK_QUANTITY.value,
            "status": None,
            "tone": tone,
            "expiry_date": food.expiry_date,
            "days_until_expiry": days,
            "storage_location": storage_location,
            "purchase_source": food.purchase_source or food.source_name or None,
            "updated_at": food.updated_at.isoformat(),
            "primary_action": "edit_food_stock" if is_pending or tone == "danger" else "record_meal",
            "search_text": " ".join(
                [
                    food.name,
                    food.category,
                    storage_location,
                    food.source_name,
                    food.purchase_source,
                    food.notes,
                    food.routine_note,
                    " ".join(food.scene_tags or []),
                ]
            ),
        }
        if _matches_query(row, query):
            rows.append(row)
    return rows


def build_inventory_overview(
    db: Session,
    *,
    family_id: str,
    scope: InventoryOverviewScope,
    query: str,
    today: date,
) -> dict[str, Any]:
    normalized_query = query.strip()
    rows: list[dict[str, Any]] = []
    if scope in {"all", "ingredient"}:
        rows.extend(_ingredient_rows(db, family_id=family_id, today=today, query=normalized_query))
    if scope in {"all", "food"}:
        rows.extend(_food_rows(db, family_id=family_id, today=today, query=normalized_query))
    rows.sort(
        key=lambda row: (
            _TONE_PRIORITY.get(row["tone"], len(_TONE_PRIORITY)),
            _SOURCE_PRIORITY.get(row["source_type"], len(_SOURCE_PRIORITY)),
            row["updated_at"],
            row["id"],
        )
    )
    summary = {
        "total_count": len(rows),
        "ingredient_count": sum(1 for row in rows if row["source_type"] == "ingredient"),
        "food_count": sum(1 for row in rows if row["source_type"] == "food"),
        "alert_count": sum(1 for row in rows if row["tone"] in {"warning", "danger"}),
        "expiring_count": sum(
            1
            for row in rows
            if row["days_until_expiry"] is not None and 0 <= row["days_until_expiry"] <= 7
        ),
        "empty_count": sum(1 for row in rows if row["tone"] == "empty"),
    }
    return {"scope": scope, "query": normalized_query, "summary": summary, "items": rows}
