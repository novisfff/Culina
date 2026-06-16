from __future__ import annotations

from typing import Any

from app.core.utils import create_id


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
    default_action = approval_result_default_action(
        approval_type=str(approval.get("approval_type") or ""),
        draft_payload=draft_payload,
        draft_type=draft_type,
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
                "operationLabel": approval_result_operation_label(action) if action else None,
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
    records = business_entity_records(business_entity, entity_type=entity_type)
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


def business_entity_records(entity_payload: Any, *, entity_type: str) -> list[dict[str, Any]]:
    if not isinstance(entity_payload, dict):
        return []
    if isinstance(entity_payload.get("operations"), list):
        records: list[dict[str, Any]] = []
        for item in entity_payload.get("operations") or []:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("item"), dict):
                records.append({**item["item"], "_operation": item.get("action"), "_operationId": item.get("operationId")})
                continue
            if isinstance(item.get("inventory_item"), dict):
                records.append({**item["inventory_item"], "_operation": item.get("operation"), "_operationId": item.get("operationId")})
                continue
            records.append(item)
        return records
    if isinstance(entity_payload.get("steps"), list):
        records = []
        for step in entity_payload.get("steps") or []:
            if not isinstance(step, dict):
                continue
            payload = step.get("payload") if isinstance(step.get("payload"), dict) else {}
            if isinstance(payload.get("operations"), list):
                for item in payload.get("operations") or []:
                    if isinstance(item, dict):
                        records.append({**item, "_operation": step.get("domain"), "_stepId": step.get("stepId")})
                continue
            records.append(step)
        return records
    if isinstance(entity_payload.get("items"), list):
        return [item for item in entity_payload.get("items") or [] if isinstance(item, dict)]
    if entity_type == "RecipeCookLog" and isinstance(entity_payload.get("cook_log"), dict):
        return [entity_payload["cook_log"]]
    return [entity_payload]


def approval_result_title(title: str | None, *, fallback: str) -> str:
    if isinstance(title, str) and title.startswith("确认") and len(title) > 2:
        return f"已{title[2:]}"
    if isinstance(title, str) and title.strip():
        return title
    return fallback or "已完成写入"


def approval_result_default_action(*, approval_type: str, draft_payload: dict[str, Any], draft_type: str) -> str:
    action = str(draft_payload.get("action") or "")
    if action:
        return action
    if approval_type.endswith(".create"):
        return "create"
    if approval_type.endswith(".update"):
        return "update"
    if approval_type.endswith(".delete"):
        return "delete"
    if approval_type.endswith(".favorite"):
        return "set_favorite"
    if approval_type.endswith(".rate_food"):
        return "rate_food"
    if approval_type.endswith(".cook"):
        return "cook"
    if draft_type == "inventory_operation":
        return "inventory_operation"
    if draft_type == "composite_operation":
        return "composite_operation"
    return ""


def approval_result_operation_label(action: str) -> str:
    return {
        "create": "新增",
        "update": "更新",
        "delete": "删除",
        "set_status": "状态变更",
        "set_done": "状态变更",
        "set_favorite": "收藏",
        "update_details": "补充详情",
        "rate_food": "评分",
        "cook": "做菜",
        "restock": "补货",
        "consume": "消耗",
        "dispose": "销毁",
        "inventory_operation": "库存处理",
    }.get(action, action or "已处理")


def approval_result_workspace_label(draft_type: str) -> str:
    return {
        "recipe": "菜谱库",
        "recipe_cook": "做菜记录",
        "shopping_list": "购物清单",
        "meal_plan": "菜单计划",
        "meal_log": "餐食记录",
        "food_profile": "食物库",
        "ingredient_profile": "食材库",
        "inventory_operation": "库存页",
        "composite_operation": "相关工作区",
    }.get(draft_type, "对应页面")


def approval_result_count_label(draft_type: str, count: int) -> str:
    nouns = {
        "recipe": "个菜谱",
        "recipe_cook": "条做菜记录",
        "shopping_list": "项采购",
        "meal_plan": "条计划",
        "meal_log": "条餐食记录",
        "food_profile": "个食物",
        "ingredient_profile": "个食材",
        "inventory_operation": "项库存变更",
        "composite_operation": "个复合步骤结果",
    }
    return f"{count} {nouns.get(draft_type, '个实体')}"


def artifact_updated_at(record: dict[str, Any]) -> str | None:
    for key in ("updated_at", "updatedAt", "baseUpdatedAt"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def artifact_summary(record: dict[str, Any], *, fallback_type: str) -> str:
    for key in ("title", "name"):
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    date_value = record.get("date") or record.get("plan_date") or record.get("cook_date")
    meal_type = record.get("meal_type") or record.get("mealType")
    if date_value and meal_type:
        return f"{date_value} {meal_type}"
    if date_value:
        return str(date_value)
    return fallback_type or "business_entity"
