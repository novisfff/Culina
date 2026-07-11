from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, InventoryConfirmationSource
from app.core.utils import utcnow
from app.models.domain import Food
from app.services.activity import log_activity
from app.services.food_stock_quantity import (
    format_food_stock_quantity,
    normalize_food_stock_quantity,
    validate_food_stock_quantity_precision,
)
from app.services.inventory_overview import is_ready_like_food
from app.services.search.jobs import enqueue_search_index_job


def _normalize_unit(unit: str | None, fallback: str) -> str:
    normalized = (unit or fallback or "份").strip()
    if not normalized:
        raise ValueError("单位不能为空")
    return normalized


def _require_food_stock_managed(food: Food) -> None:
    if not is_ready_like_food(food):
        raise ValueError("只有成品、速食和包装食品支持食物库存操作")


def _current_quantity(food: Food) -> Decimal:
    return normalize_food_stock_quantity(Decimal(str(food.stock_quantity or 0)))


def _format_quantity(value: Decimal, unit: str) -> str:
    return format_food_stock_quantity(value, unit, fallback=f"0{unit or '份'}")


def merge_food_intake_expiry(
    *,
    current_quantity: Decimal,
    current_expiry: date | None,
    incoming_expiry: date | None,
) -> date | None:
    """Intake-only expiry merge: keep earliest non-null date when old stock remains."""
    if current_quantity <= 0:
        return incoming_expiry
    if current_expiry is None:
        return incoming_expiry
    if incoming_expiry is None:
        return current_expiry
    return min(current_expiry, incoming_expiry)


def _touch_food_stock(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    summary: str,
    record_activity: bool = True,
) -> Food:
    food.updated_by = user_id
    if record_activity:
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="Food",
            entity_id=food.id,
            summary=summary,
        )
    enqueue_search_index_job(
        db,
        family_id=family_id,
        user_id=user_id,
        entity_type="food",
        entity_id=food.id,
        target_name=food.name,
    )
    db.flush()
    return food


def apply_food_stock_restock(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    expiry_date: date | None,
    purchase_source: str | None,
    storage_location: str | None,
    note: str = "",
    record_activity: bool = True,
) -> Food:
    _require_food_stock_managed(food)
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    validate_food_stock_quantity_precision(quantity)
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit and _current_quantity(food) > 0:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，请先清空或使用相同单位")
    food.stock_unit = normalized_unit
    food.stock_quantity = normalize_food_stock_quantity(_current_quantity(food) + quantity)
    if expiry_date is not None:
        food.expiry_date = expiry_date
    if purchase_source is not None:
        food.purchase_source = purchase_source.strip()
    if storage_location is not None:
        food.storage_location = storage_location.strip()
    detail = f"补充食物库存 {food.name} {_format_quantity(quantity, normalized_unit)}"
    if note.strip():
        detail = f"{detail}：{note.strip()}"
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=detail,
        record_activity=record_activity,
    )


def apply_food_stock_intake(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str,
    expiry_date: date | None,
    storage_location: str,
    note: str = "",
    record_activity: bool = False,
) -> Food:
    """Add purchased food stock with intake-only earliest-date expiry merge. Never commits."""
    _require_food_stock_managed(food)
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    validate_food_stock_quantity_precision(quantity)
    current_quantity = _current_quantity(food)
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit and current_quantity > 0:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，请先清空或使用相同单位")
    location = (storage_location or "").strip()
    if not location:
        raise ValueError("存放位置不能为空")

    merged_expiry = merge_food_intake_expiry(
        current_quantity=current_quantity,
        current_expiry=food.expiry_date,
        incoming_expiry=expiry_date,
    )
    food.stock_unit = normalized_unit
    food.stock_quantity = normalize_food_stock_quantity(current_quantity + quantity)
    food.expiry_date = merged_expiry
    food.storage_location = location
    food.inventory_last_confirmed_at = utcnow()
    food.inventory_last_confirmed_by = user_id
    food.inventory_confirmation_source = InventoryConfirmationSource.SHOPPING_INTAKE

    detail = f"采购入库食物 {food.name} {_format_quantity(quantity, normalized_unit)}"
    if note.strip():
        detail = f"{detail}：{note.strip()}"
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=detail,
        record_activity=record_activity,
    )


