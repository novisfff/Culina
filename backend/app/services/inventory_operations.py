from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from collections.abc import Callable
from typing import Any, Literal, cast

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import (
    ActivityAction,
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
    InventoryOperationType,
    InventoryStatus,
)
from app.core.utils import create_id
from app.models.domain import Ingredient, InventoryItem, InventoryOperation
from app.repos.inventory_operations import claim_inventory_operation
from app.schemas.inventory_operations import InventoryOperationDisplaySummary
from app.services.activity import log_activity
from app.services.ingredient_units import (
    UnitConversionError,
    convert_quantity_from_default_unit,
    convert_quantity_to_default_unit,
    normalize_unit_label,
)
from app.services.inventory_operation_locking import LockedInventoryTargets, lock_inventory_targets
from app.services.inventory_operation_history import (
    canonical_request_hash,
    record_ingredient_collection_guard,
    record_operation_line,
    snapshot_inventory_item,
)
from app.services.ingredient_inventory_state import PresenceStateRequiredError
from app.services.inventory_usage import (
    build_ingredient_consumption_plan,
    inventory_remaining_in_default,
    remaining_quantity,
    tracks_quantity,
)
from app.services.inventory_versions import bump_ingredient_collection, require_expected_version


def require_ingredient(
    db: Session,
    *,
    family_id: str,
    ingredient_id: str,
    for_update: bool = False,
) -> Ingredient:
    statement = select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id == ingredient_id)
    if for_update:
        statement = statement.with_for_update()
    ingredient = db.scalar(statement)
    if ingredient is None:
        raise ValueError("食材不存在或不属于当前家庭")
    return ingredient


def require_inventory_item(
    db: Session,
    *,
    family_id: str,
    inventory_item_id: str,
    for_update: bool = False,
) -> InventoryItem:
    statement = (
        select(InventoryItem)
        .where(InventoryItem.family_id == family_id, InventoryItem.id == inventory_item_id)
        .options(selectinload(InventoryItem.ingredient))
    )
    if for_update:
        statement = statement.with_for_update()
    item = db.scalar(statement)
    if item is None:
        raise ValueError("库存批次不存在或不属于当前家庭")
    return item


def _lock_parent_ingredient(
    db: Session,
    *,
    family_id: str,
    ingredient: Ingredient,
) -> Ingredient:
    locked = lock_inventory_targets(
        db,
        family_id=family_id,
        ingredient_ids=[ingredient.id],
    ).ingredients.get(ingredient.id)
    if locked is None:
        raise ValueError("食材不存在或不属于当前家庭")
    return locked


def create_inventory_batch(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    ingredient: Ingredient,
    quantity: Decimal | None,
    unit: str | None,
    status: InventoryStatus,
    purchase_date: date,
    expiry_date: date | None,
    storage_location: str,
    notes: str = "",
    low_stock_threshold: Decimal | None = None,
    record_activity: bool = True,
    already_locked: bool = False,
) -> InventoryItem:
    if not already_locked:
        ingredient = _lock_parent_ingredient(db, family_id=family_id, ingredient=ingredient)
    if not tracks_quantity(ingredient):
        raise PresenceStateRequiredError()
    if quantity is None:
        raise ValueError("库存数量不能为空")
    normalized_unit = normalize_unit_label(unit or "")
    if not normalized_unit:
        raise ValueError("单位不能为空")
    try:
        normalized_quantity = convert_quantity_to_default_unit(
            quantity,
            ingredient.default_unit,
            ingredient.unit_conversions,
            normalized_unit,
        )
    except UnitConversionError as exc:
        raise ValueError(str(exc)) from exc

    threshold = low_stock_threshold
    if ingredient.default_low_stock_threshold is not None:
        threshold = ingredient.default_low_stock_threshold
    elif threshold:
        try:
            threshold = convert_quantity_to_default_unit(
                threshold,
                ingredient.default_unit,
                ingredient.unit_conversions,
                normalized_unit,
            )
        except UnitConversionError as exc:
            raise ValueError(str(exc)) from exc
    entered_quantity = quantity

    item = InventoryItem(
        id=create_id("inventory"),
        family_id=family_id,
        ingredient_id=ingredient.id,
        quantity=normalized_quantity,
        consumed_quantity=Decimal("0"),
        disposed_quantity=Decimal("0"),
        unit=ingredient.default_unit,
        entered_quantity=entered_quantity,
        entered_unit=normalized_unit,
        status=status,
        purchase_date=purchase_date,
        expiry_date=expiry_date,
        storage_location=storage_location,
        notes=notes,
        low_stock_threshold=threshold or Decimal("0"),
        created_by=user_id,
        updated_by=user_id,
    )
    item.ingredient = ingredient
    db.add(item)
    bump_ingredient_collection(ingredient, user_id=user_id)
    db.flush()
    if record_activity:
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="InventoryItem",
            entity_id=item.id,
            summary=f"录入库存 {ingredient.name} {float(quantity or 0):g}{normalized_unit}",
        )
    return item


