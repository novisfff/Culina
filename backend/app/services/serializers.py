from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from app.core.enums import normalize_food_type
from app.models.domain import (
    ActivityLog,
    AIConversation,
    AIRecommendation,
    Family,
    Food,
    FoodPlanItem,
    Ingredient,
    InventoryDeductionSuggestion,
    InventoryItem,
    MealLog,
    MediaAsset,
    Membership,
    Recipe,
    RecipeCookLog,
    RecipeFavorite,
    FoodScene,
    ShoppingListItem,
    User,
)
from app.services.ingredient_units import serialize_unit_conversions


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    return float(value)


def _to_optional_float(value: Decimal | float | int | None) -> float | None:
    if value is None:
        return None
    return float(value)


def _remaining_quantity(quantity: Decimal | float | int | None, consumed_quantity: Decimal | float | int | None) -> float:
    quantity_value = Decimal(str(quantity or 0))
    consumed_value = Decimal(str(consumed_quantity or 0))
    return float(max(quantity_value - consumed_value, Decimal("0")))


def serialize_media(asset: MediaAsset) -> dict:
    return {
        "id": asset.id,
        "name": asset.name,
        "url": asset.url,
        "source": asset.source,
        "alt": asset.alt,
        "generation_mode": asset.generation_mode,
        "reference_media_id": asset.reference_media_id,
        "style_key": asset.style_key,
        "prompt_version": asset.prompt_version,
        "created_at": asset.created_at,
        "created_by": asset.created_by,
    }


def group_media_by_entity(assets: list[MediaAsset]) -> dict[tuple[str, str], list[MediaAsset]]:
    grouped: dict[tuple[str, str], list[MediaAsset]] = defaultdict(list)
    for asset in assets:
        if asset.entity_type and asset.entity_id:
            grouped[(asset.entity_type, asset.entity_id)].append(asset)
    return grouped


def serialize_user(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "email": user.email,
        "phone": user.phone,
        "avatar_seed": user.avatar_seed,
    }


def serialize_membership(membership: Membership) -> dict:
    return {
        "id": membership.id,
        "family_id": membership.family_id,
        "user_id": membership.user_id,
        "role": membership.role,
        "status": membership.status.value if hasattr(membership.status, "value") else membership.status,
    }


def serialize_family(family: Family, recommendations: list[AIRecommendation] | None = None) -> dict:
    return {
        "id": family.id,
        "name": family.name,
        "motto": family.motto,
        "location": family.location,
        "created_at": family.created_at,
        "updated_at": family.updated_at,
        "ai_recommendations": [serialize_ai_recommendation(item) for item in (recommendations or [])],
    }


def serialize_member(user: User, membership: Membership) -> dict:
    return {
        **serialize_user(user),
        "role": membership.role,
        "status": membership.status.value if hasattr(membership.status, "value") else membership.status,
    }


