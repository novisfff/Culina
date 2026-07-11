from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.deps import get_current_auth
from app.core.utils import utcnow
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.inventory_operations import (
    InventoryOperationResult,
    InventoryReconciliationOut,
    InventoryReconciliationRequest,
    ReconciliationScope,
)
from app.services.clock import today_for_family
from app.services.inventory_reconciliation import (
    ReconciliationValidationError,
    apply_inventory_reconciliation,
    build_inventory_reconciliation,
    validation_detail,
)
from app.services.inventory_versions import STALE_INVENTORY_DETAIL, InventoryConflictError, conflict_detail

router = APIRouter(tags=["inventory-reconciliation"])


def _commit_reconciliation_session(db: Session) -> None:
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


@router.get("/api/inventory/reconciliation", response_model=InventoryReconciliationOut)
def get_inventory_reconciliation(
    scope: ReconciliationScope = Query(...),
    storage_location: str | None = Query(default=None),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> InventoryReconciliationOut:
    _user, membership = auth
    if storage_location is not None:
        storage_location = storage_location.strip() or None
    if scope in {"all", "suggested"} and storage_location is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "invalid_target",
                "message": "all/suggested 范围不能指定 storage_location",
                "conflicts": [],
                "field_errors": [
                    {
                        "field": "storage_location",
                        "code": "invalid_target",
                        "message": "all/suggested 范围不能指定 storage_location",
                    }
                ],
            },
        )
    if scope in {"refrigerated", "frozen", "room_temperature"}:
        from app.schemas.inventory_operations import SCOPE_CANONICAL_STORAGE

        canonical = SCOPE_CANONICAL_STORAGE[scope]
        if storage_location is None:
            storage_location = canonical
        elif storage_location != canonical:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "code": "invalid_target",
                    "message": f"{scope} 范围的 storage_location 必须为 {canonical}",
                    "conflicts": [],
                    "field_errors": [
                        {
                            "field": "storage_location",
                            "code": "invalid_target",
                            "message": f"{scope} 范围的 storage_location 必须为 {canonical}",
                        }
                    ],
                },
            )

    return build_inventory_reconciliation(
        db,
        family_id=membership.family_id,
        scope=scope,
        storage_location=storage_location,
        business_date=today_for_family(membership.family_id),
        generated_at=utcnow(),
    )


@router.post("/api/inventory/reconciliations", response_model=InventoryOperationResult)
def create_inventory_reconciliation(
    payload: InventoryReconciliationRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> InventoryOperationResult:
    user, membership = auth
    try:
        result = apply_inventory_reconciliation(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            request=payload,
            business_date=today_for_family(membership.family_id),
        )
    except InventoryConflictError as exc:
        db.rollback()
        raise _http_conflict(exc) from exc
    except ReconciliationValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=validation_detail(exc),
        ) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    _commit_reconciliation_session(db)
    return result