def consume_ingredient_inventory(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    ingredient: Ingredient,
    quantity: Decimal | None,
    unit: str | None,
    today: date,
    inventory_item_id: str | None = None,
) -> dict:
    ingredient = _lock_parent_ingredient(db, family_id=family_id, ingredient=ingredient)
    if not tracks_quantity(ingredient):
        raise PresenceStateRequiredError()

    if quantity is None:
        raise ValueError("消费数量不能为空")
    normalized_unit = normalize_unit_label(unit or "")
    if not normalized_unit:
        raise ValueError("单位不能为空")
    items = list(
        db.scalars(
            select(InventoryItem)
            .where(
                InventoryItem.family_id == family_id,
                InventoryItem.ingredient_id == ingredient.id,
            )
            .order_by(InventoryItem.id.asc())
            .with_for_update()
        )
    )
    if inventory_item_id:
        items = [item for item in items if item.id == inventory_item_id]
        if not items:
            raise ValueError("指定库存批次不存在或不属于该食材")
    try:
        requested_in_default, available_total, deductions = build_ingredient_consumption_plan(
            ingredient=ingredient,
            items=items,
            requested_quantity=quantity,
            unit=normalized_unit,
            today=today,
        )
    except UnitConversionError as exc:
        raise ValueError(str(exc)) from exc
    if available_total < requested_in_default:
        try:
            available_in_requested = convert_quantity_from_default_unit(
                available_total,
                ingredient.default_unit,
                ingredient.unit_conversions,
                normalized_unit,
            )
        except UnitConversionError:
            available_in_requested = available_total
        raise ValueError(f"当前最多只能消费 {float(available_in_requested):g}{normalized_unit}")
    affected_ids: list[str] = []
    for deduction in deductions:
        deduction.item.consumed_quantity += deduction.quantity
        deduction.item.updated_by = user_id
        affected_ids.append(deduction.item.id)
    if affected_ids:
        bump_ingredient_collection(ingredient, user_id=user_id)
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"消费食材 {ingredient.name} {float(quantity):g}{normalized_unit}",
    )
    return {
        "operation": "consume",
        "ingredient_id": ingredient.id,
        "ingredient_name": ingredient.name,
        "unit": normalized_unit,
        "quantity": float(quantity),
        "affected_item_ids": affected_ids,
        "affected_items": [
            {
                "inventory_item_id": deduction.item.id,
                "remaining_quantity": float(remaining_quantity(deduction.item)),
                "unit": deduction.item.unit,
            }
            for deduction in deductions
        ],
    }


