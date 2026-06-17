from __future__ import annotations

from collections.abc import Iterator
from datetime import date
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.kitchen.context import load_agent_context
from app.ai.kitchen.recipe_drafts import (
    RECIPE_DRAFT_JSON_SCHEMA,
    RecipeDraftGenerationInput,
    build_recipe_draft_messages,
    build_recipe_image_render_payload,
    normalize_recipe_draft,
)
from app.ai.runtime.provider import BaseChatProvider, get_chat_provider
from app.ai.skills import build_workspace_skill_registry
from app.ai.workflows.conversations import (
    find_active_conversation_run,
    find_idempotent_run,
    get_or_create_conversation,
    normalize_workspace_subject,
    require_conversation,
    resolve_conversation_user_id,
)
from app.ai.workflows.run_lifecycle import (
    build_regenerate_part_chat_request,
    build_retry_chat_request,
    cancel_workspace_run,
)
from app.core.enums import AiMode
from app.core.utils import create_id, utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AITaskDraft,
)
from app.services.ai_operations import (
    apply_ai_approval_decision,
    DRAFT_APPROVAL_CONFIG,
    append_message_result_card,
    approval_decision_artifacts_for_decision,
    create_ai_draft_approval,
    create_inventory_quick_draft_from_card,
    load_operation_current_value,
    draft_preview_summary,
    normalize_ai_draft_payload,
    record_recommendation_selection_for_card,
)
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_message,
    serialize_ai_run,
    serialize_ai_run_event,
)

logger = logging.getLogger(__name__)


