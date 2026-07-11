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
from app.models.domain import AIMessage, InventoryItem
from app.ai.tools.catalog.inventory import inventory_record
from app.services.clock import today_for_family
from app.services.ingredient_inventory_state import PresenceStateRequiredError, upsert_inventory_state
from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
from app.services.inventory_operations import consume_ingredient_inventory, create_inventory_batch, dispose_inventory_quantity, require_ingredient, require_inventory_item
from app.services.inventory_usage import tracks_quantity
from app.services.serializers import serialize_ingredient_inventory_state, serialize_inventory_item


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
        for operation in payload.get("operations") or []:
            action = str(operation["action"])
            ingredient = require_ingredient(
                db,
                family_id=family_id,
                ingredient_id=str(operation["ingredientId"]),
            )
            if action == "restock":
                if not tracks_quantity(ingredient):
                    from sqlalchemy import select
                    from app.models.domain import IngredientInventoryState

                    expected_ingredient_row_version = int(
                        operation.get("expectedIngredientRowVersion")
                        or operation.get("expected_ingredient_row_version")
                        or ingredient.row_version
                    )
                    state_id = operation.get("stateId") or operation.get("state_id")
                    expected_state_row_version = operation.get("expectedStateRowVersion") or operation.get(
                        "expected_state_row_version"
                    )
                    if expected_state_row_version is not None:
                        expected_state_row_version = int(expected_state_row_version)
                    if state_id is None:
                        existing_state = db.scalar(
                            select(IngredientInventoryState).where(
                                IngredientInventoryState.family_id == family_id,
                                IngredientInventoryState.ingredient_id == ingredient.id,
                            )
                        )
                        if existing_state is not None:
                            state_id = existing_state.id
                            if expected_state_row_version is None:
                                expected_state_row_version = existing_state.row_version
                    availability_level = operation.get("availabilityLevel") or operation.get("availability_level") or "present_unknown"
                    state = upsert_inventory_state(
                        db,
                        family_id=family_id,
                        user_id=user_id,
                        ingredient=ingredient,
                        expected_ingredient_row_version=expected_ingredient_row_version,
                        state_id=str(state_id) if state_id else None,
                        expected_state_row_version=expected_state_row_version,
                        availability_level=InventoryAvailabilityLevel(str(availability_level)),
                        inventory_status=InventoryStatus(str(operation.get("status") or "fresh")),
                        purchase_date=date.fromisoformat(str(operation["purchaseDate"])) if operation.get("purchaseDate") else None,
                        expiry_date=date.fromisoformat(str(operation["expiryDate"])) if operation.get("expiryDate") else None,
                        storage_location=str(operation.get("storageLocation") or operation.get("storage_location") or ingredient.default_storage or "常温"),
                        notes=str(operation.get("notes") or ""),
                        confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
                        record_activity=True,
                    )
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
                # Unlocked provisional load only; dispose locks parent-first.
                item = require_inventory_item(
                    db,
                    family_id=family_id,
                    inventory_item_id=str(operation["inventoryItemId"]),
                    for_update=False,
                )
                result = dispose_inventory_quantity(
                    db,
                    family_id=family_id,
                    user_id=user_id,
                    item=item,
                    quantity=Decimal(str(operation["quantity"])) if operation.get("quantity") is not None else None,
                    unit=str(operation.get("unit") or item.unit),
                    reason=str(operation["reason"]),
                )
                entity_ids.append(item.id)
            else:
                raise ValueError("不支持的库存操作")
            results.append(result)
        db.flush()
    except PresenceStateRequiredError as exc:
        raise ValueError(str(exc)) from exc
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
