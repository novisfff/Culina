from __future__ import annotations

from typing import Any

from fastapi.encoders import jsonable_encoder

from app.models.domain import AIApprovalRequest, AITaskDraft
from app.services.serializers import serialize_ai_approval_request, serialize_ai_task_draft


def draft_message_part(draft: AITaskDraft) -> dict[str, Any]:
    return {
        "id": f"draft-part-{draft.id}",
        "type": "draft",
        "draft": jsonable_encoder(serialize_ai_task_draft(draft)),
    }


def approval_request_message_part(approval: AIApprovalRequest) -> dict[str, Any]:
    return {
        "id": f"approval-part-{approval.id}",
        "type": "approval_request",
        "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
    }


def result_card_message_part(*, part_id: str, card: dict[str, Any]) -> dict[str, Any]:
    return {"id": part_id, "type": "result_card", "card": card}


def human_input_request_message_part(*, part_id: str, request: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": part_id,
        "type": "human_input_request",
        "request": request,
    }


def text_message_part(*, part_id: str, text: str) -> dict[str, Any]:
    return {"id": part_id, "type": "text", "text": text}


def append_progressive_draft_metadata(
    metadata: dict[str, Any],
    *,
    draft_id: str,
    approval_id: str,
) -> dict[str, Any]:
    return {
        **metadata,
        "progressiveDraftIds": [
            *[str(item) for item in metadata.get("progressiveDraftIds") or [] if str(item)],
            draft_id,
        ],
        "progressiveApprovalIds": [
            *[str(item) for item in metadata.get("progressiveApprovalIds") or [] if str(item)],
            approval_id,
        ],
    }


def missing_draft_approval_message_parts(
    existing_parts: list[dict[str, Any]],
    *,
    draft: AITaskDraft,
    approval: AIApprovalRequest,
) -> list[dict[str, Any]]:
    existing_part_ids = {
        str(part.get("id") or "")
        for part in existing_parts
        if isinstance(part, dict)
    }
    parts: list[dict[str, Any]] = []
    draft_part = draft_message_part(draft)
    if draft_part["id"] not in existing_part_ids:
        parts.append(draft_part)
    approval_part = approval_request_message_part(approval)
    if approval_part["id"] not in existing_part_ids:
        parts.append(approval_part)
    return parts


def aggregate_text_from_parts(parts: list[dict[str, Any]]) -> str:
    text_parts = [
        str(part.get("text") or "").strip()
        for part in parts
        if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
    ]
    return "\n\n".join(text_parts)


def result_cards_from_parts(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        part["card"]
        for part in parts
        if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
    ]


def terminal_message_text(
    *,
    content: str | None,
    parts: list[dict[str, Any]],
    status: str,
) -> str:
    text = str(content or "").strip()
    if text:
        return text
    aggregate_text = aggregate_text_from_parts(parts)
    if aggregate_text:
        return aggregate_text
    if status == "failed":
        return "AI 工作台暂时失败，请重试。"
    if status == "cancelled":
        return "已中止这次处理。"
    return "任务已完成。"
