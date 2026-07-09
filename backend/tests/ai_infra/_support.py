from __future__ import annotations

import base64
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
from sqlalchemy import select
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
from app.core.enums import AiMode, Difficulty, FoodType, ImageGenerationMode, IngredientExpiryMode, IngredientQuantityTrackingMode, InventoryStatus, MealType, MediaEntityType, MediaSource, MembershipStatus, UserRole
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
    AITaskDraft,
    AIUserApproval,
    Base,
    Family,
    Food,
    FoodPlanItem,
    Ingredient,
    InventoryItem,
    MealLog,
    MealLogFood,
    MediaAsset,
    Membership,
    Recipe,
    RecipeCookLog,
    RecipeFavorite,
    RecipeIngredient,
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

        resume_next_draft_type = ""
        if is_orchestrator:
            resume_next_draft_type = self._resume_next_draft_type(payload)
            skills = [resume_next_draft_type] if resume_next_draft_type else self._orchestrator_skills_for_message(message, quick_task)
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

        if "meal_plan.create_draft" in available_tool_names and not recommendation_mode and resume_next_draft_type != "meal_log":
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
            if any(term in message for term in ["购物", "采购", "补货"]):
                draft_args["afterApproval"] = {
                    "continue": True,
                    "instruction": "确认餐食计划后，继续根据计划生成购物清单草稿。",
                    "nextDraftType": "shopping_list",
                }
            if self._wants_meal_log_after_plan(message) or self._resume_final_draft_type(payload) == "meal_log":
                draft_args["afterApproval"] = {
                    "instruction": "确认餐食计划后，继续创建用餐记录；如确认结果里有真实计划项 ID，优先把 meal_log 关联到 planItemId。",
                    "nextDraftType": "meal_log",
                    "taskState": {"finalDraftType": "meal_log", "targetFoodName": planned_food_name},
                }
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
                task_state = {"targetFoodName": name, "targetMealType": "dinner"}
                if self._wants_meal_log_after_plan(message):
                    instruction = "确认食物资料后，继续用该食物创建今天晚餐的餐食计划；计划确认后再创建用餐记录并尽量关联计划项。"
                    task_state["finalDraftType"] = "meal_log"
                draft_args["afterApproval"] = {
                    "instruction": instruction,
                    "nextDraftType": "meal_plan",
                    "taskState": task_state,
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
            return ["food_profile"]
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

    def _resume_next_draft_type(self, payload: dict) -> str:
        artifacts = self._resume_artifacts(payload)
        for artifact in reversed(artifacts):
            next_draft_type = artifact.get("nextDraftType")
            if isinstance(next_draft_type, str) and next_draft_type in {"meal_plan", "meal_log", "shopping_list"}:
                return next_draft_type
        return ""

    def _resume_final_draft_type(self, payload: dict) -> str:
        for artifact in reversed(self._resume_artifacts(payload)):
            task_state = artifact.get("taskState") if isinstance(artifact.get("taskState"), dict) else {}
            final_draft_type = task_state.get("finalDraftType")
            if isinstance(final_draft_type, str):
                return final_draft_type
        return ""

    def _resume_artifacts(self, payload: dict) -> list[dict]:
        return [
            artifact.get("payload") or {}
            for key in ("artifacts", "currentRunArtifacts")
            for artifact in (payload.get(key) if isinstance(payload.get(key), list) else [])
            if isinstance(artifact, dict)
            and artifact.get("type") == "draft_after_approval"
            and isinstance(artifact.get("payload"), dict)
        ]

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
        has_resume_after_approval = any(
            artifact.get("type") == "draft_after_approval"
            and "购物" in str(artifact.get("payload") or {})
            for artifact in artifacts
        )
        has_shopping_output = any(artifact.get("type") == "shopping_list" for artifact in artifacts)
        return has_resume_after_approval and has_meal_plan_decision and not has_shopping_output

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