def dispose_inventory_quantity(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    item: InventoryItem,
    quantity: Decimal | None,
    unit: str | None,
    reason: str,
    record_activity: bool = True,
    expected_row_version: int | None = None,
    already_locked: bool = False,
    bump_parent: bool = True,
) -> dict:
    """Dispose quantity from a batch with parent-first locking.

    Callers must not hold an InventoryItem row lock before this entrypoint unless
    they already locked Ingredient first (set already_locked=True).
    """
    reason = reason.strip()
    if not reason:
        raise ValueError("请填写销毁原因")

    if already_locked:
        ingredient = item.ingredient
        if ingredient is None or ingredient.id != item.ingredient_id:
            ingredient = require_ingredient(
                db,
                family_id=family_id,
                ingredient_id=item.ingredient_id,
            )
            item.ingredient = ingredient
    else:
        # Discover ingredient_id without locking child first, then lock parent→child.
        provisional = item
        if provisional.ingredient_id is None:
            provisional = require_inventory_item(
                db,
                family_id=family_id,
                inventory_item_id=item.id,
                for_update=False,
            )
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=[provisional.ingredient_id],
            inventory_item_ids=[item.id],
        )
        ingredient = locked.ingredients.get(provisional.ingredient_id)
        locked_item = locked.inventory_items.get(item.id)
        if ingredient is None or locked_item is None:
            raise ValueError("库存批次不存在或不属于当前家庭")
        item = locked_item
        item.ingredient = ingredient

    if expected_row_version is not None:
        require_expected_version(
            item,
            expected_row_version,
            entity_type="inventory_item",
            entity_id=item.id,
        )

    if not tracks_quantity(ingredient):
        raise PresenceStateRequiredError()
    available_in_default = inventory_remaining_in_default(item, ingredient)
    if available_in_default <= 0:
        raise ValueError("库存批次已无剩余数量")
    requested_unit = normalize_unit_label(unit or item.unit)
    if not requested_unit:
        raise ValueError("单位不能为空")
    if quantity is None:
        requested_in_default = available_in_default
        requested_quantity = convert_quantity_from_default_unit(
            available_in_default,
            ingredient.default_unit,
            ingredient.unit_conversions,
            requested_unit,
        )
    else:
        requested_quantity = quantity
        try:
            requested_in_default = convert_quantity_to_default_unit(
                requested_quantity,
                ingredient.default_unit,
                ingredient.unit_conversions,
                requested_unit,
            )
        except UnitConversionError as exc:
            raise ValueError(str(exc)) from exc
    if requested_in_default > available_in_default:
        available_in_requested = convert_quantity_from_default_unit(
            available_in_default,
            ingredient.default_unit,
            ingredient.unit_conversions,
            requested_unit,
        )
        raise ValueError(f"当前最多只能销毁 {float(available_in_requested):g}{requested_unit}")
    disposed_in_item_unit = convert_quantity_from_default_unit(
        requested_in_default,
        ingredient.default_unit,
        ingredient.unit_conversions,
        item.unit,
    )
    item.disposed_quantity += disposed_in_item_unit
    item.updated_by = user_id
    if bump_parent:
        bump_ingredient_collection(ingredient, user_id=user_id)
    remaining = remaining_quantity(item)
    if record_activity:
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="InventoryItem",
            entity_id=item.id,
            summary=f"销毁库存 {ingredient.name} {float(requested_quantity):g}{requested_unit}：{reason}",
        )
    return {
        "operation": "dispose",
        "ingredient_id": ingredient.id,
        "ingredient_name": ingredient.name,
        "inventory_item_id": item.id,
        "unit": requested_unit,
        "quantity": float(requested_quantity),
        "reason": reason,
        "remaining_quantity": float(remaining),
    }


def hash_inventory_quantity_request(
    *,
    operation_type: Literal["consume", "dispose"],
    ingredient_id: str,
    inventory_item_id: str | None,
    quantity: Decimal | None,
    unit: str | None,
    reason: str = "",
) -> str:
    return canonical_request_hash(
        {
            "operation_type": operation_type,
            "ingredient_id": ingredient_id,
            "inventory_item_id": inventory_item_id,
            "quantity": quantity,
            "unit": normalize_unit_label(unit or "") or None,
            "reason": reason.strip(),
        }
    )


