from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.exc import StaleDataError

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction, MealType
from app.core.utils import create_id, utcnow
from app.models.domain import FoodPlanItem, MealLog, MealLogFood, Recipe, RecipeCookLog
from app.schemas.recipes import CookRecipeRequest
from app.services.activity import log_activity
from app.services.ai_operations.common import assert_updated_at_matches
from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
from app.services.inventory_operation_locking import (
    InventoryTargetNotFoundError,
    LockedInventoryTargets,
    lock_inventory_targets,
)
from app.services.inventory_versions import InventoryConflictError, bump_ingredient_collection, require_expected_version
from app.services.inventory_usage import build_cook_inventory_plan, serialize_cook_preview_item, tracks_quantity
from app.services.recipe_food_sync import ensure_food_for_recipe
from app.services.serializers import serialize_recipe_cook_log
from app.services.clock import today_for_family


MISSING_RECIPE_COOK_BOUNDARY_DETAIL = "做菜草稿缺少库存并发校验信息，请重新生成后确认"


def _boundary_row_version(record: dict[str, Any], key: str) -> int:
    if key not in record or isinstance(record.get(key), bool):
        raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
    try:
        version = int(record[key])
    except (TypeError, ValueError) as exc:
        raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL) from exc
    if version < 1:
        raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
    return version


def _lock_and_validate_recipe_cook_boundaries(
    db: Session,
    *,
    family_id: str,
    payload: dict[str, Any],
) -> LockedInventoryTargets:
    if "inventoryBoundaries" not in payload or not isinstance(payload["inventoryBoundaries"], list):
        raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
    boundaries = payload["inventoryBoundaries"]
    ingredient_ids: list[str] = []
    state_ingredient_ids: list[str] = []
    inventory_item_ids: list[str] = []
    seen_ingredient_ids: set[str] = set()
    for boundary in boundaries:
        if not isinstance(boundary, dict):
            raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
        ingredient_id = str(boundary.get("ingredientId") or "")
        if not ingredient_id or ingredient_id in seen_ingredient_ids:
            raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
        seen_ingredient_ids.add(ingredient_id)
        ingredient_ids.append(ingredient_id)
        _boundary_row_version(boundary, "expectedIngredientRowVersion")
        state_id = boundary.get("stateId")
        expected_state_version = boundary.get("expectedStateRowVersion")
        if state_id is not None:
            if not str(state_id) or expected_state_version is None:
                raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
            _boundary_row_version(boundary, "expectedStateRowVersion")
            state_ingredient_ids.append(ingredient_id)
        elif expected_state_version is not None:
            raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
        batches = boundary.get("batches")
        if not isinstance(batches, list):
            raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
        seen_batch_ids: set[str] = set()
        for batch in batches:
            if not isinstance(batch, dict):
                raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
            item_id = str(batch.get("inventoryItemId") or "")
            if not item_id or item_id in seen_batch_ids:
                raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)
            seen_batch_ids.add(item_id)
            _boundary_row_version(batch, "expectedRowVersion")
            inventory_item_ids.append(item_id)

    try:
        locked = lock_inventory_targets(
            db,
            family_id=family_id,
            ingredient_ids=ingredient_ids,
            state_ingredient_ids=state_ingredient_ids,
            inventory_item_ids=inventory_item_ids,
        )
    except InventoryTargetNotFoundError as exc:
        raise AIConflictError(STALE_INVENTORY_DETAIL) from exc

    for boundary in boundaries:
        ingredient_id = str(boundary["ingredientId"])
        ingredient = locked.ingredients.get(ingredient_id)
        if ingredient is None:
            raise AIConflictError(STALE_INVENTORY_DETAIL)
        require_expected_version(
            ingredient,
            _boundary_row_version(boundary, "expectedIngredientRowVersion"),
            entity_type="ingredient",
            entity_id=ingredient.id,
        )
        expected_tracking_mode = str(boundary.get("quantityTrackingMode") or "")
        actual_tracking_mode = "track_quantity" if tracks_quantity(ingredient) else "not_track_quantity"
        if expected_tracking_mode != actual_tracking_mode:
            raise AIConflictError("食材数量记录方式已变化，请重新生成做菜草稿")

        state_id = boundary.get("stateId")
        state = locked.states_by_ingredient_id.get(ingredient.id)
        if expected_tracking_mode == "not_track_quantity":
            if state_id is None or state is None or state.id != str(state_id):
                raise AIConflictError(STALE_INVENTORY_DETAIL)
            require_expected_version(
                state,
                _boundary_row_version(boundary, "expectedStateRowVersion"),
                entity_type="ingredient_inventory_state",
                entity_id=state.id,
            )
        elif state_id is not None or boundary.get("expectedStateRowVersion") is not None:
            raise AIConflictError(MISSING_RECIPE_COOK_BOUNDARY_DETAIL)

        for batch in boundary["batches"]:
            item_id = str(batch["inventoryItemId"])
            item = locked.inventory_items.get(item_id)
            if item is None or item.ingredient_id != ingredient.id:
                raise AIConflictError(STALE_INVENTORY_DETAIL)
            require_expected_version(
                item,
                _boundary_row_version(batch, "expectedRowVersion"),
                entity_type="inventory_item",
                entity_id=item.id,
            )

    return locked


