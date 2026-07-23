from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.ai.workflows.conversations import require_conversation
from app.ai.workflows.runner_support.run_status import WAITING_INPUT
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    lock_run_for_transition,
)

logger = logging.getLogger("app.ai.workflows.runner")


@dataclass
class PreparedHumanInputResume:
    config: dict[str, Any]
    snapshot: Any
    run_id: str
    resume_payload: dict[str, Any]


class HumanInputResumePreparer:
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
        request_id: str,
        selected_option_ids: list[str],
        text: str | None,
        stream: bool,
    ) -> PreparedHumanInputResume:
        conversation = require_conversation(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            capability="contribute",
        )
        config = self.config_for_conversation(conversation_id)
        snapshot = self.graph.get_state(config)
        if not snapshot.values or not snapshot.next:
            logger.warning(
                "AI graph human input %sresume missing checkpoint family_id=%s user_id=%s conversation_id=%s request_id=%s",
                "stream " if stream else "",
                family_id,
                user_id,
                conversation_id,
                request_id,
            )
            raise LookupError("用户补充信息请求不存在或已结束")
        snapshot_values = snapshot.values or {}
        snapshot_run_id = str(snapshot_values.get("run_id") or "")
        if not snapshot_run_id:
            raise AIConflictError("这次补充信息任务已取消或结束，请刷新后重试")
        run = lock_run_for_transition(
            self.db,
            family_id=family_id,
            run_id=snapshot_run_id,
        )
        if (
            run.conversation_id != conversation.id
            or run.status != WAITING_INPUT
            or cancellation_wins(self.db, run=run, lock_request=False)
        ):
            raise AIConflictError("这次补充信息任务已取消或结束，请刷新后重试")
        locked_snapshot = self.graph.get_state(config)
        locked_values = locked_snapshot.values or {}
        pending = (
            locked_values.get("pending_human_input")
            or locked_values.get("pendingHumanInput")
            or {}
        )
        if (
            not locked_snapshot.next
            or str(locked_values.get("run_id") or "") != run.id
            or str(pending.get("id") or "") != request_id
        ):
            raise AIConflictError("用户补充信息请求已变化，请刷新后重试")
        return PreparedHumanInputResume(
            config=config,
            snapshot=locked_snapshot,
            run_id=run.id,
            resume_payload=self.build_resume_payload(
                request_id=request_id,
                selected_option_ids=selected_option_ids,
                text=text,
                user_id=user_id,
                family_id=family_id,
            ),
        )
