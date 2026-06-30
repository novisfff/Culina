from __future__ import annotations

from time import perf_counter
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.ai.errors import AIExecutionCancelled
from app.ai.skills import SkillContext, SkillResult
from app.ai.workflows.orchestrator import WorkspaceOrchestratorAgent
from app.ai.workflows.runner_support.orchestrator_context import OrchestratorContextBuilder
from app.ai.workflows.runner_support.orchestrator_next_state import OrchestratorNextStateResolver
from app.ai.workflows.state import WorkspaceGraphState
from app.models.domain import AIApprovalRequest, AIConversation

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner


class OrchestratorNode:
    def __init__(self, runner: WorkspaceGraphRunner) -> None:
        self.runner = runner
        self.context_builder = OrchestratorContextBuilder(runner)
        self.next_state_resolver = OrchestratorNextStateResolver(runner)

    def run(self, state: WorkspaceGraphState) -> dict[str, Any]:
        runner = self.runner
        if runner._cancel_requested(state["run_id"]):
            return {"status": "cancelled"}
        trace_context = self.context_builder.start_trace_context(state)

        def finish_graph_span(status_value: str, output_summary: dict[str, Any] | None = None) -> None:
            trace_context.graph_span.finish(
                status="waiting" if status_value in {"waiting_approval", "waiting_input"} else status_value,
                output_summary={"status": status_value, **(output_summary or {})},
            )

        waiting_patch = self._waiting_patch(state, finish_graph_span)
        if waiting_patch is not None:
            return waiting_patch

        execution_context = self.context_builder.build(state, trace_context=trace_context)
        started_at = perf_counter()
        try:
            result = WorkspaceOrchestratorAgent(
                provider=runner.provider,
                skill_registry=runner.skill_registry,
            ).run(
                SkillContext(
                    db=runner.db,
                    family_id=state["family_id"],
                    user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    run_id=state["run_id"],
                    conversation=execution_context.timeline,
                    current_message=state["message"],
                    subject=state.get("subject") or {},
                    orchestrator_profile=state.get("orchestrator_profile") or {},
                    current_message_attachments=execution_context.current_message_attachments,
                    current_message_images=execution_context.current_message_images,
                    quick_task=state.get("quick_task"),
                    tool_executor=execution_context.tool_executor,
                    provider=runner.provider,
                    current_run_artifacts=execution_context.current_run_artifacts,
                    stream_writer=execution_context.stream_writer,
                    progressive_draft_publisher=runner.progressive_draft_publisher.create_publisher(
                        state,
                        tracer=execution_context.tracer,
                        parent_span_id=execution_context.graph_span.span_id,
                        round_index=execution_context.round_index,
                    ),
                    cancel_check=lambda: runner._cancel_requested(state["run_id"]),
                    tracer=execution_context.tracer,
                    trace_parent_span_id=execution_context.graph_span.span_id,
                    trace_round_index=execution_context.round_index,
                ),
                injected_skill_keys=list(state.get("injected_skill_keys") or []),
            )
        except AIExecutionCancelled:
            result = SkillResult(
                text="已取消这次任务。",
                status="cancelled",
                model=getattr(runner.provider, "model_name", ""),
            )
        if execution_context.last_human_input_result is not None:
            result.context_summary = {
                **(result.context_summary or {}),
                "lastHumanInputResult": execution_context.last_human_input_result.get(
                    "payload",
                    execution_context.last_human_input_result,
                ),
            }
        runner.assistant_result_persister.persist(
            state,
            result,
            skill_key=None,
            duration_ms=int((perf_counter() - started_at) * 1000),
        )
        return self.next_state_resolver.resolve(
            state,
            result=result,
            finish_graph_span=finish_graph_span,
        )

    def _waiting_patch(
        self,
        state: WorkspaceGraphState,
        finish_graph_span: Any,
    ) -> dict[str, Any] | None:
        runner = self.runner
        pending = runner.db.scalar(
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
            runner.progressive_draft_publisher.mark_waiting_approval_state(state)
            finish_graph_span("waiting_approval", {"pendingApprovalId": pending.id})
            return {
                "status": "waiting_approval",
                "pending_approval_id": pending.id,
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
                "run_artifacts": list(state.get("run_artifacts") or []),
            }

        conversation = runner.db.get(AIConversation, state["conversation_id"])
        conversation_context = dict(conversation.context or {}) if conversation is not None else {}
        task_state = conversation_context.get("taskState") if isinstance(conversation_context.get("taskState"), dict) else {}
        pending_human_input = task_state.get("pendingHumanInput") if isinstance(task_state, dict) else None
        if isinstance(pending_human_input, dict) and pending_human_input.get("id"):
            finish_graph_span("waiting_input", {"pendingHumanInputId": pending_human_input.get("id")})
            return {
                "status": "waiting_input",
                "pending_human_input": pending_human_input,
                "injected_skill_keys": list(state.get("injected_skill_keys") or []),
                "injection_history": list(state.get("injection_history") or []),
                "run_artifacts": list(state.get("run_artifacts") or []),
            }
        return None
