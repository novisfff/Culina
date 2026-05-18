from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.db.session import get_db
from app.models.domain import Ingredient, InventoryItem
from app.schemas.domain import (
    ConsumeInventoryRequest,
    ConsumeInventoryResponse,
    CreateInventoryItemRequest,
    DisposeExpiredInventoryRequest,
    DisposeExpiredInventoryResponse,
    InventoryItemOut,
)
from app.services.activity import log_activity
from app.services.ingredient_units import (
    UnitConversionError,
    convert_quantity_from_default_unit,
    convert_quantity_to_default_unit,
    normalize_unit_label,
)
from app.services.serializers import serialize_inventory_item

router = APIRouter(tags=["inventory"])


def _remaining_quantity(item: InventoryItem) -> Decimal:
    return max(item.quantity - item.consumed_quantity, Decimal("0"))


def _expiry_sort_key(expiry_date: date | None) -> tuple[int, date]:
    return (1, date.max) if expiry_date is None else (0, expiry_date)


def _remaining_quantity_in_default(item: InventoryItem, ingredient: Ingredient) -> Decimal:
    remaining = _remaining_quantity(item)
    if item.unit == ingredient.default_unit:
        return remaining
    return convert_quantity_to_default_unit(remaining, ingredient.default_unit, ingredient.unit_conversions, item.unit)


@router.get("/api/inventory", response_model=list[InventoryItemOut])
def list_inventory(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    items = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == membership.family_id)
            .options(selectinload(InventoryItem.ingredient))
            .order_by(InventoryItem.updated_at.desc())
        )
    )
    return [serialize_inventory_item(item) for item in items]


