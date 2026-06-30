from __future__ import annotations

from typing import Any

from app.ai.skills import SkillResult


def human_input_question_types(result: SkillResult) -> list[str]:
    if not isinstance(result.context_summary, dict):
        return []
    pending = result.context_summary.get("pendingHumanInput")
    if not isinstance(pending, dict):
        return []
    resume_hint = pending.get("resumeHint") if isinstance(pending.get("resumeHint"), dict) else {}
    question_type = str(resume_hint.get("questionType") or pending.get("questionType") or "").strip()
    return [question_type or "human_input"]


def skill_result_clarification_question_types(result: SkillResult) -> list[str]:
    return human_input_question_types(result)


def skill_execution_record(
    *,
    skill_key: str,
    result: SkillResult,
    draft_count: int,
) -> dict[str, Any]:
    return {
        "skillKey": skill_key,
        "operation": result.operation,
        "sourceArtifactId": result.source_artifact_id,
        "status": result.status,
        "diagnostic": result.diagnostic,
        "requiresClarification": result.requires_clarification,
        "clarificationQuestionTypes": skill_result_clarification_question_types(result),
        "draftCount": draft_count,
    }


def injected_skill_keys_from_context_summary(context_summary: dict[str, Any]) -> list[str]:
    orchestrator_summary = (
        context_summary.get("orchestrator")
        if isinstance(context_summary.get("orchestrator"), dict)
        else {}
    )
    raw_injected_skill_keys = (
        orchestrator_summary.get("injectedSkills")
        if isinstance(orchestrator_summary, dict) and isinstance(orchestrator_summary.get("injectedSkills"), list)
        else []
    )
    return [
        str(item)
        for item in raw_injected_skill_keys
        if str(item)
    ]


def record_skill_observation(
    context_summary: dict[str, Any],
    *,
    skill_key: str | None,
    result: SkillResult,
    draft_count: int,
    approval_count: int,
) -> None:
    metrics = dict(context_summary.get("runMetrics") or {})
    if skill_key:
        metrics["skillExecutionCount"] = int(metrics.get("skillExecutionCount") or 0) + 1
    if result.status == "completed":
        metrics["completedSkillExecutionCount"] = int(metrics.get("completedSkillExecutionCount") or 0) + (1 if skill_key else 0)
    metrics["toolCallCount"] = int(metrics.get("toolCallCount") or 0) + len(result.tool_calls)
    metrics["draftCount"] = int(metrics.get("draftCount") or 0) + draft_count
    metrics["approvalRequestCount"] = int(metrics.get("approvalRequestCount") or 0) + approval_count

    clarification_types = skill_result_clarification_question_types(result)
    if clarification_types:
        metrics["clarificationCount"] = int(metrics.get("clarificationCount") or 0) + len(clarification_types)
        clarification = dict(context_summary.get("clarificationStats") or {})
        reasons = dict(clarification.get("reasons") or {})
        for question_type in clarification_types:
            reasons[question_type] = int(reasons.get(question_type) or 0) + 1
        clarification["count"] = int(clarification.get("count") or 0) + len(clarification_types)
        clarification["reasons"] = reasons
        clarification["lastQuestionTypes"] = clarification_types
        if skill_key:
            by_skill = dict(clarification.get("bySkill") or {})
            by_skill[skill_key] = int(by_skill.get(skill_key) or 0) + len(clarification_types)
            clarification["bySkill"] = by_skill
        context_summary["clarificationStats"] = clarification

    context_summary["runMetrics"] = metrics


def result_context_summary(
    *,
    existing_context_summary: dict[str, Any],
    result: SkillResult,
    skill_key: str | None,
    draft_count: int,
    approval_count: int,
    conversation_context: dict[str, Any] | None,
) -> tuple[dict[str, Any], list[str]]:
    context_summary = dict(existing_context_summary or {})
    context_summary.update(result.context_summary)
    skill_executions = list(context_summary.get("skillExecutions") or [])
    if skill_key:
        skill_executions.append(
            skill_execution_record(
                skill_key=skill_key,
                result=result,
                draft_count=draft_count,
            )
        )

    injected_skill_keys = injected_skill_keys_from_context_summary(context_summary)
    observation_skill_key = skill_key
    if observation_skill_key is None and len(injected_skill_keys) == 1:
        observation_skill_key = injected_skill_keys[0]
    record_skill_observation(
        context_summary,
        skill_key=observation_skill_key,
        result=result,
        draft_count=draft_count,
        approval_count=approval_count,
    )

    if injected_skill_keys:
        routing = dict(context_summary.get("routing") or {})
        routing["skills"] = injected_skill_keys
        context_summary["routing"] = routing
        if not skill_executions:
            skill_executions.extend(
                skill_execution_record(
                    skill_key=key,
                    result=result,
                    draft_count=draft_count,
                )
                for key in injected_skill_keys
            )

    if "lastHumanInputResult" not in context_summary and isinstance(conversation_context, dict):
        task_state = conversation_context.get("taskState") if isinstance(conversation_context.get("taskState"), dict) else {}
        last_human_input_result = task_state.get("lastHumanInputResult") if isinstance(task_state, dict) else None
        if isinstance(last_human_input_result, dict):
            context_summary["lastHumanInputResult"] = last_human_input_result
    if skill_executions:
        context_summary["skillExecutions"] = skill_executions
    return context_summary, injected_skill_keys


def record_approval_outcome_summary(
    context_summary: dict[str, Any],
    *,
    approval_status: str,
    draft_type: str,
) -> dict[str, Any]:
    next_summary = dict(context_summary or {})
    metrics = dict(next_summary.get("runMetrics") or {})
    if approval_status == "approved":
        metrics["approvalApprovedCount"] = int(metrics.get("approvalApprovedCount") or 0) + 1
    elif approval_status == "rejected":
        metrics["approvalRejectedCount"] = int(metrics.get("approvalRejectedCount") or 0) + 1
    next_summary["runMetrics"] = metrics

    approvals = dict(next_summary.get("approvalStats") or {})
    by_draft_type = dict(approvals.get("byDraftType") or {})
    if draft_type:
        bucket = dict(by_draft_type.get(draft_type) or {})
        bucket[approval_status] = int(bucket.get(approval_status) or 0) + 1
        by_draft_type[draft_type] = bucket
    approvals["byDraftType"] = by_draft_type
    approvals["lastDecision"] = {"status": approval_status, "draftType": draft_type or None}
    next_summary["approvalStats"] = approvals
    return next_summary
