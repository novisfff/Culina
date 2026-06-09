from __future__ import annotations

from collections.abc import Iterator
import logging
from time import perf_counter
from typing import TYPE_CHECKING, Any

from fastapi.encoders import jsonable_encoder
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from sqlalchemy import select

from app.ai.planning import PlannerRequest, WorkspacePlanner
from app.ai.planning.schemas import PlannerResult
from app.ai.skills import SkillContext, SkillExecutor, SkillResult, build_workspace_skill_registry
from app.ai.skills.shared import result_artifacts
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.ai.workflows.state import WorkspaceGraphState
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
        conversation = self.service._get_or_create_conversation(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            quick_task=quick_task,
        )
        config = self._config(conversation.id)
        logger.info(
            "AI graph invoke started family_id=%s user_id=%s conversation_id=%s client_run_id=%s quick_task=%s message_length=%s",
            family_id,
            user_id,
            conversation.id,
            client_run_id,
            quick_task,
            len(prompt),
        )
        output = self.graph.invoke(
            {
                "family_id": family_id,
                "user_id": user_id,
                "conversation_id": conversation.id,
                "message": prompt,
                "client_message_id": client_message_id,
                "client_run_id": client_run_id,
                "quick_task": quick_task,
                "subject": subject or {},
                "preplanned_plan": preplanned_plan.model_dump(mode="json") if preplanned_plan is not None else {},
                "general_text": general_text or "",
                "run_artifacts": [],
                "skill_index": 0,
                "status": "running",
                "error": None,
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
            conversation.id,
            run_id,
        )
        return self._chat_response(conversation.id, run_id)

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
        conversation = self.service._get_or_create_conversation(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            quick_task=quick_task,
        )
        config = self._config(conversation.id)
        run_id = ""
        seen_event_ids: set[str] = set()
        logger.info(
            "AI graph stream started family_id=%s user_id=%s conversation_id=%s client_run_id=%s quick_task=%s message_length=%s",
            family_id,
            user_id,
            conversation.id,
            client_run_id,
            quick_task,
            len(prompt),
        )
        for chunk in self.graph.stream(
            {
                "family_id": family_id,
                "user_id": user_id,
                "conversation_id": conversation.id,
                "message": prompt,
                "client_message_id": client_message_id,
                "client_run_id": client_run_id,
                "quick_task": quick_task,
                "subject": subject or {},
                "preplanned_plan": preplanned_plan.model_dump(mode="json") if preplanned_plan is not None else {},
                "general_text": general_text or "",
                "run_artifacts": [],
                "skill_index": 0,
                "status": "running",
                "error": None,
            },
            config=config,
            stream_mode=["updates", "custom"],
            durability="sync",
        ):
            mode, update = chunk if isinstance(chunk, tuple) else ("updates", chunk)
            if mode == "custom":
                event, data = self._custom_stream_event(update)
                if event:
                    yield (event, data)
                continue
            if mode != "updates":
                continue
            run_id = run_id or self._run_id_from_update(update)
            if run_id:
                yield from self._new_progress_events(run_id, seen_event_ids)

        if not run_id:
            state = self.graph.get_state(config)
            run_id = str(state.values.get("run_id") or "")
        if run_id:
            yield from self._new_progress_events(run_id, seen_event_ids)
        logger.info(
            "AI graph stream completed family_id=%s user_id=%s conversation_id=%s run_id=%s",
            family_id,
            user_id,
            conversation.id,
            run_id,
        )
        yield ("response", self._chat_response(conversation.id, run_id))

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
        self.service._require_conversation(family_id=family_id, conversation_id=conversation_id)
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
        conversation = self.service._require_conversation(
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
        timeline = self.service._build_planner_conversation(
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
        logger.info(
            "AI planner started run_id=%s conversation_id=%s family_id=%s preplanned=%s",
            state.get("run_id"),
            state["conversation_id"],
            state["family_id"],
            bool(state.get("preplanned_plan")),
        )
        timeline = self.service._build_planner_conversation(
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
        else:
            planner = WorkspacePlanner(provider=self.provider, skill_registry=self.skill_registry)
            plan = planner.plan(
                PlannerRequest(
                    family_id=state["family_id"],
                    user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    conversation=timeline,
                    available_skills=[manifest.to_planner_record() for manifest in self.skill_registry.list_manifests()],
                )
            )
        run = self.db.get(AIAgentRun, state["run_id"])
        if run is not None:
            run.intent = self.service._intent_for_plan(self.skill_registry, plan)
            run.agent_key = self.service._agent_key_for_plan(self.skill_registry, plan)
            run.context_summary = {
                **(run.context_summary or {}),
                "routing": {
                    "intent": run.intent,
                    "agentKey": run.agent_key,
                    "skills": plan.skills,
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
        result = SkillResult(text=text, model=getattr(self.provider, "model_name", "")) if text else self._stream_general_chat(state)
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
        prompt = str(state.get("message") or "").strip()
        model = getattr(self.provider, "model_name", "")
        if prompt:
            for chunk in self.provider.stream_generate(system=system, user=prompt):
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
            operation = result.get("operation")
            next_approval = result.get("approval")
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
                return {"status": "waiting_approval", "last_decision": serialized}
            if str(resume.get("decision")) == "rejected":
                logger.info(
                    "AI graph approval rejected run_id=%s conversation_id=%s family_id=%s approval_id=%s",
                    state["run_id"],
                    state["conversation_id"],
                    state["family_id"],
                    pending.id,
                )
                if run is not None:
                    run.status = "cancelled"
                    run.output_summary = "用户拒绝了当前草稿"
                if conversation is not None:
                    conversation.last_run_status = "cancelled"
                self.db.flush()
                return {"status": "cancelled", "last_decision": serialized}
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
                return {"status": "failed", "last_decision": serialized, "error": "草稿写入失败"}
            if run is not None:
                run.status = "running"
            if conversation is not None:
                conversation.last_run_status = "running"
            self.db.flush()
            return {
                "skill_index": int(state.get("skill_index") or 0) + 1,
                "status": "running",
                "last_decision": serialized,
            }

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
        stream_writer = get_stream_writer()
        root_tools = ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=self.db,
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                run_id=state["run_id"],
                stream_writer=stream_writer,
            ),
        )
        timeline = self.service._build_planner_conversation(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        started_at = perf_counter()
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
                tool_executor=root_tools,
                provider=self.provider,
                current_run_artifacts=list(state.get("run_artifacts") or []),
                stream_writer=stream_writer,
            )
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
            interrupt(self._approval_interrupt_payload(pending))
        if result.requires_clarification:
            return {"skill_index": index + 1, "run_artifacts": run_artifacts, "status": "completed", "error": result.error}
        if result.status == "failed":
            return {"run_artifacts": run_artifacts, "status": result.status, "error": result.error}
        return {"skill_index": index + 1, "run_artifacts": run_artifacts, "status": "running"}

    def _persist_assistant_result(
        self,
        state: WorkspaceGraphState,
        result: SkillResult,
        *,
        skill_key: str | None,
        duration_ms: int = 0,
    ) -> AIMessage:
        cards = self.service._normalize_result_cards(result.cards)
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
            draft, approval, card = self.service._create_draft_approval(
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                draft_payload=draft_payload,
            )
            drafts.append(draft)
            approvals.append(approval)
            cards.append(card)
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
                {"id": create_id("ai_part"), "type": "result_card", "card": card},
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
                    }
                )
            context_summary.update(result.context_summary)
            if skill_executions:
                context_summary["skillExecutions"] = skill_executions
            run.status = "waiting_approval" if drafts else result.status
            run.model = result.model or run.model
            run.output_summary = aggregate_text[:255]
            run.output = {"text": aggregate_text, "cards": all_cards, "routing": (run.context_summary or {}).get("routing", {})}
            run.tool_calls = [*(run.tool_calls or []), *result.tool_calls]
            run.error = result.error
            run.duration_ms = int(run.duration_ms or 0) + duration_ms
            run.context_summary = context_summary
        if conversation is not None:
            conversation.prompt = state["message"]
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = "waiting_approval" if drafts else result.status
            if result.state_patch:
                context = dict(conversation.context or {})
                task_state = dict(context.get("taskState") or {})
                task_state.update(result.state_patch)
                context["taskState"] = task_state
                conversation.context = context
        self.db.flush()
        return message

    def _finalize(self, state: WorkspaceGraphState) -> dict[str, Any]:
        run = self.db.get(AIAgentRun, state["run_id"])
        conversation = self.db.get(AIConversation, state["conversation_id"])
        status = str(state.get("status") or "completed")
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
                run.output = {"text": message.content, "cards": [], "routing": (run.context_summary or {}).get("routing", {})}
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
        if state.get("status") == "failed":
            return "finalize"
        plan = PlannerResult.model_validate(state.get("plan") or {})
        return "skill_step" if plan.skills else "general_chat"

    def _route_after_skill(self, state: WorkspaceGraphState) -> str:
        if state.get("status") in {"failed", "fallback", "cancelled", "rejected"}:
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
