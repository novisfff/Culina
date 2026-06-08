from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.ai.skills.shared import artifact_by_id, json_object, meal_type_label, model_name, norm_name, normalize_meal_types


class MealPlanSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        expiring = context.tool_executor.call("inventory.read_expiring_items", {"days": 7})
        inventory = context.tool_executor.call("inventory.read_available_items", {"limit": 80})
        recent_logs = context.tool_executor.call("meal_log.read_recent", {"limit": 8})
        foods = context.tool_executor.call("food.search", {"limit": 24})
        recipes = context.tool_executor.call("recipe.search", {"limit": 24})
        existing_plans = context.tool_executor.call("meal_plan.read_existing", {"limit": 20})

        decision = self._decide_with_model(
            context=context,
            expiring=expiring,
            inventory=inventory,
            foods=foods,
            recipes=recipes,
            recent_logs=recent_logs,
        )
        if decision is None:
            return SkillResult(text="餐食计划模型没有返回有效结果，请重试。", status="failed", model=model_name(context), error="invalid meal plan model response")

        operation = str(decision.get("operation") or "")
        if operation == "clarify":
            return SkillResult(text=str(decision.get("clarification") or "请补充餐食计划的范围和偏好。"), model=model_name(context), operation="clarify", requires_clarification=True)

        source_artifact_id = str(decision.get("sourceArtifactId") or "")
        if operation == "modify" and artifact_by_id(context, source_artifact_id, "meal_plan") is None:
            return SkillResult(
                text="没有找到要修改的餐食计划草稿。",
                status="failed",
                model=model_name(context),
                error="meal plan source artifact is invalid",
                operation=operation,
                source_artifact_id=source_artifact_id or None,
            )

        meal_types = normalize_meal_types(decision.get("mealTypes"))
        days = max(1, min(int(decision.get("days") or 3), 7))
        constraints = [str(item) for item in decision.get("constraints") or [] if item]
        entries = self._normalize_entries(decision.get("items"), days=days, meal_types=meal_types)
        if not entries:
            return SkillResult(text="餐食计划模型没有生成可用的计划项，请重试。", status="failed", model=model_name(context), error="meal plan items are empty", operation=operation)

        draft = {
            "draftType": "meal_plan",
            "schemaVersion": "meal_plan.v1",
            "items": entries,
            "source": {
                "days": days,
                "mealTypes": meal_types,
                "expiringInventoryIds": [item.get("id") for item in expiring.get("items", [])[:8]],
                "modifiedFromDraftId": source_artifact_id or None,
                "constraints": constraints,
            },
        }
        context.tool_executor.call("meal_plan.create_draft", {"draft": draft})
        card = {
            "id": "meal-plan-draft",
            "type": "meal_plan_draft",
            "title": "餐食计划草稿",
            "data": {"draft": draft, "summary": f"{days} 天 · {', '.join(meal_type_label(item) for item in meal_types)}", "items": entries},
        }
        return SkillResult(
            text=f"我生成了 {len(entries)} 条餐食计划草稿，优先考虑了临期库存、最近餐食和你的口味约束。每条计划都标出了使用库存和可能缺少的食材。",
            cards=[card],
            drafts=[{"draft_type": "meal_plan", "payload": draft, "schema_version": "meal_plan.v1"}],
            events=[
                {"type": "tool", "message": "已读取临期库存、最近餐食和候选菜品"},
                {"type": "draft", "message": "已生成带缺口说明的餐食计划草稿"},
            ],
            context_summary={
                "inventoryItemCount": inventory.get("count", 0),
                "expiringItemCount": expiring.get("count", 0),
                "recentMealCount": recent_logs.get("count", 0),
                "existingPlanCount": existing_plans.get("count", 0),
                "draftType": "meal_plan",
                "constraints": constraints,
            },
            state_patch={"activeTask": "meal_plan", "activeDraftType": "meal_plan", "slots": {"days": days, "mealTypes": meal_types, "constraints": constraints}, "lastSkillResults": [{"skillKey": "meal_plan", "draftType": "meal_plan"}]},
            model=model_name(context),
            operation=operation,
            source_artifact_id=source_artifact_id or None,
        )

    def _decide_with_model(self, *, context: SkillContext, expiring: dict[str, Any], inventory: dict[str, Any], foods: dict[str, Any], recipes: dict[str, Any], recent_logs: dict[str, Any]) -> dict[str, Any] | None:
        if context.provider is None or self.skill_dir is None:
            return None
        system = (self.skill_dir / "prompts" / "system.md").read_text(encoding="utf-8").strip()
        schema = json.loads((self.skill_dir / "schemas" / "decision.schema.json").read_text(encoding="utf-8"))
        user = json.dumps(
            {
                "conversation": context.conversation,
                "currentMessage": context.current_message,
                "expiringInventory": expiring.get("items", [])[:12],
                "availableInventory": inventory.get("items", [])[:40],
                "foods": foods.get("items", [])[:24],
                "recipes": recipes.get("items", [])[:24],
                "recentMealLogs": recent_logs.get("items", [])[:8],
                "today": date.today().isoformat(),
            },
            ensure_ascii=False,
            default=str,
        )
        result = context.provider.generate(system=system, user=user, response_schema=schema)
        return json_object(result.text) if result.text else None

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
            if meal_type not in {"breakfast", "lunch", "dinner", "snack"}:
                meal_type = meal_types[len(normalized) % len(meal_types)]
            title = norm_name(item.get("title"))
            if not title:
                continue
            normalized.append(
                {
                    "date": plan_date.isoformat(),
                    "mealType": meal_type,
                    "title": title[:80],
                    "foodId": item.get("foodId") or None,
                    "recipeId": item.get("recipeId") or None,
                    "reason": norm_name(item.get("reason")) or "根据当前厨房上下文生成。",
                    "usedInventory": [str(value) for value in item.get("usedInventory") or [] if value],
                    "missingIngredients": [str(value) for value in item.get("missingIngredients") or [] if value],
                }
            )
        return normalized or None


def create_skill(manifest: SkillManifest, skill_dir: Path) -> BaseSkill:
    return MealPlanSkill(manifest, skill_dir)
