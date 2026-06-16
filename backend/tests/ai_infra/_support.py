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

from app.ai.kitchen.recipe_drafts import build_recipe_image_render_payload
from app.ai.planning import PlannerRequest, PlannerResult, WorkspacePlanner
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult, DisabledChatProvider, OpenAICompatibleChatProvider
from app.ai.skills import BaseSkill, SkillContext, SkillDirectoryLoader, SkillExecutor, SkillManifest, SkillRegistry, SkillResult, SkillScriptCatalog, SkillScriptExecutor, ToolCallingSkill, build_workspace_skill_registry
from app.ai.skills.shared import json_object
from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from app.ai.tools.draft_validation import normalize_inventory_operation_draft
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.ai.workflows.runner import WorkspaceGraphRunner
from app.ai.workflows.timeline import build_planner_conversation
from app.core.deps import get_current_auth
from app.core.enums import AiMode, Difficulty, FoodType, ImageGenerationMode, IngredientExpiryMode, InventoryStatus, MealType, MediaEntityType, MediaSource, MembershipStatus, UserRole
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
    ShoppingListItem,
    User,
)
from app.ai.images.generation import ImageGenerationRequest, ImageProviderConfig, OpenAIImageGenerationProvider, build_ai_image_prompt, _build_provider_config
from app.services.inventory_operations import dispose_inventory_quantity
from app.services.inventory_usage import remaining_quantity
from app.services.clock import today_for_family
from app.services.ai_operations.approval_config import DRAFT_APPROVAL_CONFIG, approval_config_for_payload
from app.services.ai_operations.composite import (
    build_composite_operation_step_previews,
    composite_execution_order,
    execute_composite_operation_plan,
    resolve_composite_step_operation,
    validate_composite_operation_plan,
)
from app.services.ai_operations.drafts import validate_inventory_operation_shape


