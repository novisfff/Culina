from __future__ import annotations

import re
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.services.ai_operations.registry import draft_operation_registry


def build_failure_summary(
    db: Session,
    *,
    family_id: str,
    draft_type: str,
    payload: dict[str, Any],
    error_message: str,
) -> dict[str, Any]:
    summary: dict[str, Any] = {"errorMessage": error_message}
    operations = payload.get("operations")
    if not isinstance(operations, list):
        return summary
    failed_operation_id = extract_failed_operation_id(error_message)
    selected = [
        operation
        for operation in operations
        if isinstance(operation, dict)
        and (failed_operation_id is None or str(operation.get("operationId") or "") == failed_operation_id)
    ]
    if not selected and failed_operation_id:
        selected = [{"operationId": failed_operation_id}]
    if not selected:
        return summary
    summary["failedOperationIds"] = [
        str(operation.get("operationId") or "")
        for operation in selected
        if str(operation.get("operationId") or "").strip()
    ]
    summary["failedOperationSummaries"] = [
        operation_failure_record(
            db,
            family_id=family_id,
            draft_type=draft_type,
            operation=operation,
            error_message=error_message,
        )
        for operation in selected
    ]
    return summary


def extract_failed_operation_id(error_message: str) -> str | None:
    match = re.search(r"操作\s+([A-Za-z0-9_-]+)\s+失败", error_message)
    return match.group(1) if match else None


def operation_failure_record(
    db: Session,
    *,
    family_id: str,
    draft_type: str,
    operation: dict[str, Any],
    error_message: str,
) -> dict[str, Any]:
    payload = operation.get("payload") if isinstance(operation.get("payload"), dict) else {}
    before = operation.get("before") if isinstance(operation.get("before"), dict) else {}
    title = (
        payload.get("title")
        or payload.get("name")
        or before.get("title")
        or before.get("food_name")
        or before.get("name")
        or operation.get("targetId")
        or "未命名对象"
    )
    action = str(operation.get("action") or "")
    action_label = {
        "create": "新增",
        "update": "更新",
        "delete": "删除",
        "set_status": "状态变更",
        "set_done": "状态变更",
    }.get(action, action or "操作")
    has_conflict = "冲突" in error_message or "更新" in error_message or "baseUpdatedAt" in error_message
    current_value = load_operation_current_value(
        db,
        family_id=family_id,
        draft_type=draft_type,
        target_id=str(operation.get("targetId") or ""),
    )
    return {
        "operationId": operation.get("operationId"),
        "action": action,
        "targetId": operation.get("targetId"),
        "summary": f"{action_label} {title}",
        "currentValue": jsonable_encoder(current_value) if current_value is not None else None,
        "recoveryHint": operation_recovery_hint(
            draft_type=draft_type,
            action=action,
            has_conflict=has_conflict,
            has_current_value=current_value is not None,
        ),
    }


def operation_recovery_hint(*, draft_type: str, action: str, has_conflict: bool, has_current_value: bool) -> str:
    if has_conflict and has_current_value:
        return "当前业务值已经变化，建议先核对下面的最新内容；如果只是时间或状态被别人改过，请按最新值调整草稿后重试。"
    if action == "delete":
        return "如果目标已经不存在，无需再次删除；可以直接放弃这条草稿，或重新整理剩余操作。"
    return draft_operation_registry.recovery_hint(draft_type)


def load_operation_current_value(
    db: Session,
    *,
    family_id: str,
    draft_type: str,
    target_id: str,
) -> dict[str, Any] | None:
    return draft_operation_registry.load_current_value(
        db,
        family_id=family_id,
        draft_type=draft_type,
        target_id=target_id,
    )
