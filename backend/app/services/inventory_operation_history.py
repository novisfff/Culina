from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta
from decimal import Decimal
from enum import Enum
from typing import Any

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.enums import (
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
    InventoryOperationType,
)
from app.core.utils import create_id, utcnow
from app.models.domain import (
    Food,
    Ingredient,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    InventoryOperationLine,
    ShoppingListItem,
)
from app.repos.inventory_operations import claim_inventory_operation
from app.schemas.inventory_operations import (
    SNAPSHOT_SCHEMA_VERSION,
    InventoryOperationDisplaySummary,
)


def _enum_value(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    return value


def _decimal_string(value: Decimal | None) -> str | None:
    if value is None:
        return None
    normalized = format(value.normalize(), "f")
    if "." in normalized:
        normalized = normalized.rstrip("0").rstrip(".")
    if normalized in {"", "-0"}:
        return "0"
    return normalized


def _date_value(value: date | datetime | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.isoformat()
        return value.isoformat()
    return value.isoformat()


def _normalize_for_hash(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _normalize_for_hash(value.model_dump(mode="python"))
    if isinstance(value, dict):
        return {str(key): _normalize_for_hash(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_for_hash(item) for item in value]
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Decimal):
        return _decimal_string(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def canonical_request_hash(payload: BaseModel) -> str:
    """SHA-256 of a stable JSON encoding of the business payload."""
    normalized = _normalize_for_hash(payload)
    canonical = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def snapshot_ingredient_collection_guard(ingredient: Ingredient) -> dict[str, object]:
    return {
        "id": ingredient.id,
        "family_id": ingredient.family_id,
        "quantity_tracking_mode": _enum_value(ingredient.quantity_tracking_mode),
        "row_version": int(ingredient.row_version),
    }


def snapshot_inventory_item(item: InventoryItem) -> dict[str, object]:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "ingredient_id": item.ingredient_id,
        "quantity": _decimal_string(item.quantity),
        "consumed_quantity": _decimal_string(item.consumed_quantity),
        "disposed_quantity": _decimal_string(item.disposed_quantity),
        "unit": item.unit,
        "entered_quantity": _decimal_string(item.entered_quantity),
        "entered_unit": item.entered_unit,
        "status": _enum_value(item.status),
        "purchase_date": _date_value(item.purchase_date),
        "expiry_date": _date_value(item.expiry_date),
        "storage_location": item.storage_location,
        "notes": item.notes,
        "low_stock_threshold": _decimal_string(item.low_stock_threshold),
        "last_confirmed_at": _date_value(item.last_confirmed_at),
        "last_confirmed_by": item.last_confirmed_by,
        "last_confirmation_source": _enum_value(item.last_confirmation_source),
        "row_version": int(item.row_version),
    }


def snapshot_inventory_state(state: IngredientInventoryState) -> dict[str, object]:
    return {
        "id": state.id,
        "family_id": state.family_id,
        "ingredient_id": state.ingredient_id,
        "availability_level": _enum_value(state.availability_level),
        "inventory_status": _enum_value(state.inventory_status),
        "purchase_date": _date_value(state.purchase_date),
        "expiry_date": _date_value(state.expiry_date),
        "storage_location": state.storage_location,
        "notes": state.notes,
        "expiry_alert_snoozed_until": _date_value(state.expiry_alert_snoozed_until),
        "expiry_reviewed_at": _date_value(state.expiry_reviewed_at),
        "expiry_reviewed_by": state.expiry_reviewed_by,
        "last_confirmed_at": _date_value(state.last_confirmed_at),
        "last_confirmed_by": state.last_confirmed_by,
        "last_confirmation_source": _enum_value(state.last_confirmation_source),
        "row_version": int(state.row_version),
    }


def snapshot_food_inventory(food: Food) -> dict[str, object]:
    return {
        "id": food.id,
        "family_id": food.family_id,
        "stock_quantity": _decimal_string(food.stock_quantity),
        "stock_unit": food.stock_unit,
        "storage_location": food.storage_location,
        "expiry_date": _date_value(food.expiry_date),
        "inventory_last_confirmed_at": _date_value(food.inventory_last_confirmed_at),
        "inventory_last_confirmed_by": food.inventory_last_confirmed_by,
        "inventory_confirmation_source": _enum_value(food.inventory_confirmation_source),
        "row_version": int(food.row_version),
    }


def snapshot_shopping_item(item: ShoppingListItem) -> dict[str, object]:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "ingredient_id": item.ingredient_id,
        "food_id": item.food_id,
        "title": item.title,
        "quantity": _decimal_string(item.quantity),
        "unit": item.unit,
        "quantity_mode": _enum_value(item.quantity_mode),
        "display_label": item.display_label,
        "reason": item.reason,
        "done": bool(item.done),
        "row_version": int(item.row_version),
    }


def start_operation(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    operation_type: InventoryOperationType,
    client_request_id: str,
    request_hash: str,
    summary: InventoryOperationDisplaySummary,
) -> InventoryOperation:
    """Create and flush an applied operation window without committing."""
    operation, _created = claim_inventory_operation(
        db,
        family_id=family_id,
        actor_id=actor_id,
        operation_type=operation_type,
        client_request_id=client_request_id,
        request_hash=request_hash,
        summary=summary,
    )
    if operation.applied_at is None:
        operation.applied_at = utcnow()
    if operation.revertible_until is None:
        operation.revertible_until = operation.applied_at + timedelta(minutes=15)
    if operation.status is None:
        operation.status = InventoryOperationStatus.APPLIED
    if not operation.summary_json:
        operation.summary_json = summary.model_dump(mode="json")
    db.flush()
    return operation


def record_operation_line(
    db: Session,
    *,
    operation: InventoryOperation,
    sequence: int,
    entity_type: InventoryOperationEntityType,
    entity_id: str,
    change_type: InventoryOperationChangeType,
    before_snapshot: dict[str, object] | None,
    after_snapshot: dict[str, object] | None,
    before_row_version: int | None,
    after_row_version: int | None,
    change_metadata: dict[str, object] | None = None,
) -> InventoryOperationLine:
    line = InventoryOperationLine(
        id=create_id("inventory-operation-line"),
        operation_id=operation.id,
        sequence=sequence,
        entity_type=entity_type,
        entity_id=entity_id,
        change_type=change_type,
        before_snapshot=before_snapshot,
        after_snapshot=after_snapshot,
        before_row_version=before_row_version,
        after_row_version=after_row_version,
        change_metadata=change_metadata,
        snapshot_schema_version=SNAPSHOT_SCHEMA_VERSION,
    )
    db.add(line)
    return line


def record_ingredient_collection_guard(
    db: Session,
    *,
    operation: InventoryOperation,
    sequence: int,
    ingredient: Ingredient,
    before_row_version: int,
    after_row_version: int,
) -> InventoryOperationLine:
    """Record exactly one parent collection-version guard for an Ingredient."""
    before_snapshot = {
        "id": ingredient.id,
        "family_id": ingredient.family_id,
        "quantity_tracking_mode": _enum_value(ingredient.quantity_tracking_mode),
        "row_version": int(before_row_version),
    }
    after_snapshot = {
        "id": ingredient.id,
        "family_id": ingredient.family_id,
        "quantity_tracking_mode": _enum_value(ingredient.quantity_tracking_mode),
        "row_version": int(after_row_version),
    }
    return record_operation_line(
        db,
        operation=operation,
        sequence=sequence,
        entity_type=InventoryOperationEntityType.INGREDIENT,
        entity_id=ingredient.id,
        change_type=InventoryOperationChangeType.UPDATE,
        before_snapshot=before_snapshot,
        after_snapshot=after_snapshot,
        before_row_version=before_row_version,
        after_row_version=after_row_version,
        change_metadata={"role": "collection_version_guard"},
    )