class AIApplicationService:
    def __init__(self, db: Session, provider: BaseChatProvider | None = None) -> None:
        self.db = db
        self.provider = provider if provider is not None else get_chat_provider()

    def chat(
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
    ) -> dict[str, Any]:
        from app.ai.workflows.runner import WorkspaceGraphRunner

        return WorkspaceGraphRunner(self).invoke_user_message(
            family_id=family_id,
            user_id=user_id,
            message=message,
            conversation_id=conversation_id,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
        )

    def stream_chat(
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
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        from app.ai.workflows.runner import WorkspaceGraphRunner

        return WorkspaceGraphRunner(self).stream_user_message(
            family_id=family_id,
            user_id=user_id,
            message=message,
            conversation_id=conversation_id,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
            quick_task=quick_task,
            subject=subject,
        )

    def normalize_subject(self, *, family_id: str, subject: dict[str, Any] | None) -> dict[str, Any]:
        return normalize_workspace_subject(self.db, family_id=family_id, subject=subject)

    def find_idempotent_run(
        self,
        *,
        family_id: str,
        client_message_id: str | None,
        client_run_id: str | None,
    ) -> AIAgentRun | None:
        return find_idempotent_run(
            self.db,
            family_id=family_id,
            client_message_id=client_message_id,
            client_run_id=client_run_id,
        )

    def find_active_conversation_run(self, *, family_id: str, conversation_id: str) -> AIAgentRun | None:
        return find_active_conversation_run(self.db, family_id=family_id, conversation_id=conversation_id)

    def generate_recipe_draft(
        self,
        *,
        family_id: str,
        user_id: str,
        prompt: str,
        subject: dict[str, Any],
        generate_image: bool,
    ) -> dict[str, Any]:
        draft_input = RecipeDraftGenerationInput(prompt=prompt, subject=subject)
        context = load_agent_context(
            self.db,
            family_id=family_id,
            mode=AiMode.RECIPE_DRAFT,
            subject=subject,
            include_inventory=False,
            include_meal_logs=False,
        )
        system, user_prompt = build_recipe_draft_messages(context, draft_input)
        result = self.provider.generate(system=system, user=user_prompt, response_schema=RECIPE_DRAFT_JSON_SCHEMA)
        draft = None
        image_render_payload = None
        status = "failed"
        error = result.error
        if result.text and result.status == "completed":
            draft = normalize_recipe_draft(result.text, context, draft_input)
            if draft is None:
                error = error or "model returned invalid recipe draft JSON"
            else:
                status = "completed"
                error = None
                image_render_payload = build_recipe_image_render_payload(draft) if generate_image else None
        else:
            error = error or "AI recipe draft provider is unavailable"

        run = AIAgentRun(
            id=create_id("agent_run"),
            family_id=family_id,
            agent_key="recipe_draft_agent",
            feature_key="aiRecipeDraft",
            intent="recipe_draft",
            input_summary=prompt[:255],
            context_summary=context.to_record(),
            output_summary="已生成可编辑的菜谱草稿。" if status == "completed" else "AI 菜谱生成失败，请稍后重试。",
            status=status,
            model=result.model or getattr(self.provider, "model_name", ""),
            input={
                "prompt": prompt,
                "subject": subject,
                "responseFormat": "recipe_draft",
                "context": context.to_record(),
            },
            output={"recipeDraft": draft, "imageRenderPayload": image_render_payload},
            tool_calls=[],
            error=error,
            created_by=user_id,
        )
        self.db.add(run)
        self.db.flush()
        return {
            "draft": draft,
            "agent_run_id": run.id,
            "status": status,
            "error": error,
            "image_render_payload": image_render_payload,
        }

    def record_recommendation_selection(
        self,
        *,
        family_id: str,
        user_id: str,
        message_id: str,
        part_id: str,
        card_id: str,
        entity_id: str,
        food_plan_item_id: str,
    ) -> AIMessage:
        return record_recommendation_selection_for_card(
            self.db,
            family_id=family_id,
            user_id=user_id,
            message_id=message_id,
            part_id=part_id,
            card_id=card_id,
            entity_id=entity_id,
            food_plan_item_id=food_plan_item_id,
        )

    def create_inventory_quick_draft(
        self,
        *,
        family_id: str,
        user_id: str,
        message_id: str,
        part_id: str,
        card_id: str,
        item_id: str,
        action: str,
    ) -> AIMessage:
        return create_inventory_quick_draft_from_card(
            self.db,
            family_id=family_id,
            user_id=user_id,
            message_id=message_id,
            part_id=part_id,
            card_id=card_id,
            item_id=item_id,
            action=action,
            create_draft_approval=self._create_draft_approval,
        )

    def pending_approvals(self, *, family_id: str, conversation_id: str) -> list[dict[str, Any]]:
        self._require_conversation(family_id=family_id, conversation_id=conversation_id)
        approvals = list(
            self.db.scalars(
                select(AIApprovalRequest)
                .where(
                    AIApprovalRequest.family_id == family_id,
                    AIApprovalRequest.conversation_id == conversation_id,
                    AIApprovalRequest.status == "pending",
                )
                .order_by(AIApprovalRequest.created_at.asc())
            )
        )
        return [serialize_ai_approval_request(item) for item in approvals]

    def cancel_run(self, *, family_id: str, user_id: str, run_id: str) -> dict[str, Any]:
        run, event = cancel_workspace_run(self.db, family_id=family_id, user_id=user_id, run_id=run_id)
        return {"run": serialize_ai_run(run), "events": [serialize_ai_run_event(event)]}

    def retry_run(self, *, family_id: str, user_id: str, run_id: str) -> dict[str, Any]:
        retry_request = build_retry_chat_request(self.db, family_id=family_id, run_id=run_id)
        return self.chat(
            family_id=family_id,
            user_id=user_id,
            message=retry_request["message"],
            conversation_id=retry_request["conversation_id"],
            client_message_id=retry_request["client_message_id"],
            quick_task=retry_request["quick_task"],
            subject=retry_request["subject"],
        )

    def regenerate_part(self, *, family_id: str, user_id: str, message_id: str, part_id: str) -> dict[str, Any]:
        regenerate_request = build_regenerate_part_chat_request(
            self.db,
            family_id=family_id,
            message_id=message_id,
            part_id=part_id,
        )
        return self.chat(
            family_id=family_id,
            user_id=user_id,
            message=regenerate_request["message"],
            conversation_id=regenerate_request["conversation_id"],
            client_message_id=regenerate_request["client_message_id"],
            quick_task=regenerate_request["quick_task"],
            subject=regenerate_request["subject"],
        )

    def decide_approval(
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
        from app.ai.workflows.runner import WorkspaceGraphRunner

        return WorkspaceGraphRunner(self).resume_approval(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            approval_id=approval_id,
            decision=decision,
            draft_version=draft_version,
            values=values,
            comment=comment,
        )

    def stream_approval_decision(
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
        from app.ai.workflows.runner import WorkspaceGraphRunner

        return WorkspaceGraphRunner(self).stream_resume_approval(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            approval_id=approval_id,
            decision=decision,
            draft_version=draft_version,
            values=values,
            comment=comment,
        )

    def _apply_approval_decision(
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
        return apply_ai_approval_decision(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            approval_id=approval_id,
            decision=decision,
            draft_version=draft_version,
            values=values,
            resolve_user_id=self._resolve_conversation_user_id,
            comment=comment,
        )

    def _get_or_create_conversation(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str | None,
        prompt: str,
        quick_task: str | None,
    ) -> AIConversation:
        return get_or_create_conversation(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            quick_task=quick_task,
        )

    def _require_conversation(self, *, family_id: str, conversation_id: str) -> AIConversation:
        return require_conversation(self.db, family_id=family_id, conversation_id=conversation_id)

    def _resolve_conversation_user_id(self, conversation_id: str) -> str | None:
        return resolve_conversation_user_id(self.db, conversation_id)

    def _create_draft_approval(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        message_id: str,
        run_id: str | None,
        draft_payload: dict[str, Any],
    ) -> tuple[AITaskDraft, AIApprovalRequest]:
        draft_type = str(draft_payload.get("draft_type") or "")
        if draft_type not in DRAFT_APPROVAL_CONFIG:
            raise ValueError("暂不支持的草稿类型")
        payload = self._validate_draft_payload(
            draft_type=draft_type,
            family_id=family_id,
            conversation_id=conversation_id,
            payload=dict(draft_payload.get("payload") or {}),
        )
        summary = self._draft_preview_summary(draft_type, payload)
        return create_ai_draft_approval(
            self.db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            message_id=message_id,
            run_id=run_id,
            draft_type=draft_type,
            schema_version=draft_payload.get("schema_version"),
            payload=payload,
            preview_summary=summary,
        )

    def _operation_current_value(self, *, family_id: str, draft_type: str, target_id: str) -> dict[str, Any] | None:
        return load_operation_current_value(
            self.db,
            family_id=family_id,
            draft_type=draft_type,
            target_id=target_id,
        )

    def _validate_draft_payload(self, *, draft_type: str, family_id: str, conversation_id: str, payload: Any) -> dict[str, Any]:
        return normalize_ai_draft_payload(
            self.db,
            draft_type=draft_type,
            family_id=family_id,
            user_id=self._resolve_conversation_user_id(conversation_id),
            conversation_id=conversation_id,
            payload=payload,
        )

    def _draft_preview_summary(self, draft_type: str, payload: dict[str, Any]) -> str:
        return draft_preview_summary(draft_type, payload)

    def _append_message_result_card(self, decision_result: dict[str, Any]) -> None:
        append_message_result_card(self.db, decision_result=decision_result)

    def _approval_decision_artifacts(self, decision_result: dict[str, Any]) -> list[dict[str, Any]]:
        return approval_decision_artifacts_for_decision(decision_result)
