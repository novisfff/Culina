from __future__ import annotations

from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.core.utils import create_id
from app.models.domain import AIApprovalRequest, AIMessage, AITaskDraft
from app.services.ai_operations.approval_config import DRAFT_APPROVAL_CONFIG, approval_config_for_payload
from app.services.ai_operations.artifacts import (
    approval_decision_artifacts,
    build_approval_result_card,
    business_entity_artifacts,
)
from app.services.serializers import serialize_ai_approval_request, serialize_ai_task_draft


def sync_message_approval_parts(db: Session, *, draft: AITaskDraft, approval: AIApprovalRequest) -> None:
    if not approval.message_id:
        return
    message = db.get(AIMessage, approval.message_id)
    if message is None:
        return
    draft_record = jsonable_encoder(serialize_ai_task_draft(draft))
    approval_record = jsonable_encoder(serialize_ai_approval_request(approval))
    next_parts: list[dict[str, Any]] = []
    for part in message.parts:
        if part.get("type") == "draft" and part.get("draft", {}).get("id") == draft.id:
            next_parts.append({**part, "draft": draft_record})
        elif part.get("type") == "approval_request" and part.get("approval", {}).get("id") == approval.id:
            next_parts.append({**part, "approval": approval_record})
        else:
            next_parts.append(part)
    message.parts = next_parts


def append_message_approval_part(db: Session, *, approval: AIApprovalRequest) -> None:
    if not approval.message_id:
        return
    message = db.get(AIMessage, approval.message_id)
    if message is None:
        return
    if any(part.get("approval", {}).get("id") == approval.id for part in message.parts):
        return
    message.parts = [
        *message.parts,
        {
            "id": create_id("ai_part"),
            "type": "approval_request",
            "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
        },
    ]


def persist_message_artifacts(db: Session, *, message_id: str | None, artifacts: list[dict[str, Any]]) -> None:
    if not message_id or not artifacts:
        return
    message = db.get(AIMessage, message_id)
    if message is None:
        return
    metadata = dict(message.message_metadata or {})
    existing = [artifact for artifact in metadata.get("artifacts") or [] if isinstance(artifact, dict)]
    seen = {str(item.get("id") or "") for item in existing}
    next_artifacts = list(existing)
    for artifact in artifacts:
        artifact_id = str(artifact.get("id") or "")
        if not artifact_id or artifact_id in seen:
            continue
        next_artifacts.append(jsonable_encoder(artifact))
        seen.add(artifact_id)
    metadata["artifacts"] = next_artifacts
    message.message_metadata = metadata


def append_message_result_card(db: Session, *, decision_result: dict[str, Any]) -> None:
    card = approval_result_card(decision_result)
    if card is None:
        return
    approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
    message_id = str(approval.get("message_id") or "")
    if not message_id:
        return
    message = db.get(AIMessage, message_id)
    if message is None:
        return
    parts = [part for part in (message.parts or []) if isinstance(part, dict)]
    if any(
        part.get("type") == "result_card"
        and isinstance(part.get("card"), dict)
        and str(part["card"].get("id") or "") == str(card.get("id") or "")
        for part in parts
    ):
        return
    message.parts = [
        *parts,
        {
            "id": create_id("ai_part"),
            "type": "result_card",
            "card": jsonable_encoder(card),
        },
    ]


def approval_result_card(decision_result: dict[str, Any]) -> dict[str, Any] | None:
    approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
    draft = decision_result.get("draft") if isinstance(decision_result.get("draft"), dict) else {}
    operation = decision_result.get("operation") if isinstance(decision_result.get("operation"), dict) else {}
    draft_type = str(draft.get("draft_type") or "")
    draft_payload = draft.get("payload") if isinstance(draft.get("payload"), dict) else {}
    if draft_type not in DRAFT_APPROVAL_CONFIG:
        return None
    config = approval_config_for_payload(draft_type, draft_payload)
    return build_approval_result_card(
        approval=approval,
        draft=draft,
        operation=operation,
        draft_config=config,
        business_artifacts=business_entity_artifacts_for_decision(decision_result),
    )


def approval_decision_artifacts_for_decision(decision_result: dict[str, Any]) -> list[dict[str, Any]]:
    approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
    draft = decision_result.get("draft") if isinstance(decision_result.get("draft"), dict) else {}
    operation = decision_result.get("operation") if isinstance(decision_result.get("operation"), dict) else {}
    business_entity = decision_result.get("business_entity")
    return approval_decision_artifacts(
        approval=approval,
        draft=draft,
        operation=operation,
        business_entity=business_entity,
    )


def business_entity_artifacts_for_decision(decision_result: dict[str, Any]) -> list[dict[str, Any]]:
    approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
    draft = decision_result.get("draft") if isinstance(decision_result.get("draft"), dict) else {}
    operation = decision_result.get("operation") if isinstance(decision_result.get("operation"), dict) else {}
    business_entity = decision_result.get("business_entity")
    return business_entity_artifacts(
        approval=approval,
        draft=draft,
        operation=operation,
        business_entity=business_entity,
    )
