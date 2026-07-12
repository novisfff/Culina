from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import (
    ActivityAction,
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
    InventoryOperationType,
    UserRole,
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
    User,
)
from app.repos.inventory_operations import (
    claim_inventory_operation,
    get_family_operation_with_lines,
    list_family_operations,
)
from app.schemas.inventory_operations import (
    SNAPSHOT_SCHEMA_VERSION,
    InventoryOperationDetailOut,
    InventoryOperationDisplaySummary,
    InventoryOperationLineDisplayOut,
    InventoryOperationResult,
    InventoryOperationSummaryOut,
)
from app.services.activity import log_activity
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.inventory_versions import InventoryConflictError, bump_ingredient_collection
from app.services.search.jobs import enqueue_search_index_job


class InventoryOperationNotFoundError(LookupError):
    """Family-safe missing operation."""


class InventoryOperationPermissionError(PermissionError):
    """Same-family permission denial (e.g. Member reverting another member)."""


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
        return value.isoformat()
    return value.isoformat()


def _parse_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _parse_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = str(value)
    if "T" in text:
        return datetime.fromisoformat(text).date()
    return date.fromisoformat(text)


def _parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    text = str(value)
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _as_aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


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
        "expiry_alert_snoozed_until": _date_value(item.expiry_alert_snoozed_until),
        "expiry_reviewed_at": _date_value(item.expiry_reviewed_at),
        "expiry_reviewed_by": item.expiry_reviewed_by,
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


def _summary_from_operation(operation: InventoryOperation) -> InventoryOperationDisplaySummary:
    summary_data = operation.summary_json or {}
    return InventoryOperationDisplaySummary(
        title=str(summary_data.get("title") or "库存操作"),
        description=str(summary_data.get("description") or ""),
        confirmed_count=int(summary_data.get("confirmed_count") or 0),
        adjusted_count=int(summary_data.get("adjusted_count") or 0),
        completed_count=int(summary_data.get("completed_count") or 0),
        partial_count=int(summary_data.get("partial_count") or 0),
    )


def compute_can_revert(
    operation: InventoryOperation,
    *,
    user_id: str,
    user_role: UserRole,
    now: datetime,
) -> bool:
    """Whether the requesting member may currently request a whole-operation revert."""
    if operation.status != InventoryOperationStatus.APPLIED:
        return False
    deadline = _as_aware(operation.revertible_until)
    current = _as_aware(now) or now
    if deadline is None or current > deadline:
        return False
    if operation.actor_id == user_id:
        return True
    return user_role == UserRole.OWNER


def _actor_display_names(db: Session, actor_ids: set[str]) -> dict[str, str]:
    if not actor_ids:
        return {}
    users = list(db.scalars(select(User).where(User.id.in_(sorted(actor_ids)))))
    return {user.id: (user.display_name or user.username or "家庭成员") for user in users}


def _is_collection_guard(line: InventoryOperationLine) -> bool:
    metadata = line.change_metadata or {}
    return (
        line.entity_type == InventoryOperationEntityType.INGREDIENT
        and metadata.get("role") == "collection_version_guard"
    )


def _line_title(line: InventoryOperationLine, labels: dict[str, str]) -> str:
    entity_type = line.entity_type
    entity_id = line.entity_id
    if entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
        return labels.get(entity_id) or labels.get(f"item:{entity_id}") or "库存批次"
    if entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE:
        return labels.get(entity_id) or labels.get(f"state:{entity_id}") or "食材状态"
    if entity_type == InventoryOperationEntityType.FOOD:
        return labels.get(entity_id) or labels.get(f"food:{entity_id}") or "成品库存"
    if entity_type == InventoryOperationEntityType.SHOPPING_LIST_ITEM:
        return labels.get(entity_id) or labels.get(f"shopping:{entity_id}") or "采购项"
    if entity_type == InventoryOperationEntityType.INGREDIENT:
        return labels.get(entity_id) or labels.get(f"ingredient:{entity_id}") or "食材"
    return "库存变化"


def _format_qty(value: Any, unit: Any = None) -> str:
    qty = _decimal_string(_parse_decimal(value)) if value is not None else None
    unit_text = str(unit or "").strip()
    if qty is None:
        return unit_text or "—"
    if unit_text:
        return f"{qty}{unit_text}"
    return qty


