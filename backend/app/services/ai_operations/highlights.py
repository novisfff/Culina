from __future__ import annotations

from typing import Any

from app.core.enums import ActivityHighlightKind
from app.services.activity import ActivityHighlight
from app.services.ai_operations.registry_types import (
    DraftHighlightContext,
    DraftOperationRegistry,
)


def reduce_activity_highlights(
    candidates: list[ActivityHighlight],
) -> ActivityHighlight | None:
    if not candidates:
        return None
    kinds = {candidate.kind for candidate in candidates}
    if len(kinds) != 1:
        return None
    kind = candidates[0].kind
    if len(candidates) == 1:
        return candidates[0]
    noun = {
        ActivityHighlightKind.SHOPPING: "组采购入库",
        ActivityHighlightKind.INVENTORY: "组库存处理",
        ActivityHighlightKind.MEAL_PLAN: "组菜单安排",
        ActivityHighlightKind.MEAL: "项餐食记录",
        ActivityHighlightKind.FAMILY: "项家庭协作",
    }[kind]
    return ActivityHighlight(kind=kind, summary=f"完成 {len(candidates)} {noun}")


def _composite_candidates(
    registry: DraftOperationRegistry,
    *,
    submitted_payload: dict[str, Any],
    business_entity: dict[str, Any],
) -> list[ActivityHighlight]:
    from app.services.ai_operations.composite import COMPOSITE_DOMAIN_DRAFT_TYPES

    submitted_steps = {
        str(step.get("stepId")): step
        for step in submitted_payload.get("steps") or []
        if isinstance(step, dict)
    }
    candidates: list[ActivityHighlight] = []
    for result in business_entity.get("steps") or []:
        if not isinstance(result, dict):
            continue
        step = submitted_steps.get(str(result.get("stepId")))
        domain = str(result.get("domain") or "")
        draft_type = COMPOSITE_DOMAIN_DRAFT_TYPES.get(domain)
        if step is None or draft_type is None:
            continue
        candidate = registry.classify_highlight(
            DraftHighlightContext(
                draft_type=draft_type,
                submitted_payload=step.get("operation") or {},
                business_entity=result.get("payload") or {},
            )
        )
        if candidate is not None:
            candidates.append(candidate)
    return candidates


def classify_approval_highlight(
    registry: DraftOperationRegistry,
    *,
    draft_type: str,
    submitted_payload: dict[str, Any],
    business_entity: dict[str, Any],
) -> ActivityHighlight | None:
    if draft_type == "composite_operation":
        return reduce_activity_highlights(
            _composite_candidates(
                registry,
                submitted_payload=submitted_payload,
                business_entity=business_entity,
            )
        )
    return registry.classify_highlight(
        DraftHighlightContext(
            draft_type=draft_type,
            submitted_payload=submitted_payload,
            business_entity=business_entity,
        )
    )
