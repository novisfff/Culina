from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from app.ai.skills import SkillResult
from app.ai.workflows.result_cards import validate_result_cards
from app.ai.workflows.runner_support.message_parts import (
    aggregate_text_from_parts,
    draft_route_status,
    human_input_request_message_part,
    matching_successful_operation_result_card,
    result_card_part_id,
    result_card_message_part,
    result_cards_from_parts,
    operation_result_decision_identity,
    ROUTED_WITHOUT_APPROVAL_STATUSES,
)
from app.ai.workflows.runner_support.message_metadata import (
    conversation_context_with_state_patch,
    initial_assistant_message_metadata,
    merge_assistant_skill_metadata,
    message_metadata_with_draft_ids,
    message_metadata_with_model_usage_fallback,
    run_output_payload,
)
from app.ai.workflows.runner_support.run_summary import result_context_summary
from app.ai.workflows.state import WorkspaceGraphState
from app.core.utils import create_id, utcnow
from app.models.domain import AIApprovalRequest, AIConversation, AIMessage, AITaskDraft
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)
from app.services.serializers import serialize_ai_approval_request, serialize_ai_task_draft
from app.ai.workflows.runner_support.run_status import COMPLETED, WAITING_INPUT

if TYPE_CHECKING:
    from app.ai.workflows.runner import WorkspaceGraphRunner


@dataclass
class PersistedAssistantResult:
    message: AIMessage
    message_id: str
    run_id: str
    status: str
    draft_ids: list[str]
    approval_ids: list[str]
    card_count: int
    tool_call_count: int


