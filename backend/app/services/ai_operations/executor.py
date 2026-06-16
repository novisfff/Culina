from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.ai_operations.composite import execute_composite_operation_plan
from app.services.ai_operations.foods import execute_food_profile_draft
from app.services.ai_operations.ingredients import execute_ingredient_profile_draft
from app.services.ai_operations.inventory import execute_inventory_operation_draft
from app.services.ai_operations.meal_logs import execute_meal_log_draft
from app.services.ai_operations.meal_plans import execute_meal_plan_draft
from app.services.ai_operations.recipe_cook import execute_recipe_cook_draft
from app.services.ai_operations.recipes import execute_recipe_draft
from app.services.ai_operations.shopping import execute_shopping_list_draft
from app.services.serializers import serialize_food, serialize_ingredient, serialize_recipe


AssertUpdatedAt = Callable[..., None]


def execute_ai_operation_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    draft_type: str,
    payload: dict[str, Any],
    assert_updated_at_matches: AssertUpdatedAt,
) -> tuple[dict[str, Any], list[str]]:
    if draft_type == "recipe":
        if payload.get("action") == "delete":
            recipe_id = str(payload.get("targetId"))
            title = str(((payload.get("before") or {}) if isinstance(payload.get("before"), dict) else {}).get("title") or "")
            execute_recipe_draft(
                db,
                family_id=family_id,
                user_id=user_id,
                payload=payload,
                assert_updated_at_matches=assert_updated_at_matches,
            )
            return {"id": recipe_id, "title": title, "deleted": True}, [recipe_id]
        recipe = execute_recipe_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="recipe", entity_ids=[recipe.id]))
        return serialize_recipe(recipe, media_map), [recipe.id]
    if draft_type == "recipe_cook":
        return execute_recipe_cook_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
        )
    if draft_type == "shopping_list":
        return execute_shopping_list_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
    if draft_type == "meal_plan":
        return execute_meal_plan_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
    if draft_type == "meal_log":
        return execute_meal_log_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
    if draft_type == "food_profile":
        food = execute_food_profile_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="food", entity_ids=[food.id]))
        return serialize_food(food, media_map), [food.id]
    if draft_type == "ingredient_profile":
        ingredient = execute_ingredient_profile_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            assert_updated_at_matches=assert_updated_at_matches,
        )
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="ingredient", entity_ids=[ingredient.id]))
        return serialize_ingredient(ingredient, media_map), [ingredient.id]
    if draft_type == "inventory_operation":
        return execute_inventory_operation_draft(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
        )
    if draft_type == "composite_operation":
        def execute_step(step_draft_type: str, step_payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
            return execute_ai_operation_draft(
                db,
                family_id=family_id,
                user_id=user_id,
                draft_type=step_draft_type,
                payload=step_payload,
                assert_updated_at_matches=assert_updated_at_matches,
            )

        result = execute_composite_operation_plan(
            db,
            family_id=family_id,
            user_id=user_id,
            payload=payload,
            execute_operation=execute_step,
        )
        entity_ids = [
            str(entity_id)
            for step in result.get("steps") or []
            if isinstance(step, dict)
            for entity_id in (step.get("entityIds") or [])
            if str(entity_id)
        ]
        return result, list(dict.fromkeys(entity_ids))
    raise ValueError("暂不支持的草稿类型")
