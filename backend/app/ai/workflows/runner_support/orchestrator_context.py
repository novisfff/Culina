from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from langgraph.config import get_stream_writer
from sqlalchemy import select

from app.ai.observability.tracer import AIRunTracer
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.ai.workflows.runner_support.attachments import provider_images_for_attachments
from app.ai.workflows.state import WorkspaceGraphState
from app.ai.workflows.timeline import build_planner_conversation
from app.core.utils import create_id
from app.models.domain import AIConversation, AIRunTraceSpan
from app.services.media import read_media_object_for_ai

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner


@dataclass
class OrchestratorTraceContext:
    tracer: AIRunTracer
    graph_span: Any
    round_index: int


@dataclass
class OrchestratorExecutionContext:
    tracer: AIRunTracer
    graph_span: Any
    round_index: int
    stream_writer: Any
    tool_executor: ToolExecutor
    timeline: list[dict[str, Any]]
    current_run_artifacts: list[dict[str, Any]]
    current_message_attachments: list[dict[str, Any]]
    current_message_images: list[Any]
    last_human_input_result: dict[str, Any] | None


class OrchestratorContextBuilder:
    def __init__(self, runner: WorkspaceGraphRunner) -> None:
        self.runner = runner

    def start_trace_context(self, state: WorkspaceGraphState) -> OrchestratorTraceContext:
        runner = self.runner
        tracer = self._tracer(state)
        round_index = int(state.get("agent_rounds") or 0) + 1
        graph_span = tracer.start_span(
            "graph_node",
            "orchestrator",
            round_index=round_index,
            input_summary={
                "status": state.get("status"),
                "agentRounds": state.get("agent_rounds") or 0,
                "injectedSkills": list(state.get("injected_skill_keys") or []),
                "runArtifactCount": len(state.get("run_artifacts") or []),
            },
        )
        return OrchestratorTraceContext(
            tracer=tracer,
            graph_span=graph_span,
            round_index=round_index,
        )

    def build(
        self,
        state: WorkspaceGraphState,
        *,
        trace_context: OrchestratorTraceContext,
    ) -> OrchestratorExecutionContext:
        runner = self.runner
        conversation = runner.db.get(AIConversation, state["conversation_id"])
        conversation_context = dict(conversation.context or {}) if conversation is not None else {}
        task_state = conversation_context.get("taskState") if isinstance(conversation_context.get("taskState"), dict) else {}
        stream_writer = runner._persistent_progress_writer(get_stream_writer(), state)
        tool_executor = ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=runner.db,
                family_id=state["family_id"],
                user_id=state["user_id"],
                conversation_id=state["conversation_id"],
                run_id=state["run_id"],
                stream_writer=stream_writer,
                cancel_check=lambda: runner._cancel_requested(state["run_id"]),
                tracer=trace_context.tracer,
                trace_parent_span_id=trace_context.graph_span.span_id,
                trace_round_index=trace_context.round_index,
            ),
        )
        timeline = build_planner_conversation(
            runner.db,
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            quick_task=state.get("quick_task"),
        )
        current_run_artifacts = list(state.get("run_artifacts") or [])
        last_human_input_result = self._last_human_input_result(
            state,
            current_run_artifacts=current_run_artifacts,
            task_state=task_state if isinstance(task_state, dict) else {},
        )
        current_message_attachments = list(state.get("current_message_attachments") or [])
        current_message_images = provider_images_for_attachments(
            db=runner.db,
            family_id=state["family_id"],
            attachments=current_message_attachments,
            provider_supports_vision=bool(getattr(runner.provider, "supports_vision", False)),
            read_media_object=read_media_object_for_ai,
        )
        return OrchestratorExecutionContext(
            tracer=trace_context.tracer,
            graph_span=trace_context.graph_span,
            round_index=trace_context.round_index,
            stream_writer=stream_writer,
            tool_executor=tool_executor,
            timeline=timeline,
            current_run_artifacts=current_run_artifacts,
            current_message_attachments=current_message_attachments,
            current_message_images=current_message_images,
            last_human_input_result=last_human_input_result,
        )

    def _tracer(self, state: WorkspaceGraphState) -> AIRunTracer:
        runner = self.runner
        trace_id = runner.db.scalar(
            select(AIRunTraceSpan.trace_id)
            .where(AIRunTraceSpan.run_id == state["run_id"], AIRunTraceSpan.family_id == state["family_id"])
            .order_by(AIRunTraceSpan.started_at.asc(), AIRunTraceSpan.id.asc())
            .limit(1)
        )
        return AIRunTracer(
            db=runner.db,
            family_id=state["family_id"],
            run_id=state["run_id"],
            conversation_id=state["conversation_id"],
            user_id=state["user_id"],
            trace_id=trace_id,
        )

    @staticmethod
    def _last_human_input_result(
        state: WorkspaceGraphState,
        *,
        current_run_artifacts: list[dict[str, Any]],
        task_state: dict[str, Any],
    ) -> dict[str, Any] | None:
        last_human_input_result = (
            state.get("last_human_input_result")
            if isinstance(state.get("last_human_input_result"), dict) and state.get("last_human_input_result")
            else None
        )
        if last_human_input_result is None:
            last_human_input_result = next(
                (
                    item
                    for item in reversed(current_run_artifacts)
                    if isinstance(item, dict) and item.get("type") == "human.input_result"
                ),
                None,
            )
        if last_human_input_result is None and isinstance(task_state.get("lastHumanInputResult"), dict):
            last_human_input_result = {
                "id": f"human_input:{task_state['lastHumanInputResult'].get('request', {}).get('id') or create_id('human_input')}",
                "type": "human.input_result",
                "kind": "human_input",
                "version": 1,
                "status": "completed",
                "payload": task_state["lastHumanInputResult"],
            }
        if last_human_input_result is not None and not any(
            item.get("id") == last_human_input_result.get("id")
            for item in current_run_artifacts
            if isinstance(item, dict)
        ):
            current_run_artifacts.append(last_human_input_result)
        return last_human_input_result
