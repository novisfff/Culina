from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.exc import StaleDataError
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Ingredient, InventoryItem
from app.schemas.inventory import (
    ConsumeInventoryRequest,
    ConsumeInventoryResponse,
    CorrectInventoryExpiryDateRequest,
    CreateInventoryItemRequest,
    DisposeInventoryRequest,
    DisposeInventoryResponse,
    DisposeExpiredInventoryRequest,
    DisposeExpiredInventoryResponse,
    InventoryItemOut,
    SnoozeExpiryAlertsRequest,
    SnoozeExpiryAlertsResponse,
)
from app.schemas.inventory_overview import InventoryOverviewOut, InventoryOverviewScope
from app.services.clock import today_for_family
from app.services.inventory_expiry_actions import (
    InventoryStaleVersionError,
    correct_inventory_expiry_date,
    dispose_expired_inventory_items,
    snooze_expiry_alerts,
)
from app.services.inventory_versions import STALE_INVENTORY_DETAIL

from app.services.inventory_overview import build_inventory_overview
from app.services.inventory_operations import (
    consume_ingredient_inventory,
    create_inventory_batch,
    dispose_inventory_quantity,
    require_inventory_item,
)
from app.services.search.hybrid import hybrid_search
from app.services.serializers import serialize_inventory_item

router = APIRouter(tags=["inventory"])


def _commit_inventory_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


def _actor_display_name(user) -> str:
    display_name = getattr(user, "display_name", None)
    if isinstance(display_name, str) and display_name.strip():
        return display_name.strip()
    username = getattr(user, "username", None)
    if isinstance(username, str) and username.strip():
        return username.strip()
    return "家庭成员"


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
    _commit_inventory_session(db)
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
    _commit_inventory_session(db)
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
    _commit_inventory_session(db)
    return {
        "ingredient_id": result["ingredient_id"],
        "inventory_item_id": result["inventory_item_id"],
        "unit": result["unit"],
        "disposed_quantity": result["quantity"],
        "remaining_quantity": result["remaining_quantity"],
    }


@router.post("/api/inventory/snooze-expiry-alerts", response_model=SnoozeExpiryAlertsResponse)
def snooze_inventory_expiry_alerts(
    payload: SnoozeExpiryAlertsRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        result = snooze_expiry_alerts(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            actor_display_name=_actor_display_name(user),
            ingredient_id=payload.ingredient_id,
            action=payload.action,
            item_refs=payload.items,
            snoozed_until=payload.snoozed_until,
            today=today_for_family(membership.family_id),
        )
    except InventoryStaleVersionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _commit_inventory_session(db)
    return result


@router.patch("/api/inventory/{inventory_item_id}/expiry-date", response_model=InventoryItemOut)
def correct_inventory_item_expiry_date(
    inventory_item_id: str,
    payload: CorrectInventoryExpiryDateRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        item = correct_inventory_expiry_date(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            actor_display_name=_actor_display_name(user),
            inventory_item_id=inventory_item_id,
            expiry_date=payload.expiry_date,
            expected_row_version=payload.expected_row_version,
        )
    except InventoryStaleVersionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _commit_inventory_session(db)
    db.refresh(item)
    db.refresh(item, attribute_names=["ingredient"])
    return serialize_inventory_item(item)


@router.post("/api/inventory/dispose-expired", response_model=DisposeExpiredInventoryResponse)
def dispose_expired_inventory(
    payload: DisposeExpiredInventoryRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        result = dispose_expired_inventory_items(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            actor_display_name=_actor_display_name(user),
            ingredient_id=payload.ingredient_id,
            item_refs=payload.items,
            today=today_for_family(membership.family_id),
        )
    except InventoryStaleVersionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _commit_inventory_session(db)
    return result