def execute_recipe_cook_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == family_id, Recipe.id == str(payload.get("recipeId")))
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.foods), selectinload(Recipe.cook_logs))
        .with_for_update()
    )
    if recipe is None:
        raise AIConflictError("菜谱不存在或已被删除")
    assert_updated_at_matches(actual=recipe.updated_at, expected=str(payload.get("baseUpdatedAt")), label=f"菜谱 {recipe.title}")

    request = CookRecipeRequest.model_validate(
        {
            "servings": payload.get("servings"),
            "date": payload.get("date"),
            "meal_type": payload.get("mealType"),
            "participant_user_ids": payload.get("participantUserIds") or [],
            "notes": payload.get("notes") or "",
            "create_meal_log": payload.get("createMealLog") or False,
            "food_plan_item_id": payload.get("planItemId"),
            "recipe_plan_item_id": payload.get("planItemId"),
            "result_note": payload.get("resultNote") or "",
            "adjustments": payload.get("adjustments") or "",
            "rating": payload.get("rating"),
        }
    )
    try:
        locked = _lock_and_validate_recipe_cook_boundaries(
            db,
            family_id=family_id,
            payload=payload,
        )
    except InventoryConflictError as exc:
        raise AIConflictError(STALE_INVENTORY_DETAIL) from exc

    consumption_plan, shortages = build_cook_inventory_plan(
        db,
        family_id=family_id,
        recipe=recipe,
        servings=request.servings,
        today=today_for_family(family_id),
    )
    if shortages:
        raise AIConflictError("当前库存不足，不能直接完成做菜，请刷新预览或先补采购")
    current_preview = jsonable_encoder([serialize_cook_preview_item(item) for item in consumption_plan])
    if payload.get("shortages") != [] or payload.get("previewItems") != current_preview:
        raise AIConflictError("库存扣减预览已变化，请重新生成做菜草稿")

    planned_item_ids = [
        deduction.item.id
        for plan in consumption_plan
        for deduction in plan.deductions
    ]
    planned_ingredient_ids = sorted({plan.ingredient.id for plan in consumption_plan if plan.ingredient is not None})
    locked_items = locked.inventory_items
    locked_ingredients = locked.ingredients
    if any(item_id not in locked_items for item_id in planned_item_ids) or any(
        ingredient_id not in locked_ingredients for ingredient_id in planned_ingredient_ids
    ):
        raise AIConflictError("库存扣减范围已变化，请重新生成做菜草稿")

    consumed_items: list[dict[str, Any]] = []
    try:
        bumped_ingredient_ids: set[str] = set()
        for plan in consumption_plan:
            affected_item_ids: list[str] = []
            for deduction in plan.deductions:
                item = locked_items.get(deduction.item.id)
                if item is None:
                    raise AIConflictError(STALE_INVENTORY_DETAIL)
                item.consumed_quantity = item.consumed_quantity + deduction.quantity
                item.updated_by = user_id
                affected_item_ids.append(item.id)
            if affected_item_ids and plan.ingredient is not None and plan.ingredient.id not in bumped_ingredient_ids:
                ingredient = locked_ingredients.get(plan.ingredient.id)
                if ingredient is None:
                    raise AIConflictError(STALE_INVENTORY_DETAIL)
                bump_ingredient_collection(ingredient, user_id=user_id)
                bumped_ingredient_ids.add(plan.ingredient.id)
            consumed_items.append(
                {
                    "ingredient_id": plan.ingredient.id,
                    "ingredient_name": plan.ingredient_item.ingredient_name,
                    "requested_quantity": float(plan.requested_quantity),
                    "unit": plan.ingredient_item.unit,
                    "quantity_tracking_mode": plan.quantity_tracking_mode,
                    "deduction_note": plan.deduction_note,
                    "affected_item_ids": affected_item_ids,
                }
            )
        db.flush()
    except (InventoryConflictError, StaleDataError) as exc:
        raise AIConflictError(STALE_INVENTORY_DETAIL) from exc

    meal_log_id: str | None = None
    if request.create_meal_log:
        food, _ = ensure_food_for_recipe(
            db,
            family_id=family_id,
            user_id=user_id,
            recipe=recipe,
            sync_media=False,
        )
        meal_log = MealLog(
            id=create_id("meal"),
            family_id=family_id,
            date=request.date or today_for_family(family_id),
            meal_type=request.meal_type or MealType.DINNER,
            participant_user_ids=list(request.participant_user_ids or [user_id]),
            notes=request.notes,
            mood="已做菜谱",
            created_by=user_id,
            updated_by=user_id,
        )
        db.add(meal_log)
        db.flush()
        db.add(
            MealLogFood(
                id=create_id("meal-food"),
                meal_log_id=meal_log.id,
                food_id=food.id,
                servings=Decimal(str(request.servings)),
                note=f"来自菜谱：{recipe.title}",
            )
        )
        meal_log_id = meal_log.id

    plan_item = None
    if request.food_plan_item_id or request.recipe_plan_item_id:
        plan_item_id = request.food_plan_item_id or request.recipe_plan_item_id
        plan_item = db.scalar(
            select(FoodPlanItem)
            .join(FoodPlanItem.food)
            .where(
                FoodPlanItem.family_id == family_id,
                FoodPlanItem.user_id == user_id,
                FoodPlanItem.id == plan_item_id,
                FoodPlanItem.food.has(recipe_id=recipe.id),
            )
            .with_for_update()
        )
        if plan_item is None:
            raise AIConflictError("关联计划项不存在或不匹配当前菜谱")
        assert_updated_at_matches(actual=plan_item.updated_at, expected=str(payload.get("planItemBaseUpdatedAt")), label="关联餐食计划")
        plan_item.status = "cooked"
        plan_item.completed_at = utcnow()
        plan_item.meal_log_id = meal_log_id
        plan_item.updated_by = user_id

    cook_log = RecipeCookLog(
        id=create_id("recipe-cook"),
        family_id=family_id,
        recipe_id=recipe.id,
        meal_log_id=meal_log_id,
        cook_date=request.date or today_for_family(family_id),
        meal_type=request.meal_type or MealType.DINNER,
        servings=Decimal(str(request.servings)),
        result_note=request.result_note.strip(),
        adjustments=request.adjustments.strip(),
        rating=request.rating,
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(cook_log)
    db.flush()
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"AI 完成做菜 {recipe.title}，扣减 {len(consumed_items)} 项食材",
    )
    result = {
        "recipe_id": recipe.id,
        "title": recipe.title,
        "consumed_items": consumed_items,
        "shortages": [],
        "meal_log_id": meal_log_id,
        "cook_log_id": cook_log.id,
        "plan_item_id": plan_item.id if plan_item is not None else None,
        "cook_log": serialize_recipe_cook_log(cook_log),
    }
    return result, [cook_log.id]
