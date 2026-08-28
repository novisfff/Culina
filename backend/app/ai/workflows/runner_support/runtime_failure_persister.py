from __future__ import annotations

from collections.abc import Callable
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIRuntimeFailurePersistenceError, AutoExecutionBlockRequired
from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.ai.workflows.runner_support.human_input_resume_claim import (
    clear_stream_resume_claim,
    current_stream_resume_claim,
)
from app.ai.workflows.runner_support.run_status import (
    FAILED,
    TERMINAL_RUN_STATUSES,
    WAITING_APPROVAL,
)
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage, AIRunEvent
from app.services.ai_operations.run_blocking import mark_run_auto_execution_blocked
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)

logger = logging.getLogger("app.ai.workflows.runner")


class RuntimeFailurePersister:
    def __init__(self, *, db: Session, json_record: Callable[[Any], Any]) -> None:
        self.db = db
        self.json_record = json_record

    def mark_failed(
        self,
        *,
        run_id: str,
        conversation_id: str,
        family_id: str,
        user_id: str,
        error: BaseException | str,
    ) -> None:
        requires_auto_execution_block = isinstance(error, AutoExecutionBlockRequired)
        try:
            self.db.rollback()
            if requires_auto_execution_block:
                self._persist_auto_execution_block(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    family_id=family_id,
                    error=error,
                )
                live_ai_stream_cache.clear_run(run_id)
                return
            try:
                run = lock_run_for_transition(
                    self.db,
                    family_id=family_id,
                    run_id=run_id,
                )
            except LookupError:
                live_ai_stream_cache.clear_run(run_id)
                return
            if cancellation_wins(self.db, run=run):
                finalize_run_cancellation(self.db, run=run)
                self.db.commit()
                live_ai_stream_cache.clear_run(run_id)
                return
            if run.status in {*TERMINAL_RUN_STATUSES, WAITING_APPROVAL}:
                had_stream_claim = current_stream_resume_claim(run) is not None
                clear_stream_resume_claim(run)
                if had_stream_claim:
                    self.db.commit()
                live_ai_stream_cache.clear_run(run_id)
                return
            text = "AI 服务暂时不可用，请稍后重试。"
            self._get_or_create_failed_assistant_message(
                run=run,
                run_id=run_id,
                conversation_id=conversation_id,
                family_id=family_id,
                user_id=user_id,
                text=text,
            )
            self._append_runtime_error_event(
                run_id=run_id,
                conversation_id=conversation_id,
                family_id=family_id,
                error=str(error),
                text=text,
            )
            self._mark_run_failed(run, error=str(error), text=text)
            self._mark_conversation_failed(conversation_id=conversation_id, text=text)
            self.db.commit()
            live_ai_stream_cache.clear_run(run_id)
        except Exception:
            self.db.rollback()
            logger.exception(
                "AI graph failed to persist runtime error run_id=%s conversation_id=%s family_id=%s",
                run_id,
                conversation_id,
                family_id,
            )
            if requires_auto_execution_block:
                raise AIRuntimeFailurePersistenceError(
                    "AI 运行失败状态无法安全保存，请稍后重试"
                ) from None

    def _persist_auto_execution_block(
        self,
        *,
        run_id: str,
        conversation_id: str,
        family_id: str,
        error: AutoExecutionBlockRequired,
    ) -> None:
        run = mark_run_auto_execution_blocked(
            self.db,
            family_id=family_id,
            run_id=run_id,
        )
        if run is None:
            raise LookupError("AI Run 不存在，无法持久化自动执行阻断结果")
        clear_stream_resume_claim(run)
        self._append_runtime_error_event(
            run_id=run_id,
            conversation_id=conversation_id,
            family_id=family_id,
            error=error.message,
            text=error.message,
            internal_code=error.error_code,
        )
        self.db.commit()

    def _get_or_create_failed_assistant_message(
        self,
        *,
        run: AIAgentRun,
        run_id: str,
        conversation_id: str,
        family_id: str,
        user_id: str,
        text: str,
    ) -> AIMessage:
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == run_id, AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.desc())
        )
        if message is None:
            message = AIMessage(
                id=create_id("ai_message"),
                family_id=family_id,
                conversation_id=conversation_id,
                role="assistant",
                content=text,
                content_type="parts",
                parts=[{"id": create_id("ai_part"), "type": "text", "text": text}],
                run_id=run_id,
                status=FAILED,
                message_metadata={
                    "intent": run.intent or "runtime_failed",
                    "agentKey": run.agent_key or "workspace_orchestrator",
                },
                created_by=user_id,
            )
            self.db.add(message)
            return message

        message.status = FAILED
        if not message.content:
            message.content = text
        if not message.parts:
            message.parts = [{"id": create_id("ai_part"), "type": "text", "text": message.content or text}]
        metadata = dict(message.message_metadata or {})
        metadata.pop("liveStreaming", None)
        metadata.pop("liveTextPartIds", None)
        metadata.pop("livePartIds", None)
        message.message_metadata = metadata
        return message

    def _append_runtime_error_event(
        self,
        *,
        run_id: str,
        conversation_id: str,
        family_id: str,
        error: str,
        text: str,
        internal_code: str = "runtime_exception",
    ) -> None:
        event = AIRunEvent(
            id=create_id("ai_run_event"),
            family_id=family_id,
            conversation_id=conversation_id,
            run_id=run_id,
            type="error",
            internal_code=internal_code,
            user_message=text,
            status=FAILED,
            payload={"error": error[:1000]},
        )
        self.db.add(event)

    def _mark_run_failed(self, run: AIAgentRun, *, error: str, text: str) -> None:
        clear_stream_resume_claim(run)
        run.status = FAILED
        run.error = error or text
        run.output_summary = text
        run.output = self.json_record({"text": text, "cards": [], "routing": (run.context_summary or {}).get("routing", {})})

    def _mark_conversation_failed(self, *, conversation_id: str, text: str) -> None:
        conversation = self.db.get(AIConversation, conversation_id)
        if conversation is None:
            return
        conversation.last_run_status = FAILED
        conversation.last_message_at = utcnow()
        context = dict(conversation.context or {})
        context.pop("activeRunId", None)
        conversation.context = self.json_record(context)
        if not conversation.response:
            conversation.response = text
            conversation.summary = text[:255]