def _line_description(line: InventoryOperationLine) -> str:
    change = line.change_type
    before = line.before_snapshot or {}
    after = line.after_snapshot or {}
    metadata = line.change_metadata or {}

    if line.entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
        if change == InventoryOperationChangeType.CREATE:
            return f"新增批次 {_format_qty(after.get('quantity'), after.get('unit'))}"
        if change == InventoryOperationChangeType.DELETE:
            return "删除批次"
        before_qty = _format_qty(before.get("quantity"), before.get("unit") or after.get("unit"))
        after_qty = _format_qty(after.get("quantity"), after.get("unit") or before.get("unit"))
        if before_qty != after_qty:
            return f"数量从 {before_qty} 调整为 {after_qty}"
        action = metadata.get("action")
        if action == "confirm_all" or action == "confirm_observed":
            return "确认批次仍在"
        if action == "set_absent":
            return "清零批次"
        return "更新批次信息"

    if line.entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE:
        if change == InventoryOperationChangeType.CREATE:
            level = after.get("availability_level") or "present_unknown"
            return f"记录状态为 {level}"
        if change == InventoryOperationChangeType.DELETE:
            return "删除食材状态"
        before_level = before.get("availability_level")
        after_level = after.get("availability_level")
        if before_level != after_level:
            return f"状态从 {before_level} 调整为 {after_level}"
        return "更新食材状态"

    if line.entity_type == InventoryOperationEntityType.FOOD:
        if change == InventoryOperationChangeType.CREATE:
            return f"新增成品库存 {_format_qty(after.get('stock_quantity'), after.get('stock_unit'))}"
        if change == InventoryOperationChangeType.DELETE:
            return "删除成品库存"
        before_qty = _format_qty(before.get("stock_quantity"), before.get("stock_unit") or after.get("stock_unit"))
        after_qty = _format_qty(after.get("stock_quantity"), after.get("stock_unit") or before.get("stock_unit"))
        if before_qty != after_qty:
            return f"成品库存从 {before_qty} 调整为 {after_qty}"
        action = metadata.get("action")
        if action == "confirm":
            return "确认成品库存"
        return "更新成品库存"

    if line.entity_type == InventoryOperationEntityType.SHOPPING_LIST_ITEM:
        result = metadata.get("result")
        if result == "partial":
            remaining = metadata.get("remaining_planned_quantity")
            if remaining is not None:
                return f"部分买到，剩余计划 {remaining}"
            return "部分买到"
        if result == "completed_without_inventory":
            return "仅标记完成，未入库"
        if result in {"completed", "stocked"}:
            return "采购完成并入库" if result == "stocked" else "采购完成"
        if change == InventoryOperationChangeType.UPDATE:
            if bool(before.get("done")) != bool(after.get("done")):
                return "更新采购完成状态"
            return "更新采购项"
        return "更新采购项"

    return "库存变化"


