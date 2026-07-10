from __future__ import annotations

from typing import Any

from app.ai.workflows.orchestrator.profiles import (
    OrchestratorBudgetConfig,
    OrchestratorCapabilityPolicy,
    profile_state_value,
)
from app.ai.workflows.state import WorkspaceGraphState


class ContinuationResumeError(ValueError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


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


def continuation_artifact(
    *,
    run_id: str,
    approval_id: str,
    continuation: dict[str, Any],
    decision_status: str,
    business_entity_ids: list[str],
) -> dict[str, Any]:
    artifact_status = "ready" if decision_status == "approved" else "rejected"
    return {
        "id": (
            f"workflow_continuation:{continuation['workflowId']}:"
            f"{continuation['stepKey']}:{approval_id}"
        ),
        "type": "workflow.continuation",
        "kind": "task_resume",
        "version": 1,
        "status": artifact_status,
        "sourceApprovalId": approval_id,
        "payload": {
            **continuation,
            "status": artifact_status,
            "businessEntityIds": list(dict.fromkeys(business_entity_ids)),
            "sourceRunId": run_id,
        },
    }


def continuation_resume_state(
    *,
    state: WorkspaceGraphState,
    artifact: dict[str, Any],
) -> tuple[list[str], list[dict[str, Any]]]:
    payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
    resume_key = str(payload.get("resumeSkillKey") or "").strip()
    profile_state = state.get("orchestrator_profile") or {}
    capability_policy = OrchestratorCapabilityPolicy.from_state(
        profile_state_value(profile_state, "capabilityPolicy", "capability_policy")
    )
    budget = OrchestratorBudgetConfig.from_state(
        profile_state_value(profile_state, "budgetConfig", "budget_config")
    ).for_capability_policy(capability_policy)
    existing_keys = list(state.get("injected_skill_keys") or [])
    existing_business_keys = [key for key in existing_keys if key != "cooking_assistant"]
    if not capability_policy.allows_skill(resume_key):
        raise ContinuationResumeError("continuation_skill_not_allowed")
    if resume_key not in existing_business_keys and len(existing_business_keys) >= budget.max_business_skills_per_run:
        raise ContinuationResumeError("continuation_skill_budget_exhausted")

    injected_skill_keys = list(dict.fromkeys([*existing_keys, resume_key]))
    injection_history = list(state.get("injection_history") or [])
    if resume_key not in existing_keys:
        injection_history.append(
            {
                "skillKey": resume_key,
                "source": "workflow.continuation",
                "reasonCode": payload.get("reasonCode"),
                "workflowId": payload.get("workflowId"),
                "stepKey": payload.get("stepKey"),
            }
        )
    return injected_skill_keys, injection_history


def continuation_from_metadata(metadata: dict[str, Any]) -> dict[str, Any] | None:
    continuation = metadata.get("continuation")
    return dict(continuation) if isinstance(continuation, dict) else None


def _dedupe_artifacts(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for artifact in artifacts:
        artifact_id = str(artifact.get("id") or "")
        if artifact_id and artifact_id in seen_ids:
            continue
        if artifact_id:
            seen_ids.add(artifact_id)
        deduped.append(artifact)
    return deduped


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
    injected_skill_keys: list[str] | None = None,
    injection_history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    next_run_artifacts = [*run_artifacts, *approval_artifacts]
    if resume_artifact is not None:
        next_run_artifacts.append(resume_artifact)
    return {
        "run_artifacts": _dedupe_artifacts(next_run_artifacts),
        "status": status,
        "last_decision": serialized,
        "pending_approval_id": "",
        "pending_human_input": {},
        "injected_skill_keys": (
            list(injected_skill_keys)
            if injected_skill_keys is not None
            else list(state.get("injected_skill_keys") or [])
        ),
        "injection_history": (
            list(injection_history)
            if injection_history is not None
            else list(state.get("injection_history") or [])
        ),
    }
