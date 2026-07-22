from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.exc import StaleDataError

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.db.transactions import commit_session
from app.schemas.inventory_intake import (
    inventory_result_to_shopping_result,
    shopping_request_to_inventory_request,
)
from app.schemas.inventory_operations import ShoppingIntakeRequest, ShoppingIntakeResult
from app.services.clock import today_for_family
from app.services.inventory_intake import (
    InventoryIntakeValidationError,
    apply_inventory_intake,
    validation_detail,
)
from app.services.inventory_versions import STALE_INVENTORY_DETAIL, InventoryConflictError, conflict_detail

router = APIRouter(tags=["shopping-intake"])

SHOPPING_INTAKE_SUBMIT_PATH = "/api/shopping-list/intakes"

_SHOPPING_INTAKE_ROOT_ERROR_FIELDS = {
    "更新库存状态时必须同时提供 state_id 与 expected_state_row_version": "state_id",
    "采购入库不能将食材标记为没有": "resulting_availability_level",
    "请求中包含重复的采购项": "items",
}
_SHOPPING_INTAKE_ITEM_VARIANTS = {
    "exact_ingredient",
    "presence_ingredient",
    "food",
    "none",
}


def _shopping_intake_validation_message(error: dict[str, Any]) -> str:
    message = str(error.get("msg") or "请求参数无效")
    return message.removeprefix("Value error, ")


def _shopping_intake_validation_field(*, error: dict[str, Any], message: str) -> str:
    location = [str(part) for part in error.get("loc", ()) if str(part) != "body"]
    try:
        item_offset = location.index("items")
    except ValueError:
        return ".".join(location) or "body"

    item_path = location[item_offset : item_offset + 2]
    if len(item_path) != 2:
        return ".".join(location) or "items"

    root_field = _SHOPPING_INTAKE_ROOT_ERROR_FIELDS.get(message)
    if root_field is not None:
        if root_field == "items":
            return "items"
        return f"items.{item_path[1]}.{root_field}"

    suffix = [part for part in location[item_offset + 2 :] if part not in _SHOPPING_INTAKE_ITEM_VARIANTS]
    if suffix:
        return ".".join([*item_path, *suffix])
    return ".".join(item_path)


def shopping_intake_request_validation_detail(errors: list[dict[str, Any]]) -> dict[str, Any]:
    """Normalize this endpoint's pre-route Pydantic errors to its public 422 contract."""
    field_errors = []
    for error in errors:
        message = _shopping_intake_validation_message(error)
        field_errors.append(
            {
                "field": _shopping_intake_validation_field(error=error, message=message),
                "code": "invalid_request",
                "message": message,
            }
        )
    message = field_errors[0]["message"] if field_errors else "请求参数无效"
    return {
        "code": "invalid_request",
        "message": message,
        "conflicts": [],
        "field_errors": field_errors,
    }


def _commit_intake_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


@router.post(SHOPPING_INTAKE_SUBMIT_PATH, response_model=ShoppingIntakeResult)
def create_shopping_intake(
    payload: ShoppingIntakeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> ShoppingIntakeResult:
    user, membership = auth
    try:
        inventory_request = shopping_request_to_inventory_request(payload)
        inventory_result = apply_inventory_intake(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            user_role=membership.role,
            request=inventory_request,
            business_date=today_for_family(membership.family_id),
        )
        result = inventory_result_to_shopping_result(inventory_result)
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
    except InventoryIntakeValidationError as exc:
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
