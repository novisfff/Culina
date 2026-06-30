from __future__ import annotations

from typing import Any

from app.services.ai_operations.composite import (
    execute_composite_operation_plan,
    normalize_composite_operation_draft,
    validate_composite_operation_shape,
)
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftNormalizeContext,
    DraftOperationSpec,
    DraftResultMetadata,
)
from app.services.ai_operations.draft_specs.common import _spec


def _normalize_composite_operation(context: DraftNormalizeContext) -> dict[str, Any]:
    return normalize_composite_operation_draft(context.payload)


def _execute_composite_operation(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
    def execute_step(step_draft_type: str, step_payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        from app.services.ai_operations.registry import draft_operation_registry

        return draft_operation_registry.execute(
            DraftExecuteContext(
                db=context.db,
                family_id=context.family_id,
                user_id=context.user_id,
                draft_type=step_draft_type,
                payload=step_payload,
                assert_updated_at_matches=context.assert_updated_at_matches,
            )
        )

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
