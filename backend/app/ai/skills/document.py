from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from app.ai.kitchen.context import load_agent_context
from app.ai.kitchen.recipe_drafts import (
    RECIPE_DRAFT_JSON_SCHEMA,
    RecipeDraftGenerationInput,
    build_recipe_draft_messages,
    normalize_recipe_draft,
)
from app.ai.skills.base import BaseSkill, SkillContext, SkillResult
from app.ai.skills.context_policy import read_skill_context
from app.ai.skills.runner_registry import register_skill_runner
from app.ai.skills.shared import (
    artifact_by_id,
    conversation_artifacts,
    json_object,
    legacy_subject,
    meal_type_label,
    model_name,
    norm_name,
    normalize_meal_types,
)
from app.core.enums import AiMode, FoodType


MEAL_PLAN_DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "operation": {"type": "string", "enum": ["create", "modify", "clarify"]},
        "sourceArtifactId": {"type": ["string", "null"]},
        "days": {"type": "integer", "minimum": 1, "maximum": 7},
        "mealTypes": {"type": "array", "minItems": 1, "items": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]}},
        "constraints": {"type": "array", "items": {"type": "string"}},
        "clarification": {"type": ["string", "null"]},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "date": {"type": "string"},
                    "mealType": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
                    "title": {"type": "string"},
                    "foodId": {"type": ["string", "null"]},
                    "recipeId": {"type": ["string", "null"]},
                    "reason": {"type": "string"},
                    "usedInventory": {"type": "array", "items": {"type": "string"}},
                    "missingIngredients": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["date", "mealType", "title", "foodId", "recipeId", "reason", "usedInventory", "missingIngredients"],
            },
        },
    },
    "required": ["operation", "sourceArtifactId", "days", "mealTypes", "constraints", "clarification", "items"],
}

SHOPPING_LIST_DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "operation": {"type": "string", "enum": ["create", "derive", "modify", "clarify"]},
        "sourceArtifactId": {"type": ["string", "null"]},
        "clarification": {"type": ["string", "null"]},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "quantity": {"type": "number", "exclusiveMinimum": 0},
                    "unit": {"type": "string"},
                    "reason": {"type": "string"},
                    "sourceMeals": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title", "quantity", "unit", "reason", "sourceMeals"],
            },
        },
    },
    "required": ["operation", "sourceArtifactId", "clarification", "items"],
}

MEAL_LOG_DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["operation", "date", "mealType", "foods", "notes", "clarification"],
    "properties": {
        "operation": {"type": "string", "enum": ["create", "clarify"]},
        "date": {"type": "string"},
        "mealType": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]},
        "foods": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["foodId", "name", "servings", "note"],
                "properties": {
                    "foodId": {"type": ["string", "null"]},
                    "name": {"type": "string"},
                    "servings": {"type": "number", "exclusiveMinimum": 0},
                    "note": {"type": "string"},
                },
            },
        },
        "notes": {"type": "string"},
        "clarification": {"type": ["string", "null"]},
    },
}

FOOD_PROFILE_DECISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "operation",
        "clarification",
        "name",
        "type",
        "category",
        "flavor_tags",
        "scene_tags",
        "suitable_meal_types",
        "source_name",
        "purchase_source",
        "scene",
        "notes",
        "routine_note",
        "price",
        "rating",
        "repurchase",
        "expiry_date",
        "stock_quantity",
        "stock_unit",
        "favorite",
        "recipe_id",
    ],
    "properties": {
        "operation": {"type": "string", "enum": ["create", "clarify"]},
        "clarification": {"type": ["string", "null"]},
        "name": {"type": "string"},
        "type": {"type": "string", "enum": ["selfMade", "takeout", "diningOut", "readyMade", "instant", "packaged"]},
        "category": {"type": "string"},
        "flavor_tags": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        "scene_tags": {"type": "array", "maxItems": 20, "items": {"type": "string"}},
        "suitable_meal_types": {"type": "array", "maxItems": 4, "items": {"type": "string", "enum": ["breakfast", "lunch", "dinner", "snack"]}},
        "source_name": {"type": "string"},
        "purchase_source": {"type": "string"},
        "scene": {"type": "string"},
        "notes": {"type": "string"},
        "routine_note": {"type": "string"},
        "price": {"type": ["number", "null"], "minimum": 0},
        "rating": {"type": ["integer", "null"], "minimum": 1, "maximum": 5},
        "repurchase": {"type": ["boolean", "null"]},
        "expiry_date": {"type": ["string", "null"]},
        "stock_quantity": {"type": ["number", "null"], "minimum": 0},
        "stock_unit": {"type": "string"},
        "favorite": {"type": "boolean"},
        "recipe_id": {"type": ["string", "null"]},
    },
}

