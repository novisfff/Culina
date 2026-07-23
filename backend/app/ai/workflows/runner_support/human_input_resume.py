from __future__ import annotations

from typing import Any

from app.ai.workflows.state import WorkspaceGraphState


def cancelled_human_input_request_parts(
    parts: list[dict[str, Any]] | None,
    *,
    request_id: str,
    cancelled_at: str,
) -> list[dict[str, Any]]:
    next_parts: list[dict[str, Any]] = []
    for part in parts or []:
        if not isinstance(part, dict):
            continue
        request = part.get("request") if isinstance(part.get("request"), dict) else {}
        if part.get("type") != "human_input_request" or str(request.get("id") or "") != request_id:
            next_parts.append(part)
            continue
        cancelled_part = dict(part)
        cancelled_part.pop("response", None)
        cancelled_part.pop("responded_at", None)
        cancelled_part.update(
            {
                "status": "cancelled",
                "cancelled_at": cancelled_at,
                "cancellation": {
                    "reason": "user_cancel",
                    "message": "已取消这次任务",
                },
            }
        )
        next_parts.append(cancelled_part)
    return next_parts


def human_input_answer_summary(
    pending: dict[str, Any],
    selected_option_ids: list[str],
    text: str,
) -> str:
    options = pending.get("options") if isinstance(pending.get("options"), list) else []
    labels_by_id = {
        str(option.get("id")): str(option.get("label") or "").strip()
        for option in options
        if isinstance(option, dict) and str(option.get("id") or "").strip()
    }
    selected_labels = [
        labels_by_id.get(option_id, option_id)
        for option_id in selected_option_ids
        if option_id
    ]
    values = list(dict.fromkeys(value for value in [*selected_labels, text.strip()] if value))
    return "；".join(values) or "已提交回答"


def human_input_response_payload(
    *,
    selected_option_ids: list[str],
    text: str,
    answer_summary: str,
) -> dict[str, Any]:
    return {
        "selectedOptionIds": selected_option_ids,
        "text": text,
        "summary": answer_summary,
    }


def human_input_result_artifact(
    *,
    pending: dict[str, Any],
    response_payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": f"human_input:{pending['id']}",
        "type": "human.input_result",
        "kind": "human_input",
        "version": 1,
        "status": "completed",
        "payload": {
            "request": pending,
            **response_payload,
        },
    }


def human_input_message_metadata(
    metadata: dict[str, Any] | None,
    *,
    result_artifact: dict[str, Any],
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    artifacts = [item for item in next_metadata.get("artifacts") or [] if isinstance(item, dict)]
    if not any(item.get("id") == result_artifact["id"] for item in artifacts):
        artifacts.append(result_artifact)
    next_metadata["artifacts"] = artifacts
    return next_metadata


def completed_human_input_request_parts(
    parts: list[dict[str, Any]] | None,
    *,
    pending_id: str,
    response_payload: dict[str, Any],
    responded_at: str,
) -> list[dict[str, Any]]:
    next_parts: list[dict[str, Any]] = []
    for part in parts or []:
        if not isinstance(part, dict):
            continue
        request = part.get("request") if isinstance(part.get("request"), dict) else {}
        if part.get("type") == "human_input_request" and str(request.get("id") or "") == pending_id:
            next_parts.append(
                {
                    **part,
                    "status": "completed",
                    "responded_at": responded_at,
                    "response": response_payload,
                }
            )
            continue
        next_parts.append(part)
    return next_parts


def human_input_conversation_context(
    context: dict[str, Any] | None,
    *,
    result_payload: dict[str, Any],
) -> dict[str, Any]:
    next_context = dict(context or {})
    task_state = dict(next_context.get("taskState") or {})
    task_state.pop("pendingHumanInput", None)
    task_state["lastHumanInputResult"] = result_payload
    next_context["taskState"] = task_state
    return next_context


def human_input_resume_state_patch(
    *,
    state: WorkspaceGraphState,
    run_artifacts: list[dict[str, Any]],
    result_artifact: dict[str, Any],
) -> dict[str, Any]:
    return {
        "status": "running",
        "run_artifacts": [*run_artifacts, result_artifact],
        "pending_human_input": {},
        "pending_approval_id": "",
        "last_human_input_result": result_artifact,
        "injected_skill_keys": list(state.get("injected_skill_keys") or []),
        "injection_history": list(state.get("injection_history") or []),
    }
