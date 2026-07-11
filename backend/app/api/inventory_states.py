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
from app.schemas.inventory_states import IngredientInventoryStateOut, UpsertIngredientInventoryStateRequest
from app.services.ingredient_inventory_state import list_inventory_states, upsert_inventory_state
from app.services.inventory_versions import STALE_INVENTORY_DETAIL, InventoryConflictError, conflict_detail
from app.services.serializers import serialize_ingredient_inventory_state

router = APIRouter(tags=["inventory-states"])


def _commit_state_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


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
