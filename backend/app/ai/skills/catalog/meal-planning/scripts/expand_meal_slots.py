from __future__ import annotations

from datetime import date, timedelta


VALID_MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}


def expand_meal_slots(start_date: str, days: int, meal_types: list[str]) -> dict:
    """Expand a date range and meal types into deterministic meal-plan slots."""
    errors: list[dict] = []
    try:
        start = date.fromisoformat(start_date)
    except ValueError:
        return {"valid": False, "slots": [], "errors": [{"field": "start_date", "message": "日期格式必须是 YYYY-MM-DD"}]}

    if days < 1 or days > 14:
        errors.append({"field": "days", "message": "天数必须在 1 到 14 之间"})
    normalized_meal_types = [str(meal_type).strip() for meal_type in meal_types if str(meal_type).strip()]
    if not normalized_meal_types:
        errors.append({"field": "meal_types", "message": "至少需要一个餐别"})
    invalid_meal_types = [meal_type for meal_type in normalized_meal_types if meal_type not in VALID_MEAL_TYPES]
    for meal_type in invalid_meal_types:
        errors.append({"field": "meal_types", "message": f"mealType 不合法: {meal_type}"})
    if errors:
        return {"valid": False, "slots": [], "errors": errors}

    slots = []
    for day_offset in range(days):
        plan_date = start + timedelta(days=day_offset)
        for meal_type in normalized_meal_types:
            slots.append({"date": plan_date.isoformat(), "mealType": meal_type})
    return {"valid": True, "slots": slots, "errors": []}
