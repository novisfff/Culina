from __future__ import annotations

from enum import Enum
import logging
from typing import TYPE_CHECKING, Any

from fastapi.encoders import jsonable_encoder

from app.ai.workflows.runner_support.approval_resume import (
    ContinuationResumeError,
    approval_failed_state_patch,
    approval_resolved_state_patch,
    approval_waiting_state_patch,
    continuation_resume_state,
    continuation_skill_start_event,
)
from app.ai.workflows.runner_support.run_summary import (
    record_approval_outcome_summary,
    record_continuation_rejected,
)
from app.ai.workflows.state import WorkspaceGraphState
from app.models.domain import AIAgentRun, AIApprovalRequest, AIConversation, AIRunEvent
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner

logger = logging.getLogger(__name__)


class ApprovalOutcome(str, Enum):
    WAITING_APPROVAL = "waiting_approval"
    REJECTED = "rejected"
    OPERATION_FAILED = "operation_failed"
    APPROVED_AND_DONE = "approved_and_done"
    APPROVED_AND_CONTINUE = "approved_and_continue"


class ApprovalResumeHandler:
    def __init__(self, runner: WorkspaceGraphRunner) -> None:
        self.runner = runner

    def resume(
        self,
        *,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        resume: Any,
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        recorded_decision = self.runner._pop_fast_approval_decision(state, pending.id)
        if recorded_decision is not None:
            return self.resume_recorded_decision(
                state=state,
                serialized=recorded_decision,
                run_artifacts=run_artifacts,
            )
        payload = self._validated_payload(state=state, pending=pending, resume=resume)
        result = self.runner.service._apply_approval_decision(
            family_id=state["family_id"],
            user_id=str(payload.get("userId") or state["user_id"]),
            conversation_id=state["conversation_id"],
            approval_id=pending.id,
            decision=str(payload.get("decision") or ""),
            draft_version=int(payload.get("draftVersion") or 0),
            values=payload.get("values") if isinstance(payload.get("values"), dict) else {},
            comment=str(payload.get("comment") or "") or None,
        )
        serialized = jsonable_encoder(result)
        approval_artifacts = self.runner.service._approval_decision_artifacts(serialized)
        cancelled_patch = self._cancelled_state_patch(
            state=state,
            serialized=serialized,
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
        )
        if cancelled_patch is not None:
            return cancelled_patch
        operation = result.get("operation")
        next_approval = result.get("approval")
        decision_draft = result.get("draft") if isinstance(result.get("draft"), dict) else {}
        decision_draft_type = str(decision_draft.get("draft_type") or "")
        run = self.runner.db.get(AIAgentRun, state["run_id"])
        conversation = self.runner.db.get(AIConversation, state["conversation_id"])
        outcome = self._outcome(payload=payload, next_approval=next_approval, operation=operation)
        if outcome == ApprovalOutcome.WAITING_APPROVAL:
            return self._handle_waiting_approval(
                state=state,
                pending=pending,
                next_approval=next_approval if isinstance(next_approval, dict) else {},
                serialized=serialized,
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
                run=run,
                conversation=conversation,
            )
        if outcome == ApprovalOutcome.REJECTED:
            return self._handle_rejected(
                state=state,
                pending=pending,
                serialized=serialized,
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
                run=run,
                conversation=conversation,
                decision_draft_type=decision_draft_type,
            )
        if outcome == ApprovalOutcome.OPERATION_FAILED:
            return self._handle_operation_failed(
                state=state,
                pending=pending,
                operation=operation,
                serialized=serialized,
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
                run=run,
                conversation=conversation,
            )
        return self._handle_approved(
            state=state,
            serialized=serialized,
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
            run=run,
            conversation=conversation,
            decision_draft_type=decision_draft_type,
        )

    def resume_recorded_decision(
        self,
        *,
        state: WorkspaceGraphState,
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any]:
        approval_artifacts = self.runner.service._approval_decision_artifacts(serialized)
        cancelled_patch = self._cancelled_state_patch(
            state=state,
            serialized=serialized,
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
        )
        if cancelled_patch is not None:
            return cancelled_patch
        approval = serialized.get("approval") if isinstance(serialized.get("approval"), dict) else {}
        operation = serialized.get("operation") if isinstance(serialized.get("operation"), dict) else None
        run = self.runner.db.get(AIAgentRun, state["run_id"])
        conversation = self.runner.db.get(AIConversation, state["conversation_id"])
        if approval.get("status") == "pending":
            if run is not None:
                run.status = "waiting_approval"
            if conversation is not None:
                conversation.last_run_status = "waiting_approval"
            self.runner.db.flush()
            return approval_waiting_state_patch(
                approval_id=str(approval.get("id") or ""),
                serialized=serialized,
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
            )
        if approval.get("decision") == "rejected":
            if run is not None:
                run.status = "running"
            if conversation is not None:
                conversation.last_run_status = "running"
            self.runner.db.flush()
            resume_artifact = self._consume_resume_artifact(state=state, serialized=serialized)
            if run is not None and self._is_typed_continuation(resume_artifact):
                payload = resume_artifact.get("payload") if isinstance(resume_artifact.get("payload"), dict) else {}
                workflow_id = str(payload.get("workflowId") or "").strip()
                if workflow_id:
                    summary = dict(run.context_summary or {})
                    record_continuation_rejected(summary, workflow_id=workflow_id)
                    run.context_summary = summary
            return approval_resolved_state_patch(
                state=state,
                serialized=serialized,
                status="running",
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
                resume_artifact=resume_artifact,
            )
        if operation is not None and operation.get("status") != "succeeded":
            if run is not None:
                run.status = "failed"
            if conversation is not None:
                conversation.last_run_status = "failed"
            self.runner.db.flush()
            return approval_failed_state_patch(
                serialized=serialized,
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
            )
        resume_artifact = self._consume_resume_artifact(state=state, serialized=serialized)
        if self._is_typed_continuation(resume_artifact):
            resolved_artifact, injected_skill_keys, injection_history, should_continue = (
                self._resolve_typed_continuation(state=state, artifact=resume_artifact)
            )
            if not should_continue and run is not None:
                self._record_continuation_rejection(run, resolved_artifact)
            if should_continue:
                self._publish_resumed_skill_start(
                    state=state,
                    artifact=resolved_artifact,
                    injected_skill_keys=injected_skill_keys,
                )
            next_status = "running" if should_continue else "completed"
            if run is not None:
                run.status = next_status
            if conversation is not None:
                conversation.last_run_status = next_status
            self.runner.db.flush()
            return approval_resolved_state_patch(
                state=state,
                serialized=serialized,
                status=next_status,
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
                resume_artifact=resolved_artifact,
                injected_skill_keys=injected_skill_keys,
                injection_history=injection_history,
            )
        if resume_artifact is None:
            self.runner.approval_followup_streamer.stream_followup(state, serialized, terminal_status="completed")
            if run is not None:
                run.status = "completed"
            if conversation is not None:
                conversation.last_run_status = "completed"
            self.runner.db.flush()
            return approval_resolved_state_patch(
                state=state,
                serialized=serialized,
                status="completed",
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
            )
        if run is not None:
            run.status = "running"
        if conversation is not None:
            conversation.last_run_status = "running"
        self.runner.db.flush()
        return approval_resolved_state_patch(
            state=state,
            serialized=serialized,
            status="running",
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
            resume_artifact=resume_artifact,
        )

    def _cancelled_state_patch(
        self,
        *,
        state: WorkspaceGraphState,
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
        approval_artifacts: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        run = lock_run_for_transition(
            self.runner.db,
            family_id=state["family_id"],
            run_id=state["run_id"],
        )
        if not serialized.get("suppress_continuation") and not cancellation_wins(
            self.runner.db,
            run=run,
            lock_request=False,
        ):
            return None
        finalize_run_cancellation(self.runner.db, run=run)
        return approval_resolved_state_patch(
            state=state,
            serialized=serialized,
            status="cancelled",
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
        )

    @staticmethod
    def _outcome(
        *,
        payload: dict[str, Any],
        next_approval: Any,
        operation: Any,
    ) -> ApprovalOutcome:
        if isinstance(next_approval, dict) and next_approval.get("status") == "pending":
            return ApprovalOutcome.WAITING_APPROVAL
        if str(payload.get("decision")) == "rejected":
            return ApprovalOutcome.REJECTED
        if not isinstance(operation, dict) or operation.get("status") != "succeeded":
            return ApprovalOutcome.OPERATION_FAILED
        return ApprovalOutcome.APPROVED_AND_CONTINUE

    @staticmethod
    def _validated_payload(
        *,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        resume: Any,
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
        return resume

    def _handle_waiting_approval(
        self,
        *,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        next_approval: dict[str, Any],
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
        approval_artifacts: list[dict[str, Any]],
        run: AIAgentRun | None,
        conversation: AIConversation | None,
    ) -> dict[str, Any]:
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
        self.runner.db.flush()
        return approval_waiting_state_patch(
            approval_id=str(next_approval.get("id") or ""),
            serialized=serialized,
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
        )

    def _handle_rejected(
        self,
        *,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
        approval_artifacts: list[dict[str, Any]],
        run: AIAgentRun | None,
        conversation: AIConversation | None,
        decision_draft_type: str,
    ) -> dict[str, Any]:
        logger.info(
            "AI graph approval rejected run_id=%s conversation_id=%s family_id=%s approval_id=%s",
            state["run_id"],
            state["conversation_id"],
            state["family_id"],
            pending.id,
        )
        if run is not None:
            run.status = "running"
            run.context_summary = record_approval_outcome_summary(
                dict(run.context_summary or {}),
                approval_status="rejected",
                draft_type=decision_draft_type,
            )
        if conversation is not None:
            conversation.last_run_status = "running"
        self.runner.db.flush()
        resume_artifact = self._consume_resume_artifact(state=state, serialized=serialized)
        if run is not None and self._is_typed_continuation(resume_artifact):
            payload = resume_artifact.get("payload") if isinstance(resume_artifact.get("payload"), dict) else {}
            workflow_id = str(payload.get("workflowId") or "").strip()
            if workflow_id:
                summary = dict(run.context_summary or {})
                record_continuation_rejected(summary, workflow_id=workflow_id)
                run.context_summary = summary
        return approval_resolved_state_patch(
            state=state,
            serialized=serialized,
            status="running",
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
            resume_artifact=resume_artifact,
        )

    def _handle_operation_failed(
        self,
        *,
        state: WorkspaceGraphState,
        pending: AIApprovalRequest,
        operation: Any,
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
        approval_artifacts: list[dict[str, Any]],
        run: AIAgentRun | None,
        conversation: AIConversation | None,
    ) -> dict[str, Any]:
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
        self.runner.db.flush()
        return approval_failed_state_patch(
            serialized=serialized,
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
        )

    def _handle_approved(
        self,
        *,
        state: WorkspaceGraphState,
        serialized: dict[str, Any],
        run_artifacts: list[dict[str, Any]],
        approval_artifacts: list[dict[str, Any]],
        run: AIAgentRun | None,
        conversation: AIConversation | None,
        decision_draft_type: str,
    ) -> dict[str, Any]:
        if run is not None:
            run.status = "running"
            run.context_summary = record_approval_outcome_summary(
                dict(run.context_summary or {}),
                approval_status="approved",
                draft_type=decision_draft_type,
            )
        if conversation is not None:
            conversation.last_run_status = "running"
        self.runner.db.flush()
        if not self.runner._commit_stream_checkpoint(state, run_status="running"):
            raise RuntimeError("确认结果持久化失败，请稍后重试")
        resume_artifact = self._consume_resume_artifact(state=state, serialized=serialized)
        if self._is_typed_continuation(resume_artifact):
            resolved_artifact, injected_skill_keys, injection_history, should_continue = (
                self._resolve_typed_continuation(state=state, artifact=resume_artifact)
            )
            if not should_continue and run is not None:
                self._record_continuation_rejection(run, resolved_artifact)
            if should_continue:
                self._publish_resumed_skill_start(
                    state=state,
                    artifact=resolved_artifact,
                    injected_skill_keys=injected_skill_keys,
                )
            next_status = "running" if should_continue else "completed"
            if not should_continue:
                if run is not None:
                    run.status = next_status
                if conversation is not None:
                    conversation.last_run_status = next_status
                self.runner.db.flush()
            return approval_resolved_state_patch(
                state=state,
                serialized=serialized,
                status=next_status,
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
                resume_artifact=resolved_artifact,
                injected_skill_keys=injected_skill_keys,
                injection_history=injection_history,
            )
        if resume_artifact is None:
            self.runner.approval_followup_streamer.stream_followup(state, serialized, terminal_status="completed")
            if run is not None:
                run.status = "completed"
            if conversation is not None:
                conversation.last_run_status = "completed"
            self.runner.db.flush()
            return approval_resolved_state_patch(
                state=state,
                serialized=serialized,
                status="completed",
                run_artifacts=run_artifacts,
                approval_artifacts=approval_artifacts,
            )
        return approval_resolved_state_patch(
            state=state,
            serialized=serialized,
            status="running",
            run_artifacts=run_artifacts,
            approval_artifacts=approval_artifacts,
            resume_artifact=resume_artifact,
        )

    @staticmethod
    def _is_typed_continuation(artifact: dict[str, Any] | None) -> bool:
        return isinstance(artifact, dict) and artifact.get("type") == "workflow.continuation"

    @staticmethod
    def _record_continuation_rejection(run: AIAgentRun, artifact: dict[str, Any]) -> None:
        payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
        workflow_id = str(payload.get("workflowId") or "").strip()
        if not workflow_id:
            return
        summary = dict(run.context_summary or {})
        record_continuation_rejected(summary, workflow_id=workflow_id)
        run.context_summary = summary

    def _publish_resumed_skill_start(
        self,
        *,
        state: WorkspaceGraphState,
        artifact: dict[str, Any],
        injected_skill_keys: list[str],
    ) -> None:
        payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
        skill_key = str(payload.get("resumeSkillKey") or "").strip()
        existing_keys = set(state.get("injected_skill_keys") or [])
        if not skill_key or skill_key in existing_keys or skill_key not in injected_skill_keys:
            return
        display_name = self.runner.skill_registry.get(skill_key).manifest.name
        update = continuation_skill_start_event(
            run_id=state["run_id"],
            artifact=artifact,
            skill_key=skill_key,
            display_name=display_name,
        )
        event_id = str(update["data"]["id"])
        if self.runner.db.get(AIRunEvent, event_id) is not None:
            return
        writer = self.runner._persistent_progress_writer(
            self.runner._optional_stream_writer(),
            state,
        )
        writer(update)

    def _consume_resume_artifact(
        self,
        *,
        state: WorkspaceGraphState,
        serialized: dict[str, Any],
    ) -> dict[str, Any] | None:
        # Shopping completion no longer auto-builds shopping_to_stock continuations.
        # Purchase intake is owned by inventory_analysis via inventory_intake.
        return self.runner._consume_resume_after_approval(state, serialized)

    @staticmethod
    def _resolve_typed_continuation(
        *,
        state: WorkspaceGraphState,
        artifact: dict[str, Any],
    ) -> tuple[dict[str, Any], list[str], list[dict[str, Any]], bool]:
        try:
            injected_skill_keys, injection_history = continuation_resume_state(
                state=state,
                artifact=artifact,
            )
        except ContinuationResumeError as exc:
            failed_artifact = {
                **artifact,
                "status": "failed",
                "payload": {
                    **(
                        artifact.get("payload")
                        if isinstance(artifact.get("payload"), dict)
                        else {}
                    ),
                    "status": "failed",
                    "errorCode": exc.code,
                },
            }
            return (
                failed_artifact,
                list(state.get("injected_skill_keys") or []),
                list(state.get("injection_history") or []),
                False,
            )
        return artifact, injected_skill_keys, injection_history, True
