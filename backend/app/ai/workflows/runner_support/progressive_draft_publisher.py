from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
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
from app.ai.workflows.runner_support.run_status import WAITING_APPROVAL
from app.ai.workflows.state import WorkspaceGraphState
from app.core.utils import utcnow
from app.models.domain import AIAgentRun, AIApprovalRequest, AIConversation, AIMessage, AITaskDraft
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)
from app.services.ai_operations.routing import DraftRouteRequest, route_draft
from app.services.ai_operations.result_projection import hydrate_operation_result_server_now
from app.services.ai_auto_execution.policy_types import DraftRouteOutcome
from app.services.ai_timeline import AITimelineService


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
        registered_revert_adapters: frozenset[str] = frozenset(),
    ) -> None:
        self.db = db
        self.service = service
        self.cancel_requested = cancel_requested
        self.commit_stream_checkpoint = commit_stream_checkpoint
        self.optional_stream_writer = optional_stream_writer
        self.persistent_progress_writer = persistent_progress_writer
        self.registered_revert_adapters = registered_revert_adapters
        self.timeline = AITimelineService(db)

    def create_publisher(
        self,
        state: WorkspaceGraphState,
        *,
        tracer: AIRunTracer | None = None,
        parent_span_id: str | None = None,
        round_index: int | None = None,
    ) -> Callable[[dict[str, Any]], dict[str, Any]]:
        def publish(draft_payload: dict[str, Any]) -> dict[str, Any]:
            run = lock_run_for_transition(
                self.db,
                family_id=state["family_id"],
                run_id=state["run_id"],
            )
            if cancellation_wins(self.db, run=run):
                finalize_run_cancellation(self.db, run=run)
                raise AIExecutionCancelled("AI run was cancelled")
            span = self._start_span(
                tracer=tracer,
                draft_payload=draft_payload,
                parent_span_id=parent_span_id,
                round_index=round_index,
            )
            message = self._ensure_assistant_message(state)
            draft_type = str(draft_payload.get("draft_type") or "")
            payload = self.service._validate_draft_payload(
                draft_type=draft_type,
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                payload=dict(draft_payload.get("payload") or {}),
            )
            outcome = route_draft(
                self.db,
                DraftRouteRequest(
                    family_id=state["family_id"],
                    actor_user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    message_id=message.id,
                    run_id=state["run_id"],
                    draft_type=draft_type,
                    payload=payload,
                    intent_evidence_input=(
                        dict(draft_payload["intent_evidence_input"])
                        if isinstance(draft_payload.get("intent_evidence_input"), dict)
                        else None
                    ),
                    schema_version=str(
                        draft_payload.get("schema_version") or f"{draft_type}.v1"
                    ),
                    tool_name=str(draft_payload.get("tool") or ""),
                    skill_approval_policy=str(
                        draft_payload.get("skill_approval_policy") or "draft_then_confirm"
                    ),
                    current_message=str(state.get("message") or ""),
                    trusted_resolution_sources=dict(
                        draft_payload.get("trusted_resolution_sources") or {}
                    ),
                    continuation=(
                        dict(draft_payload["continuation"])
                        if isinstance(draft_payload.get("continuation"), dict)
                        else {}
                    ),
                ),
                registered_revert_adapters=self.registered_revert_adapters,
            )
            draft = self.db.get(AITaskDraft, outcome.draft_id)
            if draft is None:
                raise RuntimeError("草稿路由完成后没有持久化草稿")
            parts: tuple[dict[str, Any], ...]
            if outcome.status == "waiting_approval":
                approval = self.db.get(AIApprovalRequest, outcome.approval_id)
                if approval is None:
                    raise RuntimeError("草稿路由完成后没有持久化确认请求")
                self.mark_waiting_approval_state(state)
                draft_part = draft_message_part(draft)
                approval_part = approval_request_message_part(approval)
                parts = (draft_part, approval_part)
                outcome = replace(
                    outcome,
                    published_part_ids=(draft_part["id"], approval_part["id"]),
                )
                self.timeline.update_message_metadata(
                    family_id=state["family_id"],
                    conversation_id=state["conversation_id"],
                    message_id=message.id,
                    run_id=state["run_id"],
                    metadata=append_progressive_draft_metadata(
                        dict(message.message_metadata or {}),
                        draft_id=draft.id,
                        approval_id=approval.id,
                    ),
                    created_by=state.get("user_id"),
                )
            else:
                part_ids = set(outcome.published_part_ids)
                parts = tuple(
                    part
                    for part in message.parts or []
                    if isinstance(part, dict) and str(part.get("id") or "") in part_ids
                )
            _update_published_outcome(draft, outcome)
            self.db.flush()
            checkpoint_status = WAITING_APPROVAL if outcome.status == "waiting_approval" else outcome.status
            if not self.commit_stream_checkpoint(state, run_status=checkpoint_status):
                if span is not None:
                    span.finish(
                        status="failed",
                        error_code="stream_checkpoint_failed",
                        error_message="draft approval checkpoint failed",
                    )
                raise RuntimeError("确认请求持久化失败，请稍后重试")
            self._emit_parts(state, message_id=message.id, parts=parts)
            result = {
                "draft_id": outcome.draft_id,
                "approval_id": outcome.approval_id,
                "operation_id": outcome.operation_id,
                "route_status": outcome.status,
                "route_outcome": outcome,
                "published_part_ids": list(outcome.published_part_ids),
            }
            if span is not None:
                span.finish(
                    status="waiting",
                    output_summary={
                        "draftId": draft.id,
                        "approvalId": outcome.approval_id,
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
        message_id = str(state.get("assistant_message_id") or "").strip()
        if not message_id:
            raise RuntimeError("草稿发布缺少 canonical assistant_message_id")
        message = self.db.scalar(
            select(AIMessage)
            .where(
                AIMessage.id == message_id,
                AIMessage.family_id == state["family_id"],
                AIMessage.conversation_id == state["conversation_id"],
                AIMessage.run_id == state["run_id"],
                AIMessage.role == "assistant",
            )
        )
        if message is not None:
            return message
        raise RuntimeError("预创建的 canonical 助手消息不存在")

    def mark_waiting_approval_state(self, state: WorkspaceGraphState) -> None:
        run = lock_run_for_transition(
            self.db,
            family_id=state["family_id"],
            run_id=state["run_id"],
        )
        if cancellation_wins(self.db, run=run):
            finalize_run_cancellation(self.db, run=run)
            raise AIExecutionCancelled("AI run was cancelled")
        run.status = WAITING_APPROVAL
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if conversation is not None:
            conversation.last_run_status = WAITING_APPROVAL
        message = self._ensure_assistant_message(state)
        if message.status != WAITING_APPROVAL:
            self.timeline.update_message_status(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                status=WAITING_APPROVAL,
                created_by=state.get("user_id"),
            )
        self.db.flush()

    def _emit_parts(
        self,
        state: WorkspaceGraphState,
        *,
        message_id: str,
        parts: tuple[dict[str, Any], ...],
    ) -> None:
        response_now = utcnow()
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
                            "part": hydrate_operation_result_server_now(part, response_now),
                        },
                    }
                )


def _update_published_outcome(draft: Any, outcome: DraftRouteOutcome) -> None:
    metadata = dict(draft.ai_metadata or {})
    stored = dict(metadata.get("routeOutcome") or {})
    stored["publishedPartIds"] = list(outcome.published_part_ids)
    metadata["routeOutcome"] = stored
    draft.ai_metadata = metadata