@router.post("/api/inventory", response_model=InventoryItemOut, status_code=status.HTTP_201_CREATED)
def create_inventory_item(
    payload: CreateInventoryItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    ingredient = db.scalar(
        select(Ingredient).where(Ingredient.family_id == membership.family_id, Ingredient.id == payload.ingredient_id)
    )
    if ingredient is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")
    if payload.quantity <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Quantity must be greater than 0")

    normalized_unit = normalize_unit_label(payload.unit)
    if not normalized_unit:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unit is required")
    try:
        normalized_quantity = convert_quantity_to_default_unit(
            payload.quantity,
            ingredient.default_unit,
            ingredient.unit_conversions,
            normalized_unit,
        )
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    fallback_threshold = payload.low_stock_threshold
    if ingredient.default_low_stock_threshold is None and fallback_threshold:
        try:
            fallback_threshold = float(
                convert_quantity_to_default_unit(
                    fallback_threshold,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    normalized_unit,
                )
            )
        except UnitConversionError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    item = InventoryItem(
        id=create_id("inventory"),
        family_id=membership.family_id,
        ingredient_id=payload.ingredient_id,
        quantity=normalized_quantity,
        unit=ingredient.default_unit,
        entered_quantity=Decimal(str(payload.quantity)),
        entered_unit=normalized_unit,
        status=payload.status,
        purchase_date=payload.purchase_date,
        expiry_date=payload.expiry_date,
        storage_location=payload.storage_location,
        notes=payload.notes,
        low_stock_threshold=ingredient.default_low_stock_threshold
        if ingredient.default_low_stock_threshold is not None
        else fallback_threshold,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(item)
    db.flush()
    db.refresh(item, attribute_names=["ingredient"])
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="InventoryItem",
        entity_id=item.id,
        summary=f"录入库存 {item.ingredient.name if item.ingredient else '食材'} {float(item.entered_quantity or item.quantity):g}{item.entered_unit or item.unit}",
    )
    db.commit()
    db.refresh(item)
    return serialize_inventory_item(item)


@router.post("/api/inventory/consume", response_model=ConsumeInventoryResponse)
def consume_inventory(
    payload: ConsumeInventoryRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    ingredient = db.scalar(
        select(Ingredient).where(Ingredient.family_id == membership.family_id, Ingredient.id == payload.ingredient_id)
    )
    if ingredient is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")

    requested_quantity = Decimal(str(payload.quantity))
    if requested_quantity <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Quantity must be greater than 0")

    unit = normalize_unit_label(payload.unit)
    if not unit:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unit is required")
    try:
        requested_quantity_in_default = convert_quantity_to_default_unit(
            requested_quantity,
            ingredient.default_unit,
            ingredient.unit_conversions,
            unit,
        )
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    items = list(
        db.scalars(
            select(InventoryItem)
            .where(
                InventoryItem.family_id == membership.family_id,
                InventoryItem.ingredient_id == payload.ingredient_id,
            )
        )
    )
    today = date.today()
    available_items: list[tuple[InventoryItem, Decimal]] = []
    for item in items:
        if item.expiry_date is not None and item.expiry_date < today:
            continue
        try:
            remaining_in_default = _remaining_quantity_in_default(item, ingredient)
        except UnitConversionError:
            continue
        if remaining_in_default > 0:
            available_items.append((item, remaining_in_default))
    available_items.sort(
        key=lambda entry: (
            *_expiry_sort_key(entry[0].expiry_date),
            entry[0].purchase_date,
            entry[0].created_at,
        )
    )

    available_total = sum((remaining for _, remaining in available_items), Decimal("0"))
    if available_total < requested_quantity_in_default:
        try:
            available_total_in_requested_unit = convert_quantity_from_default_unit(
                available_total,
                ingredient.default_unit,
                ingredient.unit_conversions,
                unit,
            )
        except UnitConversionError:
            available_total_in_requested_unit = available_total
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"当前最多只能消费 {float(available_total_in_requested_unit):g}{unit}",
        )

    remaining_to_consume = requested_quantity_in_default
    affected_item_ids: list[str] = []

    for item, remaining_quantity_in_default in available_items:
        if remaining_to_consume <= 0:
            break
        deduction_in_default = min(remaining_quantity_in_default, remaining_to_consume)
        if deduction_in_default <= 0:
            continue
        try:
            deduction_in_item_unit = (
                deduction_in_default
                if item.unit == ingredient.default_unit
                else convert_quantity_from_default_unit(
                    deduction_in_default,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    item.unit,
                )
            )
        except UnitConversionError:
            continue
        item.consumed_quantity = item.consumed_quantity + deduction_in_item_unit
        item.updated_by = user.id
        affected_item_ids.append(item.id)
        remaining_to_consume -= deduction_in_default

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"消费食材 {ingredient.name} {float(requested_quantity):g}{unit}",
    )
    db.commit()

    return {
        "ingredient_id": ingredient.id,
        "unit": unit,
        "consumed_quantity": float(requested_quantity),
        "affected_item_ids": affected_item_ids,
    }


@router.post("/api/inventory/dispose-expired", response_model=DisposeExpiredInventoryResponse)
def dispose_expired_inventory(
    payload: DisposeExpiredInventoryRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    ingredient = db.scalar(
        select(Ingredient).where(Ingredient.family_id == membership.family_id, Ingredient.id == payload.ingredient_id)
    )
    if ingredient is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")

    requested_item_ids = list(dict.fromkeys(payload.inventory_item_ids))
    if not requested_item_ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Inventory items are required")

    items = list(
        db.scalars(
            select(InventoryItem).where(
                InventoryItem.family_id == membership.family_id,
                InventoryItem.id.in_(requested_item_ids),
            )
        )
    )
    items_by_id = {item.id: item for item in items}
    if len(items_by_id) != len(requested_item_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Some inventory items are invalid")

    today = date.today()
    disposed_item_ids: list[str] = []

    for item_id in requested_item_ids:
        item = items_by_id[item_id]
        if item.ingredient_id != ingredient.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Inventory item does not belong to ingredient")
        if item.expiry_date is None or item.expiry_date >= today:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only expired inventory can be disposed")
        if _remaining_quantity(item) <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Inventory item has no remaining quantity")

        item.consumed_quantity = item.quantity
        item.updated_by = user.id
        disposed_item_ids.append(item.id)

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"销毁过期库存 {ingredient.name} {len(disposed_item_ids)} 条批次",
    )
    db.commit()

    return {
        "ingredient_id": ingredient.id,
        "disposed_item_ids": disposed_item_ids,
        "disposed_count": len(disposed_item_ids),
    }
