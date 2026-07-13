from __future__ import annotations

from dataclasses import replace
from typing import Any

from app.services.ai_operations.composite import (
    COMPOSITE_DOMAIN_DRAFT_TYPES,
    composite_execution_order,
    composite_operation_requires_deferred_normalization,
    execute_composite_operation_plan,
    normalize_composite_operation_draft,
    validate_composite_operation_shape,
)
from app.services.ai_operations.executor import derive_child_operation_idempotency_key
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftNormalizeContext,
    DraftOperationSpec,
    DraftResultMetadata,
)
from app.services.ai_operations.draft_specs.common import _spec


def _normalize_composite_operation(context: DraftNormalizeContext) -> dict[str, Any]:
    normalized = normalize_composite_operation_draft(context.payload)
    if context.phase == "approval":
        return normalized

    from app.services.ai_operations.registry import draft_operation_registry

    normalized_steps: list[dict[str, Any]] = []
    for step in normalized["steps"]:
        operation = step["operation"]
        if not composite_operation_requires_deferred_normalization(
            operation,
            domain=str(step["domain"]),
        ):
            operation = draft_operation_registry.normalize(
                DraftNormalizeContext(
                    db=context.db,
                    draft_type=COMPOSITE_DOMAIN_DRAFT_TYPES[str(step["domain"])],
                    family_id=context.family_id,
                    user_id=context.user_id,
                    conversation_id=context.conversation_id,
                    payload=operation,
                    phase="proposal",
                )
            )
        normalized_steps.append({**step, "operation": operation})
    return normalize_composite_operation_draft({**normalized, "steps": normalized_steps})


def _execute_composite_operation(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    steps_by_id = {
        str(step.get("stepId") or ""): step
        for step in (context.payload.get("steps") or [])
        if isinstance(step, dict)
    }

    def execute_step(
        step_draft_type: str,
        step_payload: dict[str, Any],
        normalize_before_execute: bool,
        step_id: str,
    ) -> tuple[dict[str, Any], list[str]]:
        from app.services.ai_operations.registry import draft_operation_registry

        step = steps_by_id.get(step_id) or {}
        if step_draft_type == "recipe_cook":
            child_operation_id = str(
                step_payload.get("operationId")
                or step_payload.get("operation_id")
                or step.get("operationId")
                or step.get("operation_id")
                or ""
            ).strip()
            if not child_operation_id:
                raise ValueError("复合做菜步骤必须包含稳定的 operationId，不能使用列表位置作为幂等标识")
        else:
            child_operation_id = str(
                step_payload.get("operationId")
                or step_payload.get("operation_id")
                or step_id
                or ""
            ).strip()
            if not child_operation_id:
                raise ValueError("复合操作步骤缺少稳定 operationId/stepId，无法生成幂等键")

        if normalize_before_execute:
            step_payload = draft_operation_registry.normalize(
                DraftNormalizeContext(
                    db=context.db,
                    draft_type=step_draft_type,
                    family_id=context.family_id,
                    user_id=context.user_id,
                    conversation_id=context.conversation_id,
                    payload=step_payload,
                    phase="proposal",
                )
            )
        child_context = replace(
            context,
            draft_type=step_draft_type,
            payload=step_payload,
            operation_idempotency_key=derive_child_operation_idempotency_key(
                context.operation_idempotency_key,
                child_operation_id,
            ),
        )
        return draft_operation_registry.execute(child_context)

    # Ensure topological order is validated before execution.
    composite_execution_order(context.payload)
    result = execute_composite_operation_plan(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        execute_operation=execute_step,
    )
    entity_ids = [
        str(entity_id)
        for step in result.get("steps") or []
        if isinstance(step, dict)
        for entity_id in (step.get("entityIds") or [])
        if str(entity_id)
    ]
    return result, list(dict.fromkeys(entity_ids))


def _preview_composite_operation(payload: dict[str, Any]) -> str:
    steps = payload.get("steps") or []
    return f"{len(steps)} 步复合操作"


def composite_operation_specs() -> list[DraftOperationSpec]:
    return [
        _spec(
            "composite_operation",
            normalize=_normalize_composite_operation,
            execute=_execute_composite_operation,
            preview_summary=_preview_composite_operation,
            validate_approval_value=validate_composite_operation_shape,
            result_metadata=DraftResultMetadata(
                workspace_label="相关工作区",
                count_noun="个复合步骤结果",
                fallback_label="复合操作",
                default_action="composite_operation",
            ),
        ),
    ]
