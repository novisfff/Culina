from __future__ import annotations

from collections.abc import Callable
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIRuntimeFailurePersistenceError, AutoExecutionBlockRequired
from app.ai.workflows.runner_support.human_input_resume_claim import (
    clear_stream_resume_claim,
    current_stream_resume_claim,
)
from app.ai.workflows.runner_support.run_status import (
    COMPLETED,
    FAILED,
    TERMINAL_RUN_STATUSES,
    WAITING_APPROVAL,
    WAITING_INPUT,
)
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage, AIRunEvent
from app.services.ai_operations.run_blocking import mark_run_auto_execution_blocked
from app.services.ai_timeline import AITimelineService
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
        self.timeline = AITimelineService(db)

    def mark_failed(
        self,
        *,
        run_id: str,
        conversation_id: str,
        family_id: str,
        user_id: str,
        error: BaseException | str,
    ) -> bool:
        """Persist a runtime failure and report whether it was safely absorbed.

        A stream worker can fail after an approval has already committed the
        business operation and appended its operation-result card.  In that
        case the operation is the durable user-facing fact; turning the same
        assistant message/run into a generic failure would be both misleading
        and destructive to the result card.  ``True`` tells the stream bridge
        that a final response can be emitted instead of forwarding an error
        event to the client.
        """
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
                return False
            try:
                run = lock_run_for_transition(
                    self.db,
                    family_id=family_id,
                    run_id=run_id,
                )
            except LookupError:
                return False
            if cancellation_wins(self.db, run=run):
                finalize_run_cancellation(self.db, run=run)
                self.db.commit()
                return False

            # The approval commit and the provider/stream continuation are
            # separate phases.  If the latter fails after a successful
            # operation-result card has been persisted, preserve that success
            # and let the caller return the durable conversation snapshot.
            if self._preserve_successful_operation_result(
                run=run,
                run_id=run_id,
                conversation_id=conversation_id,
            ):
                self.db.commit()
                return True

            if run.status in {*TERMINAL_RUN_STATUSES, WAITING_APPROVAL}:
                had_stream_claim = current_stream_resume_claim(run) is not None
                clear_stream_resume_claim(run)
                if had_stream_claim:
                    self.db.commit()
                return False
            text = "AI 服务暂时不可用，请稍后重试。"
            message = self._get_canonical_assistant_message(
                run=run,
                run_id=run_id,
                conversation_id=conversation_id,
                family_id=family_id,
                user_id=user_id,
                text=text,
            )
            self.timeline.terminal(
                family_id=family_id,
                conversation_id=conversation_id,
                message_id=message.id,
                run_id=run_id,
                status=FAILED,
                content=message.content or text,
                created_by=user_id,
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
            return False
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
            return False

    def _preserve_successful_operation_result(
        self,
        *,
        run: Any,
        run_id: str,
        conversation_id: str,
    ) -> bool:
        matched = self._latest_successful_operation_message(run_id=run_id)
        if matched is None:
            return False
        message, has_pending_approval, has_pending_input = matched
        if has_pending_approval:
            next_status = WAITING_APPROVAL
        elif has_pending_input:
            next_status = WAITING_INPUT
        else:
            next_status = COMPLETED

        clear_stream_resume_claim(run)
        run.status = next_status
        # ``error`` is an internal continuation/provider detail.  Exposing it
        # through a completed run would make the durable success look failed to
        # diagnostics that only inspect the run row.
        run.error = None
        if not run.output_summary:
            run.output_summary = str(message.content or "")[:255]

        metadata = dict(message.message_metadata or {})
        metadata.pop("liveStreaming", None)
        metadata.pop("liveTextPartIds", None)
        metadata.pop("livePartIds", None)
        self.timeline.update_message_metadata(
            family_id=run.family_id,
            conversation_id=conversation_id,
            message_id=message.id,
            run_id=run_id,
            metadata=metadata,
            created_by=message.created_by,
            allow_after_terminal=True,
        )
        if next_status in TERMINAL_RUN_STATUSES:
            self.timeline.terminal(
                family_id=run.family_id,
                conversation_id=conversation_id,
                message_id=message.id,
                run_id=run_id,
                status=next_status,
                content=message.content or "",
                created_by=message.created_by,
            )
        elif message.status != next_status:
            self.timeline.update_message_status(
                family_id=run.family_id,
                conversation_id=conversation_id,
                message_id=message.id,
                run_id=run_id,
                status=next_status,
                created_by=message.created_by,
            )

        conversation = self.db.get(AIConversation, conversation_id)
        if conversation is not None:
            conversation.last_run_status = next_status
            conversation.last_message_at = utcnow()
            context = dict(conversation.context or {})
            if next_status == COMPLETED:
                context.pop("activeRunId", None)
            conversation.context = self.json_record(context)
            if not conversation.response:
                conversation.response = message.content or ""
                conversation.summary = (message.content or "")[:255]
        logger.warning(
            "AI runtime failure occurred after operation result was committed; preserving success run_id=%s conversation_id=%s status=%s",
            run_id,
            conversation_id,
            next_status,
        )
        return True

    def _latest_successful_operation_message(
        self,
        *,
        run_id: str,
    ) -> tuple[AIMessage, bool, bool] | None:
        messages = list(
            self.db.scalars(
                select(AIMessage)
                .join(AIAgentRun, AIAgentRun.id == run_id)
                .where(
                    AIMessage.run_id == run_id,
                    AIMessage.role == "assistant",
                    AIMessage.family_id == AIAgentRun.family_id,
                    AIMessage.conversation_id == AIAgentRun.conversation_id,
                )
                .order_by(AIMessage.timeline_position.asc(), AIMessage.id.asc())
                .with_for_update()
            )
        )
        if len(messages) > 1:
            raise LookupError("运行关联了多个 canonical 助手消息")
        for message in messages:
            if not self._contains_successful_operation_result(message):
                continue
            has_pending_approval = False
            has_pending_input = False
            for part in message.parts or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "approval_request":
                    approval = part.get("approval") if isinstance(part.get("approval"), dict) else {}
                    if str(approval.get("status") or "").lower() in {"pending", "pending_retry"}:
                        has_pending_approval = True
                elif part.get("type") == "human_input_request":
                    request_status = str(part.get("status") or "pending").lower()
                    if request_status in {"pending", "pending_retry"}:
                        has_pending_input = True
            return message, has_pending_approval, has_pending_input
        return None

    @staticmethod
    def _contains_successful_operation_result(message: AIMessage) -> bool:
        for part in message.parts or []:
            if not isinstance(part, dict) or part.get("type") != "result_card":
                continue
            card = part.get("card") if isinstance(part.get("card"), dict) else {}
            if card.get("type") != "operation_result":
                continue
            data = card.get("data") if isinstance(card.get("data"), dict) else {}
            result_status = str(data.get("result_status") or data.get("resultStatus") or "").lower()
            operation_status = str(data.get("operation_status") or data.get("operationStatus") or "").lower()
            if result_status == "failed" or operation_status == "failed":
                continue
            # A projection may temporarily expose ``result_status=completed``
            # while the underlying operation is still pending. That card is
            # only a progress snapshot; preserving it as a committed success
            # would hide a real write failure that follows.
            if operation_status == "pending":
                continue
            if result_status in {"completed", "no_change", "reverted"}:
                return True
            if operation_status in {"completed", "reverted"}:
                return True
            # Older trusted cards may not carry the canonical status aliases;
            # an operation-result card with no explicit failure still denotes a
            # committed result and is safe to preserve.
            if not result_status and not operation_status:
                return True
        return False

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

    def _get_canonical_assistant_message(
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
            select(AIMessage).where(
                AIMessage.id == run.message_id,
                AIMessage.family_id == family_id,
                AIMessage.conversation_id == conversation_id,
                AIMessage.run_id == run_id,
                AIMessage.role == "assistant",
            )
        )
        if message is None:
            # ``AIAgentRun.message_id`` historically points at the user
            # message.  Resolve the sole pre-created assistant by canonical
            # run scope, never by created_at or by creating a replacement.
            candidates = list(
                self.db.scalars(
                    select(AIMessage)
                    .where(
                        AIMessage.family_id == family_id,
                        AIMessage.conversation_id == conversation_id,
                        AIMessage.run_id == run_id,
                        AIMessage.role == "assistant",
                    )
                    .order_by(AIMessage.timeline_position.asc(), AIMessage.id.asc())
                )
            )
            if len(candidates) == 1:
                message = candidates[0]
        if message is None:
            raise LookupError("预创建的 canonical 助手消息不存在")
        if not message.content and not any(
            isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
            for part in (message.parts or [])
        ):
            self.timeline.append_part(
                family_id=family_id,
                conversation_id=conversation_id,
                message_id=message.id,
                run_id=run_id,
                part={"id": create_id("ai_part"), "type": "text", "text": text},
                created_by=user_id,
            )
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
