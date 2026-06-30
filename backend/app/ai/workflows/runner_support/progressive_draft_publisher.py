from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIExecutionCancelled
from app.ai.observability.tracer import AIRunTracer
from app.ai.workflows.runner_support.message_parts import (
    append_progressive_draft_metadata,
    approval_request_message_part,
    draft_message_part,
)
from app.ai.workflows.runner_support.run_status import RUNNING, WAITING_APPROVAL
from app.ai.workflows.state import WorkspaceGraphState
from app.core.utils import create_id
from app.models.domain import AIAgentRun, AIConversation, AIMessage


class ProgressiveDraftPublisher:
    def __init__(
        self,
        *,
        db: Session,
        service: Any,
        cancel_requested: Callable[[str], bool],
        commit_stream_checkpoint: Callable[..., bool],
        optional_stream_writer: Callable[[], Any],
        persistent_progress_writer: Callable[[Any, WorkspaceGraphState], Any],
    ) -> None:
        self.db = db
        self.service = service
        self.cancel_requested = cancel_requested
        self.commit_stream_checkpoint = commit_stream_checkpoint
        self.optional_stream_writer = optional_stream_writer
        self.persistent_progress_writer = persistent_progress_writer

    def create_publisher(
        self,
        state: WorkspaceGraphState,
        *,
        tracer: AIRunTracer | None = None,
        parent_span_id: str | None = None,
        round_index: int | None = None,
    ) -> Callable[[dict[str, Any]], dict[str, Any]]:
        def publish(draft_payload: dict[str, Any]) -> dict[str, Any]:
            if self.cancel_requested(state["run_id"]):
                raise AIExecutionCancelled("AI run was cancelled")
            span = self._start_span(
                tracer=tracer,
                draft_payload=draft_payload,
                parent_span_id=parent_span_id,
                round_index=round_index,
            )
            message = self._ensure_assistant_message(state)
            draft, approval = self.service._create_draft_approval(
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                draft_payload=draft_payload,
            )
            self.mark_waiting_approval_state(state)
            draft_part = draft_message_part(draft)
            approval_part = approval_request_message_part(approval)
            message.message_metadata = append_progressive_draft_metadata(
                dict(message.message_metadata or {}),
                draft_id=draft.id,
                approval_id=approval.id,
            )
            self.db.flush()
            if not self.commit_stream_checkpoint(state, run_status=WAITING_APPROVAL):
                if span is not None:
                    span.finish(
                        status="failed",
                        error_code="stream_checkpoint_failed",
                        error_message="draft approval checkpoint failed",
                    )
                raise RuntimeError("确认请求持久化失败，请稍后重试")
            self._emit_parts(state, message_id=message.id, parts=(draft_part, approval_part))
            result = {
                "draft_id": draft.id,
                "approval_id": approval.id,
                "published_part_ids": [draft_part["id"], approval_part["id"]],
            }
            if span is not None:
                span.finish(
                    status="waiting",
                    output_summary={
                        "draftId": draft.id,
                        "approvalId": approval.id,
                        "messageId": message.id,
                        "publishedPartIds": result["published_part_ids"],
                    },
                )
            return result

        return publish

    @staticmethod
    def _start_span(
        *,
        tracer: AIRunTracer | None,
        draft_payload: dict[str, Any],
        parent_span_id: str | None,
        round_index: int | None,
    ):
        if tracer is None:
            return None
        return tracer.start_span(
            "draft_publish",
            str(draft_payload.get("draft_type") or draft_payload.get("tool") or "draft"),
            parent_span_id=parent_span_id,
            round_index=round_index,
            input_summary={
                "draftType": draft_payload.get("draft_type"),
                "schemaVersion": draft_payload.get("schema_version"),
                "tool": draft_payload.get("tool"),
            },
        )

    def _ensure_assistant_message(self, state: WorkspaceGraphState) -> AIMessage:
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        if message is not None:
            return message
        message = AIMessage(
            id=create_id("ai_message"),
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            role="assistant",
            content="",
            content_type="parts",
            parts=[],
            run_id=state["run_id"],
            status=RUNNING,
            message_metadata={
                "intent": "workspace_orchestrator",
                "agentKey": "workspace_orchestrator",
                "skillKey": None,
            },
            created_by=state["user_id"],
        )
        self.db.add(message)
        self.db.flush()
        return message

    def mark_waiting_approval_state(self, state: WorkspaceGraphState) -> None:
        run = self.db.get(AIAgentRun, state["run_id"])
        if run is not None:
            run.status = WAITING_APPROVAL
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if conversation is not None:
            conversation.last_run_status = WAITING_APPROVAL
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        if message is not None:
            message.status = WAITING_APPROVAL
        self.db.flush()

    def _emit_parts(
        self,
        state: WorkspaceGraphState,
        *,
        message_id: str,
        parts: tuple[dict[str, Any], dict[str, Any]],
    ) -> None:
        for part in parts:
            writer = self.persistent_progress_writer(self.optional_stream_writer(), state)
            if writer is not None:
                writer(
                    {
                        "event": "message_part",
                        "data": {
                            "message_id": message_id,
                            "conversation_id": state["conversation_id"],
                            "run_id": state["run_id"],
                            "part": part,
                        },
                    }
                )
