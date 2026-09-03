"""Pure helpers for public message metadata.

These helpers deliberately do not read or write ``AIMessage`` rows.  The
caller must hand their result to :class:`AITimelineService`, which records the
metadata replacement as a canonical timeline event.
"""

from __future__ import annotations

from typing import Any

from app.models.domain import AIApprovalRequest, AITaskDraft


def initial_assistant_message_metadata(
    *,
    intent: str,
    agent_key: str,
    skill_key: str | None,
) -> dict[str, Any]:
    return {
        "intent": intent,
        "agentKey": agent_key,
        "skillKey": skill_key,
    }


def merge_assistant_skill_metadata(
    metadata: dict[str, Any] | None,
    *,
    skill_key: str | None,
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    if not skill_key:
        return next_metadata
    skill_keys = list(next_metadata.get("skillKeys") or [])
    if not skill_keys and next_metadata.get("skillKey"):
        skill_keys.append(str(next_metadata["skillKey"]))
    skill_keys.append(skill_key)
    next_metadata["skillKeys"] = list(dict.fromkeys(item for item in skill_keys if item))
    next_metadata["skillKey"] = skill_key
    return next_metadata


def message_metadata_with_draft_ids(
    metadata: dict[str, Any] | None,
    *,
    drafts: list[AITaskDraft],
    approvals: list[AIApprovalRequest],
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    existing_draft_ids = [str(item) for item in next_metadata.get("draftIds") or [] if str(item)]
    existing_approval_ids = [str(item) for item in next_metadata.get("approvalIds") or [] if str(item)]
    next_metadata["draftIds"] = list(dict.fromkeys([*existing_draft_ids, *[item.id for item in drafts]]))
    next_metadata["approvalIds"] = list(dict.fromkeys([*existing_approval_ids, *[item.id for item in approvals]]))
    return next_metadata


def message_metadata_with_model_usage_fallback(
    metadata: dict[str, Any] | None,
    *,
    fallback_used: bool,
    fallback_reason_code: str | None,
) -> dict[str, Any]:
    next_metadata = dict(metadata or {})
    if not fallback_used:
        next_metadata.pop("modelUsageFallback", None)
        return next_metadata
    next_metadata["modelUsageFallback"] = {
        "used": True,
        "reasonCode": fallback_reason_code,
    }
    return next_metadata


def run_output_payload(
    *,
    text: str,
    cards: list[dict[str, Any]],
    routing: dict[str, Any] | None,
    fallback_used: bool = False,
    fallback_reason_code: str | None = None,
) -> dict[str, Any]:
    return {
        "text": text,
        "cards": cards,
        "routing": dict(routing or {}),
        "model_usage_fallback": {
            "used": bool(fallback_used),
            "reason_code": fallback_reason_code if fallback_used else None,
        },
    }


def conversation_context_with_state_patch(
    context: dict[str, Any] | None,
    *,
    state_patch: dict[str, Any] | None,
) -> dict[str, Any]:
    next_context = dict(context or {})
    next_context.pop("activeRunId", None)
    if not state_patch:
        return next_context
    task_state = dict(next_context.get("taskState") or {})
    for key, value in state_patch.items():
        if value is None:
            task_state.pop(key, None)
        else:
            task_state[key] = value
    next_context["taskState"] = task_state
    return next_context


def append_artifacts(metadata: dict[str, Any] | None, artifacts: list[dict[str, Any]]) -> dict[str, Any]:
    """Return metadata with artifacts upserted by stable artifact id."""

    next_metadata = dict(metadata or {})
    existing = [item for item in next_metadata.get("artifacts") or [] if isinstance(item, dict)]
    positions = {
        str(item.get("id") or ""): index
        for index, item in enumerate(existing)
        if str(item.get("id") or "")
    }
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        artifact_id = str(artifact.get("id") or "")
        if not artifact_id:
            continue
        if artifact_id in positions:
            existing[positions[artifact_id]] = dict(artifact)
        else:
            positions[artifact_id] = len(existing)
            existing.append(dict(artifact))
    next_metadata["artifacts"] = existing
    return next_metadata
