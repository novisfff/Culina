from __future__ import annotations

import logging
from time import perf_counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.ai.workflows.runner_support.message_parts import terminal_message_text, text_message_part
from app.ai.workflows.runner_support.run_status import (
    CANCELLED,
    COMPLETED,
    FAILED,
    RUNNING,
    TERMINAL_RUN_STATUSES,
    WAITING_APPROVAL,
)
from app.ai.workflows.state import WorkspaceGraphState
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner

logger = logging.getLogger("app.ai.workflows.runner")


def _elapsed_ms(started_at: float) -> int:
    return int((perf_counter() - started_at) * 1000)


class RunFinalizer:
    def __init__(self, runner: WorkspaceGraphRunner, *, max_agent_rounds: int) -> None:
        self.runner = runner
        self.max_agent_rounds = max_agent_rounds

    def finalize(self, state: WorkspaceGraphState) -> dict[str, Any]:
        runner = self.runner
        finalize_started_at = perf_counter()
        run = runner.db.get(AIAgentRun, state["run_id"])
        conversation = runner.db.get(AIConversation, state["conversation_id"])
        status = self._final_status(state)
        logger.info(
            "AI graph finalizing run_id=%s conversation_id=%s family_id=%s status=%s error=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            state.get("error"),
        )
        message = runner.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.desc())
        )
        if message is None:
            message = self._create_fallback_message(state, run=run, status=status)
        terminal_text = self._finalize_message(state, message, status=status)
        if run is not None and run.status != WAITING_APPROVAL:
            run.status = status
            run.error = state.get("error")
            if not run.output_summary:
                run.output_summary = terminal_text[:255]
                run.output = runner._json_record(
                    {"text": terminal_text, "cards": [], "routing": (run.context_summary or {}).get("routing", {})}
                )
        if conversation is not None and conversation.last_run_status != WAITING_APPROVAL:
            conversation.last_run_status = status
            conversation.last_message_at = utcnow()
            if self._is_terminal_run_status(status):
                context = dict(conversation.context or {})
                if context.pop("activeRunId", None) is not None:
                    logger.warning(
                        "AI graph finalized terminal run and cleared stale activeRunId run_id=%s conversation_id=%s family_id=%s status=%s",
                        state["run_id"],
                        state["conversation_id"],
                        state["family_id"],
                        status,
                    )
                conversation.context = runner._json_record(context)
            if not conversation.response:
                conversation.response = terminal_text
                conversation.summary = terminal_text[:255]
        if self._is_terminal_run_status(status):
            live_ai_stream_cache.clear_run(state["run_id"])
        runner.db.flush()
        logger.info(
            "AI graph finalized run_id=%s conversation_id=%s family_id=%s status=%s run_status=%s conversation_status=%s message_id=%s finalize_ms=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            run.status if run is not None else None,
            conversation.last_run_status if conversation is not None else None,
            message.id,
            _elapsed_ms(finalize_started_at),
        )
        logger.info(
            "AI graph finalize perf summary run_id=%s conversation_id=%s family_id=%s status=%s finalize_ms=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            _elapsed_ms(finalize_started_at),
        )
        return {"status": status}

    def _final_status(self, state: WorkspaceGraphState) -> str:
        status = str(state.get("status") or COMPLETED)
        if self.runner._cancel_requested(state["run_id"]):
            return CANCELLED
        if status == RUNNING and int(state.get("agent_rounds") or 0) >= self.max_agent_rounds:
            state["error"] = "agent round limit exceeded"
            return FAILED
        if status == RUNNING:
            return COMPLETED
        return status

    def _create_fallback_message(
        self,
        state: WorkspaceGraphState,
        *,
        run: AIAgentRun | None,
        status: str,
    ) -> AIMessage:
        text = "AI 工作台暂时失败，请重试。" if status == FAILED else "任务已结束。"
        message = AIMessage(
            id=create_id("ai_message"),
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            role="assistant",
            content=text,
            content_type="parts",
            parts=[text_message_part(part_id=create_id("ai_part"), text=text)],
            run_id=state["run_id"],
            status=status,
            message_metadata={
                "intent": run.intent if run is not None else "workspace_orchestrator",
                "agentKey": "workspace_orchestrator",
            },
            created_by=state["user_id"],
        )
        self.runner.db.add(message)
        return message

    def _finalize_message(self, state: WorkspaceGraphState, message: AIMessage, *, status: str) -> str:
        message_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        terminal_text = terminal_message_text(content=message.content, parts=message_parts, status=status)
        if not self._is_terminal_run_status(status):
            return terminal_text
        self._clear_message_live_metadata(message)
        if not str(message.content or "").strip():
            logger.warning(
                "AI graph finalizing terminal run with empty assistant text run_id=%s conversation_id=%s family_id=%s status=%s fallback_text=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                status,
                terminal_text,
            )
            message.content = terminal_text
            message.content_type = "parts"
            parts = [part for part in (message.parts or []) if isinstance(part, dict)]
            if not any(part.get("type") == "text" and str(part.get("text") or "").strip() for part in parts):
                message.parts = [*parts, text_message_part(part_id=create_id("ai_part"), text=terminal_text)]
            terminal_text = terminal_message_text(
                content=message.content,
                parts=[part for part in (message.parts or []) if isinstance(part, dict)],
                status=status,
            )
        message.status = status
        return terminal_text

    @staticmethod
    def _is_terminal_run_status(status: str | None) -> bool:
        return str(status or "").lower() in TERMINAL_RUN_STATUSES

    @staticmethod
    def _clear_message_live_metadata(message: AIMessage) -> None:
        metadata = dict(message.message_metadata or {})
        metadata.pop("liveStreaming", None)
        metadata.pop("livePartIds", None)
        metadata.pop("liveTextPartIds", None)
        message.message_metadata = metadata
