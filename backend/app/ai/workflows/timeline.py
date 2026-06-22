from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import AIMessage, AITaskDraft


def build_planner_conversation(
    db: Session,
    *,
    family_id: str,
    conversation_id: str,
    quick_task: str | None = None,
    pending_user_message: str | None = None,
    limit: int = 12,
) -> list[dict[str, Any]]:
    recent = list(
        db.scalars(
            select(AIMessage)
            .where(
                AIMessage.family_id == family_id,
                AIMessage.conversation_id == conversation_id,
            )
            .order_by(AIMessage.created_at.desc())
            .limit(limit)
        )
    )
    pending_drafts = list(
        db.scalars(
            select(AITaskDraft).where(
                AITaskDraft.family_id == family_id,
                AITaskDraft.conversation_id == conversation_id,
                AITaskDraft.status == "pending",
            )
        )
    )
    message_ids = {message.id for message in recent}
    required_message_ids = {draft.message_id for draft in pending_drafts if draft.message_id and draft.message_id not in message_ids}
    if required_message_ids:
        recent.extend(
            db.scalars(
                select(AIMessage).where(
                    AIMessage.family_id == family_id,
                    AIMessage.conversation_id == conversation_id,
                    AIMessage.id.in_(required_message_ids),
                )
            )
        )
    all_message_ids = {message.id for message in recent}
    drafts = list(
        db.scalars(
            select(AITaskDraft).where(
                AITaskDraft.family_id == family_id,
                AITaskDraft.conversation_id == conversation_id,
                AITaskDraft.message_id.in_(all_message_ids),
            )
        )
    ) if all_message_ids else []
    drafts_by_message: dict[str, list[AITaskDraft]] = {}
    for draft in drafts:
        if draft.message_id:
            if draft.message_id not in drafts_by_message:
                drafts_by_message[draft.message_id] = []
            drafts_by_message[draft.message_id].append(draft)
    timeline: list[dict[str, Any]] = []
    for message in sorted(recent, key=lambda item: (item.created_at.timestamp(), item.id)):
        metadata = dict(message.message_metadata or {})
        if quick_task and message.role == "user" and message is recent[0]:
            metadata["quickTask"] = quick_task
        persisted_artifacts = [artifact for artifact in metadata.get("artifacts") or [] if isinstance(artifact, dict)]
        timeline.append(
            {
                "id": message.id,
                "role": message.role,
                "content": message.content,
                "metadata": metadata,
                "artifacts": [
                    *[
                        {
                            "id": draft.id,
                            "type": draft.draft_type,
                            "version": draft.version,
                            "status": draft.status,
                            "payload": draft.payload,
                        }
                        for draft in sorted(drafts_by_message.get(message.id, []), key=lambda item: item.created_at)
                    ],
                    *persisted_artifacts,
                ],
            }
        )
    if pending_user_message:
        timeline.append(
            {
                "id": "pending-user-message",
                "role": "user",
                "content": pending_user_message,
                "metadata": {"quickTask": quick_task},
                "artifacts": [],
            }
        )
    return timeline
