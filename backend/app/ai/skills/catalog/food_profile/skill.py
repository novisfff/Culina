from __future__ import annotations

from pathlib import Path

from app.ai.skills.base import BaseSkill, SkillContext, SkillManifest, SkillResult
from app.core.enums import FoodType


def _enum_value(value):
    return value.value if hasattr(value, "value") else value


class FoodProfileSkill(BaseSkill):
    def run(self, context: SkillContext) -> SkillResult:
        prompt = context.current_message.strip()
        foods_result = context.tool_executor.call("food.search", {"limit": 40})
        foods = foods_result.get("items", [])
        name = prompt
        for marker in ["补全", "整理", "食物资料", "资料", "创建食物", "新增食物"]:
            name = name.replace(marker, "")
        name = name.strip(" ，。")[:40] or "待完善食物"
        matched = next((food for food in foods if food.get("name") and (food["name"] in prompt or prompt in food["name"])), None)
        payload = {
            "draftType": "food_profile",
            "schemaVersion": "food_profile.v1",
            "name": matched["name"] if matched else name,
            "type": _enum_value(matched["type"]) if matched else FoodType.READY_MADE.value,
            "category": matched.get("category") if matched else "AI整理",
            "flavor_tags": matched.get("flavorTags", []) if matched else [],
            "scene_tags": matched.get("sceneTags", []) if matched else ["AI整理"],
            "suitable_meal_types": matched.get("suitableMealTypes", []) if matched else ["breakfast", "lunch", "dinner"],
            "source_name": "",
            "purchase_source": "",
            "scene": matched.get("scene", "") if matched else "",
            "notes": prompt,
            "routine_note": matched.get("routineNote", "") if matched else "由 AI 工作台整理，确认前可继续编辑。",
            "price": None,
            "rating": None,
            "repurchase": None,
            "expiry_date": None,
            "stock_quantity": None,
            "stock_unit": "",
            "favorite": False,
            "recipe_id": matched.get("recipeId") if matched else None,
            "media_ids": [],
        }
        context.tool_executor.call("food_profile.create_draft", {"draft": payload})
        card = {"id": "food-profile-draft", "type": "food_profile_draft", "title": "食物资料草稿", "data": {"draft": payload, "summary": f"{payload['name']} · {payload['category']}", "items": [{"title": payload["name"], "reason": payload["routine_note"]}]}}
        return SkillResult(
            text=f"我整理了一份 {payload['name']} 的食物资料草稿，确认后才会写入食物库。",
            cards=[card],
            drafts=[{"draft_type": "food_profile", "payload": payload, "schema_version": "food_profile.v1"}],
            context_summary={"foodCount": len(foods), "draftType": "food_profile"},
        )


def create_skill(manifest: SkillManifest, skill_dir: Path) -> BaseSkill:
    return FoodProfileSkill(manifest, skill_dir)
