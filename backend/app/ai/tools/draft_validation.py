from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import MealType
from app.models.domain import AITaskDraft, Food, Ingredient, Recipe
from app.schemas.foods import CreateFoodRequest
from app.schemas.recipes import CreateRecipeRequest
from app.schemas.shopping import CreateShoppingListItemRequest


def normalize_shopping_list_draft(db: Session, *, family_id: str, conversation_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("购物清单草稿格式不正确")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("购物清单草稿不能为空")
    source_draft_id = payload.get("sourceDraftId")
    if source_draft_id:
        source_draft_id = str(source_draft_id)
        if not source_draft_id.startswith("in_run:"):
            existing = db.scalar(
                select(AITaskDraft.id).where(
                    AITaskDraft.family_id == family_id,
                    AITaskDraft.conversation_id == conversation_id,
                    AITaskDraft.id == source_draft_id,
                    AITaskDraft.draft_type.in_(["meal_plan", "shopping_list"]),
                )
            )
            if existing is None:
                raise ValueError("购物清单草稿引用了不存在的来源草稿")
    return {
        "draftType": "shopping_list",
        "schemaVersion": payload.get("schemaVersion") or "shopping_list.v1",
        "items": [CreateShoppingListItemRequest.model_validate(item).model_dump(mode="json") for item in items],
        "sourceDraftId": source_draft_id or None,
    }


def normalize_meal_plan_draft(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("餐食计划草稿格式不正确")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("餐食计划草稿不能为空")

    food_ids = _string_ids(item.get("foodId") or item.get("food_id") for item in items if isinstance(item, dict))
    if len(food_ids) != len(items):
        raise ValueError("餐食计划里的每个食物都必须从食物库选择，不能生成库外食物名称")
    foods_by_id = _load_by_id(db, Food, family_id=family_id, ids=food_ids, label="食物")

    recipe_ids = _string_ids(item.get("recipeId") or item.get("recipe_id") for item in items if isinstance(item, dict))
    recipes_by_id = _load_by_id(db, Recipe, family_id=family_id, ids=recipe_ids, label="菜谱")

    normalized_items: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("餐食计划草稿项格式不正确")
        plan_date = date.fromisoformat(str(item.get("date")))
        meal_type = MealType(str(item.get("mealType")))
        food_id = str(item.get("foodId") or item.get("food_id") or "")
        food = foods_by_id[food_id]
        recipe_id = item.get("recipeId") or item.get("recipe_id")
        recipe_id = str(recipe_id) if recipe_id else food.recipe_id
        if recipe_id and recipe_id not in recipes_by_id:
            _load_by_id(db, Recipe, family_id=family_id, ids=[recipe_id], label="菜谱")
        if recipe_id and food.recipe_id != recipe_id:
            raise ValueError("餐食计划草稿中的食物和菜谱关联不一致")
        normalized_items.append(
            {
                "date": plan_date.isoformat(),
                "mealType": meal_type.value,
                "title": food.name,
                "foodId": food.id,
                "recipeId": recipe_id or None,
                "reason": str(item.get("reason") or item.get("note") or ""),
                "usedInventory": _string_list(item.get("usedInventory"), max_items=20),
                "missingIngredients": _string_list(item.get("missingIngredients"), max_items=20),
                "source": item.get("source") if isinstance(item.get("source"), dict) else {},
            }
        )

    return {
        "draftType": "meal_plan",
        "schemaVersion": payload.get("schemaVersion") or "meal_plan.v1",
        "items": normalized_items,
        "source": payload.get("source") if isinstance(payload.get("source"), dict) else {},
    }


def normalize_meal_log_draft(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("餐食记录草稿格式不正确")
    foods = payload.get("foods")
    if not isinstance(foods, list) or not foods:
        raise ValueError("餐食记录草稿不能为空")

    food_ids = _string_ids(item.get("foodId") or item.get("food_id") for item in foods if isinstance(item, dict))
    if len(food_ids) != len(foods):
        raise ValueError("餐食记录里的每个食物都必须从食物库选择，不能生成库外食物名称")
    foods_by_id = _load_by_id(db, Food, family_id=family_id, ids=food_ids, label="食物")

    normalized_foods: list[dict[str, Any]] = []
    for item in foods:
        if not isinstance(item, dict):
            raise ValueError("餐食记录食物项格式不正确")
        food_id = str(item.get("foodId") or item.get("food_id") or "")
        food = foods_by_id[food_id]
        normalized_foods.append(
            {
                "foodId": food.id,
                "name": food.name,
                "servings": max(float(item.get("servings") or 1), 0.1),
                "note": str(item.get("note") or ""),
            }
        )

    return {
        "draftType": "meal_log",
        "schemaVersion": payload.get("schemaVersion") or "meal_log.v1",
        "date": date.fromisoformat(str(payload.get("date"))).isoformat(),
        "mealType": MealType(str(payload.get("mealType"))).value,
        "foods": normalized_foods,
        "notes": str(payload.get("notes") or ""),
    }


def normalize_recipe_draft_for_tools(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    recipe = CreateRecipeRequest.model_validate(payload).model_dump(mode="json")
    ingredient_ids = _string_ids(item.get("ingredient_id") for item in recipe["ingredient_items"])
    ingredients_by_id = _load_by_id(db, Ingredient, family_id=family_id, ids=ingredient_ids, label="食材")
    normalized_items = []
    for item in recipe["ingredient_items"]:
        ingredient_id = item.get("ingredient_id")
        if ingredient_id:
            ingredient = ingredients_by_id[str(ingredient_id)]
            item = {**item, "ingredient_id": ingredient.id, "ingredient_name": ingredient.name}
        normalized_items.append(item)
    return {**recipe, "ingredient_items": normalized_items}


def normalize_food_profile_draft_for_tools(db: Session, *, family_id: str, payload: Any) -> dict[str, Any]:
    food = CreateFoodRequest.model_validate(payload).model_dump(mode="json")
    recipe_id = food.get("recipe_id")
    if recipe_id:
        recipe = _load_by_id(db, Recipe, family_id=family_id, ids=[recipe_id], label="菜谱")[str(recipe_id)]
        food["name"] = recipe.title
    return {"draftType": "food_profile", "schemaVersion": payload.get("schemaVersion") or "food_profile.v1", **food}


def _load_by_id(db: Session, model: Any, *, family_id: str, ids: list[str], label: str) -> dict[str, Any]:
    unique_ids = list(dict.fromkeys(ids))
    if not unique_ids:
        return {}
    rows = list(db.scalars(select(model).where(model.family_id == family_id, model.id.in_(unique_ids))))
    by_id = {row.id: row for row in rows}
    missing = [item for item in unique_ids if item not in by_id]
    if missing:
        raise ValueError(f"草稿包含不属于当前家庭的{label}: {', '.join(missing)}")
    return by_id


def _string_ids(values: Any) -> list[str]:
    return [str(value) for value in values if value]


def _string_list(value: Any, *, max_items: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item)[:80] for item in value[:max_items] if item]
