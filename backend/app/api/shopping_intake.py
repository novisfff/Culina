from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.inventory_operations import ShoppingIntakeRequest, ShoppingIntakeResult
from app.services.clock import today_for_family
from app.services.inventory_versions import STALE_INVENTORY_DETAIL, InventoryConflictError, conflict_detail
from app.services.shopping_intake import (
    ShoppingIntakeValidationError,
    apply_shopping_intake,
    validation_detail,
)

router = APIRouter(tags=["shopping-intake"])


def _commit_intake_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


@router.post("/api/shopping-list/intakes", response_model=ShoppingIntakeResult)
def create_shopping_intake(
    payload: ShoppingIntakeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> ShoppingIntakeResult:
    user, membership = auth
    try:
        result = apply_shopping_intake(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            request=payload,
            business_date=today_for_family(membership.family_id),
        )
    except InventoryConflictError as exc:
        db.rollback()
        detail = conflict_detail(exc)
        if isinstance(detail, str):
            detail = {
                "code": exc.code,
                "message": detail,
                "conflicts": list(exc.conflicts or []),
                "field_errors": [],
            }
        else:
            detail = {
                "code": detail.get("code", exc.code),
                "message": detail.get("message", exc.message),
                "conflicts": detail.get("conflicts", list(exc.conflicts or [])),
                "field_errors": detail.get("field_errors", []),
            }
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc
    except ShoppingIntakeValidationError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=validation_detail(exc),
        ) from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    _commit_intake_session(db)
    return result
