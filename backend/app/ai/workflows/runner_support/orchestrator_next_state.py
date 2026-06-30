from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.ai.skills import SkillResult
from app.ai.skills.shared import result_artifacts
from app.ai.workflows.state import WorkspaceGraphState
from app.models.domain import AIApprovalRequest

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner


class OrchestratorNextStateResolver:
    def __init__(self, runner: WorkspaceGraphRunner) -> None:
        self.runner = runner

    def resolve(
        self,
        state: WorkspaceGraphState,
        *,
        result: SkillResult,
        finish_graph_span: Any,
    ) -> dict[str, Any]:
        runner = self.runner
        orchestrator_summary = result.context_summary.get("orchestrator") if isinstance(result.context_summary, dict) else {}
        injected_skill_keys = (
            list(orchestrator_summary.get("injectedSkills") or [])
            if isinstance(orchestrator_summary, dict)
            else list(state.get("injected_skill_keys") or [])
        )
        injection_history = (
            list(orchestrator_summary.get("injectionHistory") or [])
            if isinstance(orchestrator_summary, dict)
            else list(state.get("injection_history") or [])
        )
        run_artifacts = [
            *(state.get("run_artifacts") or []),
            *result_artifacts("orchestrator", result),
            *runner._tool_call_artifacts(result),
        ]
        if result.status == "waiting_input":
            return self._waiting_input_patch(
                result=result,
                run_artifacts=run_artifacts,
                injected_skill_keys=injected_skill_keys,
                injection_history=injection_history,
                finish_graph_span=finish_graph_span,
            )
        pending_after_result = runner.db.scalar(
            select(AIApprovalRequest)
            .where(
                AIApprovalRequest.run_id == state["run_id"],
                AIApprovalRequest.status == "pending",
            )
            .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
        )
        next_agent_rounds = int(state.get("agent_rounds") or 0) + 1
        if result.drafts and pending_after_result is None:
            return self._draft_without_persisted_approval_patch(
                state,
                result=result,
                run_artifacts=run_artifacts,
                injected_skill_keys=injected_skill_keys,
                injection_history=injection_history,
                next_agent_rounds=next_agent_rounds,
                finish_graph_span=finish_graph_span,
            )
        if pending_after_result is not None:
            self.runner.progressive_draft_publisher.mark_waiting_approval_state(state)
            return self._waiting_approval_patch(
                result=result,
                pending_approval_id=pending_after_result.id,
                run_artifacts=run_artifacts,
                injected_skill_keys=injected_skill_keys,
                injection_history=injection_history,
                next_agent_rounds=next_agent_rounds,
                finish_graph_span=finish_graph_span,
            )
        return self._normal_result_patch(
            result=result,
            run_artifacts=run_artifacts,
            injected_skill_keys=injected_skill_keys,
            injection_history=injection_history,
            next_agent_rounds=next_agent_rounds,
            finish_graph_span=finish_graph_span,
        )

    @staticmethod
    def _waiting_input_patch(
        *,
        result: SkillResult,
        run_artifacts: list[dict[str, Any]],
        injected_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        finish_graph_span: Any,
    ) -> dict[str, Any]:
        pending_human_input = (
            result.context_summary.get("pendingHumanInput")
            if isinstance(result.context_summary, dict) and isinstance(result.context_summary.get("pendingHumanInput"), dict)
            else {}
        )
        finish_graph_span(
            "waiting_input",
            {
                "draftCount": len(result.drafts),
                "cardCount": len(result.cards),
                "toolCallCount": len(result.tool_calls),
                "pendingHumanInputId": pending_human_input.get("id"),
            },
        )
        return {
            "run_artifacts": run_artifacts,
            "injected_skill_keys": injected_skill_keys,
            "injection_history": injection_history,
            "pending_approval_id": "",
            "pending_human_input": pending_human_input,
            "status": "waiting_input",
        }

    def _draft_without_persisted_approval_patch(
        self,
        state: WorkspaceGraphState,
        *,
        result: SkillResult,
        run_artifacts: list[dict[str, Any]],
        injected_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        next_agent_rounds: int,
        finish_graph_span: Any,
    ) -> dict[str, Any]:
        fast_approval_id = str(result.drafts[0].get("approval_id") or "") if result.drafts else ""
        if fast_approval_id and self.runner._has_fast_approval_decision(state, fast_approval_id):
            return self._waiting_approval_patch(
                result=result,
                pending_approval_id=fast_approval_id,
                run_artifacts=run_artifacts,
                injected_skill_keys=injected_skill_keys,
                injection_history=injection_history,
                next_agent_rounds=next_agent_rounds,
                finish_graph_span=finish_graph_span,
            )
        finish_graph_span(
            "failed",
            {
                "draftCount": len(result.drafts),
                "cardCount": len(result.cards),
                "toolCallCount": len(result.tool_calls),
                "error": "draft_without_approval",
            },
        )
        raise RuntimeError("草稿已生成，但没有创建确认请求")

    @staticmethod
    def _waiting_approval_patch(
        *,
        result: SkillResult,
        pending_approval_id: str,
        run_artifacts: list[dict[str, Any]],
        injected_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        next_agent_rounds: int,
        finish_graph_span: Any,
    ) -> dict[str, Any]:
        finish_graph_span(
            "waiting_approval",
            {
                "draftCount": len(result.drafts),
                "cardCount": len(result.cards),
                "toolCallCount": len(result.tool_calls),
                "pendingApprovalId": pending_approval_id,
            },
        )
        return {
            "run_artifacts": run_artifacts,
            "injected_skill_keys": injected_skill_keys,
            "injection_history": injection_history,
            "pending_approval_id": pending_approval_id,
            "pending_human_input": {},
            "agent_rounds": next_agent_rounds,
            "status": "waiting_approval",
        }

    @staticmethod
    def _normal_result_patch(
        *,
        result: SkillResult,
        run_artifacts: list[dict[str, Any]],
        injected_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        next_agent_rounds: int,
        finish_graph_span: Any,
    ) -> dict[str, Any]:
        finish_graph_span(
            result.status,
            {
                "draftCount": len(result.drafts),
                "cardCount": len(result.cards),
                "toolCallCount": len(result.tool_calls),
                "error": result.error,
            },
        )
        return {
            "run_artifacts": run_artifacts,
            "injected_skill_keys": injected_skill_keys,
            "injection_history": injection_history,
            "pending_approval_id": "",
            "pending_human_input": {},
            "agent_rounds": next_agent_rounds,
            "status": result.status,
            "error": result.error,
        }
