from __future__ import annotations

VALID_MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}


def validate_meal_plan(plan: list[dict]) -> dict:
    errors: list[dict] = []
    for index, item in enumerate(plan):
        for field in ["date", "mealType", "title", "foodId"]:
            if not item.get(field):
                errors.append({"index": index, "field": field, "message": f"缺少必填字段: {field}"})
        meal_type = item.get("mealType")
        if meal_type and meal_type not in VALID_MEAL_TYPES:
            errors.append({"index": index, "field": "mealType", "message": f"mealType 不合法: {meal_type}"})
    return {"valid": not errors, "errors": errors}
