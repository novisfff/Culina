from __future__ import annotations

from typing import Any


def approval_followup_fallback_text(
    decision_result: dict[str, Any],
    *,
    terminal_status: str,
) -> str:
    approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
    operation = decision_result.get("operation") if isinstance(decision_result.get("operation"), dict) else {}
    decision = str(approval.get("decision") or approval.get("status") or "").lower()
    operation_status = str(operation.get("status") or "").lower()
    if terminal_status == "failed" or operation_status == "failed":
        return "这次确认后的处理没有完成，请稍后重试。"
    if decision == "rejected":
        return "已取消这次草稿，不会写入正式数据。你可以继续调整后再让我整理。"
    if operation_status == "succeeded":
        action_summary = str(operation.get("action_summary") or operation.get("summary") or "").strip()
        if action_summary:
            return f"{action_summary} 你可以继续告诉我需要调整的内容。"
        return "已按你的确认完成处理。你可以继续告诉我需要调整的内容。"
    return "这次处理已结束。你可以继续告诉我需要调整的内容。"


def approval_followup_delta_event(
    *,
    message_id: str,
    conversation_id: str,
    run_id: str,
    part_id: str,
    delta: str,
) -> dict[str, Any]:
    return {
        "event": "message_delta",
        "data": {
            "message_id": message_id,
            "conversation_id": conversation_id,
            "run_id": run_id,
            "part_id": part_id,
            "delta": delta,
        },
    }
