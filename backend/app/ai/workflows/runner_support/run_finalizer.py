from __future__ import annotations

import logging
from time import perf_counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

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
from app.services.ai_operations.messages import persist_message_artifacts
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)

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
        run = lock_run_for_transition(
            runner.db,
            family_id=state["family_id"],
            run_id=state["run_id"],
        )
        conversation = runner.db.get(AIConversation, state["conversation_id"])
        status = self._final_status(state, run=run)
        if status == CANCELLED:
            finalize_run_cancellation(runner.db, run=run)
        logger.info(
            "AI graph finalizing run_id=%s conversation_id=%s family_id=%s status=%s error=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            state.get("error"),
        )
        assistant_message_id = str(state.get("assistant_message_id") or "")
        if not assistant_message_id:
            raise RuntimeError("AI finalizer 缺少 canonical assistant_message_id")
        message = runner.db.scalar(
            select(AIMessage).where(
                AIMessage.id == assistant_message_id,
                AIMessage.family_id == state["family_id"],
                AIMessage.conversation_id == state["conversation_id"],
                AIMessage.run_id == state["run_id"],
                AIMessage.role == "assistant",
            )
        )
        if message is None:
            raise RuntimeError("预创建的 canonical 助手消息不存在")
        already_terminal = runner.timeline_service.has_terminal(
            conversation_id=state["conversation_id"],
            message_id=message.id,
        )
        # Cancellation and a late provider callback can race with finalization.
        # Once a terminal event is durable, finalization is an idempotent
        # projection read; it must never append metadata/text after the
        # terminal boundary.
        terminal_text = (
            str(message.content or "")
            if already_terminal
            else self._finalize_message(state, message, status=status)
        )
        persist_message_artifacts(
            runner.db,
            message_id=message.id,
            artifacts=[
                artifact
                for artifact in state.get("run_artifacts") or []
                if isinstance(artifact, dict)
                and artifact.get("kind") == "result_card"
                and artifact.get("type") == "recipe_shortage"
            ],
        )
        if run is not None and run.status != WAITING_APPROVAL:
            run.status = status
            run.error = None if status == CANCELLED else state.get("error")
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

    def _final_status(self, state: WorkspaceGraphState, *, run: AIAgentRun) -> str:
        status = str(state.get("status") or COMPLETED)
        if cancellation_wins(self.runner.db, run=run):
            return CANCELLED
        if status == RUNNING and int(state.get("agent_rounds") or 0) >= self.max_agent_rounds:
            state["error"] = "agent round limit exceeded"
            return FAILED
        if status == RUNNING:
            return COMPLETED
        return status

    def _finalize_message(self, state: WorkspaceGraphState, message: AIMessage, *, status: str) -> str:
        message_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        terminal_text = terminal_message_text(content=message.content, parts=message_parts, status=status)
        if not self._is_terminal_run_status(status):
            return terminal_text
        metadata = dict(message.message_metadata or {})
        metadata.pop("liveStreaming", None)
        metadata.pop("livePartIds", None)
        metadata.pop("liveTextPartIds", None)
        if not str(message.content or "").strip():
            logger.warning(
                "AI graph finalizing terminal run with empty assistant text run_id=%s conversation_id=%s family_id=%s status=%s fallback_text=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                status,
                terminal_text,
            )
            parts = [part for part in (message.parts or []) if isinstance(part, dict)]
            if not any(part.get("type") == "text" and str(part.get("text") or "").strip() for part in parts):
                self.runner.timeline_service.append_part(
                    family_id=state["family_id"],
                    conversation_id=state["conversation_id"],
                    message_id=message.id,
                    run_id=state["run_id"],
                    part=text_message_part(part_id=create_id("ai_part"), text=terminal_text),
                    created_by=state.get("user_id"),
                )
            terminal_text = terminal_message_text(
                content=message.content,
                parts=[part for part in (message.parts or []) if isinstance(part, dict)],
                status=status,
            )
        self.runner.timeline_service.terminal(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            message_id=message.id,
            run_id=state["run_id"],
            status=status,
            content=terminal_text,
            metadata=metadata,
            created_by=state.get("user_id"),
        )
        return terminal_text

    @staticmethod
    def _is_terminal_run_status(status: str | None) -> bool:
        return str(status or "").lower() in TERMINAL_RUN_STATUSES
