from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.deps import get_current_auth
from app.core.enums import InventoryConfirmationSource
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Ingredient
from app.schemas.inventory_states import (
    CorrectStateExpiryDateRequest,
    IngredientInventoryStateOut,
    SetInventoryStateAbsentRequest,
    SnoozeStateExpiryAlertRequest,
    UpsertIngredientInventoryStateRequest,
)
from app.services.clock import today_for_family
from app.services.ingredient_inventory_state import list_inventory_states, upsert_inventory_state
from app.services.inventory_expiry_actions import (
    correct_state_expiry_date,
    set_inventory_state_absent,
    snooze_state_expiry_alert,
)
from app.services.inventory_versions import STALE_INVENTORY_DETAIL, InventoryConflictError, conflict_detail
from app.services.serializers import serialize_ingredient_inventory_state

router = APIRouter(tags=["inventory-states"])


def _actor_display_name(user) -> str:
    return (getattr(user, "display_name", None) or getattr(user, "username", None) or "家人").strip() or "家人"


def _commit_state_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


def _conflict_http(exc: InventoryConflictError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=conflict_detail(exc))


@router.get("/api/inventory/states", response_model=list[IngredientInventoryStateOut])
def get_inventory_states(
    ingredient_ids: list[str] | None = Query(default=None),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    states = list_inventory_states(
        db,
        family_id=membership.family_id,
        ingredient_ids=ingredient_ids,
    )
    return [serialize_ingredient_inventory_state(state) for state in states]


@router.put("/api/inventory/states/{ingredient_id}", response_model=IngredientInventoryStateOut)
def put_inventory_state(
    ingredient_id: str,
    payload: UpsertIngredientInventoryStateRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    ingredient = db.scalar(
        select(Ingredient).where(
            Ingredient.family_id == membership.family_id,
            Ingredient.id == ingredient_id,
        )
    )
    if ingredient is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")
    try:
        state = upsert_inventory_state(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            ingredient=ingredient,
            expected_ingredient_row_version=payload.expected_ingredient_row_version,
            state_id=payload.state_id,
            expected_state_row_version=payload.expected_state_row_version,
            availability_level=payload.availability_level,
            inventory_status=payload.inventory_status,
            purchase_date=payload.purchase_date,
            expiry_date=payload.expiry_date,
            storage_location=payload.storage_location,
            notes=payload.notes,
            confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
            record_activity=True,
        )
    except InventoryConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=conflict_detail(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _commit_state_session(db)
    db.refresh(state)
    return serialize_ingredient_inventory_state(state)


@router.post(
    "/api/inventory/states/{ingredient_id}/snooze-expiry-alert",
    response_model=IngredientInventoryStateOut,
)
def snooze_inventory_state_expiry_alert(
    ingredient_id: str,
    payload: SnoozeStateExpiryAlertRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        state = snooze_state_expiry_alert(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            actor_display_name=_actor_display_name(user),
            ingredient_id=ingredient_id,
            state_id=payload.state_id,
            expected_row_version=payload.expected_row_version,
            action=payload.action,
            snoozed_until=payload.snoozed_until,
            today=today_for_family(membership.family_id),
        )
    except InventoryConflictError as exc:
        raise _conflict_http(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _commit_state_session(db)
    db.refresh(state)
    return serialize_ingredient_inventory_state(state)


@router.patch(
    "/api/inventory/states/{ingredient_id}/expiry-date",
    response_model=IngredientInventoryStateOut,
)
def correct_inventory_state_expiry_date(
    ingredient_id: str,
    payload: CorrectStateExpiryDateRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        state = correct_state_expiry_date(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            actor_display_name=_actor_display_name(user),
            ingredient_id=ingredient_id,
            state_id=payload.state_id,
            expected_row_version=payload.expected_row_version,
            expiry_date=payload.expiry_date,
        )
    except InventoryConflictError as exc:
        raise _conflict_http(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _commit_state_session(db)
    db.refresh(state)
    return serialize_ingredient_inventory_state(state)


@router.post(
    "/api/inventory/states/{ingredient_id}/set-absent",
    response_model=IngredientInventoryStateOut,
)
def set_inventory_state_absent_endpoint(
    ingredient_id: str,
    payload: SetInventoryStateAbsentRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        state = set_inventory_state_absent(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            actor_display_name=_actor_display_name(user),
            ingredient_id=ingredient_id,
            state_id=payload.state_id,
            expected_row_version=payload.expected_row_version,
            today=today_for_family(membership.family_id),
        )
    except InventoryConflictError as exc:
        raise _conflict_http(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    _commit_state_session(db)
    db.refresh(state)
    return serialize_ingredient_inventory_state(state)
