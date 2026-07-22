from __future__ import annotations

import base64
from contextlib import ExitStack
import json
import tempfile
import unittest
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
from fastapi.testclient import TestClient
from langgraph.checkpoint.base import empty_checkpoint
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine

from app.ai.kitchen.recipe_drafts import _extract_json, build_recipe_image_render_payload
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult, DisabledChatProvider, OpenAICompatibleChatProvider, ProviderUserInput
from app.ai.skills import (
    BaseSkill,
    CatalogSkill,
    SkillCompletionPolicy,
    SkillContext,
    SkillDirectoryLoader,
    SkillManifest,
    SkillRegistry,
    SkillResult,
    SkillScriptCatalog,
    SkillScriptExecutor,
    build_workspace_skill_registry,
)
from app.ai.skills.shared import json_object
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.ai.tools.draft_validation import normalize_inventory_operation_draft
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.ai.workflows.orchestrator import SkillInjectionManager, WorkspaceOrchestratorAgent
from app.ai.workflows.runner import WorkspaceGraphRunner
from app.ai.workflows.timeline import build_planner_conversation
from app.core.deps import get_current_auth
from app.core.enums import AiMode, AIConversationVisibility, Difficulty, FoodType, ImageGenerationMode, IngredientExpiryMode, IngredientQuantityTrackingMode, InventoryStatus, MealType, MediaEntityType, MediaSource, MembershipStatus, UserRole
from app.core.utils import utcnow
from app.db.session import get_db
from app.main import app
from app.models.domain import (
    ActivityLog,
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIGraphCheckpoint,
    AIGraphWrite,
    AIImageGenerationJob,
    AIMessage,
    AIOperation,
    AIRunEvent,
    AIRunTraceSpan,
    AITaskDraft,
    AIUserApproval,
    Base,
    Family,
    Food,
    FoodPlanItem,
    Ingredient,
    InventoryDeductionSuggestion,
    InventoryItem,
    MealLog,
    MealLogFood,
    MediaAsset,
    Membership,
    Recipe,
    RecipeCookLog,
    RecipeIngredient,
    RecipeStep,
    SearchIndexJob,
    ShoppingListItem,
    User,
)
from app.ai.images.generation import ImageGenerationRequest, ImageProviderConfig, OpenAIImageGenerationProvider, build_ai_image_prompt, _build_provider_config
from app.services.inventory_operations import dispose_inventory_quantity
from app.services.inventory_usage import remaining_quantity
from app.services.clock import today_for_family
from app.services.ai_operations.composite import (
    build_composite_operation_step_previews,
    composite_execution_order,
    execute_composite_operation_plan,
    resolve_composite_step_operation,
    validate_composite_operation_plan,
)
from app.services.ai_operations.registry import draft_operation_registry


def prompt_contract_metadata(system_prompt: str) -> dict[str, Any]:
    marker = "Prompt contract metadata:\n"
    if marker not in system_prompt:
        raise AssertionError("system prompt missing contract metadata")
    raw = system_prompt.split(marker, 1)[1].split("\n\n", 1)[0]
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise AssertionError("system prompt contract metadata must be an object")
    return value


