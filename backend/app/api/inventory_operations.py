from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.deps import get_current_auth
from app.core.utils import utcnow
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.inventory_operations import (
    InventoryOperationDetailOut,
    InventoryOperationResult,
    InventoryOperationSummaryOut,
)
from app.services.inventory_operation_history import (
    InventoryOperationNotFoundError,
    InventoryOperationPermissionError,
    get_inventory_operation_detail,
    list_inventory_operations,
    revert_inventory_operation,
)
from app.services.inventory_versions import STALE_INVENTORY_DETAIL, InventoryConflictError, conflict_detail

router = APIRouter(tags=["inventory-operations"])


def _commit_operation_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


def _http_conflict(exc: InventoryConflictError) -> HTTPException:
    detail = conflict_detail(exc)
    if isinstance(detail, str):
        payload = {
            "code": exc.code,
            "message": detail,
            "conflicts": list(exc.conflicts or []),
            "field_errors": [],
        }
    else:
        payload = {
            "code": detail.get("code", exc.code),
            "message": detail.get("message", exc.message),
            "conflicts": detail.get("conflicts", list(exc.conflicts or [])),
            "field_errors": detail.get("field_errors", []),
        }
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=payload)


@router.get("/api/inventory/operations", response_model=list[InventoryOperationSummaryOut])
def get_inventory_operations(
    limit: int = Query(default=20, ge=1, le=50),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[InventoryOperationSummaryOut]:
    user, membership = auth
    try:
        return list_inventory_operations(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            user_role=membership.role,
            now=utcnow(),
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc


@router.get("/api/inventory/operations/{operation_id}", response_model=InventoryOperationDetailOut)
def get_inventory_operation(
    operation_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> InventoryOperationDetailOut:
    user, membership = auth
    try:
        return get_inventory_operation_detail(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            user_role=membership.role,
            operation_id=operation_id,
            now=utcnow(),
        )
    except InventoryOperationNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post("/api/inventory/operations/{operation_id}/revert", response_model=InventoryOperationResult)
def post_inventory_operation_revert(
    operation_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> InventoryOperationResult:
    user, membership = auth
    try:
        result = revert_inventory_operation(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            user_role=membership.role,
            operation_id=operation_id,
            now=utcnow(),
        )
    except InventoryOperationNotFoundError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except InventoryOperationPermissionError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except InventoryConflictError as exc:
        db.rollback()
        raise _http_conflict(exc) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    _commit_operation_session(db)
    return result
