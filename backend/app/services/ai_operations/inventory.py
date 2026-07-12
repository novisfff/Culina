from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.exc import StaleDataError

from app.ai.errors import AIConflictError
from app.core.enums import InventoryAvailabilityLevel, InventoryConfirmationSource, InventoryStatus
from app.core.utils import utcnow
from app.ai.tools.catalog.common import entity_media_map
from app.models.domain import AIMessage, IngredientInventoryState, InventoryItem
from app.ai.tools.catalog.inventory import inventory_record, inventory_state_record
from app.services.clock import today_for_family
from app.services.ingredient_inventory_state import PresenceStateRequiredError, upsert_inventory_state
from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
from app.services.inventory_operation_locking import (
    InventoryTargetNotFoundError,
    LockedInventoryTargets,
    lock_inventory_targets,
)
from app.services.inventory_operations import consume_ingredient_inventory, create_inventory_batch, dispose_inventory_quantity
from app.services.inventory_usage import tracks_quantity
from app.services.inventory_versions import InventoryConflictError, require_expected_version
from app.services.serializers import serialize_ingredient_inventory_state, serialize_inventory_item


MISSING_INVENTORY_BOUNDARY_DETAIL = "库存草稿缺少并发校验信息，请重新生成后确认"


def _required_row_version(operation: dict[str, Any], key: str) -> int:
    if key not in operation or isinstance(operation.get(key), bool):
        raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
    try:
        value = int(operation[key])
    except (TypeError, ValueError) as exc:
        raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL) from exc
    if value < 1:
        raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
    return value


def _optional_row_version(operation: dict[str, Any], key: str) -> int | None:
    if key not in operation:
        raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
    if operation[key] is None:
        return None
    return _required_row_version(operation, key)


