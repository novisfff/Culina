from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.config import get_settings
from app.core.enums import AiMode, Difficulty, FoodType, MealType, normalize_food_type
from app.core.utils import create_id, utcnow
from app.models.domain import (
    AIConversation,
    AIRecommendation,
    Family,
    Food,
    Ingredient,
    InventoryItem,
    MealLog,
    MealLogFood,
    Recipe,
)
from app.services.serializers import serialize_ai_conversation, serialize_ai_recommendation
from app.services.ingredient_units import UnitConversionError, convert_quantity_to_default_unit

MEAL_TYPE_LABELS = {
    MealType.BREAKFAST: "早餐",
    MealType.LUNCH: "午餐",
    MealType.DINNER: "晚餐",
    MealType.SNACK: "加餐/夜宵",
}

FOOD_TYPE_LABELS = {
    FoodType.SELF_MADE.value: "家常菜",
    FoodType.TAKEOUT.value: "外卖",
    FoodType.DINING_OUT.value: "外出就餐",
    FoodType.READY_MADE.value: "成品",
    FoodType.INSTANT.value: "速食",
    FoodType.PACKAGED.value: "成品食品",
}

DIFFICULTY_LABELS = {
    Difficulty.EASY: "简单",
    Difficulty.MEDIUM: "中等",
    Difficulty.HARD: "偏难",
}


def _remaining_quantity_in_default(item: InventoryItem) -> Decimal:
    remaining_quantity = max(item.quantity - item.consumed_quantity, Decimal("0"))
    ingredient = item.ingredient
    if ingredient is None or item.unit == ingredient.default_unit:
        return remaining_quantity
    try:
        return convert_quantity_to_default_unit(
            remaining_quantity,
            ingredient.default_unit,
            ingredient.unit_conversions,
            item.unit,
        )
    except UnitConversionError:
        return remaining_quantity


def _inventory_snapshot(inventory_items: Iterable[InventoryItem]) -> list[str]:
    snapshot: list[str] = []
    for item in inventory_items:
        if item.ingredient:
            display_quantity = _remaining_quantity_in_default(item)
            snapshot.append(f"{item.ingredient.name}{float(display_quantity):g}{item.ingredient.default_unit}")
    return snapshot


def _build_alerts(inventory_items: Iterable[InventoryItem]) -> list[str]:
    alerts: list[str] = []
    inventory_list = list(inventory_items)
    today = utcnow().date()
    ingredients_by_id: dict[str, Ingredient] = {}

    for item in inventory_list:
        if item.ingredient:
            ingredients_by_id[item.ingredient.id] = item.ingredient

    for ingredient in ingredients_by_id.values():
        if ingredient.default_low_stock_threshold is None:
            continue
        available_quantity = sum(
            float(_remaining_quantity_in_default(item))
            for item in inventory_list
            if item.ingredient_id == ingredient.id
            and (item.expiry_date is None or item.expiry_date >= today)
            and _remaining_quantity_in_default(item) > 0
        )
        if available_quantity <= float(ingredient.default_low_stock_threshold):
            alerts.append(f"{ingredient.name} 库存偏低")

    for item in inventory_list:
        if item.ingredient and item.expiry_date:
            delta = (item.expiry_date - today).days
            if delta <= 2:
                alerts.append(f"{item.ingredient.name} {'已过期' if delta < 0 else '即将到期'}")
    return alerts


def _availability_score(recipe: Recipe | None, inventory_items: list[InventoryItem]) -> float:
    if recipe is None or not recipe.ingredient_items:
        return 0.0
    ingredient_ids = [item.ingredient_id for item in recipe.ingredient_items if item.ingredient_id]
    if not ingredient_ids:
        return 0.0
    matched = sum(1 for ingredient_id in ingredient_ids if any(inv.ingredient_id == ingredient_id for inv in inventory_items))
    return matched / len(ingredient_ids)


def _rank_recommendation_candidates(
    foods: list[Food],
    inventory_items: list[InventoryItem],
    meal_logs: list[MealLog],
) -> list[tuple[Food, float]]:
    eaten_food_ids = {
        entry.food_id
        for meal in meal_logs
        if meal.date == utcnow().date()
        for entry in meal.food_entries
    }
    candidates = [
        (food, _availability_score(food.recipe, inventory_items))
        for food in foods
        if food.id not in eaten_food_ids
    ]
    candidates.sort(key=lambda item: item[1], reverse=True)
    return candidates


def _pick_recommendation(
    family_id: str,
    foods: list[Food],
    inventory_items: list[InventoryItem],
    meal_logs: list[MealLog],
) -> AIRecommendation:
    candidates = _rank_recommendation_candidates(foods, inventory_items, meal_logs)
    best_food, score = candidates[0] if candidates else (foods[0] if foods else None, 0.0)
    alerts = _build_alerts(inventory_items)

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


