from __future__ import annotations

from decimal import Decimal
from time import perf_counter
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from pydantic import ValidationError

from app.ai.agents import build_agent_registry
from app.ai.orchestration.tools import build_tool_registry
from app.ai.orchestration.workspace import OrchestratorRequest, WorkspaceOrchestrator
from app.ai.runtime.provider import BaseChatProvider
from app.ai.runtime.runner import get_chat_provider
from app.core.enums import ActivityAction, AiMode
from app.core.utils import create_id, utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIOperation,
    AIRunEvent,
    AITaskDraft,
    AIUserApproval,
    Ingredient,
    Recipe,
    RecipeIngredient,
    RecipeStep,
)
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.recipes import CreateRecipeRequest
from app.services.activity import log_activity
from app.services.media import bind_media_assets
from app.services.recipe_food_sync import ensure_food_for_recipe
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_message,
    serialize_ai_operation,
    serialize_ai_run,
    serialize_ai_run_event,
    serialize_ai_task_draft,
    serialize_recipe,
)


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
        quick_task: str | None = None,
        subject: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        prompt = message.strip()
        if not prompt:
            raise ValueError("消息不能为空")

        conversation = self._get_or_create_conversation(
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            prompt=prompt,
            quick_task=quick_task,
        )
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

        run = AIAgentRun(
            id=create_id("agent_run"),
            family_id=family_id,
            conversation_id=conversation.id,
            message_id=user_message.id,
            agent_key="workspace_orchestrator",
            feature_key="ai_workspace_chat",
            intent="",
            input_summary=prompt[:255],
            context_summary={},
            output_summary="",
            status="running",
            model=getattr(self.provider, "model_name", ""),
            input={"prompt": prompt, "quickTask": quick_task, "subject": subject or {}},
            output={},
            tool_calls=[],
            duration_ms=0,
            created_by=user_id,
        )
        self.db.add(run)
        self.db.flush()
        events = [
            self._add_event(family_id, conversation.id, run.id, "intent", "detect_intent", "正在理解你的需求", "completed"),
            self._add_event(family_id, conversation.id, run.id, "context", "load_context", "正在查看你的厨房上下文", "completed"),
        ]

        started_at = perf_counter()
        orchestrator = WorkspaceOrchestrator(
            self.db,
            agent_registry=build_agent_registry(),
            tool_registry=build_tool_registry(),
            provider=self.provider,
        )
        result = orchestrator.run(
            OrchestratorRequest(
                family_id=family_id,
                user_id=user_id,
                prompt=prompt,
                quick_task=quick_task,
                subject=subject or {},
            )
        )
        output = result.output
        events.append(self._add_event(family_id, conversation.id, run.id, "agent", "run_agent", "正在生成可操作建议", output.status))

        cards = output.cards
        parts = [{"id": create_id("ai_part"), "type": "text", "text": output.text}]
        for card in cards:
            parts.append({"id": create_id("ai_part"), "type": "result_card", "card": card})
        if output.status == "failed":
            error_card = {
                "id": create_id("ai_card"),
                "type": "error_recovery",
                "title": "这次没有生成成功",
                "data": {"message": output.error or "请稍后重试，或换一种说法。"},
            }
            cards = [*cards, error_card]
            parts.append({"id": create_id("ai_part"), "type": "error_recovery", "card": error_card})

        assistant_message = AIMessage(
            id=create_id("ai_message"),
            family_id=family_id,
            conversation_id=conversation.id,
            role="assistant",
            content=output.text,
            content_type="parts",
            parts=parts,
            run_id=run.id,
            status=output.status,
            message_metadata={"intent": result.intent, "agentKey": result.agent_key},
            created_by=user_id,
        )
        self.db.add(assistant_message)
        self.db.flush()

        drafts: list[AITaskDraft] = []
        approvals: list[AIApprovalRequest] = []
        if output.status == "completed":
            for draft_payload in output.drafts:
                draft, approval, card = self._create_draft_approval(
                    family_id=family_id,
                    user_id=user_id,
                    conversation_id=conversation.id,
                    message_id=assistant_message.id,
                    run_id=run.id,
                    draft_payload=draft_payload,
                )
                drafts.append(draft)
                approvals.append(approval)
                cards.append(card)
                parts.append({"id": create_id("ai_part"), "type": "draft", "draft": jsonable_encoder(serialize_ai_task_draft(draft))})
                parts.append({"id": create_id("ai_part"), "type": "approval_request", "approval": jsonable_encoder(serialize_ai_approval_request(approval))})
                parts.append({"id": create_id("ai_part"), "type": "result_card", "card": card})
            if drafts:
                assistant_message.parts = parts
                assistant_message.message_metadata = {
                    **(assistant_message.message_metadata or {}),
                    "draftIds": [draft.id for draft in drafts],
                    "approvalIds": [approval.id for approval in approvals],
                }

        run.agent_key = result.agent_key
        run.intent = result.intent
        run.status = output.status
        run.model = output.model or run.model
        run.context_summary = output.context_summary
        run.output_summary = output.text[:255]
        run.output = {"text": output.text, "cards": cards}
        run.tool_calls = output.tool_calls
        run.error = output.error
        run.duration_ms = int((perf_counter() - started_at) * 1000)

        conversation.prompt = prompt
        conversation.response = output.text
        conversation.summary = output.text[:255]
        conversation.last_message_at = utcnow()
        conversation.last_run_status = output.status

        events.append(self._add_event(family_id, conversation.id, run.id, "finalize", "build_response", "已生成回复", output.status))
        self.db.flush()
        return {
            "conversation_id": conversation.id,
            "message": serialize_ai_message(assistant_message),
            "run": serialize_ai_run(run),
            "events": [serialize_ai_run_event(event) for event in events],
            "included": {
                "result_cards": cards,
                "drafts": [serialize_ai_task_draft(draft) for draft in drafts],
                "approvals": [serialize_ai_approval_request(approval) for approval in approvals],
            },
        }

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
        self._require_conversation(family_id=family_id, conversation_id=conversation_id)
        approval = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
        if approval is None:
            raise LookupError("确认请求不存在")
        draft = self.db.scalar(
            select(AITaskDraft).where(AITaskDraft.id == approval.draft_id, AITaskDraft.family_id == family_id)
        )
        if draft is None:
            raise LookupError("草稿不存在")
        if approval.status != "pending":
            raise ValueError("确认请求已处理，不能重复提交")
        if draft.status not in {"pending", "pending_retry"}:
            raise ValueError("草稿已处理，不能重复提交")
        if draft_version != draft.version or approval.draft_version != draft.version:
            raise ValueError("草稿已更新，请重新确认")
        if decision == "rejected" and approval.request_payload.get("requireRejectComment") and not (comment or "").strip():
            raise ValueError("请填写拒绝原因")

        submitted_values = (
            self._validate_approval_values(approval, draft, values, enforce_required=True)
            if decision == "approved"
            else self._validate_rejection_values(approval, values)
        )
        now = utcnow()
        approval.status = "approved" if decision == "approved" else "rejected"
        approval.decision = decision
        approval.comment = (comment or "").strip() or None
        approval.submitted_values = submitted_values
        approval.resolved_at = now
        approval.updated_by = user_id

        audit = AIUserApproval(
            id=create_id("ai_user_approval"),
            family_id=family_id,
            approval_request_id=approval.id,
            draft_id=draft.id,
            approved_by=user_id,
            approved_at=now,
            decision=decision,
            approval_payload=submitted_values,
            operation_summary={},
            comment=approval.comment,
        )
        self.db.add(audit)

        operation: AIOperation | None = None
        business_entity: dict[str, Any] | None = None
        if decision == "rejected":
            draft.status = "rejected"
            draft.updated_by = user_id
            self.db.flush()
            self._sync_message_approval_parts(draft, approval)
            return {
                "approval": serialize_ai_approval_request(approval),
                "draft": serialize_ai_task_draft(draft),
                "operation": None,
                "business_entity": None,
            }

        operation = AIOperation(
            id=create_id("ai_operation"),
            family_id=family_id,
            approval_request_id=approval.id,
            draft_id=draft.id,
            operation_type="recipe.create",
            status="running",
            business_entity_type="Recipe",
            business_entity_ids=[],
            idempotency_key=f"{approval.id}:recipe.create:v{draft.version}",
        )
        self.db.add(operation)
        self.db.flush()
        decision_approval = approval
        try:
            with self.db.begin_nested():
                recipe = self._create_recipe_from_draft(family_id=family_id, user_id=user_id, payload=submitted_values["recipe"])
            operation.status = "succeeded"
            operation.business_entity_ids = [recipe.id]
            operation.completed_at = utcnow()
            draft.status = "confirmed"
            draft.payload = submitted_values["recipe"]
            draft.updated_by = user_id
            audit.operation_summary = {"operationId": operation.id, "recipeId": recipe.id}
            media_map = build_media_map(
                get_media_assets_for_entities(self.db, family_id=family_id, entity_type="recipe", entity_ids=[recipe.id])
            )
            business_entity = serialize_recipe(recipe, media_map)
        except Exception as exc:
            operation.status = "failed"
            operation.error_message = str(exc)
            draft.status = "pending_retry"
            draft.payload = submitted_values["recipe"]
            draft.updated_by = user_id
            retry_approval = self._create_retry_approval(
                family_id=family_id,
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=approval.message_id,
                run_id=approval.run_id,
                draft=draft,
                values=submitted_values,
                error_message=str(exc),
            )
            self._sync_message_approval_parts(draft, decision_approval)
            self._append_message_approval_part(retry_approval)
            approval = retry_approval
        finally:
            self.db.flush()
        self._sync_message_approval_parts(draft, approval)

        return {
            "approval": serialize_ai_approval_request(approval),
            "draft": serialize_ai_task_draft(draft),
            "operation": serialize_ai_operation(operation),
            "business_entity": business_entity,
        }

    def _get_or_create_conversation(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str | None,
        prompt: str,
        quick_task: str | None,
    ) -> AIConversation:
        if conversation_id:
            conversation = self.db.scalar(
                select(AIConversation).where(AIConversation.id == conversation_id, AIConversation.family_id == family_id)
            )
            if conversation is None:
                raise LookupError("会话不存在")
            return conversation
        title = "今日吃什么" if quick_task == "today_recommendation" else prompt[:24]
        conversation = AIConversation(
            id=create_id("conversation"),
            family_id=family_id,
            mode=AiMode.RECOMMENDATION,
            prompt=prompt,
            response="",
            context={"workspace": True},
            title=title,
            summary="",
            status="active",
            last_message_at=utcnow(),
            created_by=user_id,
        )
        self.db.add(conversation)
        self.db.flush()
        return conversation

    def _require_conversation(self, *, family_id: str, conversation_id: str) -> AIConversation:
        conversation = self.db.scalar(
            select(AIConversation).where(AIConversation.id == conversation_id, AIConversation.family_id == family_id)
        )
        if conversation is None:
            raise LookupError("会话不存在")
        return conversation

    def _create_draft_approval(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        message_id: str,
        run_id: str,
        draft_payload: dict[str, Any],
    ) -> tuple[AITaskDraft, AIApprovalRequest, dict[str, Any]]:
        if draft_payload.get("draft_type") != "recipe":
            raise ValueError("暂不支持的草稿类型")
        payload = dict(draft_payload.get("payload") or {})
        validated = CreateRecipeRequest.model_validate(payload)
        recipe_payload = validated.model_dump(mode="json")
        title = recipe_payload["title"]
        draft = AITaskDraft(
            id=create_id("ai_draft"),
            family_id=family_id,
            conversation_id=conversation_id,
            source_run_id=run_id,
            message_id=message_id,
            draft_type="recipe",
            payload=recipe_payload,
            preview_summary=f"{title} · {len(recipe_payload['ingredient_items'])} 个食材 · {len(recipe_payload['steps'])} 个步骤",
            status="pending",
            version=1,
            schema_version=draft_payload.get("schema_version") or "recipe.v1",
            validation_errors=[],
            idempotency_key=f"{run_id}:recipe:{create_id('idem')}",
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(draft)
        self.db.flush()
        approval = AIApprovalRequest(
            id=create_id("ai_approval"),
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
            run_id=run_id,
            draft_id=draft.id,
            draft_version=draft.version,
            draft_schema_version=draft.schema_version,
            approval_type="recipe.create",
            status="pending",
            request_payload={
                "title": "确认创建菜谱",
                "instruction": "确认后会创建菜谱，并自动同步一个家常菜食物资料。",
                "approveLabel": "创建菜谱",
                "rejectLabel": "暂不创建",
                "requireRejectComment": False,
            },
            field_schema=[
                {"name": "recipe", "label": "菜谱草稿", "type": "object", "widget": "recipe_draft_editor", "required": True}
            ],
            initial_values={"recipe": recipe_payload},
            submitted_values={},
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(approval)
        self.db.flush()
        card = {
            "id": create_id("ai_card"),
            "type": "recipe_draft",
            "title": title,
            "data": {
                "draftId": draft.id,
                "approvalId": approval.id,
                "summary": draft.preview_summary,
                "draft": recipe_payload,
            },
        }
        return draft, approval, card

    def _create_retry_approval(
        self,
        *,
        family_id: str,
        user_id: str,
        conversation_id: str,
        message_id: str | None,
        run_id: str | None,
        draft: AITaskDraft,
        values: dict[str, Any],
        error_message: str,
    ) -> AIApprovalRequest:
        approval = AIApprovalRequest(
            id=create_id("ai_approval"),
            family_id=family_id,
            conversation_id=conversation_id,
            message_id=message_id,
            run_id=run_id,
            draft_id=draft.id,
            draft_version=draft.version,
            draft_schema_version=draft.schema_version,
            approval_type="recipe.create.retry",
            status="pending",
            request_payload={
                "title": "重试创建菜谱",
                "instruction": f"上次写入失败：{error_message}。你可以调整草稿后重试。",
                "approveLabel": "重试创建",
                "rejectLabel": "放弃草稿",
                "requireRejectComment": False,
            },
            field_schema=[
                {"name": "recipe", "label": "菜谱草稿", "type": "object", "widget": "recipe_draft_editor", "required": True}
            ],
            initial_values=values,
            submitted_values={},
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(approval)
        self.db.flush()
        return approval

    def _validate_rejection_values(self, approval: AIApprovalRequest, values: dict[str, Any]) -> dict[str, Any]:
        allowed = {field["name"] for field in approval.field_schema if isinstance(field.get("name"), str)}
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"确认表单包含未知字段：{', '.join(sorted(unknown))}")
        return {}

    def _validate_approval_values(
        self,
        approval: AIApprovalRequest,
        draft: AITaskDraft,
        values: dict[str, Any],
        *,
        enforce_required: bool = True,
    ) -> dict[str, Any]:
        fields = [field for field in approval.field_schema if isinstance(field.get("name"), str)]
        allowed = {field["name"] for field in fields}
        unknown = set(values) - allowed
        if unknown:
            raise ValueError(f"确认表单包含未知字段：{', '.join(sorted(unknown))}")
        for field in fields:
            self._validate_approval_field(field, values, enforce_required=enforce_required)
        recipe_value = values.get("recipe", draft.payload)
        try:
            recipe = CreateRecipeRequest.model_validate(recipe_value).model_dump(mode="json")
        except ValidationError as exc:
            raise ValueError("菜谱草稿字段不完整或格式不正确") from exc
        ingredient_ids = [item.get("ingredient_id") for item in recipe["ingredient_items"] if item.get("ingredient_id")]
        if ingredient_ids:
            existing_ids = set(
                self.db.scalars(select(Ingredient.id).where(Ingredient.family_id == draft.family_id, Ingredient.id.in_(ingredient_ids)))
            )
            missing = set(ingredient_ids) - existing_ids
            if missing:
                raise ValueError("草稿包含不属于当前家庭的食材")
        return {"recipe": recipe}

    def _validate_approval_field(self, field: dict[str, Any], values: dict[str, Any], *, enforce_required: bool) -> None:
        name = str(field["name"])
        if enforce_required and field.get("required") and name not in values:
            raise ValueError(f"{field.get('label') or name} 不能为空")
        if name not in values:
            return
        value = values[name]
        if enforce_required and field.get("required") and (value is None or value == "" or value == []):
            raise ValueError(f"{field.get('label') or name} 不能为空")
        if name == "recipe":
            return

        expected_type = field.get("type")
        if expected_type == "string" and not isinstance(value, str):
            raise ValueError(f"{field.get('label') or name} 必须是文本")
        if expected_type == "number" and not isinstance(value, int | float):
            raise ValueError(f"{field.get('label') or name} 必须是数字")
        if expected_type == "integer" and not isinstance(value, int):
            raise ValueError(f"{field.get('label') or name} 必须是整数")
        if expected_type == "boolean" and not isinstance(value, bool):
            raise ValueError(f"{field.get('label') or name} 必须是布尔值")
        if expected_type == "array" and not isinstance(value, list):
            raise ValueError(f"{field.get('label') or name} 必须是数组")
        if expected_type == "object" and not isinstance(value, dict):
            raise ValueError(f"{field.get('label') or name} 必须是对象")

        widget = field.get("widget")
        if widget in {"select", "radio", "checkbox_group"}:
            allowed_values = {
                option.get("value") if isinstance(option, dict) else option
                for option in (field.get("options") or [])
            }
            submitted_values = value if isinstance(value, list) else [value]
            if allowed_values and any(item not in allowed_values for item in submitted_values):
                raise ValueError(f"{field.get('label') or name} 包含不支持的选项")
        if widget == "date" and isinstance(value, str):
            from datetime import date

            try:
                date.fromisoformat(value)
            except ValueError as exc:
                raise ValueError(f"{field.get('label') or name} 必须是有效日期") from exc
        if widget == "time" and isinstance(value, str):
            from datetime import time

            try:
                time.fromisoformat(value)
            except ValueError as exc:
                raise ValueError(f"{field.get('label') or name} 必须是有效时间") from exc

    def _create_recipe_from_draft(self, *, family_id: str, user_id: str, payload: dict[str, Any]) -> Recipe:
        recipe_in = CreateRecipeRequest.model_validate(payload)
        recipe = Recipe(
            id=create_id("recipe"),
            family_id=family_id,
            title=recipe_in.title,
            servings=recipe_in.servings,
            prep_minutes=recipe_in.prep_minutes,
            difficulty=recipe_in.difficulty,
            tips=recipe_in.tips,
            scene_tags=list(dict.fromkeys(tag.strip() for tag in recipe_in.scene_tags if tag.strip())),
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(recipe)
        self.db.flush()
        for index, item in enumerate(recipe_in.ingredient_items):
            self.db.add(
                RecipeIngredient(
                    id=create_id("recipe-ingredient"),
                    recipe_id=recipe.id,
                    ingredient_id=item.ingredient_id,
                    ingredient_name=item.ingredient_name,
                    quantity=Decimal(str(item.quantity)),
                    unit=item.unit,
                    note=item.note,
                    sort_order=index,
                )
            )
        for index, step in enumerate([value for value in recipe_in.steps if value.text.strip()]):
            self.db.add(
                RecipeStep(
                    id=create_id("step"),
                    recipe_id=recipe.id,
                    title=step.title.strip() or None,
                    text=step.text.strip(),
                    icon=step.icon.strip() or "pan",
                    summary=step.summary.strip(),
                    estimated_minutes=step.estimated_minutes if step.estimated_minutes and step.estimated_minutes > 0 else None,
                    tip=step.tip.strip(),
                    key_points=[item.strip() for item in step.key_points if item.strip()],
                    sort_order=index,
                )
            )
        bind_media_assets(self.db, family_id=family_id, media_ids=recipe_in.media_ids, entity_type="recipe", entity_id=recipe.id)
        log_activity(
            self.db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="Recipe",
            entity_id=recipe.id,
            summary=f"AI 创建菜谱 {recipe.title}",
        )
        food, _ = ensure_food_for_recipe(
            self.db,
            family_id=family_id,
            user_id=user_id,
            recipe=recipe,
            recipe_media_ids=recipe_in.media_ids,
            sync_media=True,
        )
        log_activity(
            self.db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="Food",
            entity_id=food.id,
            summary=f"AI 自动创建家常菜 {food.name}",
        )
        self.db.flush()
        recipe = self.db.scalar(
            select(Recipe)
            .where(Recipe.id == recipe.id)
            .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
        )
        assert recipe is not None
        return recipe

    def _sync_message_approval_parts(self, draft: AITaskDraft, approval: AIApprovalRequest) -> None:
        if not approval.message_id:
            return
        message = self.db.get(AIMessage, approval.message_id)
        if message is None:
            return
        draft_record = jsonable_encoder(serialize_ai_task_draft(draft))
        approval_record = jsonable_encoder(serialize_ai_approval_request(approval))
        next_parts: list[dict[str, Any]] = []
        for part in message.parts:
            if part.get("type") == "draft" and part.get("draft", {}).get("id") == draft.id:
                next_parts.append({**part, "draft": draft_record})
            elif part.get("type") == "approval_request" and part.get("approval", {}).get("id") == approval.id:
                next_parts.append({**part, "approval": approval_record})
            else:
                next_parts.append(part)
        message.parts = next_parts

    def _append_message_approval_part(self, approval: AIApprovalRequest) -> None:
        if not approval.message_id:
            return
        message = self.db.get(AIMessage, approval.message_id)
        if message is None:
            return
        if any(part.get("approval", {}).get("id") == approval.id for part in message.parts):
            return
        message.parts = [
            *message.parts,
            {
                "id": create_id("ai_part"),
                "type": "approval_request",
                "approval": jsonable_encoder(serialize_ai_approval_request(approval)),
            },
        ]

    def _add_event(
        self,
        family_id: str,
        conversation_id: str,
        run_id: str,
        event_type: str,
        internal_code: str,
        user_message: str,
        status: str,
    ) -> AIRunEvent:
        event = AIRunEvent(
            id=create_id("ai_run_event"),
            family_id=family_id,
            conversation_id=conversation_id,
            run_id=run_id,
            type=event_type,
            internal_code=internal_code,
            user_message=user_message,
            status="failed" if status == "failed" else "completed",
            payload={},
        )
        self.db.add(event)
        self.db.flush()
        return event
