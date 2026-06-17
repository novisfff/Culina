from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.models.domain import AIApprovalRequest, AITaskDraft
from app.services.ai_operations.approval_config import DRAFT_APPROVAL_CONFIG, approval_config_for_payload
from app.services.ai_operations.composite import validate_composite_operation_shape
from app.services.ai_operations.drafts import (
    normalize_ai_draft_payload,
    validate_inventory_operation_shape,
    validate_operation_draft_shape,
    validate_single_target_operation_shape,
)


ResolveUserId = Callable[[str], str | None]


def validate_rejection_values(approval: AIApprovalRequest, values: dict[str, Any]) -> dict[str, Any]:
    allowed = {field["name"] for field in approval.field_schema if isinstance(field.get("name"), str)}
    unknown = set(values) - allowed
    if unknown:
        raise ValueError(f"确认表单包含未知字段：{', '.join(sorted(unknown))}")
    return {}


def validate_approval_values(
    db: Session,
    *,
    approval: AIApprovalRequest,
    draft: AITaskDraft,
    values: dict[str, Any],
    resolve_user_id: ResolveUserId,
    enforce_required: bool = True,
) -> dict[str, Any]:
    fields = [field for field in approval.field_schema if isinstance(field.get("name"), str)]
    allowed = {field["name"] for field in fields}
    unknown = set(values) - allowed
    if unknown:
        raise ValueError(f"确认表单包含未知字段：{', '.join(sorted(unknown))}")
    for field in fields:
        _validate_approval_field(field, values, enforce_required=enforce_required)
    if draft.draft_type not in DRAFT_APPROVAL_CONFIG:
        raise ValueError("暂不支持的草稿类型")
    config = approval_config_for_payload(draft.draft_type, draft.payload)
    value_key = config["value_key"]
    draft_value = values.get(value_key, draft.payload)
    if draft.draft_type == "inventory_operation":
        validate_inventory_operation_shape(draft.payload, draft_value)
    elif draft.draft_type in {"meal_plan", "shopping_list"}:
        validate_operation_draft_shape(draft.payload, draft_value)
    elif draft.draft_type == "ingredient_profile":
        validate_single_target_operation_shape(draft.payload, draft_value)
    elif draft.draft_type == "composite_operation":
        validate_composite_operation_shape(draft.payload, draft_value)
    return {
        value_key: normalize_ai_draft_payload(
            db,
            draft_type=draft.draft_type,
            family_id=draft.family_id,
            user_id=resolve_user_id(draft.conversation_id),
            conversation_id=draft.conversation_id,
            payload=draft_value,
        )
    }


def _validate_approval_field(field: dict[str, Any], values: dict[str, Any], *, enforce_required: bool) -> None:
    name = str(field["name"])
    if enforce_required and field.get("required") and name not in values:
        raise ValueError(f"{field.get('label') or name} 不能为空")
    if name not in values:
        return
    value = values[name]
    if enforce_required and field.get("required") and (value is None or value == "" or value == []):
        raise ValueError(f"{field.get('label') or name} 不能为空")
    if name in {"recipe", "draft"}:
        return

    expected_type = field.get("type")
    if expected_type == "string" and not isinstance(value, str):
        raise ValueError(f"{field.get('label') or name} 必须是文本")
    if expected_type == "number" and not isinstance(value, int | float):
        raise ValueError(f"{field.get('label') or name} 必须是数字")
    if expected_type == "integer" and not isinstance(value, int):
        raise ValueError(f"{field.get('label') or name} 必须是整数")
    if expected_type == "boolean" and not isinstance(value, bool):
        raise ValueError(f"{field.get('label') or name} 必须是布尔值")
    if expected_type == "array" and not isinstance(value, list):
        raise ValueError(f"{field.get('label') or name} 必须是数组")
    if expected_type == "object" and not isinstance(value, dict):
        raise ValueError(f"{field.get('label') or name} 必须是对象")

    widget = field.get("widget")
    if widget in {"select", "radio", "checkbox_group"}:
        allowed_values = {
            option.get("value") if isinstance(option, dict) else option
            for option in (field.get("options") or [])
        }
        submitted_values = value if isinstance(value, list) else [value]
        if allowed_values and any(item not in allowed_values for item in submitted_values):
            raise ValueError(f"{field.get('label') or name} 包含不支持的选项")
    if widget == "date" and isinstance(value, str):
        from datetime import date

        try:
            date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"{field.get('label') or name} 必须是有效日期") from exc
    if widget == "time" and isinstance(value, str):
        from datetime import time

        try:
            time.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(f"{field.get('label') or name} 必须是有效时间") from exc