def _build_recent_meal_snapshot(meal_logs: list[MealLog]) -> list[str]:
    lines: list[str] = []
    for meal in meal_logs[:5]:
        foods = "、".join(entry.food.name if entry.food else "未命名食物" for entry in meal.food_entries)
        meal_label = MEAL_TYPE_LABELS.get(meal.meal_type, meal.meal_type.value)
        lines.append(f"{meal.date.isoformat()} {meal_label}: {foods or '未记录菜品'}")
    return lines


def _build_food_context(food: Food | None) -> str:
    if food is None:
        return "未找到指定菜品。"

    segments = [
        f"菜名：{food.name}",
        f"类型：{FOOD_TYPE_LABELS.get(normalize_food_type(food.type), food.type)}",
        f"分类：{food.category}",
        f"场景：{'、'.join(food.scene_tags or []) or food.scene or '未填写'}",
        f"备注：{food.notes or '未填写'}",
    ]

    if food.recipe:
        ingredients_text = "、".join(
            f"{item.ingredient_name}{float(item.quantity):g}{item.unit}"
            for item in food.recipe.ingredient_items
        )
        segments.extend(
            [
                f"菜谱难度：{DIFFICULTY_LABELS.get(food.recipe.difficulty, food.recipe.difficulty.value)}",
                f"准备时长：{food.recipe.prep_minutes} 分钟",
                f"原料：{ingredients_text or '未填写'}",
                f"技巧：{food.recipe.tips or '未填写'}",
            ]
        )

    return "\n".join(f"- {segment}" for segment in segments)


def _build_ingredient_context(ingredients: list[Ingredient]) -> str:
    if not ingredients:
        return "未选择食材。"
    return "\n".join(
        f"- {item.name}（分类：{item.category}，常用单位：{item.default_unit}，存放：{item.default_storage}）"
        for item in ingredients
    )


def _build_recommendation_context(
    foods: list[Food],
    inventory_items: list[InventoryItem],
    meal_logs: list[MealLog],
) -> str:
    candidates = _rank_recommendation_candidates(foods, inventory_items, meal_logs)
    if not candidates:
        return "- 当前没有可推荐的自做菜候选。"
    return "\n".join(
        (
            f"- {food.name}：库存匹配度 {round(score * 100)}%，"
            f"{f'准备约 {food.recipe.prep_minutes} 分钟，' if food.recipe else ''}"
            f"{'今天尚未吃过' if all(entry.food_id != food.id for meal in meal_logs if meal.date == utcnow().date() for entry in meal.food_entries) else '今天已吃过'}"
        )
        for food, score in candidates[:3]
    )


def _build_food_answer(food: Food | None, prompt: str) -> str:
    if not food:
        return "我还没有找到这道菜的上下文，可以先在食物或菜谱里完善信息后再问我。"
    recipe = food.recipe
    if recipe is None:
        return f"{food.name} 当前还没有绑定完整菜谱，建议补充来源、口味和备注。"
    lighter_tip = (
        "如果要更清淡，可以把油量减到平时的 70%，并增加蒸/焯步骤。"
        if "清淡" in prompt
        else "可以优先保留这道菜的核心步骤，再根据家庭口味调整调味。"
    )
    ingredients_text = "、".join(
        f"{item.ingredient_name}{float(item.quantity):g}{item.unit}" for item in recipe.ingredient_items
    )
    scenes = "、".join(food.scene_tags or []) or food.scene or "家庭日常"
    return (
        f"{food.name} 适合 {scenes} 场景，当前难度是 {DIFFICULTY_LABELS.get(recipe.difficulty, recipe.difficulty.value)}，准备约 {recipe.prep_minutes} 分钟。"
        f"{lighter_tip} 现有原料包括 {ingredients_text}。"
    )


def _build_inventory_answer(inventory_items: list[InventoryItem]) -> str:
    alerts = _build_alerts(inventory_items)
    snapshot = _inventory_snapshot(inventory_items)
    if not alerts:
        return f"当前库存状态平稳，主要食材有：{'、'.join(snapshot[:6])}。可以优先安排 1 道自做菜和 1 份轻主食组合。"
    return (
        f"目前最需要关注的是：{'、'.join(alerts)}。"
        f"现有库存里可以优先消耗 {'、'.join(snapshot[:5])}。"
        "如果你愿意，我下一步可以直接给你一顿晚餐搭配建议。"
    )


def _build_recipe_draft_payload(ingredients: list[Ingredient], prompt: str) -> dict | None:
    if not ingredients:
        return None
    title = f"{ingredients[0].name}{f'搭配{ingredients[1].name}' if len(ingredients) > 1 else ''}快手家常菜"
    names = "、".join(item.name for item in ingredients)
    direction = prompt.strip()
    tips = f"控制总时长在 20 分钟内，少油少盐，适合家庭日常。{f' 口味方向：{direction}。' if direction else ''}"
    return {
        "title": title,
        "servings": 2,
        "prep_minutes": 20,
        "difficulty": Difficulty.EASY.value,
        "ingredient_items": [
            {
                "ingredient_id": item.id,
                "ingredient_name": item.name,
                "quantity": 1,
                "unit": item.default_unit,
                "note": "按家庭口味处理",
            }
            for item in ingredients[:4]
        ],
        "steps": [
            f"处理 {names}，需要切块的先切块，容易出水的食材单独放。",
            "热锅少油，先下不易熟的食材翻炒，再加入容易熟或出水的食材。",
            "按口味调味，收汁后出锅，保持整体清爽。",
        ],
        "tips": tips,
        "scene_tags": ["快手菜", "家常菜"],
    }