def build_quantity_operation_summary(
    operation_type: Literal["consume", "dispose"],
    quantity: Decimal | None,
    unit: str | None,
) -> InventoryOperationDisplaySummary:
    label = "消耗" if operation_type == "consume" else "销毁"
    amount = "全部" if quantity is None else f"{float(quantity):g}{normalize_unit_label(unit or '')}"
    return InventoryOperationDisplaySummary(
        title=f"{label}库存",
        description=f"{label} {amount}",
        adjusted_count=1,
    )


def _quantity_batch_request_hash(operations: list[dict[str, Any]]) -> str:
    normalized: list[dict[str, Any]] = []
    for operation in operations:
        normalized.append(
            {
                "operation_type": str(operation["operation_type"]),
                "ingredient_id": str(operation["ingredient_id"]),
                "inventory_item_id": operation.get("inventory_item_id"),
                "quantity": operation.get("quantity"),
                "unit": normalize_unit_label(str(operation.get("unit") or "")) or None,
                "reason": str(operation.get("reason") or "").strip(),
            }
        )
    return canonical_request_hash({"operations": normalized})


def apply_inventory_quantity_operations(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    operations: list[dict[str, Any]],
    client_request_id: str,
    now: datetime,
    revertible_until: datetime | None = None,
    lock_and_validate: Callable[[], LockedInventoryTargets] | None = None,
) -> InventoryOperation:
    """Apply one homogeneous consume/dispose batch and record one snapshot ledger."""
    if not operations:
        raise ValueError("库存数量操作不能为空")
    action_values = {str(item.get("operation_type") or "") for item in operations}
    if len(action_values) != 1 or not action_values <= {"consume", "dispose"}:
        raise ValueError("一笔库存快照账本只能包含同一种数量操作")
    action = cast(Literal["consume", "dispose"], next(iter(action_values)))
    operation_type = InventoryOperationType(action)
    if len(operations) == 1:
        only = operations[0]
        quantity = only.get("quantity")
        parsed_summary_quantity = (
            quantity if isinstance(quantity, Decimal) or quantity is None else Decimal(str(quantity))
        )
        summary = build_quantity_operation_summary(
            action,
            parsed_summary_quantity,
            str(only.get("unit") or "") or None,
        )
        request_hash = hash_inventory_quantity_request(
            operation_type=action,
            ingredient_id=str(only["ingredient_id"]),
            inventory_item_id=(
                str(only["inventory_item_id"]) if only.get("inventory_item_id") else None
            ),
            quantity=parsed_summary_quantity,
            unit=str(only.get("unit") or "") or None,
            reason=str(only.get("reason") or ""),
        )
    else:
        summary = InventoryOperationDisplaySummary(
            title="消耗库存" if action == "consume" else "销毁库存",
            description=f"处理 {len(operations)} 项",
            adjusted_count=len(operations),
        )
        request_hash = _quantity_batch_request_hash(operations)
    ledger, created = claim_inventory_operation(
        db,
        family_id=family_id,
        actor_id=actor_user_id,
        operation_type=operation_type,
        client_request_id=client_request_id,
        request_hash=request_hash,
        summary=summary,
        applied_at=now,
        revertible_until=revertible_until,
    )
    if not created:
        return ledger

    ingredient_ids = sorted({str(item["ingredient_id"]) for item in operations})
    inventory_item_ids = sorted(
        {str(item["inventory_item_id"]) for item in operations if item.get("inventory_item_id")}
    )
    locked = None
    if lock_and_validate is not None:
        locked = lock_and_validate()
    if locked is None:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=ingredient_ids,
            inventory_item_ids=inventory_item_ids,
        )

    # Consume without an explicit batch may span several rows. Lock and snapshot
    # every current child under the already locked parents, then persist only rows
    # whose snapshot actually changed.
    all_items = list(
        db.scalars(
            select(InventoryItem)
            .where(
                InventoryItem.family_id == family_id,
                InventoryItem.ingredient_id.in_(ingredient_ids),
            )
            .order_by(InventoryItem.id.asc())
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    for item in all_items:
        locked.inventory_items[item.id] = item

    ingredient_before_versions = {
        ingredient_id: int(locked.ingredients[ingredient_id].row_version)
        for ingredient_id in ingredient_ids
    }
    item_before = {item.id: snapshot_inventory_item(item) for item in all_items}
    results: list[dict[str, Any]] = []
    for item in operations:
        ingredient = locked.ingredients[str(item["ingredient_id"])]
        quantity = item.get("quantity")
        parsed_quantity = (
            quantity
            if isinstance(quantity, Decimal) or quantity is None
            else Decimal(str(quantity))
        )
        if action == "consume":
            result = consume_ingredient_inventory(
                db,
                family_id=family_id,
                user_id=actor_user_id,
                ingredient=ingredient,
                quantity=parsed_quantity,
                unit=str(item.get("unit") or ingredient.default_unit),
                today=item.get("today") or now.date(),
                inventory_item_id=item.get("inventory_item_id"),
            )
        else:
            inventory_item_id = str(item.get("inventory_item_id") or "")
            inventory_item = locked.inventory_items.get(inventory_item_id)
            if inventory_item is None or inventory_item.ingredient_id != ingredient.id:
                raise ValueError("库存批次不存在或不属于当前家庭")
            inventory_item.ingredient = ingredient
            result = dispose_inventory_quantity(
                db,
                family_id=family_id,
                user_id=actor_user_id,
                item=inventory_item,
                quantity=parsed_quantity,
                unit=str(item.get("unit") or inventory_item.unit),
                reason=str(item.get("reason") or "库存处理"),
                already_locked=True,
            )
        results.append(result)

    db.flush()
    sequence = 1
    changed_ingredient_ids: set[str] = set()
    for item in sorted(all_items, key=lambda value: value.id):
        before = item_before[item.id]
        after = snapshot_inventory_item(item)
        if before == after:
            continue
        changed_ingredient_ids.add(item.ingredient_id)
        record_operation_line(
            db,
            operation=ledger,
            sequence=sequence,
            entity_type=InventoryOperationEntityType.INVENTORY_ITEM,
            entity_id=item.id,
            change_type=InventoryOperationChangeType.UPDATE,
            before_snapshot=before,
            after_snapshot=after,
            before_row_version=int(before["row_version"]),
            after_row_version=int(after["row_version"]),
        )
        sequence += 1
    for ingredient_id in sorted(changed_ingredient_ids):
        ingredient = locked.ingredients[ingredient_id]
        record_ingredient_collection_guard(
            db,
            operation=ledger,
            sequence=sequence,
            ingredient=ingredient,
            before_row_version=ingredient_before_versions[ingredient_id],
            after_row_version=int(ingredient.row_version),
        )
        sequence += 1

    ledger.status = InventoryOperationStatus.APPLIED
    ledger.summary_json = {
        **summary.model_dump(mode="json"),
        "result_payload": {"operations": results},
    }
    db.flush()
    return ledger


def apply_inventory_quantity_operation(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    operation_type: Literal["consume", "dispose"],
    ingredient_id: str,
    inventory_item_id: str | None,
    quantity: Decimal | None,
    unit: str | None,
    client_request_id: str,
    now: datetime,
    revertible_until: datetime | None = None,
    reason: str = "",
) -> InventoryOperation:
    return apply_inventory_quantity_operations(
        db,
        family_id=family_id,
        actor_user_id=actor_user_id,
        operations=[
            {
                "operation_type": operation_type,
                "ingredient_id": ingredient_id,
                "inventory_item_id": inventory_item_id,
                "quantity": quantity,
                "unit": unit,
                "reason": reason,
            }
        ],
        client_request_id=client_request_id,
        now=now,
        revertible_until=revertible_until,
    )
