from __future__ import annotations

import base64
import json
import tempfile
import unittest
from datetime import date, timedelta
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
from app.ai.workspace_service import AIApplicationService, DRAFT_APPROVAL_CONFIG
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.core.deps import get_current_auth
from app.core.enums import AiMode, Difficulty, FoodType, ImageGenerationMode, IngredientExpiryMode, InventoryStatus, MealType, MediaEntityType, MediaSource, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIGraphCheckpoint,
    AIGraphWrite,
    AIMessage,
    AIOperation,
    AIRunEvent,
    AITaskDraft,
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
    RecipeIngredient,
    ShoppingListItem,
    User,
)
from app.ai.images.generation import ImageGenerationRequest, ImageProviderConfig, OpenAIImageGenerationProvider, build_ai_image_prompt, _build_provider_config
from app.services.inventory_operations import dispose_inventory_quantity
from app.services.inventory_usage import remaining_quantity


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
            card = {"id": "shopping-list-draft", "type": "shopping_list_draft", "title": "购物清单草稿", "data": {"draft": draft, "items": items, "summary": "1 个待确认采购项"}}
            return self._tool_result(
                {
                    "text": "我根据餐食计划里的缺失食材合并了 1 个购物清单草稿项。",
                    "cards": [card],
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
            card = {"id": "recipe-draft", "type": "recipe_draft", "title": draft.get("title", "菜谱草稿"), "data": {"draft": draft}}
            return self._tool_result(
                {
                    "text": f"我生成了《{draft.get('title', '菜谱草稿')}》的菜谱草稿。",
                    "cards": [card],
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
            card = {"id": "meal-log-draft", "type": "meal_log_draft", "title": "餐食记录草稿", "data": {"draft": draft}}
            return self._tool_result(
                {"text": "我整理了餐食记录草稿。", "cards": [card], "events": [], "context_summary": {"draftType": "meal_log"}, "state_patch": {}, "requires_clarification": False, "status": "completed", "error": None, "operation": "create"},
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
            card = {"id": "food-profile-draft", "type": "food_profile_draft", "title": draft["name"], "data": {"draft": draft}}
            return self._tool_result(
                {"text": f"我整理了「{draft['name']}」的食物资料草稿。", "cards": [card], "events": [], "context_summary": {"draftType": "food_profile"}, "state_patch": {}, "requires_clarification": False, "status": "completed", "error": None, "operation": "create"},
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
                            "cards": [{"id": "shopping-list-draft", "type": "shopping_list_draft", "title": "购物清单草稿", "data": {"draft": draft, "items": items}}],
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
                    "cards": [{"id": "shopping-list-draft", "type": "shopping_list_draft", "title": "购物清单草稿", "data": {"draft": draft, "items": items}}],
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
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_disabled_provider_returns_fallback_without_network(self) -> None:
        result = DisabledChatProvider(model_name="test-model").generate(system="s", user="u")
        self.assertIsNone(result.text)
        self.assertEqual(result.status, "fallback")
        self.assertEqual(result.model, "test-model")

    def test_sqlalchemy_checkpointer_roundtrip_writes_thread_isolation_and_delete(self) -> None:
        with self.SessionLocal() as db:
            saver = SQLAlchemyCheckpointSaver(db)
            checkpoint = empty_checkpoint()
            checkpoint["id"] = "checkpoint-1"
            checkpoint["channel_values"] = {"state": {"step": 1}}
            config = {"configurable": {"thread_id": "conversation-1"}}
            saved_config = saver.put(
                config,
                checkpoint,
                {"source": "input", "step": 1, "parents": {}},
                {},
            )
            saver.put_writes(saved_config, [("custom", {"pending": True})], "task-1", "skill_step")

            stored = saver.get_tuple(config)
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(stored.checkpoint["channel_values"]["state"], {"step": 1})
            self.assertEqual(stored.pending_writes, [("task-1", "custom", {"pending": True})])
            self.assertIsNone(saver.get_tuple({"configurable": {"thread_id": "conversation-2"}}))
            self.assertEqual(len(list(saver.list(config))), 1)

            saver.delete_thread("conversation-1")
            self.assertIsNone(saver.get_tuple(config))
            self.assertEqual(db.query(AIGraphCheckpoint).count(), 0)
            self.assertEqual(db.query(AIGraphWrite).count(), 0)

    def test_ai_workspace_disabled_provider_returns_planner_failure_without_business_fallback(self) -> None:
        with patch(
            "app.ai.workspace_service.get_chat_provider",
            return_value=DisabledChatProvider(model_name="disabled-model"),
        ):
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["intent"], "planner_failed")
        self.assertEqual(data["run"]["status"], "failed")
        self.assertEqual(data["included"]["drafts"], [])
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.tool_calls, [])
            self.assertEqual(run.context_summary["routing"]["plannerAttempts"], 2)

    def test_context_tools_are_family_scoped(self) -> None:
        with self.SessionLocal() as db:
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            output = executor.call("inventory.read_available_items", {"limit": 50})
        output_text = str(output)
        self.assertIn("番茄", output_text)
        self.assertNotIn("其他家庭牛排", output_text)

    def test_phase_a_planner_creates_composite_skill_steps(self) -> None:
        skill_registry = build_workspace_skill_registry()
        planner = WorkspacePlanner(provider=FakeChatProvider(), skill_registry=skill_registry)
        plan = planner.plan(
            PlannerRequest(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation=[
                    {
                        "id": "message-test",
                        "role": "user",
                        "content": "用快过期食材安排三天晚餐，顺便生成购物清单",
                        "artifacts": [],
                    }
                ],
                available_skills=[manifest.to_planner_record() for manifest in skill_registry.list_manifests()],
            )
        )
        self.assertEqual(plan.skills, ["meal_plan", "shopping_list"])
        self.assertEqual(plan.attempts, 1)

    def test_skill_catalog_scans_skill_markdown_and_enforces_platform_contracts(self) -> None:
        import yaml

        skills_dir = Path(__file__).resolve().parents[1] / "app" / "ai" / "skills" / "catalog"
        skill_registry = build_workspace_skill_registry()
        tool_registry = build_workspace_tool_registry()
        tool_names = {tool.name for tool in tool_registry.list()}
        skill_dirs = sorted(
            path
            for path in skills_dir.iterdir()
            if path.is_dir() and not path.name.startswith("__")
        )
        records = []
        for skill_dir in skill_dirs:
            skill_markdown = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
            self.assertTrue(skill_markdown.startswith("---\n"))
            frontmatter = yaml.safe_load(skill_markdown.split("---\n", 2)[1])
            slug = frontmatter["name"]
            key = frontmatter.get("key") or slug.replace("-", "_")
            records.append((key, frontmatter))
            self.assertEqual(skill_dir.name, slug)
            self.assertIn("description", frontmatter)
            declared_tool_names = frontmatter.get("allowed_tools", [])
            self.assertTrue(set(declared_tool_names).issubset(tool_names), f"{key} declares unknown tools")
            declared_tools = [tool_registry.get(name) for name in declared_tool_names]
            approval_policy = frontmatter.get("approval_policy")
            self.assertIn(approval_policy, {"none", "draft_then_confirm"})
            if approval_policy == "none":
                self.assertTrue(all(tool.side_effect == "read" for tool in declared_tools), f"{key} exposes non-read tools without approval")
                self.assertEqual(frontmatter.get("draft_types", []), [])
            else:
                self.assertTrue(frontmatter.get("draft_types", []), f"{key} requires approval but declares no draft type")
                self.assertTrue(any(tool.side_effect == "draft" for tool in declared_tools), f"{key} requires approval but exposes no draft tool")
                self.assertTrue(set(frontmatter["draft_types"]).issubset(DRAFT_APPROVAL_CONFIG), f"{key} declares unsupported draft types")
            self.assertFalse(any(tool.side_effect == "write" for tool in declared_tools), f"{key} must not expose write tools")

        keys = [key for key, _frontmatter in records]
        self.assertEqual(
            keys,
            ["food_profile", "inventory_analysis", "meal_plan", "meal_log", "recipe_draft", "shopping_list"],
        )
        self.assertEqual(skill_registry.keys(), set(keys))
        self.assertEqual([manifest.key for manifest in skill_registry.list_manifests()], keys)
        self.assertNotIn("general_chat", skill_registry.keys())
        self.assertNotIn("today_recommendation", skill_registry.keys())
        self.assertIsInstance(skill_registry.get("inventory_analysis"), ToolCallingSkill)

    def test_ai_registry_endpoint_exposes_skill_and_tool_contracts(self) -> None:
        response = self.client.get("/api/ai/registry")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        skills = {item["key"]: item for item in data["skills"]}
        tools = {item["name"]: item for item in data["tools"]}

        self.assertEqual(len(skills), 6)
        self.assertNotIn("today_recommendation", skills)
        self.assertIn("today_recommendation", skills["meal_plan"]["output_types"])
        self.assertIn("meal_log", skills)
        self.assertEqual(skills["meal_log"]["runner"], "toolcall")
        self.assertEqual(skills["meal_log"]["context_policy"], ["foods", "meal_logs"])
        self.assertIn("meal_log.create_draft", skills["meal_log"]["tools"])
        self.assertEqual(
            skills["meal_plan"]["scripts"],
            ["script.validate_meal_plan", "script.render_plan_preview"],
        )
        self.assertEqual(
            skills["shopping_list"]["scripts"],
            ["script.merge_ingredients", "script.normalize_ingredient"],
        )
        self.assertIn("ingredient.search", skills["recipe_draft"]["tools"])
        self.assertEqual(tools["ingredient.search"]["display_name"], "食材资料")
        self.assertEqual(tools["ingredient.search"]["side_effect"], "read")
        self.assertEqual(tools["meal_log.create_draft"]["display_name"], "餐食记录确认表单")
        self.assertEqual(tools["meal_log.create_draft"]["permission"], "family:draft")
        self.assertEqual(tools["meal_log.create_draft"]["side_effect"], "draft")
        self.assertNotIn("shopping_list.create_draft", tools)
        self.assertEqual(
            tools["meal_log.create_draft"]["input_schema"]["properties"]["draft"]["properties"]["draftType"]["enum"],
            ["meal_log"],
        )

    def test_skill_loader_uses_unified_toolcall_runner_without_skill_python_entrypoint(self) -> None:
        skill_registry = build_workspace_skill_registry()
        self.assertEqual(skill_registry.get("meal_plan").manifest.runner, "toolcall")
        self.assertIsInstance(skill_registry.get("meal_plan"), ToolCallingSkill)
        self.assertFalse(any(Path(__file__).resolve().parents[1].glob("app/ai/skills/catalog/*/skill.py")))

    def test_skill_loader_accepts_markdown_only_skill_without_python_entrypoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            catalog_dir = Path(tmp_dir)
            skill_dir = catalog_dir / "simple-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: simple-skill\n"
                "display_name: 简单 Skill\n"
                "description: Markdown only.\n"
                "approval_policy: none\n"
                "---\n",
                encoding="utf-8",
            )
            skills = SkillDirectoryLoader(catalog_dir).load()
            self.assertEqual(len(skills), 1)
            self.assertIsInstance(skills[0], ToolCallingSkill)

    def test_skill_loader_includes_conventional_workflow_without_frontmatter_noise(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            catalog_dir = Path(tmp_dir)
            skill_dir = catalog_dir / "simple-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: simple-skill\n"
                "display_name: 简单 Skill\n"
                "description: Markdown only.\n"
                "approval_policy: none\n"
                "---\n"
                "# Root\n\nBody instructions.\n",
                encoding="utf-8",
            )
            (skill_dir / "workflows.md").write_text("workflow content", encoding="utf-8")
            skills = SkillDirectoryLoader(catalog_dir).load()
            self.assertIsInstance(skills[0], ToolCallingSkill)
            instructions = skills[0].instructions
            self.assertIn("Body instructions.", instructions)
            self.assertIn("workflow content", instructions)
            self.assertNotIn("name: simple-skill", instructions)

    def test_skill_loader_exposes_declared_scripts_as_model_tools(self) -> None:
        skill = build_workspace_skill_registry().get("meal_plan")
        definitions = {
            definition.name: definition
            for definition in SkillScriptExecutor(
                skill.script_catalog,
                SkillContext(
                    db=MagicMock(),
                    family_id="family-test",
                    user_id="user-test",
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="",
                    tool_executor=MagicMock(),
                ),
            ).tool_definitions()
        }

        self.assertEqual(
            set(definitions),
            {"script.validate_meal_plan", "script.render_plan_preview"},
        )
        self.assertEqual(
            definitions["script.validate_meal_plan"].input_schema["required"],
            ["plan"],
        )
        self.assertEqual(
            definitions["script.render_plan_preview"].output_schema["properties"]["result"]["type"],
            "string",
        )
        self.assertEqual(
            definitions["script.validate_meal_plan"].permission,
            "skill:script",
        )

    def test_skill_loader_rejects_unsafe_script_imports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            catalog_dir = Path(tmp_dir)
            skill_dir = catalog_dir / "unsafe-skill"
            scripts_dir = skill_dir / "scripts"
            scripts_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: unsafe-skill\n"
                "description: Unsafe script.\n"
                "script_files: [scripts/unsafe.py]\n"
                "approval_policy: none\n"
                "---\n",
                encoding="utf-8",
            )
            (scripts_dir / "unsafe.py").write_text(
                "import os\n\n"
                "def inspect_environment() -> dict:\n"
                "    return dict(os.environ)\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "unsupported import"):
                SkillDirectoryLoader(catalog_dir).load()

    def test_skill_script_executor_times_out_and_records_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            skill_dir = Path(tmp_dir) / "slow-skill"
            scripts_dir = skill_dir / "scripts"
            scripts_dir.mkdir(parents=True)
            (scripts_dir / "slow.py").write_text(
                "def wait_forever() -> dict:\n"
                "    while True:\n"
                "        pass\n",
                encoding="utf-8",
            )
            catalog = SkillScriptCatalog(skill_dir, ["scripts/slow.py"])
            executor = SkillScriptExecutor(
                catalog,
                SkillContext(
                    db=MagicMock(),
                    family_id="family-test",
                    user_id="user-test",
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="",
                    tool_executor=MagicMock(),
                ),
                timeout_seconds=0.05,
            )

            with self.assertRaisesRegex(RuntimeError, "timed out"):
                executor.call("script.wait_forever", {})

            self.assertEqual(executor.records()[0]["status"], "failed")

    def test_tool_calling_skill_executes_script_through_model_tool_handler(self) -> None:
        class ScriptCallingProvider(BaseChatProvider):
            model_name = "script-calling-model"

            def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                raise AssertionError("tool-calling skill should use generate_with_tools")

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
                self.assert_script_is_exposed = "script.validate_meal_plan" in {
                    tool.name for tool in tools
                }
                validation = tool_handler(
                    "script.validate_meal_plan",
                    {
                        "plan": [
                            {
                                "date": date.today().isoformat(),
                                "mealType": "dinner",
                                "title": "番茄小炒",
                                "foodId": "food-tomato",
                            }
                        ]
                    },
                )["result"]
                return ChatProviderResult(
                    text=json.dumps(
                        {
                            "text": "计划结构检查完成。",
                            "cards": [],
                            "drafts": [],
                            "events": [],
                            "context_summary": {"scriptValidation": validation},
                            "state_patch": {},
                            "requires_clarification": False,
                            "status": "completed",
                            "error": None,
                        },
                        ensure_ascii=False,
                    ),
                    status="completed",
                    model=self.model_name,
                    structured_mode="tool_call",
                )

        provider = ScriptCallingProvider()
        progress_events: list[dict] = []
        skill = build_workspace_skill_registry().get("meal_plan")
        with self.SessionLocal() as db:
            result = skill.run(
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="检查这个餐食计划",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-test",
                            run_id="run-test",
                        ),
                    ),
                    provider=provider,
                    stream_writer=progress_events.append,
                )
            )

        self.assertTrue(provider.assert_script_is_exposed)
        self.assertEqual(result.context_summary["scriptValidation"], {"valid": True, "errors": []})
        self.assertEqual(result.tool_calls[0]["name"], "script.validate_meal_plan")
        self.assertTrue(
            any(
                event.get("data", {}).get("type") == "script"
                for event in progress_events
            )
        )

    def test_skill_loader_rejects_unknown_allowed_tool_when_registry_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            catalog_dir = Path(tmp_dir)
            skill_dir = catalog_dir / "bad-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: bad-skill\n"
                "description: Invalid.\n"
                "allowed_tools: [inventory.not_a_real_tool]\n"
                "approval_policy: none\n"
                "---\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "unknown allowed tool"):
                SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

    def test_skill_loader_rejects_draft_tool_without_approval_when_registry_is_available(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            catalog_dir = Path(tmp_dir)
            skill_dir = catalog_dir / "bad-skill"
            skill_dir.mkdir()
            (skill_dir / "SKILL.md").write_text(
                "---\n"
                "name: bad-skill\n"
                "description: Invalid.\n"
                "allowed_tools: [shopping.create_draft]\n"
                "approval_policy: none\n"
                "---\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "exposes non-read tools without approval"):
                SkillDirectoryLoader(catalog_dir, tool_registry=build_workspace_tool_registry()).load()

    def test_skill_loader_rejects_directory_missing_required_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            catalog_dir = Path(tmp_dir)
            skill_dir = catalog_dir / "broken_skill"
            skill_dir.mkdir()
            with self.assertRaises(FileNotFoundError):
                SkillDirectoryLoader(catalog_dir).load()

    def test_skill_executor_scopes_tools_to_skill_manifest(self) -> None:
        class UndeclaredToolSkill(BaseSkill):
            def run(self, context: SkillContext) -> SkillResult:
                context.tool_executor.call("inventory.read_available_items", {"limit": 10})
                return SkillResult(text="should not reach")

        manifest = SkillManifest(
            key="limited_skill",
            name="受限 Skill",
            description="测试工具边界。",
            examples=[],
            context_policy=[],
            tools=["inventory.read_summary"],
            output_types=[],
            draft_types=[],
            approval_policy="none",
            can_continue_from=[],
            intent="limited",
            agent_key="limited_agent",
        )
        registry = SkillRegistry()
        registry.register(UndeclaredToolSkill(manifest))
        with self.SessionLocal() as db:
            result = SkillExecutor(registry).run(
                PlannerResult(skills=["limited_skill"]),
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="测试",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-test",
                            run_id="run-test",
                        ),
                    ),
                    provider=FakeChatProvider(),
                ),
            )

        self.assertEqual(result.status, "failed")
        self.assertIn("受限 Skill执行失败", result.text)
        self.assertIn("未声明工具", result.context_summary["skillExecutions"][0]["diagnostic"])

    def test_skill_executor_rejects_forbidden_tool_calls_even_when_allowed(self) -> None:
        with self.SessionLocal() as db:
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            ).scoped(
                allowed_tools={"inventory.read_available_items"},
                forbidden_tools={"inventory.read_available_items"},
                allowed_side_effects={"read"},
            )
            with self.assertRaisesRegex(PermissionError, "禁止调用工具"):
                executor.call("inventory.read_available_items", {"limit": 10})

    def test_skill_executor_rejects_undeclared_draft_results(self) -> None:
        class BadDraftSkill(BaseSkill):
            def run(self, context: SkillContext) -> SkillResult:
                return SkillResult(text="bad", drafts=[{"draft_type": "meal_plan", "payload": {}}])

        manifest = SkillManifest(
            key="bad_draft_skill",
            name="坏草稿 Skill",
            description="测试草稿契约。",
            approval_policy="none",
            intent="bad_draft",
            agent_key="bad_draft_agent",
        )
        registry = SkillRegistry()
        registry.register(BadDraftSkill(manifest))
        with self.SessionLocal() as db:
            result = SkillExecutor(registry).run(
                PlannerResult(skills=["bad_draft_skill"]),
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="测试",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-test",
                            run_id="run-test",
                        ),
                    ),
                    provider=FakeChatProvider(),
                ),
            )
        self.assertEqual(result.status, "failed")
        self.assertIn("returned drafts without draft approval policy", result.context_summary["skillExecutions"][0]["diagnostic"])

    def test_skill_executor_rejects_undeclared_card_type(self) -> None:
        class BadCardSkill(BaseSkill):
            def run(self, context: SkillContext) -> SkillResult:
                return SkillResult(text="bad", cards=[{"type": "shopping_list_draft", "data": {}}])

        manifest = SkillManifest(
            key="bad_card_skill",
            name="坏卡片 Skill",
            description="测试卡片契约。",
            output_types=["inventory_summary"],
            approval_policy="none",
            intent="bad_card",
            agent_key="bad_card_agent",
        )
        registry = SkillRegistry()
        registry.register(BadCardSkill(manifest))
        with self.SessionLocal() as db:
            result = SkillExecutor(registry).run(
                PlannerResult(skills=["bad_card_skill"]),
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="测试",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                    ),
                    provider=FakeChatProvider(),
                ),
            )

        self.assertEqual(result.status, "failed")
        self.assertIn("returned undeclared card type", result.context_summary["skillExecutions"][0]["diagnostic"])

    def test_skill_executor_rejects_invalid_result_status(self) -> None:
        class BadStatusSkill(BaseSkill):
            def run(self, context: SkillContext) -> SkillResult:
                return SkillResult(text="bad", status="waiting")

        manifest = SkillManifest(
            key="bad_status_skill",
            name="坏状态 Skill",
            description="测试状态契约。",
            approval_policy="none",
            intent="bad_status",
            agent_key="bad_status_agent",
        )
        registry = SkillRegistry()
        registry.register(BadStatusSkill(manifest))
        with self.SessionLocal() as db:
            result = SkillExecutor(registry).run(
                PlannerResult(skills=["bad_status_skill"]),
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="测试",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                    ),
                    provider=FakeChatProvider(),
                ),
            )

        self.assertEqual(result.status, "failed")
        self.assertIn("returned invalid status", result.context_summary["skillExecutions"][0]["diagnostic"])

    def test_tool_calling_inventory_skill_reads_declared_tools_and_model_response(self) -> None:
        skill = build_workspace_skill_registry().get("inventory_analysis")
        self.assertIsInstance(skill, ToolCallingSkill)
        with self.SessionLocal() as db:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            result = skill.run(
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="库存怎么样",
                    tool_executor=tool_executor,
                    provider=FakeChatProvider(),
                )
            )
            tool_names = [item["name"] for item in tool_executor.records()]

        self.assertEqual(result.status, "completed")
        self.assertIn("当前可用库存", result.text)
        self.assertEqual(result.cards[0]["type"], "inventory_summary")
        self.assertEqual(result.cards[0]["data"]["queryFocus"], "overview")
        self.assertNotIn("suggestedAction", result.cards[0]["data"]["items"][0])
        self.assertEqual(result.context_summary["inventoryItemCount"], 1)
        self.assertIn("inventory.read_summary", tool_names)
        self.assertIn("inventory.read_expiring_items", tool_names)

    def test_inventory_card_is_built_from_available_items_when_summary_tool_is_not_called(self) -> None:
        class AvailableOnlyProvider(BaseChatProvider):
            model_name = "available-only-model"

            def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                raise AssertionError("tool-calling skill should use generate_with_tools")

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
                del system, user, tools, response_schema, max_rounds, visible_text_handler
                tool_handler("inventory.read_available_items", {"limit": 20})
                return ChatProviderResult(
                    text=json.dumps(
                        {
                            "text": "这里是可用库存。",
                            "cards": [{"type": "inventory_summary", "title": "可用库存", "data": {}}],
                            "status": "completed",
                        },
                        ensure_ascii=False,
                    ),
                    status="completed",
                    model=self.model_name,
                    structured_mode="tool_call",
                )

        skill = build_workspace_skill_registry().get("inventory_analysis")
        with self.SessionLocal() as db:
            result = skill.run(
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="我有什么食材可以用",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                    ),
                    provider=AvailableOnlyProvider(),
                )
            )

        data = result.cards[0]["data"]
        self.assertEqual(data["availableCount"], 1)
        self.assertEqual(data["queryFocus"], "available")
        self.assertEqual(data["items"][0]["name"], "番茄")
        self.assertEqual(data["items"][0]["image"]["id"], "media-ingredient-tomato")
        self.assertNotIn("suggestedAction", data["items"][0])

    def test_inventory_query_tools_expose_only_contextual_suggested_actions(self) -> None:
        with self.SessionLocal() as db:
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            item.low_stock_threshold = Decimal("4")
            db.flush()
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )

            summary = executor.call("inventory.read_summary", {})
            available = executor.call("inventory.read_available_items", {"limit": 20})
            expiring = executor.call("inventory.read_expiring_items", {"days": 7})
            low_stock = executor.call("inventory.read_low_stock_items", {"limit": 20})

            self.assertEqual(summary["queryFocus"], "overview")
            self.assertNotIn("suggestedAction", summary["items"][0])
            self.assertEqual(available["queryFocus"], "available")
            self.assertNotIn("suggestedAction", available["items"][0])
            self.assertEqual(expiring["queryFocus"], "expiring")
            self.assertEqual(expiring["items"][0]["suggestedAction"], "consume")
            self.assertEqual(low_stock["queryFocus"], "low_stock")
            self.assertEqual(low_stock["items"][0]["suggestedAction"], "restock")

            item.expiry_date = date.today() - timedelta(days=1)
            db.flush()
            expired = executor.call("inventory.read_expired_items", {"limit": 20})
            expiring_with_expired = executor.call("inventory.read_expiring_items", {"days": 7})
            self.assertEqual(expired["queryFocus"], "expired")
            self.assertEqual(expired["items"][0]["suggestedAction"], "dispose")
            self.assertEqual(expiring_with_expired["items"][0]["suggestedAction"], "dispose")

    def test_inventory_operation_draft_normalizes_real_entities_and_rejects_cross_family_items(self) -> None:
        with self.SessionLocal() as db:
            draft = normalize_inventory_operation_draft(
                db,
                family_id=self.family.id,
                payload={
                    "draftType": "inventory_operation",
                    "schemaVersion": "inventory_operation.v1",
                    "operations": [
                        {
                            "action": "consume",
                            "ingredientId": "ingredient-tomato",
                            "quantity": 1,
                            "unit": "个",
                        },
                        {
                            "action": "dispose",
                            "ingredientId": "ingredient-tomato",
                            "inventoryItemId": "inventory-tomato",
                            "quantity": 0.5,
                            "unit": "个",
                            "reason": "包装破损",
                        },
                    ],
                },
            )
            self.assertEqual(draft["draftType"], "inventory_operation")
            self.assertEqual(draft["operations"][0]["ingredientName"], "番茄")
            self.assertEqual(draft["operations"][1]["remainingQuantity"], 2)
            self.assertEqual(draft["operations"][0]["image"]["id"], "media-ingredient-tomato")

            with self.assertRaisesRegex(ValueError, "最多只能销毁"):
                normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 2,
                                "unit": "个",
                            },
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-tomato",
                                "inventoryItemId": "inventory-tomato",
                                "quantity": 2,
                                "unit": "个",
                                "reason": "变质",
                            },
                        ]
                    },
                )

            with self.assertRaisesRegex(ValueError, "不属于当前家庭"):
                normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-secret",
                                "inventoryItemId": "inventory-secret",
                                "quantity": 1,
                                "unit": "块",
                                "reason": "测试",
                            }
                        ]
                    },
                )

    def test_inventory_approval_cannot_change_operation_type(self) -> None:
        original = {
            "operations": [
                {
                    "action": "consume",
                    "ingredientId": "ingredient-tomato",
                    "quantity": 1,
                    "unit": "个",
                }
            ]
        }
        AIApplicationService._validate_inventory_operation_shape(original, original)
        with self.assertRaisesRegex(ValueError, "处理方式不能"):
            AIApplicationService._validate_inventory_operation_shape(
                original,
                {
                    "operations": [
                        {
                            "action": "dispose",
                            "ingredientId": "ingredient-tomato",
                            "inventoryItemId": "inventory-tomato",
                            "quantity": 1,
                            "unit": "个",
                            "reason": "变质",
                        }
                    ]
                },
            )

    def test_inventory_disposal_tracks_partial_disposal_separately_from_consumption(self) -> None:
        with self.SessionLocal() as db:
            item = db.scalar(
                select(InventoryItem)
                .where(InventoryItem.id == "inventory-tomato")
                .options(selectinload(InventoryItem.ingredient))
            )
            assert item is not None
            result = dispose_inventory_quantity(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                item=item,
                quantity=Decimal("1.25"),
                unit="个",
                reason="包装破损",
            )
            self.assertEqual(item.consumed_quantity, Decimal("0"))
            self.assertEqual(item.disposed_quantity, Decimal("1.25"))
            self.assertEqual(remaining_quantity(item), Decimal("1.75"))
            self.assertEqual(result["remaining_quantity"], 1.75)

    def test_inventory_card_quick_action_creates_approval_and_updates_card_after_confirmation(self) -> None:
        with self.SessionLocal() as db:
            conversation = AIConversation(
                id="conversation-inventory-quick",
                family_id=self.family.id,
                mode=AiMode.INVENTORY_QA,
                prompt="库存处理",
                response="库存概览",
                context={},
                title="库存处理",
                summary="",
                status="active",
                created_by=self.user.id,
            )
            message = AIMessage(
                id="message-inventory-quick",
                family_id=self.family.id,
                conversation_id=conversation.id,
                role="assistant",
                content="库存概览",
                content_type="parts",
                parts=[
                    {
                        "id": "part-inventory-card",
                        "type": "result_card",
                        "card": {
                            "id": "card-inventory",
                            "type": "inventory_summary",
                            "title": "库存概览",
                            "data": {
                                "availableCount": 1,
                                "expiringCount": 1,
                                "lowStockCount": 0,
                                "items": [
                                    {
                                        "id": "inventory-tomato",
                                        "ingredientId": "ingredient-tomato",
                                        "name": "番茄",
                                        "quantity": "3",
                                        "unit": "个",
                                        "status": "fresh",
                                        "displayStatus": "expiring",
                                    }
                                ],
                            },
                        },
                    }
                ],
                status="completed",
                message_metadata={},
                created_by=self.user.id,
            )
            db.add_all([conversation, message])
            db.commit()

        response = self.client.post(
            "/api/ai/messages/message-inventory-quick/inventory-operation-draft",
            json={
                "part_id": "part-inventory-card",
                "card_id": "card-inventory",
                "item_id": "inventory-tomato",
                "action": "dispose",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval_part = next(part for part in data["parts"] if part["type"] == "approval_request")
        approval = approval_part["approval"]
        self.assertEqual(approval["approval_type"], "inventory.operation")

        decision = self.client.post(
            f"/api/ai/conversations/conversation-inventory-quick/approvals/{approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": approval["draft_version"],
                "values": approval["initial_values"],
            },
        )
        self.assertEqual(decision.status_code, 200, decision.text)
        self.assertEqual(decision.json()["operation"]["status"], "succeeded")
        with self.SessionLocal() as db:
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            self.assertEqual(item.disposed_quantity, Decimal("3.00"))
            stored_message = db.get(AIMessage, "message-inventory-quick")
            assert stored_message is not None
            card_item = stored_message.parts[0]["card"]["data"]["items"][0]
            self.assertEqual(card_item["quantity"], "0")
            self.assertEqual(card_item["lastOperation"]["action"], "dispose")

    def test_today_recommendation_accepts_model_items_at_card_root(self) -> None:
        class RootItemsRecommendationProvider(BaseChatProvider):
            model_name = "root-items-recommendation-model"

            def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                raise AssertionError("tool-calling skill should use generate_with_tools")

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
                del system, user, tools, response_schema, max_rounds, visible_text_handler
                tool_handler("inventory.read_available_items", {"limit": 50})
                tool_handler("inventory.read_expiring_items", {"days": 7})
                tool_handler("meal_log.read_recent", {"limit": 8})
                tool_handler("food.search", {"limit": 24})
                tool_handler("recipe.search", {"limit": 24})
                return ChatProviderResult(
                    text=json.dumps(
                        {
                            "text": "明晚建议吃番茄小炒。",
                            "cards": [
                                {
                                    "type": "today_recommendation",
                                    "title": "今日吃什么",
                                    "data": {
                                        "contextSummary": {
                                            "inventoryCount": 1,
                                            "expiringCount": 1,
                                            "recentMealCount": 0,
                                            "recipeCount": 0,
                                        },
                                        "recommendations": [],
                                    },
                                    "items": [
                                        {
                                            "foodId": "food-tomato",
                                            "reason": "优先消耗临期番茄。",
                                        }
                                    ],
                                }
                            ],
                            "status": "completed",
                        },
                        ensure_ascii=False,
                    ),
                    status="completed",
                    model=self.model_name,
                    structured_mode="tool_call",
                )

        skill = build_workspace_skill_registry().get("meal_plan")
        with self.SessionLocal() as db:
            result = skill.run(
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="明晚吃什么",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                    ),
                    provider=RootItemsRecommendationProvider(),
                )
            )

        card = result.cards[0]
        self.assertNotIn("items", card)
        self.assertEqual(len(card["data"]["recommendations"]), 1)
        self.assertEqual(card["data"]["recommendations"][0]["foodId"], "food-tomato")
        self.assertEqual(card["data"]["recommendations"][0]["name"], "番茄小炒")
        self.assertEqual(card["data"]["recommendations"][0]["image"]["id"], "media-food-tomato")
        self.assertEqual(card["data"]["targetDate"], (date.today() + timedelta(days=1)).isoformat())
        self.assertEqual(card["data"]["mealType"], "dinner")

    def test_tool_calling_skill_normalizes_preview_card_type_to_declared_draft_type(self) -> None:
        class PreviewCardProvider(BaseChatProvider):
            model_name = "preview-card-model"

            def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                raise AssertionError("tool-calling skill should use generate_with_tools")

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
                del system, user, tools, response_schema, max_rounds
                item = {
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "title": "番茄小炒",
                    "foodId": "food-tomato",
                    "recipeId": None,
                    "reason": "使用当前库存。",
                    "usedInventory": ["番茄"],
                    "missingIngredients": ["鸡蛋"],
                }
                draft = {
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "items": [item],
                    "source": {"days": 1, "mealTypes": ["dinner"]},
                }
                tool_handler("meal_plan.create_draft", {"draft": draft})
                return ChatProviderResult(
                    text=json.dumps(
                        {
                            "text": "我生成了 1 条餐食计划草稿。",
                            "cards": [
                                {
                                    "id": "meal-plan-preview",
                                    "type": "meal_plan_preview",
                                    "title": "餐食计划预览",
                                    "data": {"draft": draft, "items": [item]},
                                }
                            ],
                            "events": [],
                            "context_summary": {},
                            "state_patch": {},
                            "requires_clarification": False,
                            "status": "completed",
                            "error": None,
                        },
                        ensure_ascii=False,
                    ),
                    status="completed",
                    model=self.model_name,
                    structured_mode="tool_call",
                )

        skill = build_workspace_skill_registry().get("meal_plan")
        with self.SessionLocal() as db:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            result = skill.run(
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="安排一天晚餐",
                    tool_executor=tool_executor,
                    provider=PreviewCardProvider(),
                )
        )

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.cards, [])
        self.assertEqual(result.drafts[0]["draft_type"], "meal_plan")

    def test_tool_calling_skill_streams_visible_text_around_tool_calls(self) -> None:
        class InterleavedProvider(BaseChatProvider):
            model_name = "interleaved-model"

            def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                raise AssertionError("tool-calling skill should use generate_with_tools")

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
                del system, user, tools, response_schema, max_rounds
                if visible_text_handler is not None:
                    visible_text_handler("<visible_text>我先")
                    visible_text_handler("看一下临期食材。</visible_text>")
                tool_handler("inventory.read_expiring_items", {"days": 7})
                item = {
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "title": "番茄小炒",
                    "foodId": "food-tomato",
                    "recipeId": None,
                    "reason": "使用当前库存。",
                    "usedInventory": ["番茄"],
                    "missingIngredients": [],
                }
                draft = {
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "items": [item],
                    "source": {"days": 1, "mealTypes": ["dinner"]},
                }
                tool_handler("meal_plan.create_draft", {"draft": draft})
                if visible_text_handler is not None:
                    visible_text_handler("<visible_text>我生成了 1 条餐食计划草稿。</visible_text>")
                payload = {
                    "text": "我先看一下临期食材。我生成了 1 条餐食计划草稿。",
                    "cards": [],
                    "events": [{"type": "draft", "message": "已生成餐食计划草稿"}],
                    "context_summary": {"draftType": "meal_plan"},
                    "state_patch": {},
                    "requires_clarification": False,
                    "status": "completed",
                    "error": None,
                    "operation": "create",
                }
                return ChatProviderResult(
                    text=f"<visible_text>我生成了 1 条餐食计划草稿。</visible_text><structured_result>{json.dumps(payload, ensure_ascii=False)}</structured_result>",
                    status="completed",
                    model=self.model_name,
                    structured_mode="tool_call",
                    tool_calls=[
                        {"name": "inventory.read_expiring_items", "args": {"days": 7}},
                        {"name": "meal_plan.create_draft", "args": {}},
                    ],
                )

        skill = build_workspace_skill_registry().get("meal_plan")
        stream_events: list[dict] = []
        with self.SessionLocal() as db:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            result = skill.run(
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="安排一天晚餐",
                    tool_executor=tool_executor,
                    provider=InterleavedProvider(),
                    stream_writer=lambda item: stream_events.append(item),
                )
            )
            tool_names = [item["name"] for item in tool_executor.records()]

        deltas = [event["data"]["delta"] for event in stream_events if event.get("event") == "message_delta"]
        self.assertEqual(deltas, ["我先看一下临期食材。\n", "我生成了 1 条餐食计划草稿。\n"])
        self.assertEqual(result.text, "我先看一下临期食材。\n我生成了 1 条餐食计划草稿。")
        self.assertNotIn("structured_result", result.text)
        self.assertEqual(result.drafts[0]["draft_type"], "meal_plan")
        self.assertIn("inventory.read_expiring_items", tool_names)
        self.assertIn("meal_plan.create_draft", tool_names)

    def test_tool_calling_skill_fails_invalid_model_json(self) -> None:
        skill = build_workspace_skill_registry().get("inventory_analysis")
        with self.SessionLocal() as db:
            result = skill.run(
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="库存怎么样",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-test",
                            run_id="run-test",
                        ),
                    ),
                    provider=SequenceChatProvider(["不是 JSON"]),
                )
            )

        self.assertEqual(result.status, "failed")
        self.assertIn("没有返回有效结果", result.text)

    def test_tool_calling_meal_plan_repairs_empty_items(self) -> None:
        empty_decision = json.dumps(
            {
                "operation": "create",
                "sourceArtifactId": None,
                "days": 1,
                "mealTypes": ["dinner"],
                "constraints": [],
                "clarification": None,
                "items": [],
            },
            ensure_ascii=False,
        )
        repaired_decision = json.dumps(
            {
                "operation": "create",
                "sourceArtifactId": None,
                "days": 1,
                "mealTypes": ["dinner"],
                "constraints": ["light"],
                "clarification": None,
                "items": [
                    {
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "修复后补充计划项",
                        "usedInventory": ["番茄"],
                        "missingIngredients": ["鸡蛋"],
                    }
                ],
            },
            ensure_ascii=False,
        )
        provider = SequenceChatProvider([empty_decision, repaired_decision])
        with self.SessionLocal() as db:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
            )
            result = SkillExecutor(build_workspace_skill_registry()).run_step(
                "meal_plan",
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="安排一天晚餐",
                    tool_executor=tool_executor,
                    provider=provider,
                ),
            )
            tool_names = [item["name"] for item in tool_executor.records()]

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.cards, [])
        self.assertEqual(result.context_summary["scriptValidation"], {"valid": True, "errors": []})
        self.assertEqual(result.drafts[0]["draft_type"], "meal_plan")
        self.assertIn("番茄小炒", str(result.drafts[0]["payload"]))
        self.assertIn("script.validate_meal_plan", tool_names)
        self.assertIn("meal_plan.create_draft", tool_names)
        self.assertLess(
            tool_names.index("script.validate_meal_plan"),
            tool_names.index("meal_plan.create_draft"),
        )
        self.assertEqual(provider.responses, [])

    def test_tool_calling_shopping_list_invalid_source_does_not_create_draft(self) -> None:
        provider = SequenceChatProvider(
            [
                json.dumps(
                    {
                        "operation": "derive",
                        "sourceArtifactId": "missing-meal-plan",
                        "clarification": None,
                        "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "用于晚餐", "sourceMeals": ["番茄鸡蛋面"]}],
                    },
                    ensure_ascii=False,
                )
            ]
        )
        with self.SessionLocal() as db:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
            )
            result = SkillExecutor(build_workspace_skill_registry()).run_step(
                "shopping_list",
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message="基于这个计划生成采购清单",
                    tool_executor=tool_executor,
                    provider=provider,
                ),
            )
            tool_names = [item["name"] for item in tool_executor.records()]

        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error, "invalid meal_plan source artifact")
        self.assertNotIn("shopping.create_draft", tool_names)

    def test_tool_calling_shopping_list_accepts_current_run_meal_plan_artifact(self) -> None:
        provider = SequenceChatProvider(
            [
                json.dumps(
                    {
                        "operation": "derive",
                        "sourceArtifactId": "in_run:meal_plan:meal_plan:1",
                        "clarification": None,
                        "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "用于晚餐", "sourceMeals": ["番茄鸡蛋面"]}],
                    },
                    ensure_ascii=False,
                )
            ]
        )
        with self.SessionLocal() as db:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
            )
            result = SkillExecutor(build_workspace_skill_registry()).run_step(
                "shopping_list",
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_run_artifacts=[
                        {
                            "id": "in_run:meal_plan:meal_plan:1",
                            "type": "meal_plan",
                            "kind": "draft",
                            "status": "proposed",
                            "payload": {"items": [{"title": "番茄鸡蛋面"}]},
                            "sourceSkill": "meal_plan",
                        }
                    ],
                    current_message="基于这个计划生成采购清单",
                    tool_executor=tool_executor,
                    provider=provider,
                ),
            )
            tool_names = [item["name"] for item in tool_executor.records()]

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.drafts[0]["draft_type"], "shopping_list")
        self.assertEqual(result.drafts[0]["payload"]["sourceDraftId"], "in_run:meal_plan:meal_plan:1")
        self.assertIn("shopping.create_draft", tool_names)

    def test_tool_calling_shopping_list_empty_repair_still_empty_skips_draft(self) -> None:
        empty_decision = json.dumps(
            {
                "operation": "derive",
                "sourceArtifactId": "artifact-meal-plan",
                "clarification": None,
                "items": [],
            },
            ensure_ascii=False,
        )
        provider = SequenceChatProvider([empty_decision, empty_decision])
        conversation = [
            {
                "id": "message-with-plan",
                "role": "assistant",
                "content": "餐食计划草稿",
                "artifacts": [
                    {
                        "id": "artifact-meal-plan",
                        "type": "meal_plan",
                        "version": 1,
                        "status": "confirmed",
                        "payload": {"items": [{"title": "番茄鸡蛋面", "missingIngredients": ["鸡蛋"]}]},
                    }
                ],
            }
        ]
        with self.SessionLocal() as db:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
            )
            result = SkillExecutor(build_workspace_skill_registry()).run_step(
                "shopping_list",
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation=conversation,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    current_message="生成购物清单",
                    tool_executor=tool_executor,
                    provider=provider,
                ),
            )
            tool_names = [item["name"] for item in tool_executor.records()]

        self.assertEqual(result.status, "completed")
        self.assertEqual(result.drafts, [])
        self.assertIn("当前没有需要加入购物清单", result.text)
        self.assertNotIn("shopping.create_draft", tool_names)
        self.assertEqual(provider.responses, [])

    def test_phase_a_tool_executor_records_real_tool_calls(self) -> None:
        with self.SessionLocal() as db:
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            output = executor.call("inventory.read_expiring_items", {"days": 7})
            records = executor.records()

        self.assertEqual(output["count"], 1)
        self.assertEqual(records[0]["name"], "inventory.read_expiring_items")
        self.assertEqual(records[0]["permission"], "family:read")
        self.assertEqual(records[0]["side_effect"], "read")
        self.assertEqual(records[0]["status"], "completed")
        self.assertEqual(records[0]["output_summary"]["count"], 1)

    def test_tool_executor_enforces_skill_allowlist_and_side_effect_policy(self) -> None:
        with self.SessionLocal() as db:
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            ).scoped(
                allowed_tools={"inventory.read_summary", "shopping.create_draft"},
                allowed_side_effects={"read"},
            )
            output = executor.call("inventory.read_summary", {})
            self.assertEqual(output["availableCount"], 1)
            with self.assertRaises(PermissionError):
                executor.call("inventory.read_available_items", {"limit": 10})
            with self.assertRaises(PermissionError):
                executor.call("shopping.create_draft", {"draft": {"items": [{"title": "鸡蛋"}]}})

    def test_tool_executor_validates_input_schema(self) -> None:
        with self.SessionLocal() as db:
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            with self.assertRaises(ValueError):
                executor.call("inventory.read_expiring_items", {"days": "七天"})
            with self.assertRaises(ValueError):
                executor.call("meal_plan.create_draft", {})

    def test_draft_tools_reject_or_normalize_catalog_bound_fields(self) -> None:
        with self.SessionLocal() as db:
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            with self.assertRaisesRegex(ValueError, "foodId"):
                executor.call(
                    "meal_plan.create_draft",
                    {
                        "draft": {
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan.v1",
                            "items": [{"date": date.today().isoformat(), "mealType": "dinner", "title": "库外菜名"}],
                        }
                    },
                )

            meal_plan = executor.call(
                "meal_plan.create_draft",
                {
                    "draft": {
                        "draftType": "meal_plan",
                        "schemaVersion": "meal_plan.v1",
                        "items": [
                            {
                                "date": date.today().isoformat(),
                                "mealType": "dinner",
                                "title": "库外菜名",
                                "foodId": "food-tomato",
                                "recipeId": None,
                                "missingIngredientItems": [
                                    {
                                        "ingredientId": "ingredient-tomato",
                                        "name": "错误名称",
                                        "quantity": 2.5,
                                        "unit": "个",
                                    }
                                ],
                            }
                        ],
                    }
                },
            )
            self.assertEqual(meal_plan["draft"]["items"][0]["title"], "番茄小炒")
            self.assertEqual(meal_plan["draft"]["items"][0]["missingIngredients"], ["番茄"])
            self.assertEqual(
                meal_plan["draft"]["items"][0]["missingIngredientItems"],
                [{"ingredientId": "ingredient-tomato", "name": "番茄", "quantity": 2.5, "unit": "个"}],
            )

            with self.assertRaisesRegex(ValueError, "foodId"):
                executor.call(
                    "meal_log.create_draft",
                    {
                        "draft": {
                            "draftType": "meal_log",
                            "schemaVersion": "meal_log.v1",
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "foods": [{"foodId": None, "name": "库外菜名", "servings": 1, "note": ""}],
                            "notes": "",
                        }
                    },
                )

            meal_log = executor.call(
                "meal_log.create_draft",
                {
                    "draft": {
                        "draftType": "meal_log",
                        "schemaVersion": "meal_log.v1",
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                        "foods": [{"foodId": "food-tomato", "name": "库外菜名", "servings": 1, "note": ""}],
                        "notes": "",
                    }
                },
            )
            self.assertEqual(meal_log["draft"]["foods"][0]["name"], "番茄小炒")

            recipe_steps = [
                {
                    "title": "备菜",
                    "text": "洗净番茄后切块，准备好调味料。",
                    "icon": "bowl",
                    "summary": "处理番茄",
                    "estimated_minutes": 5,
                    "tip": "",
                    "key_points": ["切块"],
                },
                {
                    "title": "下锅",
                    "text": "锅中加少量油，放入番茄翻炒出汁。",
                    "icon": "pan",
                    "summary": "炒出汤汁",
                    "estimated_minutes": 6,
                    "tip": "",
                    "key_points": ["中火"],
                },
                {
                    "title": "调味",
                    "text": "加入盐调味后收汁装盘。",
                    "icon": "plate",
                    "summary": "完成装盘",
                    "estimated_minutes": 4,
                    "tip": "",
                    "key_points": ["尝味"],
                },
            ]
            recipe = executor.call(
                "recipe.create_draft",
                {
                    "draft": {
                        "title": "番茄菜",
                        "servings": 2,
                        "prep_minutes": 15,
                        "difficulty": "easy",
                        "ingredient_items": [
                            {"ingredient_id": "ingredient-tomato", "ingredient_name": "随便写", "quantity": 1, "unit": "个", "note": ""}
                        ],
                        "steps": recipe_steps,
                        "tips": "",
                        "scene_tags": [],
                    }
                },
            )
            self.assertEqual(recipe["draft"]["ingredient_items"][0]["ingredient_name"], "番茄")

            with self.assertRaisesRegex(ValueError, "当前家庭"):
                executor.call(
                    "recipe.create_draft",
                    {
                        "draft": {
                            "title": "跨家庭菜",
                            "servings": 2,
                            "prep_minutes": 15,
                            "difficulty": "easy",
                            "ingredient_items": [
                                {"ingredient_id": "ingredient-secret", "ingredient_name": "其他家庭牛排", "quantity": 1, "unit": "块", "note": ""}
                            ],
                            "steps": recipe_steps,
                            "tips": "",
                            "scene_tags": [],
                        }
                    },
                )

            with self.assertRaisesRegex(ValueError, "来源草稿"):
                executor.call(
                    "shopping.create_draft",
                    {
                        "draft": {
                            "draftType": "shopping_list",
                            "schemaVersion": "shopping_list.v1",
                            "sourceDraftId": "missing-draft",
                            "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "测试"}],
                        }
                    },
                )

    def test_workspace_tool_registry_uses_real_schemas_for_key_tools(self) -> None:
        registry = build_workspace_tool_registry()
        for tool in registry.list():
            self.assertTrue(tool.display_name)
            self.assertNotIn(".", tool.display_name)
        expiring = registry.get("inventory.read_expiring_items")
        self.assertEqual(expiring.display_name, "临期食材")
        self.assertIn("days", expiring.input_schema["properties"])
        self.assertEqual(expiring.output_schema["required"], ["count", "items"])
        meal_plan_draft = registry.get("meal_plan.create_draft")
        self.assertEqual(meal_plan_draft.display_name, "餐食计划确认表单")
        self.assertEqual(meal_plan_draft.side_effect, "draft")
        self.assertEqual(meal_plan_draft.permission, "family:draft")
        self.assertEqual(meal_plan_draft.input_schema["required"], ["draft"])
        self.assertEqual(meal_plan_draft.input_schema["properties"]["draft"]["properties"]["draftType"]["enum"], ["meal_plan"])
        self.assertIn("items", meal_plan_draft.input_schema["properties"]["draft"]["required"])
        self.assertTrue(meal_plan_draft.requires_confirmation)
        meal_log_draft = registry.get("meal_log.create_draft")
        self.assertEqual(meal_log_draft.input_schema["properties"]["draft"]["properties"]["foods"]["minItems"], 1)

    def test_tool_executor_progress_uses_display_names(self) -> None:
        events: list[dict] = []

        def stream_writer(event: dict) -> None:
            events.append(event)

        with self.SessionLocal() as db:
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    stream_writer=stream_writer,
                ),
            )
            executor.call("inventory.read_available_items", {"limit": 10})
            executor.call(
                "meal_plan.create_draft",
                {
                    "draft": {
                        "draftType": "meal_plan",
                        "schemaVersion": "meal_plan.v1",
                        "items": [{"date": date.today().isoformat(), "mealType": "dinner", "title": "番茄小炒", "foodId": "food-tomato"}],
                    }
                },
            )

        messages = [event["data"]["user_message"] for event in events]
        self.assertEqual(messages, ["调用「可用库存」", "生成「餐食计划确认表单」"])
        self.assertNotIn("inventory.read_available_items", "\n".join(messages))

    def test_meal_plan_read_existing_uses_related_food_name(self) -> None:
        with self.SessionLocal() as db:
            db.add(
                FoodPlanItem(
                    id="food-plan-existing",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id="food-tomato",
                    plan_date=date.today() + timedelta(days=1),
                    meal_type=MealType.DINNER,
                    note="少油",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
            )
            db.commit()
            executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            output = executor.call("meal_plan.read_existing", {"limit": 20})

        self.assertEqual(output["count"], 1)
        self.assertEqual(output["items"][0]["title"], "番茄小炒")
        self.assertEqual(output["items"][0]["note"], "少油")

    def test_workspace_chat_records_completed_graph_run_with_tools(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "库存怎么样"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["intent"], "inventory")
        card = data["included"]["result_cards"][0]
        self.assertEqual(card["type"], "inventory_summary")
        self.assertEqual(card["data"]["items"][0]["name"], "番茄")
        self.assertEqual(card["data"]["items"][0]["image"]["id"], "media-ingredient-tomato")
        self.assertEqual(card["data"]["items"][0]["displayStatus"], "expiring")
        with self.SessionLocal() as db:
            run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == data["run"]["id"]))
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.status, "completed")
            self.assertGreaterEqual(len(run.tool_calls), 1)
            self.assertEqual(run.conversation_id, data["conversation_id"])

    def test_workspace_graph_persists_all_drafts_from_single_skill_result(self) -> None:
        from app.ai.workflows.runner import WorkspaceGraphRunner

        with self.SessionLocal() as db:
            service = AIApplicationService(db, provider=FakeChatProvider())
            conversation = service._get_or_create_conversation(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id=None,
                prompt="生成多份草稿",
                quick_task=None,
            )
            run = AIAgentRun(
                id="agent_run-multi-draft-test",
                family_id=self.family.id,
                conversation_id=conversation.id,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="multi_draft",
                input_summary="生成多份草稿",
                context_summary={},
                output_summary="",
                status="running",
                model="fake-model",
                input={},
                output={},
                tool_calls=[],
                created_by=self.user.id,
            )
            db.add(run)
            db.flush()
            meal_plan_payload = {
                "draftType": "meal_plan",
                "schemaVersion": "meal_plan.v1",
                "items": [
                    {
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "测试多草稿",
                        "usedInventory": ["番茄"],
                        "missingIngredients": ["鸡蛋"],
                    }
                ],
                "source": {"days": 1, "mealTypes": ["dinner"]},
            }
            shopping_payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list.v1",
                "items": [
                    {
                        "title": "鸡蛋",
                        "quantity": 2,
                        "unit": "个",
                        "reason": "用于番茄鸡蛋面",
                        "sourceMeals": ["番茄鸡蛋面"],
                    }
                ],
                "sourceDraftId": None,
            }
            message = WorkspaceGraphRunner(service)._persist_assistant_result(
                {
                    "family_id": self.family.id,
                    "user_id": self.user.id,
                    "conversation_id": conversation.id,
                    "run_id": run.id,
                    "message": "生成多份草稿",
                },
                SkillResult(
                    text="生成了两份草稿。",
                    drafts=[
                        {"draft_type": "meal_plan", "payload": meal_plan_payload, "schema_version": "meal_plan.v1"},
                        {"draft_type": "shopping_list", "payload": shopping_payload, "schema_version": "shopping_list.v1"},
                    ],
                    model="fake-model",
                ),
                skill_key="meal_plan",
            )
            response = WorkspaceGraphRunner(service)._chat_response(conversation.id, run.id)

            draft_parts = [part for part in message.parts if part.get("type") == "draft"]
            approval_parts = [part for part in message.parts if part.get("type") == "approval_request"]
            self.assertEqual([part["draft"]["draft_type"] for part in draft_parts], ["meal_plan", "shopping_list"])
            self.assertEqual([part["approval"]["approval_type"] for part in approval_parts], ["meal_plan.create", "shopping_list.create"])
            self.assertEqual([draft["draft_type"] for draft in response["included"]["drafts"]], ["meal_plan", "shopping_list"])
            self.assertEqual([approval["approval_type"] for approval in response["included"]["approvals"]], ["meal_plan.create", "shopping_list.create"])
            self.assertEqual(response["included"]["result_cards"], [])
            self.assertEqual(response["run"]["status"], "waiting_approval")

    def test_legacy_ai_query_api_is_removed(self) -> None:
        response = self.client.post("/api/ai/query", json={"mode": "inventoryQa", "prompt": "库存怎么样"})
        self.assertEqual(response.status_code, 404, response.text)

    def test_ai_workspace_chat_returns_today_recommendation_card_and_persists_lifecycle(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "今日吃什么？", "quick_task": "today_recommendation"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertIn("conversation_id", data)
        self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
        self.assertEqual(data["run"]["intent"], "meal_plan")
        self.assertEqual(data["included"]["drafts"], [])
        self.assertEqual(data["included"]["approvals"], [])
        card_parts = [part for part in data["message"]["parts"] if part["type"] == "result_card"]
        self.assertEqual(card_parts[0]["card"]["type"], "today_recommendation")
        recommendations = card_parts[0]["card"]["data"]["recommendations"]
        self.assertGreaterEqual(len(recommendations), 1)
        self.assertEqual(recommendations[0]["foodId"], "food-tomato")
        self.assertEqual(recommendations[0]["name"], "番茄小炒")
        self.assertEqual(recommendations[0]["image"]["id"], "media-food-tomato")
        self.assertIn("reason", recommendations[0])
        self.assertIn("evidence", recommendations[0])

        plan_response = self.client.post(
            "/api/food-plan",
            json={
                "food_id": "food-tomato",
                "plan_date": (date.today() + timedelta(days=1)).isoformat(),
                "meal_type": "dinner",
                "note": "来自 AI 推荐",
            },
        )
        self.assertEqual(plan_response.status_code, 201, plan_response.text)
        selection_response = self.client.post(
            f"/api/ai/messages/{data['message']['id']}/recommendation-selection",
            json={
                "part_id": card_parts[0]["id"],
                "card_id": card_parts[0]["card"]["id"],
                "entity_id": recommendations[0]["entityId"],
                "food_plan_item_id": plan_response.json()["id"],
            },
        )
        self.assertEqual(selection_response.status_code, 200, selection_response.text)
        selected_item = selection_response.json()["parts"][-1]["card"]["data"]["recommendations"][0]
        self.assertEqual(selected_item["planSelection"]["foodPlanItemId"], plan_response.json()["id"])
        self.assertEqual(selected_item["planSelection"]["mealType"], "dinner")

        with self.SessionLocal() as db:
            messages = list(db.scalars(select(AIMessage).where(AIMessage.conversation_id == data["conversation_id"])))
            events = list(db.scalars(select(AIRunEvent).where(AIRunEvent.run_id == data["run"]["id"])))
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertEqual(len(messages), 2)
            event_messages = [event.user_message for event in events]
            self.assertIn("调用「餐食计划」技能", event_messages)
            self.assertIn("调用「可用库存」", event_messages)
            self.assertIn("餐食计划执行完成", event_messages)
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.intent, "meal_plan")
            self.assertEqual(run.context_summary["routing"]["skills"], ["meal_plan"])
            self.assertEqual(run.context_summary["inventoryItemCount"], 1)
            tool_names = [item["name"] for item in run.tool_calls]
            self.assertIn("inventory.read_available_items", tool_names)
            self.assertIn("inventory.read_expiring_items", tool_names)
            self.assertIn("food.search", tool_names)
            self.assertIn("meal_log.read_recent", tool_names)
            self.assertIn("recipe.search", tool_names)
            self.assertNotIn("meal_plan.create_draft", tool_names)
            stored_message = db.get(AIMessage, data["message"]["id"])
            self.assertEqual(
                stored_message.message_metadata["recommendationSelections"][0]["name"],
                "番茄小炒",
            )
            timeline = AIApplicationService(db)._build_planner_conversation(
                family_id=self.family.id,
                conversation_id=data["conversation_id"],
            )
            assistant_entry = next(item for item in timeline if item["id"] == data["message"]["id"])
            self.assertEqual(
                assistant_entry["metadata"]["recommendationSelections"][0]["foodPlanItemId"],
                plan_response.json()["id"],
            )

    def test_ai_workspace_routes_natural_today_recommendation_to_meal_plan_without_draft(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "今晚吃什么？"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
        self.assertEqual(data["run"]["intent"], "meal_plan")
        self.assertEqual(data["included"]["drafts"], [])
        self.assertEqual(data["included"]["approvals"], [])
        self.assertEqual(data["included"]["result_cards"][0]["type"], "today_recommendation")

    def test_ai_workspace_messages_are_family_scoped(self) -> None:
        create_response = self.client.post("/api/ai/chat", json={"message": "随便聊聊"})
        self.assertEqual(create_response.status_code, 200, create_response.text)
        conversation_id = create_response.json()["conversation_id"]

        response = self.client.get(f"/api/ai/conversations/{conversation_id}/messages")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 2)

    def test_ai_workspace_general_chat_does_not_persist_task_progress(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "随便聊聊"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["intent"], "general_chat")
        self.assertEqual(data["events"], [])

    def test_ai_workspace_general_chat_sends_conversation_history_to_provider(self) -> None:
        provider = CapturingGeneralChatProvider()
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            first_response = self.client.post("/api/ai/chat", json={"message": "给我两个早餐思路"})
            self.assertEqual(first_response.status_code, 200, first_response.text)
            conversation_id = first_response.json()["conversation_id"]

            second_response = self.client.post(
                "/api/ai/chat",
                json={"conversation_id": conversation_id, "message": "那第二种呢"},
            )
            self.assertEqual(second_response.status_code, 200, second_response.text)

        self.assertGreaterEqual(len(provider.general_payloads), 2)
        second_payload = provider.general_payloads[-1]
        self.assertEqual(second_payload["currentMessage"], "那第二种呢")
        history = second_payload["conversation"]
        self.assertTrue(any(item["role"] == "user" and item["content"] == "给我两个早餐思路" for item in history), history)
        self.assertTrue(any(item["role"] == "assistant" and "收到" in item["content"] for item in history), history)
        self.assertTrue(any(item["role"] == "user" and item["content"] == "那第二种呢" for item in history), history)

    def test_ai_workspace_subject_references_reach_toolcalling_skill_payload(self) -> None:
        provider = CapturingToolSubjectProvider()
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={
                    "message": "安排三天晚餐",
                    "subject": {
                        "source": "ingredient-page",
                        "ingredientIds": ["ingredient-tomato"],
                    },
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreaterEqual(len(provider.tool_payloads), 1)
        subject = provider.tool_payloads[0]["subject"]
        self.assertEqual(subject["source"], "ingredient-page")
        self.assertEqual(subject["ingredient_ids"], ["ingredient-tomato"])
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, response.json()["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.input["subject"]["ingredient_ids"], ["ingredient-tomato"])

    def test_ai_workspace_reuses_completed_client_message_and_run_ids(self) -> None:
        payload = {
            "message": "随便聊聊",
            "client_message_id": "client-message-idempotent",
            "client_run_id": "agent_run-idempotent",
        }
        first_response = self.client.post("/api/ai/chat", json=payload)
        self.assertEqual(first_response.status_code, 200, first_response.text)
        second_response = self.client.post("/api/ai/chat", json=payload)
        self.assertEqual(second_response.status_code, 200, second_response.text)

        first_data = first_response.json()
        second_data = second_response.json()
        self.assertEqual(second_data["run"]["id"], first_data["run"]["id"])
        self.assertEqual(second_data["message"]["id"], first_data["message"]["id"])
        with self.SessionLocal() as db:
            user_messages = list(
                db.scalars(
                    select(AIMessage).where(
                        AIMessage.family_id == self.family.id,
                        AIMessage.role == "user",
                        AIMessage.client_message_id == "client-message-idempotent",
                    )
                )
            )
            runs = list(db.scalars(select(AIAgentRun).where(AIAgentRun.id == "agent_run-idempotent")))
            self.assertEqual(len(user_messages), 1)
            self.assertEqual(len(runs), 1)

    def test_ai_workspace_duplicate_running_client_run_returns_conflict(self) -> None:
        with self.SessionLocal() as db:
            conversation = AIConversation(
                id="conversation-running-idempotency",
                family_id=self.family.id,
                mode=AiMode.RECOMMENDATION,
                prompt="处理中",
                response="",
                context={"workspace": True},
                created_by=self.user.id,
            )
            run = AIAgentRun(
                id="agent_run-running-idempotency",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id=None,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="general_chat",
                input_summary="处理中",
                context_summary={},
                output_summary="",
                status="running",
                model="fake-model",
                input={"prompt": "处理中", "subject": {}},
                output={},
                tool_calls=[],
                duration_ms=0,
                created_by=self.user.id,
            )
            db.add_all([conversation, run])
            db.commit()

        response = self.client.post(
            "/api/ai/chat",
            json={"message": "重试同一个运行", "client_run_id": "agent_run-running-idempotency"},
        )
        self.assertEqual(response.status_code, 409, response.text)

    def test_ai_workspace_rejects_new_message_when_conversation_has_active_run(self) -> None:
        with self.SessionLocal() as db:
            conversation = AIConversation(
                id="conversation-active-run",
                family_id=self.family.id,
                mode=AiMode.RECOMMENDATION,
                prompt="处理中",
                response="",
                context={"workspace": True},
                created_by=self.user.id,
            )
            run = AIAgentRun(
                id="agent_run-active-conversation",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id=None,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="general_chat",
                input_summary="处理中",
                context_summary={},
                output_summary="",
                status="running",
                model="fake-model",
                input={"prompt": "处理中", "subject": {}},
                output={},
                tool_calls=[],
                duration_ms=0,
                created_by=self.user.id,
            )
            db.add_all([conversation, run])
            db.commit()

        response = self.client.post(
            "/api/ai/chat",
            json={"message": "新消息", "conversation_id": "conversation-active-run"},
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("当前会话已有 AI 任务", response.text)

    def test_ai_status_reports_disabled_provider_without_secrets(self) -> None:
        settings = SimpleNamespace(ai_provider="disabled", ai_model="", ai_api_key="")
        with patch("app.api.ai.get_settings", return_value=settings):
            response = self.client.get("/api/ai/status")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertFalse(data["enabled"])
        self.assertEqual(data["status"], "disabled")
        self.assertEqual(data["provider"], "disabled")
        self.assertNotIn("api_key", data)

    def test_ai_status_reports_ready_provider_without_secrets(self) -> None:
        settings = SimpleNamespace(ai_provider="openai-compatible", ai_model="fake-model", ai_api_key="secret")
        with patch("app.api.ai.get_settings", return_value=settings):
            response = self.client.get("/api/ai/status")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data["enabled"])
        self.assertEqual(data["status"], "ready")
        self.assertEqual(data["model"], "fake-model")
        self.assertNotIn("secret", response.text)

    def test_ai_chat_request_rejects_blank_message_before_running_agent(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "   "})
        self.assertEqual(response.status_code, 422, response.text)

    def test_ai_chat_request_rejects_overlong_message_before_running_agent(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "x" * 2001})
        self.assertEqual(response.status_code, 422, response.text)

    def test_ai_workspace_messages_normalize_legacy_result_cards_missing_id_and_title(self) -> None:
        with self.SessionLocal() as db:
            db.add(
                AIConversation(
                    id="conversation-legacy-card",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="库存概览",
                    response="库存概览",
                    context={},
                    created_by=self.user.id,
                )
            )
            message = AIMessage(
                id="ai-message-legacy-card",
                family_id=self.family.id,
                conversation_id="conversation-legacy-card",
                role="assistant",
                content="库存概览",
                content_type="parts",
                parts=[
                    {"id": "part-text", "type": "text", "text": "库存概览"},
                    {
                        "id": "part-card",
                        "type": "result_card",
                        "card": {
                            "id": None,
                            "type": "inventory_summary",
                            "title": None,
                            "data": {"availableCount": 6, "expiringCount": 3, "lowStockCount": 3},
                        },
                    },
                ],
                status="completed",
                created_by=self.user.id,
            )
            db.add(message)
            db.commit()

        response = self.client.get("/api/ai/conversations/conversation-legacy-card/messages")
        self.assertEqual(response.status_code, 200, response.text)
        card = response.json()[0]["parts"][1]["card"]
        self.assertEqual(card["id"], "part-card-card")
        self.assertEqual(card["title"], "库存概览")

    def test_ai_workspace_recipe_draft_approval_creates_recipe_after_decision(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄鸡蛋面",
              "servings": 2,
              "prep_minutes": 20,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                {"ingredient_id": null, "ingredient_name": "鸡蛋", "quantity": 2, "unit": "个", "note": "打散"},
                {"ingredient_id": null, "ingredient_name": "面条", "quantity": 200, "unit": "克", "note": "提前备好"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成 2 厘米块，鸡蛋打到没有透明蛋清。面条提前称好，葱花和调味料放在手边，方便后续连续操作。", "icon": "bowl", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["番茄切块", "鸡蛋打散"]},
                {"title": "炒汤底", "text": "锅中放少量油，中火加热 30 秒后倒入蛋液炒到刚凝固盛出。继续用中火炒番茄 3 分钟，看到出汁变软后加入热水煮沸。", "icon": "pan", "summary": "炒出汤底", "estimated_minutes": 8, "tip": "番茄要炒出汁。", "key_points": ["中火", "炒出汁"]},
                {"title": "煮面收尾", "text": "汤汁沸腾后下面条煮 5 分钟，保持微沸并不时搅动防止粘连。面条变软熟透后倒回鸡蛋，加盐调味，确认汤汁冒泡后出锅。", "icon": "plate", "summary": "煮熟装盘", "estimated_minutes": 7, "tip": "出锅前尝味。", "key_points": ["煮熟", "尝味"]}
              ],
              "tips": "少油少盐，适合晚餐。",
              "scene_tags": ["家常菜", "快手菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄鸡蛋面的菜谱，2 人份。", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["agent_key"], "recipe_draft_agent")
        self.assertEqual(data["run"]["intent"], "recipe_draft")
        self.assertEqual(len(data["included"]["drafts"]), 1)
        self.assertEqual(len(data["included"]["approvals"]), 1)
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]
        self.assertEqual(approval["status"], "pending")
        self.assertEqual(draft["status"], "pending")

        with self.SessionLocal() as db:
            self.assertEqual(db.query(Recipe).count(), 0)
            self.assertEqual(db.query(AITaskDraft).count(), 1)
            self.assertEqual(db.query(AIApprovalRequest).count(), 1)
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            self.assertIn("recipe.create_draft", [item["name"] for item in run.tool_calls])

        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        self.assertEqual(pending_response.json()[0]["id"], approval["id"])

        recipe_payload = draft["payload"]
        recipe_payload["title"] = "番茄鸡蛋面（确认版）"
        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": draft["version"],
                "values": {"recipe": recipe_payload},
            },
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["approval"]["status"], "approved")
        self.assertEqual(decision_data["draft"]["status"], "confirmed")
        self.assertEqual(decision_data["operation"]["status"], "succeeded")
        self.assertEqual(decision_data["business_entity"]["title"], "番茄鸡蛋面（确认版）")

        repeat_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": draft["version"],
                "values": {"recipe": recipe_payload},
            },
        )
        self.assertEqual(repeat_response.status_code, 409, repeat_response.text)
        with self.SessionLocal() as db:
            self.assertEqual(db.query(Recipe).count(), 1)
            self.assertEqual(db.query(AIOperation).count(), 1)

    def test_ai_workspace_approval_rejects_stale_draft_version(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄小炒",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                {"title": "翻炒", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入少量水，保持冒泡继续煮 5 分钟。", "icon": "pan", "summary": "炒软", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["中火"]},
                {"title": "收尾", "text": "汤汁略微浓稠后加盐调味，再继续翻炒 1 分钟。确认番茄软烂且汤汁冒泡后关火装盘。", "icon": "plate", "summary": "装盘", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
              ],
              "tips": "清淡少油。",
              "scene_tags": ["家常菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄小炒的菜谱", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]
        stale_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": draft["version"] + 1,
                "values": {"recipe": draft["payload"]},
            },
        )
        self.assertEqual(stale_response.status_code, 409, stale_response.text)
        self.assertIn("草稿已更新", stale_response.json()["detail"])

    def test_ai_workspace_operation_failure_returns_recoverable_state(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄汤",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                {"title": "煮汤", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入热水，保持冒泡继续煮 8 分钟。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["出汁"]},
                {"title": "调味", "text": "汤汁沸腾且略微浓稠后加盐调味，再继续煮 1 分钟。确认番茄软烂且汤汁冒泡后关火装碗。", "icon": "plate", "summary": "装碗", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
              ],
              "tips": "清淡少油。",
              "scene_tags": ["家常菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄汤的菜谱", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]

        with patch("app.ai.workspace_service.ensure_food_for_recipe", side_effect=RuntimeError("sync failed")):
            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": draft["version"],
                    "values": {"recipe": draft["payload"]},
                },
            )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["approval"]["status"], "pending")
        self.assertEqual(decision_data["approval"]["approval_type"], "recipe.create.retry")
        self.assertEqual(decision_data["draft"]["status"], "pending_retry")
        self.assertEqual(decision_data["operation"]["status"], "failed")
        self.assertIn("sync failed", decision_data["operation"]["error_message"])
        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        self.assertEqual(pending_response.json()[0]["id"], decision_data["approval"]["id"])
        with self.SessionLocal() as db:
            self.assertEqual(db.query(Recipe).count(), 0)
            self.assertEqual(db.query(AIOperation).count(), 1)
            self.assertEqual(db.query(AIApprovalRequest).count(), 2)

    def test_ai_workspace_reject_does_not_validate_broken_recipe_payload(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄汤",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                {"title": "煮汤", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入热水，保持冒泡继续煮 8 分钟。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["出汁"]},
                {"title": "调味", "text": "汤汁沸腾且略微浓稠后加盐调味，再继续煮 1 分钟。确认番茄软烂且汤汁冒泡后关火装碗。", "icon": "plate", "summary": "装碗", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
              ],
              "tips": "清淡少油。",
              "scene_tags": ["家常菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄汤的菜谱", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]
        reject_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "rejected",
                "draft_version": draft["version"],
                "values": {"recipe": {"title": ""}},
            },
        )
        self.assertEqual(reject_response.status_code, 200, reject_response.text)
        reject_data = reject_response.json()
        self.assertEqual(reject_data["approval"]["status"], "rejected")
        self.assertEqual(reject_data["draft"]["status"], "rejected")

    def test_ai_workspace_phase2_routes_meal_plan_without_mode_and_records_tools(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
        self.assertEqual(data["run"]["intent"], "meal_plan")
        cards = data["included"]["result_cards"]
        self.assertEqual(cards, [])
        self.assertEqual(data["included"]["drafts"][0]["draft_type"], "meal_plan")
        self.assertGreaterEqual(len(data["included"]["drafts"][0]["payload"]["items"]), 3)
        self.assertIn("番茄", str(data["included"]["drafts"][0]["payload"]))

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            tool_names = [item["name"] for item in run.tool_calls]
            self.assertIn("inventory.read_expiring_items", tool_names)
            self.assertIn("meal_plan.create_draft", tool_names)
            self.assertEqual(run.context_summary["routing"]["skills"], ["meal_plan"])

    def test_ai_workspace_phase_a_runs_composite_meal_plan_and_shopping_skills(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐，顺便生成购物清单"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["agent_key"], "workspace_planner")
        self.assertEqual(data["run"]["intent"], "multi_skill")
        self.assertEqual([draft["draft_type"] for draft in data["included"]["drafts"]], ["meal_plan"])
        self.assertEqual([approval["approval_type"] for approval in data["included"]["approvals"]], ["meal_plan.create"])
        self.assertEqual(data["included"]["result_cards"], [])
        self.assertEqual(data["run"]["status"], "waiting_approval")

        meal_plan_approval = data["included"]["approvals"][0]
        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{meal_plan_approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": meal_plan_approval["draft_version"],
                "values": meal_plan_approval["initial_values"],
            },
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        self.assertEqual(decision_response.json()["operation"]["business_entity_type"], "FoodPlanItem")

        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        pending = pending_response.json()
        self.assertEqual([approval["approval_type"] for approval in pending], ["shopping_list.create"])
        shopping_approval = pending[0]

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.context_summary["routing"]["skills"], ["meal_plan", "shopping_list"])
            tool_names = [item["name"] for item in run.tool_calls]
            self.assertIn("meal_plan.create_draft", tool_names)
            self.assertIn("shopping.create_draft", tool_names)
            assistant_messages = list(
                db.scalars(
                    select(AIMessage)
                    .where(AIMessage.run_id == data["run"]["id"], AIMessage.role == "assistant")
                    .order_by(AIMessage.created_at.asc())
                )
            )
            self.assertEqual(len(assistant_messages), 1)
            assistant_message = assistant_messages[0]
            approval_types = [
                part["approval"]["approval_type"]
                for part in assistant_message.parts
                if isinstance(part, dict) and part.get("type") == "approval_request"
            ]
            self.assertEqual(approval_types, ["meal_plan.create", "shopping_list.create"])
            card_types = [
                part["card"]["type"]
                for part in assistant_message.parts
                if isinstance(part, dict) and part.get("type") == "result_card"
            ]
            self.assertEqual(card_types, [])
            from app.ai.workflows.runner import WorkspaceGraphRunner

            response_after_second_skill = WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))._chat_response(
                data["conversation_id"], data["run"]["id"]
            )
            self.assertEqual([draft["draft_type"] for draft in response_after_second_skill["included"]["drafts"]], ["meal_plan", "shopping_list"])
            self.assertEqual(
                [approval["approval_type"] for approval in response_after_second_skill["included"]["approvals"]],
                ["meal_plan.create", "shopping_list.create"],
            )

        shopping_decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{shopping_approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": shopping_approval["draft_version"],
                "values": shopping_approval["initial_values"],
            },
        )
        self.assertEqual(shopping_decision_response.status_code, 200, shopping_decision_response.text)
        self.assertEqual(shopping_decision_response.json()["operation"]["business_entity_type"], "ShoppingListItem")

        with self.SessionLocal() as db:
            self.assertGreaterEqual(db.query(FoodPlanItem).count(), 3)
            self.assertGreaterEqual(db.query(ShoppingListItem).count(), 1)

    def test_ai_workspace_composite_rejection_stops_downstream_skills(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐，顺便生成购物清单"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]

        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "rejected",
                "draft_version": approval["draft_version"],
                "values": {},
            },
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        self.assertEqual(decision_response.json()["approval"]["status"], "rejected")
        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        self.assertEqual(pending_response.json(), [])

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.status, "cancelled")
            self.assertNotIn("shopping.create_draft", [item["name"] for item in run.tool_calls])

    def test_ai_workspace_approval_rejection_stream_returns_result_to_model(self) -> None:
        provider = FakeChatProvider("模型看到 HumanInLoop 结果后继续回复。")
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        original_message_id = data["message"]["id"]

        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision/stream",
                json={
                    "decision": "rejected",
                    "draft_version": approval["draft_version"],
                    "values": {},
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                body = "".join(stream_response.iter_text())

        self.assertIn("event: message_delta", body)
        self.assertIn("模型看到 HumanInLoop 结果后继续回复。", body)
        self.assertIn("event: response", body)
        self.assertIn(original_message_id, body)

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            message = db.get(AIMessage, original_message_id)
            self.assertIsNotNone(run)
            self.assertIsNotNone(message)
            assert run is not None and message is not None
            self.assertEqual(run.status, "cancelled")
            self.assertEqual(message.run_id, data["run"]["id"])
            self.assertEqual(message.role, "assistant")
            self.assertIn("模型看到 HumanInLoop 结果后继续回复。", message.content)
            part_types = [part.get("type") for part in message.parts if isinstance(part, dict)]
            self.assertEqual(part_types[-2:], ["approval_request", "text"])

    def test_ai_workspace_approval_decision_stream_resumes_downstream_skill(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐，顺便生成购物清单"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        meal_plan_approval = data["included"]["approvals"][0]

        with self.client.stream(
            "POST",
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{meal_plan_approval['id']}/decision/stream",
            json={
                "decision": "approved",
                "draft_version": meal_plan_approval["draft_version"],
                "values": meal_plan_approval["initial_values"],
            },
        ) as stream_response:
            self.assertEqual(stream_response.status_code, 200)
            body = "".join(stream_response.iter_text())

        self.assertIn("event: progress", body)
        self.assertIn("event: response", body)
        self.assertIn("shopping_list.create", body)
        self.assertIn("生成「购物清单确认表单」", body)
        self.assertLess(body.index("生成「购物清单确认表单」"), body.index("event: response"))

        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        pending = pending_response.json()
        self.assertEqual([approval["approval_type"] for approval in pending], ["shopping_list.create"])

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.status, "waiting_approval")
            tool_names = [item["name"] for item in run.tool_calls]
            self.assertIn("meal_plan.create_draft", tool_names)
            self.assertIn("shopping.create_draft", tool_names)

    def test_ai_workspace_waiting_approval_run_can_be_cancelled(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["status"], "waiting_approval")
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]

        cancel_response = self.client.post(f"/api/ai/runs/{data['run']['id']}/cancel")
        self.assertEqual(cancel_response.status_code, 200, cancel_response.text)
        cancel_data = cancel_response.json()
        self.assertEqual(cancel_data["run"]["status"], "cancelled")

        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        self.assertEqual(pending_response.json(), [])

        with self.SessionLocal() as db:
            stored_approval = db.get(AIApprovalRequest, approval["id"])
            stored_draft = db.get(AITaskDraft, draft["id"])
            self.assertIsNotNone(stored_approval)
            self.assertIsNotNone(stored_draft)
            assert stored_approval is not None and stored_draft is not None
            self.assertEqual(stored_approval.status, "cancelled")
            self.assertEqual(stored_draft.status, "rejected")

    def test_ai_workspace_phase2_uses_current_plan_for_shopping_draft(self) -> None:
        with self.SessionLocal() as db:
            recipe = Recipe(
                id="recipe-tomato-egg",
                family_id=self.family.id,
                title="番茄鸡蛋面",
                servings=2,
                prep_minutes=20,
                difficulty=Difficulty.EASY,
                tips="少油少盐",
                scene_tags=["晚餐", "家常菜"],
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            recipe_food = Food(
                id="food-tomato-egg",
                family_id=self.family.id,
                name="番茄鸡蛋面",
                type=FoodType.SELF_MADE,
                category="家常菜",
                flavor_tags=["清淡"],
                scene_tags=["晚餐"],
                suitable_meal_types=["dinner"],
                source_name="自家菜谱",
                purchase_source="",
                scene="晚餐",
                notes="",
                routine_note="适合用临期番茄。",
                recipe_id=recipe.id,
            )
            db.add_all(
                [
                    recipe,
                    recipe_food,
                    RecipeIngredient(
                        id="recipe-ingredient-tomato",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=2,
                        unit="个",
                        note="切块",
                        sort_order=0,
                    ),
                    RecipeIngredient(
                        id="recipe-ingredient-egg",
                        recipe_id=recipe.id,
                        ingredient_id=None,
                        ingredient_name="鸡蛋",
                        quantity=2,
                        unit="个",
                        note="打散",
                        sort_order=1,
                    ),
                ]
            )
            db.commit()

        plan_response = self.client.post("/api/ai/chat", json={"message": "用快过期食材安排三天晚餐"})
        self.assertEqual(plan_response.status_code, 200, plan_response.text)
        conversation_id = plan_response.json()["conversation_id"]

        shopping_response = self.client.post(
            "/api/ai/chat",
            json={"conversation_id": conversation_id, "message": "基于这个计划生成购物清单"},
        )
        self.assertEqual(shopping_response.status_code, 200, shopping_response.text)
        data = shopping_response.json()
        self.assertEqual(data["run"]["agent_key"], "shopping_agent")
        self.assertEqual(data["run"]["intent"], "shopping")
        self.assertEqual(data["included"]["result_cards"], [])
        shopping_items = data["included"]["drafts"][0]["payload"]["items"]
        self.assertTrue(any(item["title"] == "鸡蛋" for item in shopping_items), shopping_items)
        egg_item = next(item for item in shopping_items if item["title"] == "鸡蛋")
        self.assertEqual(egg_item["unit"], "个")
        self.assertIn("用于", egg_item["reason"])
        self.assertNotEqual(egg_item["title"], "通用配菜")
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            conversation = run.input["conversation"]
            self.assertTrue(
                any(
                    artifact["type"] == "meal_plan"
                    for message in conversation
                    for artifact in message.get("artifacts", [])
                )
            )
            self.assertIn("shopping.create_draft", [item["name"] for item in run.tool_calls])

    def test_ai_workspace_phase2_modifies_existing_meal_plan_draft(self) -> None:
        plan_response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
        self.assertEqual(plan_response.status_code, 200, plan_response.text)
        conversation_id = plan_response.json()["conversation_id"]

        modify_response = self.client.post(
            "/api/ai/chat",
            json={"conversation_id": conversation_id, "message": "第二天不要吃鸡肉，整体清淡一点"},
        )
        self.assertEqual(modify_response.status_code, 200, modify_response.text)
        data = modify_response.json()
        self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
        self.assertEqual(data["included"]["result_cards"], [])
        self.assertIn("清淡", str(data["included"]["drafts"][0]["payload"]))

    def test_ai_workspace_modifies_plan_after_deriving_shopping_list(self) -> None:
        plan_response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
        self.assertEqual(plan_response.status_code, 200, plan_response.text)
        conversation_id = plan_response.json()["conversation_id"]

        shopping_response = self.client.post(
            "/api/ai/chat",
            json={"conversation_id": conversation_id, "message": "基于这个计划生成购物清单"},
        )
        self.assertEqual(shopping_response.status_code, 200, shopping_response.text)
        self.assertEqual(shopping_response.json()["run"]["agent_key"], "shopping_agent")

        modify_response = self.client.post(
            "/api/ai/chat",
            json={
                "conversation_id": conversation_id,
                "message": "第二天不要吃鸡蛋，换成更适合孩子吃的，整体还是清淡",
            },
        )
        self.assertEqual(modify_response.status_code, 200, modify_response.text)
        data = modify_response.json()
        self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
        self.assertEqual(data["run"]["intent"], "meal_plan")
        self.assertEqual(data["included"]["result_cards"], [])
        self.assertEqual(data["included"]["drafts"][0]["draft_type"], "meal_plan")

        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            artifact_types = [
                artifact["type"]
                for message in run.input["conversation"]
                for artifact in message.get("artifacts", [])
            ]
            self.assertIn("meal_plan", artifact_types)
            self.assertIn("shopping_list", artifact_types)
            routing = run.context_summary["routing"]
            self.assertEqual(routing["skills"], ["meal_plan"])
            self.assertEqual(run.context_summary["skillExecutions"][0]["operation"], "modify")

    def test_planner_retries_invalid_structured_output_once(self) -> None:
        provider = SequenceChatProvider(["不是 JSON", '{"skills":["meal_plan"]}'])
        planner = WorkspacePlanner(provider=provider, skill_registry=build_workspace_skill_registry())
        result = planner.plan(
            PlannerRequest(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-artifacts",
                conversation=[{"id": "message-1", "role": "user", "content": "修改餐食计划", "artifacts": []}],
            )
        )

        self.assertEqual(result.skills, ["meal_plan"])
        self.assertEqual(result.attempts, 2)
        self.assertFalse(result.failed)

    def test_planner_accepts_a_single_complete_json_code_fence(self) -> None:
        planner = WorkspacePlanner(
            provider=SequenceChatProvider(['```json\n{"skills":["meal_plan"]}\n```']),
            skill_registry=build_workspace_skill_registry(),
        )
        result = planner.plan(
            PlannerRequest(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐", "artifacts": []}],
            )
        )
        self.assertEqual(result.skills, ["meal_plan"])
        self.assertFalse(result.failed)

    def test_planner_rejects_explanation_outside_json_code_fence(self) -> None:
        planner = WorkspacePlanner(
            provider=SequenceChatProvider(
                [
                    '结果如下：\n```json\n{"skills":["meal_plan"]}\n```',
                    '仍然错误：\n```json\n{"skills":["meal_plan"]}\n```',
                ]
            ),
            skill_registry=build_workspace_skill_registry(),
        )
        result = planner.plan(
            PlannerRequest(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐", "artifacts": []}],
            )
        )
        self.assertTrue(result.failed)
        self.assertEqual(result.error, "AI 规划结果格式不正确，请重试。")
        self.assertIn("invalid JSON", result.diagnostic or "")

    def test_openai_compatible_provider_falls_back_to_json_object_mode(self) -> None:
        provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
        provider.model_name = "compatible-model"
        base_client = MagicMock()
        schema_client = MagicMock()
        json_object_client = MagicMock()
        base_client.bind.side_effect = [schema_client, json_object_client, base_client]
        schema_client.invoke.side_effect = RuntimeError("json_schema unsupported")
        json_object_client.invoke.return_value = type("Message", (), {"content": '{"skills":["meal_plan"]}'})()
        provider.client = base_client

        result = provider.generate(
            system="只输出 JSON",
            user="安排晚餐",
            response_schema={"type": "object"},
        )

        self.assertEqual(result.text, '{"skills":["meal_plan"]}')
        self.assertEqual(result.structured_mode, "json_object")
        self.assertEqual(schema_client.invoke.call_count, 1)
        self.assertEqual(json_object_client.invoke.call_count, 1)

    def test_planner_fails_after_two_invalid_outputs_without_rule_fallback(self) -> None:
        planner = WorkspacePlanner(
            provider=SequenceChatProvider(["不是 JSON", '{"skills":["unknown_skill"]}']),
            skill_registry=build_workspace_skill_registry(),
        )
        result = planner.plan(
            PlannerRequest(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-artifacts",
                conversation=[{"id": "message-1", "role": "user", "content": "安排三天晚餐", "artifacts": []}],
            )
        )
        self.assertTrue(result.failed)
        self.assertEqual(result.skills, [])
        self.assertEqual(result.attempts, 2)

    def test_ai_workspace_phase2_asks_clarifying_question_for_underspecified_plan(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "帮我做菜单"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["intent"], "meal_plan")
        self.assertEqual(data["run"]["agent_key"], "meal_plan_agent")
        self.assertIn("几天", data["message"]["content"])

    def test_ai_workspace_phase3_confirms_shopping_list_draft(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "帮我生成补货清单", "quick_task": "shopping"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        self.assertEqual(approval["approval_type"], "shopping_list.create")

        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["operation"]["status"], "succeeded")
        self.assertEqual(decision_data["draft"]["status"], "confirmed")

        with self.SessionLocal() as db:
            self.assertEqual(db.query(ShoppingListItem).count(), len(approval["initial_values"]["draft"]["items"]))
            duplicate_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
            )
            self.assertEqual(duplicate_response.status_code, 409)
            self.assertEqual(db.query(AIOperation).count(), 1)

    def test_ai_workspace_phase3_confirms_meal_plan_draft(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        self.assertEqual(approval["approval_type"], "meal_plan.create")

        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["operation"]["business_entity_type"], "FoodPlanItem")
        self.assertGreaterEqual(len(decision_data["operation"]["business_entity_ids"]), 3)

        with self.SessionLocal() as db:
            self.assertGreaterEqual(db.query(FoodPlanItem).count(), 3)
            self.assertGreaterEqual(db.query(Food).count(), 1)

    def test_ai_workspace_phase3_confirms_meal_log_draft(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "今晚吃了番茄小炒", "quick_task": "meal_log"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        self.assertEqual(approval["approval_type"], "meal_log.create")

        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["operation"]["business_entity_type"], "MealLog")

        with self.SessionLocal() as db:
            self.assertEqual(db.query(MealLog).count(), 1)
            self.assertEqual(db.query(MealLogFood).count(), 1)
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            tool_names = [item["name"] for item in run.tool_calls]
            self.assertIn("food.search", tool_names)
            self.assertIn("meal_log.read_recent", tool_names)
            self.assertIn("meal_log.create_draft", tool_names)

    def test_ai_workspace_phase3_confirms_food_profile_draft(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "整理食物资料 蓝莓酸奶", "quick_task": "food_profile"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        self.assertEqual(approval["approval_type"], "food_profile.create")
        self.assertEqual(data["included"]["result_cards"], [])
        self.assertEqual(data["included"]["drafts"][0]["draft_type"], "food_profile")

        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={"decision": "approved", "draft_version": approval["draft_version"], "values": approval["initial_values"]},
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["operation"]["business_entity_type"], "Food")

        with self.SessionLocal() as db:
            self.assertEqual(db.query(Food).filter(Food.name == "蓝莓酸奶").count(), 1)
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertIsNotNone(run)
            assert run is not None
            tool_names = [item["name"] for item in run.tool_calls]
            self.assertIn("food.search", tool_names)
            self.assertIn("food_profile.create_draft", tool_names)

    def test_ai_workspace_phase3_rejects_cross_family_food_in_meal_plan(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        values = approval["initial_values"]
        values["draft"]["items"][0]["foodId"] = "food-other"
        with self.SessionLocal() as db:
            db.add(
                Food(
                    id="food-other",
                    family_id=self.other_family.id,
                    name="其他家庭菜",
                    type=FoodType.SELF_MADE,
                    category="家常菜",
                    flavor_tags=[],
                    scene="",
                    notes="",
                )
            )
            db.commit()

        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={"decision": "approved", "draft_version": approval["draft_version"], "values": values},
        )
        self.assertEqual(decision_response.status_code, 409)
        self.assertIn("当前家庭", decision_response.text)

    def test_ai_workspace_phase4_streams_progress_and_final_response(self) -> None:
        with self.client.stream(
            "POST",
            "/api/ai/chat/stream",
            json={"message": "今日吃什么？", "quick_task": "today_recommendation", "client_run_id": "agent_run-client-test"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            body = "".join(response.iter_text())
        self.assertIn("event: progress", body)
        self.assertIn("调用「餐食计划」技能", body)
        self.assertIn("调用「可用库存」", body)
        self.assertIn("agent_run-client-test", body)
        self.assertIn("event: message_delta", body)
        self.assertIn("我先看一下库存、菜谱和最近餐食。", body)
        self.assertIn("我按当前库存和最近餐食整理了今天的建议。", body)
        self.assertNotIn("<structured_result>", body)
        self.assertNotIn("读取上下文：inventory.read_available_items", body)
        self.assertIn("餐食计划执行完成", body)
        self.assertLess(body.index("我先看一下库存、菜谱和最近餐食。"), body.index("调用「可用库存」"))
        self.assertLess(body.index("调用「可用库存」"), body.index("我按当前库存和最近餐食整理了今天的建议。"))
        self.assertLess(body.index("调用「餐食计划」技能"), body.index("调用「可用库存」"))
        self.assertLess(body.index("调用「餐食计划」技能"), body.index("event: response"))
        self.assertLess(body.index("餐食计划执行完成"), body.index("event: response"))
        self.assertIn("event: response", body)
        self.assertIn("meal_plan_agent", body)
        self.assertIn("我先看一下库存、菜谱和最近餐食。\\n我按当前库存和最近餐食整理了今天的建议。", body)
        events_response = self.client.get("/api/ai/runs/agent_run-client-test/events")
        self.assertEqual(events_response.status_code, 200)
        event_messages = [event["user_message"] for event in events_response.json()]
        self.assertIn("调用「餐食计划」技能", event_messages)
        self.assertIn("调用「可用库存」", event_messages)
        self.assertIn("餐食计划执行完成", event_messages)

    def test_ai_workspace_phase4_streams_draft_progress_before_approval_response(self) -> None:
        with self.client.stream(
            "POST",
            "/api/ai/chat/stream",
            json={"message": "安排三天晚餐", "client_run_id": "agent_run-draft-stream-test"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            body = "".join(response.iter_text())
        self.assertIn("event: progress", body)
        self.assertIn("调用「餐食计划」技能", body)
        self.assertIn("调用「临期食材」", body)
        self.assertIn("生成「餐食计划确认表单」", body)
        self.assertIn("event: message_delta", body)
        self.assertIn("我先看一下临期食材和最近餐食。", body)
        self.assertIn("我生成了 3 条餐食计划草稿。", body)
        self.assertNotIn("<structured_result>", body)
        self.assertNotIn("正在生成餐食计划结构化结果", body)
        self.assertNotIn("餐食计划：已准备草稿", body)
        self.assertIn("餐食计划执行完成", body)
        self.assertLess(body.index("我先看一下临期食材和最近餐食。"), body.index("调用「临期食材」"))
        self.assertLess(body.index("生成「餐食计划确认表单」"), body.index("我生成了 3 条餐食计划草稿。"))
        self.assertLess(body.index("调用「餐食计划」技能"), body.index("调用「临期食材」"))
        self.assertLess(body.index("调用「临期食材」"), body.index("生成「餐食计划确认表单」"))
        self.assertLess(body.index("调用「餐食计划」技能"), body.index("event: response"))
        self.assertLess(body.index("餐食计划执行完成"), body.index("event: response"))
        self.assertIn("waiting_approval", body)
        self.assertIn("meal_plan.create", body)
        self.assertIn("我先看一下临期食材和最近餐食。\\n我生成了 3 条餐食计划草稿。", body)
        events_response = self.client.get("/api/ai/runs/agent_run-draft-stream-test/events")
        self.assertEqual(events_response.status_code, 200)
        event_messages = [event["user_message"] for event in events_response.json()]
        self.assertIn("调用「餐食计划」技能", event_messages)
        self.assertIn("调用「临期食材」", event_messages)
        self.assertIn("生成「餐食计划确认表单」", event_messages)
        self.assertIn("餐食计划执行完成", event_messages)

    def test_ai_workspace_phase4_streams_fallback_model_deltas_before_final_response(self) -> None:
        with patch("app.ai.workspace_service.get_chat_provider", return_value=StreamingChatProvider()):
            with self.client.stream(
                "POST",
                "/api/ai/chat/stream",
                json={"message": "随便聊聊", "client_run_id": "agent_run-stream-test"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                body = "".join(response.iter_text())
        self.assertIn("event: message_delta", body)
        self.assertIn("第一段", body)
        self.assertIn("第二段", body)
        self.assertLess(body.index("第一段"), body.index("event: response"))
        self.assertIn("general_chat_agent", body)

    def test_ai_workspace_stream_failure_marks_run_failed(self) -> None:
        with patch("app.ai.workspace_service.get_chat_provider", return_value=FailingStreamingChatProvider()):
            with self.client.stream(
                "POST",
                "/api/ai/chat/stream",
                json={"message": "随便聊聊", "client_run_id": "agent_run-stream-failure-test"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                body = "".join(response.iter_text())

        self.assertIn("event: message_delta", body)
        self.assertIn("event: error", body)
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, "agent_run-stream-failure-test")
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.status, "failed")
            self.assertIn("stream broke", run.error or "")
            message = db.scalar(
                select(AIMessage).where(
                    AIMessage.run_id == run.id,
                    AIMessage.role == "assistant",
                )
            )
            self.assertIsNotNone(message)
            assert message is not None
            self.assertEqual(message.status, "failed")
            event = db.scalar(
                select(AIRunEvent).where(
                    AIRunEvent.run_id == run.id,
                    AIRunEvent.internal_code == "runtime_exception",
                )
            )
            self.assertIsNotNone(event)
            assert event is not None
            self.assertEqual(event.status, "failed")

    def test_ai_workspace_phase4_cancel_running_run_records_event(self) -> None:
        with self.SessionLocal() as db:
            run = AIAgentRun(
                id="agent-run-cancel",
                family_id=self.family.id,
                conversation_id=None,
                message_id=None,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="meal_plan",
                input_summary="安排三天晚餐",
                context_summary={},
                output_summary="",
                status="running",
                model="rules",
                input={"prompt": "安排三天晚餐", "subject": {}},
                output={},
                tool_calls=[],
                duration_ms=0,
                created_by=self.user.id,
            )
            db.add(run)
            db.commit()
        response = self.client.post("/api/ai/runs/agent-run-cancel/cancel")
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["status"], "cancelled")
        self.assertEqual(data["events"][0]["internal_code"], "user_cancel")

    def test_ai_workspace_finalize_does_not_overwrite_cancelled_run(self) -> None:
        from app.ai.workflows.runner import WorkspaceGraphRunner

        with self.SessionLocal() as db:
            conversation = AIConversation(
                id="conversation-cancel-finalize",
                family_id=self.family.id,
                mode=AiMode.RECOMMENDATION,
                prompt="安排三天晚餐",
                response="",
                context={"workspace": True},
                last_run_status="cancelled",
                created_by=self.user.id,
            )
            run = AIAgentRun(
                id="agent_run-cancel-finalize",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id=None,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="meal_plan",
                input_summary="安排三天晚餐",
                context_summary={},
                output_summary="",
                status="cancelled",
                model="fake-model",
                input={"prompt": "安排三天晚餐", "subject": {}},
                output={},
                tool_calls=[],
                duration_ms=0,
                created_by=self.user.id,
            )
            db.add_all([conversation, run])
            db.flush()

            WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))._finalize(
                {
                    "family_id": self.family.id,
                    "user_id": self.user.id,
                    "conversation_id": conversation.id,
                    "run_id": run.id,
                    "message": "安排三天晚餐",
                    "status": "completed",
                    "error": None,
                }
            )

            self.assertEqual(run.status, "cancelled")
            self.assertEqual(conversation.last_run_status, "cancelled")

    def test_ai_workspace_phase4_retries_failed_run_in_same_conversation(self) -> None:
        failed_response = self.client.post("/api/ai/chat", json={"message": "随便聊聊"})
        self.assertEqual(failed_response.status_code, 200, failed_response.text)
        data = failed_response.json()
        with self.SessionLocal() as db:
            run = db.get(AIAgentRun, data["run"]["id"])
            assert run is not None
            run.status = "failed"
            run.error = "forced failure"
            db.commit()
        retry_response = self.client.post(f"/api/ai/runs/{data['run']['id']}/retry")
        self.assertEqual(retry_response.status_code, 200, retry_response.text)
        retry_data = retry_response.json()
        self.assertEqual(retry_data["conversation_id"], data["conversation_id"])
        self.assertNotEqual(retry_data["run"]["id"], data["run"]["id"])

    def test_ai_workspace_phase4_regenerates_message_part_with_same_context(self) -> None:
        response = self.client.post("/api/ai/chat", json={"message": "今日吃什么？", "quick_task": "today_recommendation"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        result_part = next(part for part in data["message"]["parts"] if part["type"] == "result_card")
        regenerate_response = self.client.post(
            f"/api/ai/messages/{data['message']['id']}/parts/{result_part['id']}/regenerate"
        )
        self.assertEqual(regenerate_response.status_code, 200, regenerate_response.text)
        regenerated = regenerate_response.json()
        self.assertEqual(regenerated["conversation_id"], data["conversation_id"])
        self.assertEqual(regenerated["run"]["agent_key"], data["run"]["agent_key"])

    def test_recipe_draft_api_returns_failed_without_fallback_draft_when_provider_disabled(self) -> None:
        response = self.client.post(
            "/api/ai/recipes/draft",
            json={
                "title": "番茄快手菜",
                "prompt": "清淡一点",
                "ingredient_ids": ["ingredient-tomato"],
                "extra_ingredients": ["葱花"],
                "generate_image": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "failed")
        self.assertIsNone(data["draft"])
        self.assertIsNone(data["image_render_payload"])
        with self.SessionLocal() as db:
            run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == data["agent_run_id"]))
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.feature_key, "aiRecipeDraft")
            self.assertEqual(run.status, "failed")
            self.assertEqual(run.input["context"]["inventoryItemCount"], 0)
            self.assertEqual(run.input["context"]["mealLogCount"], 0)

    def test_recipe_draft_api_requires_minimum_input(self) -> None:
        response = self.client.post("/api/ai/recipes/draft", json={})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("菜名", response.json()["detail"])

    def test_recipe_draft_runner_preserves_family_scoped_ingredients_from_valid_json(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄炖蛋",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "错名", "quantity": 2, "unit": "斤", "note": "切块"},
                {"ingredient_id": "ingredient-secret", "ingredient_name": "其他家庭牛排", "quantity": 1, "unit": "块", "note": ""}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切成 2 厘米块，鸡蛋或蛋液提前备好。保持食材大小接近，后面中火炖煮 8 分钟时更容易均匀熟透。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "炖煮", "text": "锅中少油，中火炒番茄 3 分钟到出汁变软。加入少量水后继续炖煮 5 分钟，看到汤汁冒泡并略微浓稠。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["中火"]},
                {"title": "收尾", "text": "倒入蛋液后保持小火 2 分钟，让蛋液完全凝固。确认没有透明蛋液、汤汁略收后再调味出锅。", "icon": "plate", "summary": "熟透出锅", "estimated_minutes": 5, "tip": "出锅前尝味。", "key_points": ["确认熟透"]}
              ],
              "tips": "少油少盐。",
              "scene_tags": ["晚餐", "清淡"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = self._generate_recipe_draft(
                db,
                provider,
                prompt="清淡",
                subject={"ingredientIds": ["ingredient-tomato", "ingredient-secret"]},
            )
        draft = result["draft"]
        self.assertEqual(result["status"], "completed")
        self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
        self.assertEqual(draft["ingredient_items"][0]["ingredient_name"], "番茄")
        self.assertNotIn("ingredient-secret", [item["ingredient_id"] for item in draft["ingredient_items"]])
        self.assertIsInstance(draft["steps"][0], dict)

    def test_recipe_draft_runner_parses_fenced_json_response(self) -> None:
        provider = FakeChatProvider(
            """
            ```json
            {
              "title": "番茄炒蛋",
              "servings": 2,
              "prep_minutes": 15,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "洗净切块"},
                {"ingredient_id": null, "ingredient_name": "鸡蛋", "quantity": 3, "unit": "个", "note": "打散备用"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切块，鸡蛋打散备用。保持食材大小接近，方便后面均匀受热。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "炒蛋", "text": "热锅少油，中火倒入蛋液炒到刚凝固。看到表面还有少量嫩液时盛出备用。", "icon": "pan", "summary": "先炒鸡蛋", "estimated_minutes": 4, "tip": "不要久炒。", "key_points": ["中火", "刚凝固"]},
                {"title": "炒番茄", "text": "锅中补少量油，中火下番茄炒 3 分钟。看到番茄出汁变软后再调味。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 5, "tip": "番茄要炒出汁。", "key_points": ["炒出汁"]},
                {"title": "收尾", "text": "鸡蛋回锅后加盐翻匀 1 分钟。确认鸡蛋熟透、汤汁略收后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 2, "tip": "出锅前尝味。", "key_points": ["熟透", "尝味"]}
              ],
              "tips": "中火快炒，保留鸡蛋嫩度。",
              "scene_tags": ["家常菜", "快手菜"]
            }
            ```
            """
        )
        with self.SessionLocal() as db:
            result = self._generate_recipe_draft(
                db,
                provider,
                prompt="番茄炒蛋",
                subject={"ingredientIds": ["ingredient-tomato"]},
            )

        draft = result["draft"]
        self.assertEqual(result["status"], "completed")
        self.assertEqual(draft["title"], "番茄炒蛋")
        self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")

    def test_recipe_draft_runner_splits_merged_scene_tags(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄快手菜",
              "servings": 2,
              "prep_minutes": 15,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "洗净切块"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切成 2 厘米块，蒜末提前备好。食材大小保持接近，后面中火快炒时更容易均匀熟透。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "翻炒", "text": "热锅少油，中火下番茄翻炒 3 到 4 分钟。看到番茄边缘变软并出汁后再调味。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 6, "tip": "保持中火。", "key_points": ["中火", "出汁"]},
                {"title": "收尾", "text": "加盐后继续翻炒 1 分钟，让味道进入汤汁。确认番茄软而不碎、汤汁略收后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 3, "tip": "出锅前尝味。", "key_points": ["尝味", "装盘"]}
              ],
              "tips": "适合临时加一道清爽小菜。",
              "scene_tags": ["家常菜、快手菜", "晚餐/午餐", "快手菜"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = self._generate_recipe_draft(
                db,
                provider,
                prompt="快手",
                subject={"ingredientIds": ["ingredient-tomato"]},
            )

        draft = result["draft"]
        self.assertEqual(result["status"], "completed")
        self.assertEqual(draft["scene_tags"], ["家常菜", "快手菜", "晚餐", "午餐"])

    def test_recipe_draft_runner_parses_json_surrounded_by_text(self) -> None:
        provider = FakeChatProvider(
            """
            下面是生成结果：
            {
              "title": "清炒番茄",
              "servings": 2,
              "prep_minutes": 12,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                {"ingredient_id": null, "ingredient_name": "蒜", "quantity": 2, "unit": "瓣", "note": "拍碎"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切块，蒜瓣拍碎备用。切块尽量均匀，方便中火快炒。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "爆香", "text": "锅热后加少量油，小火下蒜炒 30 秒。闻到蒜香但没有焦色时加入番茄。", "icon": "pan", "summary": "炒香蒜", "estimated_minutes": 2, "tip": "蒜不要炒焦。", "key_points": ["小火"]},
                {"title": "翻炒", "text": "转中火翻炒番茄 3 到 4 分钟。看到番茄边缘变软并出汁后再调味。", "icon": "pan", "summary": "炒软出汁", "estimated_minutes": 4, "tip": "中火更稳。", "key_points": ["出汁"]},
                {"title": "收尾", "text": "加盐后翻匀 1 分钟，让味道进入汤汁。确认番茄软而不碎后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 1, "tip": "最后调味更容易控制咸淡。", "key_points": ["尝味", "装盘"]}
              ],
              "tips": "适合搭配米饭或面条。",
              "scene_tags": ["家常菜"]
            }
            以上 JSON 可直接使用。
            """
        )
        with self.SessionLocal() as db:
            result = self._generate_recipe_draft(
                db,
                provider,
                prompt="清淡",
                subject={"ingredientIds": ["ingredient-tomato"]},
            )

        draft = result["draft"]
        self.assertEqual(result["status"], "completed")
        self.assertEqual(draft["title"], "清炒番茄")
        self.assertGreaterEqual(len(draft["steps"]), 3)

    def test_recipe_draft_runner_fails_without_fallback_on_invalid_json(self) -> None:
        with self.SessionLocal() as db:
            result = self._generate_recipe_draft(
                db,
                FakeChatProvider("不是 JSON"),
                prompt="清淡",
                subject={"ingredientIds": ["ingredient-tomato"]},
            )
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["draft"])
        self.assertEqual(result["error"], "model returned invalid recipe draft JSON")
        self.assertIsNone(result["image_render_payload"])

    def test_recipe_draft_runner_rejects_low_quality_steps_without_local_fallback(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄炒蛋",
              "servings": 2,
              "prep_minutes": 16,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "个", "note": ""},
                {"ingredient_id": null, "ingredient_name": "鸡蛋", "quantity": 1, "unit": "个", "note": ""}
              ],
              "steps": [
                {"title": "备菜", "text": "处理食材", "icon": "pan", "summary": "", "estimated_minutes": 2, "tip": "", "key_points": []},
                {"title": "炒熟", "text": "翻炒均匀", "icon": "pan", "summary": "", "estimated_minutes": 3, "tip": "", "key_points": []}
              ],
              "tips": "",
              "scene_tags": ["晚餐"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = self._generate_recipe_draft(
                db,
                provider,
                prompt="更细一点",
                subject={"ingredientIds": ["ingredient-tomato"]},
            )

        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["draft"])
        self.assertEqual(result["error"], "model returned invalid recipe draft JSON")

    def test_recipe_draft_runner_keeps_selected_ingredient_ids_and_default_units(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄鸡蛋汤",
              "servings": 3,
              "prep_minutes": 12,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "斤", "note": "切块"},
                {"ingredient_id": "ingredient-secret", "ingredient_name": "其他家庭牛排", "quantity": 1, "unit": "块", "note": ""}
              ],
              "steps": [
                {"title": "处理", "text": "番茄切成小块，鸡蛋打散后加 1 勺清水。食材提前备好，后面中火煮 5 分钟时能更快熟透。", "icon": "tomato", "summary": "处理", "estimated_minutes": 4, "tip": "", "key_points": ["切块"]},
                {"title": "煮汤", "text": "锅中加水煮到沸腾后下番茄，中火煮 5 分钟。看到番茄变软出汁、汤色微红后再倒蛋液。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 5, "tip": "", "key_points": ["煮开"]},
                {"title": "收尾", "text": "沿锅边倒入蛋液，小火保持 2 分钟让蛋花凝固。确认蛋液熟透、汤面重新冒泡后加盐调味出锅。", "icon": "plate", "summary": "收尾", "estimated_minutes": 3, "tip": "", "key_points": ["出锅"]}
              ],
              "tips": "清淡。",
              "scene_tags": ["午餐"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = self._generate_recipe_draft(
                db,
                provider,
                prompt="清淡一点",
                subject={"ingredientIds": ["ingredient-tomato", "ingredient-secret"]},
            )

        draft = result["draft"]
        self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
        self.assertEqual(draft["ingredient_items"][0]["unit"], "个")
        self.assertNotIn("ingredient-secret", [item["ingredient_id"] for item in draft["ingredient_items"]])

    def test_recipe_image_prompts_do_not_force_banner_composition(self) -> None:
        draft = {
            "title": "番茄炒蛋",
            "tips": "少油少盐。",
            "scene_tags": ["晚餐", "家常"],
            "ingredient_items": [{"ingredient_name": "番茄"}, {"ingredient_name": "鸡蛋"}],
        }
        payload = build_recipe_image_render_payload(draft)
        prompt = build_ai_image_prompt(
            ImageGenerationRequest(
                entity_type=MediaEntityType.RECIPE,
                mode=ImageGenerationMode.TEXT,
                title=payload["title"],
                category=payload["category"],
                notes=payload["notes"],
                tags=payload["tags"],
                scene=payload["scene"],
                ingredient_names=payload["ingredient_names"],
                size=payload["size"],
            )
        )

        forbidden_terms = ["banner", "Banner", "横幅", "横向", "页面顶部", "顶部主图"]
        for term in forbidden_terms:
            with self.subTest(term=term):
                self.assertNotIn(term, payload["notes"])
                self.assertNotIn(term, prompt)

    def test_reference_image_prompt_prioritizes_unified_style_over_copying_source(self) -> None:
        prompt = build_ai_image_prompt(
            ImageGenerationRequest(
                entity_type=MediaEntityType.INGREDIENT,
                mode=ImageGenerationMode.REFERENCE,
                title="番茄",
                category="蔬菜",
                notes="新鲜红番茄",
                reference_image_bytes=b"fake",
                reference_filename="tomato.jpg",
            )
        )

        self.assertIn("参考图只用于识别主体", prompt)
        self.assertIn("重新在 Culina 统一摄影棚里拍了一张标准主图", prompt)
        self.assertIn("与纯文字生成模式一致", prompt)
        self.assertIn("不要复制原图的拍摄角度", prompt)
        self.assertIn("参考图仅作为主体识别补充", prompt)
        self.assertIn("统一为约 4:3 卡片比例", prompt)

    def test_family_and_user_image_prompts_do_not_request_round_avatar_rendering(self) -> None:
        family_prompt = build_ai_image_prompt(
            ImageGenerationRequest(
                entity_type=MediaEntityType.FAMILY,
                mode=ImageGenerationMode.TEXT,
                title="三餐四季",
                category="上海",
                notes="喜欢明亮温暖的厨房氛围",
            )
        )
        user_prompt = build_ai_image_prompt(
            ImageGenerationRequest(
                entity_type=MediaEntityType.USER,
                mode=ImageGenerationMode.TEXT,
                title="小雨",
                category="Owner",
                notes="清爽、柔和、厨房感",
            )
        )

        self.assertNotIn("适合圆形裁切", family_prompt)
        self.assertNotIn("适合圆形裁切", user_prompt)
        self.assertIn("前端展示时可再做圆形遮罩", user_prompt)

    def test_image_generation_normalizes_all_modes_to_standard_card_size(self) -> None:
        calls: list[dict] = []

        class FakeHttpxClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback) -> None:
                return None

            def post(self, url: str, **kwargs):
                calls.append({"url": url, **kwargs})
                return httpx.Response(
                    200,
                    json={"data": [{"b64_json": base64.b64encode(b"fake-image").decode("ascii")}]},
                )

        provider = OpenAIImageGenerationProvider(
            ImageProviderConfig(
                provider="openai",
                api_base="https://example.test/v1",
                api_key="test-key",
                model="gpt-image-2",
            )
        )
        with patch("app.ai.images.generation.httpx.Client", FakeHttpxClient):
            provider.generate_from_text(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.RECIPE,
                    mode=ImageGenerationMode.TEXT,
                    title="番茄炒蛋",
                    size="1792*1008",
                )
            )
            provider.generate_from_reference(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.INGREDIENT,
                    mode=ImageGenerationMode.REFERENCE,
                    title="番茄",
                    size="960*1280",
                    reference_image_bytes=b"fake",
                    reference_filename="tomato.jpg",
                )
            )

        self.assertEqual(calls[0]["json"]["size"], "1536x1024")
        self.assertEqual(calls[1]["data"]["size"], "1536x1024")

    def test_openai_image_provider_uses_configured_endpoint_and_key(self) -> None:
        calls: list[dict] = []

        class FakeHttpxClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback) -> None:
                return None

            def post(self, url: str, **kwargs):
                calls.append({"url": url, **kwargs})
                return httpx.Response(
                    200,
                    json={"data": [{"b64_json": base64.b64encode(b"fake-image").decode("ascii")}]},
                )

        provider = OpenAIImageGenerationProvider(
            ImageProviderConfig(
                provider="openai",
                api_base="https://example.test/v1",
                api_key="test-key",
                model="gpt-image-2",
            )
        )
        with patch("app.ai.images.generation.httpx.Client", FakeHttpxClient):
            result = provider.generate_from_text(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.FOOD,
                    mode=ImageGenerationMode.TEXT,
                    title="番茄炒蛋",
                    size="1664*1040",
                )
            )

        self.assertEqual(result.binary_content, b"fake-image")
        self.assertEqual(result.file_extension, ".png")
        self.assertEqual(result.mime_type, "image/png")
        self.assertEqual(calls[0]["url"], "https://example.test/v1/images/generations")
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(calls[0]["json"]["model"], "gpt-image-2")
        self.assertEqual(calls[0]["json"]["size"], "1536x1024")
        self.assertEqual(calls[0]["json"]["output_format"], "png")

    def test_openai_image_provider_config_defaults_to_openai_base(self) -> None:
        class FakeSettings:
            ai_image_reference_provider = "openai"
            ai_image_reference_api_base = ""
            ai_image_reference_api_key = "reference-key"
            ai_image_reference_model = ""
            ai_image_text_provider = "openai"
            ai_image_text_api_base = ""
            ai_image_text_api_key = "text-key"
            ai_image_text_model = ""

        with patch("app.ai.images.generation.get_settings", return_value=FakeSettings()):
            text_config = _build_provider_config(ImageGenerationMode.TEXT)
            reference_config = _build_provider_config(ImageGenerationMode.REFERENCE)

        self.assertEqual(text_config.api_base, "https://api.openai.com/v1")
        self.assertEqual(text_config.model, "gpt-image-2")
        self.assertEqual(reference_config.api_base, "https://api.openai.com/v1")
        self.assertEqual(reference_config.model, "gpt-image-2")


if __name__ == "__main__":
    unittest.main()
