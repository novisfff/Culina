from __future__ import annotations

from typing import Any

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIOperation,
    AIRunEvent,
    AIRunLLMExchange,
    AIRunTraceSpan,
    AITaskDraft,
    AIUserApproval,
    MediaAsset,
)


def _retained_run_context(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    run_metrics = value.get("runMetrics")
    return {"runMetrics": dict(run_metrics)} if isinstance(run_metrics, dict) else {}


def purge_ai_conversation_user_data(
    db: Session,
    *,
    family_id: str,
    conversation_id: str,
    expected_run_id: str | None = None,
) -> bool:
    """Delete conversation content while retaining scrubbed operational run audits."""
    conversation = db.scalar(
        select(AIConversation).where(
            AIConversation.id == conversation_id,
            AIConversation.family_id == family_id,
        )
    )
    if conversation is None:
        return False

    runs = list(
        db.scalars(
            select(AIAgentRun).where(
                AIAgentRun.conversation_id == conversation_id,
                AIAgentRun.family_id == family_id,
            )
        )
    )
    if expected_run_id is not None and all(run.id != expected_run_id for run in runs):
        return False

    run_ids = [run.id for run in runs]
    message_ids = list(
        db.scalars(
            select(AIMessage.id).where(
                AIMessage.conversation_id == conversation_id,
                AIMessage.family_id == family_id,
            )
        )
    )
    approval_ids = list(
        db.scalars(
            select(AIApprovalRequest.id).where(
                AIApprovalRequest.conversation_id == conversation_id,
                AIApprovalRequest.family_id == family_id,
            )
        )
    )
    draft_ids = list(
        db.scalars(
            select(AITaskDraft.id).where(
                AITaskDraft.conversation_id == conversation_id,
                AITaskDraft.family_id == family_id,
            )
        )
    )

    if message_ids:
        db.execute(
            update(MediaAsset)
            .where(
                MediaAsset.family_id == family_id,
                MediaAsset.entity_type == "ai_message",
                MediaAsset.entity_id.in_(message_ids),
            )
            .values(entity_type=None, entity_id=None)
        )
    if approval_ids:
        db.execute(
            delete(AIOperation).where(
                AIOperation.approval_request_id.in_(approval_ids),
                AIOperation.family_id == family_id,
            )
        )
        db.execute(
            delete(AIUserApproval).where(
                AIUserApproval.approval_request_id.in_(approval_ids),
                AIUserApproval.family_id == family_id,
            )
        )
        db.execute(
            delete(AIApprovalRequest).where(
                AIApprovalRequest.id.in_(approval_ids),
                AIApprovalRequest.family_id == family_id,
            )
        )
    if draft_ids:
        db.execute(
            delete(AITaskDraft).where(
                AITaskDraft.id.in_(draft_ids),
                AITaskDraft.family_id == family_id,
            )
        )

    event_scope = AIRunEvent.conversation_id == conversation_id
    if run_ids:
        event_scope = or_(event_scope, AIRunEvent.run_id.in_(run_ids))
    db.execute(
        delete(AIRunEvent).where(
            AIRunEvent.family_id == family_id,
            event_scope,
        )
    )
    db.execute(
        delete(AIMessage).where(
            AIMessage.conversation_id == conversation_id,
            AIMessage.family_id == family_id,
        )
    )

    for run in runs:
        run.conversation_id = None
        run.message_id = None
        run.input_summary = ""
        run.context_summary = _retained_run_context(run.context_summary)
        run.output_summary = ""
        run.input = {}
        run.output = {}
        run.tool_calls = []
        run.error = None

    if run_ids:
        db.execute(
            update(AIRunTraceSpan)
            .where(
                AIRunTraceSpan.family_id == family_id,
                AIRunTraceSpan.run_id.in_(run_ids),
            )
            .values(
                conversation_id=None,
                input_summary={},
                output_summary={},
                error_message=None,
                exception_type=None,
                payload={},
            )
        )
        db.execute(
            update(AIRunLLMExchange)
            .where(
                AIRunLLMExchange.family_id == family_id,
                AIRunLLMExchange.run_id.in_(run_ids),
            )
            .values(
                conversation_id=None,
                request_messages=[],
                request_tools=[],
                request_options={},
                request_original_digest="",
                request_digest="",
                response_message={},
                response_text=None,
                response_tool_calls=[],
                stream_chunks=[],
                response_original_digest="",
                response_digest="",
                error_message=None,
            )
        )

    SQLAlchemyCheckpointSaver(db).delete_thread(conversation_id)
    db.delete(conversation)
    return True
