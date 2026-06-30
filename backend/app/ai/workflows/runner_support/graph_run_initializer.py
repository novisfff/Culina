from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.observability.tracer import AIRunTracer
from app.ai.workflows.runner_support.run_status import CANCELLED, RUNNING
from app.ai.workflows.state import WorkspaceGraphState
from app.models.domain import AIAgentRun, AIMessage, AIRunTraceSpan


class GraphRunInitializer:
    def __init__(self, *, db: Session) -> None:
        self.db = db

    def initialize(self, state: WorkspaceGraphState) -> dict[str, str]:
        run_id = state.get("run_id")
        user_message_id = state.get("user_message_id")
        if not run_id or not user_message_id:
            raise RuntimeError("AI 运行必须先完成用户消息准备")

        run = self.db.get(AIAgentRun, run_id)
        user_message = self.db.get(AIMessage, user_message_id)
        if run is None or user_message is None:
            raise RuntimeError("预创建的 AI 运行状态不存在")
        self._record_initialize_event_if_needed(state, run)
        return {
            "run_id": run.id,
            "user_message_id": user_message.id,
            "status": CANCELLED if run.status == CANCELLED else RUNNING,
        }

    def _record_initialize_event_if_needed(self, state: WorkspaceGraphState, run: AIAgentRun) -> None:
        existing_trace_id = self.db.scalar(
            select(AIRunTraceSpan.trace_id)
            .where(AIRunTraceSpan.run_id == run.id, AIRunTraceSpan.family_id == state["family_id"])
            .order_by(AIRunTraceSpan.started_at.asc(), AIRunTraceSpan.id.asc())
            .limit(1)
        )
        if existing_trace_id is not None:
            return
        AIRunTracer(
            db=self.db,
            family_id=state["family_id"],
            run_id=run.id,
            conversation_id=run.conversation_id,
            user_id=state["user_id"],
        ).record_event(
            "run",
            "initialize",
            payload={
                "clientRunId": state.get("client_run_id"),
                "quickTask": state.get("quick_task"),
                "hasSubject": bool(state.get("subject")),
                "attachmentCount": len(state.get("current_message_attachments") or []),
                "precreated": True,
            },
        )
