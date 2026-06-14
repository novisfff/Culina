from __future__ import annotations

from collections import Counter
from collections.abc import Iterator
from datetime import date
from decimal import Decimal
import logging
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
from pydantic import ValidationError

from app.ai.kitchen.context import load_agent_context
from app.ai.kitchen.recipe_drafts import (
    RECIPE_DRAFT_JSON_SCHEMA,
    RecipeDraftGenerationInput,
    build_recipe_draft_messages,
    build_recipe_image_render_payload,
    normalize_recipe_draft,
)
from app.ai.runtime.provider import BaseChatProvider, get_chat_provider
from app.ai.errors import AIConflictError
from app.ai.skills import build_workspace_skill_registry
from app.ai.tools.draft_validation import (
    normalize_food_profile_draft_for_tools,
    normalize_inventory_operation_draft,
    normalize_meal_log_draft,
    normalize_meal_plan_draft,
    normalize_recipe_draft_for_tools,
    normalize_shopping_list_draft,
)
from app.ai.tools.catalog.common import entity_media_map
from app.ai.tools.catalog.inventory import inventory_record
from app.core.enums import ActivityAction, AiMode, InventoryStatus, MealType
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
    Food,
    FoodPlanItem,
    Ingredient,
    InventoryItem,
    MealLog,
    MealLogFood,
    Recipe,
    RecipeIngredient,
    RecipeStep,
    ShoppingListItem,
)
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.recipes import CreateRecipeRequest
from app.schemas.foods import CreateFoodRequest
from app.schemas.meal_logs import CreateMealLogRequest
from app.schemas.shopping import CreateShoppingListItemRequest
from app.services.activity import log_activity
from app.services.clock import today_for_family
from app.services.inventory_operations import (
    consume_ingredient_inventory,
    create_inventory_batch,
    dispose_inventory_quantity,
    require_ingredient,
    require_inventory_item,
)
from app.services.media import bind_media_assets
from app.services.recipe_food_sync import ensure_food_for_recipe
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_message,
    serialize_ai_operation,
    serialize_ai_run,
    serialize_ai_run_event,
    serialize_ai_task_draft,
    serialize_food,
    serialize_food_plan_item,
    serialize_meal_log,
    serialize_inventory_item,
    serialize_recipe,
    serialize_shopping_item,
)

logger = logging.getLogger(__name__)


ACTIVE_CONVERSATION_RUN_STATUSES = {"pending", "running"}


