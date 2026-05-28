from __future__ import annotations

from datetime import date as date_type

from app.ai.kitchen.formatters import build_alerts_for_date, recipe_availability_score
from app.core.utils import create_id, utcnow
from app.models.domain import AIRecommendation, Food, InventoryItem, MealLog
from app.services.clock import today_for_family


def rank_recommendation_candidates(
    foods: list[Food],
    inventory_items: list[InventoryItem],
    meal_logs: list[MealLog],
    today: date_type | None = None,
) -> list[tuple[Food, float]]:
    target_date = today or today_for_family()
    eaten_food_ids = {
        entry.food_id
        for meal in meal_logs
        if meal.date == target_date
        for entry in meal.food_entries
    }
    candidates = [
        (food, recipe_availability_score(food.recipe, inventory_items))
        for food in foods
        if food.id not in eaten_food_ids
    ]
    candidates.sort(key=lambda item: item[1], reverse=True)
    return candidates


def pick_recommendation(
    family_id: str,
    foods: list[Food],
    inventory_items: list[InventoryItem],
    meal_logs: list[MealLog],
) -> AIRecommendation:
    today = today_for_family(family_id)
    candidates = rank_recommendation_candidates(foods, inventory_items, meal_logs, today=today)
    best_food, score = candidates[0] if candidates else (foods[0] if foods else None, 0.0)
    alerts = build_alerts_for_date(inventory_items, today)

    return AIRecommendation(
        id=create_id("recommendation"),
        family_id=family_id,
        title=f"今晚推荐：{best_food.name}" if best_food else "今晚推荐一份轻松晚餐",
        detail=(
            f"匹配库存度 {round(score * 100)}%，"
            f"{f'建议准备 {best_food.recipe.prep_minutes} 分钟。' if best_food and best_food.recipe else '适合直接安排。'}"
            f"{f' 另外别忘了优先处理：{alerts[0]}。' if alerts else ''}"
        )
        if best_food
        else "先补齐常用食材后，系统会给出更准确的推荐。",
        created_at=utcnow(),
    )