class FakeChatProvider(BaseChatProvider):
    model_name = "fake-model"

    def __init__(self, text: str | None = None) -> None:
        self.text = text or "模型回答：优先处理库存并安排清淡晚餐。"

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        if "工作台的 Planner" in system:
            payload = json.loads(user)
            message = str(payload.get("conversation", [])[-1].get("content") or "")
            if "购物" in message or "采购" in message or "补货" in message:
                skills = ["meal_plan", "shopping_list"] if any(term in message for term in ["安排", "三天", "晚餐"]) else ["shopping_list"]
            elif any(term in message for term in ["菜单", "安排", "三天", "晚餐", "第二天", "清淡"]):
                skills = ["meal_plan"]
            elif any(term in message for term in ["菜谱", "做法"]):
                skills = ["recipe_draft"]
            elif any(term in message for term in ["记录餐食", "今晚吃了", "今天吃了"]):
                skills = ["meal_log"]
            elif any(term in message for term in ["食材档案", "新增食材", "食材资料"]):
                skills = ["ingredient_profile"]
            elif any(term in message for term in ["食物资料", "整理食物"]):
                skills = ["food_profile"]
            elif any(term in message for term in ["库存", "临期", "快过期"]):
                skills = ["inventory_analysis"]
            elif any(term in message for term in ["今日吃什么", "今天吃什么", "今晚吃什么"]):
                skills = ["meal_plan"]
            else:
                skills = []
            return ChatProviderResult(text=json.dumps({"skills": skills}), status="completed", model=self.model_name)
        if "Markdown Skill Runner" in system:
            payload = json.loads(user)
            inventory = payload.get("toolOutputs", {}).get("inventory.read_summary", {})
            available_count = inventory.get("availableCount", 0)
            expiring_count = inventory.get("expiringCount", 0)
            low_stock_count = inventory.get("lowStockCount", 0)
            return ChatProviderResult(
                text=json.dumps(
                    {
                        "text": f"当前可用库存 {available_count} 项，临期 {expiring_count} 项，低库存 {low_stock_count} 项。",
                        "cards": [
                            {
                                "id": "inventory-summary",
                                "type": "inventory_summary",
                                "title": "库存概览",
                                "data": inventory,
                            }
                        ],
                        "events": [{"type": "tool", "message": "已读取库存摘要"}],
                        "context_summary": {
                            "inventoryItemCount": available_count,
                            "expiringItemCount": expiring_count,
                            "lowStockItemCount": low_stock_count,
                        },
                        "state_patch": {},
                        "requires_clarification": False,
                        "status": "completed",
                        "error": None,
                    },
                    ensure_ascii=False,
                ),
                status="completed",
                model=self.model_name,
            )
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
        tools: list,
        tool_handler,
        response_schema: dict | None = None,
        max_rounds: int = 8,
        visible_text_handler=None,
    ) -> ChatProviderResult:
        del system, response_schema, max_rounds
        payload = json.loads(user)
        message = str(payload.get("currentMessage") or "")
        quick_task = payload.get("quickTask")
        available_tool_names = {tool.name for tool in tools}
        tool_names: list[str] = []
        recommendation_mode = quick_task == "today_recommendation" or (
            any(term in message for term in ["今日吃什么", "今天吃什么", "今晚吃什么", "推荐一餐"])
            and not any(term in message for term in ["安排", "计划", "菜单", "制定", "修改", "第二天", "三天"])
        )

        def emit_visible(text: str) -> None:
            if visible_text_handler is not None:
                visible_text_handler(f"<visible_text>{text}</visible_text>")

        def call(name: str, args: dict | None = None) -> dict:
            tool_names.append(name)
            return tool_handler(name, args or {})

        if "meal_plan.create_draft" in available_tool_names and not recommendation_mode:
            emit_visible("我先看一下临期食材和最近餐食。")
            inventory = call("inventory.read_expiring_items", {"days": 7})
            call("inventory.read_available_items", {"limit": 80})
            call("meal_log.read_recent", {"limit": 8})
            call("food.search", {"limit": 24})
            call("recipe.search", {"limit": 24})
            call("meal_plan.read_existing", {"limit": 20})
            artifacts = [artifact for artifact in payload.get("artifacts", []) if artifact.get("type") == "meal_plan"]
            operation = "modify" if artifacts or "第二天" in message else "create"
            source_id = artifacts[-1]["id"] if artifacts else None
            if "帮我做菜单" in message:
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
            if operation == "modify" and artifacts:
                source_items = artifacts[-1].get("payload", {}).get("items", [])
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
            call("meal_plan.create_draft", {"draft": draft})
            emit_visible(f"我生成了 {len(items)} 条餐食计划草稿。")
            return self._tool_result(
                {
                    "text": f"我生成了 {len(items)} 条餐食计划草稿。",
                    "cards": [],
                    "events": [{"type": "draft", "message": "已生成餐食计划草稿"}],
                    "context_summary": {
                        "expiringItemCount": inventory.get("count", 0),
                        "draftType": "meal_plan",
                        "scriptValidation": validation,
                    },
                    "state_patch": {"activeTask": "meal_plan", "activeDraftType": "meal_plan"},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                    "operation": operation,
                    "source_artifact_id": source_id,
                },
                tool_names,
            )

        if "shopping.create_draft" in available_tool_names:
            emit_visible("我先核对已有购物项和可用库存。")
            pending = call("shopping.read_pending", {"limit": 50})
            call("inventory.read_available_items", {"limit": 80})
            plans = [artifact for artifact in payload.get("artifacts", []) if artifact.get("type") == "meal_plan"]
            source_id = plans[-1]["id"] if plans else None
            items = [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "用于番茄鸡蛋面", "sourceMeals": ["番茄鸡蛋面"], "alreadyPending": False}]
            canonical_title = call("script.normalize_ingredient", {"name": items[0]["title"]})["result"]
            merged_items = call("script.merge_ingredients", {"items": items})["result"]
            items = [
                {
                    **item,
                    "title": canonical_title if index == 0 else item["title"],
                    "reason": "用于番茄鸡蛋面",
                    "sourceMeals": ["番茄鸡蛋面"],
                    "alreadyPending": False,
                }
                for index, item in enumerate(merged_items)
            ]
            draft = {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1", "items": items, "sourceDraftId": source_id}
            call("shopping.create_draft", {"draft": draft})
            emit_visible("我根据餐食计划里的缺失食材合并了 1 个购物清单草稿项。")
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

        if "recipe.create_draft" in available_tool_names:
            emit_visible("我先查一下可用食材。")
            call("ingredient.search", {"limit": 50})
            draft = self._recipe_draft_from_text()
            call("recipe.create_draft", {"draft": draft})
            emit_visible(f"我生成了《{draft.get('title', '菜谱草稿')}》的菜谱草稿。")
            return self._tool_result(
                {
                    "text": f"我生成了《{draft.get('title', '菜谱草稿')}》的菜谱草稿。",
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
            matched = next((food for food in foods if food.get("name") and food["name"] in message), None)
            name = matched["name"] if matched else message.replace("今晚吃了", "").replace("今天吃了", "").strip(" ，。")
            draft = {"draftType": "meal_log", "schemaVersion": "meal_log.v1", "date": date.today().isoformat(), "mealType": "dinner", "foods": [{"foodId": matched["id"] if matched else None, "name": name, "servings": 1, "note": "从用户描述中整理"}], "notes": message}
            call("meal_log.create_draft", {"draft": draft})
            emit_visible("我整理了餐食记录草稿。")
            return self._tool_result(
                {"text": "我整理了餐食记录草稿。", "cards": [], "events": [], "context_summary": {"draftType": "meal_log"}, "state_patch": {}, "requires_clarification": False, "status": "completed", "error": None, "operation": "create"},
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
            draft = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile.v1",
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
            }
            call("food_profile.create_draft", {"draft": draft})
            emit_visible(f"我整理了「{draft['name']}」的食物资料草稿。")
            return self._tool_result(
                {"text": f"我整理了「{draft['name']}」的食物资料草稿。", "cards": [], "events": [], "context_summary": {"draftType": "food_profile"}, "state_patch": {}, "requires_clarification": False, "status": "completed", "error": None, "operation": "create"},
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
            emit_visible(f"我整理了「{draft['payload']['name']}」的食材档案草稿。")
            return self._tool_result(
                {
                    "text": f"我整理了「{draft['payload']['name']}」的食材档案草稿。",
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
                    "cards": [{"id": "inventory-summary", "type": "inventory_summary", "title": "库存概览", "data": summary}],
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

        if "recipe.search" in available_tool_names and "meal_log.read_recent" in available_tool_names:
            emit_visible("我先看一下库存、菜谱和最近餐食。")
            inventory = call("inventory.read_available_items", {"limit": 50})
            expiring = call("inventory.read_expiring_items", {"days": 7})
            recipes = call("recipe.search", {"limit": 12})
            foods = call("food.search", {"limit": 12})
            recent = call("meal_log.read_recent", {"limit": 5})
            food_candidates = [item for item in foods.get("items", [])[:3] if item.get("id")]
            recipe_candidates = [item for item in recipes.get("items", [])[:3] if item.get("id")]
            candidates = (
                [{"foodId": item["id"]} for item in food_candidates]
                or [{"recipeId": item["id"]} for item in recipe_candidates]
            )
            card = {
                "id": "today-recommendation",
                "type": "today_recommendation",
                "title": "今日吃什么",
                "data": {
                    "recommendations": [{**candidate, "reason": "优先使用当前库存。", "evidence": expiring.get("items", [])[:1]} for candidate in candidates[:3]],
                    "contextSummary": {
                        "inventoryCount": inventory.get("count", 0),
                        "expiringCount": expiring.get("count", 0),
                        "recentMealCount": recent.get("count", 0),
                        "recipeCount": recipes.get("count", 0),
                    },
                },
            }
            emit_visible("我按当前库存和最近餐食整理了今天的建议。")
            return self._tool_result(
                {
                    "text": "我按当前库存和最近餐食整理了今天的建议。",
                    "cards": [card],
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

    def _tool_result(self, payload: dict, tool_names: list[str]) -> ChatProviderResult:
        return ChatProviderResult(
            text=json.dumps(payload, ensure_ascii=False, default=str),
            status="completed",
            model=self.model_name,
            structured_mode="tool_call",
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

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        if "工作台的 Planner" in system:
            return ChatProviderResult(text='{"skills":[]}', status="completed", model=self.model_name)
        raise AssertionError("streaming chat should not call blocking generate")

    def stream_generate(self, *, system: str, user: str, response_schema: dict | None = None):
        yield "第一段"
        yield "第二段"


class FailingStreamingChatProvider(BaseChatProvider):
    model_name = "stream-failing-model"

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        if "工作台的 Planner" in system:
            return ChatProviderResult(text='{"skills":[]}', status="completed", model=self.model_name)
        raise AssertionError("streaming chat should not call blocking generate")

    def stream_generate(self, *, system: str, user: str, response_schema: dict | None = None):
        yield "第一段"
        raise RuntimeError("stream broke")


class CapturingGeneralChatProvider(BaseChatProvider):
    model_name = "capture-chat-model"

    def __init__(self) -> None:
        self.general_payloads: list[dict] = []

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        if "工作台的 Planner" in system:
            return ChatProviderResult(text='{"skills":[]}', status="completed", model=self.model_name)
        raise AssertionError("general chat should use stream_generate")

    def stream_generate(self, *, system: str, user: str, response_schema: dict | None = None):
        self.general_payloads.append(json.loads(user))
        yield "收到，我会接着前文回答。"


class CapturingToolSubjectProvider(FakeChatProvider):
    def __init__(self) -> None:
        super().__init__()
        self.tool_payloads: list[dict] = []

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools: list,
        tool_handler,
        response_schema: dict | None = None,
        max_rounds: int = 8,
        visible_text_handler=None,
    ) -> ChatProviderResult:
        self.tool_payloads.append(json.loads(user))
        return super().generate_with_tools(
            system=system,
            user=user,
            tools=tools,
            tool_handler=tool_handler,
            response_schema=response_schema,
            max_rounds=max_rounds,
            visible_text_handler=visible_text_handler,
        )


class SequenceChatProvider(BaseChatProvider):
    model_name = "sequence-model"

    def __init__(self, responses: list[str | None]) -> None:
        self.responses = list(responses)

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        text = self.responses.pop(0) if self.responses else None
        return ChatProviderResult(text=text, status="completed" if text else "fallback", model=self.model_name)

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools: list,
        tool_handler,
        response_schema: dict | None = None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del system, user, response_schema, max_rounds
        text = self.responses.pop(0) if self.responses else None
        if not text:
            return ChatProviderResult(text=None, status="fallback", model=self.model_name)
        decision = json_object(text)
        if not isinstance(decision, dict):
            return ChatProviderResult(text=text, status="completed", model=self.model_name, structured_mode="tool_call")
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
        return ChatProviderResult(text=text, status="completed", model=self.model_name, structured_mode="tool_call")

    def _result(self, payload: dict, tool_names: list[str]) -> ChatProviderResult:
        return ChatProviderResult(
            text=json.dumps(payload, ensure_ascii=False, default=str),
            status="completed",
            model=self.model_name,
            structured_mode="tool_call",
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

