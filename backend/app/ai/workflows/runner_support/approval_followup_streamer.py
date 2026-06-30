from __future__ import annotations

from collections.abc import Callable
import inspect
import json
import logging
from time import perf_counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIExecutionCancelled
from app.ai.observability.llm_exchange import LLMExchangeRecorder
from app.ai.observability.tracer import AIRunTracer
from app.ai.workflows.runner_support.approval_followup import (
    approval_followup_delta_event,
    approval_followup_fallback_text,
)
from app.ai.workflows.runner_support.message_parts import (
    aggregate_text_from_parts,
    result_cards_from_parts,
    text_message_part,
)
from app.ai.workflows.state import WorkspaceGraphState
from app.ai.workflows.timeline import build_planner_conversation
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage

logger = logging.getLogger("app.ai.workflows.runner")


def _elapsed_ms(started_at: float) -> int:
    return int((perf_counter() - started_at) * 1000)


class ApprovalFollowupStreamer:
    def __init__(
        self,
        *,
        db: Session,
        provider: Any,
        json_record: Callable[[Any], Any],
        cancel_requested: Callable[[str], bool],
        tracer_for_state: Callable[[WorkspaceGraphState], AIRunTracer],
        optional_stream_writer: Callable[[], Any],
        persistent_progress_writer: Callable[[Any, WorkspaceGraphState], Any],
    ) -> None:
        self.db = db
        self.provider = provider
        self.json_record = json_record
        self.cancel_requested = cancel_requested
        self.tracer_for_state = tracer_for_state
        self.optional_stream_writer = optional_stream_writer
        self.persistent_progress_writer = persistent_progress_writer

    def stream_followup(
        self,
        state: WorkspaceGraphState,
        decision_result: dict[str, Any],
        *,
        terminal_status: str,
    ) -> None:
        followup_started_at = perf_counter()
        approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
        message = self._find_assistant_message(state, approval)
        if message is None:
            logger.warning(
                "AI graph approval follow-up skipped because assistant message is missing run_id=%s conversation_id=%s family_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
            )
            return

        part_id = create_id("ai_part")
        chunks: list[str] = []
        writer = self.persistent_progress_writer(self.optional_stream_writer(), state)
        tracer = self.tracer_for_state(state)
        followup_span = tracer.start_span(
            "approval_followup",
            "approval.decision.followup",
            input_summary={
                "terminalStatus": terminal_status,
                "approvalId": approval.get("id"),
                "decision": approval.get("decision") or approval.get("status"),
            },
        )
        try:
            for chunk in self.provider.stream_generate(
                **self._provider_kwargs(state, decision_result, terminal_status, tracer, followup_span.span_id)
            ):
                if self.cancel_requested(state["run_id"]):
                    raise AIExecutionCancelled("AI run was cancelled")
                if not chunk:
                    continue
                chunks.append(chunk)
                self._emit_message_delta(
                    writer,
                    state,
                    message_id=message.id,
                    part_id=part_id,
                    chunk=chunk,
                )
        except AIExecutionCancelled:
            followup_span.finish(
                status="failed",
                error_code="cancelled",
                error_message="AI run was cancelled",
                exception_type="AIExecutionCancelled",
            )
            raise
        except Exception as exc:
            logger.warning(
                "AI graph approval follow-up model failed run_id=%s conversation_id=%s family_id=%s duration_ms=%s error=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                _elapsed_ms(followup_started_at),
                exc,
            )
            followup_span.finish(
                status="failed",
                error_code="provider_stream_failed",
                error_message=str(exc),
                exception_type=type(exc).__name__,
                output_summary={"fallbackAppended": True},
            )
            self._append_fallback(
                state,
                message,
                part_id=part_id,
                decision_result=decision_result,
                status=terminal_status,
                writer=writer,
                reason="provider_stream_failed",
            )
            return

        text = "".join(chunks).strip()
        if not text:
            logger.warning(
                "AI graph approval follow-up returned empty response run_id=%s conversation_id=%s family_id=%s duration_ms=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                _elapsed_ms(followup_started_at),
            )
            followup_span.finish(
                status="failed",
                output_summary={"textLength": 0, "fallbackAppended": True},
                error_code="provider_empty_response",
                error_message="empty model response",
            )
            self._append_fallback(
                state,
                message,
                part_id=part_id,
                decision_result=decision_result,
                status=terminal_status,
                writer=writer,
                reason="provider_empty_response",
            )
            return
        followup_span.finish(status="completed", output_summary={"textLength": len(text)})
        logger.info(
            "AI graph approval follow-up perf summary run_id=%s conversation_id=%s family_id=%s status=completed provider_stream_ms=%s text_length=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            _elapsed_ms(followup_started_at),
            len(text),
        )
        self.append_text_to_assistant_message(
            state,
            message,
            part_id=part_id,
            text=text,
            status=terminal_status,
        )

    def _find_assistant_message(self, state: WorkspaceGraphState, approval: dict[str, Any]) -> AIMessage | None:
        message_id = str(approval.get("message_id") or "")
        message = self.db.get(AIMessage, message_id) if message_id else None
        if message is not None:
            return message
        return self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.desc(), AIMessage.id.desc())
        )

    def _provider_kwargs(
        self,
        state: WorkspaceGraphState,
        decision_result: dict[str, Any],
        terminal_status: str,
        tracer: AIRunTracer,
        span_id: str,
    ) -> dict[str, Any]:
        payload = {
            "currentMessage": state.get("message") or "",
            "terminalStatus": terminal_status,
            "humanInLoopTool": {
                "name": "approval.decision",
                "result": decision_result,
            },
            "conversation": build_planner_conversation(
                self.db,
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                quick_task=state.get("quick_task"),
            ),
            "subject": state.get("subject") or {},
        }
        provider_kwargs: dict[str, Any] = {
            "system": self._system_prompt(),
            "user": json.dumps(payload, ensure_ascii=False, default=str),
        }
        if "trace_recorder" in inspect.signature(self.provider.stream_generate).parameters:
            provider_kwargs["trace_recorder"] = LLMExchangeRecorder(
                db=self.db,
                family_id=state["family_id"],
                run_id=state["run_id"],
                conversation_id=state["conversation_id"],
                trace_id=tracer.trace_id,
                user_id=state.get("user_id"),
                span_id=span_id,
            )
        return provider_kwargs

    @staticmethod
    def _system_prompt() -> str:
        return """
        你是 Culina 的厨房助手。你刚收到一个 HumanInLoop 工具的返回结果，这个工具表示用户对你前面生成的确认表单做出了批准或拒绝。

        请把这个工具结果当成普通工具调用结果继续对话：
        1. 用自然、简短、可执行的话接着前文回复。
        2. 如果用户批准并且操作成功，说明结果已按用户确认处理。
        3. 如果用户拒绝，尊重这个决定，说明不会按这个草稿写入，并提示可以继续调整或重新整理。
        4. 不要编造没有发生的写入、删除、修改；只依据输入里的 approval、draft、operation、business_entity。
        5. 不要输出 JSON，不要重复表单内容。
        """.strip()

    @staticmethod
    def _emit_message_delta(
        writer: Any,
        state: WorkspaceGraphState,
        *,
        message_id: str,
        part_id: str,
        chunk: str,
    ) -> None:
        if writer is None:
            return
        writer(
            {
                "event": "message_delta",
                "data": {
                    "message_id": message_id,
                    "conversation_id": state["conversation_id"],
                    "run_id": state["run_id"],
                    "part_id": part_id,
                    "delta": chunk,
                },
            }
        )

    def _append_fallback(
        self,
        state: WorkspaceGraphState,
        message: AIMessage,
        *,
        part_id: str,
        decision_result: dict[str, Any],
        status: str,
        writer: Any,
        reason: str,
    ) -> None:
        text = approval_followup_fallback_text(decision_result, terminal_status=status)
        logger.warning(
            "AI graph approval follow-up fallback appended run_id=%s conversation_id=%s family_id=%s reason=%s text_length=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            reason,
            len(text),
        )
        if writer is not None:
            writer(
                approval_followup_delta_event(
                    message_id=message.id,
                    conversation_id=state["conversation_id"],
                    run_id=state["run_id"],
                    part_id=part_id,
                    delta=text,
                )
            )
        self.append_text_to_assistant_message(
            state,
            message,
            part_id=part_id,
            text=text,
            status=status,
        )

    def append_text_to_assistant_message(
        self,
        state: WorkspaceGraphState,
        message: AIMessage,
        *,
        part_id: str,
        text: str,
        status: str,
    ) -> None:
        existing_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        existing_parts = [part for part in existing_parts if str(part.get("id") or "") != part_id]
        message.parts = [*existing_parts, text_message_part(part_id=part_id, text=text)]
        metadata = dict(message.message_metadata or {})
        live_text_part_ids = [
            str(item)
            for item in metadata.get("liveTextPartIds", [])
            if isinstance(item, str) and item != part_id
        ]
        if live_text_part_ids:
            metadata["liveTextPartIds"] = live_text_part_ids
        else:
            metadata.pop("liveTextPartIds", None)
            metadata.pop("livePartIds", None)
            metadata.pop("liveStreaming", None)
        message.message_metadata = metadata
        aggregate_text = aggregate_text_from_parts([part for part in (message.parts or []) if isinstance(part, dict)])
        message.content = aggregate_text
        message.content_type = "parts"
        message.status = status

        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        all_cards = result_cards_from_parts([part for part in (message.parts or []) if isinstance(part, dict)])
        if run is not None:
            run.status = status
            run.model = getattr(self.provider, "model_name", "") or run.model
            run.output_summary = aggregate_text[:255]
            run.output = self.json_record(
                {"text": aggregate_text, "cards": all_cards, "routing": (run.context_summary or {}).get("routing", {})}
            )
            run.error = state.get("error")
        if conversation is not None:
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = status
            context = dict(conversation.context or {})
            context.pop("activeRunId", None)
            conversation.context = self.json_record(context)
        self.db.flush()
