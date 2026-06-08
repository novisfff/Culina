from __future__ import annotations

from datetime import date
from pathlib import Path

from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.ai.skills.shared import meal_type_label, normalize_meal_types


class MealLogSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        foods_result = context.tool_executor.call("food.search", {"limit": 50})
        recent_result = context.tool_executor.call("meal_log.read_recent", {"limit": 8})
        foods = foods_result.get("items", [])
        recent_logs = recent_result.get("items", [])
        meal_type = normalize_meal_types([])[0]
        prompt = context.current_message.strip()
        matched_foods = [food for food in foods if food.get("name") and food["name"] in prompt]
        draft_foods = [{"foodId": food["id"], "name": food["name"], "servings": 1, "note": "从描述中匹配到已有食物"} for food in matched_foods[:5]]
        if not draft_foods:
            raw = prompt.replace("今晚吃了", "").replace("今天吃了", "").replace("记录餐食", "").strip(" ，。")
            names = [item.strip() for item in raw.replace("和", "、").replace(",", "、").split("、") if item.strip()]
            draft_foods = [{"foodId": None, "name": name[:40], "servings": 1, "note": "待确认是否创建或关联食物"} for name in names[:5]]
        draft = {"draftType": "meal_log", "schemaVersion": "meal_log.v1", "date": date.today().isoformat(), "mealType": meal_type, "foods": draft_foods, "notes": prompt}
        context.tool_executor.call("meal_log.create_draft", {"draft": draft})
        card = {"id": "meal-log-draft", "type": "meal_log_draft", "title": "餐食记录草稿", "data": {"draft": draft, "foods": draft_foods, "summary": f"{meal_type_label(meal_type)} · {len(draft_foods)} 个食物项"}}
        return SkillResult(
            text=f"我整理了一条{meal_type_label(meal_type)}餐食记录草稿，包含 {len(draft_foods)} 个食物项。确认后才会写入餐食记录。",
            cards=[card],
            drafts=[{"draft_type": "meal_log", "payload": draft, "schema_version": "meal_log.v1"}],
            context_summary={"foodCount": len(foods), "recentMealCount": len(recent_logs), "draftType": "meal_log"},
        )


def create_skill(manifest: SkillManifest, skill_dir: Path) -> BaseSkill:
    return MealLogSkill(manifest, skill_dir)