def _lock_and_validate_inventory_boundaries(
    db: Session,
    *,
    family_id: str,
    operations: Any,
) -> LockedInventoryTargets:
    if not isinstance(operations, list) or not operations:
        raise ValueError("库存操作草稿不能为空")

    ingredient_ids: list[str] = []
    state_ingredient_ids: list[str] = []
    optional_state_ingredient_ids: list[str] = []
    inventory_item_ids: list[str] = []
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("库存操作项格式不正确")
        ingredient_id = str(operation.get("ingredientId") or "")
        if not ingredient_id:
            raise ValueError("库存操作必须引用真实食材")
        ingredient_ids.append(ingredient_id)
        if "quantityTrackingMode" not in operation:
            raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
        _required_row_version(operation, "expectedIngredientRowVersion")
        state_id = operation.get("stateId")
        expected_state_version = _optional_row_version(operation, "expectedStateRowVersion")
        if state_id is not None:
            if not str(state_id):
                raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
            if expected_state_version is None:
                raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
            state_ingredient_ids.append(ingredient_id)
        elif expected_state_version is not None:
            raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
        elif str(operation["quantityTrackingMode"]) == "not_track_quantity":
            optional_state_ingredient_ids.append(ingredient_id)

        explicit_item_id = operation.get("inventoryItemId")
        expected_item_version = _optional_row_version(operation, "expectedInventoryItemRowVersion")
        if expected_item_version is not None and not explicit_item_id:
            raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
        if explicit_item_id:
            inventory_item_ids.append(str(explicit_item_id))

        batch_options = operation.get("batchOptions")
        if not isinstance(batch_options, list):
            raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
        for option in batch_options:
            if not isinstance(option, dict) or not option.get("id"):
                raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)
            _required_row_version(option, "rowVersion")
            inventory_item_ids.append(str(option["id"]))

    try:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=ingredient_ids,
            state_ingredient_ids=state_ingredient_ids,
            optional_state_ingredient_ids=optional_state_ingredient_ids,
            inventory_item_ids=inventory_item_ids,
        )
    except InventoryTargetNotFoundError as exc:
        raise AIConflictError(STALE_INVENTORY_DETAIL) from exc

    for operation in operations:
        ingredient_id = str(operation["ingredientId"])
        ingredient = locked.ingredients.get(ingredient_id)
        if ingredient is None:
            raise AIConflictError(STALE_INVENTORY_DETAIL)
        require_expected_version(
            ingredient,
            _required_row_version(operation, "expectedIngredientRowVersion"),
            entity_type="ingredient",
            entity_id=ingredient.id,
        )
        actual_tracking_mode = (
            ingredient.quantity_tracking_mode.value
            if hasattr(ingredient.quantity_tracking_mode, "value")
            else str(ingredient.quantity_tracking_mode)
        )
        if str(operation["quantityTrackingMode"]) != actual_tracking_mode:
            raise AIConflictError("食材数量记录方式已变化，请重新生成库存草稿")
        action = str(operation.get("action") or "")
        if action not in {"restock", "consume", "dispose"}:
            raise ValueError("不支持的库存操作")
        if action == "restock" and not tracks_quantity(ingredient):
            if "availabilityLevel" not in operation or operation.get("availabilityLevel") not in {
                "present_unknown",
                "low",
                "sufficient",
            }:
                raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)

        state_id = operation.get("stateId")
        expected_state_version = _optional_row_version(operation, "expectedStateRowVersion")
        locked_state = locked.states_by_ingredient_id.get(ingredient.id)
        if state_id is not None:
            if locked_state is None or locked_state.id != str(state_id):
                raise AIConflictError(STALE_INVENTORY_DETAIL)
            assert expected_state_version is not None
            require_expected_version(
                locked_state,
                expected_state_version,
                entity_type="ingredient_inventory_state",
                entity_id=locked_state.id,
            )
        elif locked_state is not None:
            raise AIConflictError(STALE_INVENTORY_DETAIL)

        explicit_item_id = operation.get("inventoryItemId")
        expected_item_version = _optional_row_version(operation, "expectedInventoryItemRowVersion")
        if explicit_item_id:
            explicit_item = locked.inventory_items.get(str(explicit_item_id))
            if explicit_item is None or explicit_item.ingredient_id != ingredient.id:
                raise AIConflictError(STALE_INVENTORY_DETAIL)
            if expected_item_version is not None:
                require_expected_version(
                    explicit_item,
                    expected_item_version,
                    entity_type="inventory_item",
                    entity_id=explicit_item.id,
                )
        elif expected_item_version is not None:
            raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)

        batch_options = operation["batchOptions"]
        batch_ids: set[str] = set()
        for option in batch_options:
            option_id = str(option["id"])
            batch_ids.add(option_id)
            item = locked.inventory_items.get(option_id)
            if item is None or item.ingredient_id != ingredient.id:
                raise AIConflictError(STALE_INVENTORY_DETAIL)
            require_expected_version(
                item,
                _required_row_version(option, "rowVersion"),
                entity_type="inventory_item",
                entity_id=item.id,
            )

        if action == "consume" and explicit_item_id and str(explicit_item_id) not in batch_ids:
            raise ValueError("消耗库存指定的批次不在原草稿候选范围内")
        if action == "dispose":
            if not explicit_item_id or expected_item_version is None or str(explicit_item_id) not in batch_ids:
                raise AIConflictError(MISSING_INVENTORY_BOUNDARY_DETAIL)

    return locked


