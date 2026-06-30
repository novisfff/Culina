from __future__ import annotations

from typing import Any

from app.ai.workflows.state import WorkspaceGraphState


def approval_resume_draft_id(decision_result: dict[str, Any]) -> str:
    draft_record = decision_result.get("draft") if isinstance(decision_result.get("draft"), dict) else {}
    return str(draft_record.get("id") or "")


def approval_resume_payload_from_metadata(metadata: dict[str, Any]) -> dict[str, Any] | None:
    after_approval = metadata.get("afterApproval") if isinstance(metadata.get("afterApproval"), dict) else {}
    resume_payload = dict(after_approval)
    resume_payload.pop("continue", None)
    resume_payload.setdefault(
        "instruction",
        "根据这次确认结果继续对话；如果当前任务已经完成，给出简短总结。",
    )
    return resume_payload


def approval_resume_artifact(
    *,
    run_id: str,
    approval_id: str,
    fallback_resume_id: str,
    resume_payload: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": f"draft_after_approval:{run_id}:{approval_id or fallback_resume_id}",
        "type": "draft_after_approval",
        "kind": "task_resume",
        "version": 1,
        "status": "pending",
        "payload": resume_payload,
    }


def approval_waiting_state_patch(
    *,
    approval_id: str,
    serialized: dict[str, Any],
    run_artifacts: list[dict[str, Any]],
    approval_artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "status": "waiting_approval",
        "pending_approval_id": approval_id,
        "last_decision": serialized,
        "run_artifacts": [*run_artifacts, *approval_artifacts],
    }


def approval_failed_state_patch(
    *,
    serialized: dict[str, Any],
    run_artifacts: list[dict[str, Any]],
    approval_artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "status": "failed",
        "last_decision": serialized,
        "error": "草稿写入失败",
        "run_artifacts": [*run_artifacts, *approval_artifacts],
    }


def approval_resolved_state_patch(
    *,
    state: WorkspaceGraphState,
    serialized: dict[str, Any],
    status: str,
    run_artifacts: list[dict[str, Any]],
    approval_artifacts: list[dict[str, Any]],
    resume_artifact: dict[str, Any] | None = None,
) -> dict[str, Any]:
    next_run_artifacts = [*run_artifacts, *approval_artifacts]
    if resume_artifact is not None:
        next_run_artifacts.append(resume_artifact)
    return {
        "run_artifacts": next_run_artifacts,
        "status": status,
        "last_decision": serialized,
        "pending_approval_id": "",
        "pending_human_input": {},
        "injected_skill_keys": list(state.get("injected_skill_keys") or []),
        "injection_history": list(state.get("injection_history") or []),
    }
