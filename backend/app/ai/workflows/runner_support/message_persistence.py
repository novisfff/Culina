from __future__ import annotations

from typing import Any

from fastapi.encoders import jsonable_encoder

from app.models.domain import AIApprovalRequest, AITaskDraft
from app.services.serializers import serialize_ai_approval_request, serialize_ai_task_draft


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
    existing_draft_ids = list(next_metadata.get("draftIds") or [])
    existing_approval_ids = list(next_metadata.get("approvalIds") or [])
    next_metadata["draftIds"] = [*existing_draft_ids, *[item.id for item in drafts]]
    next_metadata["approvalIds"] = [*existing_approval_ids, *[item.id for item in approvals]]
    return next_metadata


def dedupe_message_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for part in parts:
        if not isinstance(part, dict):
            continue
        part_id = str(part.get("id") or "").strip()
        if part_id:
            if part_id in seen_ids:
                continue
            seen_ids.add(part_id)
        deduped.append(part)
    return deduped


def sync_message_parts_with_current_approval_state(
    parts: list[dict[str, Any]] | None,
    *,
    drafts: list[AITaskDraft],
    approvals: list[AIApprovalRequest],
) -> list[dict[str, Any]]:
    current_parts = [part for part in (parts or []) if isinstance(part, dict)]
    if not current_parts:
        return current_parts
    drafts_by_id = {draft.id: jsonable_encoder(serialize_ai_task_draft(draft)) for draft in drafts}
    approvals_by_id = {approval.id: jsonable_encoder(serialize_ai_approval_request(approval)) for approval in approvals}
    next_parts: list[dict[str, Any]] = []
    for part in current_parts:
        if part.get("type") == "draft":
            draft_id = str((part.get("draft") or {}).get("id") or "")
            current = drafts_by_id.get(draft_id)
            if current is not None and part.get("draft") != current:
                next_parts.append({**part, "draft": current})
                continue
        if part.get("type") == "approval_request":
            approval_id = str((part.get("approval") or {}).get("id") or "")
            current = approvals_by_id.get(approval_id)
            if current is not None and part.get("approval") != current:
                next_parts.append({**part, "approval": current})
                continue
        next_parts.append(part)
    return next_parts


def run_output_payload(
    *,
    text: str,
    cards: list[dict[str, Any]],
    routing: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "text": text,
        "cards": cards,
        "routing": dict(routing or {}),
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
