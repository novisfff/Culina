from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.ai.workflows.conversations import require_conversation

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
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
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
        return PreparedHumanInputResume(
            config=config,
            snapshot=snapshot,
            run_id=str((snapshot.values or {}).get("run_id") or ""),
            resume_payload=self.build_resume_payload(
                request_id=request_id,
                selected_option_ids=selected_option_ids,
                text=text,
                user_id=user_id,
                family_id=family_id,
            ),
        )