def _resolve_display_labels(
    db: Session,
    lines: list[InventoryOperationLine],
    *,
    family_id: str,
) -> dict[str, str]:
    ingredient_ids: set[str] = set()
    food_ids: set[str] = set()
    item_ids: set[str] = set()
    state_ids: set[str] = set()
    shopping_ids: set[str] = set()
    labels: dict[str, str] = {}

    for line in lines:
        if _is_collection_guard(line):
            continue
        snapshot = line.after_snapshot or line.before_snapshot or {}
        if line.entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
            item_ids.add(line.entity_id)
            ingredient_id = snapshot.get("ingredient_id")
            if isinstance(ingredient_id, str):
                ingredient_ids.add(ingredient_id)
        elif line.entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE:
            state_ids.add(line.entity_id)
            ingredient_id = snapshot.get("ingredient_id")
            if isinstance(ingredient_id, str):
                ingredient_ids.add(ingredient_id)
        elif line.entity_type == InventoryOperationEntityType.FOOD:
            food_ids.add(line.entity_id)
        elif line.entity_type == InventoryOperationEntityType.SHOPPING_LIST_ITEM:
            shopping_ids.add(line.entity_id)
            title = snapshot.get("title")
            if isinstance(title, str) and title.strip():
                labels[line.entity_id] = title.strip()
        elif line.entity_type == InventoryOperationEntityType.INGREDIENT:
            ingredient_ids.add(line.entity_id)

    if ingredient_ids:
        for ingredient in db.scalars(
            select(Ingredient).where(
                Ingredient.family_id == family_id,
                Ingredient.id.in_(sorted(ingredient_ids)),
            )
        ):
            labels[ingredient.id] = ingredient.name
            labels[f"ingredient:{ingredient.id}"] = ingredient.name
    if food_ids:
        for food in db.scalars(
            select(Food).where(
                Food.family_id == family_id,
                Food.id.in_(sorted(food_ids)),
            )
        ):
            labels[food.id] = food.name
            labels[f"food:{food.id}"] = food.name
    if item_ids:
        for item in db.scalars(
            select(InventoryItem)
            .where(
                InventoryItem.family_id == family_id,
                InventoryItem.id.in_(sorted(item_ids)),
            )
            .options(selectinload(InventoryItem.ingredient))
        ):
            name = (
                item.ingredient.name
                if item.ingredient is not None and item.ingredient.family_id == family_id
                else "库存批次"
            )
            labels[item.id] = name
            labels[f"item:{item.id}"] = name
    if state_ids:
        for state in db.scalars(
            select(IngredientInventoryState)
            .where(
                IngredientInventoryState.family_id == family_id,
                IngredientInventoryState.id.in_(sorted(state_ids)),
            )
            .options(selectinload(IngredientInventoryState.ingredient))
        ):
            name = (
                state.ingredient.name
                if state.ingredient is not None and state.ingredient.family_id == family_id
                else "食材状态"
            )
            labels[state.id] = name
            labels[f"state:{state.id}"] = name
    if shopping_ids:
        for shopping in db.scalars(
            select(ShoppingListItem).where(
                ShoppingListItem.family_id == family_id,
                ShoppingListItem.id.in_(sorted(shopping_ids)),
            )
        ):
            labels[shopping.id] = shopping.title
            labels[f"shopping:{shopping.id}"] = shopping.title
    return labels


def _display_lines(
    db: Session,
    lines: list[InventoryOperationLine],
    *,
    family_id: str,
) -> list[InventoryOperationLineDisplayOut]:
    visible = [line for line in lines if not _is_collection_guard(line)]
    labels = _resolve_display_labels(db, visible, family_id=family_id)
    ordered = sorted(visible, key=lambda item: item.sequence)
    return [
        InventoryOperationLineDisplayOut(
            sequence=line.sequence,
            entity_type=line.entity_type,
            change_type=line.change_type,
            title=_line_title(line, labels),
            description=_line_description(line),
        )
        for line in ordered
    ]


def _serialize_summary(
    operation: InventoryOperation,
    *,
    actor_display_name: str,
    user_id: str,
    user_role: UserRole,
    now: datetime,
) -> InventoryOperationSummaryOut:
    return InventoryOperationSummaryOut(
        operation_id=operation.id,
        operation_type=operation.operation_type,
        status=operation.status,
        applied_at=_as_aware(operation.applied_at) or operation.applied_at,
        revertible_until=_as_aware(operation.revertible_until) or operation.revertible_until,
        can_revert=compute_can_revert(operation, user_id=user_id, user_role=user_role, now=now),
        summary=_summary_from_operation(operation),
        actor_display_name=actor_display_name,
    )


def _serialize_result(
    operation: InventoryOperation,
    *,
    user_id: str,
    user_role: UserRole,
    now: datetime,
) -> InventoryOperationResult:
    return InventoryOperationResult(
        operation_id=operation.id,
        operation_type=operation.operation_type,
        status=operation.status,
        applied_at=_as_aware(operation.applied_at) or operation.applied_at,
        revertible_until=_as_aware(operation.revertible_until) or operation.revertible_until,
        can_revert=compute_can_revert(operation, user_id=user_id, user_role=user_role, now=now),
        summary=_summary_from_operation(operation),
    )


def list_inventory_operations(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    user_role: UserRole,
    now: datetime,
    limit: int = 20,
) -> list[InventoryOperationSummaryOut]:
    if limit < 1 or limit > 50:
        raise ValueError("limit 必须在 1 到 50 之间")
    operations = list_family_operations(db, family_id=family_id, limit=limit)
    names = _actor_display_names(db, {operation.actor_id for operation in operations})
    return [
        _serialize_summary(
            operation,
            actor_display_name=names.get(operation.actor_id, "家庭成员"),
            user_id=user_id,
            user_role=user_role,
            now=now,
        )
        for operation in operations
    ]


