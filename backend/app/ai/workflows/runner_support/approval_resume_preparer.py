from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.ai.workflows.conversations import require_conversation
from app.ai.workflows.runner_support.run_status import WAITING_APPROVAL
from app.models.domain import AIApprovalRequest
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)

logger = logging.getLogger("app.ai.workflows.runner")


@dataclass
class PreparedApprovalResume:
    config: dict[str, Any]
    snapshot: Any
    pending: AIApprovalRequest
    run_id: str
    resume_payload: dict[str, Any]


class ApprovalResumePreparer:
    def __init__(
        self,
        *,
        db: Session,
        graph: Any,
        config_for_conversation: Callable[[str], dict[str, Any]],
        build_resume_payload: Callable[..., dict[str, Any]],
    ) -> None:
        self.db = db
        self.graph = graph
        self.config_for_conversation = config_for_conversation
        self.build_resume_payload = build_resume_payload

    def prepare(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        approval_id: str,
        decision: str,
        draft_version: int,
        values: dict[str, Any],
        comment: str | None,
        stream: bool,
    ) -> PreparedApprovalResume:
        conversation = require_conversation(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            capability="contribute",
        )
        config = self.config_for_conversation(conversation_id)
        snapshot = self.graph.get_state(config)
        pending = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if pending is None:
            if not stream:
                logger.warning(
                    "AI graph approval resume missing approval family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                    family_id,
                    user_id,
                    conversation_id,
                    approval_id,
                )
            raise LookupError("确认请求不存在")
        if not snapshot.values or not snapshot.next:
            logger.warning(
                "AI graph approval %sresume missing checkpoint family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                "stream " if stream else "",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            raise AIConflictError("确认请求缺少可恢复的运行状态，请重新生成草稿")
        run_id = pending.run_id or str((snapshot.values or {}).get("run_id") or "")
        if not run_id:
            raise AIConflictError("确认请求关联的运行状态已变化，请刷新后重试")
        run = lock_run_for_transition(
            self.db,
            family_id=family_id,
            run_id=run_id,
        )
        fast_decisions = (
            conversation.context.get("fastApprovalDecisions")
            if isinstance(conversation.context, dict)
            and isinstance(conversation.context.get("fastApprovalDecisions"), dict)
            else {}
        )
        has_recorded_fast_decision = approval_id in fast_decisions
        if run.conversation_id != conversation_id or (
            run.status != WAITING_APPROVAL
            and not (run.status == "running" and has_recorded_fast_decision)
        ):
            raise AIConflictError("确认请求关联的运行状态已变化，请刷新后重试")
        if cancellation_wins(self.db, run=run, lock_request=False):
            finalize_run_cancellation(self.db, run=run)
            raise AIConflictError("运行任务已取消，不能继续提交确认")
        snapshot = self.graph.get_state(config)
        checkpoint_run_id = str((snapshot.values or {}).get("run_id") or "")
        if not snapshot.values or not snapshot.next or checkpoint_run_id != run.id:
            raise AIConflictError("确认请求缺少可恢复的运行状态，请重新生成草稿")
        resume_payload = self.build_resume_payload(
            approval_id=approval_id,
            decision=decision,
            draft_version=draft_version,
            values=values,
            comment=comment,
            user_id=user_id,
            family_id=family_id,
        )
        return PreparedApprovalResume(
            config=config,
            snapshot=snapshot,
            pending=pending,
            run_id=run_id,
            resume_payload=resume_payload,
        )
