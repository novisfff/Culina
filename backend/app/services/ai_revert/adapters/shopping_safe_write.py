from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select

from app.core.enums import ActivityAction, InventoryOperationEntityType, InventoryOperationStatus
from app.models.domain import InventoryOperation, InventoryOperationLine, ShoppingListItem
from app.services.activity import log_activity
from app.services.ai_revert.errors import (
    AIRevertAdapterVersionUnsupported,
    AIRevertDependencyExists,
    AIRevertTargetChanged,
)
from app.services.ai_revert.types import AIRevertContext, AIRevertResult
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets


_SAFE_FIELDS = {"quantity", "unit", "notes"}


def _decimal(value: object) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise AIRevertAdapterVersionUnsupported()
    try:
        return Decimal(str(value))
    except Exception as exc:
        raise AIRevertAdapterVersionUnsupported() from exc


def _safe_values(record: object) -> tuple[Decimal, str, str]:
    if not isinstance(record, dict) or set(record) != _SAFE_FIELDS:
        raise AIRevertAdapterVersionUnsupported()
    if not isinstance(record.get("unit"), str) or not isinstance(record.get("notes"), str):
        raise AIRevertAdapterVersionUnsupported()
    return _decimal(record["quantity"]), record["unit"], record["notes"]


class ShoppingSafeWriteRevertAdapter:
    key = "shopping_list.safe_write.v1"
    schema_version = 1

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        payload = context.operation.revert_context_json
        if (
            not isinstance(payload, dict)
            or set(payload) != {"schema_version", "mode", "items"}
            or type(payload.get("schema_version")) is not int
            or payload["schema_version"] != self.schema_version
            or payload.get("mode") not in {"add", "update", "restore"}
            or not isinstance(payload.get("items"), list)
            or not payload["items"]
        ):
            raise AIRevertAdapterVersionUnsupported()
        mode = payload["mode"]
        records: list[dict] = []
        for record in payload["items"]:
            if (
                not isinstance(record, dict)
                or set(record) != {"shopping_item_id", "before", "after", "after_row_version"}
                or not isinstance(record.get("shopping_item_id"), str)
                or type(record.get("after_row_version")) is not int
            ):
                raise AIRevertAdapterVersionUnsupported()
            records.append(record)
        item_ids = [record["shopping_item_id"] for record in records]
        if item_ids != sorted(set(item_ids)):
            raise AIRevertAdapterVersionUnsupported()

        discovered = list(
            context.db.scalars(
                select(ShoppingListItem).where(
                    ShoppingListItem.family_id == context.family_id,
                    ShoppingListItem.id.in_(item_ids),
                )
            )
        )
        ingredient_ids = tuple(sorted({item.ingredient_id for item in discovered if item.ingredient_id}))
        food_ids = tuple(sorted({item.food_id for item in discovered if item.food_id}))
        try:
            locked = lock_inventory_targets(
                context.db,
                family_id=context.family_id,
                ingredient_ids=ingredient_ids,
                food_ids=food_ids,
                shopping_item_ids=item_ids,
            )
        except InventoryTargetNotFoundError as exc:
            raise AIRevertTargetChanged() from exc
        items = locked.shopping_items

        if mode == "add":
            used_ids = set(
                context.db.scalars(
                    select(InventoryOperationLine.entity_id)
                    .join(InventoryOperation, InventoryOperation.id == InventoryOperationLine.operation_id)
                    .where(
                        InventoryOperation.family_id == context.family_id,
                        InventoryOperation.status == InventoryOperationStatus.APPLIED,
                        InventoryOperationLine.entity_type == InventoryOperationEntityType.SHOPPING_LIST_ITEM,
                        InventoryOperationLine.entity_id.in_(item_ids),
                    )
                )
            )
            if used_ids:
                raise AIRevertDependencyExists()

        for record in records:
            item = items[record["shopping_item_id"]]
            if mode == "add":
                after = record["after"]
                if not isinstance(after, dict) or set(after) != _SAFE_FIELDS | {"done"}:
                    raise AIRevertAdapterVersionUnsupported()
                quantity, unit, notes = _safe_values({key: after[key] for key in _SAFE_FIELDS})
                if (
                    item.done
                    or int(item.row_version) != record["after_row_version"]
                    or Decimal(str(item.quantity)) != quantity
                    or item.unit != unit
                    or item.reason != notes
                    or after["done"] is not False
                    or record["before"] is not None
                ):
                    raise AIRevertTargetChanged()
            elif mode == "update":
                before = _safe_values(record["before"])
                after = _safe_values(record["after"])
                del before
                if (
                    int(item.row_version) != record["after_row_version"]
                    or Decimal(str(item.quantity)) != after[0]
                    or item.unit != after[1]
                    or item.reason != after[2]
                ):
                    raise AIRevertTargetChanged()
            else:
                if record["before"] != {"done": True} or record["after"] != {"done": False}:
                    raise AIRevertAdapterVersionUnsupported()
                if int(item.row_version) != record["after_row_version"] or item.done:
                    raise AIRevertTargetChanged()

        entities = tuple(
            {"id": item_id, "label": items[item_id].title, "operation": "delete" if mode == "add" else "update"}
            for item_id in item_ids
        )
        for record in records:
            item = items[record["shopping_item_id"]]
            if mode == "add":
                context.db.delete(item)
            elif mode == "update":
                before = _safe_values(record["before"])
                item.quantity, item.unit, item.reason = before
                item.updated_by = context.actor_user_id
            else:
                item.done = True
                item.updated_by = context.actor_user_id
            log_activity(
                context.db,
                family_id=context.family_id,
                actor_id=context.actor_user_id,
                action=ActivityAction.UPDATE,
                entity_type="ShoppingListItem",
                entity_id=item.id,
                summary="撤销 AI 购物清单变更",
            )
        context.db.flush()
        return AIRevertResult(
            result_json={"restored": True, "count": len(records)},
            entities=entities,
            cache_scopes=("shopping_list", "ai_conversation"),
        )