def get_inventory_operation_detail(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    user_role: UserRole,
    operation_id: str,
    now: datetime,
) -> InventoryOperationDetailOut:
    operation = get_family_operation_with_lines(
        db,
        family_id=family_id,
        operation_id=operation_id,
        for_update=False,
    )
    if operation is None:
        raise InventoryOperationNotFoundError("库存操作不存在")
    names = _actor_display_names(db, {operation.actor_id})
    summary = _serialize_summary(
        operation,
        actor_display_name=names.get(operation.actor_id, "家庭成员"),
        user_id=user_id,
        user_role=user_role,
        now=now,
    )
    return InventoryOperationDetailOut(
        **summary.model_dump(),
        lines=_display_lines(db, list(operation.lines), family_id=operation.family_id),
    )


def _conflict(
    code: str,
    message: str,
    *,
    conflicts: list[dict[str, object]] | None = None,
) -> InventoryConflictError:
    return InventoryConflictError(message, code=code, conflicts=conflicts or [])


def _entity_type_key(entity_type: InventoryOperationEntityType) -> str:
    return entity_type.value


def _current_version(entity: Any) -> int:
    return int(getattr(entity, "row_version"))


def _touch_entity(entity: Any, *, user_id: str) -> None:
    if hasattr(entity, "updated_by"):
        entity.updated_by = user_id
    # Force SQLAlchemy version counter advancement even if only audit fields changed.
    entity.row_version = int(entity.row_version) + 1


def _restore_inventory_item(item: InventoryItem, snapshot: dict[str, Any], *, user_id: str) -> None:
    item.quantity = _parse_decimal(snapshot.get("quantity")) or Decimal("0")
    item.consumed_quantity = _parse_decimal(snapshot.get("consumed_quantity")) or Decimal("0")
    item.disposed_quantity = _parse_decimal(snapshot.get("disposed_quantity")) or Decimal("0")
    item.unit = str(snapshot.get("unit") or item.unit)
    item.entered_quantity = _parse_decimal(snapshot.get("entered_quantity"))
    entered_unit = snapshot.get("entered_unit")
    item.entered_unit = str(entered_unit) if entered_unit is not None else None
    status = snapshot.get("status")
    if status is not None:
        item.status = status
    item.purchase_date = _parse_date(snapshot.get("purchase_date")) or item.purchase_date
    item.expiry_date = _parse_date(snapshot.get("expiry_date"))
    item.storage_location = str(snapshot.get("storage_location") or "")
    item.notes = str(snapshot.get("notes") or "")
    threshold = _parse_decimal(snapshot.get("low_stock_threshold"))
    if threshold is not None:
        item.low_stock_threshold = threshold
    if "expiry_alert_snoozed_until" in snapshot:
        item.expiry_alert_snoozed_until = _parse_date(snapshot.get("expiry_alert_snoozed_until"))
    if "expiry_reviewed_at" in snapshot:
        item.expiry_reviewed_at = _parse_datetime(snapshot.get("expiry_reviewed_at"))
    if "expiry_reviewed_by" in snapshot:
        item.expiry_reviewed_by = snapshot.get("expiry_reviewed_by")
    item.last_confirmed_at = _parse_datetime(snapshot.get("last_confirmed_at"))
    item.last_confirmed_by = snapshot.get("last_confirmed_by")
    item.last_confirmation_source = snapshot.get("last_confirmation_source")
    item.updated_by = user_id


def _restore_inventory_state(state: IngredientInventoryState, snapshot: dict[str, Any], *, user_id: str) -> None:
    availability = snapshot.get("availability_level")
    if availability is not None:
        state.availability_level = availability
    inventory_status = snapshot.get("inventory_status")
    if inventory_status is not None:
        state.inventory_status = inventory_status
    state.purchase_date = _parse_date(snapshot.get("purchase_date"))
    state.expiry_date = _parse_date(snapshot.get("expiry_date"))
    storage = snapshot.get("storage_location")
    state.storage_location = str(storage) if storage is not None else None
    state.notes = str(snapshot.get("notes") or "")
    state.expiry_alert_snoozed_until = _parse_date(snapshot.get("expiry_alert_snoozed_until"))
    state.expiry_reviewed_at = _parse_datetime(snapshot.get("expiry_reviewed_at"))
    state.expiry_reviewed_by = snapshot.get("expiry_reviewed_by")
    state.last_confirmed_at = _parse_datetime(snapshot.get("last_confirmed_at"))
    state.last_confirmed_by = snapshot.get("last_confirmed_by")
    state.last_confirmation_source = snapshot.get("last_confirmation_source")
    state.updated_by = user_id


