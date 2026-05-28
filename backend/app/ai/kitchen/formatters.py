from __future__ import annotations

from collections.abc import Iterable
from datetime import date as date_type
from decimal import Decimal

from app.core.enums import Difficulty, FoodType, MealType, normalize_food_type
from app.models.domain import Food, Ingredient, InventoryItem, MealLog, Recipe
from app.services.clock import today_for_family
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


def remaining_quantity_in_default(item: InventoryItem) -> Decimal:
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


def inventory_snapshot(inventory_items: Iterable[InventoryItem]) -> list[str]:
    snapshot: list[str] = []
    for item in inventory_items:
        if item.ingredient:
            display_quantity = remaining_quantity_in_default(item)
            snapshot.append(f"{item.ingredient.name}{float(display_quantity):g}{item.ingredient.default_unit}")
    return snapshot


def build_alerts(inventory_items: Iterable[InventoryItem]) -> list[str]:
    return build_alerts_for_date(inventory_items, today_for_family())


def build_alerts_for_date(inventory_items: Iterable[InventoryItem], today: date_type) -> list[str]:
    alerts: list[str] = []
    inventory_list = list(inventory_items)
    ingredients_by_id: dict[str, Ingredient] = {}

    for item in inventory_list:
        if item.ingredient:
            ingredients_by_id[item.ingredient.id] = item.ingredient

    for ingredient in ingredients_by_id.values():
        if ingredient.default_low_stock_threshold is None:
            continue
        available_quantity = sum(
            float(remaining_quantity_in_default(item))
            for item in inventory_list
            if item.ingredient_id == ingredient.id
            and (item.expiry_date is None or item.expiry_date >= today)
            and remaining_quantity_in_default(item) > 0
        )
        if available_quantity <= float(ingredient.default_low_stock_threshold):
            alerts.append(f"{ingredient.name} 库存偏低")

    for item in inventory_list:
        if item.ingredient and item.expiry_date:
            delta = (item.expiry_date - today).days
            if delta <= 2:
                alerts.append(f"{item.ingredient.name} {'已过期' if delta < 0 else '即将到期'}")
    return alerts


def recent_meal_snapshot(meal_logs: list[MealLog]) -> list[str]:
    lines: list[str] = []
    for meal in meal_logs[:5]:
        foods = "、".join(entry.food.name if entry.food else "未命名食物" for entry in meal.food_entries)
        meal_label = MEAL_TYPE_LABELS.get(meal.meal_type, meal.meal_type.value)
        lines.append(f"{meal.date.isoformat()} {meal_label}: {foods or '未记录菜品'}")
    return lines


def food_context(food: Food | None) -> str:
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


def ingredient_context(ingredients: list[Ingredient]) -> str:
    if not ingredients:
        return "未选择食材。"
    return "\n".join(
        f"- {item.name}（分类：{item.category}，常用单位：{item.default_unit}，存放：{item.default_storage}）"
        for item in ingredients
    )


def recommendation_context(
    foods: list[Food],
    inventory_items: list[InventoryItem],
    meal_logs: list[MealLog],
) -> str:
    from app.ai.kitchen.recommendations import rank_recommendation_candidates

    today = today_for_family()
    candidates = rank_recommendation_candidates(foods, inventory_items, meal_logs, today=today)
    if not candidates:
        return "- 当前没有可推荐的自做菜候选。"
    return "\n".join(
        (
            f"- {food.name}：库存匹配度 {round(score * 100)}%，"
            f"{f'准备约 {food.recipe.prep_minutes} 分钟，' if food.recipe else ''}"
            f"{'今天尚未吃过' if all(entry.food_id != food.id for meal in meal_logs if meal.date == today for entry in meal.food_entries) else '今天已吃过'}"
        )
        for food, score in candidates[:3]
    )


def recipe_availability_score(recipe: Recipe | None, inventory_items: list[InventoryItem]) -> float:
    if recipe is None or not recipe.ingredient_items:
        return 0.0
    ingredient_ids = [item.ingredient_id for item in recipe.ingredient_items if item.ingredient_id]
    if not ingredient_ids:
        return 0.0
    matched = sum(1 for ingredient_id in ingredient_ids if any(inv.ingredient_id == ingredient_id for inv in inventory_items))
    return matched / len(ingredient_ids)
