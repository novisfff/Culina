from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.domain import Food, FoodPlanItem, Ingredient, MealLog, MealLogFood, Recipe, ShoppingListItem
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.serializers import (
    serialize_food,
    serialize_food_plan_item,
    serialize_ingredient,
    serialize_meal_log,
    serialize_recipe,
    serialize_shopping_item,
)


def load_meal_plan_current_value(db: Session, *, family_id: str, target_id: str) -> dict[str, Any] | None:
    item = db.scalar(
        select(FoodPlanItem)
        .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
        .where(FoodPlanItem.family_id == family_id, FoodPlanItem.id == target_id)
    )
    if item is None:
        return {"id": target_id, "label": "当前计划已不存在", "summary": "该计划可能已被删除或移出当前范围", "payload": None}
    payload = serialize_food_plan_item(item)
    return {
        "id": item.id,
        "label": payload.get("food_name") or "当前计划",
        "summary": " · ".join(
            [
                str(payload.get("plan_date") or ""),
                str(payload.get("meal_type") or ""),
                str(payload.get("status") or ""),
            ]
        ).strip(" · "),
        "payload": payload,
    }


def load_shopping_list_current_value(db: Session, *, family_id: str, target_id: str) -> dict[str, Any] | None:
    item = db.scalar(select(ShoppingListItem).where(ShoppingListItem.family_id == family_id, ShoppingListItem.id == target_id))
    if item is None:
        return {"id": target_id, "label": "当前购物项已不存在", "summary": "该购物项可能已被删除", "payload": None}
    payload = serialize_shopping_item(item)
    status = "已完成" if payload.get("done") else "待购买"
    return {
        "id": item.id,
        "label": str(payload.get("title") or "当前购物项"),
        "summary": f"{payload.get('quantity')} {payload.get('unit')} · {status}",
        "payload": payload,
    }


def load_meal_log_current_value(db: Session, *, family_id: str, target_id: str) -> dict[str, Any] | None:
    item = db.scalar(
        select(MealLog)
        .where(MealLog.family_id == family_id, MealLog.id == target_id)
        .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food), selectinload(MealLog.deduction_suggestions))
    )
    if item is None:
        return {"id": target_id, "label": "当前餐食记录已不存在", "summary": "该记录可能已被删除", "payload": None}
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="meal_log", entity_ids=[item.id]))
    payload = serialize_meal_log(item, media_map)
    return {
        "id": item.id,
        "label": "当前餐食记录",
        "summary": " · ".join([str(payload.get("date") or ""), str(payload.get("meal_type") or ""), str(len(payload.get("foods") or [])) + " 项食物"]),
        "payload": payload,
    }


def load_food_profile_current_value(db: Session, *, family_id: str, target_id: str) -> dict[str, Any] | None:
    item = db.scalar(select(Food).where(Food.family_id == family_id, Food.id == target_id))
    if item is None:
        return {"id": target_id, "label": "当前食物资料已不存在", "summary": "该食物可能已被删除", "payload": None}
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="food", entity_ids=[item.id]))
    payload = serialize_food(item, media_map)
    return {
        "id": item.id,
        "label": str(payload.get("name") or "当前食物"),
        "summary": " · ".join([str(payload.get("type") or ""), str(payload.get("category") or "")]).strip(" · "),
        "payload": payload,
    }


def load_ingredient_profile_current_value(db: Session, *, family_id: str, target_id: str) -> dict[str, Any] | None:
    item = db.scalar(select(Ingredient).where(Ingredient.family_id == family_id, Ingredient.id == target_id))
    if item is None:
        return {"id": target_id, "label": "当前食材档案已不存在", "summary": "该食材可能已被删除", "payload": None}
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="ingredient", entity_ids=[item.id]))
    payload = serialize_ingredient(item, media_map)
    return {
        "id": item.id,
        "label": str(payload.get("name") or "当前食材"),
        "summary": " · ".join([str(payload.get("category") or ""), str(payload.get("default_unit") or "")]).strip(" · "),
        "payload": payload,
    }


def load_recipe_current_value(db: Session, *, family_id: str, target_id: str) -> dict[str, Any] | None:
    item = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == family_id, Recipe.id == target_id)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
    )
    if item is None:
        return {"id": target_id, "label": "当前菜谱已不存在", "summary": "该菜谱可能已被删除", "payload": None}
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="recipe", entity_ids=[item.id]))
    payload = serialize_recipe(item, media_map)
    return {
        "id": item.id,
        "label": str(payload.get("title") or "当前菜谱"),
        "summary": " · ".join([f"{payload.get('servings')} 人份", f"{payload.get('prep_minutes')} 分钟"]),
        "payload": payload,
    }
