from __future__ import annotations

from typing import Any

from fastapi.encoders import jsonable_encoder

from app.models.domain import AIApprovalRequest, AITaskDraft
from app.services.serializers import serialize_ai_approval_request, serialize_ai_task_draft


ROUTED_WITHOUT_APPROVAL_STATUSES = {"auto_executed", "no_change", "execution_failed"}


def operation_result_card_identity(card: dict[str, Any]) -> dict[str, str]:
    data = card.get("data") if isinstance(card.get("data"), dict) else {}
    return {
        "approval_id": str(data.get("approval_id") or data.get("approvalId") or ""),
        "draft_id": str(data.get("draft_id") or data.get("draftId") or ""),
        "operation_id": str(data.get("operation_id") or data.get("operationId") or ""),
    }


def operation_result_decision_identity(decision: dict[str, Any] | None) -> dict[str, str]:
    record = decision if isinstance(decision, dict) else {}
    approval = record.get("approval") if isinstance(record.get("approval"), dict) else {}
    draft = record.get("draft") if isinstance(record.get("draft"), dict) else {}
    operation = record.get("operation") if isinstance(record.get("operation"), dict) else {}
    return {
        "approval_id": str(approval.get("id") or record.get("sourceApprovalId") or ""),
        "draft_id": str(
            draft.get("id")
            or approval.get("draft_id")
            or record.get("sourceDraftId")
            or ""
        ),
        "operation_id": str(operation.get("id") or record.get("sourceOperationId") or ""),
    }


def is_successful_operation_result_card(card: dict[str, Any]) -> bool:
    if card.get("type") != "operation_result":
        return False
    data = card.get("data") if isinstance(card.get("data"), dict) else {}
    result_status = str(data.get("result_status") or data.get("resultStatus") or "").lower()
    operation_status = str(data.get("operation_status") or data.get("operationStatus") or "").lower()
    if result_status == "failed" or operation_status in {"failed", "pending"}:
        return False
    if result_status in {"completed", "no_change", "reverted"}:
        return True
    if operation_status in {"completed", "reverted"}:
        return True
    # Legacy trusted result cards did not carry canonical status aliases.  A
    # caller that supplies an expected identity still has to match at least one
    # durable approval/draft/operation id before this can be treated as success.
    return not result_status and not operation_status


def matching_successful_operation_result_card(
    parts: list[dict[str, Any]],
    *,
    expected_identity: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    expected = {
        key: str(value or "")
        for key, value in (expected_identity or {}).items()
        if str(value or "")
    }
    for part in parts:
        if not isinstance(part, dict) or part.get("type") != "result_card":
            continue
        card = part.get("card") if isinstance(part.get("card"), dict) else {}
        if not is_successful_operation_result_card(card):
            continue
        if not expected:
            return card
        actual = operation_result_card_identity(card)
        comparable_keys = [key for key, value in expected.items() if actual.get(key)]
        if not comparable_keys:
            continue
        if any(actual[key] != expected[key] for key in comparable_keys):
            continue
        if any(actual[key] == expected[key] for key in comparable_keys):
            return card
    return None


def draft_route_status(draft_payload: dict[str, Any]) -> str:
    status = str(draft_payload.get("route_status") or "")
    if status:
        return status
    return "waiting_approval" if draft_payload else ""


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


def operation_result_message_part(
    *,
    draft_id: str,
    card: dict[str, Any],
    part_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": part_id or f"operation-result-part:{draft_id}",
        "type": "result_card",
        "card": card,
    }


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
