from __future__ import annotations

from collections.abc import Iterator
import json
import logging
from time import perf_counter
from typing import TYPE_CHECKING, Any

from fastapi.encoders import jsonable_encoder
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError, AIExecutionCancelled
from app.ai.clarifications import PENDING_CLARIFICATION_KEY
from app.ai.planning import PlannerRequest, WorkspacePlanner
from app.ai.planning.schemas import PlannerResult
from app.ai.skills import SkillContext, SkillExecutor, SkillResult, build_workspace_skill_registry
from app.ai.skills.shared import result_artifacts
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.ai.workflows.conversations import (
    find_active_conversation_run,
    find_idempotent_run,
    get_or_create_conversation,
    normalize_workspace_subject,
    require_conversation,
)
from app.ai.workflows.plan_metadata import agent_key_for_plan, intent_for_plan
from app.ai.workflows.result_cards import normalize_result_cards
from app.ai.workflows.state import WorkspaceGraphState
from app.ai.workflows.timeline import build_planner_conversation
from app.core.utils import create_id, utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIRunEvent,
    AITaskDraft,
)
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_message,
    serialize_ai_run,
    serialize_ai_run_event,
    serialize_ai_task_draft,
)

if TYPE_CHECKING:
    from app.ai.workspace_service import AIApplicationService

logger = logging.getLogger(__name__)


