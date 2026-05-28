from __future__ import annotations

from app.ai.kitchen.formatters import DIFFICULTY_LABELS, build_alerts, inventory_snapshot
from app.core.enums import Difficulty
from app.models.domain import Food, Ingredient, InventoryItem


def build_food_answer(food: Food | None, prompt: str) -> str:
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


def build_inventory_answer(inventory_items: list[InventoryItem]) -> str:
    alerts = build_alerts(inventory_items)
    snapshot = inventory_snapshot(inventory_items)
    if not alerts:
        return f"当前库存状态平稳，主要食材有：{'、'.join(snapshot[:6])}。可以优先安排 1 道自做菜和 1 份轻主食组合。"
    return (
        f"目前最需要关注的是：{'、'.join(alerts)}。"
        f"现有库存里可以优先消耗 {'、'.join(snapshot[:5])}。"
        "如果你愿意，我下一步可以直接给你一顿晚餐搭配建议。"
    )


def build_recipe_draft_payload(ingredients: list[Ingredient], prompt: str) -> dict | None:
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


def format_recipe_draft_response(draft: dict | None, prompt: str) -> str:
    if draft is None:
        return "先选择 2-4 个现有食材，我就能生成更贴近家庭库存的菜谱草稿。"
    names = "、".join(item["ingredient_name"] for item in draft["ingredient_items"])
    return (
        f"菜谱草稿《{draft['title']}》：1. 主料使用 {names}。2. 先处理容易出水的食材，再加入主调味。"
        f"3. 控制总时长在 20 分钟内。{f' 你提到“{prompt}”，我会优先按这个方向调整口味。' if prompt else ''}"
    )
