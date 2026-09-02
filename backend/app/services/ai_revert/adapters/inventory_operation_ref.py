from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.enums import (
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
)
from app.models.domain import (
    Food,
    IngredientInventoryState,
    InventoryItem,
    InventoryOperation,
    InventoryOperationLine,
)
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
    snapshot_food_inventory,
    snapshot_inventory_state,
)
from app.services.inventory_versions import InventoryConflictError


def _decimal(value) -> Decimal:
    return Decimal(str(value or 0))


def _changed_inventory_is_dependency(context: AIRevertContext, operation: InventoryOperation) -> bool:
    for line in operation.lines:
        after = line.after_snapshot or {}
        if line.entity_type == InventoryOperationEntityType.INVENTORY_ITEM:
            item = context.db.scalar(
                select(InventoryItem).where(
                    InventoryItem.family_id == context.family_id,
                    InventoryItem.id == line.entity_id,
                )
            )
            if item is not None and (
                _decimal(item.consumed_quantity) > _decimal(after.get("consumed_quantity"))
                or _decimal(item.disposed_quantity) > _decimal(after.get("disposed_quantity"))
            ):
                return True
        elif line.entity_type == InventoryOperationEntityType.FOOD:
            food = context.db.scalar(
                select(Food).where(
                    Food.family_id == context.family_id,
                    Food.id == line.entity_id,
                )
            )
            if food is not None and _snapshot_fields_changed(
                snapshot_food_inventory(food),
                after,
                fields=_FOOD_INVENTORY_FIELDS,
            ):
                return True
        elif line.entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE:
            state = context.db.scalar(
                select(IngredientInventoryState).where(
                    IngredientInventoryState.family_id == context.family_id,
                    IngredientInventoryState.id == line.entity_id,
                )
            )
            if state is not None and _snapshot_fields_changed(
                snapshot_inventory_state(state),
                after,
                fields=_PRESENCE_INVENTORY_FIELDS,
            ):
                return True
    return False


_FOOD_INVENTORY_FIELDS = (
    "stock_quantity",
    "stock_unit",
    "storage_location",
    "expiry_date",
    "inventory_last_confirmed_at",
    "inventory_last_confirmed_by",
    "inventory_confirmation_source",
)

_PRESENCE_INVENTORY_FIELDS = (
    "availability_level",
    "inventory_status",
    "purchase_date",
    "expiry_date",
    "storage_location",
    "expiry_alert_snoozed_until",
    "expiry_reviewed_at",
    "expiry_reviewed_by",
    "last_confirmed_at",
    "last_confirmed_by",
    "last_confirmation_source",
)


def _snapshot_fields_changed(
    current: dict[str, object],
    after: dict,
    *,
    fields: tuple[str, ...],
) -> bool:
    return any(
        _normalized_snapshot_value(field, current.get(field))
        != _normalized_snapshot_value(field, after.get(field))
        for field in fields
    )


def _normalized_snapshot_value(field: str, value: object) -> object:
    if value is None or not field.endswith("_at"):
        return value
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


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
