from __future__ import annotations

from app.ai.kitchen.formatters import (
    build_alerts,
    food_context,
    ingredient_context,
    inventory_snapshot,
    recent_meal_snapshot,
    recommendation_context,
)
from app.core.enums import AiMode
from app.models.domain import AIRecommendation, Family, Food, Ingredient, InventoryItem, MealLog


def default_prompt(mode: AiMode) -> str:
    prompts = {
        AiMode.FOOD_QA: "请结合这道菜和家庭厨房现状给出建议。",
        AiMode.INVENTORY_QA: "请总结当前库存情况和需要优先处理的风险。",
        AiMode.RECOMMENDATION: "请推荐今晚适合这家人安排的一餐。",
        AiMode.RECIPE_DRAFT: "请基于这些食材生成一个可执行的菜谱草稿。",
    }
    return prompts.get(mode, mode.value)


def build_mode_instruction(mode: AiMode, recommendation: AIRecommendation | None) -> str:
    if mode == AiMode.FOOD_QA:
        return "你正在回答单菜问答。只能依据给定菜品、菜谱和家庭上下文回答；如果信息不足，要明确指出缺口。回答使用简体中文，2-4 句，不使用 Markdown。"
    if mode == AiMode.INVENTORY_QA:
        return "你正在回答家庭库存问答。只能依据给定库存和提醒回答，不能虚构不存在的食材。回答使用简体中文，2-4 句，不使用 Markdown。"
    if mode == AiMode.RECOMMENDATION:
        title = recommendation.title if recommendation else "今晚推荐"
        return f"你正在生成今日吃什么推荐。标题已经固定为“{title}”，不要重复输出标题，只输出推荐理由和执行建议正文，必须优先基于现有库存和最近用餐情况，使用简体中文，2-4 句，不使用 Markdown。"
    if mode == AiMode.RECIPE_DRAFT:
        return "你正在生成菜谱草稿。只能使用给定食材，给出家庭可执行的做法方向和口味建议，使用简体中文，3-4 句，不使用 Markdown。"
    return "请只依据给定上下文回答，使用简体中文，不使用 Markdown。"


def build_provider_messages(
    *,
    family: Family | None,
    mode: AiMode,
    prompt: str,
    inventory_items: list[InventoryItem],
    meal_logs: list[MealLog],
    food: Food | None = None,
    ingredients: list[Ingredient] | None = None,
    recommendation: AIRecommendation | None = None,
    recommendation_foods: list[Food] | None = None,
) -> list[dict[str, str]]:
    family_name = family.name if family else "当前家庭"
    snapshot = inventory_snapshot(inventory_items)
    alerts = build_alerts(inventory_items)
    recent_meals = recent_meal_snapshot(meal_logs)

    sections = [
        f"家庭名称：{family_name}",
        f"家庭位置：{family.location if family and family.location else '未填写'}",
        f"家庭口号：{family.motto if family and family.motto else '未填写'}",
        "当前库存：\n" + ("\n".join(f"- {item}" for item in snapshot[:10]) if snapshot else "- 暂无库存记录"),
        "库存提醒：\n" + ("\n".join(f"- {item}" for item in alerts[:8]) if alerts else "- 暂无明显风险"),
        "最近餐食：\n" + ("\n".join(f"- {item}" for item in recent_meals) if recent_meals else "- 暂无历史记录"),
    ]

    if food is not None or mode == AiMode.FOOD_QA:
        sections.append("当前菜品上下文：\n" + food_context(food))
    if ingredients:
        sections.append("选中食材：\n" + ingredient_context(ingredients))
    if recommendation_foods is not None or mode == AiMode.RECOMMENDATION:
        sections.append(
            "推荐候选：\n"
            + recommendation_context(recommendation_foods or [], inventory_items, meal_logs)
        )

    sections.append(f"用户问题：{prompt or default_prompt(mode)}")

    return [
        {
            "role": "system",
            "content": (
                "你是 Culina 的家庭厨房 AI 助手。"
                "你只能依据提供给你的家庭上下文回答，不能假设数据库中不存在的库存、菜品、成员或历史。"
                f"{build_mode_instruction(mode, recommendation)}"
            ),
        },
        {
            "role": "user",
            "content": "\n\n".join(sections),
        },
    ]
