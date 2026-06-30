from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy import select

from app.ai.skills import SkillResult
from app.ai.workflows.result_cards import validate_result_cards
from app.ai.workflows.runner_support.message_parts import (
    aggregate_text_from_parts,
    human_input_request_message_part,
    missing_draft_approval_message_parts,
    result_card_message_part,
    result_cards_from_parts,
)
from app.ai.workflows.runner_support.message_persistence import (
    conversation_context_with_state_patch,
    dedupe_message_parts,
    initial_assistant_message_metadata,
    merge_assistant_skill_metadata,
    message_metadata_with_draft_ids,
    run_output_payload,
    sync_message_parts_with_current_approval_state,
)
from app.ai.workflows.runner_support.run_summary import result_context_summary
from app.ai.workflows.state import WorkspaceGraphState
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIApprovalRequest, AIConversation, AIMessage, AITaskDraft

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
        if runner._cancel_requested(state["run_id"]):
            result.status = "cancelled"
            result.cards = []
            result.drafts = []
            result.error = result.error or "用户取消了这次任务"
            if not result.text.strip():
                result.text = "已取消这次任务。"
        assistant_status = "waiting_approval" if result.drafts else result.status
        cards = [] if result.drafts else validate_result_cards(result.cards)
        next_parts = runner._base_assistant_parts_from_live_stream(
            state,
            result.text,
            stop_after_first_draft=bool(result.drafts),
        )
        for card in cards:
            next_parts.append(result_card_message_part(part_id=create_id("ai_part"), card=card))
        pending_human_input = (
            result.context_summary.get("pendingHumanInput")
            if isinstance(result.context_summary, dict) and isinstance(result.context_summary.get("pendingHumanInput"), dict)
            else None
        )
        if pending_human_input is not None:
            next_parts.append(human_input_request_message_part(part_id=create_id("ai_part"), request=pending_human_input))
        message = runner.db.scalar(
            select(AIMessage)
            .where(AIMessage.run_id == state["run_id"], AIMessage.role == "assistant")
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
        )
        metadata = dict(message.message_metadata or {}) if message is not None else {}
        if message is None:
            metadata_intent = "general_chat"
            metadata_agent_key = "general_chat_agent"
            if skill_key is None:
                metadata_intent = "workspace_orchestrator"
                metadata_agent_key = "workspace_orchestrator"
            elif skill_key:
                metadata_intent = runner.skill_registry.get(skill_key).manifest.intent
                metadata_agent_key = runner.skill_registry.get(skill_key).manifest.agent_key
            metadata = initial_assistant_message_metadata(
                intent=metadata_intent,
                agent_key=metadata_agent_key,
                skill_key=skill_key,
            )
            message = AIMessage(
                id=create_id("ai_message"),
                family_id=state["family_id"],
                conversation_id=state["conversation_id"],
                role="assistant",
                content=result.text,
                content_type="parts",
                parts=next_parts,
                run_id=state["run_id"],
                status=assistant_status,
                message_metadata=metadata,
                created_by=state["user_id"],
            )
            runner.db.add(message)
        else:
            live_text_part_ids = {
                str(part_id)
                for part_id in metadata.get("liveTextPartIds", [])
                if isinstance(part_id, str) and part_id
            }
            existing_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
            if live_text_part_ids:
                existing_parts = [part for part in existing_parts if str(part.get("id") or "") not in live_text_part_ids]
                metadata.pop("liveStreaming", None)
                metadata.pop("liveTextPartIds", None)
                metadata.pop("livePartIds", None)
            message.parts = dedupe_message_parts([*existing_parts, *next_parts])
            metadata = merge_assistant_skill_metadata(metadata, skill_key=skill_key)
            message.message_metadata = metadata
        runner.db.flush()
        drafts: list[AITaskDraft] = []
        approvals: list[AIApprovalRequest] = []
        for draft_payload in result.drafts:
            draft_id = str(draft_payload.get("draft_id") or "")
            approval_id = str(draft_payload.get("approval_id") or "")
            draft = runner.db.get(AITaskDraft, draft_id) if draft_id else None
            approval = runner.db.get(AIApprovalRequest, approval_id) if approval_id else None
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
            next_draft_parts = missing_draft_approval_message_parts(
                [part for part in (message.parts or []) if isinstance(part, dict)],
                draft=draft,
                approval=approval,
            )
            if next_draft_parts:
                message.parts = dedupe_message_parts([*(message.parts or []), *next_draft_parts])
        if drafts:
            message.message_metadata = message_metadata_with_draft_ids(
                metadata,
                drafts=drafts,
                approvals=approvals,
            )
        message.parts = sync_message_parts_with_current_approval_state(message.parts, drafts=drafts, approvals=approvals)
        message_parts = [part for part in (message.parts or []) if isinstance(part, dict)]
        aggregate_text = aggregate_text_from_parts(message_parts)
        message.content = aggregate_text
        message.status = assistant_status
        run = runner.db.get(AIAgentRun, state["run_id"])
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
                )
            )
            run.tool_calls = runner._json_record([*(run.tool_calls or []), *result.tool_calls])
            run.error = result.error
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