class AssistantResultPersister:
    def __init__(self, runner: WorkspaceGraphRunner) -> None:
        self.runner = runner

    def persist(
        self,
        state: WorkspaceGraphState,
        result: SkillResult,
        *,
        skill_key: str | None,
        duration_ms: int = 0,
    ) -> PersistedAssistantResult:
        runner = self.runner
        run = lock_run_for_transition(
            runner.db,
            family_id=state["family_id"],
            run_id=state["run_id"],
        )
        if cancellation_wins(runner.db, run=run):
            finalize_run_cancellation(runner.db, run=run)
            result.status = "cancelled"
            result.error = None
            if not result.text.strip():
                result.text = "已取消这次任务。"
        assistant_message_id = str(state.get("assistant_message_id") or "")
        if not assistant_message_id:
            raise RuntimeError("AI 结果缺少 canonical assistant_message_id")
        existing_message = runner.db.scalar(
            select(AIMessage).where(
                AIMessage.id == assistant_message_id,
                AIMessage.family_id == state["family_id"],
                AIMessage.conversation_id == state["conversation_id"],
                AIMessage.run_id == state["run_id"],
                AIMessage.role == "assistant",
            )
        )
        if existing_message is None:
            raise RuntimeError("预创建的 canonical 助手消息不存在")
        # Cancellation finalizes the canonical message before control returns
        # to the graph node.  There must be no second visible write after its
        # terminal event; return the already materialized snapshot instead of
        # trying to merge the provider result into it.
        if result.status == "cancelled" and runner.timeline_service.has_terminal(
            conversation_id=state["conversation_id"],
            message_id=existing_message.id,
        ):
            return self._snapshot_result(
                state,
                run=run,
                message=existing_message,
                status="cancelled",
                duration_ms=duration_ms,
            )
        preserved = self._preserve_committed_operation_after_provider_failure(
            state=state,
            result=result,
            run=run,
            message=existing_message,
            duration_ms=duration_ms,
        )
        if preserved is not None:
            return preserved
        draft_payloads: list[dict[str, Any]] = []
        for draft_payload in result.drafts:
            if not isinstance(draft_payload, dict):
                raise RuntimeError("草稿结果格式无效")
            draft_payloads.append(draft_payload)
        route_statuses = [
            self._persisted_route_status(state, draft_payload)
            for draft_payload in draft_payloads
        ]
        has_manual_draft = any(
            route_status not in ROUTED_WITHOUT_APPROVAL_STATUSES
            for route_status in route_statuses
        )
        assistant_status = "waiting_approval" if has_manual_draft else result.status
        cards = [] if has_manual_draft else validate_result_cards(result.cards)
        message = existing_message
        if result.text.strip() and not result.streamed_text_part_id:
            runner.timeline_service.append_part(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                part={
                    "id": create_id("ai_part"),
                    "type": "text",
                    "text": result.text,
                },
                created_by=state.get("user_id"),
            )
        for card in cards:
            runner.timeline_service.append_part(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                part=result_card_message_part(part_id=result_card_part_id(card), card=card),
                created_by=state.get("user_id"),
            )
        pending_human_input = (
            result.context_summary.get("pendingHumanInput")
            if isinstance(result.context_summary, dict) and isinstance(result.context_summary.get("pendingHumanInput"), dict)
            else None
        )
        if pending_human_input is not None:
            request_id = str(pending_human_input.get("id") or create_id("ai_human_input"))
            runner.timeline_service.append_part(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                part=human_input_request_message_part(
                    part_id=f"human-input-part-{request_id}",
                    request=pending_human_input,
                ),
                created_by=state.get("user_id"),
            )
        metadata = dict(message.message_metadata or {})
        metadata_intent = "general_chat"
        metadata_agent_key = "general_chat_agent"
        if skill_key is None:
            metadata_intent = "workspace_orchestrator"
            metadata_agent_key = "workspace_orchestrator"
        elif skill_key:
            metadata_intent = runner.skill_registry.get(skill_key).manifest.intent
            metadata_agent_key = runner.skill_registry.get(skill_key).manifest.agent_key
        if not metadata.get("intent") or metadata.get("intent") == "workspace_orchestrator":
            metadata = {
                **metadata,
                **initial_assistant_message_metadata(
                    intent=metadata_intent,
                    agent_key=metadata_agent_key,
                    skill_key=skill_key,
                ),
            }
        metadata.pop("liveStreaming", None)
        metadata.pop("liveTextPartIds", None)
        metadata.pop("livePartIds", None)
        metadata = merge_assistant_skill_metadata(metadata, skill_key=skill_key)
        metadata = message_metadata_with_model_usage_fallback(
            metadata,
            fallback_used=result.fallback_used,
            fallback_reason_code=result.fallback_reason_code,
        )
        drafts: list[AITaskDraft] = []
        approvals: list[AIApprovalRequest] = []
        for draft_payload, route_status in zip(draft_payloads, route_statuses, strict=True):
            routed_without_approval = route_status in ROUTED_WITHOUT_APPROVAL_STATUSES
            draft_id = str(draft_payload.get("draft_id") or "")
            approval_id = str(draft_payload.get("approval_id") or "")
            draft = runner.db.get(AITaskDraft, draft_id) if draft_id else None
            approval = runner.db.get(AIApprovalRequest, approval_id) if approval_id else None
            if routed_without_approval:
                if draft is None:
                    raise RuntimeError("路由草稿缺少已持久化记录")
                if approval is not None or approval_id:
                    raise RuntimeError("自动路由草稿不能关联确认请求")
                draft.message_id = message.id
                draft.source_run_id = state["run_id"]
                runner.db.flush()
                runner.db.refresh(draft)
                drafts.append(draft)
                continue
            if draft is None or approval is None:
                draft, approval = runner.service._create_draft_approval(
                    family_id=state["family_id"],
                    user_id=state["user_id"],
                    conversation_id=state["conversation_id"],
                    message_id=message.id,
                    run_id=state["run_id"],
                    draft_payload=draft_payload,
                )
            else:
                draft.message_id = message.id
                draft.source_run_id = state["run_id"]
                approval.message_id = message.id
                approval.run_id = state["run_id"]
                runner.db.flush()
                runner.db.refresh(draft)
                runner.db.refresh(approval)
            drafts.append(draft)
            approvals.append(approval)
            # A draft and its approval are visible parts with stable IDs.  The
            # timeline service decides append vs replace while holding the
            # message lock, so a replay updates the original position rather
            # than deleting and re-appending it.
            runner.timeline_service.upsert_part(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                part={
                    "id": f"draft-part-{draft.id}",
                    "type": "draft",
                    "draft": runner._json_record(serialize_ai_task_draft(draft)),
                },
                created_by=state.get("user_id"),
            )
            runner.timeline_service.upsert_part(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                part={
                    "id": f"approval-part-{approval.id}",
                    "type": "approval_request",
                    "approval": runner._json_record(serialize_ai_approval_request(approval)),
                },
                created_by=state.get("user_id"),
            )
        if drafts:
            metadata = message_metadata_with_draft_ids(
                metadata,
                drafts=drafts,
                approvals=approvals,
            )
        # Metadata is part of the canonical message snapshot as well.  It must
        # be represented by a timeline event instead of an ORM-only mutation.
        runner.timeline_service.update_message_metadata(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            message_id=message.id,
            run_id=state["run_id"],
            metadata=metadata,
            created_by=state.get("user_id"),
        )
        message_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        aggregate_text = aggregate_text_from_parts(message_parts)
        if message.status != assistant_status:
            runner.timeline_service.update_message_status(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                status=assistant_status,
                created_by=state.get("user_id"),
            )
        conversation = runner.db.get(AIConversation, state["conversation_id"])
        all_cards = result_cards_from_parts(message_parts)
        if run is not None:
            context_summary, injected_skill_keys = result_context_summary(
                existing_context_summary=dict(run.context_summary or {}),
                result=result,
                skill_key=skill_key,
                draft_count=len(drafts),
                approval_count=len(approvals),
                conversation_context=dict(conversation.context or {}) if conversation is not None else None,
                current_run_artifacts=list(state.get("run_artifacts") or []),
            )
            run.status = assistant_status
            if skill_key is None and injected_skill_keys:
                run.intent = (
                    "multi_skill"
                    if len(injected_skill_keys) > 1
                    else runner.skill_registry.get(injected_skill_keys[0]).manifest.intent
                )
            elif skill_key is None:
                run.intent = "general_chat"
            run.model = result.model or run.model
            run.output_summary = aggregate_text[:255]
            run.output = runner._json_record(
                run_output_payload(
                    text=aggregate_text,
                    cards=all_cards,
                    routing=(run.context_summary or {}).get("routing", {}),
                    fallback_used=result.fallback_used,
                    fallback_reason_code=result.fallback_reason_code,
                )
            )
            run.tool_calls = runner._json_record([*(run.tool_calls or []), *result.tool_calls])
            run.error = None if assistant_status == "cancelled" else result.error
            run.duration_ms = int(run.duration_ms or 0) + duration_ms
            run.context_summary = runner._json_record(context_summary)
        if conversation is not None:
            conversation.prompt = state["message"]
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = assistant_status
            conversation.context = runner._json_record(
                conversation_context_with_state_patch(
                    conversation.context if isinstance(conversation.context, dict) else {},
                    state_patch=result.state_patch,
                )
            )
        runner.db.flush()
        return PersistedAssistantResult(
            message=message,
            message_id=message.id,
            run_id=state["run_id"],
            status=assistant_status,
            draft_ids=[draft.id for draft in drafts],
            approval_ids=[approval.id for approval in approvals],
            card_count=len(all_cards),
            tool_call_count=len(result.tool_calls),
        )

    def _snapshot_result(
        self,
        state: WorkspaceGraphState,
        *,
        run: Any,
        message: AIMessage,
        status: str,
        duration_ms: int,
    ) -> PersistedAssistantResult:
        """Return the durable message without creating a second snapshot."""

        parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        text = aggregate_text_from_parts(parts)
        if run is not None:
            run.status = status
            run.error = None
            run.output_summary = (text or str(message.content or ""))[:255]
            run.output = self.runner._json_record(
                run_output_payload(text=text, cards=result_cards_from_parts(parts), routing={})
            )
            run.duration_ms = int(run.duration_ms or 0) + duration_ms
        conversation = self.runner.db.get(AIConversation, state["conversation_id"])
        if conversation is not None:
            conversation.last_run_status = status
            conversation.last_message_at = utcnow()
            conversation.response = text or str(message.content or "")
            conversation.summary = conversation.response[:255]
            context = dict(conversation.context or {})
            context.pop("activeRunId", None)
            conversation.context = self.runner._json_record(context)
        return PersistedAssistantResult(
            message=message,
            message_id=message.id,
            run_id=state["run_id"],
            status=status,
            draft_ids=[],
            approval_ids=[],
            card_count=len(result_cards_from_parts(parts)),
            tool_call_count=0,
        )

    def _preserve_committed_operation_after_provider_failure(
        self,
        *,
        state: WorkspaceGraphState,
        result: SkillResult,
        run: Any,
        message: AIMessage | None,
        duration_ms: int,
    ) -> PersistedAssistantResult | None:
        """Keep a committed approval result when only its continuation failed.

        Approval commits write the operation-result card before the resumed
        orchestrator asks the Provider for a follow-up response.  A normal
        Provider failure is still returned as a ``SkillResult`` (rather than
        raising), so the generic persister must not append that failure over a
        card belonging to the same approval.  Matching uses the decision IDs;
        an unrelated earlier operation in a multi-step run must remain a real
        failure.
        """

        if (
            result.status != "failed"
            or result.cards
            or result.drafts
            or result.text.strip() != "AI 工作台暂时无法完成这次请求，请稍后重试。"
            or message is None
        ):
            return None
        expected_identity = self._operation_result_identity_from_state(state)
        if not expected_identity:
            return None
        parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        matched_card = matching_successful_operation_result_card(
            parts,
            expected_identity=expected_identity,
        )
        if matched_card is None:
            return None

        next_status = self._message_status_after_preserved_operation(parts)
        aggregate_text = aggregate_text_from_parts(parts)
        metadata = dict(message.message_metadata or {})
        metadata.pop("liveStreaming", None)
        metadata.pop("liveTextPartIds", None)
        metadata.pop("livePartIds", None)

        runner = self.runner
        runner.timeline_service.update_message_metadata(
            family_id=state["family_id"],
            conversation_id=state["conversation_id"],
            message_id=message.id,
            run_id=state["run_id"],
            metadata=metadata,
            created_by=state.get("user_id"),
            allow_after_terminal=True,
        )
        if message.status != next_status:
            runner.timeline_service.update_message_status(
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                message_id=message.id,
                run_id=state["run_id"],
                status=next_status,
                created_by=state.get("user_id"),
            )
        all_cards = result_cards_from_parts(parts)
        if run is not None:
            run.status = next_status
            run.error = None
            run.model = result.model or run.model
            run.output_summary = (aggregate_text or str(matched_card.get("title") or ""))[:255]
            run.output = runner._json_record(
                run_output_payload(
                    text=aggregate_text,
                    cards=all_cards,
                    routing=(run.context_summary or {}).get("routing", {}),
                )
            )
            if result.tool_calls:
                run.tool_calls = runner._json_record([*(run.tool_calls or []), *result.tool_calls])
            run.duration_ms = int(run.duration_ms or 0) + duration_ms
        conversation = runner.db.get(AIConversation, state["conversation_id"])
        if conversation is not None:
            conversation.prompt = state["message"]
            conversation.response = aggregate_text
            conversation.summary = aggregate_text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = next_status
            context = dict(conversation.context or {})
            if next_status == COMPLETED:
                context.pop("activeRunId", None)
            conversation.context = runner._json_record(context)

        # Make the graph and finalizer follow the durable operation result. The
        # provider diagnostic remains in the trace/LLM exchange; it must not be
        # exposed as a second user-facing failure message.
        result.status = next_status
        result.error = None
        result.text = ""
        runner.db.flush()
        return PersistedAssistantResult(
            message=message,
            message_id=message.id,
            run_id=state["run_id"],
            status=next_status,
            draft_ids=[],
            approval_ids=[],
            card_count=len(all_cards),
            tool_call_count=len(result.tool_calls),
        )

    @staticmethod
    def _operation_result_identity_from_state(state: WorkspaceGraphState) -> dict[str, str]:
        decision = state.get("last_decision")
        if isinstance(decision, dict):
            identity = operation_result_decision_identity(decision)
            if any(identity.values()):
                return identity
        for artifact in reversed(state.get("run_artifacts") or []):
            if not isinstance(artifact, dict):
                continue
            if artifact.get("type") not in {"approval_decision", "ai_operation_result"}:
                continue
            payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
            candidate = operation_result_decision_identity(
                {
                    **payload,
                    "sourceApprovalId": artifact.get("sourceApprovalId"),
                    "sourceDraftId": artifact.get("sourceDraftId"),
                    "sourceOperationId": artifact.get("sourceOperationId"),
                }
            )
            if any(candidate.values()):
                return candidate
        return {}

    @staticmethod
    def _message_status_after_preserved_operation(parts: list[dict[str, Any]]) -> str:
        for part in parts:
            if part.get("type") == "approval_request":
                approval = part.get("approval") if isinstance(part.get("approval"), dict) else {}
                if str(approval.get("status") or "").lower() in {"pending", "pending_retry"}:
                    return "waiting_approval"
            if part.get("type") == "human_input_request":
                request = part.get("request") if isinstance(part.get("request"), dict) else {}
                if str(request.get("status") or "pending").lower() in {"pending", "pending_retry"}:
                    return WAITING_INPUT
        return COMPLETED

    def _persisted_route_status(
        self,
        state: WorkspaceGraphState,
        draft_payload: dict[str, Any],
    ) -> str:
        claimed_status = str(draft_payload.get("route_status") or "")
        draft_id = str(draft_payload.get("draft_id") or "")
        draft = self.runner.db.get(AITaskDraft, draft_id) if draft_id else None
        if draft is None:
            if claimed_status in ROUTED_WITHOUT_APPROVAL_STATUSES:
                raise RuntimeError("自动路由草稿缺少已持久化记录")
            return draft_route_status(draft_payload)
        if (
            draft.family_id != state["family_id"]
            or draft.conversation_id != state["conversation_id"]
            or draft.source_run_id != state["run_id"]
        ):
            raise RuntimeError("路由草稿的运行或会话归属不一致")
        metadata = draft.ai_metadata if isinstance(draft.ai_metadata, dict) else {}
        stored_outcome = (
            metadata.get("routeOutcome")
            if isinstance(metadata.get("routeOutcome"), dict)
            else {}
        )
        stored_status = str(stored_outcome.get("status") or "")
        valid_statuses = {"waiting_approval", *ROUTED_WITHOUT_APPROVAL_STATUSES}
        if stored_status:
            if stored_status not in valid_statuses:
                raise RuntimeError("持久化草稿路由结果无效")
            if claimed_status and claimed_status != stored_status:
                raise RuntimeError("草稿路由结果与持久化状态不一致")
            draft_payload["route_status"] = stored_status
            return stored_status
        if claimed_status in ROUTED_WITHOUT_APPROVAL_STATUSES:
            raise RuntimeError("自动路由草稿缺少持久化路由结果")
        return draft_route_status(draft_payload)