class FakeChatProvider(BaseChatProvider):
    model_name = "fake-model"

    def __init__(self, text: str | None = None) -> None:
        self.text = text or "模型回答：优先处理库存并安排清淡晚餐。"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        if "餐食计划 Skill" in system:
            payload = json.loads(user)
            message = str(payload.get("currentMessage") or "")
            artifacts = [
                artifact
                for entry in payload.get("conversation", [])
                for artifact in entry.get("artifacts", [])
                if artifact.get("type") == "meal_plan"
            ]
            operation = "modify" if artifacts else "create"
            source_id = artifacts[-1]["id"] if artifacts else None
            if "帮我做菜单" in message:
                return ChatProviderResult(
                    text=json.dumps(
                        {
                            "operation": "clarify",
                            "sourceArtifactId": None,
                            "days": 3,
                            "mealTypes": ["dinner"],
                            "constraints": [],
                            "clarification": "我需要先确认计划范围：你想安排几天、哪些餐别？",
                            "items": [],
                        },
                        ensure_ascii=False,
                    ),
                    status="completed",
                    model=self.model_name,
                )
            days = 3 if "三天" in message or operation == "modify" else 1
            items = [
                {
                    "date": (date.today() + timedelta(days=index)).isoformat(),
                    "mealType": "dinner",
                    "title": "番茄小炒",
                    "foodId": "food-tomato",
                    "recipeId": None,
                    "reason": "优先使用临期番茄；按清淡口味安排",
                    "usedInventory": ["番茄"],
                    "missingIngredients": ["鸡蛋"] if index == 0 else [],
                }
                for index in range(days)
            ]
            if operation == "modify":
                source_items = artifacts[-1].get("payload", {}).get("items", [])
                if source_items:
                    items = [dict(item) for item in source_items]
                    if len(items) > 1:
                        items[1].update(
                            {
                                "title": "番茄小炒",
                                "foodId": "food-tomato",
                                "recipeId": None,
                                "reason": "根据要求换成更适合孩子的清淡餐食",
                                "missingIngredients": ["豆腐", "青菜"],
                            }
                        )
            return ChatProviderResult(
                text=json.dumps(
                    {
                        "operation": operation,
                        "sourceArtifactId": source_id,
                        "days": days,
                        "mealTypes": ["dinner"],
                        "constraints": ["light"] if "清淡" in message else [],
                        "clarification": None,
                        "items": items,
                    },
                    ensure_ascii=False,
                ),
                status="completed",
                model=self.model_name,
            )
        if "购物清单 Skill" in system:
            payload = json.loads(user)
            artifacts = payload.get("availableArtifacts", [])
            plans = [artifact for artifact in artifacts if artifact.get("type") == "meal_plan"]
            source_id = plans[-1]["id"] if plans else None
            return ChatProviderResult(
                text=json.dumps(
                    {
                        "operation": "derive" if source_id else "create",
                        "sourceArtifactId": source_id,
                        "clarification": None,
                        "items": [
                            {
                                "title": "鸡蛋",
                                "quantity": 2,
                                "unit": "个",
                                "reason": "用于番茄鸡蛋面",
                                "sourceMeals": ["番茄鸡蛋面"],
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                status="completed",
                model=self.model_name,
            )
        if "餐食记录 Skill" in system:
            payload = json.loads(user)
            message = str(payload.get("currentMessage") or "")
            foods = payload.get("foods", [])
            matched = next((food for food in foods if food.get("name") and food["name"] in message), None)
            if not any(term in message for term in ["吃了", "早餐", "午餐", "晚餐", "早饭", "午饭", "晚饭"]):
                return ChatProviderResult(
                    text=json.dumps(
                        {
                            "operation": "clarify",
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "foods": [],
                            "notes": message,
                            "clarification": "请告诉我这餐具体吃了什么。",
                        },
                        ensure_ascii=False,
                    ),
                    status="completed",
                    model=self.model_name,
                )
            name = matched["name"] if matched else message.replace("今晚吃了", "").replace("今天吃了", "").strip(" ，。")
            return ChatProviderResult(
                text=json.dumps(
                    {
                        "operation": "create",
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                        "foods": [
                            {
                                "foodId": matched["id"] if matched else None,
                                "name": name,
                                "servings": 1,
                                "note": "从用户描述中整理",
                            }
                        ],
                        "notes": message,
                        "clarification": None,
                    },
                    ensure_ascii=False,
                ),
                status="completed",
                model=self.model_name,
            )
        if "食物资料 Skill" in system:
            payload = json.loads(user)
            message = str(payload.get("currentMessage") or "")
            foods = payload.get("foods", [])
            name = message
            for marker in ["补全", "整理", "食物资料", "资料", "创建食物", "新增食物"]:
                name = name.replace(marker, "")
            name = name.strip(" ，。")
            matched = next((food for food in foods if food.get("name") == name), None)
            if not name:
                return ChatProviderResult(
                    text=json.dumps(
                        {
                            "operation": "clarify",
                            "clarification": "请告诉我要整理的食物名称。",
                            "name": "",
                            "type": "readyMade",
                            "category": "",
                            "flavor_tags": [],
                            "scene_tags": [],
                            "suitable_meal_types": [],
                            "source_name": "",
                            "purchase_source": "",
                            "scene": "",
                            "notes": "",
                            "routine_note": "",
                            "price": None,
                            "rating": None,
                            "repurchase": None,
                            "expiry_date": None,
                            "stock_quantity": None,
                            "stock_unit": "",
                            "favorite": False,
                            "recipe_id": None,
                        },
                        ensure_ascii=False,
                    ),
                    status="completed",
                    model=self.model_name,
                )
            return ChatProviderResult(
                text=json.dumps(
                    {
                        "operation": "create",
                        "clarification": None,
                        "name": matched["name"] if matched else name,
                        "type": matched["type"] if matched else "readyMade",
                        "category": matched.get("category") if matched else "AI整理",
                        "flavor_tags": matched.get("flavorTags", []) if matched else [],
                        "scene_tags": matched.get("sceneTags", []) if matched else ["AI整理"],
                        "suitable_meal_types": matched.get("suitableMealTypes", []) if matched else ["breakfast", "lunch", "dinner"],
                        "source_name": "",
                        "purchase_source": "",
                        "scene": matched.get("scene", "") if matched else "",
                        "notes": message,
                        "routine_note": matched.get("routineNote", "") if matched else "由 AI 工作台整理，确认前可继续编辑。",
                        "price": None,
                        "rating": None,
                        "repurchase": None,
                        "expiry_date": None,
                        "stock_quantity": None,
                        "stock_unit": "",
                        "favorite": False,
                        "recipe_id": matched.get("recipeId") if matched else None,
                    },
                    ensure_ascii=False,
                ),
                status="completed",
                model=self.model_name,
            )
        return ChatProviderResult(text=self.text, status="completed", model=self.model_name)

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        is_orchestrator = "主 Orchestrator" in system
        del max_rounds
        available_tool_names = {tool.name for tool in (tools())}
        if not is_orchestrator and "家庭菜谱生成智能体" in system and "recipe.create_draft" in available_tool_names:
            draft = _extract_json(self.text)
            if not isinstance(draft, dict):
                return ChatProviderResult(text=self.text, status="completed", model=self.model_name)
            output = tool_handler("recipe.create_draft", {"draft": draft})
            return ChatProviderResult(
                text=None,
                status="completed",
                model=self.model_name,
                tool_calls=[{"name": "recipe.create_draft", "args": {"draft": draft}, "output": output}],
            )
        payload = json.loads(user)
        message = str(payload.get("currentMessage") or "")
        quick_task = payload.get("quickTask")
        tool_names: list[str] = []
        latest_approval_decision = next(
            (
                artifact
                for artifact in reversed(payload.get("currentRunArtifacts") or [])
                if isinstance(artifact, dict) and artifact.get("type") == "approval_decision"
            ),
            None,
        )
        if isinstance(latest_approval_decision, dict) and latest_approval_decision.get("status") == "rejected":
            if message_handler is not None:
                message_handler(self.text)
            return self._tool_result(
                {
                    "text": self.text,
                    "cards": [],
                    "events": [],
                    "context_summary": {"lastApprovalDecision": "rejected"},
                    "state_patch": {},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                },
                tool_names,
            )
        recommendation_mode = quick_task == "today_recommendation" or (
            any(term in message for term in ["今日吃什么", "今天吃什么", "今晚吃什么", "中午吃啥", "早餐思路", "推荐一餐"])
            and not any(term in message for term in ["安排", "计划", "菜单", "制定", "修改", "第二天", "三天"])
        )

        resume_skill_key = ""
        approved_draft_type = self._latest_approved_draft_type(payload)
        if is_orchestrator:
            resume_skill_key = self._resume_skill_key(payload)
            if approved_draft_type == "meal_plan":
                if self._wants_meal_log_after_plan(message):
                    skills = ["meal_log"]
                elif any(term in message for term in ["购物", "采购", "补货"]):
                    skills = ["shopping_list"]
                else:
                    skills = []
            else:
                skills = [resume_skill_key] if resume_skill_key else self._orchestrator_skills_for_message(message, quick_task)
            if skills:
                tool_handler("skill.inject", {"skills": skills, "reason": "根据用户请求选择需要的 Culina 能力"})
                available_tool_names = {tool.name for tool in (tools())}

        def emit_visible(text: str) -> None:
            if message_handler is not None:
                message_handler(text)

        def call(name: str, args: dict | None = None) -> dict:
            tool_names.append(name)
            return tool_handler(name, args or {})

        def read_artifact_payload(artifact_id: str | None) -> dict:
            if not artifact_id or "workspace.read_artifact" not in available_tool_names:
                return {}
            detail = call("workspace.read_artifact", {"id": artifact_id, "kind": "draft"})
            artifact = detail.get("artifact") if isinstance(detail.get("artifact"), dict) else {}
            payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
            return payload

        if "shopping.create_draft" in available_tool_names and self._should_create_downstream_shopping(payload):
            return self._shopping_tool_result(payload, message, call, emit_visible, tool_names)

        takeout_needs_food = self._is_takeout_arrangement_message(message) and resume_skill_key != "meal_plan"
        if (
            "meal_plan.create_draft" in available_tool_names
            and not recommendation_mode
            and not takeout_needs_food
            and approved_draft_type != "meal_plan"
        ):
            emit_visible("我先看一下临期食材和最近餐食。")
            inventory = call("inventory.read_expiring_items", {"days": 7})
            call("inventory.read_available_items", {"limit": 80})
            call("meal_log.read_recent", {"limit": 8})
            foods = call("food.search", {"limit": 24}).get("items", [])
            call("recipe.search", {"limit": 24})
            call("meal_plan.read_existing", {"limit": 20})
            artifacts = [artifact for artifact in payload.get("artifacts", []) if artifact.get("type") == "meal_plan"]
            operation = "modify" if artifacts or "第二天" in message else "create"
            source_id = artifacts[-1]["id"] if artifacts else None
            if "帮我做菜单" in message:
                emit_visible("我需要先确认计划范围：你想安排几天、哪些餐别？")
                return self._tool_result(
                    {
                        "text": "我需要先确认计划范围：你想安排几天、哪些餐别？",
                        "cards": [],
                        "events": [],
                        "context_summary": {},
                        "state_patch": {},
                        "requires_clarification": True,
                        "status": "completed",
                        "error": None,
                        "operation": "clarify",
                    },
                    tool_names,
                )
            days = 3 if "三天" in message or operation == "modify" else 1
            target_food_name = self._takeout_food_name(message) if self._is_takeout_arrangement_message(message) else ""
            matched_food = next((food for food in foods if food.get("name") == target_food_name), None)
            planned_food_id = matched_food["id"] if matched_food else "food-tomato"
            planned_food_name = matched_food["name"] if matched_food else "番茄小炒"
            items = [
                {
                    "date": (date.today() + timedelta(days=index)).isoformat(),
                    "mealType": "dinner",
                    "title": planned_food_name,
                    "foodId": planned_food_id,
                    "recipeId": None,
                    "reason": "按用户指定安排为今天晚餐" if matched_food else "优先使用临期番茄；按清淡口味安排",
                    "usedInventory": [] if matched_food else ["番茄"],
                    "missingIngredients": [] if matched_food else (["鸡蛋"] if index == 0 else []),
                }
                for index in range(days)
            ]
            if operation == "modify" and artifacts:
                source_items = read_artifact_payload(source_id).get("items") or artifacts[-1].get("payload", {}).get("items", [])
                if source_items:
                    items = [dict(item) for item in source_items]
                    if len(items) > 1:
                        items[1].update({"title": "清淡蔬菜豆腐", "reason": "根据要求换成更适合孩子的清淡餐食", "missingIngredients": ["豆腐", "青菜"]})
            validation = call("script.validate_meal_plan", {"plan": items})["result"]
            if not validation.get("valid"):
                return self._tool_result(
                    {
                        "text": "餐食计划结构校验失败，请重试。",
                        "cards": [],
                        "events": [],
                        "context_summary": {"scriptValidation": validation},
                        "state_patch": {},
                        "requires_clarification": False,
                        "status": "failed",
                        "error": "meal plan script validation failed",
                        "operation": operation,
                        "source_artifact_id": source_id,
                    },
                    tool_names,
                )
            draft = {
                "draftType": "meal_plan",
                "schemaVersion": "meal_plan.v1",
                "items": items,
                "source": {"days": days, "mealTypes": ["dinner"], "expiringInventoryIds": [item.get("id") for item in inventory.get("items", [])], "modifiedFromDraftId": source_id},
            }
            draft_args = {"draft": draft}
            state_patch = {"activeTask": "meal_plan", "activeDraftType": "meal_plan"}
            call("meal_plan.create_draft", draft_args)
            return self._tool_result(
                {
                    "text": "我先看一下临期食材和最近餐食。",
                    "cards": [],
                    "events": [{"type": "draft", "message": "已生成餐食计划草稿"}],
                    "context_summary": {
                        "expiringItemCount": inventory.get("count", 0),
                        "draftType": "meal_plan",
                        "scriptValidation": validation,
                    },
                    "state_patch": state_patch,
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                    "operation": operation,
                    "source_artifact_id": source_id,
                },
                tool_names,
            )

        if "shopping.create_draft" in available_tool_names:
            return self._shopping_tool_result(payload, message, call, emit_visible, tool_names)

        if "recipe.create_draft" in available_tool_names:
            emit_visible("我先查一下可用食材。")
            call("ingredient.search", {"limit": 50})
            draft = self._recipe_draft_from_text()
            call("recipe.create_draft", {"draft": draft})
            return self._tool_result(
                {
                    "text": "我先查一下可用食材。",
                    "cards": [],
                    "events": [{"type": "draft", "message": "已生成菜谱草稿"}],
                    "context_summary": {"draftType": "recipe"},
                    "state_patch": {"activeTask": "recipe_draft", "activeDraftType": "recipe"},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                    "operation": "create",
                },
                tool_names,
            )

        if "meal_log.create_draft" in available_tool_names:
            emit_visible("我先匹配家庭食物资料和最近记录。")
            foods = call("food.search", {"limit": 24}).get("items", [])
            call("meal_log.read_recent", {"limit": 8})
            plan_artifact = self._latest_confirmed_meal_plan_artifact(payload)
            plan_payload = plan_artifact.get("payload") if isinstance(plan_artifact.get("payload"), dict) else {}
            planned_food_id = str(plan_payload.get("food_id") or plan_payload.get("foodId") or "")
            planned_food_name = str(plan_payload.get("food_name") or plan_payload.get("foodName") or plan_artifact.get("summary") or "")
            matched = next((food for food in foods if planned_food_id and food.get("id") == planned_food_id), None)
            if matched is None:
                matched = next((food for food in foods if planned_food_name and food.get("name") == planned_food_name), None)
            if matched is None and planned_food_name:
                matched = next((food for food in call("food.search", {"query": planned_food_name, "exact": True, "limit": 1}).get("items", [])), None)
            if matched is None:
                matched = next((food for food in foods if food.get("name") and food["name"] in message), None)
            name = planned_food_name or (matched["name"] if matched else message.replace("今晚吃了", "").replace("今天吃了", "").strip(" ，。"))
            food_id = planned_food_id or (matched["id"] if matched else None)
            draft = {
                "draftType": "meal_log",
                "schemaVersion": "meal_log.v1",
                "date": str(plan_payload.get("plan_date") or date.today().isoformat()),
                "mealType": str(plan_payload.get("meal_type") or "dinner"),
                "foods": [{"foodId": food_id, "name": name, "servings": 1, "note": "从用户描述中整理"}],
                "notes": message,
            }
            plan_item_id = str(plan_artifact.get("entityId") or plan_payload.get("id") or "")
            if plan_item_id:
                draft["planItemId"] = plan_item_id
            plan_updated_at = plan_payload.get("updated_at") or plan_payload.get("updatedAt") or plan_artifact.get("updatedAt")
            if plan_updated_at:
                draft["planItemBaseUpdatedAt"] = str(plan_updated_at)
            call("meal_log.create_draft", {"draft": draft})
            return self._tool_result(
                {"text": "我先匹配家庭食物资料和最近记录。", "cards": [], "events": [], "context_summary": {"draftType": "meal_log"}, "state_patch": {}, "requires_clarification": False, "status": "completed", "error": None, "operation": "create"},
                tool_names,
            )

        if "food_profile.create_draft" in available_tool_names:
            emit_visible("我先查一下已有食物资料。")
            foods = call("food.search", {"limit": 24}).get("items", [])
            name = message
            for marker in ["补全", "整理", "食物资料", "资料", "创建食物", "新增食物"]:
                name = name.replace(marker, "")
            name = name.strip(" ，。")
            matched = next((food for food in foods if food.get("name") == name), None)
            is_takeout_arrangement = self._is_takeout_arrangement_message(message)
            if is_takeout_arrangement:
                name = self._takeout_food_name(message)
                matched = next((food for food in foods if food.get("name") == name), None)
            suitable_meal_types = matched.get("suitableMealTypes", []) if matched else ["breakfast", "lunch", "dinner"]
            if not matched and is_takeout_arrangement and any(term in message for term in ["晚餐", "晚饭", "今晚"]):
                suitable_meal_types = ["dinner"]
            draft = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile.v1",
                "name": matched["name"] if matched else name,
                "type": matched["type"] if matched else ("takeout" if is_takeout_arrangement else "readyMade"),
                "category": matched.get("category") if matched else ("外卖" if is_takeout_arrangement else "AI整理"),
                "flavor_tags": matched.get("flavorTags", []) if matched else [],
                "scene_tags": matched.get("sceneTags", []) if matched else (["晚餐", "外卖"] if is_takeout_arrangement else ["AI整理"]),
                "suitable_meal_types": suitable_meal_types,
                "source_name": "",
                "purchase_source": "",
                "scene": matched.get("scene", "") if matched else "",
                "notes": message,
                "routine_note": matched.get("routineNote", "") if matched else ("先补充为可安排的食物资料，确认后继续创建餐食计划。" if is_takeout_arrangement else "由 AI 工作台整理，确认前可继续编辑。"),
                "price": None,
                "rating": None,
                "repurchase": None,
                "expiry_date": None,
                "stock_quantity": None,
                "stock_unit": "",
                "favorite": False,
                "recipe_id": matched.get("recipeId") if matched else None,
            }
            draft_args = {"draft": draft}
            if is_takeout_arrangement:
                instruction = "确认食物资料后，继续用该食物创建今天晚餐的餐食计划。"
                if self._wants_meal_log_after_plan(message):
                    instruction = "确认食物资料后，继续用该食物创建今天晚餐的餐食计划；计划确认后再创建用餐记录并尽量关联计划项。"
                draft_args["continuation"] = {
                    "workflowId": f"takeout-dinner:{name}",
                    "stepKey": "create-food-profile",
                    "reasonCode": "missing_food",
                    "nextSkillKey": "food_profile",
                    "resumeSkillKey": "meal_plan",
                    "requiredDraftType": "food_profile",
                    "stateSchema": "meal_missing_food.v1",
                    "state": {
                        "targetName": name,
                        "targetDate": date.today().isoformat(),
                        "mealType": "dinner",
                        "instruction": instruction,
                    },
                }
            call("food_profile.create_draft", draft_args)
            return self._tool_result(
                {"text": "我先查一下已有食物资料。", "cards": [], "events": [], "context_summary": {"draftType": "food_profile"}, "state_patch": {}, "requires_clarification": False, "status": "completed", "error": None, "operation": "create"},
                tool_names,
            )

        if "ingredient_profile.create_draft" in available_tool_names:
            emit_visible("我先查一下已有食材档案。")
            call("ingredient.search", {"limit": 50})
            name = message
            for marker in ["新增", "创建", "整理", "食材档案", "食材资料", "食材"]:
                name = name.replace(marker, "")
            name = name.strip(" ，。")
            draft = {
                "draftType": "ingredient_profile",
                "schemaVersion": "ingredient_profile.v1",
                "action": "create",
                "payload": {
                    "name": name or "鸡胸肉",
                    "category": "AI整理",
                    "default_unit": "克",
                    "unit_conversions": [],
                    "default_storage": "冷冻",
                    "default_expiry_mode": "none",
                    "default_expiry_days": None,
                    "default_low_stock_threshold": None,
                    "notes": message,
                    "media_ids": [],
                },
            }
            call("ingredient_profile.create_draft", {"draft": draft})
            return self._tool_result(
                {
                    "text": "我先查一下已有食材档案。",
                    "cards": [],
                    "events": [],
                    "context_summary": {"draftType": "ingredient_profile"},
                    "state_patch": {},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                    "operation": "create",
                },
                tool_names,
            )

        if "inventory.read_summary" in available_tool_names:
            emit_visible("我先读取库存概览和临期食材。")
            summary = call("inventory.read_summary")
            expiring = call("inventory.read_expiring_items", {"days": 7})
            text = f"当前可用库存 {summary.get('availableCount', 0)} 项，临期 {summary.get('expiringCount', 0)} 项，低库存 {summary.get('lowStockCount', 0)} 项。"
            emit_visible(text)
            return self._tool_result(
                {
                    "text": text,
                    "cards": [],
                    "events": [{"type": "tool", "message": "已读取库存摘要"}],
                    "context_summary": {
                        "inventoryItemCount": summary.get("availableCount", 0),
                        "expiringItemCount": expiring.get("count", summary.get("expiringCount", 0)),
                        "lowStockItemCount": summary.get("lowStockCount", 0),
                    },
                    "state_patch": {},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                },
                tool_names,
            )

        if "meal_plan.recommend_today" in available_tool_names and "recipe.search" in available_tool_names and "meal_log.read_recent" in available_tool_names:
            emit_visible("我先看一下库存、菜谱和最近餐食。")
            inventory = call("inventory.read_available_items", {"limit": 50})
            expiring = call("inventory.read_expiring_items", {"days": 7})
            recipes = call("recipe.search", {"limit": 12})
            foods = call("food.search", {"limit": 12})
            recent = call("meal_log.read_recent", {"limit": 5})
            food_candidates = [item for item in foods.get("items", [])[:3] if item.get("id")]
            recipe_candidates = [item for item in recipes.get("items", [])[:3] if item.get("id")]
            candidates = (
                [{"foodId": item["id"], "reason": "优先使用当前库存。", "evidence": expiring.get("items", [])[:1]} for item in food_candidates]
                or [{"recipeId": item["id"], "reason": "结合当前库存和菜谱库推荐。", "evidence": expiring.get("items", [])[:1]} for item in recipe_candidates]
            )
            meal_type = "breakfast" if "早餐" in message else "lunch" if "中午" in message else "dinner" if "今晚" in message else None
            call("meal_plan.recommend_today", {"recommendations": candidates[:3], "mealType": meal_type})
            emit_visible("我按当前库存和最近餐食整理了今天的建议。")
            return self._tool_result(
                {
                    "text": "我按当前库存和最近餐食整理了今天的建议。",
                    "cards": [],
                    "events": [{"type": "tool", "message": "已读取库存、菜谱和最近餐食"}],
                    "context_summary": {"inventoryItemCount": inventory.get("count", 0), "expiringItemCount": expiring.get("count", 0)},
                    "state_patch": {},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                },
                tool_names,
            )

        return self._tool_result({"text": self.text, "cards": [], "events": [], "context_summary": {}, "state_patch": {}, "requires_clarification": False, "status": "completed", "error": None}, tool_names)

    def _orchestrator_skills_for_message(self, message: str, quick_task: str | None) -> list[str]:
        if quick_task == "recipe_draft":
            return ["recipe_draft"]
        if quick_task == "today_recommendation":
            return ["meal_plan"]
        if self._is_takeout_arrangement_message(message):
            return ["meal_plan", "food_profile"]
        if "购物" in message or "采购" in message or "补货" in message:
            return ["meal_plan", "shopping_list"] if any(term in message for term in ["安排", "三天", "晚餐"]) else ["shopping_list"]
        if any(term in message for term in ["菜单", "安排", "三天", "晚餐", "第二天", "清淡"]):
            return ["meal_plan"]
        if any(term in message for term in ["菜谱", "做法"]):
            return ["recipe_draft"]
        if any(term in message for term in ["记录餐食", "今晚吃了", "今天吃了"]):
            return ["meal_log"]
        if any(term in message for term in ["食材档案", "新增食材", "食材资料"]):
            return ["ingredient_profile"]
        if any(term in message for term in ["食物资料", "整理食物"]):
            return ["food_profile"]
        if any(term in message for term in ["库存", "临期", "快过期"]):
            return ["inventory_analysis"]
        if any(term in message for term in ["今日吃什么", "今天吃什么", "今晚吃什么", "中午吃啥", "早餐思路", "推荐一餐"]):
            return ["meal_plan"]
        return []

    def _resume_skill_key(self, payload: dict) -> str:
        artifacts = [
            artifact
            for key in ("artifacts", "currentRunArtifacts")
            for artifact in (payload.get(key) if isinstance(payload.get(key), list) else [])
            if isinstance(artifact, dict)
            and artifact.get("type") == "workflow.continuation"
            and artifact.get("status") == "ready"
        ]
        for artifact in reversed(artifacts):
            continuation = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
            resume_skill_key = continuation.get("resumeSkillKey")
            if isinstance(resume_skill_key, str):
                return resume_skill_key
        return ""

    def _latest_approved_draft_type(self, payload: dict) -> str:
        artifacts = [
            artifact
            for key in ("artifacts", "currentRunArtifacts")
            for artifact in (payload.get(key) if isinstance(payload.get(key), list) else [])
            if isinstance(artifact, dict)
            and artifact.get("type") == "approval_decision"
            and artifact.get("status") == "approved"
        ]
        if not artifacts:
            return ""
        decision_payload = artifacts[-1].get("payload") if isinstance(artifacts[-1].get("payload"), dict) else {}
        draft = decision_payload.get("draft") if isinstance(decision_payload.get("draft"), dict) else {}
        return str(draft.get("draft_type") or "")

    def _latest_confirmed_meal_plan_artifact(self, payload: dict) -> dict:
        artifacts = [
            artifact
            for key in ("artifacts", "currentRunArtifacts")
            for artifact in (payload.get(key) if isinstance(payload.get(key), list) else [])
            if isinstance(artifact, dict)
            and artifact.get("type") == "meal_plan"
            and artifact.get("kind") == "business_entity"
            and artifact.get("status") == "confirmed"
        ]
        return artifacts[-1] if artifacts else {}

    def _is_takeout_arrangement_message(self, message: str) -> bool:
        has_plan_intent = any(term in message for term in ["安排", "作为", "当作", "当今天", "放到", "加入"])
        has_meal_slot = any(term in message for term in ["今天晚餐", "今晚", "晚餐", "晚饭", "菜单"])
        has_outside_food = any(term in message for term in ["外卖", "棒约翰", "披萨", "意面", "汉堡", "麦当劳", "肯德基"])
        return has_plan_intent and has_meal_slot and has_outside_food

    def _wants_meal_log_after_plan(self, message: str) -> bool:
        return any(term in message for term in ["并记录", "记录已吃", "记录吃了", "已吃", "吃了"])

    def _takeout_food_name(self, message: str) -> str:
        name = message.strip(" ，。")
        for prefix in ["请帮我", "帮我", "把", "将"]:
            if name.startswith(prefix):
                name = name[len(prefix) :]
        for marker in ["安排为", "安排到", "安排进", "作为", "当作", "放到", "加入"]:
            if marker in name:
                name = name.split(marker, 1)[0]
                break
        name = name.replace("外卖", "").strip(" ，。的")
        return name or "外卖晚餐"

    def _should_create_downstream_shopping(self, payload: dict) -> bool:
        artifacts = [
            artifact
            for key in ("artifacts", "currentRunArtifacts")
            for artifact in (payload.get(key) if isinstance(payload.get(key), list) else [])
            if isinstance(artifact, dict)
        ]
        has_meal_plan_decision = any(
            artifact.get("type") == "approval_decision"
            and isinstance(artifact.get("payload"), dict)
            and isinstance(artifact["payload"].get("draft"), dict)
            and artifact["payload"]["draft"].get("draft_type") == "meal_plan"
            for artifact in artifacts
        )
        has_shopping_output = any(artifact.get("type") == "shopping_list" for artifact in artifacts)
        return has_meal_plan_decision and not has_shopping_output

    def _shopping_tool_result(self, payload: dict, message: str, call, emit_visible, tool_names: list[str]) -> ChatProviderResult:
        del message
        emit_visible("我先核对已有购物项和可用库存。")
        pending = call("shopping.read_pending", {"limit": 50})
        call("inventory.read_available_items", {"limit": 80})
        plans = [
            artifact
            for key in ("artifacts", "currentRunArtifacts")
            for artifact in (payload.get(key) if isinstance(payload.get(key), list) else [])
            if isinstance(artifact, dict) and artifact.get("type") == "meal_plan"
        ]
        source_id = plans[-1]["id"] if plans else None
        items = [
            {
                "ingredientId": "ingredient-tomato",
                "title": "番茄",
                "quantity": 2,
                "unit": "个",
                "reason": "用于番茄鸡蛋面",
                "sourceMeals": ["番茄鸡蛋面"],
                "alreadyPending": False,
            }
        ]
        draft = {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1", "items": items, "sourceDraftId": source_id}
        emit_visible("我根据餐食计划里的缺失食材合并了 1 个购物清单草稿项。")
        call("shopping.create_draft", {"draft": draft})
        return self._tool_result(
            {
                "text": "我根据餐食计划里的缺失食材合并了 1 个购物清单草稿项。",
                "cards": [],
                "events": [{"type": "draft", "message": "已生成购物清单草稿"}],
                "context_summary": {"pendingShoppingCount": pending.get("count", 0), "draftType": "shopping_list"},
                "state_patch": {"activeTask": "shopping_list", "activeDraftType": "shopping_list"},
                "requires_clarification": False,
                "status": "completed",
                "error": None,
                "operation": "derive" if source_id else "create",
                "source_artifact_id": source_id,
            },
            tool_names,
        )

    def _tool_result(self, payload: dict, tool_names: list[str]) -> ChatProviderResult:
        return ChatProviderResult(
            text=str(payload.get("text") or ""),
            status=str(payload.get("status") or "completed"),
            model=self.model_name,
            tool_calls=[{"name": name, "args": {}} for name in tool_names],
        )

    def _recipe_draft_from_text(self) -> dict:
        parsed = json_object(self.text)
        if isinstance(parsed, dict) and parsed.get("title"):
            return parsed
        return {
            "title": "番茄鸡蛋面",
            "servings": 2,
            "prep_minutes": 20,
            "difficulty": "easy",
            "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                {"ingredient_id": None, "ingredient_name": "鸡蛋", "quantity": 2, "unit": "个", "note": "打散"},
            ],
            "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成 2 厘米块，鸡蛋打到没有透明蛋清。面条提前称好，葱花和调味料放在手边，方便后续连续操作。", "icon": "bowl", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["番茄切块"]},
                {"title": "炒汤底", "text": "锅中放少量油，中火加热 30 秒后倒入蛋液炒到刚凝固盛出。继续用中火炒番茄 3 分钟，看到出汁变软后加入热水煮沸。", "icon": "pan", "summary": "炒出汤底", "estimated_minutes": 8, "tip": "番茄要炒出汁。", "key_points": ["中火"]},
                {"title": "煮面收尾", "text": "汤汁沸腾后下面条煮 5 分钟，保持微沸并不时搅动防止粘连。面条变软熟透后倒回鸡蛋，加盐调味，确认汤汁冒泡后出锅。", "icon": "plate", "summary": "煮熟装盘", "estimated_minutes": 7, "tip": "出锅前尝味。", "key_points": ["煮熟"]},
            ],
            "tips": "少油少盐，适合晚餐。",
            "scene_tags": ["家常菜"],
        }


class StreamingChatProvider(BaseChatProvider):
    model_name = "stream-model"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("streaming chat should not call blocking generate")

    def stream_generate(self, *, system: str, user: str):
        yield "第一段"
        yield "第二段"

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del tools, tool_handler, max_rounds
        chunks = []
        for chunk in self.stream_generate(system=system, user=user):
            chunks.append(chunk)
            if message_handler is not None:
                message_handler(chunk)
        text = "".join(chunks)
        return ChatProviderResult(
            text=text,
            status="completed",
            model=self.model_name,
        )


class FailingStreamingChatProvider(BaseChatProvider):
    model_name = "stream-failing-model"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("streaming chat should not call blocking generate")

    def stream_generate(self, *, system: str, user: str):
        yield "第一段"
        raise RuntimeError("stream broke")

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del tools, tool_handler, max_rounds
        try:
            for chunk in self.stream_generate(system=system, user=user):
                if message_handler is not None:
                    message_handler(chunk)
        except RuntimeError as exc:
            return ChatProviderResult(text="", status="failed", model=self.model_name, error=str(exc))
        return ChatProviderResult(text="", status="completed", model=self.model_name)


class CapturingGeneralChatProvider(BaseChatProvider):
    model_name = "capture-chat-model"

    def __init__(self) -> None:
        self.general_payloads: list[dict] = []

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("general chat should use stream_generate")

    def stream_generate(self, *, system: str, user: str):
        self.general_payloads.append(json.loads(user))
        yield "收到，我会接着前文回答。"

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del tools, tool_handler, max_rounds
        chunks = []
        for chunk in self.stream_generate(system=system, user=user):
            chunks.append(chunk)
            if message_handler is not None:
                message_handler(chunk)
        text = "".join(chunks)
        return ChatProviderResult(
            text=text,
            status="completed",
            model=self.model_name,
        )


class CapturingToolSubjectProvider(FakeChatProvider):
    def __init__(self) -> None:
        super().__init__()
        self.tool_payloads: list[dict] = []

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        self.tool_payloads.append(json.loads(user))
        return super().generate_with_tools(
            system=system,
            user=user,
            tools=tools,
            tool_handler=tool_handler,
            message_handler=message_handler,
            max_rounds=max_rounds,
        )


class SequenceChatProvider(BaseChatProvider):
    model_name = "sequence-model"

    def __init__(self, responses: list[str | None]) -> None:
        self.responses = list(responses)

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        text = self.responses.pop(0) if self.responses else None
        return ChatProviderResult(text=text, status="completed" if text else "fallback", model=self.model_name)

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del system, user, max_rounds
        text = self.responses.pop(0) if self.responses else None
        if not text:
            return ChatProviderResult(text=None, status="fallback", model=self.model_name)
        decision = json_object(text)
        if not isinstance(decision, dict):
            return ChatProviderResult(text=text, status="completed", model=self.model_name)
        available_tool_names = {tool.name for tool in tools}
        tool_names: list[str] = []

        def call(name: str, args: dict) -> dict:
            tool_names.append(name)
            return tool_handler(name, args)

        if "meal_plan.create_draft" in available_tool_names:
            items = decision.get("items") if isinstance(decision.get("items"), list) else []
            if not items and self.responses:
                repaired = json_object(self.responses.pop(0) or "")
                if isinstance(repaired, dict):
                    decision = repaired
                    items = decision.get("items") if isinstance(decision.get("items"), list) else []
            call("inventory.read_expiring_items", {"days": 7})
            call("inventory.read_available_items", {"limit": 80})
            call("meal_log.read_recent", {"limit": 8})
            call("food.search", {"limit": 24})
            call("recipe.search", {"limit": 24})
            call("meal_plan.read_existing", {"limit": 20})
            if not items:
                return self._result(
                    {
                        "text": "餐食计划模型没有生成可用的计划项，请重试。",
                        "cards": [],
                        "events": [],
                        "context_summary": {"scriptValidation": {"valid": False, "errors": ["empty items"]}},
                        "state_patch": {},
                        "requires_clarification": False,
                        "status": "failed",
                        "error": "meal plan items are empty",
                        "operation": decision.get("operation"),
                    },
                    tool_names,
            )
            validation = call("script.validate_meal_plan", {"plan": items})["result"]
            if not validation.get("valid"):
                return self._result(
                    {
                        "text": "餐食计划结构校验失败，请重试。",
                        "cards": [],
                        "events": [],
                        "context_summary": {"scriptValidation": validation},
                        "state_patch": {},
                        "requires_clarification": False,
                        "status": "failed",
                        "error": "meal plan script validation failed",
                        "operation": decision.get("operation"),
                    },
                    tool_names,
                )
            draft = {"draftType": "meal_plan", "schemaVersion": "meal_plan.v1", "items": items, "source": {"days": decision.get("days") or 1, "mealTypes": decision.get("mealTypes") or ["dinner"]}}
            call("meal_plan.create_draft", {"draft": draft})
            return self._result(
                {
                    "text": f"我生成了 {len(items)} 条餐食计划草稿。",
                    "cards": [],
                    "events": [{"type": "draft", "message": "已生成餐食计划草稿"}],
                    "context_summary": {"scriptValidation": validation},
                    "state_patch": {},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                    "operation": decision.get("operation"),
                    "source_artifact_id": decision.get("sourceArtifactId"),
                },
                tool_names,
            )

        if "shopping.create_draft" in available_tool_names:
            call("shopping.read_pending", {"limit": 50})
            call("inventory.read_available_items", {"limit": 80})
            source_id = str(decision.get("sourceArtifactId") or "")
            items = decision.get("items") if isinstance(decision.get("items"), list) else []
            if decision.get("operation") in {"derive", "modify"} and source_id.startswith("missing"):
                return self._result(
                    {
                        "text": "没有找到购物清单所引用的有效草稿。",
                        "cards": [],
                        "events": [],
                        "context_summary": {},
                        "state_patch": {},
                        "requires_clarification": False,
                        "status": "failed",
                        "error": "invalid meal_plan source artifact",
                        "operation": decision.get("operation"),
                        "source_artifact_id": source_id,
                    },
                    tool_names,
                )
            if not items:
                if self.responses:
                    repaired = json_object(self.responses.pop(0) or "")
                    if isinstance(repaired, dict):
                        items = repaired.get("items") if isinstance(repaired.get("items"), list) else []
                        decision = repaired
                if items:
                    draft = {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1", "items": items, "sourceDraftId": source_id or None}
                    call("shopping.create_draft", {"draft": draft})
                    return self._result(
                        {
                            "text": f"我根据餐食计划里的缺失食材合并了 {len(items)} 个购物清单草稿项。",
                            "cards": [],
                            "events": [{"type": "draft", "message": "已生成购物清单草稿"}],
                            "context_summary": {"draftType": "shopping_list"},
                            "state_patch": {},
                            "requires_clarification": False,
                            "status": "completed",
                            "error": None,
                            "operation": decision.get("operation"),
                            "source_artifact_id": source_id,
                        },
                        tool_names,
                    )
                return self._result(
                    {
                        "text": "当前没有需要加入购物清单的项目。",
                        "cards": [],
                        "events": [],
                        "context_summary": {},
                        "state_patch": {},
                        "requires_clarification": False,
                        "status": "completed",
                        "error": "shopping list items are empty",
                        "operation": decision.get("operation"),
                        "source_artifact_id": source_id,
                    },
                    tool_names,
                )
            draft = {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1", "items": items, "sourceDraftId": source_id or None}
            call("shopping.create_draft", {"draft": draft})
            return self._result(
                {
                    "text": f"我根据餐食计划里的缺失食材合并了 {len(items)} 个购物清单草稿项。",
                    "cards": [],
                    "events": [{"type": "draft", "message": "已生成购物清单草稿"}],
                    "context_summary": {"draftType": "shopping_list"},
                    "state_patch": {},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                    "operation": decision.get("operation"),
                    "source_artifact_id": source_id,
                },
                tool_names,
            )
        return ChatProviderResult(text=text, status="completed", model=self.model_name)

    def _result(self, payload: dict, tool_names: list[str]) -> ChatProviderResult:
        payload = {"action": "finalize", **payload}
        return ChatProviderResult(
            text=json.dumps(payload, ensure_ascii=False, default=str),
            status="completed",
            model=self.model_name,
            tool_calls=[{"name": name, "args": {}} for name in tool_names],
        )


class AIAgentInfraTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.workspace_provider_patcher = patch("app.ai.workspace_service.get_chat_provider", return_value=FakeChatProvider())
        self.workspace_provider_patcher.start()
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            future=True,
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(
            bind=self.engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
            class_=Session,
        )

        with self.SessionLocal() as db:
            self.family = Family(id="family-ai", name="AI 测试家庭", motto="", location="")
            self.other_family = Family(id="family-other", name="其他家庭", motto="", location="")
            self.user = User(id="user-ai", username="ai-owner", display_name="AI Owner", avatar_seed="", is_active=True)
            self.membership = Membership(
                id="membership-ai",
                family_id=self.family.id,
                user_id=self.user.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            )
            tomato = Ingredient(
                id="ingredient-tomato",
                family_id=self.family.id,
                name="番茄",
                category="蔬菜",
                default_unit="个",
                unit_conversions=[],
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
            )
            secret = Ingredient(
                id="ingredient-secret",
                family_id=self.other_family.id,
                name="其他家庭牛排",
                category="肉类",
                default_unit="块",
                unit_conversions=[],
                default_storage="冷冻",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
            )
            inventory = InventoryItem(
                id="inventory-tomato",
                family_id=self.family.id,
                ingredient_id=tomato.id,
                quantity=Decimal("3"),
                consumed_quantity=Decimal("0"),
                unit="个",
                status=InventoryStatus.FRESH,
                purchase_date=date.today(),
                expiry_date=date.today() + timedelta(days=2),
                storage_location="冷藏",
                low_stock_threshold=Decimal("0"),
            )
            other_inventory = InventoryItem(
                id="inventory-secret",
                family_id=self.other_family.id,
                ingredient_id=secret.id,
                quantity=Decimal("2"),
                consumed_quantity=Decimal("0"),
                unit="块",
                status=InventoryStatus.FRESH,
                purchase_date=date.today(),
                storage_location="冷冻",
                low_stock_threshold=Decimal("0"),
            )
            food = Food(
                id="food-tomato",
                family_id=self.family.id,
                name="番茄小炒",
                type=FoodType.SELF_MADE,
                category="家常菜",
                flavor_tags=[],
                scene="晚餐",
                notes="",
            )
            ingredient_media = MediaAsset(
                id="media-ingredient-tomato",
                family_id=self.family.id,
                name="番茄",
                url="/media/family/tomato.png",
                file_path="family-ai/tomato.png",
                source=MediaSource.UPLOAD,
                alt="番茄",
                entity_type="ingredient",
                entity_id=tomato.id,
                created_by=self.user.id,
            )
            food_media = MediaAsset(
                id="media-food-tomato",
                family_id=self.family.id,
                name="番茄小炒",
                url="/media/family/tomato-food.png",
                file_path="family-ai/tomato-food.png",
                source=MediaSource.UPLOAD,
                alt="番茄小炒",
                entity_type="food",
                entity_id=food.id,
                created_by=self.user.id,
            )
            db.add_all(
                [
                    self.family,
                    self.other_family,
                    self.user,
                    self.membership,
                    tomato,
                    secret,
                    inventory,
                    other_inventory,
                    food,
                    ingredient_media,
                    food_media,
                ]
            )
            db.commit()

        def override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        def override_auth():
            with self.SessionLocal() as db:
                user = db.get(User, self.user.id)
                membership = db.get(Membership, self.membership.id)
                assert user is not None and membership is not None
                return user, membership

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_auth] = override_auth
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.workspace_provider_patcher.stop()

    def create_family_member(self, *, user_id: str = "user-ai-two") -> tuple[User, Membership]:
        with self.SessionLocal() as db:
            user = User(id=user_id, username=f"{user_id}-login", display_name="家庭成员", avatar_seed="", is_active=True)
            membership = Membership(
                id=f"membership-{user_id}",
                family_id=self.family.id,
                user_id=user.id,
                role=UserRole.MEMBER,
                status=MembershipStatus.ACTIVE,
            )
            db.add_all([user, membership])
            db.commit()
            return user, membership

    def authenticate_as(self, user_id: str, membership_id: str) -> None:
        def override_auth():
            with self.SessionLocal() as db:
                user = db.get(User, user_id)
                membership = db.get(Membership, membership_id)
                assert user is not None and membership is not None
                return user, membership
        app.dependency_overrides[get_current_auth] = override_auth

    def _seed_visibility_run(
        self,
        run_id: str,
        *,
        owner_user_id: str,
        visibility: AIConversationVisibility,
    ) -> AIAgentRun:
        with self.SessionLocal() as db:
            if db.get(User, owner_user_id) is None:
                db.add_all([
                    User(id=owner_user_id, username=owner_user_id, display_name="另一位成员", avatar_seed="", is_active=True),
                    Membership(
                        id=f"membership-{owner_user_id}",
                        family_id=self.family.id,
                        user_id=owner_user_id,
                        role=UserRole.MEMBER,
                        status=MembershipStatus.ACTIVE,
                    ),
                ])
                db.flush()
            conversation = AIConversation(
                id=f"conversation-{run_id}",
                family_id=self.family.id,
                owner_user_id=owner_user_id,
                visibility=visibility,
                mode=AiMode.RECOMMENDATION,
                prompt=run_id,
                response="",
                context={"workspace": True},
                title=run_id,
                summary="",
                status="active",
                created_by=owner_user_id,
            )
            run = AIAgentRun(
                id=run_id,
                family_id=self.family.id,
                conversation_id=conversation.id,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="general_chat",
                input_summary=run_id,
                context_summary={"runMetrics": {}},
                output_summary="",
                status="completed",
                model="fake-model",
                input={},
                output={},
                tool_calls=[],
                created_by=owner_user_id,
            )
            db.add_all([conversation, run])
            db.commit()
            db.refresh(run)
            return run

    def _generate_recipe_draft(
        self,
        db: Session,
        provider: BaseChatProvider,
        *,
        prompt: str,
        subject: dict,
        generate_image: bool = True,
    ) -> dict:
        return AIApplicationService(db, provider=provider).generate_recipe_draft(
            family_id=self.family.id,
            user_id=self.user.id,
            prompt=prompt,
            subject=subject,
            generate_image=generate_image,
        )

    def _add_egg_ingredient(self, db: Session) -> Ingredient:
        ingredient = Ingredient(
            id="ingredient-egg",
            family_id=self.family.id,
            name="鸡蛋",
            category="蛋类",
            default_unit="个",
            unit_conversions=[],
            default_storage="冷藏",
            default_expiry_mode=IngredientExpiryMode.NONE,
            notes="",
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add(ingredient)
        db.flush()
        return ingredient

    def _create_ai_approval_for_test(
        self,
        db: Session,
        *,
        draft_type: str,
        payload: dict,
        suffix: str,
    ) -> tuple[AIApplicationService, AITaskDraft, AIApprovalRequest]:
        service = AIApplicationService(db, provider=FakeChatProvider())
        conversation = service._get_or_create_conversation(
            family_id=self.family.id,
            user_id=self.user.id,
            conversation_id=None,
            prompt=f"AI 审计测试 {suffix}",
            quick_task=None,
        )
        message = AIMessage(
            id=f"ai-message-audit-{suffix}",
            family_id=self.family.id,
            conversation_id=conversation.id,
            role="assistant",
            content="",
            parts=[],
            created_by=self.user.id,
        )
        db.add(message)
        db.flush()
        return (
            service,
            *service._create_draft_approval(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id=conversation.id,
                message_id=message.id,
                run_id=None,
                draft_payload={"draft_type": draft_type, "payload": payload},
            ),
        )

    def _approve_ai_approval_for_test(
        self,
        service: AIApplicationService,
        *,
        draft: AITaskDraft,
        approval: AIApprovalRequest,
    ) -> dict:
        return service._apply_approval_decision(
            family_id=self.family.id,
            user_id=self.user.id,
            conversation_id=approval.conversation_id,
            approval_id=approval.id,
            decision="approved",
            draft_version=draft.version,
            values=approval.initial_values,
        )
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()


class AIEvalContext:
    """Runs deterministic eval cases through the real API, graph runner, and tool registry."""

    EVAL_TODAY = date(2026, 7, 10)
    CLOCK_PATCH_TARGETS = (
        "app.ai.tools.catalog.inventory.today_for_family",
        "app.ai.tools.catalog.meal_ideas.today_for_family",
        "app.ai.tools.catalog.meal_plan.today_for_family",
        "app.ai.tools.catalog.recipe.today_for_family",
        "app.ai.tools.draft_validation.today_for_family",
        "app.services.ai_operations.experience.today_for_family",
        "app.services.ai_operations.inventory.today_for_family",
        "app.services.ai_operations.recipe_cook.today_for_family",
    )

    BUSINESS_MODELS = (
        Ingredient,
        Food,
        Recipe,
        InventoryItem,
        ShoppingListItem,
        FoodPlanItem,
        MealLog,
        RecipeCookLog,
        MediaAsset,
    )
    RELATED_BUSINESS_MODELS = (
        (RecipeIngredient, Recipe, RecipeIngredient.recipe_id),
        (RecipeStep, Recipe, RecipeStep.recipe_id),
        (MealLogFood, MealLog, MealLogFood.meal_log_id),
        (InventoryDeductionSuggestion, MealLog, InventoryDeductionSuggestion.meal_log_id),
    )

    def __init__(self, owner: AIAgentInfraTestCase) -> None:
        self.owner = owner
        self.aliases: dict[str, str] = {}
        self._install_fixtures()

    def _install_fixtures(self) -> None:
        with self.owner.SessionLocal() as db:
            egg = Ingredient(
                id="ingredient-egg-eval",
                family_id=self.owner.family.id,
                name="鸡蛋",
                category="蛋类",
                default_unit="个",
                unit_conversions=[],
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            salt = Ingredient(
                id="ingredient-salt-eval",
                family_id=self.owner.family.id,
                name="盐",
                category="调味",
                default_unit="克",
                unit_conversions=[],
                quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                default_storage="常温",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            lettuce = Ingredient(
                id="ingredient-lettuce-depleted-eval",
                family_id=self.owner.family.id,
                name="生菜",
                category="蔬菜",
                default_unit="棵",
                unit_conversions=[],
                quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
                default_low_stock_threshold=Decimal("1"),
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            salmon = Ingredient(
                id="ingredient-salmon-eval",
                family_id=self.owner.family.id,
                name="三文鱼",
                category="海鲜",
                default_unit="块",
                unit_conversions=[],
                quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            dumpling = Food(
                id="food-dumpling-eval",
                family_id=self.owner.family.id,
                name="速冻饺子",
                type=FoodType.INSTANT,
                category="速食",
                flavor_tags=[],
                scene="晚餐",
                notes="",
                stock_quantity=Decimal("2"),
                stock_unit="袋",
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            milk = Food(
                id="food-milk-eval",
                family_id=self.owner.family.id,
                name="牛奶",
                type=FoodType.PACKAGED,
                category="乳品",
                flavor_tags=[],
                scene="",
                notes="",
                stock_quantity=Decimal("0"),
                stock_unit="盒",
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            other_food = Food(
                id="food-other-eval",
                family_id=self.owner.other_family.id,
                name="其他家庭食物",
                type=FoodType.READY_MADE,
                category="其他",
                flavor_tags=[],
                scene="",
                notes="",
            )
            recipe = Recipe(
                id="recipe-tomato-egg-eval",
                family_id=self.owner.family.id,
                title="番茄炒蛋",
                servings=2,
                prep_minutes=15,
                difficulty=Difficulty.EASY,
                tips="",
                scene_tags=["家常菜"],
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            other_recipe = Recipe(
                id="recipe-other-eval",
                family_id=self.owner.other_family.id,
                title="其他家庭菜谱",
                servings=2,
                prep_minutes=15,
                difficulty=Difficulty.EASY,
                tips="",
                scene_tags=[],
            )
            shopping = ShoppingListItem(
                id="shopping-item-eval",
                family_id=self.owner.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("2"),
                unit="个",
                reason="评估",
                done=False,
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            shopping_egg = ShoppingListItem(
                id="shopping-egg-item-eval",
                family_id=self.owner.family.id,
                ingredient_id=egg.id,
                title="鸡蛋",
                quantity=Decimal("12"),
                unit="个",
                reason="评估小票入库",
                done=False,
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            shopping_salmon = ShoppingListItem(
                id="shopping-salmon-item-eval",
                family_id=self.owner.family.id,
                ingredient_id=salmon.id,
                title="三文鱼",
                quantity=Decimal("1"),
                unit="kg",
                reason="评估小票入库",
                done=False,
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            shopping_food = ShoppingListItem(
                id="shopping-food-item-eval",
                family_id=self.owner.family.id,
                food_id=dumpling.id,
                title="速冻饺子",
                quantity=Decimal("1"),
                unit="袋",
                reason="评估",
                done=False,
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            shopping_milk = ShoppingListItem(
                id="shopping-milk-item-eval",
                family_id=self.owner.family.id,
                food_id=milk.id,
                title="牛奶",
                quantity=Decimal("2"),
                unit="盒",
                reason="评估部分采购",
                done=False,
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            shopping_completed = ShoppingListItem(
                id="shopping-completed-item-eval",
                family_id=self.owner.family.id,
                food_id=dumpling.id,
                title=dumpling.name,
                quantity=Decimal("2"),
                unit="袋",
                reason="评估恢复待买",
                done=True,
                created_by=self.owner.user.id,
                updated_by=self.owner.user.id,
            )
            current_media = MediaAsset(
                id="media-current-eval",
                family_id=self.owner.family.id,
                name="当前图片",
                url="/media/eval/current.png",
                file_path="family-ai/eval-current.png",
                source=MediaSource.UPLOAD,
                alt="当前图片",
                created_by=self.owner.user.id,
            )
            stale_media = MediaAsset(
                id="media-stale-eval",
                family_id=self.owner.family.id,
                name="历史图片",
                url="/media/eval/stale.png",
                file_path="family-ai/eval-stale.png",
                source=MediaSource.UPLOAD,
                alt="历史图片",
                created_by=self.owner.user.id,
            )
            other_media = MediaAsset(
                id="media-other-eval",
                family_id=self.owner.other_family.id,
                name="其他家庭图片",
                url="/media/eval/other.png",
                file_path="family-other/eval-other.png",
                source=MediaSource.UPLOAD,
                alt="其他家庭图片",
            )
            db.add_all([
                egg,
                salt,
                lettuce,
                salmon,
                dumpling,
                milk,
                other_food,
                recipe,
                other_recipe,
                shopping,
                shopping_egg,
                shopping_salmon,
                shopping_food,
                shopping_milk,
                shopping_completed,
                current_media,
                stale_media,
                other_media,
            ])
            db.flush()
            tomato_food = db.get(Food, "food-tomato")
            assert tomato_food is not None
            tomato_food.recipe_id = recipe.id
            db.add_all([
                InventoryItem(id="inventory-egg-eval", family_id=self.owner.family.id, ingredient_id=egg.id, quantity=Decimal("4"), consumed_quantity=Decimal("0"), unit="个", status=InventoryStatus.FRESH, purchase_date=self.EVAL_TODAY, storage_location="冷藏", low_stock_threshold=Decimal("5")),
                InventoryItem(id="inventory-salmon-eval", family_id=self.owner.family.id, ingredient_id=salmon.id, quantity=Decimal("1"), consumed_quantity=Decimal("0"), unit="块", status=InventoryStatus.FRESH, purchase_date=self.EVAL_TODAY, storage_location="冷藏"),
                RecipeIngredient(id="recipe-eval-tomato", recipe_id=recipe.id, ingredient_id="ingredient-tomato", ingredient_name="番茄", quantity=Decimal("2"), unit="个", note="", sort_order=0),
                RecipeIngredient(id="recipe-eval-egg", recipe_id=recipe.id, ingredient_id=egg.id, ingredient_name="鸡蛋", quantity=Decimal("2"), unit="个", note="", sort_order=1),
            ])
            db.commit()
            self.aliases = {
                "tomato": "ingredient-tomato",
                "egg": egg.id,
                "salt": salt.id,
                "depleted_lettuce": lettuce.id,
                "salmon": salmon.id,
                "dumpling": dumpling.id,
                "milk": milk.id,
                "tomato_egg_food": "food-tomato",
                "tomato_egg_recipe": recipe.id,
                "shopping_item": shopping.id,
                "shopping_egg_item": shopping_egg.id,
                "shopping_salmon_item": shopping_salmon.id,
                "shopping_food_item": shopping_food.id,
                "shopping_milk_item": shopping_milk.id,
                "shopping_completed_item": shopping_completed.id,
                "current_media": current_media.id,
                "stale_media": stale_media.id,
                "other_family_ingredient": "ingredient-secret",
                "other_family_food": other_food.id,
                "other_family_recipe": other_recipe.id,
                "other_family_media": other_media.id,
                "unknown_media": "media-unknown-eval",
                "fabricated_id": "ingredient-unknown-eval",
            }

    def resolve_aliases(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {key: self.resolve_aliases(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self.resolve_aliases(item) for item in value]
        if isinstance(value, str) and value.startswith("alias:"):
            alias = value.removeprefix("alias:")
            if alias not in self.aliases:
                raise AssertionError(f"unresolved eval alias: {value}")
            return self.aliases[alias]
        return value

    def _business_snapshot(self, db: Session) -> dict[str, dict[str, tuple[tuple[str, str], ...]]]:
        snapshot: dict[str, dict[str, tuple[tuple[str, str], ...]]] = {}
        for model in self.BUSINESS_MODELS:
            rows = db.scalars(
                select(model).where(
                    model.family_id.in_((self.owner.family.id, self.owner.other_family.id))
                )
            ).all()
            snapshot[model.__tablename__] = {
                str(row.id): tuple(
                    (column.key, repr(getattr(row, column.key)))
                    for column in model.__table__.columns
                )
                for row in rows
            }
        for model, parent_model, foreign_key in self.RELATED_BUSINESS_MODELS:
            rows = db.scalars(
                select(model)
                .join(parent_model, foreign_key == parent_model.id)
                .where(parent_model.family_id.in_((self.owner.family.id, self.owner.other_family.id)))
            ).all()
            snapshot[model.__tablename__] = {
                str(row.id): tuple(
                    (column.key, repr(getattr(row, column.key)))
                    for column in model.__table__.columns
                )
                for row in rows
            }
        return snapshot

    @staticmethod
    def _unexpected_business_write_count(
        before: dict[str, dict[str, tuple[tuple[str, str], ...]]],
        after: dict[str, dict[str, tuple[tuple[str, str], ...]]],
    ) -> int:
        changed = 0
        for table_name in set(before) | set(after):
            before_rows = before.get(table_name, {})
            after_rows = after.get(table_name, {})
            changed += sum(
                before_rows.get(row_id) != after_rows.get(row_id)
                for row_id in set(before_rows) | set(after_rows)
            )
        return changed

    def _error_code_from_runtime(
        self,
        case,
        *,
        runtime_error: str,
        runtime_error_code: str | None = None,
    ) -> str:
        if runtime_error_code:
            return runtime_error_code
        del case, runtime_error
        return "unexpected_runtime_error"

    def arguments_for(self, case, name: str) -> dict[str, Any]:
        subject = self.resolve_aliases(case.subject)
        today = self.EVAL_TODAY.isoformat()
        common = {
            "inventory.read_available_items": {"limit": 80},
            "inventory.read_low_stock_items": {"limit": 80},
            "inventory.read_expiring_items": {"days": 7},
            "ingredient.search": {"query": "番茄", "limit": 10},
            "ingredient.resolve_candidates": {"items": [{"clientKey": "tomato", "name": "番茄"}], "limitPerItem": 5},
            "food.search": {"query": "速冻饺子", "limit": 10},
            "recipe.read_by_id": {"id": subject.get("recipeId") or self.aliases["tomato_egg_recipe"]},
            "food.read_by_id": {"id": subject.get("foodId") or self.aliases["dumpling"]},
            "ingredient.read_by_id": {"id": subject.get("ingredientId") or self.aliases["tomato"]},
            "recipe.preview_cook": {"recipeId": subject.get("recipeId") or self.aliases["tomato_egg_recipe"], "servings": 2},
            "human.request_input": {"question": "请选择具体食物", "inputMode": "choice", "options": [{"id": self.aliases["dumpling"], "label": "速冻饺子"}], "required": True},
            "meal_plan.propose_from_inventory": {"title": "番茄清汤", "ingredientIds": [self.aliases["tomato"]], "reason": "使用现有库存"},
        }
        if name == "shopping.read_pending":
            if case.id.startswith("shopping.complete_to_") or case.id.startswith("inventory."):
                return {"status": "pending", "limit": 50}
            return {
                "query": "速冻饺子",
                "exact": True,
                "status": "completed",
            }
        if name == "purchasable.resolve_candidates":
            if case.id == "shopping.complete_to_food_stock":
                return {"items": [{"clientKey": case.id, "name": "速冻饺子"}]}
            if case.id == "inventory.manual_direct_intake":
                return {"items": [{"clientKey": case.id, "name": "鸡蛋"}]}
            if case.id in {
                "inventory.receipt_mixed_requires_unit_input",
                "inventory.receipt_mixed_creates_one_draft",
            }:
                # Tool input is names only; exact egg/salmon/milk fixtures exist so
                # the real resolver can return exact matches for scripted drafts.
                return {
                    "items": [
                        {"clientKey": "line-egg", "name": "鸡蛋"},
                        {"clientKey": "line-salmon", "name": "三文鱼"},
                        {"clientKey": "line-milk", "name": "牛奶"},
                        {"clientKey": "line-bag", "name": "垃圾袋"},
                    ]
                }
            if case.id in {
                "inventory.purchase_source_disambiguation",
                "inventory.partial_purchase_keeps_remainder",
            }:
                return {"items": [{"clientKey": case.id, "name": "牛奶"}]}
            if case.id == "inventory.gift_ignores_pending_shopping":
                return {"items": [{"clientKey": case.id, "name": "番茄"}]}
            if case.id == "inventory.date_conflict_requests_input":
                return {"items": [{"clientKey": case.id, "name": "番茄"}]}
            return {"items": [{"clientKey": case.id, "name": "番茄"}]}
        if name == "human.request_input":
            if case.id == "inventory.purchase_source_disambiguation":
                return {
                    "question": "牛奶是关联采购清单还是直接入库？",
                    "inputMode": "choice",
                    "options": [
                        {"id": "link_shopping", "label": "关联采购清单"},
                        {"id": "direct", "label": "直接入库"},
                    ],
                    "allowMultiple": False,
                    "required": True,
                    "sourceSkills": ["inventory_analysis"],
                    "resumeHint": {"questionType": "inventory_intake_resolution"},
                }
            if case.id == "inventory.receipt_mixed_requires_unit_input":
                continuation_state = {
                    "sourceType": "receipt_image",
                    "sourceReference": {
                        "mediaId": subject.get("mediaId") or self.aliases["current_media"]
                    },
                    "purchaseIntent": "purchase",
                    "dateEvidence": {
                        "userDate": None,
                        "userSaidToday": False,
                        "receiptDate": today,
                    },
                    "intakeDate": today,
                    "intakeDateSource": "receipt",
                    "lines": [
                        {
                            "sourceLineId": "line-egg",
                            "sourceOrder": 0,
                            "rawText": "鸡蛋 12个",
                            "name": "鸡蛋",
                            "quantity": "12",
                            "unit": "个",
                            "itemKind": "inventory",
                            "targetHint": "ingredient",
                            "resolvedSourceKind": "shopping_item",
                            "selectedShoppingItemId": self.aliases["shopping_egg_item"],
                            "selectedTargetKind": "exact_ingredient",
                            "selectedTargetId": self.aliases["egg"],
                            "confirmedAction": "stock_and_fulfill",
                            "confirmedQuantity": "12",
                            "confirmedUnit": "个",
                            "disposition": "ready",
                        },
                        {
                            "sourceLineId": "line-salmon",
                            "sourceOrder": 1,
                            "rawText": "三文鱼 1kg",
                            "name": "三文鱼",
                            "quantity": "1",
                            "unit": "kg",
                            "itemKind": "inventory",
                            "targetHint": "ingredient",
                            "resolvedSourceKind": "shopping_item",
                            "selectedShoppingItemId": self.aliases["shopping_salmon_item"],
                            "selectedTargetKind": "exact_ingredient",
                            "selectedTargetId": self.aliases["salmon"],
                            "disposition": "pending",
                        },
                        {
                            "sourceLineId": "line-milk",
                            "sourceOrder": 2,
                            "rawText": "牛奶 1盒",
                            "name": "牛奶",
                            "quantity": "1",
                            "unit": "盒",
                            "itemKind": "inventory",
                            "targetHint": "food",
                            "resolvedSourceKind": "direct",
                            "selectedTargetKind": "food",
                            "selectedTargetId": self.aliases["milk"],
                            "confirmedAction": "stock_only",
                            "confirmedQuantity": "1",
                            "confirmedUnit": "盒",
                            "disposition": "ready",
                        },
                        {
                            "sourceLineId": "line-bag",
                            "sourceOrder": 3,
                            "rawText": "垃圾袋",
                            "name": "垃圾袋",
                            "itemKind": "non_inventory",
                            "disposition": "ignored",
                        },
                    ],
                    "ignoredItems": [
                        {
                            "sourceLineId": "line-bag",
                            "reasonCode": "non_inventory_item",
                            "reason": "非食品库存对象，本次不会入库",
                        }
                    ],
                    "currentBlocker": {
                        "sourceLineId": "line-salmon",
                        "reasonCode": "unit_mismatch",
                    },
                    "pendingBlockers": [
                        {
                            "sourceLineId": "line-salmon",
                            "reasonCode": "conversion_quantity_missing",
                        }
                    ],
                }
                return {
                    "question": "三文鱼按公斤识别，但当前库存单位是块。这次要怎样处理？",
                    "inputMode": "choice",
                    "options": [
                        {"id": "convert_once", "label": "提供本次换算"},
                        {"id": "fulfill_without_stock", "label": "只完成采购项，不入库"},
                        {"id": "skip", "label": "本次跳过"},
                    ],
                    "allowMultiple": False,
                    "required": True,
                    "sourceSkills": ["inventory_analysis"],
                    "resumeHint": {
                        "questionType": "inventory_intake_resolution",
                        "stateSchema": "inventory_intake_continuation.v1",
                        "state": continuation_state,
                    },
                }
            if case.id == "inventory.date_conflict_requests_input":
                return {
                    "question": "小票日期与你说的今天不一致，以哪个日期入库？",
                    "inputMode": "choice",
                    "options": [
                        {"id": "user_today", "label": "按今天"},
                        {"id": "receipt_date", "label": "按小票日期"},
                    ],
                    "allowMultiple": False,
                    "required": True,
                    "sourceSkills": ["inventory_analysis"],
                    "resumeHint": {"questionType": "inventory_intake_resolution"},
                }
            return common["human.request_input"]
        if name in common:
            return common[name]
        continuation_tool = {
            "recipe.cook_shortage": "shopping.create_draft",
            "food.create_to_meal_plan": "food_profile.create_draft",
            "continuation.missing_ingredient_resume": "ingredient_profile.create_draft",
        }.get(case.id)
        continuation = self._continuation_for(case) if name == continuation_tool else None
        if name == "shopping.create_draft":
            if case.id in {"shopping.low_stock_remaining", "shopping.low_stock_zero"}:
                ingredient_id = (
                    self.aliases["egg"]
                    if case.id == "shopping.low_stock_remaining"
                    else self.aliases["depleted_lettuce"]
                )
                with self.owner.SessionLocal() as db:
                    ingredient = db.get(Ingredient, ingredient_id)
                if ingredient is None:
                    raise AssertionError(f"{case.id}: low-stock Ingredient fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "shopping_list",
                        "schemaVersion": "shopping_list.v1",
                        "items": [
                            {
                                "title": ingredient.name,
                                "ingredientId": ingredient.id,
                                "quantity": 1,
                                "unit": ingredient.default_unit,
                                "reason": "低库存补货",
                            }
                        ],
                    }
                }
            elif case.id == "shopping.restore_completed":
                shopping_item_id = str(subject.get("shoppingItemId") or self.aliases["shopping_completed_item"])
                with self.owner.SessionLocal() as db:
                    shopping_item = db.get(ShoppingListItem, shopping_item_id)
                if shopping_item is None:
                    raise AssertionError(f"{case.id}: completed shopping fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "shopping_list",
                        "schemaVersion": "shopping_list_operation.v1",
                        "operations": [
                            {
                                "action": "set_done",
                                "targetId": shopping_item.id,
                                "baseUpdatedAt": shopping_item.updated_at.isoformat(),
                                "payload": {"done": False, "reason": "恢复待买"},
                            }
                        ],
                    }
                }
            else:
                payload = {"draft": {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1", "items": [{"title": "番茄", "ingredientId": self.aliases["tomato"], "quantity": 1, "unit": "个"}]}}
        elif name == "inventory.create_intake_draft":
            if case.id == "inventory.manual_direct_intake":
                with self.owner.SessionLocal() as db:
                    ingredient = db.get(Ingredient, self.aliases["egg"])
                if ingredient is None:
                    raise AssertionError(f"{case.id}: egg Ingredient fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "manual_text",
                        "sourceReference": {},
                        "intakeDate": today,
                        "intakeDateSource": "user_explicit",
                        "items": [
                            {
                                "lineId": f"line-{case.id}",
                                "sourceLineId": case.id,
                                "sourceText": "鸡蛋 12个",
                                "sourceKind": "direct",
                                "action": "stock_only",
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "12",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            }
                        ],
                        "ignoredItems": [],
                    }
                }
            elif case.id == "inventory.gift_ignores_pending_shopping":
                with self.owner.SessionLocal() as db:
                    ingredient = db.get(Ingredient, self.aliases["tomato"])
                if ingredient is None:
                    raise AssertionError(f"{case.id}: tomato Ingredient fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "gift",
                        "sourceReference": {},
                        "intakeDate": today,
                        "intakeDateSource": "user_explicit",
                        "items": [
                            {
                                "lineId": f"line-{case.id}",
                                "sourceLineId": case.id,
                                "sourceText": "番茄 2个",
                                "sourceKind": "direct",
                                "action": "stock_only",
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "朋友赠送",
                            }
                        ],
                        "ignoredItems": [],
                    }
                }
            elif case.id == "inventory.partial_purchase_keeps_remainder":
                shopping_item_id = str(subject.get("shoppingItemId") or self.aliases["shopping_milk_item"])
                with self.owner.SessionLocal() as db:
                    shopping_item = db.get(ShoppingListItem, shopping_item_id)
                    if shopping_item is None:
                        raise AssertionError(f"{case.id}: shopping fixture is missing")
                    if shopping_item.food_id:
                        target = db.get(Food, shopping_item.food_id)
                        target_kind = "food"
                    else:
                        target = db.get(Ingredient, shopping_item.ingredient_id)
                        target_kind = "exact_ingredient"
                if target is None:
                    raise AssertionError(f"{case.id}: shopping target fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "manual_text",
                        "sourceReference": {},
                        "intakeDate": today,
                        "intakeDateSource": "user_explicit",
                        "items": [
                            {
                                "lineId": f"line-{case.id}",
                                "sourceLineId": case.id,
                                "sourceText": shopping_item.title,
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": shopping_item.id,
                                "targetKind": target_kind,
                                "targetId": target.id,
                                "enteredQuantity": "1",
                                "enteredUnit": shopping_item.unit,
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "部分采购",
                            }
                        ],
                        "ignoredItems": [],
                    }
                }
            elif case.id == "inventory.receipt_mixed_creates_one_draft":
                with self.owner.SessionLocal() as db:
                    egg = db.get(Ingredient, self.aliases["egg"])
                    salmon = db.get(Ingredient, self.aliases["salmon"])
                    milk = db.get(Food, self.aliases["milk"])
                    shopping_egg = db.get(ShoppingListItem, self.aliases["shopping_egg_item"])
                    shopping_salmon = db.get(ShoppingListItem, self.aliases["shopping_salmon_item"])
                if (
                    egg is None
                    or salmon is None
                    or milk is None
                    or shopping_egg is None
                    or shopping_salmon is None
                ):
                    raise AssertionError(f"{case.id}: mixed intake fixtures missing")
                payload = {
                    "draft": {
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "receipt_image",
                        "sourceReference": {
                            "mediaId": subject.get("mediaId") or self.aliases["current_media"]
                        },
                        "intakeDate": today,
                        "intakeDateSource": "receipt",
                        "items": [
                            {
                                "lineId": "line-egg",
                                "sourceLineId": "line-egg",
                                "sourceText": "鸡蛋 12个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": shopping_egg.id,
                                "targetKind": "exact_ingredient",
                                "targetId": egg.id,
                                "enteredQuantity": "12",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            },
                            {
                                "lineId": "line-salmon",
                                "sourceLineId": "line-salmon",
                                "sourceText": "三文鱼 1kg",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": shopping_salmon.id,
                                "targetKind": "exact_ingredient",
                                "targetId": salmon.id,
                                "enteredQuantity": "1",
                                "enteredUnit": "kg",
                                "packageConversion": {
                                    "ratio": "2",
                                    "targetUnit": "块",
                                    "evidence": "user_confirmed_once",
                                },
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            },
                            {
                                "lineId": "line-milk",
                                "sourceLineId": "line-milk",
                                "sourceText": "牛奶 1盒",
                                "sourceKind": "direct",
                                "action": "stock_only",
                                "targetKind": "food",
                                "targetId": milk.id,
                                "enteredQuantity": "1",
                                "enteredUnit": "盒",
                                "storageLocation": "冷藏",
                                "notes": "",
                            },
                        ],
                        "ignoredItems": [
                            {
                                "sourceLineId": "line-bag",
                                "sourceText": "垃圾袋",
                                "displayName": "垃圾袋",
                                "reasonCode": "non_inventory_item",
                                "reason": "非食品库存对象，本次不会入库",
                            }
                        ],
                    }
                }
            elif case.id.startswith("shopping.complete_to_"):
                shopping_item_id = str(subject.get("shoppingItemId") or self.aliases["shopping_item"])
                with self.owner.SessionLocal() as db:
                    shopping_item = db.get(ShoppingListItem, shopping_item_id)
                    if shopping_item is None:
                        raise AssertionError(f"{case.id}: shopping fixture is missing")
                    if shopping_item.food_id:
                        target = db.get(Food, shopping_item.food_id)
                        target_kind = "food"
                    else:
                        target = db.get(Ingredient, shopping_item.ingredient_id)
                        target_kind = "exact_ingredient"
                if target is None:
                    raise AssertionError(f"{case.id}: shopping target fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "manual_text",
                        "sourceReference": {},
                        "intakeDate": today,
                        "intakeDateSource": "user_explicit",
                        "items": [
                            {
                                "lineId": f"line-{case.id}",
                                "sourceLineId": case.id,
                                "sourceText": shopping_item.title,
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": shopping_item.id,
                                "targetKind": target_kind,
                                "targetId": target.id,
                                "enteredQuantity": "1" if target_kind == "food" else "2",
                                "enteredUnit": shopping_item.unit,
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            }
                        ],
                        "ignoredItems": [],
                    }
                }
            else:
                with self.owner.SessionLocal() as db:
                    ingredient = db.get(Ingredient, self.aliases["tomato"])
                if ingredient is None:
                    raise AssertionError(f"{case.id}: tomato Ingredient fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "receipt_image",
                        "sourceReference": {"mediaId": subject.get("mediaId") or self.aliases["current_media"]},
                        "intakeDate": today,
                        "intakeDateSource": "receipt",
                        "items": [
                            {
                                "lineId": f"line-{case.id}",
                                "sourceLineId": case.id,
                                "sourceText": "番茄 2个",
                                "sourceKind": "direct",
                                "action": "stock_only",
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            }
                        ],
                        "ignoredItems": [],
                    }
                }
        elif name == "recipe.create_draft":
            step = {"title": "烹饪", "text": "中火烹饪并观察成熟状态，确认熟透后盛出。", "icon": "pan", "summary": "烹饪", "estimated_minutes": 5, "tip": "注意火候", "key_points": ["熟透"]}
            ingredient_items = [{"ingredient_id": self.aliases["tomato"], "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""}]
            if case.id == "continuation.missing_ingredient_resume":
                with self.owner.SessionLocal() as db:
                    created_ingredient = db.scalar(
                        select(Ingredient)
                        .where(
                            Ingredient.family_id == self.owner.family.id,
                            Ingredient.name == f"评估食材-{case.id}",
                        )
                        .order_by(Ingredient.created_at.desc())
                    )
                if created_ingredient is None:
                    raise AssertionError(f"{case.id}: approved Ingredient was not persisted before resume")
                ingredient_items.append(
                    {
                        "ingredient_id": created_ingredient.id,
                        "ingredient_name": created_ingredient.name,
                        "quantity": 1,
                        "unit": created_ingredient.default_unit,
                        "note": "审批后恢复",
                    }
                )
            payload = {"draft": {"title": "番茄炒蛋评估", "servings": 2, "prep_minutes": 15, "difficulty": "easy", "ingredient_items": ingredient_items, "steps": [step, {**step, "title": "翻炒"}, {**step, "title": "装盘"}], "media_ids": [subject["mediaId"]] if subject.get("mediaId") else []}}
        elif name == "meal_plan.create_draft":
            recipe_id = subject.get("recipeId")
            planned_food_id = subject.get("foodId")
            if case.id == "food.create_to_meal_plan":
                with self.owner.SessionLocal() as db:
                    created_food = db.scalar(
                        select(Food)
                        .where(
                            Food.family_id == self.owner.family.id,
                            Food.name == f"评估食物-{case.id}",
                        )
                        .order_by(Food.created_at.desc())
                    )
                if created_food is None:
                    raise AssertionError(f"{case.id}: approved Food was not persisted before resume")
                planned_food_id = created_food.id
            planned_item = {
                "date": today,
                "mealType": "dinner",
                "title": "番茄小炒",
                "reason": "评估",
                "usedInventory": [],
                "missingIngredients": [],
            }
            if recipe_id:
                planned_item["foodId"] = self.aliases["tomato_egg_food"]
                planned_item["recipeId"] = recipe_id
            else:
                planned_item["foodId"] = planned_food_id or "food-tomato"
            payload = {
                "draft": {
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "items": [planned_item],
                    "source": {"days": 1, "mealTypes": ["dinner"]},
                }
            }
        elif name == "meal_log.create_draft":
            food_id = subject.get("foodId") or "food-tomato"
            deduct_stock = case.id == "meal.log_ready_food_deduct"
            food_entry = {
                "foodId": food_id,
                "name": "速冻饺子" if food_id == self.aliases["dumpling"] else "番茄小炒",
                "servings": 1,
                "note": "",
                "deductStock": deduct_stock,
            }
            if deduct_stock:
                food_entry.update({"stockQuantity": "1", "stockUnit": "袋"})
            payload = {"draft": {"draftType": "meal_log", "schemaVersion": "meal_log.v1", "date": today, "mealType": "dinner", "foods": [food_entry], "notes": "评估"}}
        elif name == "food_profile.create_draft":
            if case.id == "shopping.complete_to_food_stock":
                with self.owner.SessionLocal() as db:
                    food = db.get(Food, self.aliases["dumpling"])
                if food is None:
                    raise AssertionError(f"{case.id}: food fixture is missing")
                payload = {
                    "draft": {
                        "draftType": "food_profile",
                        "schemaVersion": "food_profile_operation.v1",
                        "action": "update",
                        "targetId": food.id,
                        "baseUpdatedAt": food.updated_at.isoformat(),
                        "payload": {
                            "name": food.name,
                            "type": food.type.value if hasattr(food.type, "value") else str(food.type),
                            "category": food.category,
                            "stock_quantity": float(Decimal(str(food.stock_quantity or 0)) + Decimal("1")),
                            "stock_unit": "袋",
                        },
                    }
                }
            else:
                payload = {"draft": {"draftType": "food_profile", "schemaVersion": "food_profile.v1", "name": f"评估食物-{case.id}", "type": "readyMade", "category": "速食"}}
        elif name == "ingredient_profile.create_draft":
            payload = {"draft": {"draftType": "ingredient_profile", "schemaVersion": "ingredient_profile.v1", "action": "create", "payload": {"name": f"评估食材-{case.id}", "category": "蔬菜", "default_unit": "个", "default_storage": "冷藏", "default_expiry_mode": "none"}}}
        elif name == "recipe.create_cook_draft":
            payload = {"draft": {"draftType": "recipe_cook", "schemaVersion": "recipe_cook_operation.v2", "recipeId": self.aliases["tomato_egg_recipe"], "servings": 2}}
        elif name == "ui.propose_actions":
            return {"surface": "recipe_cook_page", "recipeId": self.aliases["tomato_egg_recipe"], "actions": [{"type": "go_next_step"}]}
        elif name == "inventory.create_operation_draft":
            payload = {
                "draft": {
                    "draftType": "inventory_operation",
                    "schemaVersion": "inventory_operation.v1",
                    "operations": [
                        {
                            "action": "dispose",
                            "ingredientId": self.aliases["tomato"],
                            "ingredientName": "番茄",
                            "inventoryItemId": self.aliases.get("tomato_inventory", "inventory-tomato"),
                            "quantity": 1,
                            "unit": "个",
                            "reason": "评估销毁",
                        }
                    ],
                }
            }
        else:
            raise AssertionError(f"missing eval arguments for {case.id}: {name}")
        if continuation:
            payload["continuation"] = continuation
        return payload

    def _continuation_for(self, case) -> dict[str, Any] | None:
        schema = case.expectedContinuationSchema
        if not schema:
            return None
        mapping = {
            "recipe_shortage_to_shopping.v1": ("recipe_shortage", "shopping_list", "shopping_list", "shopping_list", {"recipeId": self.aliases["tomato_egg_recipe"], "shortages": [{"ingredientId": self.aliases["egg"], "ingredientName": "鸡蛋", "shortageType": "quantity", "quantity": "2", "unit": "个"}]}),
            "food_to_meal_plan.v1": ("plan_after_create", "meal_plan", "meal_plan", "meal_plan", {"targetDate": self.EVAL_TODAY.isoformat(), "mealType": "dinner", "instruction": "安排晚餐"}),
            "recipe_missing_ingredient.v1": ("missing_ingredient", "ingredient_profile", "recipe_draft", "ingredient_profile", {"recipeTitle": "番茄炒蛋", "currentIngredient": "鸡蛋", "pendingIngredientNames": [], "completedIngredientIds": [self.aliases["tomato"]]}),
            "inventory_intake_missing_target.v1": (
                "missing_intake_target",
                "ingredient_profile",
                "inventory_analysis",
                "ingredient_profile",
                {
                    "sourceType": "receipt_image",
                    "sourceReference": {"mediaId": self.aliases["current_media"]},
                    "purchaseIntent": "purchase",
                    "dateEvidence": {
                        "userDate": None,
                        "userSaidToday": False,
                        "receiptDate": self.EVAL_TODAY.isoformat(),
                    },
                    "intakeDate": self.EVAL_TODAY.isoformat(),
                    "intakeDateSource": "receipt",
                    "lines": [
                        {
                            "sourceLineId": "line-missing",
                            "sourceOrder": 0,
                            "rawText": "海带结",
                            "name": "海带结",
                            "itemKind": "inventory",
                            "disposition": "missing_target",
                        }
                    ],
                    "ignoredItems": [],
                    "currentBlocker": {
                        "sourceLineId": "line-missing",
                        "reasonCode": "target_missing",
                    },
                    "pendingBlockers": [],
                    "currentMissingSourceLineId": "line-missing",
                },
            ),
        }
        reason, next_skill, resume_skill, draft_type, state = mapping[schema]
        return {"workflowId": f"eval-{case.id}", "stepKey": "draft", "reasonCode": reason, "nextSkillKey": next_skill, "resumeSkillKey": resume_skill, "requiredDraftType": draft_type, "stateSchema": schema, "state": state}

    def run_case(self, case):
        from app.ai.evals.models import SkillEvalObservation
        from app.ai.evals.scripted_provider import ScriptedEvalProvider

        if case.id in {"recipe.image_create", "attachment.current_recipe"}:
            with self.owner.SessionLocal() as db:
                fresh_id = f"media-current-{case.id.replace('.', '-')}-eval"
                db.add(MediaAsset(id=fresh_id, family_id=self.owner.family.id, name="当前评估图片", url=f"/media/eval/{fresh_id}.png", file_path=f"family-ai/{fresh_id}.png", source=MediaSource.UPLOAD, alt="当前图片", created_by=self.owner.user.id))
                db.commit()
                self.aliases["current_media"] = fresh_id
        script = list(case.script)
        if case.id == "continuation.missing_ingredient_resume":
            script = [{"inject": "recipe_draft"}, *script]
        if case.id == "cooking.next_step":
            script = [entry for entry in script if entry.get("inject") != "cooking_assistant"]
        provider = ScriptedEvalProvider(script, argument_resolver=lambda name: self.arguments_for(case, name))
        provider.supports_vision = True
        request: dict[str, Any] = {"message": case.message, "quick_task": case.quickTask}
        if case.id == "cooking.next_step":
            subject = self.resolve_aliases(case.subject)
            subject["extra"] = {
                "surface": "recipe_cook_page",
                "cookSessionId": "cook-session-eval",
                "sessionRevision": 1,
            }
            request["subject"] = subject
            request["quick_task"] = "cooking_assistant"
        if case.id in {"recipe.image_create", "attachment.current_recipe"}:
            request["quick_task"] = "recipe_draft"
        if case.id in {"recipe.image_create", "attachment.current_recipe"}:
            request["attachments"] = [{"type": "image", "media_id": self.aliases["current_media"], "client_attachment_id": case.id}]
        with self.owner.SessionLocal() as db:
            before = self._business_snapshot(db)
        egg_inventory = None
        if case.id == "recipe.cook_shortage":
            with self.owner.SessionLocal() as db:
                egg_inventory = db.get(InventoryItem, "inventory-egg-eval")
                assert egg_inventory is not None
                egg_inventory.consumed_quantity = egg_inventory.quantity
                db.commit()
        with ExitStack() as stack:
            stack.enter_context(patch("app.ai.workspace_service.get_chat_provider", return_value=provider))
            stack.enter_context(
                patch(
                    "app.ai.workflows.runner_support.orchestrator_context.read_media_object_for_ai",
                    return_value=(b"eval-image", "image/png"),
                )
            )
            for target in self.CLOCK_PATCH_TARGETS:
                stack.enter_context(patch(target, return_value=self.EVAL_TODAY))
            # Capable client is required to generate recipe_cook.v2 drafts.
            response = self.owner.client.post(
                "/api/ai/chat",
                json=request,
                headers={"X-Culina-AI-Draft-Contracts": "recipe_cook_operation.v2"},
            )
            if any(entry.get("resume") is True for entry in script):
                initial_payload = response.json()
                approvals = initial_payload.get("included", {}).get("approvals", [])
                if len(approvals) != 1:
                    raise AssertionError(f"{case.id}: expected one approval before continuation resume")
                approval = approvals[0]
                with self.owner.client.stream(
                    "POST",
                    (
                        f"/api/ai/conversations/{initial_payload['conversation_id']}"
                        f"/approvals/{approval['id']}/decision/stream"
                    ),
                    json={
                        "decision": "approved",
                        "draft_version": approval["draft_version"],
                        "values": approval["initial_values"],
                    },
                ) as stream_response:
                    if stream_response.status_code != 200:
                        raise AssertionError(
                            f"{case.id}: continuation approval failed: "
                            f"{stream_response.status_code} {''.join(stream_response.iter_text())}"
                        )
                    "".join(stream_response.iter_text())
        provider.assert_consumed()
        if case.id == "recipe.cook_shortage":
            with self.owner.SessionLocal() as db:
                restored = db.get(InventoryItem, "inventory-egg-eval")
                assert restored is not None
                restored.consumed_quantity = Decimal("0")
                db.commit()
        if response.status_code != 200:
            raise AssertionError(f"{case.id}: runtime request failed: {response.status_code} {response.text}")
        payload = response.json()
        run_id = payload["run"]["id"]
        with self.owner.SessionLocal() as db:
            run = db.get(AIAgentRun, run_id)
            assert run is not None
            drafts = list(db.scalars(select(AITaskDraft).where(AITaskDraft.source_run_id == run_id).order_by(AITaskDraft.created_at)))
            messages = list(
                db.scalars(
                    select(AIMessage)
                    .where(AIMessage.run_id == run_id)
                    .order_by(AIMessage.created_at, AIMessage.id)
                )
            )
            after = self._business_snapshot(db)
            spans = list(db.scalars(select(AIRunTraceSpan).where(AIRunTraceSpan.run_id == run_id).order_by(AIRunTraceSpan.started_at, AIRunTraceSpan.id)))
            checkpoint = SQLAlchemyCheckpointSaver(db).get_tuple(
                {"configurable": {"thread_id": payload["conversation_id"]}}
            )
            checkpoint_values = checkpoint.checkpoint["channel_values"] if checkpoint is not None else {}
            run_artifacts = checkpoint_values.get("run_artifacts") if isinstance(checkpoint_values, dict) else []
        summary = run.context_summary if isinstance(run.context_summary, dict) else {}
        routing = summary.get("routing") if isinstance(summary.get("routing"), dict) else {}
        orchestrator = summary.get("orchestrator") if isinstance(summary.get("orchestrator"), dict) else {}
        skills = [str(item) for item in routing.get("skills", [])]
        if not skills:
            skills = [str(item) for item in orchestrator.get("injectedSkills", [])]
        if not skills:
            traced_skills: list[str] = []
            for span in spans:
                if span.span_type != "skill_injection" or not isinstance(span.payload, dict):
                    continue
                for key in ("added", "alreadyInjected", "requested"):
                    values = span.payload.get(key)
                    if not isinstance(values, list):
                        continue
                    for value in values:
                        skill_key = str(value).strip()
                        if skill_key and skill_key not in traced_skills:
                            traced_skills.append(skill_key)
            skills = traced_skills
        tools = [span.name for span in spans if span.span_type == "tool_call"]
        if not tools:
            tools = [str(item.get("name") or "") for item in run.tool_calls if isinstance(item, dict)]
        draft = drafts[-1] if drafts else None
        continuation = draft.ai_metadata.get("continuation") if draft and isinstance(draft.ai_metadata, dict) else None
        if not isinstance(continuation, dict) and isinstance(run_artifacts, list):
            continuation_artifact = next(
                (
                    artifact
                    for artifact in reversed(run_artifacts)
                    if isinstance(artifact, dict) and artifact.get("type") == "workflow.continuation"
                ),
                None,
            )
            continuation = (
                continuation_artifact.get("payload")
                if isinstance(continuation_artifact, dict)
                and isinstance(continuation_artifact.get("payload"), dict)
                else None
            )
        terminal = str(run.status)
        if terminal == "waiting_input":
            terminal = "waiting_human_input"
        error_code = None
        if provider.last_error is not None:
            terminal = "rejected"
            error_code = self._error_code_from_runtime(
                case,
                runtime_error=str(run.error or provider.last_error),
                runtime_error_code=str(getattr(provider.last_error, "code", "") or "") or None,
            )
        unexpected_writes = self._unexpected_business_write_count(before, after)
        card_types = [
            str(part["card"]["type"])
            for message in messages
            for part in (message.parts or [])
            if isinstance(part, dict)
            and part.get("type") == "result_card"
            and isinstance(part.get("card"), dict)
            and part["card"].get("type")
        ]
        return SkillEvalObservation(
            schemaVersion="skill_eval_observation.v1",
            caseId=case.id,
            source="scripted",
            skills=skills,
            tools=tools,
            toolOutputs=provider.tool_outputs,
            cardTypes=list(dict.fromkeys(card_types)),
            draftType=draft.draft_type if draft else None,
            draftPayload=draft.payload if draft and isinstance(draft.payload, dict) else {},
            continuationSchema=str(continuation.get("stateSchema")) if isinstance(continuation, dict) else None,
            continuationCompleted=int((summary.get("runMetrics") or {}).get("continuationCompletedCount") or 0) > 0,
            terminalStatus=terminal,
            draftValidationAttempts=(
                1
                if int((summary.get("runMetrics") or {}).get("draftValidationCandidateCount") or 0) > 0
                and int((summary.get("runMetrics") or {}).get("draftValidationAttemptCount") or 0)
                == int((summary.get("runMetrics") or {}).get("draftValidationCandidateCount") or 0)
                and int((summary.get("runMetrics") or {}).get("draftFirstPassSuccessCount") or 0)
                == int((summary.get("runMetrics") or {}).get("draftValidationCandidateCount") or 0)
                else int((summary.get("runMetrics") or {}).get("draftValidationAttemptCount") or 0)
            ),
            invalidIdentityWriteCount=(
                unexpected_writes
                if case.expectsIdentityRejection or case.expectedErrorCode is not None
                else 0
            ),
            errorCode=error_code,
        )