class WorkspaceGraphRunner:
    def __init__(self, service: AIApplicationService) -> None:
        self.service = service
        self.db = service.db
        self.provider = service.provider
        self.skill_registry = build_workspace_skill_registry()
        self.checkpointer = SQLAlchemyCheckpointSaver(self.db)
        self.graph = self._build_graph()

    def invoke_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        message: str,
        conversation_id: str | None = None,
        client_message_id: str | None = None,
        client_run_id: str | None = None,
        quick_task: str | None = None,
        subject: dict[str, Any] | None = None,
        preplanned_plan: PlannerResult | None = None,
        general_text: str | None = None,
    ) -> dict[str, Any]:
        prompt = message.strip()
        if not prompt:
            raise ValueError("消息不能为空")
        prepared = self._prepare_user_message(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
        )
        if prepared["existing"]:
            return self._chat_response(prepared["conversation_id"], prepared["run_id"])
        conversation_id = prepared["conversation_id"]
        config = self._config(conversation_id)
        logger.info(
            "AI graph invoke started family_id=%s user_id=%s conversation_id=%s client_run_id=%s quick_task=%s message_length=%s",
            family_id,
            user_id,
            conversation_id,
            client_run_id,
            quick_task,
            len(prompt),
        )
        output = self.graph.invoke(
            {
                "family_id": family_id,
                "user_id": user_id,
                "conversation_id": conversation_id,
                "message": prompt,
                "client_message_id": client_message_id,
                "client_run_id": client_run_id,
                "quick_task": quick_task,
                "subject": prepared["subject"],
                "preplanned_plan": preplanned_plan.model_dump(mode="json") if preplanned_plan is not None else {},
                "general_text": general_text or "",
                "run_artifacts": [],
                "skill_index": 0,
                "status": "running",
                "error": None,
                "run_id": prepared["run_id"],
                "user_message_id": prepared["user_message_id"],
            },
            config=config,
            durability="sync",
        )
        run_id = str(output.get("run_id") or "")
        if not run_id:
            state = self.graph.get_state(config)
            run_id = str(state.values.get("run_id") or "")
        logger.info(
            "AI graph invoke completed family_id=%s user_id=%s conversation_id=%s run_id=%s",
            family_id,
            user_id,
            conversation_id,
            run_id,
        )
        return self._chat_response(conversation_id, run_id)

    def stream_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        message: str,
        conversation_id: str | None = None,
        client_message_id: str | None = None,
        client_run_id: str | None = None,
        quick_task: str | None = None,
        subject: dict[str, Any] | None = None,
        preplanned_plan: PlannerResult | None = None,
        general_text: str | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        prompt = message.strip()
        if not prompt:
            raise ValueError("消息不能为空")
        prepared = self._prepare_user_message(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
        )
        if prepared["existing"]:
            return iter(
                [
                    (
                        "response",
                        self._chat_response(prepared["conversation_id"], prepared["run_id"]),
                    )
                ]
            )
        return self._stream_prepared_user_message(
            family_id=family_id,
            user_id=user_id,
            prompt=prompt,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            prepared=prepared,
            preplanned_plan=preplanned_plan,
            general_text=general_text,
        )

    def _stream_prepared_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        prompt: str,
        client_message_id: str | None,
        client_run_id: str | None,
        quick_task: str | None,
        prepared: dict[str, Any],
        preplanned_plan: PlannerResult | None,
        general_text: str | None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        conversation_id = str(prepared["conversation_id"])
        config = self._config(conversation_id)
        run_id = str(prepared["run_id"])
        seen_event_ids: set[str] = set()
        logger.info(
            "AI graph stream started family_id=%s user_id=%s conversation_id=%s client_run_id=%s quick_task=%s message_length=%s",
            family_id,
            user_id,
            conversation_id,
            client_run_id,
            quick_task,
            len(prompt),
        )
        try:
            for chunk in self.graph.stream(
                {
                    "family_id": family_id,
                    "user_id": user_id,
                    "conversation_id": conversation_id,
                    "message": prompt,
                    "client_message_id": client_message_id,
                    "client_run_id": client_run_id,
                    "quick_task": quick_task,
                    "subject": prepared["subject"],
                    "preplanned_plan": preplanned_plan.model_dump(mode="json") if preplanned_plan is not None else {},
                    "general_text": general_text or "",
                    "run_artifacts": [],
                    "skill_index": 0,
                    "status": "running",
                    "error": None,
                    "run_id": run_id,
                    "user_message_id": prepared["user_message_id"],
                },
                config=config,
                stream_mode=["updates", "custom"],
                durability="sync",
            ):
                mode, update = chunk if isinstance(chunk, tuple) else ("updates", chunk)
                if mode == "custom":
                    event, data = self._custom_stream_event(update)
                    if event:
                        if event == "progress" and isinstance(data.get("id"), str):
                            seen_event_ids.add(data["id"])
                        yield (event, data)
                    continue
                if mode != "updates":
                    continue
                if run_id:
                    yield from self._new_progress_events(run_id, seen_event_ids)
        except GeneratorExit:
            self._cancel_after_disconnect(run_id)
            raise
        except Exception as exc:
            self._mark_stream_run_failed(
                run_id=run_id,
                conversation_id=conversation_id,
                family_id=family_id,
                user_id=user_id,
                error=str(exc),
            )
            raise

        if run_id:
            yield from self._new_progress_events(run_id, seen_event_ids)
        logger.info(
            "AI graph stream completed family_id=%s user_id=%s conversation_id=%s run_id=%s",
            family_id,
            user_id,
            conversation_id,
            run_id,
        )
        yield ("response", self._chat_response(conversation_id, run_id))

    def _prepare_user_message(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str | None,
        prompt: str,
        client_message_id: str | None,
        client_run_id: str | None,
        quick_task: str | None,
        subject: dict[str, Any] | None,
    ) -> dict[str, Any]:
        normalized_subject = normalize_workspace_subject(self.db, family_id=family_id, subject=subject)
        existing = find_idempotent_run(
            self.db,
            family_id=family_id,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
        )
        if existing is not None:
            return self._prepared_existing_run(existing, normalized_subject)

        conversation = get_or_create_conversation(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            quick_task=quick_task,
        )
        active_run = find_active_conversation_run(
            self.db,
            family_id=family_id,
            conversation_id=conversation.id,
        )
        if active_run is not None:
            raise AIConflictError("当前会话已有 AI 任务正在处理中，请稍后再发送。")
        user_message = AIMessage(
            id=create_id("ai_message"),
            family_id=family_id,
            conversation_id=conversation.id,
            role="user",
            content=prompt,
            content_type="text",
            parts=[{"id": create_id("ai_part"), "type": "text", "text": prompt}],
            status="completed",
            client_message_id=client_message_id,
            created_by=user_id,
        )
        self.db.add(user_message)
        self.db.flush()
        timeline = build_planner_conversation(
            self.db,
            family_id=family_id,
            conversation_id=conversation.id,
            quick_task=quick_task,
        )
        run = AIAgentRun(
            id=client_run_id or create_id("agent_run"),
            family_id=family_id,
            conversation_id=conversation.id,
            message_id=user_message.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="",
            input_summary=prompt[:255],
            context_summary={"graph": {"runtime": "langgraph", "threadId": conversation.id}},
            output_summary="",
            status="running",
            model=getattr(self.provider, "model_name", ""),
            input={
                "prompt": prompt,
                "quickTask": quick_task,
                "subject": normalized_subject,
                "conversation": timeline,
            },
            output={},
            tool_calls=[],
            duration_ms=0,
            created_by=user_id,
        )
        self.db.add(run)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = find_idempotent_run(
                self.db,
                family_id=family_id,
                client_message_id=client_message_id,
                client_run_id=client_run_id,
            )
            if existing is None:
                raise
            return self._prepared_existing_run(existing, normalized_subject)
        logger.info(
            "AI run prepared run_id=%s conversation_id=%s family_id=%s user_id=%s client_message_id=%s",
            run.id,
            conversation.id,
            family_id,
            user_id,
            client_message_id,
        )
        return {
            "existing": False,
            "conversation_id": conversation.id,
            "run_id": run.id,
            "user_message_id": user_message.id,
            "subject": normalized_subject,
        }

    def _prepared_existing_run(self, run: AIAgentRun, subject: dict[str, Any]) -> dict[str, Any]:
        if run.status in {"pending", "running"}:
            raise AIConflictError("该消息正在处理中")
        if not run.conversation_id:
            raise AIConflictError("已有运行缺少会话，不能重复执行")
        assistant_message = self.db.scalar(
            select(AIMessage.id).where(
                AIMessage.family_id == run.family_id,
                AIMessage.run_id == run.id,
                AIMessage.role == "assistant",
            )
        )
        if assistant_message is None:
            raise AIConflictError("该消息已处理，但没有可复用的回复")
        return {
            "existing": True,
            "conversation_id": run.conversation_id,
            "run_id": run.id,
            "user_message_id": run.message_id,
            "subject": subject,
        }

    def _cancel_requested(self, run_id: str) -> bool:
        bind = self.db.get_bind()
        if bind.dialect.name == "sqlite":
            self.db.expire_all()
            status = self.db.scalar(
                select(AIAgentRun.status)
                .where(AIAgentRun.id == run_id)
                .execution_options(populate_existing=True)
            )
            return status == "cancelled"
        with Session(bind=bind) as db:
            status = db.scalar(select(AIAgentRun.status).where(AIAgentRun.id == run_id))
            return status == "cancelled"

    def _cancel_after_disconnect(self, run_id: str) -> None:
        self.db.rollback()
        run = self.db.get(AIAgentRun, run_id)
        if run is None or run.status not in {"pending", "running"}:
            return
        self.service.cancel_run(
            family_id=run.family_id,
            user_id=run.created_by or "",
            run_id=run.id,
        )
        self.db.commit()

    def _mark_stream_run_failed(
        self,
        *,
        run_id: str,
        conversation_id: str,
        family_id: str,
        user_id: str,
        error: str,
    ) -> None:
        try:
            self.db.rollback()
            run = self.db.get(AIAgentRun, run_id)
            if run is None or run.status in {"completed", "failed", "cancelled", "waiting_approval"}:
                return
            text = "AI 服务暂时不可用，请稍后重试。"
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
                    status="failed",
                    message_metadata={"intent": run.intent or "runtime_failed", "agentKey": run.agent_key or "workspace_orchestrator"},
                    created_by=user_id,
                )
                self.db.add(message)
            else:
                message.status = "failed"
                if not message.content:
                    message.content = text
                if not message.parts:
                    message.parts = [{"id": create_id("ai_part"), "type": "text", "text": message.content or text}]

            event = AIRunEvent(
                id=create_id("ai_run_event"),
                family_id=family_id,
                conversation_id=conversation_id,
                run_id=run_id,
                type="error",
                internal_code="runtime_exception",
                user_message=text,
                status="failed",
                payload={"error": error[:1000]},
            )
            self.db.add(event)
            run.status = "failed"
            run.error = error or text
            run.output_summary = text
            run.output = self._json_record({"text": text, "cards": [], "routing": (run.context_summary or {}).get("routing", {})})
            conversation = self.db.get(AIConversation, conversation_id)
            if conversation is not None:
                conversation.last_run_status = "failed"
                conversation.last_message_at = utcnow()
                if not conversation.response:
                    conversation.response = text
                    conversation.summary = text[:255]
            self.db.commit()
        except Exception:
            self.db.rollback()
            logger.exception(
                "AI graph failed to persist stream error run_id=%s conversation_id=%s family_id=%s",
                run_id,
                conversation_id,
                family_id,
            )

    def resume_approval(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        approval_id: str,
        decision: str,
        draft_version: int,
        values: dict[str, Any],
        comment: str | None = None,
    ) -> dict[str, Any]:
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
        config = self._config(conversation_id)
        snapshot = self.graph.get_state(config)
        logger.info(
            "AI graph approval resume started family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s draft_version=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            draft_version,
            bool(snapshot.values),
            list(snapshot.next or []),
        )
        pending = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if pending is None:
            logger.warning(
                "AI graph approval resume missing approval family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            raise LookupError("确认请求不存在")

        # Approvals created before the LangGraph migration remain processable.
        if not snapshot.values or not snapshot.next:
            logger.info(
                "AI graph approval resume using legacy path family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            return self.service._apply_approval_decision(
                family_id=family_id,
                user_id=user_id,
                conversation_id=conversation_id,
                approval_id=approval_id,
                decision=decision,
                draft_version=draft_version,
                values=values,
                comment=comment,
            )

        output = self.graph.invoke(
            Command(
                resume={
                    "approvalId": approval_id,
                    "decision": decision,
                    "draftVersion": draft_version,
                    "values": values,
                    "comment": comment,
                    "userId": user_id,
                    "familyId": family_id,
                }
            ),
            config=config,
            durability="sync",
        )
        result = output.get("last_decision")
        if not isinstance(result, dict):
            state = self.graph.get_state(config)
            result = state.values.get("last_decision")
        if not isinstance(result, dict):
            logger.error(
                "AI graph approval resume missing result family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval_id,
            )
            raise RuntimeError("LangGraph 恢复后没有生成确认结果")
        logger.info(
            "AI graph approval resume completed family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s operation_status=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            (result.get("operation") or {}).get("status") if isinstance(result.get("operation"), dict) else None,
        )
        return result

    def stream_resume_approval(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        approval_id: str,
        decision: str,
        draft_version: int,
        values: dict[str, Any],
        comment: str | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)
        config = self._config(conversation_id)
        snapshot = self.graph.get_state(config)
        pending = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if pending is None:
            raise LookupError("确认请求不存在")
        run_id = pending.run_id or str((snapshot.values or {}).get("run_id") or "")
        logger.info(
            "AI graph approval stream resume started family_id=%s user_id=%s conversation_id=%s approval_id=%s decision=%s draft_version=%s run_id=%s has_snapshot=%s next=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            decision,
            draft_version,
            run_id,
            bool(snapshot.values),
            list(snapshot.next or []),
        )

        if not snapshot.values or not snapshot.next:
            self.service._apply_approval_decision(
                family_id=family_id,
                user_id=user_id,
                conversation_id=conversation_id,
                approval_id=approval_id,
                decision=decision,
                draft_version=draft_version,
                values=values,
                comment=comment,
            )
            if not run_id:
                raise RuntimeError("确认请求缺少可恢复的运行任务")
            yield ("response", self._chat_response(conversation_id, run_id))
            return

        seen_event_ids: set[str] = set()
        try:
            for chunk in self.graph.stream(
                Command(
                    resume={
                        "approvalId": approval_id,
                        "decision": decision,
                        "draftVersion": draft_version,
                        "values": values,
                        "comment": comment,
                        "userId": user_id,
                        "familyId": family_id,
                    }
                ),
                config=config,
                stream_mode=["updates", "custom"],
                durability="sync",
            ):
                mode, update = chunk if isinstance(chunk, tuple) else ("updates", chunk)
                if mode == "custom":
                    event, data = self._custom_stream_event(update)
                    if event:
                        if event == "progress" and isinstance(data.get("id"), str):
                            seen_event_ids.add(data["id"])
                        yield (event, data)
                    continue
                if mode != "updates":
                    continue
                if not run_id:
                    run_id = self._run_id_from_update(update) or run_id
                if run_id:
                    yield from self._new_progress_events(run_id, seen_event_ids)
        except GeneratorExit:
            if run_id:
                self._cancel_after_disconnect(run_id)
            raise
        except Exception as exc:
            if run_id:
                self._mark_stream_run_failed(
                    run_id=run_id,
                    conversation_id=conversation_id,
                    family_id=family_id,
                    user_id=user_id,
                    error=str(exc),
                )
            raise

        if not run_id:
            state = self.graph.get_state(config)
            run_id = str(state.values.get("run_id") or "")
        if run_id:
            yield from self._new_progress_events(run_id, seen_event_ids)
        logger.info(
            "AI graph approval stream resume completed family_id=%s user_id=%s conversation_id=%s approval_id=%s run_id=%s",
            family_id,
            user_id,
            conversation_id,
            approval_id,
            run_id,
        )
        yield ("response", self._chat_response(conversation_id, run_id))

    def delete_thread(self, conversation_id: str) -> None:
        self.checkpointer.delete_thread(conversation_id)

    def _build_graph(self):
        graph = StateGraph(WorkspaceGraphState)
        graph.add_node("initialize", self._initialize)
        graph.add_node("planner", self._planner)
        graph.add_node("general_chat", self._general_chat)
        graph.add_node("skill_step", self._skill_step)
        graph.add_node("finalize", self._finalize)
        graph.add_edge(START, "initialize")
        graph.add_edge("initialize", "planner")
        graph.add_conditional_edges(
            "planner",
            self._route_after_plan,
            {"general_chat": "general_chat", "skill_step": "skill_step", "finalize": "finalize"},
        )
        graph.add_edge("general_chat", "finalize")
        graph.add_conditional_edges(
            "skill_step",
            self._route_after_skill,
            {"skill_step": "skill_step", "finalize": "finalize"},
        )
        graph.add_edge("finalize", END)
        return graph.compile(checkpointer=self.checkpointer)

    def _initialize(self, state: WorkspaceGraphState) -> dict[str, Any]:
        if state.get("run_id") and state.get("user_message_id"):
            run = self.db.get(AIAgentRun, state["run_id"])
            user_message = self.db.get(AIMessage, state["user_message_id"])
            if run is None or user_message is None:
                raise RuntimeError("预创建的 AI 运行状态不存在")
            return {
                "run_id": run.id,
                "user_message_id": user_message.id,
                "status": "cancelled" if run.status == "cancelled" else "running",
            }
        conversation = require_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
        )
        user_message = AIMessage(
            id=create_id("ai_message"),
            family_id=state["family_id"],
            conversation_id=conversation.id,
            role="user",
            content=state["message"],
            content_type="text",
            parts=[{"id": create_id("ai_part"), "type": "text", "text": state["message"]}],
            status="completed",
            client_message_id=state.get("client_message_id"),
            created_by=state["user_id"],
        )
        self.db.add(user_message)
        self.db.flush()
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=conversation.id,
            quick_task=state.get("quick_task"),
        )
        run = AIAgentRun(
            id=state.get("client_run_id") or create_id("agent_run"),
            family_id=state["family_id"],
            conversation_id=conversation.id,
            message_id=user_message.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="",
            input_summary=state["message"][:255],
            context_summary={"graph": {"runtime": "langgraph", "threadId": conversation.id}},
            output_summary="",
            status="running",
            model=getattr(self.provider, "model_name", ""),
            input={
                "prompt": state["message"],
                "quickTask": state.get("quick_task"),
                "subject": state.get("subject") or {},
                "conversation": timeline,
            },
            output={},
            tool_calls=[],
            duration_ms=0,
            created_by=state["user_id"],
        )
        self.db.add(run)
        self.db.flush()
        self.db.flush()
        logger.info(
            "AI graph initialized run_id=%s conversation_id=%s family_id=%s user_id=%s client_run_id=%s",
            run.id,
            conversation.id,
            state["family_id"],
            state["user_id"],
            state.get("client_run_id"),
        )
        return {"run_id": run.id, "user_message_id": user_message.id, "status": "running"}

    def _planner(self, state: WorkspaceGraphState) -> dict[str, Any]:
        if self._cancel_requested(state["run_id"]):
            return {"plan": PlannerResult(skills=[]).model_dump(mode="json"), "status": "cancelled"}
        logger.info(
            "AI planner started run_id=%s conversation_id=%s family_id=%s preplanned=%s",
            state.get("run_id"),
            state["conversation_id"],
            state["family_id"],
            bool(state.get("preplanned_plan")),
        )
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        if not timeline:
            timeline = [
                {
                    "id": state.get("user_message_id") or "current-user-message",
                    "role": "user",
                    "content": state["message"],
                    "metadata": {"quickTask": state.get("quick_task")},
                    "artifacts": [],
                }
            ]
        if state.get("preplanned_plan"):
            plan = PlannerResult.model_validate(state["preplanned_plan"])
        elif state.get("quick_task") == "today_recommendation":
            plan = PlannerResult(
                skills=["meal_plan"],
                raw_response='{"skills":["meal_plan"]}',
                attempts=0,
                structured_mode="quick_task",
            )
        else:
            conversation = self.db.get(AIConversation, state["conversation_id"])
            conversation_context = dict(conversation.context or {}) if conversation is not None else {}
            task_state = conversation_context.get("taskState") if isinstance(conversation_context.get("taskState"), dict) else {}
            pending_clarification = task_state.get(PENDING_CLARIFICATION_KEY) if isinstance(task_state, dict) else None
            planner = WorkspacePlanner(provider=self.provider, skill_registry=self.skill_registry)
            plan = planner.plan(
                PlannerRequest(
                    family_id=state["family_id"],
                    user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    conversation=timeline,
                    available_skills=[manifest.to_planner_record() for manifest in self.skill_registry.list_manifests()],
                    pending_clarification=pending_clarification if isinstance(pending_clarification, dict) else None,
                )
            )
        if self._cancel_requested(state["run_id"]):
            return {"plan": plan.model_dump(mode="json"), "status": "cancelled"}
        run = self.db.get(AIAgentRun, state["run_id"])
        if run is not None:
            run.intent = intent_for_plan(self.skill_registry, plan)
            run.agent_key = agent_key_for_plan(self.skill_registry, plan)
            run.context_summary = {
                **(run.context_summary or {}),
                "routing": {
                    "intent": run.intent,
                    "agentKey": run.agent_key,
                    "skills": plan.skills,
                    "plannedSkillCount": len(plan.skills),
                    "plannerAttempts": plan.attempts,
                    "plannerRawResponse": plan.raw_response,
                    "plannerError": plan.error,
                    "plannerDiagnostic": plan.diagnostic,
                    "plannerStructuredMode": plan.structured_mode,
                },
            }
            if plan.failed:
                run.status = "failed"
                run.error = plan.error
        self.db.flush()
        if plan.failed:
            logger.warning(
                "AI planner failed run_id=%s conversation_id=%s family_id=%s error=%s diagnostic=%s attempts=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                plan.error,
                plan.diagnostic,
                plan.attempts,
            )
        else:
            logger.info(
                "AI planner completed run_id=%s conversation_id=%s family_id=%s skills=%s attempts=%s structured_mode=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                plan.skills,
                plan.attempts,
                plan.structured_mode,
            )
        return {
            "plan": plan.model_dump(mode="json"),
            "skill_index": 0,
            "status": "failed" if plan.failed else "running",
            "error": plan.error,
        }

    def _general_chat(self, state: WorkspaceGraphState) -> dict[str, Any]:
        text = str(state.get("general_text") or "").strip()
        try:
            if self._cancel_requested(state["run_id"]):
                raise AIExecutionCancelled("AI run was cancelled")
            result = SkillResult(text=text, model=getattr(self.provider, "model_name", "")) if text else self._stream_general_chat(state)
        except AIExecutionCancelled:
            result = SkillResult(
                text="已取消这次任务。",
                status="cancelled",
                model=getattr(self.provider, "model_name", ""),
            )
        self._persist_assistant_result(state, result, skill_key=None)
        return {"status": result.status, "error": result.error}

    def _stream_general_chat(self, state: WorkspaceGraphState) -> SkillResult:
        writer = get_stream_writer()
        message_id = create_id("ai_message")
        part_id = create_id("ai_part")
        chunks: list[str] = []
        system = """
        你是 Culina 的厨房助手，负责家庭厨房场景下的普通聊天、做饭答疑、食材建议、烹饪技巧、饮食搭配和轻量决策。

        回答要求：
        1. 简短、自然、实用，优先给出用户马上能执行的建议。
        2. 可以结合用户当前提供的家庭成员、饮食偏好、库存食材、餐食计划、历史记录等上下文回答；没有上下文时不要编造。
        3. 上下文不足时，可以先给通用建议；确实需要补充信息时，只追问一个关键问题。
        4. 不承诺已经写入、修改、删除或保存任何系统数据。
        5. 涉及饮食记录、餐食计划、库存管理、用户画像更新等真实数据变更时，不要假装已完成，只能说明可以先帮用户整理。
        6. 不提供医疗诊断，不夸大营养功效。

        当用户只是闲聊、询问做饭技巧、问某个食材怎么处理、想要简单建议时，直接回答。
        """.strip()
        current_message = str(state.get("message") or "").strip()
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        prompt = json.dumps(
            {
                "currentMessage": current_message,
                "subject": state.get("subject") or {},
                "conversation": timeline,
            },
            ensure_ascii=False,
            default=str,
        )
        model = getattr(self.provider, "model_name", "")
        if current_message:
            if self._cancel_requested(state["run_id"]):
                raise AIExecutionCancelled("AI run was cancelled")
            for chunk in self.provider.stream_generate(system=system, user=prompt):
                if self._cancel_requested(state["run_id"]):
                    raise AIExecutionCancelled("AI run was cancelled")
                if not chunk:
                    continue
                chunks.append(chunk)
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
        text = "".join(chunks).strip()
        if not text:
            text = "我在，可以问我做饭技巧、食材处理、简单搭配，或者让我帮你想一顿饭。"
            for index in range(0, len(text), 12):
                writer(
                    {
                        "event": "message_delta",
                        "data": {
                            "message_id": message_id,
                            "conversation_id": state["conversation_id"],
                            "run_id": state["run_id"],
                            "part_id": part_id,
                            "delta": text[index : index + 12],
                        },
                    }
                )
        return SkillResult(text=text, model=model)

    def _skill_step(self, state: WorkspaceGraphState) -> dict[str, Any]:
        if self._cancel_requested(state["run_id"]):
            return {"status": "cancelled"}
        pending = self.db.scalar(
            select(AIApprovalRequest)
            .where(
                AIApprovalRequest.family_id == state["family_id"],
                AIApprovalRequest.conversation_id == state["conversation_id"],
                AIApprovalRequest.run_id == state["run_id"],
                AIApprovalRequest.status == "pending",
            )
            .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
        )
        if pending is not None:
            logger.info(
                "AI graph waiting for approval run_id=%s conversation_id=%s family_id=%s approval_id=%s draft_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                pending.draft_id,
            )
            resume = interrupt(self._approval_interrupt_payload(pending))
            return self._resume_pending_approval(state, pending, resume, list(state.get("run_artifacts") or []))

        plan = PlannerResult.model_validate(state.get("plan") or {})
        index = int(state.get("skill_index") or 0)
        if index >= len(plan.skills):
            logger.info(
                "AI graph skill step reached end run_id=%s conversation_id=%s family_id=%s skill_index=%s skill_count=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                index,
                len(plan.skills),
            )
            return {"status": "completed"}
        skill_key = plan.skills[index]
        logger.info(
            "AI graph skill step started run_id=%s conversation_id=%s family_id=%s skill=%s skill_index=%s skill_count=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            skill_key,
            index,
            len(plan.skills),
        )
        stream_writer = self._persistent_progress_writer(get_stream_writer(), state)
        root_tools = ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=self.db,
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                run_id=state["run_id"],
                stream_writer=stream_writer,
                cancel_check=lambda: self._cancel_requested(state["run_id"]),
            ),
        )
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        conversation = self.db.get(AIConversation, state["conversation_id"])
        conversation_context = dict(conversation.context or {}) if conversation is not None else {}
        task_state = conversation_context.get("taskState") if isinstance(conversation_context.get("taskState"), dict) else {}
        pending_clarification = task_state.get(PENDING_CLARIFICATION_KEY) if isinstance(task_state, dict) else None
        started_at = perf_counter()
        try:
            result = SkillExecutor(self.skill_registry).run_step(
                skill_key,
                SkillContext(
                    db=self.db,
                    family_id=state["family_id"],
                    user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    run_id=state["run_id"],
                    conversation=timeline,
                    current_message=state["message"],
                    subject=state.get("subject") or {},
                    tool_executor=root_tools,
                    provider=self.provider,
                    current_run_artifacts=list(state.get("run_artifacts") or []),
                    pending_clarification=pending_clarification if isinstance(pending_clarification, dict) else None,
                    stream_writer=stream_writer,
                    cancel_check=lambda: self._cancel_requested(state["run_id"]),
                )
            )
        except AIExecutionCancelled:
            result = SkillResult(
                text="已取消这次任务。",
                status="cancelled",
                model=getattr(self.provider, "model_name", ""),
            )
        self._persist_assistant_result(state, result, skill_key=skill_key, duration_ms=int((perf_counter() - started_at) * 1000))
        run_artifacts = [*(state.get("run_artifacts") or []), *result_artifacts(skill_key, result)]
        logger.info(
            "AI graph skill step completed run_id=%s conversation_id=%s family_id=%s skill=%s status=%s drafts=%s cards=%s tool_calls=%s duration_ms=%s error=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            skill_key,
            result.status,
            len(result.drafts),
            len(result.cards),
            len(result.tool_calls),
            int((perf_counter() - started_at) * 1000),
            result.error,
        )
        if result.drafts:
            pending = self.db.scalar(
                select(AIApprovalRequest)
                .where(
                    AIApprovalRequest.run_id == state["run_id"],
                    AIApprovalRequest.status == "pending",
                )
                .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
            )
            if pending is None:
                logger.error(
                    "AI graph missing approval after draft creation run_id=%s conversation_id=%s family_id=%s skill=%s drafts=%s",
                    state["run_id"],
                    state["conversation_id"],
                    state["family_id"],
                    skill_key,
                    len(result.drafts),
                )
                raise RuntimeError("草稿已生成，但没有创建确认请求")
            logger.info(
                "AI graph interrupting for approval run_id=%s conversation_id=%s family_id=%s skill=%s approval_id=%s draft_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                skill_key,
                pending.id,
                pending.draft_id,
            )
            resume = interrupt(self._approval_interrupt_payload(pending))
            return self._resume_pending_approval(state, pending, resume, run_artifacts)
        if result.requires_clarification:
            return {"skill_index": index + 1, "run_artifacts": run_artifacts, "status": "completed", "error": result.error}
        if result.status in {"failed", "cancelled"}:
            return {"run_artifacts": run_artifacts, "status": result.status, "error": result.error}
        return {"skill_index": index + 1, "run_artifacts": run_artifacts, "status": "running"}

    def _resume_pending_approval(
        self,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        resume: Any,
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if not isinstance(resume, dict):
            logger.warning(
                "AI graph approval resume invalid payload run_id=%s conversation_id=%s family_id=%s approval_id=%s payload_type=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                type(resume).__name__,
            )
            raise ValueError("确认恢复参数格式不正确")
        if str(resume.get("approvalId") or "") != pending.id:
            logger.warning(
                "AI graph approval resume mismatched approval run_id=%s conversation_id=%s family_id=%s pending_approval_id=%s resume_approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                resume.get("approvalId"),
            )
            raise ValueError("确认请求与当前暂停任务不匹配")
        if str(resume.get("familyId") or "") != state["family_id"]:
            logger.warning(
                "AI graph approval resume mismatched family run_id=%s conversation_id=%s family_id=%s resume_family_id=%s approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                resume.get("familyId"),
                pending.id,
            )
            raise LookupError("确认请求不存在")
        result = self.service._apply_approval_decision(
            family_id=state["family_id"],
            user_id=str(resume.get("userId") or state["user_id"]),
            conversation_id=state["conversation_id"],
            approval_id=pending.id,
            decision=str(resume.get("decision") or ""),
            draft_version=int(resume.get("draftVersion") or 0),
            values=resume.get("values") if isinstance(resume.get("values"), dict) else {},
            comment=str(resume.get("comment") or "") or None,
        )
        serialized = jsonable_encoder(result)
        approval_artifacts = self.service._approval_decision_artifacts(serialized)
        operation = result.get("operation")
        next_approval = result.get("approval")
        decision_draft = result.get("draft") if isinstance(result.get("draft"), dict) else {}
        decision_draft_type = str(decision_draft.get("draft_type") or "")
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        if isinstance(next_approval, dict) and next_approval.get("status") == "pending":
            logger.warning(
                "AI graph approval operation requires retry run_id=%s conversation_id=%s family_id=%s approval_id=%s next_approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                next_approval.get("id"),
            )
            if run is not None:
                run.status = "waiting_approval"
            if conversation is not None:
                conversation.last_run_status = "waiting_approval"
            self.db.flush()
            return {"status": "waiting_approval", "last_decision": serialized, "run_artifacts": [*run_artifacts, *approval_artifacts]}
        if str(resume.get("decision")) == "rejected":
            logger.info(
                "AI graph approval rejected run_id=%s conversation_id=%s family_id=%s approval_id=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
            )
            if run is not None:
                run.status = "running"
                self._record_approval_outcome(run, approval_status="rejected", draft_type=decision_draft_type)
            if conversation is not None:
                conversation.last_run_status = "running"
            self.db.flush()
            self._stream_approval_followup(state, serialized, terminal_status="cancelled")
            if run is not None:
                run.status = "cancelled"
            if conversation is not None:
                conversation.last_run_status = "cancelled"
            self.db.flush()
            return {"status": "cancelled", "last_decision": serialized, "run_artifacts": [*run_artifacts, *approval_artifacts]}
        if not isinstance(operation, dict) or operation.get("status") != "succeeded":
            logger.warning(
                "AI graph approval operation failed run_id=%s conversation_id=%s family_id=%s approval_id=%s operation=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                pending.id,
                operation,
            )
            if run is not None:
                run.status = "failed"
            if conversation is not None:
                conversation.last_run_status = "failed"
            self.db.flush()
            return {"status": "failed", "last_decision": serialized, "error": "草稿写入失败", "run_artifacts": [*run_artifacts, *approval_artifacts]}
        if run is not None:
            run.status = "running"
            self._record_approval_outcome(
                run,
                approval_status="approved",
                draft_type=decision_draft_type,
            )
        if conversation is not None:
            conversation.last_run_status = "running"
        self.db.flush()
        next_skill_index = int(state.get("skill_index") or 0) + 1
        plan = PlannerResult.model_validate(state.get("plan") or {})
        if next_skill_index >= len(plan.skills):
            self._stream_approval_followup(state, serialized, terminal_status="completed")
        return {
            "skill_index": next_skill_index,
            "run_artifacts": [*run_artifacts, *approval_artifacts],
            "status": "completed" if next_skill_index >= len(plan.skills) else "running",
            "last_decision": serialized,
        }

    def _persist_assistant_result(
        self,
        state: WorkspaceGraphState,
        result: SkillResult,
        *,
        skill_key: str | None,
        duration_ms: int = 0,
    ) -> AIMessage:
        if self._cancel_requested(state["run_id"]):
            result.status = "cancelled"
            result.cards = []
            result.drafts = []
            result.error = result.error or "用户取消了这次任务"
            if not result.text.strip():
                result.text = "已取消这次任务。"
        cards = [] if result.drafts else normalize_result_cards(result.cards)
        next_parts: list[dict[str, Any]] = [{"id": create_id("ai_part"), "type": "text", "text": result.text}]
        for card in cards:
            next_parts.append({"id": create_id("ai_part"), "type": "result_card", "card": card})
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        metadata = dict(message.message_metadata or {}) if message is not None else {}
        if message is None:
            metadata = {
                "intent": self.skill_registry.get(skill_key).manifest.intent if skill_key else "general_chat",
                "agentKey": self.skill_registry.get(skill_key).manifest.agent_key if skill_key else "general_chat_agent",
                "skillKey": skill_key,
            }
            message = AIMessage(
                id=create_id("ai_message"),
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                role="assistant",
                content=result.text,
                content_type="parts",
                parts=next_parts,
                run_id=state["run_id"],
                status="waiting_approval" if result.drafts else result.status,
                message_metadata=metadata,
                created_by=state["user_id"],
            )
            self.db.add(message)
        else:
            existing_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
            message.parts = [*existing_parts, *next_parts]
            if skill_key:
                skill_keys = list(metadata.get("skillKeys") or [])
                if not skill_keys and metadata.get("skillKey"):
                    skill_keys.append(str(metadata["skillKey"]))
                skill_keys.append(skill_key)
                metadata["skillKeys"] = list(dict.fromkeys(item for item in skill_keys if item))
                metadata["skillKey"] = skill_key
            message.message_metadata = metadata
        self.db.flush()
        drafts: list[AITaskDraft] = []
        approvals: list[AIApprovalRequest] = []
        for draft_payload in result.drafts:
            draft, approval = self.service._create_draft_approval(
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                draft_payload=draft_payload,
            )
            drafts.append(draft)
            approvals.append(approval)
            message.parts = [
                *(message.parts or []),
                {
                    "id": create_id("ai_part"),
                    "type": "draft",
                    "draft": jsonable_encoder(serialize_ai_task_draft(draft)),
                },
                {
                    "id": create_id("ai_part"),
                    "type": "approval_request",
                    "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
                },
            ]
        if drafts:
            existing_draft_ids = list(metadata.get("draftIds") or [])
            existing_approval_ids = list(metadata.get("approvalIds") or [])
            message.message_metadata = {
                **metadata,
                "draftIds": [*existing_draft_ids, *[item.id for item in drafts]],
                "approvalIds": [*existing_approval_ids, *[item.id for item in approvals]],
            }
        text_parts = [
            str(part.get("text") or "").strip()
            for part in (message.parts or [])
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
        ]
        aggregate_text = "\n\n".join(text_parts)
        message.content = aggregate_text
        message.status = "waiting_approval" if drafts else result.status
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        all_cards = [
            part["card"]
            for part in (message.parts or [])
            if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
        ]
        if run is not None:
            context_summary = dict(run.context_summary or {})
            skill_executions = list(context_summary.get("skillExecutions") or [])
            if skill_key:
                skill_executions.append(
                    {
                        "skillKey": skill_key,
                        "operation": result.operation,
                        "sourceArtifactId": result.source_artifact_id,
                        "status": result.status,
                        "diagnostic": result.diagnostic,
                        "requiresClarification": result.requires_clarification,
                        "clarificationQuestionTypes": self._clarification_question_types(cards),
                        "draftCount": len(drafts),
                    }
                )
            self._record_skill_observation(
                context_summary,
                skill_key=skill_key,
                result=result,
                cards=cards,
                draft_count=len(drafts),
                approval_count=len(approvals),
            )
            context_summary.update(result.context_summary)
            if skill_executions:
                context_summary["skillExecutions"] = skill_executions
            run.status = "waiting_approval" if drafts else result.status
            run.model = result.model or run.model
            run.output_summary = aggregate_text[:255]
            run.output = self._json_record(
                {"text": aggregate_text, "cards": all_cards, "routing": (run.context_summary or {}).get("routing", {})}
            )
            run.tool_calls = self._json_record([*(run.tool_calls or []), *result.tool_calls])
            run.error = result.error
            run.duration_ms = int(run.duration_ms or 0) + duration_ms
            run.context_summary = self._json_record(context_summary)
        if conversation is not None:
            conversation.prompt = state["message"]
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = "waiting_approval" if drafts else result.status
            if result.state_patch:
                context = dict(conversation.context or {})
                task_state = dict(context.get("taskState") or {})
                for key, value in result.state_patch.items():
                    if value is None:
                        task_state.pop(key, None)
                    else:
                        task_state[key] = value
                context["taskState"] = task_state
                conversation.context = context
        self.db.flush()
        return message

    def _remove_task_state_keys(self, conversation_id: str, keys: list[str]) -> None:
        self._patch_task_state(conversation_id, remove_keys=keys, set_values={})

    def _patch_task_state(
        self,
        conversation_id: str,
        *,
        remove_keys: list[str],
        set_values: dict[str, Any],
    ) -> None:
        conversation = self.db.get(AIConversation, conversation_id)
        if conversation is None:
            return
        context = dict(conversation.context or {})
        task_state = dict(context.get("taskState") or {})
        for key in remove_keys:
            task_state.pop(key, None)
        task_state.update(set_values)
        context["taskState"] = task_state
        conversation.context = context
        self.db.flush()

    @staticmethod
    def _json_record(value: Any) -> Any:
        return jsonable_encoder(value)

    @staticmethod
    def _clarification_question_types(cards: list[dict[str, Any]]) -> list[str]:
        question_types: list[str] = []
        for card in cards:
            if str(card.get("type") or "") != "clarification_request":
                continue
            data = card.get("data") if isinstance(card.get("data"), dict) else {}
            question_type = str(data.get("questionType") or "").strip()
            if question_type:
                question_types.append(question_type)
        return list(dict.fromkeys(question_types))

    def _record_skill_observation(
        self,
        context_summary: dict[str, Any],
        *,
        skill_key: str | None,
        result: SkillResult,
        cards: list[dict[str, Any]],
        draft_count: int,
        approval_count: int,
    ) -> None:
        metrics = dict(context_summary.get("runMetrics") or {})
        if skill_key:
            metrics["skillExecutionCount"] = int(metrics.get("skillExecutionCount") or 0) + 1
        if result.status == "completed":
            metrics["completedSkillExecutionCount"] = int(metrics.get("completedSkillExecutionCount") or 0) + (1 if skill_key else 0)
        metrics["toolCallCount"] = int(metrics.get("toolCallCount") or 0) + len(result.tool_calls)
        metrics["draftCount"] = int(metrics.get("draftCount") or 0) + draft_count
        metrics["approvalRequestCount"] = int(metrics.get("approvalRequestCount") or 0) + approval_count

        clarification_types = self._clarification_question_types(cards)
        if clarification_types:
            metrics["clarificationCount"] = int(metrics.get("clarificationCount") or 0) + len(clarification_types)
            clarification = dict(context_summary.get("clarificationStats") or {})
            reasons = dict(clarification.get("reasons") or {})
            for question_type in clarification_types:
                reasons[question_type] = int(reasons.get(question_type) or 0) + 1
            clarification["count"] = int(clarification.get("count") or 0) + len(clarification_types)
            clarification["reasons"] = reasons
            clarification["lastQuestionTypes"] = clarification_types
            if skill_key:
                by_skill = dict(clarification.get("bySkill") or {})
                by_skill[skill_key] = int(by_skill.get(skill_key) or 0) + len(clarification_types)
                clarification["bySkill"] = by_skill
            context_summary["clarificationStats"] = clarification

        context_summary["runMetrics"] = metrics

    @staticmethod
    def _record_approval_outcome(run: AIAgentRun, *, approval_status: str, draft_type: str) -> None:
        context_summary = dict(run.context_summary or {})
        metrics = dict(context_summary.get("runMetrics") or {})
        if approval_status == "approved":
            metrics["approvalApprovedCount"] = int(metrics.get("approvalApprovedCount") or 0) + 1
        elif approval_status == "rejected":
            metrics["approvalRejectedCount"] = int(metrics.get("approvalRejectedCount") or 0) + 1
        context_summary["runMetrics"] = metrics

        approvals = dict(context_summary.get("approvalStats") or {})
        by_draft_type = dict(approvals.get("byDraftType") or {})
        if draft_type:
            bucket = dict(by_draft_type.get(draft_type) or {})
            bucket[approval_status] = int(bucket.get(approval_status) or 0) + 1
            by_draft_type[draft_type] = bucket
        approvals["byDraftType"] = by_draft_type
        approvals["lastDecision"] = {"status": approval_status, "draftType": draft_type or None}
        context_summary["approvalStats"] = approvals
        run.context_summary = context_summary


    def _stream_approval_followup(
        self,
        state: WorkspaceGraphState,
        decision_result: dict[str, Any],
        *,
        terminal_status: str,
    ) -> None:
        approval = decision_result.get("approval") if isinstance(decision_result.get("approval"), dict) else {}
        message_id = str(approval.get("message_id") or "")
        message = self.db.get(AIMessage, message_id) if message_id else None
        if message is None:
            message = self.db.scalar(
                select(AIMessage)
                .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
                .order_by(AIMessage.created_at.desc(), AIMessage.id.desc())
            )
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
        writer = self._optional_stream_writer()
        system = """
        你是 Culina 的厨房助手。你刚收到一个 HumanInLoop 工具的返回结果，这个工具表示用户对你前面生成的确认表单做出了批准或拒绝。

        请把这个工具结果当成普通工具调用结果继续对话：
        1. 用自然、简短、可执行的话接着前文回复。
        2. 如果用户批准并且操作成功，说明结果已按用户确认处理，并给出下一步可以继续做什么。
        3. 如果用户拒绝，尊重这个决定，说明不会按这个草稿写入，并提示可以继续调整或重新整理。
        4. 不要编造没有发生的写入、删除、修改；只依据输入里的 approval、draft、operation、business_entity。
        5. 不要输出 JSON，不要重复表单内容。
        """.strip()
        timeline = build_planner_conversation(
            self.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        payload = {
            "currentMessage": state.get("message") or "",
            "terminalStatus": terminal_status,
            "humanInLoopTool": {
                "name": "approval.decision",
                "result": decision_result,
            },
            "conversation": timeline,
            "subject": state.get("subject") or {},
        }
        try:
            for chunk in self.provider.stream_generate(
                system=system,
                user=json.dumps(payload, ensure_ascii=False, default=str),
            ):
                if self._cancel_requested(state["run_id"]):
                    raise AIExecutionCancelled("AI run was cancelled")
                if not chunk:
                    continue
                chunks.append(chunk)
                if writer is not None:
                    writer(
                        {
                            "event": "message_delta",
                            "data": {
                                "message_id": message.id,
                                "conversation_id": state["conversation_id"],
                                "run_id": state["run_id"],
                                "part_id": part_id,
                                "delta": chunk,
                            },
                        }
                    )
        except AIExecutionCancelled:
            raise
        except Exception as exc:
            logger.warning(
                "AI graph approval follow-up model failed run_id=%s conversation_id=%s family_id=%s error=%s",
                state["run_id"],
                state["conversation_id"],
                state["family_id"],
                exc,
            )
            return

        text = "".join(chunks).strip()
        if not text:
            return
        self._append_text_to_assistant_message(
            state,
            message,
            part_id=part_id,
            text=text,
            status=terminal_status,
        )

    def _optional_stream_writer(self):
        try:
            return get_stream_writer()
        except Exception:
            return None

    def _append_text_to_assistant_message(
        self,
        state: WorkspaceGraphState,
        message: AIMessage,
        *,
        part_id: str,
        text: str,
        status: str,
    ) -> None:
        existing_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        message.parts = [*existing_parts, {"id": part_id, "type": "text", "text": text}]
        text_parts = [
            str(part.get("text") or "").strip()
            for part in message.parts
            if isinstance(part, dict) and part.get("type") == "text" and str(part.get("text") or "").strip()
        ]
        aggregate_text = "\n\n".join(text_parts)
        message.content = aggregate_text
        message.content_type = "parts"
        message.status = status

        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        all_cards = [
            part["card"]
            for part in message.parts
            if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
        ]
        if run is not None:
            run.status = status
            run.model = getattr(self.provider, "model_name", "") or run.model
            run.output_summary = aggregate_text[:255]
            run.output = self._json_record(
                {"text": aggregate_text, "cards": all_cards, "routing": (run.context_summary or {}).get("routing", {})}
            )
            run.error = state.get("error")
        if conversation is not None:
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = status
        self.db.flush()

    def _finalize(self, state: WorkspaceGraphState) -> dict[str, Any]:
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        status = str(state.get("status") or "completed")
        if self._cancel_requested(state["run_id"]):
            status = "cancelled"
        if status == "running":
            status = "completed"
        logger.info(
            "AI graph finalizing run_id=%s conversation_id=%s family_id=%s status=%s error=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            state.get("error"),
        )
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.desc())
        )
        if message is None:
            text = "AI 规划暂时失败，请重试。" if status == "failed" else "任务已结束。"
            message = AIMessage(
                id=create_id("ai_message"),
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                role="assistant",
                content=text,
                content_type="parts",
                parts=[{"id": create_id("ai_part"), "type": "text", "text": text}],
                run_id=state["run_id"],
                status=status,
                message_metadata={"intent": run.intent if run is not None else "planner_failed", "agentKey": "workspace_planner"},
                created_by=state["user_id"],
            )
            self.db.add(message)
        if run is not None and run.status != "waiting_approval":
            run.status = status
            run.error = state.get("error")
            if not run.output_summary:
                run.output_summary = message.content[:255]
                run.output = self._json_record({"text": message.content, "cards": [], "routing": (run.context_summary or {}).get("routing", {})})
        if conversation is not None and conversation.last_run_status != "waiting_approval":
            conversation.last_run_status = status
            conversation.last_message_at = utcnow()
            if not conversation.response:
                conversation.response = message.content
                conversation.summary = message.content[:255]
        self.db.flush()
        logger.info(
            "AI graph finalized run_id=%s conversation_id=%s family_id=%s status=%s run_status=%s conversation_status=%s message_id=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            status,
            run.status if run is not None else None,
            conversation.last_run_status if conversation is not None else None,
            message.id,
        )
        return {"status": status}

    def _route_after_plan(self, state: WorkspaceGraphState) -> str:
        if state.get("status") in {"failed", "cancelled"}:
            return "finalize"
        plan = PlannerResult.model_validate(state.get("plan") or {})
        return "skill_step" if plan.skills else "general_chat"

    def _route_after_skill(self, state: WorkspaceGraphState) -> str:
        if state.get("status") in {"failed", "fallback", "cancelled", "rejected", "waiting_approval"}:
            return "finalize"
        plan = PlannerResult.model_validate(state.get("plan") or {})
        return "skill_step" if int(state.get("skill_index") or 0) < len(plan.skills) else "finalize"

    def _approval_interrupt_payload(self, approval: AIApprovalRequest) -> dict[str, Any]:
        return {
            "type": "approval_required",
            "conversationId": approval.conversation_id,
            "runId": approval.run_id,
            "approvalId": approval.id,
            "draftId": approval.draft_id,
            "draftVersion": approval.draft_version,
            "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
        }

    def _chat_response(self, conversation_id: str, run_id: str) -> dict[str, Any]:
        run = self.db.get(AIAgentRun, run_id)
        if run is None:
            raise RuntimeError("LangGraph 没有创建运行记录")
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == run_id, AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.desc())
        )
        if message is None:
            raise RuntimeError("LangGraph 没有创建助手消息")
        events = list(
            self.db.scalars(
                select(AIRunEvent).where(AIRunEvent.run_id == run_id).order_by(AIRunEvent.created_at.asc())
            )
        )
        drafts = list(
            self.db.scalars(
                select(AITaskDraft).where(AITaskDraft.source_run_id == run_id).order_by(AITaskDraft.created_at.asc())
            )
        )
        approvals = list(
            self.db.scalars(
                select(AIApprovalRequest).where(AIApprovalRequest.run_id == run_id).order_by(AIApprovalRequest.created_at.asc())
            )
        )
        cards = [
            part["card"]
            for part in (message.parts or [])
            if isinstance(part, dict) and part.get("type") == "result_card" and isinstance(part.get("card"), dict)
        ]
        return {
            "conversation_id": conversation_id,
            "message": serialize_ai_message(message),
            "run": serialize_ai_run(run),
            "events": [serialize_ai_run_event(event) for event in events],
            "included": {
                "result_cards": cards,
                "drafts": [serialize_ai_task_draft(draft) for draft in drafts],
                "approvals": [serialize_ai_approval_request(approval) for approval in approvals],
            },
        }

    def _new_progress_events(self, run_id: str, seen_event_ids: set[str]) -> Iterator[tuple[str, dict[str, Any]]]:
        events = list(
            self.db.scalars(
                select(AIRunEvent)
                .where(AIRunEvent.run_id == run_id)
                .order_by(AIRunEvent.created_at.asc(), AIRunEvent.id.asc())
            )
        )
        for event in events:
            if event.id in seen_event_ids:
                continue
            seen_event_ids.add(event.id)
            yield ("progress", serialize_ai_run_event(event))

    def _persistent_progress_writer(self, writer: Any, state: WorkspaceGraphState) -> Any:
        def write(update: dict[str, Any]) -> None:
            event_name, data = self._custom_stream_event(update)
            if event_name != "progress":
                writer(update)
                return

            event_id = str(data.get("id") or create_id("ai_run_event"))
            event = self.db.get(AIRunEvent, event_id)
            if event is None:
                event = AIRunEvent(
                    id=event_id,
                    family_id=state["family_id"],
                    conversation_id=state["conversation_id"],
                    run_id=str(data.get("run_id") or state["run_id"]),
                    type=str(data.get("type") or "event"),
                    internal_code=str(data.get("internal_code") or "progress"),
                    user_message=str(data.get("user_message") or ""),
                    status=str(data.get("status") or "running"),
                    payload={},
                )
                self.db.add(event)
                self.db.flush()
            writer({"event": "progress", "data": serialize_ai_run_event(event)})

        return write


    def _run_id_from_update(self, update: Any) -> str:
        if not isinstance(update, dict):
            return ""
        direct = update.get("run_id")
        if isinstance(direct, str) and direct:
            return direct
        for value in update.values():
            if not isinstance(value, dict):
                continue
            candidate = value.get("run_id")
            if isinstance(candidate, str) and candidate:
                return candidate
        return ""

    def _custom_stream_event(self, update: Any) -> tuple[str, dict[str, Any]]:
        if not isinstance(update, dict):
            return "", {}
        event = update.get("event")
        data = update.get("data")
        if not isinstance(event, str) or not event:
            return "", {}
        if not isinstance(data, dict):
            return "", {}
        return event, data

    def _config(self, conversation_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": conversation_id}}