FOOD_TYPE_VALUES = {item.value for item in FoodType}
MEAL_TYPE_VALUES = {"breakfast", "lunch", "dinner", "snack"}


class DocumentDecisionSkill(BaseSkill):
    def _instructions(self) -> str:
        if self.skill_dir is None:
            return ""
        chunks = [(self.skill_dir / "SKILL.md").read_text(encoding="utf-8").strip()]
        for file_name in [*self.manifest.workflow_files, *self.manifest.hitl_files, *self.manifest.example_files]:
            path = self.skill_dir / file_name
            if path.exists():
                chunks.append(path.read_text(encoding="utf-8").strip())
        for file_name in self.manifest.script_files:
            path = self.skill_dir / file_name
            if path.exists():
                chunks.append(
                    "## Script reference\n"
                    "Scripts are deterministic helper references only; do not claim they write data.\n\n"
                    f"# {file_name}\n\n{path.read_text(encoding='utf-8').strip()}"
                )
        return "\n\n---\n\n".join(chunks)

    def _generate_decision(self, context: SkillContext, *, payload: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any] | None:
        if context.provider is None:
            return None
        payload = {**payload, "scriptHelpers": self.scripts.describe()}
        result = context.provider.generate(
            system=(
                "你是 Culina AI 工作台的文档型 Skill Runner。"
                "必须严格遵守 SKILL.md、workflow、HITL 和 JSON Schema。"
                "只输出符合 schema 的 JSON object，不输出 Markdown、解释或额外字段。"
                "\n\n"
                f"{self._instructions()}"
            ),
            user=json.dumps(payload, ensure_ascii=False, default=str),
            response_schema=schema,
        )
        return json_object(result.text) if result.text else None


class TodayRecommendationSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        tool_outputs = read_skill_context(
            context,
            self.manifest,
            payloads={
                "inventory.read_available_items": {"limit": 50},
                "inventory.read_expiring_items": {"days": 7},
                "food.search": {"limit": 12},
                "recipe.search": {"limit": 12},
                "meal_log.read_recent": {"limit": 5},
            },
        )
        inventory = tool_outputs["inventory.read_available_items"]
        expiring = tool_outputs["inventory.read_expiring_items"]
        foods = tool_outputs["food.search"]
        recipes = tool_outputs["recipe.search"]
        recent = tool_outputs["meal_log.read_recent"]
        available_items = inventory.get("items", [])
        expiring_items = expiring.get("items", [])
        recent_logs = recent.get("items", [])
        recipe_items = recipes.get("items", [])
        food_items = foods.get("items", [])
        evidence = [
            {
                "type": "inventory_item",
                "id": item.get("id"),
                "label": item.get("label"),
                "status": "expiring" if item in expiring_items else "available",
                "detail": f"{item.get('quantity', '')}{item.get('unit', '')}",
            }
            for item in (expiring_items or available_items[:3])
        ]
        ingredient_names = [item["label"] for item in evidence]
        candidates = [food.get("name") for food in food_items[:3] if food.get("name")] or [recipe.get("title") for recipe in recipe_items[:3] if recipe.get("title")]
        if not candidates and ingredient_names:
            candidates = [f"{ingredient_names[0]}快手菜"]
        if not candidates:
            candidates = ["清爽家常菜"]
        recommendations = []
        for index, title in enumerate(candidates[:3]):
            reason_bits = []
            if ingredient_names:
                reason_bits.append(f"可优先使用 {', '.join(ingredient_names[:2])}")
            if recent_logs:
                reason_bits.append("参考了最近餐食，尽量避免重复")
            recommendations.append({"title": title, "reason": "，".join(reason_bits) or "适合作为今天的一餐，准备成本低。", "evidence": evidence[:2] if index == 0 else evidence[:1]})
        text = "我按当前库存和最近餐食整理了今天的建议。"
        if expiring_items:
            text += " 其中临期食材优先级最高。"
        return SkillResult(
            text=text,
            cards=[
                {
                    "id": "today-recommendation",
                    "type": "today_recommendation",
                    "title": "今日吃什么",
                    "data": {"recommendations": recommendations, "contextSummary": {"inventoryCount": len(available_items), "expiringCount": len(expiring_items), "recentMealCount": len(recent_logs), "recipeCount": len(recipe_items)}},
                }
            ],
            context_summary={"inventoryItemCount": len(available_items), "expiringItemCount": len(expiring_items), "recentMealCount": len(recent_logs), "recipeCount": len(recipe_items)},
        )


class RecipeDraftSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        tool_outputs = read_skill_context(context, self.manifest, payloads={"ingredient.search": {"limit": 50}})
        provider = context.provider
        subject = dict(legacy_subject(context))
        subject.setdefault("title", self._infer_title(context.current_message))
        subject.setdefault("servings", 2)
        draft_input = RecipeDraftGenerationInput(prompt=context.current_message, subject=subject)
        agent_context = load_agent_context(context.db, family_id=context.family_id, mode=AiMode.RECIPE_DRAFT, subject=subject, include_inventory=False, include_meal_logs=False)
        context_record = {**agent_context.to_record(), "ingredientCatalogCount": tool_outputs.get("ingredient.search", {}).get("count", 0)}
        if provider is None:
            return SkillResult(text="现在还不能生成菜谱草稿：AI provider 未配置。", status="failed", model="rules", error="AI provider 未配置", context_summary=context_record)
        system, user = build_recipe_draft_messages(agent_context, draft_input)
        result = provider.generate(system=system, user=user, response_schema=RECIPE_DRAFT_JSON_SCHEMA)
        if not result.text:
            return SkillResult(text="这次没有生成可用的菜谱草稿。", status="failed", model=result.model, error=result.error or "provider returned no structured recipe draft", context_summary=context_record)
        draft = normalize_recipe_draft(result.text, agent_context, draft_input)
        if draft is None:
            return SkillResult(text="模型返回的菜谱结构不完整，我没有把它保存成草稿。", status="failed", model=result.model, error="invalid recipe draft json", context_summary=context_record)
        context.tool_executor.call("recipe.create_draft", {"draft": draft})
        title = draft.get("title", "菜谱草稿")
        return SkillResult(
            text=f"我生成了《{title}》的菜谱草稿，包含 {len(draft.get('ingredient_items', []))} 个食材项和 {len(draft.get('steps', []))} 个步骤。你可以先编辑，再确认创建菜谱。",
            drafts=[{"draft_type": "recipe", "payload": draft, "schema_version": "recipe.v1"}],
            context_summary=context_record,
            status="completed",
            model=result.model,
        )

    def _infer_title(self, prompt: str) -> str:
        text = prompt.strip()
        for prefix in ["帮我生成一份", "帮我生成", "生成一份", "生成", "做一份", "做"]:
            if text.startswith(prefix):
                text = text[len(prefix) :].strip()
                break
        for suffix in ["的菜谱", "菜谱", "，", ",", "。"]:
            if suffix in text:
                text = text.split(suffix, 1)[0].strip()
        return text[:40]


