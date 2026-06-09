from __future__ import annotations


def render_plan_preview(plan: list[dict]) -> str:
    lines = []
    for item in plan:
        date = item.get("date", "")
        meal_type = item.get("mealType", "")
        title = item.get("title", "未命名餐食")
        lines.append(f"{date} {meal_type}: {title}")
    return "\n".join(lines)