def _restore_food(food: Food, snapshot: dict[str, Any], *, user_id: str) -> None:
    food.stock_quantity = _parse_decimal(snapshot.get("stock_quantity"))
    food.stock_unit = str(snapshot.get("stock_unit") or "")
    food.storage_location = str(snapshot.get("storage_location") or "")
    food.expiry_date = _parse_date(snapshot.get("expiry_date"))
    food.inventory_last_confirmed_at = _parse_datetime(snapshot.get("inventory_last_confirmed_at"))
    food.inventory_last_confirmed_by = snapshot.get("inventory_last_confirmed_by")
    food.inventory_confirmation_source = snapshot.get("inventory_confirmation_source")
    food.updated_by = user_id


def _restore_shopping(item: ShoppingListItem, snapshot: dict[str, Any], *, user_id: str) -> None:
    item.ingredient_id = snapshot.get("ingredient_id")
    item.food_id = snapshot.get("food_id")
    item.title = str(snapshot.get("title") or item.title)
    quantity = _parse_decimal(snapshot.get("quantity"))
    if quantity is not None:
        item.quantity = quantity
    item.unit = str(snapshot.get("unit") or item.unit)
    quantity_mode = snapshot.get("quantity_mode")
    if quantity_mode is not None:
        item.quantity_mode = quantity_mode
    display_label = snapshot.get("display_label")
    item.display_label = str(display_label) if display_label is not None else None
    item.reason = str(snapshot.get("reason") or "")
    item.done = bool(snapshot.get("done"))
    item.updated_by = user_id


def _assert_create_safe(entity: Any, after_snapshot: dict[str, Any] | None, entity_type: InventoryOperationEntityType) -> None:
    if entity is None:
        raise _conflict(
            "operation_not_revertible",
            "操作涉及的对象已不存在，无法安全撤销",
            conflicts=[{"entity_type": entity_type.value, "reason": "missing"}],
        )
    if entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
        consumed = Decimal(str(getattr(entity, "consumed_quantity", 0) or 0))
        disposed = Decimal(str(getattr(entity, "disposed_quantity", 0) or 0))
        if consumed > 0 or disposed > 0:
            raise _conflict(
                "operation_not_revertible",
                "新建批次已被消费或销毁，无法安全撤销",
                conflicts=[
                    {
                        "entity_type": entity_type.value,
                        "entity_id": getattr(entity, "id", None),
                        "reason": "consumed_or_disposed",
                    }
                ],
            )
        expected_consumed = _parse_decimal((after_snapshot or {}).get("consumed_quantity")) or Decimal("0")
        expected_disposed = _parse_decimal((after_snapshot or {}).get("disposed_quantity")) or Decimal("0")
        if consumed != expected_consumed or disposed != expected_disposed:
            raise _conflict(
                "operation_modified_after_apply",
                "操作后对象已变化，无法安全撤销",
                conflicts=[
                    {
                        "entity_type": entity_type.value,
                        "entity_id": getattr(entity, "id", None),
                        "reason": "modified",
                    }
                ],
            )


def _collect_lock_ids(lines: list[InventoryOperationLine]) -> tuple[set[str], set[str], set[str], set[str], set[str]]:
    ingredient_ids: set[str] = set()
    food_ids: set[str] = set()
    state_ingredient_ids: set[str] = set()
    inventory_item_ids: set[str] = set()
    shopping_item_ids: set[str] = set()

    for line in lines:
        snapshot = line.after_snapshot or line.before_snapshot or {}
        if line.entity_type == InventoryOperationEntityType.INGREDIENT:
            ingredient_ids.add(line.entity_id)
        elif line.entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
            inventory_item_ids.add(line.entity_id)
            ingredient_id = snapshot.get("ingredient_id")
            if isinstance(ingredient_id, str) and ingredient_id:
                ingredient_ids.add(ingredient_id)
        elif line.entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE:
            ingredient_id = snapshot.get("ingredient_id")
            if isinstance(ingredient_id, str) and ingredient_id:
                ingredient_ids.add(ingredient_id)
                state_ingredient_ids.add(ingredient_id)
        elif line.entity_type == InventoryOperationEntityType.FOOD:
            food_ids.add(line.entity_id)
        elif line.entity_type == InventoryOperationEntityType.SHOPPING_LIST_ITEM:
            shopping_item_ids.add(line.entity_id)
    return ingredient_ids, food_ids, state_ingredient_ids, inventory_item_ids, shopping_item_ids