def _format_recipe_draft_response(draft: dict | None, prompt: str) -> str:
    if draft is None:
        return "先选择 2-4 个现有食材，我就能生成更贴近家庭库存的菜谱草稿。"
    names = "、".join(item["ingredient_name"] for item in draft["ingredient_items"])
    return (
        f"菜谱草稿《{draft['title']}》：1. 主料使用 {names}。2. 先处理容易出水的食材，再加入主调味。"
        f"3. 控制总时长在 20 分钟内。{f' 你提到“{prompt}”，我会优先按这个方向调整口味。' if prompt else ''}"
    )


def _default_prompt(mode: AiMode) -> str:
    prompts = {
        AiMode.FOOD_QA: "请结合这道菜和家庭厨房现状给出建议。",
        AiMode.INVENTORY_QA: "请总结当前库存情况和需要优先处理的风险。",
        AiMode.RECOMMENDATION: "请推荐今晚适合这家人安排的一餐。",
        AiMode.RECIPE_DRAFT: "请基于这些食材生成一个可执行的菜谱草稿。",
    }
    return prompts.get(mode, mode.value)


def _build_mode_instruction(mode: AiMode, recommendation: AIRecommendation | None) -> str:
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


def _build_provider_messages(
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
    inventory_snapshot = _inventory_snapshot(inventory_items)
    alerts = _build_alerts(inventory_items)
    recent_meals = _build_recent_meal_snapshot(meal_logs)

    sections = [
        f"家庭名称：{family_name}",
        f"家庭位置：{family.location if family and family.location else '未填写'}",
        f"家庭口号：{family.motto if family and family.motto else '未填写'}",
        "当前库存：\n" + ("\n".join(f"- {item}" for item in inventory_snapshot[:10]) if inventory_snapshot else "- 暂无库存记录"),
        "库存提醒：\n" + ("\n".join(f"- {item}" for item in alerts[:8]) if alerts else "- 暂无明显风险"),
        "最近餐食：\n" + ("\n".join(f"- {item}" for item in recent_meals) if recent_meals else "- 暂无历史记录"),
    ]

    if food is not None or mode == AiMode.FOOD_QA:
        sections.append("当前菜品上下文：\n" + _build_food_context(food))
    if ingredients:
        sections.append("选中食材：\n" + _build_ingredient_context(ingredients))
    if recommendation_foods is not None or mode == AiMode.RECOMMENDATION:
        sections.append(
            "推荐候选：\n"
            + _build_recommendation_context(recommendation_foods or [], inventory_items, meal_logs)
        )

    sections.append(f"用户问题：{prompt or _default_prompt(mode)}")

    return [
        {
            "role": "system",
            "content": (
                "你是 Culina 的家庭厨房 AI 助手。"
                "你只能依据提供给你的家庭上下文回答，不能假设数据库中不存在的库存、菜品、成员或历史。"
                f"{_build_mode_instruction(mode, recommendation)}"
            ),
        },
        {
            "role": "user",
            "content": "\n\n".join(sections),
        },
    ]


def _call_real_provider(messages: list[dict[str, str]]) -> str | None:
    settings = get_settings()
    if not (settings.ai_provider and settings.ai_provider != "disabled" and settings.ai_api_base and settings.ai_api_key):
        return None

    payload = {
        "model": settings.ai_model or "gpt-4o-mini",
        "messages": messages,
        "temperature": 0.5,
    }
    headers = {"Authorization": f"Bearer {settings.ai_api_key}"}
    try:
        with httpx.Client(timeout=settings.ai_timeout_seconds) as client:
            response = client.post(f"{settings.ai_api_base.rstrip('/')}/chat/completions", json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"]
            if isinstance(content, list):
                content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
            if not isinstance(content, str):
                return None
            return content.strip() or None
    except Exception:
        return None


def run_ai_query(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    mode: AiMode,
    prompt: str,
    food_id: str | None = None,
    ingredient_ids: list[str] | None = None,
) -> tuple[dict, dict | None]:
    from app.ai.runner import CulinaAgentService
    from app.ai.schemas import AgentRunRequest

    result = CulinaAgentService(db).run(
        AgentRunRequest(
            family_id=family_id,
            user_id=user_id,
            feature_key=mode.value,
            prompt=prompt,
            mode=mode,
            subject={"foodId": food_id, "ingredientIds": ingredient_ids or []},
            persist_conversation=True,
        )
    )
    if result.conversation is None:
        raise RuntimeError("AI query did not produce a conversation")
    return result.conversation, result.recommendation