DRAFT_APPROVAL_CONFIG: dict[str, dict[str, str]] = {
    "recipe": {
        "value_key": "recipe",
        "widget": "recipe_draft_editor",
        "approval_type": "recipe.create",
        "operation_type": "recipe.create",
        "business_entity_type": "Recipe",
        "title": "确认创建菜谱",
        "instruction": "确认后会创建菜谱，并自动同步一个家常菜食物资料。",
        "approve_label": "创建菜谱",
        "reject_label": "暂不创建",
    },
    "shopping_list": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "shopping_list.create",
        "operation_type": "shopping_list.create",
        "business_entity_type": "ShoppingListItem",
        "title": "确认创建购物清单",
        "instruction": "确认后会把这些项目加入购物清单。",
        "approve_label": "加入购物清单",
        "reject_label": "暂不加入",
    },
    "meal_plan": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "meal_plan.create",
        "operation_type": "meal_plan.create",
        "business_entity_type": "FoodPlanItem",
        "title": "确认创建餐食计划",
        "instruction": "确认后会把计划项写入菜单计划。未关联食物的条目会先创建可编辑的食物资料。",
        "approve_label": "写入菜单计划",
        "reject_label": "暂不写入",
    },
    "meal_log": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "meal_log.create",
        "operation_type": "meal_log.create",
        "business_entity_type": "MealLog",
        "title": "确认创建餐食记录",
        "instruction": "确认后会创建餐食记录。未关联食物的条目会先创建可编辑的食物资料。",
        "approve_label": "记录餐食",
        "reject_label": "暂不记录",
    },
    "food_profile": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "food_profile.create",
        "operation_type": "food_profile.create",
        "business_entity_type": "Food",
        "title": "确认创建食物资料",
        "instruction": "确认后会把这份资料写入食物库。",
        "approve_label": "创建食物",
        "reject_label": "暂不创建",
    },
    "inventory_operation": {
        "value_key": "draft",
        "widget": "textarea",
        "approval_type": "inventory.operation",
        "operation_type": "inventory.operation",
        "business_entity_type": "InventoryItem",
        "title": "确认处理库存",
        "instruction": "请核对食材、批次和数量。确认后会正式修改家庭库存。",
        "approve_label": "确认处理库存",
        "reject_label": "暂不处理",
    },
}


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
        value = dict(subject or {})
        recipe_id = value.get("recipe_id") or value.get("recipeId")
        food_id = value.get("food_id") or value.get("foodId")
        ingredient_ids = value.get("ingredient_ids") or value.get("ingredientIds") or []

        if recipe_id:
            matched_recipe_id = self.db.scalar(
                select(Recipe.id).where(Recipe.id == str(recipe_id), Recipe.family_id == family_id)
            )
            if matched_recipe_id is None:
                raise ValueError("引用的菜谱不属于当前家庭或不存在")
            value["recipe_id"] = str(recipe_id)
        if food_id:
            matched_food_id = self.db.scalar(
                select(Food.id).where(Food.id == str(food_id), Food.family_id == family_id)
            )
            if matched_food_id is None:
                raise ValueError("引用的食物不属于当前家庭或不存在")
            value["food_id"] = str(food_id)
        if not isinstance(ingredient_ids, list):
            raise ValueError("引用的食材列表格式不正确")
        normalized_ingredient_ids = list(dict.fromkeys(str(item) for item in ingredient_ids if str(item)))
        if normalized_ingredient_ids:
            matched_ids = set(
                self.db.scalars(
                    select(Ingredient.id).where(
                        Ingredient.family_id == family_id,
                        Ingredient.id.in_(normalized_ingredient_ids),
                    )
                )
            )
            if matched_ids != set(normalized_ingredient_ids):
                raise ValueError("引用的食材不属于当前家庭或不存在")
            value["ingredient_ids"] = normalized_ingredient_ids
        return value

    def find_idempotent_run(
        self,
        *,
        family_id: str,
        client_message_id: str | None,
        client_run_id: str | None,
    ) -> AIAgentRun | None:
        candidates: list[AIAgentRun] = []
        if client_run_id:
            run = self.db.get(AIAgentRun, client_run_id)
            if run is not None:
                if run.family_id != family_id:
                    raise AIConflictError("运行标识已被占用")
                candidates.append(run)
        if client_message_id:
            message = self.db.scalar(
                select(AIMessage).where(
                    AIMessage.family_id == family_id,
                    AIMessage.role == "user",
                    AIMessage.client_message_id == client_message_id,
                )
            )
            if message is not None:
                run = self.db.scalar(
                    select(AIAgentRun).where(
                        AIAgentRun.family_id == family_id,
                        AIAgentRun.message_id == message.id,
                    )
                )
                if run is not None:
                    candidates.append(run)
        if not candidates:
            return None
        if len({item.id for item in candidates}) != 1:
            raise AIConflictError("消息标识与运行标识指向不同任务")
        return candidates[0]

    def find_active_conversation_run(self, *, family_id: str, conversation_id: str) -> AIAgentRun | None:
        return self.db.scalar(
            select(AIAgentRun)
            .where(
                AIAgentRun.family_id == family_id,
                AIAgentRun.conversation_id == conversation_id,
                AIAgentRun.status.in_(ACTIVE_CONVERSATION_RUN_STATUSES),
            )
            .order_by(AIAgentRun.created_at.asc(), AIAgentRun.id.asc())
        )

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

    def _normalize_result_cards(self, cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
        default_titles = {
            "today_recommendation": "今日吃什么",
            "recipe_draft": "菜谱草稿",
            "approval_request": "确认请求",
            "error_recovery": "这次没有生成成功",
            "inventory_summary": "库存概览",
            "meal_plan_draft": "餐食计划草稿",
            "shopping_list_draft": "购物清单草稿",
            "meal_log_draft": "餐食记录草稿",
            "food_profile_draft": "食物资料草稿",
        }
        normalized: list[dict[str, Any]] = []
        for card in cards:
            if not isinstance(card, dict):
                continue
            next_card = dict(card)
            card_type = str(next_card.get("type") or "inventory_summary")
            if not isinstance(next_card.get("id"), str) or not next_card["id"].strip():
                next_card["id"] = create_id("ai_card")
            if not isinstance(next_card.get("title"), str) or not next_card["title"].strip():
                next_card["title"] = default_titles.get(card_type, "AI 结果")
            if not isinstance(next_card.get("data"), dict):
                next_card["data"] = {}
            normalized.append(next_card)
        return normalized

    def _build_planner_conversation(
        self,
        *,
        family_id: str,
        conversation_id: str,
        quick_task: str | None = None,
        pending_user_message: str | None = None,
        limit: int = 12,
    ) -> list[dict[str, Any]]:
        recent = list(
            self.db.scalars(
                select(AIMessage)
                .where(
                    AIMessage.family_id == family_id,
                    AIMessage.conversation_id == conversation_id,
                )
                .order_by(AIMessage.created_at.desc())
                .limit(limit)
            )
        )
        pending_drafts = list(
            self.db.scalars(
                select(AITaskDraft).where(
                    AITaskDraft.family_id == family_id,
                    AITaskDraft.conversation_id == conversation_id,
                    AITaskDraft.status == "pending",
                )
            )
        )
        message_ids = {message.id for message in recent}
        required_message_ids = {draft.message_id for draft in pending_drafts if draft.message_id and draft.message_id not in message_ids}
        if required_message_ids:
            recent.extend(
                self.db.scalars(
                    select(AIMessage).where(
                        AIMessage.family_id == family_id,
                        AIMessage.conversation_id == conversation_id,
                        AIMessage.id.in_(required_message_ids),
                    )
                )
            )
        all_message_ids = {message.id for message in recent}
        drafts = list(
            self.db.scalars(
                select(AITaskDraft).where(
                    AITaskDraft.family_id == family_id,
                    AITaskDraft.conversation_id == conversation_id,
                    AITaskDraft.message_id.in_(all_message_ids),
                )
            )
        ) if all_message_ids else []
        drafts_by_message: dict[str, list[AITaskDraft]] = {}
        for draft in drafts:
            if draft.message_id:
                drafts_by_message.setdefault(draft.message_id, []).append(draft)
        timeline = []
        for message in sorted(recent, key=lambda item: (item.created_at.timestamp(), item.id)):
            metadata = dict(message.message_metadata or {})
            if quick_task and message.role == "user" and message is recent[0]:
                metadata["quickTask"] = quick_task
            timeline.append(
                {
                    "id": message.id,
                    "role": message.role,
                    "content": message.content,
                    "metadata": metadata,
                    "artifacts": [
                        {
                            "id": draft.id,
                            "type": draft.draft_type,
                            "version": draft.version,
                            "status": draft.status,
                            "payload": draft.payload,
                        }
                        for draft in sorted(drafts_by_message.get(message.id, []), key=lambda item: item.created_at)
                    ],
                }
            )
        if pending_user_message:
            timeline.append(
                {
                    "id": "pending-user-message",
                    "role": "user",
                    "content": pending_user_message,
                    "metadata": {"quickTask": quick_task},
                    "artifacts": [],
                }
            )
        return timeline

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
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.id == message_id, AIMessage.family_id == family_id)
            .with_for_update()
        )
        if message is None:
            raise LookupError("AI 消息不存在")
        plan_item = self.db.scalar(
            select(FoodPlanItem)
            .where(FoodPlanItem.id == food_plan_item_id, FoodPlanItem.family_id == family_id)
            .with_for_update()
        )
        if plan_item is None:
            raise LookupError("菜单计划不存在")

        selected_name = ""
        next_parts: list[dict[str, Any]] = []
        matched = False
        for part in message.parts or []:
            if part.get("id") != part_id or not isinstance(part.get("card"), dict):
                next_parts.append(part)
                continue
            card = dict(part["card"])
            effective_card_id = card.get("id") if isinstance(card.get("id"), str) and card["id"].strip() else f"{part_id}-card"
            if effective_card_id != card_id or card.get("type") != "today_recommendation":
                next_parts.append(part)
                continue
            card["id"] = effective_card_id
            if not isinstance(card.get("title"), str) or not card["title"].strip():
                card["title"] = "今日吃什么"
            data = dict(card.get("data") or {})
            recommendations = []
            for item in data.get("recommendations") or []:
                if not isinstance(item, dict) or str(item.get("entityId") or "") != entity_id:
                    recommendations.append(item)
                    continue
                if str(item.get("foodId") or "") != plan_item.food_id:
                    raise ValueError("推荐食物与菜单计划不一致")
                selected_name = str(item.get("name") or (plan_item.food.name if plan_item.food else "推荐食物"))
                recommendations.append(
                    {
                        **item,
                        "planSelection": {
                            "foodPlanItemId": plan_item.id,
                            "foodId": plan_item.food_id,
                            "name": selected_name,
                            "planDate": plan_item.plan_date.isoformat(),
                            "mealType": plan_item.meal_type.value if hasattr(plan_item.meal_type, "value") else str(plan_item.meal_type),
                            "selectedAt": utcnow().isoformat(),
                            "selectedBy": user_id,
                        },
                    }
                )
                matched = True
            data["recommendations"] = recommendations
            next_parts.append({**part, "card": {**card, "data": data}})
        if not matched:
            raise ValueError("推荐卡片中没有找到对应食物")

        selection = {
            "messageId": message.id,
            "cardId": card_id,
            "entityId": entity_id,
            "foodPlanItemId": plan_item.id,
            "foodId": plan_item.food_id,
            "name": selected_name,
            "planDate": plan_item.plan_date.isoformat(),
            "mealType": plan_item.meal_type.value if hasattr(plan_item.meal_type, "value") else str(plan_item.meal_type),
        }
        metadata = dict(message.message_metadata or {})
        existing_selections = [
            item
            for item in metadata.get("recommendationSelections") or []
            if isinstance(item, dict) and item.get("foodPlanItemId") != plan_item.id
        ]
        metadata["recommendationSelections"] = [*existing_selections, selection]
        message.parts = next_parts
        message.message_metadata = metadata

        conversation = self._require_conversation(family_id=family_id, conversation_id=message.conversation_id)
        context = dict(conversation.context or {})
        context_selections = [
            item
            for item in context.get("recommendationSelections") or []
            if isinstance(item, dict) and item.get("foodPlanItemId") != plan_item.id
        ]
        context["recommendationSelections"] = [*context_selections[-9:], selection]
        conversation.context = context
        conversation.last_message_at = utcnow()
        self.db.flush()
        return message

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
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.id == message_id, AIMessage.family_id == family_id)
            .with_for_update()
        )
        if message is None:
            raise LookupError("AI 消息不存在")
        matched_item: dict[str, Any] | None = None
        effective_card_id = ""
        for part in message.parts or []:
            if part.get("id") != part_id or not isinstance(part.get("card"), dict):
                continue
            card = part["card"]
            effective_card_id = (
                str(card.get("id"))
                if isinstance(card.get("id"), str) and str(card.get("id")).strip()
                else f"{part_id}-card"
            )
            if effective_card_id != card_id or card.get("type") != "inventory_summary":
                continue
            for item in (card.get("data") or {}).get("items") or []:
                if isinstance(item, dict) and str(item.get("id") or "") == item_id:
                    matched_item = item
                    break
        if matched_item is None:
            raise ValueError("库存卡片中没有找到对应批次")
        if action not in {"restock", "consume", "dispose"}:
            raise ValueError("不支持的库存操作")

        inventory_item = require_inventory_item(
            self.db,
            family_id=family_id,
            inventory_item_id=item_id,
        )
        available = max(Decimal(str(matched_item.get("quantity") or 0)), Decimal("0"))
        if action != "restock" and available <= 0:
            raise ValueError("该库存批次已无剩余数量")
        quantity = Decimal("1") if action != "dispose" else available
        if action == "consume":
            quantity = min(quantity, available)
        raw_operation: dict[str, Any] = {
            "action": action,
            "ingredientId": inventory_item.ingredient_id,
            "inventoryItemId": inventory_item.id if action != "restock" else None,
            "quantity": float(quantity),
            "unit": str(matched_item.get("unit") or inventory_item.unit),
            "reason": "用户从库存卡发起销毁" if action == "dispose" else "",
        }
        if action == "restock":
            raw_operation.update(
                {
                    "purchaseDate": today_for_family(family_id).isoformat(),
                    "storageLocation": inventory_item.storage_location,
                    "status": (
                        inventory_item.status.value
                        if hasattr(inventory_item.status, "value")
                        else str(inventory_item.status)
                    ),
                    "notes": "",
                    "lowStockThreshold": float(inventory_item.low_stock_threshold or 0),
                }
            )
        draft_payload = {
            "draft_type": "inventory_operation",
            "schema_version": "inventory_operation.v1",
            "payload": {
                "draftType": "inventory_operation",
                "schemaVersion": "inventory_operation.v1",
                "operations": [raw_operation],
                "source": {
                    "messageId": message.id,
                    "partId": part_id,
                    "cardId": effective_card_id,
                    "itemId": item_id,
                    "action": action,
                },
            },
        }
        draft, approval = self._create_draft_approval(
            family_id=family_id,
            user_id=user_id,
            conversation_id=message.conversation_id,
            message_id=message.id,
            run_id=message.run_id,
            draft_payload=draft_payload,
        )
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
        ]
        metadata = dict(message.message_metadata or {})
        metadata["lastInventoryDraft"] = {
            "draftId": draft.id,
            "approvalId": approval.id,
            "action": action,
            "ingredientId": inventory_item.ingredient_id,
            "inventoryItemId": inventory_item.id,
        }
        message.message_metadata = metadata
        self.db.flush()
        return message

    def _agent_key_for_plan(self, skill_registry, plan) -> str:
        if plan.failed:
            return "workspace_planner"
        if not plan.skills:
            return "general_chat_agent"
        if len(plan.skills) == 1:
            return skill_registry.get(plan.skills[0]).manifest.agent_key
        return "workspace_planner"

    def _intent_for_plan(self, skill_registry, plan) -> str:
        if plan.failed:
            return "planner_failed"
        if not plan.skills:
            return "general_chat"
        if len(plan.skills) == 1:
            return skill_registry.get(plan.skills[0]).manifest.intent
        return "multi_skill"

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
        run = self.db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
        if run is None:
            raise LookupError("运行任务不存在")
        if run.status not in {"pending", "running", "waiting_approval"}:
            raise ValueError("运行任务已结束，不能取消")
        pending_approvals = list(
            self.db.scalars(
                select(AIApprovalRequest)
                .where(
                    AIApprovalRequest.family_id == family_id,
                    AIApprovalRequest.run_id == run.id,
                    AIApprovalRequest.status == "pending",
                )
                .order_by(AIApprovalRequest.created_at.asc())
            )
        )
        run.status = "cancelled"
        run.error = "用户取消了这次任务"
        if run.conversation_id:
            conversation = self.db.get(AIConversation, run.conversation_id)
            if conversation is not None:
                conversation.last_run_status = "cancelled"
                conversation.last_message_at = utcnow()
        for approval in pending_approvals:
            approval.status = "cancelled"
            approval.decision = "rejected"
            approval.comment = "用户取消了这次任务"
            approval.resolved_at = utcnow()
            approval.updated_by = user_id
            draft = self.db.scalar(select(AITaskDraft).where(AITaskDraft.id == approval.draft_id, AITaskDraft.family_id == family_id))
            if draft is not None and draft.status in {"pending", "pending_retry"}:
                draft.status = "rejected"
                draft.updated_at = utcnow()
            if draft is not None:
                self._sync_message_approval_parts(draft, approval)
        event = self._add_event(
            family_id,
            run.conversation_id or "",
            run.id,
            "cancel",
            "user_cancel",
            "已取消这次任务",
            "failed",
        )
        self.db.flush()
        return {"run": serialize_ai_run(run), "events": [serialize_ai_run_event(event)]}

    def retry_run(self, *, family_id: str, user_id: str, run_id: str) -> dict[str, Any]:
        run = self.db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
        if run is None:
            raise LookupError("运行任务不存在")
        if run.status not in {"failed", "fallback", "cancelled"}:
            raise ValueError("只有失败、fallback 或已取消的任务可以重试")
        source_input = run.input or {}
        prompt = str(source_input.get("prompt") or run.input_summary or "").strip()
        if not prompt:
            raise ValueError("找不到可重试的原始消息")
        retry_subject = source_input.get("subject") if isinstance(source_input.get("subject"), dict) else {}
        retry_subject = {**retry_subject, "retryOfRunId": run.id}
        return self.chat(
            family_id=family_id,
            user_id=user_id,
            message=prompt,
            conversation_id=run.conversation_id,
            client_message_id=f"retry-{run.id}-{create_id('client')}",
            quick_task=source_input.get("quickTask") if isinstance(source_input.get("quickTask"), str) else None,
            subject=retry_subject,
        )

    def regenerate_part(self, *, family_id: str, user_id: str, message_id: str, part_id: str) -> dict[str, Any]:
        message = self.db.scalar(select(AIMessage).where(AIMessage.id == message_id, AIMessage.family_id == family_id))
        if message is None:
            raise LookupError("消息不存在")
        if message.role != "assistant" or not message.run_id:
            raise ValueError("只能重新生成 AI 回复里的局部内容")
        part = next((item for item in message.parts or [] if item.get("id") == part_id), None)
        if part is None:
            raise LookupError("消息局部不存在")
        run = self.db.scalar(select(AIAgentRun).where(AIAgentRun.id == message.run_id, AIAgentRun.family_id == family_id))
        if run is None:
            raise LookupError("原始运行任务不存在")
        source_input = run.input or {}
        prompt = str(source_input.get("prompt") or run.input_summary or "").strip()
        if not prompt:
            raise ValueError("找不到可局部重生成的原始消息")
        subject = source_input.get("subject") if isinstance(source_input.get("subject"), dict) else {}
        regenerate_subject = {
            **subject,
            "regenerate": {
                "messageId": message.id,
                "partId": part_id,
                "partType": part.get("type"),
                "cardType": part.get("card", {}).get("type") if isinstance(part.get("card"), dict) else None,
            },
        }
        regenerate_prompt = f"{prompt}\n\n请只重新生成上一条回复中需要调整的这一部分，并保持同一个草稿上下文。"
        return self.chat(
            family_id=family_id,
            user_id=user_id,
            message=regenerate_prompt,
            conversation_id=message.conversation_id,
            client_message_id=f"regen-{message.id}-{part_id}-{create_id('client')}",
            quick_task=source_input.get("quickTask") if isinstance(source_input.get("quickTask"), str) else None,
            subject=regenerate_subject,
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
        self._require_conversation(family_id=family_id, conversation_id=conversation_id)
        approval = self.db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            ).with_for_update()
        )
        if approval is None:
            raise LookupError("确认请求不存在")
        draft = self.db.scalar(
            select(AITaskDraft)
            .where(AITaskDraft.id == approval.draft_id, AITaskDraft.family_id == family_id)
            .with_for_update()
        )
        if draft is None:
            raise LookupError("草稿不存在")
        if approval.status != "pending":
            raise AIConflictError("确认请求已处理，不能重复提交")
        if draft.status not in {"pending", "pending_retry"}:
            raise AIConflictError("草稿已处理，不能重复提交")
        if draft_version != draft.version or approval.draft_version != draft.version:
            raise AIConflictError("草稿已更新，请重新确认")
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
            logger.info(
                "AI approval rejected family_id=%s user_id=%s conversation_id=%s approval_id=%s draft_id=%s draft_type=%s",
                family_id,
                user_id,
                conversation_id,
                approval.id,
                draft.id,
                draft.draft_type,
            )
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

        config = DRAFT_APPROVAL_CONFIG.get(draft.draft_type)
        if config is None:
            raise ValueError("暂不支持的草稿类型")
        existing_operation = self.db.scalar(
            select(AIOperation)
            .where(
                AIOperation.approval_request_id == approval.id,
                AIOperation.family_id == family_id,
            )
            .with_for_update()
        )
        if existing_operation is not None:
            raise AIConflictError("该确认请求已经创建过执行操作")
        operation = AIOperation(
            id=create_id("ai_operation"),
            family_id=family_id,
            approval_request_id=approval.id,
            draft_id=draft.id,
            operation_type=config["operation_type"],
            status="running",
            business_entity_type=config["business_entity_type"],
            business_entity_ids=[],
            idempotency_key=f"{approval.id}:{config['operation_type']}:v{draft.version}",
        )
        try:
            with self.db.begin_nested():
                self.db.add(operation)
                self.db.flush()
        except IntegrityError as exc:
            raise AIConflictError("该确认请求已经创建过执行操作") from exc
        decision_approval = approval
        value_key = config["value_key"]
        submitted_payload = submitted_values[value_key]
        try:
            with self.db.begin_nested():
                business_entity, entity_ids = self._execute_draft_operation(
                    family_id=family_id,
                    user_id=user_id,
                    draft_type=draft.draft_type,
                    payload=submitted_payload,
                )
            operation.status = "succeeded"
            operation.business_entity_ids = entity_ids
            operation.completed_at = utcnow()
            draft.status = "confirmed"
            draft.payload = submitted_payload
            draft.updated_by = user_id
            audit.operation_summary = {"operationId": operation.id, "entityIds": entity_ids}
            if draft.draft_type == "inventory_operation":
                self._refresh_inventory_result_card(
                    family_id=family_id,
                    message_id=draft.message_id,
                    result=business_entity,
                    user_id=user_id,
                )
            logger.info(
                "AI approval operation succeeded family_id=%s user_id=%s conversation_id=%s approval_id=%s draft_id=%s draft_type=%s operation_id=%s entity_ids=%s",
                family_id,
                user_id,
                conversation_id,
                approval.id,
                draft.id,
                draft.draft_type,
                operation.id,
                entity_ids,
            )
        except Exception as exc:
            logger.exception(
                "AI approval operation failed family_id=%s user_id=%s conversation_id=%s approval_id=%s draft_id=%s draft_type=%s operation_id=%s",
                family_id,
                user_id,
                conversation_id,
                approval.id,
                draft.id,
                draft.draft_type,
                operation.id,
            )
            operation.status = "failed"
            operation.error_message = str(exc)
            draft.status = "pending_retry"
            draft.payload = submitted_payload
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
                select(AIConversation)
                .where(AIConversation.id == conversation_id, AIConversation.family_id == family_id)
                .with_for_update()
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
        run_id: str | None,
        draft_payload: dict[str, Any],
    ) -> tuple[AITaskDraft, AIApprovalRequest]:
        draft_type = str(draft_payload.get("draft_type") or "")
        config = DRAFT_APPROVAL_CONFIG.get(draft_type)
        if config is None:
            raise ValueError("暂不支持的草稿类型")
        payload = self._validate_draft_payload(
            draft_type=draft_type,
            family_id=family_id,
            conversation_id=conversation_id,
            payload=dict(draft_payload.get("payload") or {}),
        )
        summary = self._draft_preview_summary(draft_type, payload)
        draft = AITaskDraft(
            id=create_id("ai_draft"),
            family_id=family_id,
            conversation_id=conversation_id,
            source_run_id=run_id,
            message_id=message_id,
            draft_type=draft_type,
            payload=payload,
            preview_summary=summary,
            status="pending",
            version=1,
            schema_version=draft_payload.get("schema_version") or f"{draft_type}.v1",
            validation_errors=[],
            idempotency_key=f"{run_id}:{draft_type}:{create_id('idem')}",
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
            approval_type=config["approval_type"],
            status="pending",
            request_payload={
                "title": config["title"],
                "instruction": config["instruction"],
                "approveLabel": config["approve_label"],
                "rejectLabel": config["reject_label"],
                "requireRejectComment": False,
            },
            field_schema=[
                {"name": config["value_key"], "label": "草稿内容", "type": "object", "widget": config["widget"], "required": True}
            ],
            initial_values={config["value_key"]: payload},
            submitted_values={},
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(approval)
        self.db.flush()
        return draft, approval

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
            approval_type=f"{DRAFT_APPROVAL_CONFIG[draft.draft_type]['approval_type']}.retry",
            status="pending",
            request_payload={
                "title": f"重试{DRAFT_APPROVAL_CONFIG[draft.draft_type]['title'].replace('确认', '')}",
                "instruction": f"上次写入失败：{error_message}。你可以调整草稿后重试。",
                "approveLabel": "重试写入",
                "rejectLabel": "放弃草稿",
                "requireRejectComment": False,
            },
            field_schema=[
                {
                    "name": DRAFT_APPROVAL_CONFIG[draft.draft_type]["value_key"],
                    "label": "草稿内容",
                    "type": "object",
                    "widget": DRAFT_APPROVAL_CONFIG[draft.draft_type]["widget"],
                    "required": True,
                }
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
        config = DRAFT_APPROVAL_CONFIG.get(draft.draft_type)
        if config is None:
            raise ValueError("暂不支持的草稿类型")
        value_key = config["value_key"]
        draft_value = values.get(value_key, draft.payload)
        if draft.draft_type == "inventory_operation":
            self._validate_inventory_operation_shape(draft.payload, draft_value)
        return {
            value_key: self._validate_draft_payload(
                draft_type=draft.draft_type,
                family_id=draft.family_id,
                conversation_id=draft.conversation_id,
                payload=draft_value,
            )
        }

    @staticmethod
    def _validate_inventory_operation_shape(original: Any, submitted: Any) -> None:
        if not isinstance(original, dict) or not isinstance(submitted, dict):
            raise ValueError("库存操作草稿格式不正确")
        original_operations = original.get("operations")
        submitted_operations = submitted.get("operations")
        if not isinstance(original_operations, list) or not isinstance(submitted_operations, list):
            raise ValueError("库存操作草稿格式不正确")

        def operation_key(operation: Any) -> tuple[str, str]:
            if not isinstance(operation, dict):
                return ("", "")
            return (
                str(operation.get("ingredientId") or operation.get("ingredient_id") or ""),
                str(operation.get("action") or ""),
            )

        allowed = Counter(operation_key(operation) for operation in original_operations)
        requested = Counter(operation_key(operation) for operation in submitted_operations)
        if any(not ingredient_id or not action for ingredient_id, action in requested):
            raise ValueError("库存操作项格式不正确")
        if any(count > allowed.get(key, 0) for key, count in requested.items()):
            raise ValueError("库存处理对象或处理方式不能在确认阶段修改")

    def _validate_approval_field(self, field: dict[str, Any], values: dict[str, Any], *, enforce_required: bool) -> None:
        name = str(field["name"])
        if enforce_required and field.get("required") and name not in values:
            raise ValueError(f"{field.get('label') or name} 不能为空")
        if name not in values:
            return
        value = values[name]
        if enforce_required and field.get("required") and (value is None or value == "" or value == []):
            raise ValueError(f"{field.get('label') or name} 不能为空")
        if name in {"recipe", "draft"}:
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

    def _validate_draft_payload(self, *, draft_type: str, family_id: str, conversation_id: str, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("草稿内容格式不正确")
        if draft_type == "recipe":
            try:
                recipe = normalize_recipe_draft_for_tools(self.db, family_id=family_id, payload=payload)
            except ValidationError as exc:
                raise ValueError("菜谱草稿字段不完整或格式不正确") from exc
            return recipe
        if draft_type == "shopping_list":
            return normalize_shopping_list_draft(self.db, family_id=family_id, conversation_id=conversation_id, payload=payload)
        if draft_type == "meal_plan":
            return normalize_meal_plan_draft(self.db, family_id=family_id, payload=payload)
        if draft_type == "meal_log":
            return normalize_meal_log_draft(self.db, family_id=family_id, payload=payload)
        if draft_type == "food_profile":
            try:
                return normalize_food_profile_draft_for_tools(self.db, family_id=family_id, payload=payload)
            except ValidationError as exc:
                raise ValueError("食物资料草稿字段不完整或格式不正确") from exc
        if draft_type == "inventory_operation":
            return normalize_inventory_operation_draft(self.db, family_id=family_id, payload=payload)
        raise ValueError("暂不支持的草稿类型")

    def _draft_preview_summary(self, draft_type: str, payload: dict[str, Any]) -> str:
        if draft_type == "recipe":
            return f"{payload['title']} · {len(payload['ingredient_items'])} 个食材 · {len(payload['steps'])} 个步骤"
        if draft_type == "shopping_list":
            return f"{len(payload.get('items') or [])} 个待采购项"
        if draft_type == "meal_plan":
            return f"{len(payload.get('items') or [])} 条计划项"
        if draft_type == "meal_log":
            return f"{payload.get('date')} · {payload.get('mealType')} · {len(payload.get('foods') or [])} 个食物项"
        if draft_type == "food_profile":
            return f"{payload.get('name')} · {payload.get('category')}"
        if draft_type == "inventory_operation":
            operations = payload.get("operations") or []
            labels = {"restock": "入库", "consume": "消耗", "dispose": "销毁"}
            counts: dict[str, int] = {}
            for operation in operations:
                action = labels.get(str(operation.get("action") or ""), "处理")
                counts[action] = counts.get(action, 0) + 1
            detail = " · ".join(f"{label} {count} 项" for label, count in counts.items())
            return f"{len(operations)} 项库存处理" + (f" · {detail}" if detail else "")
        return "AI 草稿"

    def _execute_draft_operation(self, *, family_id: str, user_id: str, draft_type: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        if draft_type == "recipe":
            recipe = self._create_recipe_from_draft(family_id=family_id, user_id=user_id, payload=payload)
            media_map = build_media_map(get_media_assets_for_entities(self.db, family_id=family_id, entity_type="recipe", entity_ids=[recipe.id]))
            return serialize_recipe(recipe, media_map), [recipe.id]
        if draft_type == "shopping_list":
            return self._create_shopping_items_from_draft(family_id=family_id, user_id=user_id, payload=payload)
        if draft_type == "meal_plan":
            return self._create_meal_plan_from_draft(family_id=family_id, user_id=user_id, payload=payload)
        if draft_type == "meal_log":
            return self._create_meal_log_from_draft(family_id=family_id, user_id=user_id, payload=payload)
        if draft_type == "food_profile":
            food = self._create_food_from_profile(family_id=family_id, user_id=user_id, payload=payload)
            media_map = build_media_map(get_media_assets_for_entities(self.db, family_id=family_id, entity_type="food", entity_ids=[food.id]))
            return serialize_food(food, media_map), [food.id]
        if draft_type == "inventory_operation":
            return self._execute_inventory_operations(
                family_id=family_id,
                user_id=user_id,
                payload=payload,
            )
        raise ValueError("暂不支持的草稿类型")

    def _execute_inventory_operations(
        self,
        *,
        family_id: str,
        user_id: str,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], list[str]]:
        results: list[dict[str, Any]] = []
        entity_ids: list[str] = []
        today = today_for_family(family_id)
        for operation in payload.get("operations") or []:
            action = str(operation["action"])
            ingredient = require_ingredient(
                self.db,
                family_id=family_id,
                ingredient_id=str(operation["ingredientId"]),
            )
            if action == "restock":
                item = create_inventory_batch(
                    self.db,
                    family_id=family_id,
                    user_id=user_id,
                    ingredient=ingredient,
                    quantity=Decimal(str(operation["quantity"])),
                    unit=str(operation["unit"]),
                    status=InventoryStatus(str(operation["status"])),
                    purchase_date=date.fromisoformat(str(operation["purchaseDate"])),
                    expiry_date=date.fromisoformat(str(operation["expiryDate"])) if operation.get("expiryDate") else None,
                    storage_location=str(operation["storageLocation"]),
                    notes=str(operation.get("notes") or ""),
                    low_stock_threshold=(
                        Decimal(str(operation["lowStockThreshold"]))
                        if operation.get("lowStockThreshold") is not None
                        else None
                    ),
                )
                result = {
                    "operation": "restock",
                    "ingredient_id": ingredient.id,
                    "ingredient_name": ingredient.name,
                    "inventory_item_id": item.id,
                    "quantity": float(operation["quantity"]),
                    "unit": str(operation["unit"]),
                    "inventory_item": serialize_inventory_item(item),
                }
                entity_ids.append(item.id)
            elif action == "consume":
                result = consume_ingredient_inventory(
                    self.db,
                    family_id=family_id,
                    user_id=user_id,
                    ingredient=ingredient,
                    quantity=Decimal(str(operation["quantity"])),
                    unit=str(operation["unit"]),
                    today=today,
                    inventory_item_id=operation.get("inventoryItemId"),
                )
                entity_ids.extend(result["affected_item_ids"])
            elif action == "dispose":
                item = require_inventory_item(
                    self.db,
                    family_id=family_id,
                    inventory_item_id=str(operation["inventoryItemId"]),
                    for_update=True,
                )
                result = dispose_inventory_quantity(
                    self.db,
                    family_id=family_id,
                    user_id=user_id,
                    item=item,
                    quantity=Decimal(str(operation["quantity"])),
                    unit=str(operation["unit"]),
                    reason=str(operation["reason"]),
                )
                entity_ids.append(item.id)
            else:
                raise ValueError("不支持的库存操作")
            results.append(result)
        return {"operations": results}, list(dict.fromkeys(entity_ids))

    def _refresh_inventory_result_card(
        self,
        *,
        family_id: str,
        message_id: str | None,
        result: dict[str, Any] | None,
        user_id: str,
    ) -> None:
        if not message_id or not result:
            return
        message = self.db.scalar(
            select(AIMessage)
            .where(AIMessage.id == message_id, AIMessage.family_id == family_id)
            .with_for_update()
        )
        if message is None:
            return
        operations = [item for item in result.get("operations") or [] if isinstance(item, dict)]
        inventory_ids = list(
            dict.fromkeys(
                str(item_id)
                for operation in operations
                for item_id in [
                    operation.get("inventory_item_id"),
                    *(operation.get("affected_item_ids") or []),
                ]
                if item_id
            )
        )
        rows = list(
            self.db.scalars(
                select(InventoryItem)
                .where(InventoryItem.family_id == family_id, InventoryItem.id.in_(inventory_ids))
                .options(selectinload(InventoryItem.ingredient))
            )
        )
        media_map = entity_media_map(
            self.db,
            family_id=family_id,
            entity_types={"ingredient"},
            entity_ids=[item.ingredient_id for item in rows],
        )
        today = today_for_family(family_id)
        records = {item.id: inventory_record(item, media_map, today=today) for item in rows}
        operation_by_item: dict[str, dict[str, Any]] = {}
        for operation in operations:
            for item_id in [operation.get("inventory_item_id"), *(operation.get("affected_item_ids") or [])]:
                if item_id:
                    operation_by_item[str(item_id)] = {
                        "action": operation.get("operation"),
                        "quantity": operation.get("quantity"),
                        "unit": operation.get("unit"),
                        "reason": operation.get("reason"),
                        "handledAt": utcnow().isoformat(),
                        "handledBy": user_id,
                    }

        next_parts: list[dict[str, Any]] = []
        for part in message.parts or []:
            card = part.get("card")
            if not isinstance(card, dict) or card.get("type") != "inventory_summary":
                next_parts.append(part)
                continue
            card_data = dict(card.get("data") or {})
            current_items = [item for item in card_data.get("items") or [] if isinstance(item, dict)]
            current_ids = {str(item.get("id") or "") for item in current_items}
            refreshed_items = []
            for item in current_items:
                item_id = str(item.get("id") or "")
                refreshed = records.get(item_id)
                if refreshed is None:
                    refreshed_items.append(item)
                    continue
                refreshed_items.append(
                    {
                        **refreshed,
                        "lastOperation": operation_by_item.get(item_id),
                    }
                )
            for item_id, record in records.items():
                if item_id not in current_ids and len(refreshed_items) < 6:
                    refreshed_items.append(
                        {
                            **record,
                            "lastOperation": operation_by_item.get(item_id),
                        }
                    )
            card_data["items"] = refreshed_items
            next_parts.append({**part, "card": {**card, "data": card_data}})
        message.parts = next_parts
        metadata = dict(message.message_metadata or {})
        metadata["lastInventoryOperations"] = operations
        message.message_metadata = metadata

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

    def _create_shopping_items_from_draft(self, *, family_id: str, user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        created: list[ShoppingListItem] = []
        for item_payload in payload.get("items") or []:
            item_in = CreateShoppingListItemRequest.model_validate(item_payload)
            item = ShoppingListItem(
                id=create_id("shopping"),
                family_id=family_id,
                title=item_in.title,
                quantity=Decimal(str(item_in.quantity)),
                unit=item_in.unit,
                reason=item_in.reason,
                done=False,
                created_by=user_id,
                updated_by=user_id,
            )
            self.db.add(item)
            created.append(item)
        self.db.flush()
        for item in created:
            log_activity(
                self.db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.CREATE,
                entity_type="ShoppingListItem",
                entity_id=item.id,
                summary=f"AI 加入购物清单 {item.title}",
            )
        return {"items": [serialize_shopping_item(item) for item in created]}, [item.id for item in created]

    def _create_meal_plan_from_draft(self, *, family_id: str, user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        created: list[FoodPlanItem] = []
        for item_payload in payload.get("items") or []:
            food_id = item_payload.get("foodId")
            if not food_id:
                raise ValueError("餐食计划草稿必须引用食物库里的食物")
            food = self.db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id))
            if food is None:
                raise ValueError("草稿包含不属于当前家庭的食物")
            item = FoodPlanItem(
                id=create_id("food-plan"),
                family_id=family_id,
                user_id=user_id,
                food_id=food.id,
                plan_date=date.fromisoformat(str(item_payload["date"])),
                meal_type=MealType(str(item_payload["mealType"])),
                note=str(item_payload.get("reason") or ""),
                created_by=user_id,
                updated_by=user_id,
            )
            item.food = food
            self.db.add(item)
            created.append(item)
        self.db.flush()
        for item in created:
            log_activity(
                self.db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.CREATE,
                entity_type="FoodPlanItem",
                entity_id=item.id,
                summary=f"AI 加入菜单计划 {item.food.name if item.food else '食物'}",
            )
        return {"items": [serialize_food_plan_item(item) for item in created]}, [item.id for item in created]

    def _create_meal_log_from_draft(self, *, family_id: str, user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        food_entries = []
        for item in payload.get("foods") or []:
            food_id = item.get("foodId")
            if not food_id:
                raise ValueError("餐食记录草稿必须引用食物库里的食物")
            food = self.db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id))
            if food is None:
                raise ValueError("草稿包含不属于当前家庭的食物")
            food_entries.append((food, item))
        request = CreateMealLogRequest.model_validate(
            {
                "date": payload["date"],
                "meal_type": payload["mealType"],
                "food_entries": [
                    {"food_id": food.id, "servings": item.get("servings") or 1, "note": item.get("note") or ""}
                    for food, item in food_entries
                ],
                "participant_user_ids": [user_id],
                "notes": payload.get("notes") or "",
                "mood": "",
                "media_ids": [],
            }
        )
        meal_log = MealLog(
            id=create_id("meal"),
            family_id=family_id,
            date=request.date,
            meal_type=request.meal_type,
            participant_user_ids=request.participant_user_ids,
            notes=request.notes,
            mood=request.mood,
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(meal_log)
        self.db.flush()
        for entry_payload in request.food_entries:
            self.db.add(
                MealLogFood(
                    id=create_id("meal-food"),
                    meal_log_id=meal_log.id,
                    food_id=entry_payload.food_id,
                    servings=Decimal(str(entry_payload.servings)),
                    note=entry_payload.note,
                    rating=Decimal(str(entry_payload.rating)) if entry_payload.rating is not None else None,
                )
            )
        self.db.flush()
        log_activity(
            self.db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="MealLog",
            entity_id=meal_log.id,
            summary="AI 创建餐食记录",
        )
        meal_log = self.db.scalar(select(MealLog).where(MealLog.id == meal_log.id).options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food)))
        assert meal_log is not None
        media_map = build_media_map(get_media_assets_for_entities(self.db, family_id=family_id, entity_type="meal_log", entity_ids=[meal_log.id]))
        return serialize_meal_log(meal_log, media_map), [meal_log.id]

    def _create_food_from_profile(self, *, family_id: str, user_id: str, payload: dict[str, Any]) -> Food:
        food_in = CreateFoodRequest.model_validate(payload)
        food = Food(
            id=create_id("food"),
            family_id=family_id,
            name=food_in.name,
            type=food_in.type,
            category=food_in.category,
            flavor_tags=list(food_in.flavor_tags),
            scene_tags=list(food_in.scene_tags),
            suitable_meal_types=[item.value if hasattr(item, "value") else str(item) for item in food_in.suitable_meal_types],
            source_name=food_in.source_name,
            purchase_source=food_in.purchase_source,
            scene=food_in.scene,
            notes=food_in.notes,
            routine_note=food_in.routine_note,
            price=Decimal(str(food_in.price)) if food_in.price is not None else None,
            rating=food_in.rating,
            repurchase=food_in.repurchase,
            expiry_date=food_in.expiry_date,
            stock_quantity=Decimal(str(food_in.stock_quantity)) if food_in.stock_quantity is not None else None,
            stock_unit=food_in.stock_unit,
            favorite=food_in.favorite,
            recipe_id=food_in.recipe_id,
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(food)
        self.db.flush()
        bind_media_assets(self.db, family_id=family_id, media_ids=food_in.media_ids, entity_type="food", entity_id=food.id)
        log_activity(
            self.db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="Food",
            entity_id=food.id,
            summary=f"AI 创建食物资料 {food.name}",
        )
        return food

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