def serialize_ingredient(ingredient: Ingredient, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    media = media_map.get(("ingredient", ingredient.id), [])
    return {
        "id": ingredient.id,
        "family_id": ingredient.family_id,
        "name": ingredient.name,
        "category": ingredient.category,
        "default_unit": ingredient.default_unit,
        "unit_conversions": serialize_unit_conversions(ingredient.default_unit, ingredient.unit_conversions),
        "default_storage": ingredient.default_storage,
        "default_expiry_mode": ingredient.default_expiry_mode,
        "default_expiry_days": ingredient.default_expiry_days,
        "default_low_stock_threshold": _to_optional_float(ingredient.default_low_stock_threshold),
        "notes": ingredient.notes,
        "image": serialize_media(media[0]) if media else None,
        "created_at": ingredient.created_at,
        "updated_at": ingredient.updated_at,
        "created_by": ingredient.created_by,
        "updated_by": ingredient.updated_by,
    }


def serialize_inventory_item(item: InventoryItem) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "ingredient_id": item.ingredient_id,
        "ingredient_name": item.ingredient.name if item.ingredient else "",
        "quantity": _to_float(item.quantity),
        "consumed_quantity": _to_float(item.consumed_quantity),
        "remaining_quantity": _remaining_quantity(item.quantity, item.consumed_quantity),
        "unit": item.unit,
        "entered_quantity": _to_optional_float(item.entered_quantity),
        "entered_unit": item.entered_unit,
        "status": item.status,
        "purchase_date": item.purchase_date,
        "expiry_date": item.expiry_date,
        "storage_location": item.storage_location,
        "notes": item.notes,
        "low_stock_threshold": _to_float(item.low_stock_threshold),
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


def serialize_shopping_item(item: ShoppingListItem) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "title": item.title,
        "quantity": _to_float(item.quantity),
        "unit": item.unit,
        "reason": item.reason,
        "done": item.done,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


def serialize_recipe(recipe: Recipe, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    return {
        "id": recipe.id,
        "family_id": recipe.family_id,
        "title": recipe.title,
        "servings": recipe.servings,
        "prep_minutes": recipe.prep_minutes,
        "difficulty": recipe.difficulty,
        "ingredient_items": [
            {
                "id": item.id,
                "ingredient_id": item.ingredient_id,
                "ingredient_name": item.ingredient_name,
                "quantity": _to_float(item.quantity),
                "unit": item.unit,
                "note": item.note,
            }
            for item in recipe.ingredient_items
        ],
        "steps": [
            {
                "id": step.id,
                "title": step.title or "",
                "text": step.text,
                "icon": step.icon or "pan",
                "summary": step.summary or "",
                "estimated_minutes": step.estimated_minutes,
                "tip": step.tip or "",
                "key_points": step.key_points or [],
            }
            for step in recipe.steps
        ],
        "tips": recipe.tips,
        "images": [serialize_media(asset) for asset in media_map.get(("recipe", recipe.id), [])],
        "cook_logs": [serialize_recipe_cook_log(item) for item in list(recipe.cook_logs)[:5]],
        "created_at": recipe.created_at,
        "updated_at": recipe.updated_at,
        "created_by": recipe.created_by,
        "updated_by": recipe.updated_by,
    }


def serialize_recipe_cook_log(item: RecipeCookLog) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "recipe_id": item.recipe_id,
        "meal_log_id": item.meal_log_id,
        "cook_date": item.cook_date,
        "meal_type": item.meal_type,
        "servings": _to_float(item.servings),
        "result_note": item.result_note,
        "adjustments": item.adjustments,
        "rating": item.rating,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


def serialize_food_scene(item: FoodScene, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    images = media_map.get(("food_scene", item.id), [])
    return {
        "id": item.id,
        "family_id": item.family_id,
        "name": item.name,
        "description": item.description,
        "image_prompt": item.image_prompt,
        "image": serialize_media(images[0]) if images else None,
        "hidden": item.hidden,
        "custom": item.custom,
        "sort_order": item.sort_order,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


def serialize_recipe_favorite(item: RecipeFavorite) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "user_id": item.user_id,
        "recipe_id": item.recipe_id,
        "created_at": item.created_at,
    }


def serialize_food_plan_item(item: FoodPlanItem) -> dict:
    recipe = item.food.recipe if item.food else None
    return {
        "id": item.id,
        "family_id": item.family_id,
        "user_id": item.user_id,
        "food_id": item.food_id,
        "food_name": item.food.name if item.food else "",
        "food_type": item.food.type if item.food else "",
        "recipe_id": recipe.id if recipe else None,
        "recipe_title": recipe.title if recipe else "",
        "plan_date": item.plan_date,
        "meal_type": item.meal_type,
        "note": item.note,
        "status": item.status,
        "completed_at": item.completed_at,
        "meal_log_id": item.meal_log_id,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "created_by": item.created_by,
        "updated_by": item.updated_by,
    }


serialize_recipe_plan_item = serialize_food_plan_item


def serialize_food(food: Food, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    return {
        "id": food.id,
        "family_id": food.family_id,
        "name": food.name,
        "type": normalize_food_type(food.type),
        "category": food.category,
        "flavor_tags": list(food.flavor_tags or []),
        "scene_tags": list(food.scene_tags or []),
        "suitable_meal_types": list(food.suitable_meal_types or []),
        "source_name": food.source_name,
        "purchase_source": food.purchase_source,
        "scene": food.scene,
        "images": [serialize_media(asset) for asset in media_map.get(("food", food.id), [])],
        "notes": food.notes,
        "routine_note": food.routine_note,
        "price": float(food.price) if food.price is not None else None,
        "rating": food.rating,
        "repurchase": food.repurchase,
        "expiry_date": food.expiry_date,
        "stock_quantity": float(food.stock_quantity) if food.stock_quantity is not None else None,
        "stock_unit": food.stock_unit,
        "favorite": food.favorite,
        "recipe_id": food.recipe_id,
        "created_at": food.created_at,
        "updated_at": food.updated_at,
        "created_by": food.created_by,
        "updated_by": food.updated_by,
    }


def serialize_deduction_suggestion(item: InventoryDeductionSuggestion) -> dict:
    return {
        "id": item.id,
        "ingredient_name": item.ingredient_name,
        "suggested_amount": _to_float(item.suggested_amount),
        "unit": item.unit,
        "based_on_food_name": item.based_on_food_name,
    }


def serialize_meal_log(meal_log: MealLog, media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    return {
        "id": meal_log.id,
        "family_id": meal_log.family_id,
        "date": meal_log.date,
        "meal_type": meal_log.meal_type,
        "food_entries": [
            {
                "id": entry.id,
                "food_id": entry.food_id,
                "food_name": entry.food.name if entry.food else "",
                "servings": _to_float(entry.servings),
                "note": entry.note,
            }
            for entry in meal_log.food_entries
        ],
        "participant_user_ids": list(meal_log.participant_user_ids or []),
        "notes": meal_log.notes,
        "mood": meal_log.mood,
        "photos": [serialize_media(asset) for asset in media_map.get(("meal_log", meal_log.id), [])],
        "deduction_suggestions": [serialize_deduction_suggestion(item) for item in meal_log.deduction_suggestions],
        "created_at": meal_log.created_at,
        "updated_at": meal_log.updated_at,
        "created_by": meal_log.created_by,
        "updated_by": meal_log.updated_by,
    }


def serialize_activity(log: ActivityLog, actor_name: str | None = None) -> dict:
    return {
        "id": log.id,
        "family_id": log.family_id,
        "actor_id": log.actor_id,
        "actor_name": actor_name,
        "action": log.action.value if hasattr(log.action, "value") else log.action,
        "entity_type": log.entity_type,
        "entity_id": log.entity_id,
        "summary": log.summary,
        "created_at": log.created_at,
    }


def serialize_ai_conversation(item: AIConversation) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "mode": item.mode,
        "prompt": item.prompt,
        "response": item.response,
        "created_at": item.created_at,
        "created_by": item.created_by,
        "context": item.context,
    }


def serialize_ai_recommendation(item: AIRecommendation) -> dict:
    return {
        "id": item.id,
        "family_id": item.family_id,
        "title": item.title,
        "detail": item.detail,
        "created_at": item.created_at,
    }
