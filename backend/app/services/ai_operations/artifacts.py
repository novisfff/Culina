from __future__ import annotations

from typing import Any

from app.core.utils import create_id
from app.services.ai_operations.registry import draft_operation_registry


def build_approval_result_card(
    *,
    approval: dict[str, Any],
    draft: dict[str, Any],
    operation: dict[str, Any],
    draft_config: dict[str, str],
    business_artifacts: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if approval.get("status") != "approved" or operation.get("status") != "succeeded":
        return None
    draft_type = str(draft.get("draft_type") or "")
    draft_payload = draft.get("payload") if isinstance(draft.get("payload"), dict) else {}
    title = approval_result_title(draft_config.get("title"), fallback=draft_type)
    default_action = draft_operation_registry.result_default_action(
        draft_type,
        approval_type=str(approval.get("approval_type") or ""),
        draft_payload=draft_payload,
    )
    entities = []
    for artifact in business_artifacts:
        payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
        action = str(payload.get("_operation") or default_action or "")
        entities.append(
            {
                "id": str(artifact.get("entityId") or artifact.get("id") or create_id("result_entity")),
                "label": str(artifact.get("summary") or artifact_summary(payload, fallback_type=draft_type)),
                "operation": action or None,
                "operationLabel": draft_operation_registry.operation_label(draft_type, action) if action else None,
                "updatedAt": artifact.get("updatedAt"),
            }
        )
    count = len(entities)
    workspace_label = approval_result_workspace_label(draft_type)
    count_label = approval_result_count_label(draft_type, count)
    return {
        "id": f"operation-result:{approval.get('id') or create_id('approval_result')}",
        "type": "operation_result",
        "title": title,
        "data": {
            "actionSummary": title,
            "entityCount": count,
            "entityCountLabel": count_label,
            "workspaceLabel": workspace_label,
            "workspaceHint": f"可前往{workspace_label}查看",
            "entities": entities,
            "approvalId": approval.get("id"),
            "operationId": operation.get("id"),
            "draftId": draft.get("id"),
        },
    }


def approval_decision_artifacts(
    *,
    approval: dict[str, Any],
    draft: dict[str, Any],
    operation: dict[str, Any],
    business_entity: Any,
) -> list[dict[str, Any]]:
    artifacts = [
        {
            "id": f"human_in_loop:{approval.get('id') or create_id('approval_result')}",
            "type": "approval_decision",
            "kind": "human_in_loop_tool_result",
            "version": 1,
            "status": approval.get("status") or "resolved",
            "payload": {
                "approval": approval,
                "draft": draft,
                "operation": operation,
                "business_entity": business_entity,
            },
            "sourceDraftId": draft.get("id"),
            "sourceApprovalId": approval.get("id"),
        }
    ]
    artifacts.extend(
        business_entity_artifacts(
            approval=approval,
            draft=draft,
            operation=operation,
            business_entity=business_entity,
        )
    )
    return artifacts


def business_entity_artifacts(
    *,
    approval: dict[str, Any],
    draft: dict[str, Any],
    operation: dict[str, Any],
    business_entity: Any,
) -> list[dict[str, Any]]:
    if approval.get("status") != "approved" or operation.get("status") != "succeeded":
        return []
    draft_type = str(draft.get("draft_type") or "")
    operation_id = str(operation.get("id") or "")
    entity_type = str(operation.get("business_entity_type") or "")
    records = draft_operation_registry.business_entity_records(draft_type, business_entity, entity_type=entity_type)
    artifacts: list[dict[str, Any]] = []
    for index, record in enumerate(records, start=1):
        entity_id = str(record.get("id") or record.get("entity_id") or "")
        artifact_id = entity_id or f"{operation_id or create_id('entity_artifact')}:{index}"
        artifacts.append(
            {
                "id": f"entity:{artifact_id}",
                "type": draft_type or entity_type.lower(),
                "kind": "business_entity",
                "version": 1,
                "status": "confirmed",
                "businessEntityType": entity_type,
                "entityId": entity_id or None,
                "updatedAt": artifact_updated_at(record),
                "payload": record,
                "summary": artifact_summary(record, fallback_type=draft_type or entity_type),
                "sourceDraftId": draft.get("id"),
                "sourceApprovalId": approval.get("id"),
                "sourceOperationId": operation_id or None,
            }
        )
    return artifacts


def approval_result_title(title: str | None, *, fallback: str) -> str:
    if isinstance(title, str) and title.startswith("确认") and len(title) > 2:
        return f"已{title[2:]}"
    if isinstance(title, str) and title.strip():
        return title
    return fallback or "已完成写入"


def approval_result_default_action(*, approval_type: str, draft_payload: dict[str, Any], draft_type: str) -> str:
    return draft_operation_registry.result_default_action(
        draft_type,
        approval_type=approval_type,
        draft_payload=draft_payload,
    )


def approval_result_operation_label(action: str) -> str:
    return draft_operation_registry.operation_label("", action)


def approval_result_workspace_label(draft_type: str) -> str:
    return draft_operation_registry.workspace_label(draft_type)


def approval_result_count_label(draft_type: str, count: int) -> str:
    return draft_operation_registry.count_label(draft_type, count)


def artifact_updated_at(record: dict[str, Any]) -> str | None:
    for key in ("updated_at", "updatedAt", "baseUpdatedAt"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def artifact_summary(record: dict[str, Any], *, fallback_type: str) -> str:
    for key in ("title", "name", "ingredient_name", "ingredientName", "food_name", "foodName"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    date_value = record.get("date") or record.get("plan_date") or record.get("cook_date")
    meal_type = record.get("meal_type") or record.get("mealType")
    if date_value and meal_type:
        return f"{date_value} {meal_type}"
    if date_value:
        return str(date_value)
    return fallback_type_label(fallback_type)


def fallback_type_label(value: str) -> str:
    return draft_operation_registry.fallback_label(value)
