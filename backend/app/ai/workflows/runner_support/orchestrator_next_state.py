from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.ai.skills import SkillResult
from app.ai.skills.shared import result_artifacts
from app.ai.workflows.state import WorkspaceGraphState
from app.ai.workflows.runner_support.message_parts import (
    ROUTED_WITHOUT_APPROVAL_STATUSES,
    draft_route_status,
)
from app.models.domain import AIAgentRun, AIApprovalRequest, AIConversation, AIMessage, AITaskDraft
from app.services.ai_timeline import AITimelineService

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
        # Every orchestrator invocation owns one provider usage phase.  A
        # human-input interrupt is still the end of the current phase, even
        # though no approval request is created, so the resumed invocation
        # must receive a fresh phase identity as well.
        next_agent_rounds = int(state.get("agent_rounds") or 0) + 1
        if result.status == "waiting_input":
            return self._waiting_input_patch(
                result=result,
                run_artifacts=run_artifacts,
                injected_skill_keys=injected_skill_keys,
                injection_history=injection_history,
                next_agent_rounds=next_agent_rounds,
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
        routed_without_approval = self._has_persisted_routed_drafts(
            state,
            result=result,
        )
        if result.drafts and pending_after_result is None and not routed_without_approval:
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

    def _has_persisted_routed_drafts(
        self,
        state: WorkspaceGraphState,
        *,
        result: SkillResult,
    ) -> bool:
        if not result.drafts:
            return False
        for draft_payload in result.drafts:
            if not isinstance(draft_payload, dict):
                return False
            draft_id = str(draft_payload.get("draft_id") or "")
            draft = self.runner.db.get(AITaskDraft, draft_id) if draft_id else None
            if (
                draft is None
                or draft.family_id != state["family_id"]
                or draft.conversation_id != state["conversation_id"]
                or draft.source_run_id != state["run_id"]
            ):
                return False
            metadata = draft.ai_metadata if isinstance(draft.ai_metadata, dict) else {}
            stored_outcome = (
                metadata.get("routeOutcome")
                if isinstance(metadata.get("routeOutcome"), dict)
                else {}
            )
            stored_status = str(stored_outcome.get("status") or "")
            claimed_status = draft_route_status(draft_payload)
            if (
                stored_status not in ROUTED_WITHOUT_APPROVAL_STATUSES
                or claimed_status != stored_status
            ):
                return False
        return True

    @staticmethod
    def _waiting_input_patch(
        *,
        result: SkillResult,
        run_artifacts: list[dict[str, Any]],
        injected_skill_keys: list[str],
        injection_history: list[dict[str, Any]],
        next_agent_rounds: int,
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
            "agent_rounds": next_agent_rounds,
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
        approval_ids = [
            str(draft.get("approval_id") or "")
            for draft in result.drafts
            if isinstance(draft, dict) and str(draft.get("approval_id") or "")
        ]
        resolved_approvals = (
            list(
                self.runner.db.scalars(
                    select(AIApprovalRequest).where(
                        AIApprovalRequest.id.in_(approval_ids),
                        AIApprovalRequest.run_id == state["run_id"],
                        AIApprovalRequest.status != "pending",
                    )
                )
            )
            if approval_ids
            else []
        )
        if approval_ids and len(resolved_approvals) == len(set(approval_ids)):
            result.status = "completed"
            result.error = None
            self._mark_resolved_replay_completed(state)
            return self._normal_result_patch(
                result=result,
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

    def _mark_resolved_replay_completed(self, state: WorkspaceGraphState) -> None:
        run = self.runner.db.get(AIAgentRun, state["run_id"])
        if run is not None:
            run.status = "completed"
        message_id = str(state.get("assistant_message_id") or "").strip()
        if not message_id:
            raise RuntimeError("已解决草稿重放缺少 canonical assistant_message_id")
        message = self.runner.db.scalar(
            select(AIMessage).where(
                AIMessage.id == message_id,
                AIMessage.family_id == state["family_id"],
                AIMessage.conversation_id == state["conversation_id"],
                AIMessage.run_id == state["run_id"],
                AIMessage.role == "assistant",
            )
        )
        if message is None:
            raise RuntimeError("已解决草稿重放缺少 canonical 助手消息")
        AITimelineService(self.runner.db).update_message_status(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            message_id=message.id,
            run_id=state["run_id"],
            status="completed",
            created_by=state.get("user_id"),
        )
        conversation = self.runner.db.get(AIConversation, state["conversation_id"])
        if conversation is not None:
            conversation.last_run_status = "completed"
        self.runner.db.flush()

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