def execute_inventory_operation_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    results: list[dict[str, Any]] = []
    entity_ids: list[str] = []
    today = today_for_family(family_id)
    try:
        operations = payload.get("operations")
        locked = _lock_and_validate_inventory_boundaries(
            db,
            family_id=family_id,
            operations=operations,
        )
        runtime_states_by_ingredient_id = dict(locked.states_by_ingredient_id)
        for operation in operations:
            action = str(operation["action"])
            ingredient = locked.ingredients[str(operation["ingredientId"])]
            if action == "restock":
                if not tracks_quantity(ingredient):
                    runtime_state = runtime_states_by_ingredient_id.get(ingredient.id)
                    availability_level = str(operation["availabilityLevel"])
                    state = upsert_inventory_state(
                        db,
                        family_id=family_id,
                        user_id=user_id,
                        ingredient=ingredient,
                        expected_ingredient_row_version=int(ingredient.row_version),
                        state_id=runtime_state.id if runtime_state is not None else None,
                        expected_state_row_version=int(runtime_state.row_version) if runtime_state is not None else None,
                        availability_level=InventoryAvailabilityLevel(str(availability_level)),
                        inventory_status=InventoryStatus(str(operation.get("status") or "fresh")),
                        purchase_date=date.fromisoformat(str(operation["purchaseDate"])) if operation.get("purchaseDate") else None,
                        expiry_date=date.fromisoformat(str(operation["expiryDate"])) if operation.get("expiryDate") else None,
                        storage_location=str(operation.get("storageLocation") or operation.get("storage_location") or ingredient.default_storage or "常温"),
                        notes=str(operation.get("notes") or ""),
                        confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
                        record_activity=True,
                    )
                    runtime_states_by_ingredient_id[ingredient.id] = state
                    result = {
                        "operation": "restock",
                        "ingredient_id": ingredient.id,
                        "ingredient_name": ingredient.name,
                        "inventory_item_id": None,
                        "state_id": state.id,
                        "quantity": None,
                        "unit": ingredient.default_unit,
                        "inventory_state": serialize_ingredient_inventory_state(state),
                    }
                    entity_ids.append(state.id)
                else:
                    item = create_inventory_batch(
                        db,
                        family_id=family_id,
                        user_id=user_id,
                        ingredient=ingredient,
                        quantity=Decimal(str(operation["quantity"])) if operation.get("quantity") is not None else None,
                        unit=str(operation.get("unit") or ingredient.default_unit),
                        status=InventoryStatus(str(operation["status"])),
                        purchase_date=date.fromisoformat(str(operation["purchaseDate"])),
                        expiry_date=date.fromisoformat(str(operation["expiryDate"])) if operation.get("expiryDate") else None,
                        storage_location=str(operation["storageLocation"]),
                        notes=str(operation.get("notes") or ""),
                        low_stock_threshold=(
                            Decimal(str(operation["lowStockThreshold"]))
                            if operation.get("lowStockThreshold") is not None
                            else None
                        ),
                        already_locked=True,
                    )
                    result = {
                        "operation": "restock",
                        "ingredient_id": ingredient.id,
                        "ingredient_name": ingredient.name,
                        "inventory_item_id": item.id,
                        "quantity": float(operation["quantity"]) if operation.get("quantity") is not None else None,
                        "unit": str(operation.get("unit") or ingredient.default_unit),
                        "inventory_item": serialize_inventory_item(item),
                    }
                    entity_ids.append(item.id)
            elif action == "consume":
                result = consume_ingredient_inventory(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    ingredient=ingredient,
                    quantity=Decimal(str(operation["quantity"])) if operation.get("quantity") is not None else None,
                    unit=str(operation.get("unit") or ingredient.default_unit),
                    today=today,
                    inventory_item_id=operation.get("inventoryItemId"),
                )
                entity_ids.extend(result["affected_item_ids"])
            elif action == "dispose":
                item = locked.inventory_items[str(operation["inventoryItemId"])]
                item.ingredient = ingredient
                result = dispose_inventory_quantity(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    item=item,
                    quantity=Decimal(str(operation["quantity"])) if operation.get("quantity") is not None else None,
                    unit=str(operation.get("unit") or item.unit),
                    reason=str(operation["reason"]),
                    already_locked=True,
                )
                entity_ids.append(item.id)
            else:
                raise ValueError("不支持的库存操作")
            results.append(result)
        db.flush()
    except PresenceStateRequiredError as exc:
        raise ValueError(str(exc)) from exc
    except InventoryConflictError as exc:
        raise AIConflictError(STALE_INVENTORY_DETAIL) from exc
    except StaleDataError as exc:
        raise AIConflictError(STALE_INVENTORY_DETAIL) from exc
    return {"operations": results}, list(dict.fromkeys(entity_ids))


