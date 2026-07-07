from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Ingredient, InventoryItem
from app.schemas.inventory import (
    ConsumeInventoryRequest,
    ConsumeInventoryResponse,
    CreateInventoryItemRequest,
    DisposeInventoryRequest,
    DisposeInventoryResponse,
    DisposeExpiredInventoryRequest,
    DisposeExpiredInventoryResponse,
    InventoryItemOut,
)
from app.schemas.inventory_overview import InventoryOverviewOut, InventoryOverviewScope
from app.services.clock import today_for_family
from app.services.inventory_overview import build_inventory_overview
from app.services.inventory_operations import (
    consume_ingredient_inventory,
    create_inventory_batch,
    dispose_inventory_quantity,
    require_inventory_item,
)
from app.services.inventory_usage import remaining_quantity
from app.services.search.hybrid import hybrid_search
from app.services.serializers import serialize_inventory_item

router = APIRouter(tags=["inventory"])


@router.get("/api/inventory/overview", response_model=InventoryOverviewOut)
def inventory_overview(
    scope: InventoryOverviewScope = Query(default="all"),
    q: str = Query(default="", max_length=100),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    return build_inventory_overview(
        db,
        family_id=membership.family_id,
        scope=scope,
        query=q,
        today=today_for_family(membership.family_id),
    )


@router.get("/api/inventory", response_model=list[InventoryItemOut])
def list_inventory(
    q: str = Query(default="", max_length=100),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    query = q.strip()
    if query:
        search_result = hybrid_search(
            db,
            family_id=membership.family_id,
            query=query,
            scopes=["ingredient"],
            limit=100,
            offset=0,
        )
        ingredient_ids = [item.entity_id for item in search_result.items if item.entity_type == "ingredient"]
        if not ingredient_ids:
            return []
        items = list(
            db.scalars(
                select(InventoryItem)
                .where(
                    InventoryItem.family_id == membership.family_id,
                    InventoryItem.ingredient_id.in_(ingredient_ids),
                )
                .options(selectinload(InventoryItem.ingredient))
            )
        )
        rank_by_ingredient_id = {ingredient_id: index for index, ingredient_id in enumerate(ingredient_ids)}
        items.sort(key=lambda item: (item.updated_at, item.id), reverse=True)
        items.sort(key=lambda item: rank_by_ingredient_id.get(item.ingredient_id, len(rank_by_ingredient_id)))
        return [serialize_inventory_item(item) for item in items]

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
    try:
        item = create_inventory_batch(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            ingredient=ingredient,
            quantity=Decimal(str(payload.quantity)) if payload.quantity is not None else None,
            unit=payload.unit,
            status=payload.status,
            purchase_date=payload.purchase_date,
            expiry_date=payload.expiry_date,
            storage_location=payload.storage_location,
            notes=payload.notes,
            low_stock_threshold=Decimal(str(payload.low_stock_threshold)),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    commit_session(db)
    db.refresh(item)
    db.refresh(item, attribute_names=["ingredient"])
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

    try:
        result = consume_ingredient_inventory(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            ingredient=ingredient,
            quantity=Decimal(str(payload.quantity)) if payload.quantity is not None else None,
            unit=payload.unit,
            today=today_for_family(membership.family_id),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    commit_session(db)
    return {
        "ingredient_id": ingredient.id,
        "unit": result["unit"],
        "consumed_quantity": result["quantity"],
        "affected_item_ids": result["affected_item_ids"],
    }


@router.post("/api/inventory/dispose", response_model=DisposeInventoryResponse)
def dispose_inventory(
    payload: DisposeInventoryRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        item = require_inventory_item(
            db,
            family_id=membership.family_id,
            inventory_item_id=payload.inventory_item_id,
            for_update=True,
        )
        result = dispose_inventory_quantity(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            item=item,
            quantity=Decimal(str(payload.quantity)) if payload.quantity is not None else None,
            unit=payload.unit,
            reason=payload.reason,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    commit_session(db)
    return {
        "ingredient_id": result["ingredient_id"],
        "inventory_item_id": result["inventory_item_id"],
        "unit": result["unit"],
        "disposed_quantity": result["quantity"],
        "remaining_quantity": result["remaining_quantity"],
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
            ).options(selectinload(InventoryItem.ingredient))
        )
    )
    items_by_id = {item.id: item for item in items}
    if len(items_by_id) != len(requested_item_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Some inventory items are invalid")

    today = today_for_family(membership.family_id)
    disposed_item_ids: list[str] = []

    for item_id in requested_item_ids:
        item = items_by_id[item_id]
        if item.ingredient_id != ingredient.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Inventory item does not belong to ingredient")
        if item.expiry_date is None or item.expiry_date >= today:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only expired inventory can be disposed")
        if remaining_quantity(item) <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Inventory item has no remaining quantity")

        dispose_inventory_quantity(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            item=item,
            quantity=None,
            unit=item.unit,
            reason="过期销毁",
        )
        disposed_item_ids.append(item.id)
    commit_session(db)

    return {
        "ingredient_id": ingredient.id,
        "disposed_item_ids": disposed_item_ids,
        "disposed_count": len(disposed_item_ids),
    }
