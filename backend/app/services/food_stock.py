from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import ActivityAction
from app.models.domain import Food
from app.services.activity import log_activity
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
    return Decimal(str(food.stock_quantity or 0))


def _format_quantity(value: Decimal, unit: str) -> str:
    return f"{float(value):g}{unit}"


def _touch_food_stock(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    summary: str,
) -> Food:
    food.updated_by = user_id
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
) -> Food:
    _require_food_stock_managed(food)
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit and _current_quantity(food) > 0:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，请先清空或使用相同单位")
    food.stock_unit = normalized_unit
    food.stock_quantity = _current_quantity(food) + quantity
    if expiry_date is not None:
        food.expiry_date = expiry_date
    if purchase_source is not None:
        food.purchase_source = purchase_source.strip()
    if storage_location is not None:
        food.storage_location = storage_location.strip()
    detail = f"补充食物库存 {food.name} {_format_quantity(quantity, normalized_unit)}"
    if note.strip():
        detail = f"{detail}：{note.strip()}"
    return _touch_food_stock(db, family_id=family_id, user_id=user_id, food=food, summary=detail)


def apply_food_stock_consume(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    note: str = "",
) -> Food:
    _require_food_stock_managed(food)
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，不能按 {normalized_unit} 扣减")
    current = _current_quantity(food)
    if quantity > current:
        raise ValueError(f"当前最多只能处理 {_format_quantity(current, food.stock_unit or normalized_unit)}")
    food.stock_unit = normalized_unit
    food.stock_quantity = current - quantity
    detail = f"记录食用 {food.name} {_format_quantity(quantity, normalized_unit)}"
    if note.strip():
        detail = f"{detail}：{note.strip()}"
    return _touch_food_stock(db, family_id=family_id, user_id=user_id, food=food, summary=detail)


def apply_food_stock_dispose(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    food: Food,
    quantity: Decimal,
    unit: str | None,
    reason: str,
) -> Food:
    _require_food_stock_managed(food)
    if not reason.strip():
        raise ValueError("请填写处理原因")
    if quantity <= 0:
        raise ValueError("库存数量必须大于 0")
    normalized_unit = _normalize_unit(unit, food.stock_unit)
    if food.stock_unit and food.stock_unit != normalized_unit:
        raise ValueError(f"当前库存单位是 {food.stock_unit}，不能按 {normalized_unit} 处理")
    current = _current_quantity(food)
    if quantity > current:
        raise ValueError(f"当前最多只能处理 {_format_quantity(current, food.stock_unit or normalized_unit)}")
    food.stock_unit = normalized_unit
    food.stock_quantity = current - quantity
    return _touch_food_stock(
        db,
        family_id=family_id,
        user_id=user_id,
        food=food,
        summary=f"处理食物库存 {food.name} {_format_quantity(quantity, normalized_unit)}：{reason.strip()}",
    )
