from __future__ import annotations

import copy
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import AIApprovalRequest, AIMessage, AITaskDraft
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.result_projection import upsert_message_operation_result
from app.services.ai_timeline import AITimelineService
from app.services.ai_operations.artifacts import (
    approval_decision_artifacts,
    build_approval_result_card,
    business_entity_artifacts,
)
from app.services.serializers import serialize_ai_approval_request, serialize_ai_task_draft


def find_message_operation_result_card(
    db: Session,
    *,
    message_id: str | None,
    draft_id: str,
    family_id: str,
) -> dict[str, Any] | None:
    """Return a detached public operation-result card for one Draft."""
    if not message_id:
        return None
    message = db.scalar(
        select(AIMessage)
        .where(
            AIMessage.id == message_id,
            AIMessage.family_id == family_id,
        )
        .with_for_update()
    )
    if message is None:
        return None
    for part in message.parts or []:
        if part.get("type") != "result_card" or not isinstance(part.get("card"), dict):
            continue
        card = part["card"]
        data = card.get("data") if isinstance(card.get("data"), dict) else {}
        if str(data.get("draft_id") or data.get("draftId") or "") == draft_id:
            return copy.deepcopy(card)
    return None


def sync_message_approval_parts(db: Session, *, draft: AITaskDraft, approval: AIApprovalRequest) -> None:
    if not approval.message_id:
        return
    message = db.get(AIMessage, approval.message_id)
    if message is None:
        return
    draft_record = jsonable_encoder(serialize_ai_task_draft(draft))
    approval_record = jsonable_encoder(serialize_ai_approval_request(approval))
    timeline = AITimelineService(db)
    changed: list[dict[str, Any]] = []
    for part in message.parts:
        if part.get("type") == "draft" and part.get("draft", {}).get("id") == draft.id:
            replacement = {**part, "draft": draft_record}
            changed.append(replacement)
        elif part.get("type") == "approval_request" and part.get("approval", {}).get("id") == approval.id:
            replacement = {**part, "approval": approval_record}
            changed.append(replacement)
    for part in changed:
        timeline.replace_part(
            family_id=message.family_id,
            conversation_id=message.conversation_id,
            message_id=message.id,
            run_id=message.run_id,
            part_id=str(part["id"]),
            part=part,
            created_by=approval.updated_by or draft.updated_by,
            allow_after_terminal=True,
        )
    if approval.status == "cancelled" or draft.status == "cancelled":
        timeline.update_message_status(
            family_id=message.family_id,
            conversation_id=message.conversation_id,
            message_id=message.id,
            run_id=message.run_id,
            status="cancelled",
            created_by=approval.updated_by or draft.updated_by,
        )


def append_message_approval_part(db: Session, *, approval: AIApprovalRequest) -> None:
    if not approval.message_id:
        return
    message = db.get(AIMessage, approval.message_id)
    if message is None:
        return
    if any(part.get("approval", {}).get("id") == approval.id for part in message.parts):
        return
    AITimelineService(db).append_part(
        family_id=message.family_id,
        conversation_id=message.conversation_id,
        message_id=message.id,
        run_id=message.run_id,
        part={
            "id": f"approval-part-{approval.id}",
            "type": "approval_request",
            "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
        },
        created_by=approval.updated_by,
        allow_after_terminal=True,
    )


def persist_message_artifacts(db: Session, *, message_id: str | None, artifacts: list[dict[str, Any]]) -> None:
    if not message_id or not artifacts:
        return
    message = db.get(AIMessage, message_id)
    if message is None:
        return
    encoded_artifacts = [jsonable_encoder(artifact) for artifact in artifacts if isinstance(artifact, dict)]
    if not encoded_artifacts:
        return

    def merge_artifacts(metadata: dict[str, Any]) -> dict[str, Any]:
        next_metadata = dict(metadata)
        existing = [artifact for artifact in next_metadata.get("artifacts") or [] if isinstance(artifact, dict)]
        positions = {
            str(item.get("id") or ""): index
            for index, item in enumerate(existing)
            if str(item.get("id") or "")
        }
        for artifact in encoded_artifacts:
            artifact_id = str(artifact.get("id") or "")
            if not artifact_id:
                continue
            if artifact_id in positions:
                existing[positions[artifact_id]] = artifact
            else:
                positions[artifact_id] = len(existing)
                existing.append(artifact)
        next_metadata["artifacts"] = existing
        return next_metadata

    AITimelineService(db).update_message_metadata(
        family_id=message.family_id,
        conversation_id=message.conversation_id,
        message_id=message.id,
        run_id=message.run_id,
        updater=merge_artifacts,
        created_by=message.created_by,
        # Artifact projection can be refreshed by a revert after the run is
        # terminal; it is still a canonical metadata event, never an ORM-only
        # mutation.
        allow_after_terminal=True,
    )


def append_message_result_card(db: Session, *, decision_result: dict[str, Any]) -> dict[str, Any] | None:
    card = approval_result_card(decision_result)
    if card is None:
        return None
    approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
    draft = decision_result.get("draft") if isinstance(decision_result.get("draft"), dict) else {}
    message_id = str(
        approval.get("message_id")
        or decision_result.get("message_id")
        or draft.get("message_id")
        or ""
    )
    if not message_id:
        return None
    message = db.get(AIMessage, message_id)
    if message is None:
        return None
    parts = [part for part in (message.parts or []) if isinstance(part, dict)]
    existing_part = next(
        (
            part
            for part in parts
            if part.get("type") == "result_card"
            and isinstance(part.get("card"), dict)
            and str(part["card"].get("id") or "") == str(card.get("id") or "")
        ),
        None,
    )
    if existing_part is not None:
        return existing_part
    result_part = {
        "id": f"operation-result-part:{draft.get('id') or card.get('id')}",
        "type": "result_card",
        "card": jsonable_encoder(card),
    }
    AITimelineService(db).append_part(
        family_id=message.family_id,
        conversation_id=message.conversation_id,
        message_id=message.id,
        run_id=message.run_id,
        part=result_part,
        created_by=message.created_by,
        allow_after_terminal=True,
    )
    return result_part


def approval_result_card(decision_result: dict[str, Any]) -> dict[str, Any] | None:
    approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
    draft = decision_result.get("draft") if isinstance(decision_result.get("draft"), dict) else {}
    operation = decision_result.get("operation") if isinstance(decision_result.get("operation"), dict) else {}
    draft_type = str(draft.get("draft_type") or "")
    draft_payload = draft.get("payload") if isinstance(draft.get("payload"), dict) else {}
    if not draft_operation_registry.supports(draft_type):
        return None
    config = draft_operation_registry.approval_config_for_payload(draft_type, draft_payload)
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
