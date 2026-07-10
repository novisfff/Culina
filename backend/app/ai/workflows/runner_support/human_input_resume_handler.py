from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.ai.workflows.runner_support.human_input_resume import (
    completed_human_input_request_parts,
    human_input_answer_summary,
    human_input_conversation_context,
    human_input_message_metadata,
    human_input_response_payload,
    human_input_result_artifact,
    human_input_resume_state_patch,
)
from app.ai.workflows.state import WorkspaceGraphState
from app.core.utils import utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner


class HumanInputResumeHandler:
    def __init__(self, runner: WorkspaceGraphRunner) -> None:
        self.runner = runner

    def resume(
        self,
        *,
        state: WorkspaceGraphState,
        pending: dict[str, Any],
        resume: Any,
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        self._validate(state=state, pending=pending, resume=resume)
        selected_option_ids = [
            str(item)
            for item in (resume.get("selectedOptionIds") if isinstance(resume.get("selectedOptionIds"), list) else [])
            if str(item).strip()
        ]
        text = str(resume.get("text") or "").strip()
        answer_summary = human_input_answer_summary(pending, selected_option_ids, text)
        response_payload = human_input_response_payload(
            selected_option_ids=selected_option_ids,
            text=text,
            answer_summary=answer_summary,
        )
        actor_id = str(resume.get("userId") or state.get("user_id") or "").strip()
        if actor_id:
            response_payload = {**response_payload, "actor": actor_id}
        result_artifact = human_input_result_artifact(
            pending=pending,
            response_payload=response_payload,
        )
        self._update_message(state, pending=pending, response_payload=response_payload, result_artifact=result_artifact)
        self._update_run_and_conversation(state, result_artifact=result_artifact)
        self.runner.db.flush()
        return human_input_resume_state_patch(
            state=state,
            run_artifacts=run_artifacts,
            result_artifact=result_artifact,
        )

    @staticmethod
    def _validate(
        *,
        state: WorkspaceGraphState,
        pending: dict[str, Any],
        resume: Any,
    ) -> None:
        if not isinstance(pending, dict) or not pending.get("id"):
            raise ValueError("没有可恢复的用户补充信息请求")
        if not isinstance(resume, dict):
            raise ValueError("用户补充信息恢复参数格式不正确")
        if str(resume.get("requestId") or "") != str(pending.get("id") or ""):
            raise ValueError("用户补充信息请求与当前暂停任务不匹配")
        if str(resume.get("familyId") or "") != state["family_id"]:
            raise LookupError("用户补充信息请求不存在")

    def _update_message(
        self,
        state: WorkspaceGraphState,
        *,
        pending: dict[str, Any],
        response_payload: dict[str, Any],
        result_artifact: dict[str, Any],
    ) -> None:
        message = self.runner.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        if message is None:
            return
        responded_at = utcnow().isoformat()
        message.parts = completed_human_input_request_parts(
            message.parts,
            pending_id=str(pending["id"]),
            response_payload=response_payload,
            responded_at=responded_at,
        )
        message.message_metadata = human_input_message_metadata(
            message.message_metadata if isinstance(message.message_metadata, dict) else {},
            result_artifact=result_artifact,
        )

    def _update_run_and_conversation(
        self,
        state: WorkspaceGraphState,
        *,
        result_artifact: dict[str, Any],
    ) -> None:
        run = self.runner.db.get(AIAgentRun, state["run_id"])
        conversation = self.runner.db.get(AIConversation, state["conversation_id"])
        if run is not None:
            run.status = "running"
            context_summary = dict(run.context_summary or {})
            context_summary["lastHumanInputResult"] = result_artifact["payload"]
            run.context_summary = self.runner._json_record(context_summary)
        if conversation is not None:
            conversation.last_run_status = "running"
            conversation.context = self.runner._json_record(
                human_input_conversation_context(
                    conversation.context if isinstance(conversation.context, dict) else {},
                    result_payload=result_artifact["payload"],
                )
            )