class MealPlanSkill(DocumentDecisionSkill):
    def run(self, context: SkillContext) -> SkillResult:
        tool_outputs = read_skill_context(
            context,
            self.manifest,
            payloads={
                "inventory.read_expiring_items": {"days": 7},
                "inventory.read_available_items": {"limit": 80},
                "meal_log.read_recent": {"limit": 8},
                "food.search": {"limit": 24},
                "recipe.search": {"limit": 24},
                "meal_plan.read_existing": {"limit": 20},
            },
        )
        decision = self._decide(context, tool_outputs, repair=False)
        if decision is None:
            return self._failed(context, "餐食计划模型没有返回有效结果，请重试。", "invalid meal plan model response")
        result = self._result_from_decision(context, tool_outputs, decision)
        if result.status == "failed" and result.error in {"meal plan items are empty", "meal plan script validation failed"}:
            repaired = self._decide(context, tool_outputs, repair=True, previous_decision=decision, repair_error=result.error)
            if repaired is not None:
                return self._result_from_decision(context, tool_outputs, repaired)
        return result

    def _decide(self, context: SkillContext, tool_outputs: dict[str, dict[str, Any]], *, repair: bool, repair_error: str | None = None, previous_decision: dict[str, Any] | None = None) -> dict[str, Any] | None:
        payload = {
            "conversation": context.conversation,
            "currentMessage": context.current_message,
            "expiringInventory": tool_outputs["inventory.read_expiring_items"].get("items", [])[:12],
            "availableInventory": tool_outputs["inventory.read_available_items"].get("items", [])[:40],
            "foods": tool_outputs["food.search"].get("items", [])[:24],
            "recipes": tool_outputs["recipe.search"].get("items", [])[:24],
            "recentMealLogs": tool_outputs["meal_log.read_recent"].get("items", [])[:8],
            "today": date.today().isoformat(),
        }
        if repair:
            payload["repair"] = {"reason": repair_error or "meal plan decision needs repair", "previousDecision": previous_decision or {}, "instruction": "请保留原始意图，修复 items，使其至少包含一个有 title/date/mealType 的计划项。"}
        return self._generate_decision(context, payload=payload, schema=MEAL_PLAN_DECISION_SCHEMA)

    def _result_from_decision(self, context: SkillContext, tool_outputs: dict[str, dict[str, Any]], decision: dict[str, Any]) -> SkillResult:
        operation = str(decision.get("operation") or "")
        if operation == "clarify":
            return SkillResult(text=str(decision.get("clarification") or "请补充餐食计划的范围和偏好。"), model=model_name(context), operation="clarify", requires_clarification=True)
        source_artifact_id = str(decision.get("sourceArtifactId") or "")
        if operation == "modify" and artifact_by_id(context, source_artifact_id, "meal_plan") is None:
            return self._failed(context, "没有找到要修改的餐食计划草稿。", "meal plan source artifact is invalid", operation=operation, source_artifact_id=source_artifact_id or None)
        meal_types = normalize_meal_types(decision.get("mealTypes"))
        try:
            days = max(1, min(int(decision.get("days") or 3), 7))
        except (TypeError, ValueError):
            days = 3
        constraints = [str(item) for item in decision.get("constraints") or [] if item]
        entries = self._normalize_entries(decision.get("items"), days=days, meal_types=meal_types)
        if not entries:
            return self._failed(context, "餐食计划模型没有生成可用的计划项，请重试。", "meal plan items are empty", operation=operation)
        validation = self.scripts.call_optional("validate_meal_plan", entries)
        if isinstance(validation, dict) and not validation.get("valid", False):
            return self._failed(
                context,
                "餐食计划草稿没有通过结构校验，我会重新整理一次。",
                "meal plan script validation failed",
                operation=operation,
                source_artifact_id=source_artifact_id or None,
                context_summary={"scriptValidation": validation},
            )
        expiring = tool_outputs["inventory.read_expiring_items"]
        draft = {
            "draftType": "meal_plan",
            "schemaVersion": "meal_plan.v1",
            "items": entries,
            "source": {"days": days, "mealTypes": meal_types, "expiringInventoryIds": [item.get("id") for item in expiring.get("items", [])[:8]], "modifiedFromDraftId": source_artifact_id or None, "constraints": constraints},
        }
        context.tool_executor.call("meal_plan.create_draft", {"draft": draft})
        return SkillResult(
            text=f"我生成了 {len(entries)} 条餐食计划草稿，优先考虑了临期库存、最近餐食和你的口味约束。每条计划都标出了使用库存和可能缺少的食材。",
            drafts=[{"draft_type": "meal_plan", "payload": draft, "schema_version": "meal_plan.v1"}],
            events=[{"type": "tool", "message": "已读取临期库存、最近餐食和候选菜品"}, {"type": "script", "message": "已用 Skill 脚本校验餐食计划草稿"}, {"type": "draft", "message": "已生成带缺口说明的餐食计划草稿"}],
            context_summary={"inventoryItemCount": tool_outputs["inventory.read_available_items"].get("count", 0), "expiringItemCount": expiring.get("count", 0), "recentMealCount": tool_outputs["meal_log.read_recent"].get("count", 0), "existingPlanCount": tool_outputs["meal_plan.read_existing"].get("count", 0), "draftType": "meal_plan", "constraints": constraints, "scriptValidation": validation or {}},
            state_patch={"activeTask": "meal_plan", "activeDraftType": "meal_plan", "slots": {"days": days, "mealTypes": meal_types, "constraints": constraints}, "lastSkillResults": [{"skillKey": "meal_plan", "draftType": "meal_plan"}]},
            model=model_name(context),
            operation=operation,
            source_artifact_id=source_artifact_id or None,
        )

    def _normalize_entries(self, items: Any, *, days: int, meal_types: list[str]) -> list[dict[str, Any]] | None:
        if not isinstance(items, list) or not items:
            return None
        normalized: list[dict[str, Any]] = []
        expected_count = days * len(meal_types)
        for item in items[:expected_count]:
            if not isinstance(item, dict):
                continue
            try:
                plan_date = date.fromisoformat(str(item.get("date")))
            except ValueError:
                plan_date = date.today() + timedelta(days=len(normalized) // max(len(meal_types), 1))
            meal_type = str(item.get("mealType") or meal_types[len(normalized) % len(meal_types)])
            if meal_type not in MEAL_TYPE_VALUES:
                meal_type = meal_types[len(normalized) % len(meal_types)]
            title = norm_name(item.get("title"))
            if not title:
                continue
            normalized.append({"date": plan_date.isoformat(), "mealType": meal_type, "title": title[:80], "foodId": item.get("foodId") or None, "recipeId": item.get("recipeId") or None, "reason": norm_name(item.get("reason")) or "根据当前厨房上下文生成。", "usedInventory": [str(value) for value in item.get("usedInventory") or [] if value], "missingIngredients": [str(value) for value in item.get("missingIngredients") or [] if value]})
        return normalized or None

    def _failed(self, context: SkillContext, text: str, error: str, *, operation: str | None = None, source_artifact_id: str | None = None, context_summary: dict[str, Any] | None = None) -> SkillResult:
        return SkillResult(text=text, status="failed", model=model_name(context), error=error, operation=operation, source_artifact_id=source_artifact_id, context_summary=context_summary or {})


class ShoppingListSkill(DocumentDecisionSkill):
    def run(self, context: SkillContext) -> SkillResult:
        tool_outputs = read_skill_context(context, self.manifest, payloads={"shopping.read_pending": {"limit": 50}, "inventory.read_available_items": {"limit": 80}})
        decision = self._decide(context, tool_outputs, repair=False)
        if decision is None:
            return SkillResult(text="购物清单模型没有返回有效结果，请重试。", status="failed", model=model_name(context), error="invalid shopping list model response")
        result = self._result_from_decision(context, tool_outputs, decision)
        if result.error == "shopping list items are empty" and self._has_repair_context(context, tool_outputs["inventory.read_available_items"]):
            repaired = self._decide(context, tool_outputs, repair=True, previous_decision=decision, repair_error=result.error)
            if repaired is not None:
                return self._result_from_decision(context, tool_outputs, repaired)
        return result

    def _decide(self, context: SkillContext, tool_outputs: dict[str, dict[str, Any]], *, repair: bool, repair_error: str | None = None, previous_decision: dict[str, Any] | None = None) -> dict[str, Any] | None:
        payload = {"conversation": context.conversation, "currentMessage": context.current_message, "availableArtifacts": conversation_artifacts(context), "availableInventory": tool_outputs["inventory.read_available_items"].get("items", [])[:80], "pendingShopping": tool_outputs["shopping.read_pending"].get("items", [])[:50]}
        if repair:
            payload["repair"] = {"reason": repair_error or "shopping list decision needs repair", "previousDecision": previous_decision or {}, "instruction": "请保留原始意图，修复 items，使购物清单至少包含一个 title/quantity/unit 项。"}
        return self._generate_decision(context, payload=payload, schema=SHOPPING_LIST_DECISION_SCHEMA)

    def _result_from_decision(self, context: SkillContext, tool_outputs: dict[str, dict[str, Any]], decision: dict[str, Any]) -> SkillResult:
        operation = str(decision.get("operation") or "")
        if operation == "clarify":
            return SkillResult(text=str(decision.get("clarification") or "请说明购物清单要基于哪个计划。"), model=model_name(context), operation="clarify", requires_clarification=True)
        source_artifact_id = str(decision.get("sourceArtifactId") or "")
        if operation in {"derive", "modify"}:
            expected_type = "meal_plan" if operation == "derive" else "shopping_list"
            if artifact_by_id(context, source_artifact_id, expected_type) is None:
                return SkillResult(text="没有找到购物清单所引用的有效草稿。", status="failed", model=model_name(context), error=f"invalid {expected_type} source artifact", operation=operation, source_artifact_id=source_artifact_id or None)
        draft_items = self._normalize_model_items(decision.get("items"))
        pending = tool_outputs["shopping.read_pending"]
        inventory = tool_outputs["inventory.read_available_items"]
        if not draft_items:
            return SkillResult(text="当前没有需要加入购物清单的项目。", context_summary={"inventoryItemCount": inventory.get("count", 0), "pendingShoppingCount": pending.get("count", 0)}, model=model_name(context), operation=operation, source_artifact_id=source_artifact_id or None, error="shopping list items are empty")
        pending_titles = {item.get("title") for item in pending.get("items", [])}
        for item in draft_items:
            item["alreadyPending"] = item["title"] in pending_titles
        draft = {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1", "items": draft_items, "sourceDraftId": source_artifact_id or None}
        context.tool_executor.call("shopping.create_draft", {"draft": draft})
        return SkillResult(
            text=f"我根据餐食计划里的缺失食材合并了 {len(draft_items)} 个购物清单草稿项，并标注了每项来源。",
            drafts=[{"draft_type": "shopping_list", "payload": draft, "schema_version": "shopping_list.v1"}],
            events=[{"type": "tool", "message": "已读取待采购项和当前可用库存"}, {"type": "draft", "message": "已按餐食计划缺口合并购物清单草稿"}],
            context_summary={"inventoryItemCount": inventory.get("count", 0), "pendingShoppingCount": pending.get("count", 0), "draftType": "shopping_list"},
            state_patch={"activeTask": "shopping_list", "activeDraftType": "shopping_list", "lastSkillResults": [{"skillKey": "shopping_list", "draftType": "shopping_list"}]},
            model=model_name(context),
            operation=operation,
            source_artifact_id=source_artifact_id or None,
        )

    def _has_repair_context(self, context: SkillContext, inventory: dict[str, Any]) -> bool:
        return bool(conversation_artifacts(context, "meal_plan") or inventory.get("items"))

    def _normalize_model_items(self, value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        merged: dict[tuple[str, str], dict[str, Any]] = {}
        for item in value:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or "").strip()
            normalized_title = self.scripts.call_optional("normalize_ingredient", title)
            if isinstance(normalized_title, str) and normalized_title.strip():
                title = normalized_title.strip()
            unit = str(item.get("unit") or "份").strip()
            if not title:
                continue
            key = (title, unit)
            if key not in merged:
                merged[key] = {"title": title, "quantity": 0.0, "unit": unit, "reason": str(item.get("reason") or ""), "sourceMeals": []}
            merged[key]["quantity"] = round(float(merged[key]["quantity"]) + max(float(item.get("quantity") or 1), 0.1), 2)
            for source in item.get("sourceMeals") or []:
                source_text = str(source)
                if source_text and source_text not in merged[key]["sourceMeals"]:
                    merged[key]["sourceMeals"].append(source_text)
        items = list(merged.values())
        for item in items:
            if not item["reason"] and item["sourceMeals"]:
                item["reason"] = f"用于 {'；'.join(item['sourceMeals'][:3])}"
        return items


class MealLogSkill(DocumentDecisionSkill):
    def run(self, context: SkillContext) -> SkillResult:
        tool_outputs = read_skill_context(context, self.manifest, payloads={"food.search": {"limit": 80}, "meal_log.read_recent": {"limit": 8}})
        foods = tool_outputs["food.search"].get("items", [])
        recent_logs = tool_outputs["meal_log.read_recent"].get("items", [])
        decision = self._generate_decision(
            context,
            payload={"conversation": context.conversation, "currentMessage": context.current_message, "foods": foods[:80], "recentMealLogs": recent_logs[:8], "today": date.today().isoformat()},
            schema=MEAL_LOG_DECISION_SCHEMA,
        )
        if decision is None:
            return SkillResult(text="餐食记录模型没有返回有效结果，请重试。", status="failed", model=model_name(context), error="invalid meal log model response")
        if str(decision.get("operation") or "") == "clarify":
            return SkillResult(text=str(decision.get("clarification") or "请补充这餐吃了什么。"), model=model_name(context), operation="clarify", requires_clarification=True)
        draft_foods = self._normalize_foods(decision.get("foods"), known_foods=foods)
        if not draft_foods:
            return SkillResult(text="我还需要知道这餐具体吃了哪些食物。", model=model_name(context), operation="clarify", requires_clarification=True)
        meal_type = str(decision.get("mealType") or "dinner")
        if meal_type not in MEAL_TYPE_VALUES:
            meal_type = "dinner"
        try:
            meal_date = date.fromisoformat(str(decision.get("date") or date.today().isoformat()))
        except ValueError:
            meal_date = date.today()
        draft = {"draftType": "meal_log", "schemaVersion": "meal_log.v1", "date": meal_date.isoformat(), "mealType": meal_type, "foods": draft_foods, "notes": norm_name(decision.get("notes")) or context.current_message.strip()}
        context.tool_executor.call("meal_log.create_draft", {"draft": draft})
        matched_count = sum(1 for item in draft_foods if item.get("foodId"))
        return SkillResult(
            text=f"我整理了一条{meal_type_label(meal_type)}餐食记录草稿，包含 {len(draft_foods)} 个食物项，其中 {matched_count} 个已匹配到食物库。确认后才会写入餐食记录。",
            drafts=[{"draft_type": "meal_log", "payload": draft, "schema_version": "meal_log.v1"}],
            events=[{"type": "tool", "message": "已读取食物库和最近餐食记录"}, {"type": "draft", "message": "已生成可编辑的餐食记录草稿"}],
            context_summary={"foodCount": len(foods), "recentMealCount": len(recent_logs), "draftType": "meal_log", "matchedFoodCount": matched_count},
            state_patch={"activeTask": "meal_log", "activeDraftType": "meal_log", "lastSkillResults": [{"skillKey": "meal_log", "draftType": "meal_log"}]},
            model=model_name(context),
            operation=str(decision.get("operation") or "create"),
        )

    def _normalize_foods(self, value: Any, *, known_foods: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        known_by_id = {str(item.get("id")): item for item in known_foods if item.get("id")}
        normalized: list[dict[str, Any]] = []
        for item in value[:20]:
            if not isinstance(item, dict):
                continue
            food_id = str(item.get("foodId") or "") or None
            known = known_by_id.get(food_id) if food_id else None
            name = norm_name(item.get("name")) or norm_name(known.get("name") if known else "")
            if food_id and known is None:
                food_id = None
            if not name and food_id is None:
                continue
            try:
                servings = float(item.get("servings") or 1)
            except (TypeError, ValueError):
                servings = 1
            normalized.append({"foodId": food_id, "name": name[:80], "servings": max(servings, 0.1), "note": (norm_name(item.get("note")) or "从描述中整理")[:255]})
        return normalized


class FoodProfileSkill(DocumentDecisionSkill):
    def run(self, context: SkillContext) -> SkillResult:
        foods = read_skill_context(context, self.manifest, payloads={"food.search": {"limit": 80}})["food.search"].get("items", [])
        decision = self._generate_decision(
            context,
            payload={"conversation": context.conversation, "currentMessage": context.current_message, "foods": foods[:80], "today": date.today().isoformat()},
            schema=FOOD_PROFILE_DECISION_SCHEMA,
        )
        if decision is None:
            return SkillResult(text="食物资料模型没有返回有效结果，请重试。", status="failed", model=model_name(context), error="invalid food profile model response")
        if str(decision.get("operation") or "") == "clarify":
            return SkillResult(text=str(decision.get("clarification") or "请补充要整理的食物名称或描述。"), model=model_name(context), operation="clarify", requires_clarification=True)
        payload = self._normalize_draft(decision, foods=foods, fallback_notes=context.current_message)
        if payload is None:
            return SkillResult(text="我还需要知道要整理的食物名称。", model=model_name(context), operation="clarify", requires_clarification=True)
        context.tool_executor.call("food_profile.create_draft", {"draft": payload})
        return SkillResult(
            text=f"我整理了一份 {payload['name']} 的食物资料草稿，确认后才会写入食物库。",
            drafts=[{"draft_type": "food_profile", "payload": payload, "schema_version": "food_profile.v1"}],
            events=[{"type": "tool", "message": "已读取当前家庭食物资料"}, {"type": "draft", "message": "已生成可编辑的食物资料草稿"}],
            context_summary={"foodCount": len(foods), "draftType": "food_profile"},
            state_patch={"activeTask": "food_profile", "activeDraftType": "food_profile", "lastSkillResults": [{"skillKey": "food_profile", "draftType": "food_profile"}]},
            model=model_name(context),
            operation=str(decision.get("operation") or "create"),
        )

    def _normalize_draft(self, decision: dict[str, Any], *, foods: list[dict[str, Any]], fallback_notes: str) -> dict[str, Any] | None:
        name = norm_name(decision.get("name"))
        if not name:
            return None
        matched = next((item for item in foods if item.get("name") == name), None)
        food_type = str(decision.get("type") or (matched or {}).get("type") or FoodType.READY_MADE.value)
        if food_type not in FOOD_TYPE_VALUES:
            food_type = FoodType.READY_MADE.value
        suitable_meal_types = [str(item) for item in decision.get("suitable_meal_types") or (matched or {}).get("suitableMealTypes") or [] if str(item) in MEAL_TYPE_VALUES]
        if not suitable_meal_types:
            suitable_meal_types = ["breakfast", "lunch", "dinner"]
        recipe_id = decision.get("recipe_id") or (matched or {}).get("recipeId") or None
        return {
            "draftType": "food_profile",
            "schemaVersion": "food_profile.v1",
            "name": name[:80],
            "type": food_type,
            "category": (norm_name(decision.get("category")) or norm_name((matched or {}).get("category")) or "AI整理")[:80],
            "flavor_tags": self._string_list(decision.get("flavor_tags") or (matched or {}).get("flavorTags"), maximum=20),
            "scene_tags": self._string_list(decision.get("scene_tags") or (matched or {}).get("sceneTags"), maximum=20),
            "suitable_meal_types": suitable_meal_types[:4],
            "source_name": norm_name(decision.get("source_name"))[:80],
            "purchase_source": norm_name(decision.get("purchase_source"))[:80],
            "scene": (norm_name(decision.get("scene")) or norm_name((matched or {}).get("scene")))[:255],
            "notes": (norm_name(decision.get("notes")) or fallback_notes.strip())[:1000],
            "routine_note": (norm_name(decision.get("routine_note")) or norm_name((matched or {}).get("routineNote")) or "由 AI 工作台整理，确认前可继续编辑。")[:1000],
            "price": self._optional_nonnegative_float(decision.get("price")),
            "rating": self._optional_rating(decision.get("rating")),
            "repurchase": decision.get("repurchase") if isinstance(decision.get("repurchase"), bool) else None,
            "expiry_date": self._optional_date(decision.get("expiry_date")),
            "stock_quantity": self._optional_nonnegative_float(decision.get("stock_quantity")),
            "stock_unit": norm_name(decision.get("stock_unit"))[:20],
            "favorite": bool(decision.get("favorite")),
            "recipe_id": str(recipe_id) if recipe_id else None,
            "media_ids": [],
        }

    def _string_list(self, value: Any, *, maximum: int) -> list[str]:
        if not isinstance(value, list):
            return []
        return list(dict.fromkeys(norm_name(item)[:40] for item in value if norm_name(item)))[:maximum]

    def _optional_nonnegative_float(self, value: Any) -> float | None:
        if value is None or value == "":
            return None
        try:
            return max(float(value), 0)
        except (TypeError, ValueError):
            return None

    def _optional_rating(self, value: Any) -> int | None:
        if value is None or value == "":
            return None
        try:
            return max(1, min(int(value), 5))
        except (TypeError, ValueError):
            return None

    def _optional_date(self, value: Any) -> str | None:
        if not value:
            return None
        try:
            return date.fromisoformat(str(value)).isoformat()
        except ValueError:
            return None


register_skill_runner("today_recommendation", TodayRecommendationSkill)
register_skill_runner("recipe_draft", RecipeDraftSkill)
register_skill_runner("meal_plan", MealPlanSkill)
register_skill_runner("shopping_list", ShoppingListSkill)
register_skill_runner("meal_log", MealLogSkill)
register_skill_runner("food_profile", FoodProfileSkill)
