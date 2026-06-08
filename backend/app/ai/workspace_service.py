from __future__ import annotations

from datetime import date
from decimal import Decimal
from time import perf_counter
from collections.abc import Iterator
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from pydantic import ValidationError

from app.ai.planning import PlannerRequest, WorkspacePlanner
from app.ai.runtime.provider import BaseChatProvider
from app.ai.runtime.runner import get_chat_provider
from app.ai.skills import SkillContext, SkillExecutionResult, SkillExecutor, build_workspace_skill_registry
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.core.enums import ActivityAction, AiMode, FoodType, MealType
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
    serialize_recipe,
    serialize_shopping_item,
)


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
}


class AIApplicationService:
    def __init__(self, db: Session, provider: BaseChatProvider | None = None) -> None:
        self.db = db
        self.provider = provider if provider is not None else get_chat_provider()
        self._preplanned_result = None

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
        planner_conversation = self._build_planner_conversation(
            family_id=family_id,
            conversation_id=conversation.id,
            quick_task=quick_task,
        )

        run = AIAgentRun(
            id=client_run_id or create_id("agent_run"),
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
            input={"prompt": prompt, "quickTask": quick_task, "conversation": planner_conversation},
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
        skill_registry = build_workspace_skill_registry()
        plan = self._preplanned_result
        self._preplanned_result = None
        if plan is None:
            planner = WorkspacePlanner(provider=self.provider, skill_registry=skill_registry)
            plan = planner.plan(
                PlannerRequest(
                    family_id=family_id,
                    user_id=user_id,
                    conversation_id=conversation.id,
                    conversation=planner_conversation,
                    available_skills=[manifest.to_planner_record() for manifest in skill_registry.list_manifests()],
                )
            )
        if not plan.failed and not plan.skills:
            output = self._run_general_chat(prompt)
        else:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=self.db,
                    family_id=family_id,
                    user_id=user_id,
                    conversation_id=conversation.id,
                    run_id=run.id,
                ),
            )
            output = SkillExecutor(skill_registry).run(
                plan,
                SkillContext(
                    db=self.db,
                    family_id=family_id,
                    user_id=user_id,
                    conversation_id=conversation.id,
                    run_id=run.id,
                    conversation=planner_conversation,
                    current_message=prompt,
                    tool_executor=tool_executor,
                    provider=self.provider,
                ),
            )
        events.append(self._add_event(family_id, conversation.id, run.id, "agent", "run_agent", "正在生成可操作建议", output.status))
        for index, skill_event in enumerate(output.events):
            if not isinstance(skill_event, dict):
                continue
            message = str(skill_event.get("message") or "").strip()
            if not message:
                continue
            events.append(
                self._add_event(
                    family_id,
                    conversation.id,
                    run.id,
                    str(skill_event.get("type") or "skill"),
                    str(skill_event.get("internal_code") or f"skill_step_{index + 1}"),
                    message,
                    str(skill_event.get("status") or "completed"),
                )
            )

        cards = self._normalize_result_cards(output.cards)
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
            message_metadata={"intent": self._intent_for_plan(skill_registry, plan), "agentKey": self._agent_key_for_plan(skill_registry, plan)},
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

        run.agent_key = self._agent_key_for_plan(skill_registry, plan)
        run.intent = self._intent_for_plan(skill_registry, plan)
        run.status = output.status
        run.model = output.model or run.model
        run.context_summary = {
            **output.context_summary,
            "routing": {
                "intent": run.intent,
                "agentKey": run.agent_key,
                "skills": plan.skills,
                "plannerAttempts": plan.attempts,
                "plannerRawResponse": plan.raw_response,
                "plannerError": plan.error,
                "plannerDiagnostic": plan.diagnostic,
                "plannerStructuredMode": plan.structured_mode,
            },
        }
        run.output_summary = output.text[:255]
        run.output = {"text": output.text, "cards": cards, "routing": run.context_summary.get("routing", {})}
        run.tool_calls = output.tool_calls
        run.error = output.error
        run.duration_ms = int((perf_counter() - started_at) * 1000)

        conversation.prompt = prompt
        conversation.response = output.text
        conversation.summary = output.text[:255]
        conversation.last_message_at = utcnow()
        conversation.last_run_status = output.status
        if output.state_patch:
            context = dict(conversation.context or {})
            task_state = dict(context.get("taskState") or {})
            task_state.update(output.state_patch)
            context["taskState"] = task_state
            conversation.context = context

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

    def stream_fallback_chat(
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
    ) -> Iterator[tuple[str, dict[str, Any]]] | None:
        prompt = message.strip()
        if not prompt:
            raise ValueError("消息不能为空")

        planner_conversation = (
            self._build_planner_conversation(
                family_id=family_id,
                conversation_id=conversation_id,
                quick_task=quick_task,
                pending_user_message=prompt,
            )
            if conversation_id
            else [
                {
                    "id": "pending-user-message",
                    "role": "user",
                    "content": prompt,
                    "metadata": {"quickTask": quick_task},
                    "artifacts": [],
                }
            ]
        )
        skill_registry = build_workspace_skill_registry()
        planner = WorkspacePlanner(provider=self.provider, skill_registry=skill_registry)
        plan = planner.plan(
            PlannerRequest(
                family_id=family_id,
                user_id=user_id,
                conversation_id=conversation_id,
                conversation=planner_conversation,
                available_skills=[manifest.to_planner_record() for manifest in skill_registry.list_manifests()],
            )
        )
        if plan.failed or plan.skills:
            self._preplanned_result = plan
            return None

        def generate() -> Iterator[tuple[str, dict[str, Any]]]:
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
                id=client_run_id or create_id("agent_run"),
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
                input={"prompt": prompt, "quickTask": quick_task, "conversation": planner_conversation},
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
            message_id = create_id("ai_message")
            part_id = create_id("ai_part")
            chunks: list[str] = []
            system = "你是 Culina 的厨房助手。只能基于用户当前家庭厨房上下文给出简短、可执行的建议；不能承诺写入系统数据。"
            for chunk in self.provider.stream_generate(system=system, user=prompt):
                if not chunk:
                    continue
                chunks.append(chunk)
                yield (
                    "message_delta",
                    {
                        "message_id": message_id,
                        "conversation_id": conversation.id,
                        "run_id": run.id,
                        "part_id": part_id,
                        "delta": chunk,
                    },
                )
            text = "".join(chunks).strip()
            if not text:
                text = "我可以先帮你做轻量分析。当前 1A 阶段已经支持“今日吃什么”这类结构化建议；涉及创建菜谱、购物清单或餐食计划的写入，会在下一阶段通过草稿确认来完成。"
                for index in range(0, len(text), 12):
                    yield (
                        "message_delta",
                        {
                            "message_id": message_id,
                            "conversation_id": conversation.id,
                            "run_id": run.id,
                            "part_id": part_id,
                            "delta": text[index : index + 12],
                        },
                    )

            events.append(self._add_event(family_id, conversation.id, run.id, "agent", "run_agent", "正在生成可操作建议", "completed"))
            assistant_message = AIMessage(
                id=message_id,
                family_id=family_id,
                conversation_id=conversation.id,
                role="assistant",
                content=text,
                content_type="parts",
                parts=[{"id": part_id, "type": "text", "text": text}],
                run_id=run.id,
                status="completed",
                message_metadata={"intent": "general_chat", "agentKey": "general_chat_agent"},
                created_by=user_id,
            )
            self.db.add(assistant_message)

            run.agent_key = "general_chat_agent"
            run.intent = "general_chat"
            run.status = "completed"
            run.model = getattr(self.provider, "model_name", run.model)
            run.context_summary = {
                "routing": {
                    "intent": "general_chat",
                    "agentKey": "general_chat_agent",
                    "skills": plan.skills,
                    "plannerAttempts": plan.attempts,
                    "plannerRawResponse": plan.raw_response,
                },
            }
            run.output_summary = text[:255]
            run.output = {"text": text, "cards": [], "routing": run.context_summary.get("routing", {})}
            run.tool_calls = []
            run.duration_ms = int((perf_counter() - started_at) * 1000)

            conversation.prompt = prompt
            conversation.response = text
            conversation.summary = text[:255]
            conversation.last_message_at = utcnow()
            conversation.last_run_status = "completed"
            events.append(self._add_event(family_id, conversation.id, run.id, "finalize", "build_response", "已生成回复", "completed"))
            self.db.flush()
            yield (
                "response",
                {
                    "conversation_id": conversation.id,
                    "message": serialize_ai_message(assistant_message),
                    "run": serialize_ai_run(run),
                    "events": [serialize_ai_run_event(event) for event in events],
                    "included": {"result_cards": [], "drafts": [], "approvals": []},
                },
            )

        return generate()

    def _run_general_chat(self, prompt: str) -> SkillExecutionResult:
        system = """
        你是 Culina 的厨房助手，负责家庭厨房场景下的普通聊天、做饭答疑、食材建议、烹饪技巧、饮食搭配和轻量决策。

        回答要求：
        1. 简短、自然、实用，优先给出用户马上能执行的建议。
        2. 可以结合用户当前提供的家庭成员、饮食偏好、库存食材、餐食计划、历史记录等上下文回答；没有上下文时不要编造。
        3. 上下文不足时，可以先给通用建议；确实需要补充信息时，只追问一个关键问题。
        4. 不承诺已经写入、修改、删除或保存任何系统数据。
        5. 涉及饮食记录、餐食计划、库存管理、用户画像更新等真实数据变更时，不要假装已完成，只能说明可以先帮用户整理。
        6. 不提供医疗诊断，不夸大营养功效。

        当用户只是闲聊、询问做饭技巧、问某个食材怎么处理、想要简单建议时，直接回答。
        """.strip()

        user = (prompt or "").strip()

        if user:
            result = self.provider.generate(system=system, user=user)
            text = (result.text or "").strip()
            model = result.model or getattr(self.provider, "model_name", "")
        else:
            text = ""
            model = getattr(self.provider, "model_name", "")

        if not text:
            text = "我在，可以问我做饭技巧、食材处理、简单搭配，或者让我帮你想一顿饭。"

        return SkillExecutionResult(
            text=text,
            cards=[],
            drafts=[],
            events=[],
            tool_calls=[],
            context_summary={},
            state_patch={},
            status="completed",
            model=model,
            error=None,
        )

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
            next_card.setdefault("id", create_id("ai_card"))
            next_card.setdefault("title", default_titles.get(card_type, "AI 结果"))
            next_card.setdefault("data", {})
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
        if run.status not in {"pending", "running"}:
            raise ValueError("运行任务已结束，不能取消")
        run.status = "cancelled"
        run.error = "用户取消了这次任务"
        if run.conversation_id:
            conversation = self.db.get(AIConversation, run.conversation_id)
            if conversation is not None:
                conversation.last_run_status = "cancelled"
                conversation.last_message_at = utcnow()
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

        config = DRAFT_APPROVAL_CONFIG.get(draft.draft_type)
        if config is None:
            raise ValueError("暂不支持的草稿类型")
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
        self.db.add(operation)
        self.db.flush()
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
        except Exception as exc:
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
        draft_type = str(draft_payload.get("draft_type") or "")
        config = DRAFT_APPROVAL_CONFIG.get(draft_type)
        if config is None:
            raise ValueError("暂不支持的草稿类型")
        payload = self._validate_draft_payload(draft_type=draft_type, family_id=family_id, payload=dict(draft_payload.get("payload") or {}))
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
        card = {
            "id": create_id("ai_card"),
            "type": self._draft_card_type(draft_type),
            "title": self._draft_title(draft_type, payload),
            "data": {
                "draftId": draft.id,
                "approvalId": approval.id,
                "summary": draft.preview_summary,
                "draft": payload,
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
        return {value_key: self._validate_draft_payload(draft_type=draft.draft_type, family_id=draft.family_id, payload=draft_value)}

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

    def _validate_draft_payload(self, *, draft_type: str, family_id: str, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("草稿内容格式不正确")
        if draft_type == "recipe":
            try:
                recipe = CreateRecipeRequest.model_validate(payload).model_dump(mode="json")
            except ValidationError as exc:
                raise ValueError("菜谱草稿字段不完整或格式不正确") from exc
            ingredient_ids = [item.get("ingredient_id") for item in recipe["ingredient_items"] if item.get("ingredient_id")]
            self._require_family_ids(Ingredient, family_id=family_id, ids=ingredient_ids, label="食材")
            return recipe
        if draft_type == "shopping_list":
            items = payload.get("items")
            if not isinstance(items, list) or not items:
                raise ValueError("购物清单草稿不能为空")
            return {
                "draftType": "shopping_list",
                "schemaVersion": payload.get("schemaVersion") or "shopping_list.v1",
                "items": [CreateShoppingListItemRequest.model_validate(item).model_dump(mode="json") for item in items],
                "sourceDraftId": payload.get("sourceDraftId"),
            }
        if draft_type == "meal_plan":
            items = payload.get("items")
            if not isinstance(items, list) or not items:
                raise ValueError("餐食计划草稿不能为空")
            normalized_items = []
            food_ids = []
            recipe_ids = []
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("餐食计划草稿项格式不正确")
                plan_date = date.fromisoformat(str(item.get("date")))
                meal_type = MealType(str(item.get("mealType")))
                title = str(item.get("title") or "").strip()
                food_id = item.get("foodId") or item.get("food_id")
                recipe_id = item.get("recipeId") or item.get("recipe_id")
                if not title and not food_id:
                    raise ValueError("餐食计划草稿项缺少食物名称")
                if food_id:
                    food_ids.append(str(food_id))
                if recipe_id:
                    recipe_ids.append(str(recipe_id))
                normalized_items.append(
                    {
                        "date": plan_date.isoformat(),
                        "mealType": meal_type.value,
                        "title": title,
                        "foodId": str(food_id) if food_id else None,
                        "recipeId": str(recipe_id) if recipe_id else None,
                        "reason": str(item.get("reason") or item.get("note") or ""),
                        "usedInventory": list(item.get("usedInventory") or []),
                        "missingIngredients": list(item.get("missingIngredients") or []),
                        "source": item.get("source") if isinstance(item.get("source"), dict) else {},
                    }
                )
            self._require_family_ids(Food, family_id=family_id, ids=food_ids, label="食物")
            self._require_family_ids(Recipe, family_id=family_id, ids=recipe_ids, label="菜谱")
            return {
                "draftType": "meal_plan",
                "schemaVersion": payload.get("schemaVersion") or "meal_plan.v1",
                "items": normalized_items,
                "source": payload.get("source") if isinstance(payload.get("source"), dict) else {},
            }
        if draft_type == "meal_log":
            foods = payload.get("foods")
            if not isinstance(foods, list) or not foods:
                raise ValueError("餐食记录草稿不能为空")
            food_ids = [str(item.get("foodId") or item.get("food_id")) for item in foods if isinstance(item, dict) and (item.get("foodId") or item.get("food_id"))]
            self._require_family_ids(Food, family_id=family_id, ids=food_ids, label="食物")
            normalized_foods = []
            for item in foods:
                if not isinstance(item, dict):
                    raise ValueError("餐食记录食物项格式不正确")
                name = str(item.get("name") or "").strip()
                food_id = item.get("foodId") or item.get("food_id")
                if not name and not food_id:
                    raise ValueError("餐食记录食物项缺少名称")
                normalized_foods.append(
                    {
                        "foodId": str(food_id) if food_id else None,
                        "name": name,
                        "servings": max(float(item.get("servings") or 1), 0.1),
                        "note": str(item.get("note") or ""),
                    }
                )
            return {
                "draftType": "meal_log",
                "schemaVersion": payload.get("schemaVersion") or "meal_log.v1",
                "date": date.fromisoformat(str(payload.get("date"))).isoformat(),
                "mealType": MealType(str(payload.get("mealType"))).value,
                "foods": normalized_foods,
                "notes": str(payload.get("notes") or ""),
            }
        if draft_type == "food_profile":
            try:
                food = CreateFoodRequest.model_validate(payload).model_dump(mode="json")
            except ValidationError as exc:
                raise ValueError("食物资料草稿字段不完整或格式不正确") from exc
            recipe_id = food.get("recipe_id")
            if recipe_id:
                self._require_family_ids(Recipe, family_id=family_id, ids=[recipe_id], label="菜谱")
            return {"draftType": "food_profile", "schemaVersion": payload.get("schemaVersion") or "food_profile.v1", **food}
        raise ValueError("暂不支持的草稿类型")

    def _require_family_ids(self, model: Any, *, family_id: str, ids: list[str], label: str) -> None:
        if not ids:
            return
        existing_ids = set(self.db.scalars(select(model.id).where(model.family_id == family_id, model.id.in_(ids))))
        if set(ids) - existing_ids:
            raise ValueError(f"草稿包含不属于当前家庭的{label}")

    def _draft_title(self, draft_type: str, payload: dict[str, Any]) -> str:
        if draft_type == "recipe":
            return str(payload.get("title") or "菜谱草稿")
        if draft_type == "shopping_list":
            return "购物清单草稿"
        if draft_type == "meal_plan":
            return "餐食计划草稿"
        if draft_type == "meal_log":
            return "餐食记录草稿"
        if draft_type == "food_profile":
            return str(payload.get("name") or "食物资料草稿")
        return "AI 草稿"

    def _draft_card_type(self, draft_type: str) -> str:
        return {
            "recipe": "recipe_draft",
            "shopping_list": "shopping_list_draft",
            "meal_plan": "meal_plan_draft",
            "meal_log": "meal_log_draft",
            "food_profile": "food_profile_draft",
        }.get(draft_type, "approval_request")

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
        raise ValueError("暂不支持的草稿类型")

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

    def _get_or_create_food_for_ai_title(self, *, family_id: str, user_id: str, title: str) -> Food:
        clean_title = title.strip()[:120] or "AI 计划食物"
        existing = self.db.scalar(select(Food).where(Food.family_id == family_id, Food.name == clean_title).limit(1))
        if existing is not None:
            return existing
        food = Food(
            id=create_id("food"),
            family_id=family_id,
            name=clean_title,
            type=FoodType.SELF_MADE.value,
            category="AI计划",
            flavor_tags=[],
            scene_tags=["AI计划"],
            suitable_meal_types=[item.value for item in MealType],
            source_name="AI 工作台",
            purchase_source="",
            scene="",
            notes="由 AI 草稿确认时创建，可在食物库继续完善。",
            routine_note="",
            stock_unit="",
            favorite=False,
            created_by=user_id,
            updated_by=user_id,
        )
        self.db.add(food)
        self.db.flush()
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

    def _create_meal_plan_from_draft(self, *, family_id: str, user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        created: list[FoodPlanItem] = []
        for item_payload in payload.get("items") or []:
            food_id = item_payload.get("foodId")
            if food_id:
                food = self.db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id))
                if food is None:
                    raise ValueError("草稿包含不属于当前家庭的食物")
            else:
                food = self._get_or_create_food_for_ai_title(family_id=family_id, user_id=user_id, title=str(item_payload.get("title") or "AI 计划食物"))
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
            if food_id:
                food = self.db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id))
                if food is None:
                    raise ValueError("草稿包含不属于当前家庭的食物")
            else:
                food = self._get_or_create_food_for_ai_title(family_id=family_id, user_id=user_id, title=str(item.get("name") or "AI 餐食"))
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