def revert_inventory_operation(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    user_role: UserRole,
    operation_id: str,
    now: datetime,
) -> InventoryOperationResult:
    """Atomically revert one whole operation. Never commits."""
    operation = get_family_operation_with_lines(
        db,
        family_id=family_id,
        operation_id=operation_id,
        for_update=True,
    )
    if operation is None:
        raise InventoryOperationNotFoundError("库存操作不存在")

    # Idempotent replay.
    if operation.status == InventoryOperationStatus.REVERTED:
        return _serialize_result(operation, user_id=user_id, user_role=user_role, now=now)

    if operation.status != InventoryOperationStatus.APPLIED:
        raise _conflict("operation_not_revertible", "该操作当前不可撤销")

    if operation.actor_id != user_id and user_role != UserRole.OWNER:
        raise InventoryOperationPermissionError("只有操作者或家庭管理员可以撤销")

    deadline = _as_aware(operation.revertible_until)
    current = _as_aware(now) or now
    if deadline is None or current > deadline:
        raise _conflict("operation_expired", "撤销时限已过，无法撤销")

    lines = sorted(list(operation.lines), key=lambda item: item.sequence)
    if not lines:
        raise _conflict("operation_not_revertible", "该操作没有可恢复的变更")

    for line in lines:
        if int(line.snapshot_schema_version) != SNAPSHOT_SCHEMA_VERSION:
            raise _conflict("operation_not_revertible", "操作快照版本不受支持，无法撤销")

    ingredient_ids, food_ids, state_ingredient_ids, inventory_item_ids, shopping_item_ids = _collect_lock_ids(lines)

    # For create lines that may already be deleted, lock only present parents first; missing children
    # are treated as not-revertible after version checks.
    try:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=ingredient_ids,
            food_ids=food_ids,
            state_ingredient_ids=state_ingredient_ids,
            inventory_item_ids=inventory_item_ids,
            shopping_item_ids=shopping_item_ids,
        )
    except InventoryTargetNotFoundError as exc:
        # Distinguish deleted create targets from modified/missing concurrent rows.
        raise _conflict(
            "operation_not_revertible",
            "操作涉及的对象已不存在，无法安全撤销",
            conflicts=[{"reason": "missing", "message": str(exc)}],
        ) from exc

    # Validate every line against current versions / create invariants before mutating.
    for line in lines:
        entity_type = line.entity_type
        entity_id = line.entity_id
        expected_after = line.after_row_version
        entity: Any | None = None

        if entity_type == InventoryOperationEntityType.INGREDIENT:
            entity = locked.ingredients.get(entity_id)
        elif entity_type == InventoryOperationEntityType.FOOD:
            entity = locked.foods.get(entity_id)
        elif entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
            entity = locked.inventory_items.get(entity_id)
        elif entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE:
            entity = next((state for state in locked.states_by_ingredient_id.values() if state.id == entity_id), None)
        elif entity_type == InventoryOperationEntityType.SHOPPING_LIST_ITEM:
            entity = locked.shopping_items.get(entity_id)

        if line.change_type == InventoryOperationChangeType.CREATE:
            _assert_create_safe(entity, line.after_snapshot, entity_type)
            if entity is None:
                raise _conflict(
                    "operation_not_revertible",
                    "操作涉及的对象已不存在，无法安全撤销",
                    conflicts=[{"entity_type": entity_type.value, "entity_id": entity_id, "reason": "missing"}],
                )
            if expected_after is not None and _current_version(entity) != int(expected_after):
                raise _conflict(
                    "operation_modified_after_apply",
                    "操作后对象已变化，无法安全撤销",
                    conflicts=[
                        {
                            "entity_type": entity_type.value,
                            "entity_id": entity_id,
                            "expected_row_version": expected_after,
                            "current_row_version": _current_version(entity),
                        }
                    ],
                )
            continue

        if entity is None:
            raise _conflict(
                "operation_not_revertible",
                "操作涉及的对象已不存在，无法安全撤销",
                conflicts=[{"entity_type": entity_type.value, "entity_id": entity_id, "reason": "missing"}],
            )
        if expected_after is None:
            raise _conflict("operation_not_revertible", "操作缺少版本信息，无法撤销")
        if _current_version(entity) != int(expected_after):
            raise _conflict(
                "operation_modified_after_apply",
                "操作后对象已变化，无法安全撤销",
                conflicts=[
                    {
                        "entity_type": entity_type.value,
                        "entity_id": entity_id,
                        "expected_row_version": expected_after,
                        "current_row_version": _current_version(entity),
                    }
                ],
            )

    # Apply restores in reverse sequence so dependent creates are removed after parent checks.
    food_ids_to_reindex: set[str] = set()
    for line in reversed(lines):
        entity_type = line.entity_type
        entity_id = line.entity_id

        if entity_type == InventoryOperationEntityType.INGREDIENT:
            ingredient = locked.ingredients[entity_id]
            # Guard lines validate and bump only; never restore Ingredient profile fields.
            bump_ingredient_collection(ingredient, user_id=user_id)
            continue

        if entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
            item = locked.inventory_items.get(entity_id)
            if line.change_type == InventoryOperationChangeType.CREATE:
                if item is not None:
                    db.delete(item)
                    locked.inventory_items.pop(entity_id, None)
                continue
            assert item is not None
            if line.before_snapshot is None:
                raise _conflict("operation_not_revertible", "缺少恢复快照，无法撤销")
            _restore_inventory_item(item, line.before_snapshot, user_id=user_id)
            continue

        if entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE:
            state = next((value for value in locked.states_by_ingredient_id.values() if value.id == entity_id), None)
            if line.change_type == InventoryOperationChangeType.CREATE:
                if state is not None:
                    db.delete(state)
                    locked.states_by_ingredient_id.pop(state.ingredient_id, None)
                continue
            assert state is not None
            if line.before_snapshot is None:
                raise _conflict("operation_not_revertible", "缺少恢复快照，无法撤销")
            _restore_inventory_state(state, line.before_snapshot, user_id=user_id)
            continue

        if entity_type == InventoryOperationEntityType.FOOD:
            food = locked.foods.get(entity_id)
            if line.change_type == InventoryOperationChangeType.CREATE:
                if food is not None:
                    db.delete(food)
                    locked.foods.pop(entity_id, None)
                continue
            assert food is not None
            if line.before_snapshot is None:
                raise _conflict("operation_not_revertible", "缺少恢复快照，无法撤销")
            _restore_food(food, line.before_snapshot, user_id=user_id)
            food_ids_to_reindex.add(food.id)
            continue

        if entity_type == InventoryOperationEntityType.SHOPPING_LIST_ITEM:
            shopping = locked.shopping_items.get(entity_id)
            if line.change_type == InventoryOperationChangeType.CREATE:
                if shopping is not None:
                    db.delete(shopping)
                    locked.shopping_items.pop(entity_id, None)
                continue
            assert shopping is not None
            if line.before_snapshot is None:
                raise _conflict("operation_not_revertible", "缺少恢复快照，无法撤销")
            _restore_shopping(shopping, line.before_snapshot, user_id=user_id)
            continue

    operation.status = InventoryOperationStatus.REVERTED
    operation.reverted_at = current
    operation.reverted_by = user_id

    summary = _summary_from_operation(operation)
    if operation.operation_type == InventoryOperationType.SHOPPING_INTAKE:
        activity_summary = f"撤销了刚才的采购入库：{summary.description}" if summary.description else "撤销了刚才的采购入库"
    elif operation.operation_type == InventoryOperationType.RECONCILIATION:
        activity_summary = f"撤销了刚才的库存盘点：{summary.description}" if summary.description else "撤销了刚才的库存盘点"
    else:
        activity_summary = "撤销了刚才的库存操作"

    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.REVERT,
        entity_type="InventoryOperation",
        entity_id=operation.id,
        summary=activity_summary,
    )
    for food_id in sorted(food_ids_to_reindex):
        food = locked.foods.get(food_id)
        if food is not None:
            enqueue_search_index_job(
                db,
                family_id=family_id,
                user_id=user_id,
                entity_type="food",
                entity_id=food.id,
                target_name=food.name,
            )
    db.flush()
    return _serialize_result(operation, user_id=user_id, user_role=user_role, now=now)
