from __future__ import annotations


def render_plan_preview(plan: list[dict]) -> str:
    """Render meal-plan items as a compact line-oriented preview."""
    lines = []
    for item in plan:
        plan_date = item.get("date", "")
        meal_type = item.get("mealType", "")
        title = item.get("title", "未命名餐食")
        lines.append(f"{plan_date} {meal_type}: {title}")
    return "\n".join(lines)