def refresh_inventory_result_card(
    db: Session,
    *,
    family_id: str,
    message_id: str | None,
    result: dict[str, Any] | None,
    user_id: str,
) -> None:
    if not message_id or not result:
        return
    message = db.scalar(
        select(AIMessage)
        .where(AIMessage.id == message_id, AIMessage.family_id == family_id)
        .with_for_update()
    )
    if message is None:
        return
    operations = [item for item in result.get("operations") or [] if isinstance(item, dict)]
    inventory_ids = list(
        dict.fromkeys(
            str(item_id)
            for operation in operations
            for item_id in [
                operation.get("inventory_item_id"),
                *(operation.get("affected_item_ids") or []),
            ]
            if item_id
        )
    )
    state_ids = list(
        dict.fromkeys(
            str(state_id)
            for operation in operations
            if (state_id := operation.get("state_id"))
        )
    )
    rows = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == family_id, InventoryItem.id.in_(inventory_ids))
            .options(selectinload(InventoryItem.ingredient))
        )
    )
    media_map = entity_media_map(db, family_id=family_id, entity_types={"ingredient"}, entity_ids=[item.ingredient_id for item in rows])
    today = today_for_family(family_id)
    records = {item.id: inventory_record(item, media_map, today=today) for item in rows}
    state_rows = list(
        db.scalars(
            select(IngredientInventoryState)
            .where(
                IngredientInventoryState.family_id == family_id,
                IngredientInventoryState.id.in_(state_ids),
            )
            .options(selectinload(IngredientInventoryState.ingredient))
        )
    )
    state_media_map = entity_media_map(
        db,
        family_id=family_id,
        entity_types={"ingredient"},
        entity_ids=[state.ingredient_id for state in state_rows],
    )
    for state in state_rows:
        ingredient = state.ingredient
        if ingredient is None or tracks_quantity(ingredient):
            continue
        record = inventory_state_record(state, ingredient, state_media_map, today=today)
        records[str(record["id"])] = record
    operation_by_item: dict[str, dict[str, Any]] = {}
    for operation in operations:
        for item_id in [operation.get("inventory_item_id"), *(operation.get("affected_item_ids") or [])]:
            if item_id:
                operation_by_item[str(item_id)] = {
                    "action": operation.get("operation"),
                    "quantity": operation.get("quantity"),
                    "unit": operation.get("unit"),
                    "reason": operation.get("reason"),
                    "handledAt": utcnow().isoformat(),
                    "handledBy": user_id,
                }
        state_id = operation.get("state_id")
        if state_id:
            operation_by_item[f"ingredient-state:{state_id}"] = {
                "action": operation.get("operation"),
                "quantity": operation.get("quantity"),
                "unit": operation.get("unit"),
                "reason": operation.get("reason"),
                "handledAt": utcnow().isoformat(),
                "handledBy": user_id,
            }

    next_parts: list[dict[str, Any]] = []
    for part in message.parts or []:
        card = part.get("card")
        if not isinstance(card, dict) or card.get("type") != "inventory_summary":
            next_parts.append(part)
            continue
        card_data = dict(card.get("data") or {})
        current_items = [item for item in card_data.get("items") or [] if isinstance(item, dict)]
        current_ids = {str(item.get("id") or "") for item in current_items}
        refreshed_items = []
        for item in current_items:
            item_id = str(item.get("id") or "")
            refreshed = records.get(item_id)
            if refreshed is None:
                refreshed_items.append(item)
                continue
            refreshed_items.append({**refreshed, "lastOperation": operation_by_item.get(item_id)})
        for item_id, record in records.items():
            if item_id not in current_ids and len(refreshed_items) < 6:
                refreshed_items.append({**record, "lastOperation": operation_by_item.get(item_id)})
        card_data["items"] = refreshed_items
        next_parts.append({**part, "card": {**card, "data": card_data}})
    message.parts = next_parts
    metadata = dict(message.message_metadata or {})
    metadata["lastInventoryOperations"] = jsonable_encoder(operations)
    message.message_metadata = metadata
