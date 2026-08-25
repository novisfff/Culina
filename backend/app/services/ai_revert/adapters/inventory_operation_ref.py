from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.enums import (
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
)
from app.models.domain import ActivityLog, InventoryItem, InventoryOperation, InventoryOperationLine
from app.services.ai_revert.errors import (
    AIRevertAdapterVersionUnsupported,
    AIRevertDependencyExists,
    AIRevertTargetChanged,
)
from app.services.ai_revert.types import AIRevertContext, AIRevertResult
from app.services.inventory_operation_history import (
    InventoryOperationNotFoundError,
    InventoryOperationPermissionError,
    revert_inventory_operation,
)
from app.services.inventory_versions import InventoryConflictError


def _decimal(value) -> Decimal:
    return Decimal(str(value or 0))


def _changed_inventory_is_dependency(context: AIRevertContext, operation: InventoryOperation) -> bool:
    for line in operation.lines:
        if line.entity_type != InventoryOperationEntityType.INVENTORY_ITEM:
            continue
        item = context.db.scalar(
            select(InventoryItem).where(
                InventoryItem.family_id == context.family_id,
                InventoryItem.id == line.entity_id,
            )
        )
        if item is None:
            continue
        after = line.after_snapshot or {}
        if (
            _decimal(item.consumed_quantity) > _decimal(after.get("consumed_quantity"))
            or _decimal(item.disposed_quantity) > _decimal(after.get("disposed_quantity"))
        ):
            return True
    return False


def _later_inventory_operation_is_dependency(
    context: AIRevertContext,
    operation: InventoryOperation,
) -> bool:
    guarded_versions = {
        (line.entity_type, line.entity_id): int(line.after_row_version)
        for line in operation.lines
        if line.entity_type
        in {
            InventoryOperationEntityType.INGREDIENT,
            InventoryOperationEntityType.INVENTORY_ITEM,
            InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE,
            InventoryOperationEntityType.FOOD,
        }
        and line.after_row_version is not None
    }
    if not guarded_versions:
        return False

    later_lines = context.db.scalars(
        select(InventoryOperationLine)
        .join(InventoryOperation, InventoryOperation.id == InventoryOperationLine.operation_id)
        .where(
            InventoryOperation.family_id == context.family_id,
            InventoryOperation.id != operation.id,
            InventoryOperation.status == InventoryOperationStatus.APPLIED,
        )
    )
    for line in later_lines:
        expected_after = guarded_versions.get((line.entity_type, line.entity_id))
        if expected_after is None or line.before_row_version is None:
            continue
        if int(line.before_row_version) >= expected_after:
            return True
    return False


def _later_domain_activity_is_dependency(
    context: AIRevertContext,
    operation: InventoryOperation,
) -> bool:
    food_ids = {
        line.entity_id
        for line in operation.lines
        if line.entity_type == InventoryOperationEntityType.FOOD
    }
    state_ids = {
        line.entity_id
        for line in operation.lines
        if line.entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE
    }
    if not food_ids and not state_ids:
        return False

    activities = context.db.scalars(
        select(ActivityLog).where(
            ActivityLog.family_id == context.family_id,
            ActivityLog.created_at > operation.created_at,
        )
    )
    food_inventory_prefixes = (
        "补充食物库存 ",
        "采购入库食物 ",
        "记录食用 ",
        "处理食物库存 ",
        "确认食物库存 ",
        "调整食物库存 ",
        "确认没有 ",
    )
    for activity in activities:
        if activity.entity_type == "IngredientInventoryState" and activity.entity_id in state_ids:
            return True
        if (
            activity.entity_type == "Food"
            and activity.entity_id in food_ids
            and str(activity.summary or "").startswith(food_inventory_prefixes)
        ):
            return True
    return False


class InventoryOperationRefAdapter:
    key = "inventory.operation_ref.v1"
    schema_version = 1

    def revert(self, context: AIRevertContext) -> AIRevertResult:
        payload = context.operation.revert_context_json
        if (
            not isinstance(payload, dict)
            or set(payload) != {"schema_version", "inventory_operation_id"}
            or type(payload.get("schema_version")) is not int
            or payload["schema_version"] != self.schema_version
            or not isinstance(payload.get("inventory_operation_id"), str)
            or not payload["inventory_operation_id"].strip()
        ):
            raise AIRevertAdapterVersionUnsupported()

        operation = context.db.scalar(
            select(InventoryOperation).where(
                InventoryOperation.family_id == context.family_id,
                InventoryOperation.id == payload["inventory_operation_id"],
            ).options(selectinload(InventoryOperation.lines))
        )
        if operation is None:
            raise AIRevertTargetChanged()
        lines = sorted(operation.lines, key=lambda line: (line.sequence, line.entity_type.value, line.entity_id))
        try:
            result = revert_inventory_operation(
                context.db,
                family_id=context.family_id,
                user_id=context.actor_user_id,
                user_role=context.actor_role,
                operation_id=operation.id,
                now=context.now,
            )
        except (InventoryOperationNotFoundError, InventoryOperationPermissionError) as exc:
            raise AIRevertTargetChanged() from exc
        except InventoryConflictError as exc:
            dependency_reasons = {
                str(conflict.get("reason") or "")
                for conflict in exc.conflicts
                if isinstance(conflict, dict)
            }
            if (
                exc.code == "food_has_history"
                or "consumed_or_disposed" in dependency_reasons
                or _later_inventory_operation_is_dependency(context, operation)
                or _later_domain_activity_is_dependency(context, operation)
                or _changed_inventory_is_dependency(context, operation)
            ):
                raise AIRevertDependencyExists() from exc
            raise AIRevertTargetChanged() from exc

        labels = {
            InventoryOperationEntityType.INVENTORY_ITEM: "库存批次",
            InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE: "库存状态",
            InventoryOperationEntityType.FOOD: "食物库存",
            InventoryOperationEntityType.SHOPPING_LIST_ITEM: "购物项",
        }
        entities = tuple(
            {
                "id": line.entity_id,
                "label": labels.get(line.entity_type, "库存"),
                "operation": (
                    "delete"
                    if line.change_type == InventoryOperationChangeType.CREATE
                    else "update"
                ),
            }
            for line in lines
            if line.entity_type != InventoryOperationEntityType.INGREDIENT
        )
        return AIRevertResult(
            result_json=result.model_dump(mode="json"),
            entities=entities,
            cache_scopes=("inventory", "ai_conversation"),
        )
