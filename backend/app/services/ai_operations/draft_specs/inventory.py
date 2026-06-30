from __future__ import annotations

from collections import Counter
from typing import Any

from app.ai.tools.draft_validation import normalize_inventory_operation_draft
from app.services.ai_operations.inventory import execute_inventory_operation_draft, refresh_inventory_result_card
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftNormalizeContext,
    DraftOperationSpec,
    DraftPostExecuteContext,
    DraftResultMetadata,
)
from app.services.ai_operations.draft_specs.common import _spec


def _validate_inventory_operation_value(original: Any, submitted: Any) -> None:
    if not isinstance(original, dict) or not isinstance(submitted, dict):
        raise ValueError("库存操作草稿格式不正确")
    original_operations = original.get("operations")
    submitted_operations = submitted.get("operations")
    if not isinstance(original_operations, list) or not isinstance(submitted_operations, list):
        raise ValueError("库存操作草稿格式不正确")

    def operation_key(operation: Any) -> tuple[str, str]:
        if not isinstance(operation, dict):
            return ("", "")
        return (
            str(operation.get("ingredientId") or operation.get("ingredient_id") or ""),
            str(operation.get("action") or ""),
        )

    allowed = Counter(operation_key(operation) for operation in original_operations)
    requested = Counter(operation_key(operation) for operation in submitted_operations)
    if any(not ingredient_id or not action for ingredient_id, action in requested):
        raise ValueError("库存操作项格式不正确")
    if any(count > allowed.get(key, 0) for key, count in requested.items()):
        raise ValueError("库存处理对象或处理方式不能在确认阶段修改")


def _normalize_inventory_operation(context: DraftNormalizeContext) -> dict[str, Any]:
    return normalize_inventory_operation_draft(context.db, family_id=context.family_id, payload=context.payload)


def _execute_inventory_operation(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    return execute_inventory_operation_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
    )


def _refresh_inventory_operation_result_card(context: DraftPostExecuteContext) -> None:
    refresh_inventory_result_card(
        context.db,
        family_id=context.family_id,
        message_id=context.message_id,
        result=context.business_entity,
        user_id=context.user_id,
    )


def _preview_inventory_operation(payload: dict[str, Any]) -> str:
    operations = payload.get("operations") or []
    labels = {"restock": "入库", "consume": "消耗", "dispose": "销毁"}
    counts: dict[str, int] = {}
    for operation in operations:
        action = labels.get(str(operation.get("action") or ""), "处理")
        counts[action] = counts.get(action, 0) + 1
    detail = " · ".join(f"{label} {count} 项" for label, count in counts.items())
    return f"{len(operations)} 项库存处理" + (f" · {detail}" if detail else "")


def inventory_operation_specs() -> list[DraftOperationSpec]:
    return [
        _spec(
            "inventory_operation",
            normalize=_normalize_inventory_operation,
            execute=_execute_inventory_operation,
            after_success=_refresh_inventory_operation_result_card,
            preview_summary=_preview_inventory_operation,
            validate_approval_value=_validate_inventory_operation_value,
            result_metadata=DraftResultMetadata(
                workspace_label="库存页",
                count_noun="项库存变更",
                fallback_label="库存处理",
                default_action="inventory_operation",
            ),
        ),
    ]