def apply_food_stock_consume(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    note: str = "",
    record_activity: bool = True,
) -> Food:
    _require_food_stock_managed(food)
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    validate_food_stock_quantity_precision(quantity)
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，不能按 {normalized_unit} 扣减")
    current = _current_quantity(food)
    if quantity > current:
        raise ValueError(f"当前最多只能处理 {_format_quantity(current, food.stock_unit or normalized_unit)}")
    food.stock_unit = normalized_unit
    food.stock_quantity = normalize_food_stock_quantity(current - quantity)
    detail = f"记录食用 {food.name} {_format_quantity(quantity, normalized_unit)}"
    if note.strip():
        detail = f"{detail}：{note.strip()}"
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=detail,
        record_activity=record_activity,
    )


def apply_food_stock_dispose(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    reason: str,
    record_activity: bool = True,
) -> Food:
    _require_food_stock_managed(food)
    if not reason.strip():
        raise ValueError("请填写处理原因")
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    validate_food_stock_quantity_precision(quantity)
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，不能按 {normalized_unit} 处理")
    current = _current_quantity(food)
    if quantity > current:
        raise ValueError(f"当前最多只能处理 {_format_quantity(current, food.stock_unit or normalized_unit)}")
    food.stock_unit = normalized_unit
    food.stock_quantity = normalize_food_stock_quantity(current - quantity)
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=f"处理食物库存 {food.name} {_format_quantity(quantity, normalized_unit)}：{reason.strip()}",
        record_activity=record_activity,
    )


def apply_food_inventory_confirm(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    record_activity: bool = False,
) -> Food:
    """Touch only inventory confirmation fields for reconciliation confirm."""
    _require_food_stock_managed(food)
    food.inventory_last_confirmed_at = utcnow()
    food.inventory_last_confirmed_by = user_id
    food.inventory_confirmation_source = InventoryConfirmationSource.RECONCILIATION
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=f"确认食物库存 {food.name}",
        record_activity=record_activity,
    )


def apply_food_inventory_set_stock(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    stock_quantity: Decimal,
    stock_unit: str | None,
    expiry_date: date | None,
    storage_location: str | None,
    record_activity: bool = False,
) -> Food:
    """Set absolute food stock for reconciliation. Zero means absent. Never merges expiry."""
    _require_food_stock_managed(food)
    if stock_quantity < 0:
        raise ValueError("库存数量不能为负")
    validate_food_stock_quantity_precision(stock_quantity)

    if stock_quantity > 0:
        normalized_unit = _normalize_unit(stock_unit, food.stock_unit)
        location = (storage_location or "").strip()
        if not location:
            raise ValueError("存放位置不能为空")
        food.stock_unit = normalized_unit
        food.stock_quantity = normalize_food_stock_quantity(stock_quantity)
        food.storage_location = location
        food.expiry_date = expiry_date
        summary = f"调整食物库存 {food.name} 为 {_format_quantity(stock_quantity, normalized_unit)}"
    else:
        # Absent: zero stock; keep unit if provided else existing; clear location optional.
        if stock_unit:
            food.stock_unit = _normalize_unit(stock_unit, food.stock_unit)
        food.stock_quantity = normalize_food_stock_quantity(Decimal("0"))
        if storage_location is not None:
            food.storage_location = storage_location.strip()
        food.expiry_date = expiry_date
        summary = f"确认没有 {food.name}"

    food.inventory_last_confirmed_at = utcnow()
    food.inventory_last_confirmed_by = user_id
    food.inventory_confirmation_source = InventoryConfirmationSource.RECONCILIATION
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=summary,
        record_activity=record_activity,
    )

