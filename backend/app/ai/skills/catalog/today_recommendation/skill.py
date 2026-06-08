from __future__ import annotations

from pathlib import Path

from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult


class TodayRecommendationSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        inventory = context.tool_executor.call("inventory.read_available_items", {"limit": 50})
        expiring = context.tool_executor.call("inventory.read_expiring_items", {"days": 7})
        foods = context.tool_executor.call("food.search", {"limit": 12})
        recipes = context.tool_executor.call("recipe.search", {"limit": 12})
        recent = context.tool_executor.call("meal_log.read_recent", {"limit": 5})
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
        card = {
            "id": "today-recommendation",
            "type": "today_recommendation",
            "title": "今日吃什么",
            "data": {"recommendations": recommendations, "contextSummary": {"inventoryCount": len(available_items), "expiringCount": len(expiring_items), "recentMealCount": len(recent_logs), "recipeCount": len(recipe_items)}},
        }
        return SkillResult(text=text, cards=[card], context_summary={"inventoryItemCount": len(available_items), "expiringItemCount": len(expiring_items), "recentMealCount": len(recent_logs), "recipeCount": len(recipe_items)})


def create_skill(manifest: SkillManifest, skill_dir: Path) -> BaseSkill:
    return TodayRecommendationSkill(manifest, skill_dir)
