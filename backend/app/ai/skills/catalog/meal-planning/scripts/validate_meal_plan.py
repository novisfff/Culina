from __future__ import annotations

from datetime import date


VALID_MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}


def validate_meal_plan(plan: list[dict]) -> dict:
    """Validate required fields and meal types before creating a meal-plan draft."""
    errors: list[dict] = []
    warnings: list[dict] = []
    seen_slots: set[tuple[str, str]] = set()
    seen_foods: dict[str, int] = {}
    for index, item in enumerate(plan):
        for field in ["date", "mealType", "title", "foodId"]:
            if not item.get(field):
                errors.append({"index": index, "field": field, "message": f"缺少必填字段: {field}"})
        plan_date = str(item.get("date") or "").strip()
        if plan_date:
            try:
                date.fromisoformat(plan_date)
            except ValueError:
                errors.append({"index": index, "field": "date", "message": "date 必须是 YYYY-MM-DD"})
        meal_type = item.get("mealType")
        if meal_type and meal_type not in VALID_MEAL_TYPES:
            errors.append({"index": index, "field": "mealType", "message": f"mealType 不合法: {meal_type}"})
        if plan_date and meal_type:
            slot_key = (plan_date, str(meal_type))
            if slot_key in seen_slots:
                errors.append({"index": index, "field": "mealType", "message": "同一天同餐别存在重复计划"})
            seen_slots.add(slot_key)
        food_id = str(item.get("foodId") or "").strip()
        if food_id:
            seen_foods[food_id] = seen_foods.get(food_id, 0) + 1
    repeated_foods = sorted(food_id for food_id, count in seen_foods.items() if count >= 3)
    for food_id in repeated_foods:
        warnings.append({"field": "foodId", "message": f"食物 {food_id} 在计划中重复出现较多，建议检查是否需要换菜"})
    return {"valid": not errors, "errors": errors, "warnings": warnings}
