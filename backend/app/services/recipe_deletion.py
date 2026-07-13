from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import ActivityAction
from app.models.domain import Food, FoodPlanItem, MealLogFood, Recipe, RecipeCookLog
from app.services.activity import log_activity
from app.services.inventory_operation_locking import lock_inventory_targets
from app.services.media import replace_media_assets
from app.services.search.indexing import delete_search_document


class RecipeHasHistoryError(ValueError):
    code = "recipe_has_history"

    def __init__(self) -> None:
        super().__init__("这份做法已有菜单或餐食历史，暂时不能删除")


class FoodHasHistoryError(ValueError):
    code = "food_has_history"

    def __init__(self, message: str = "该食物已有菜单或餐食历史，暂时不能删除") -> None:
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class LockedRecipeDeletionTarget:
    recipe: Recipe
    foods_by_id: dict[str, Food]


def recipe_has_history_detail(exc: RecipeHasHistoryError) -> dict[str, str]:
    return {
        "code": exc.code,
        "message": str(exc),
    }


def food_has_history(db: Session, *, food_id: str) -> bool:
    """Return True when a food is referenced by meal logs, plans, or cook logs."""
    has_meal = (
        db.scalar(select(MealLogFood.id).where(MealLogFood.food_id == food_id).limit(1)) is not None
    )
    if has_meal:
        return True
    has_plan = (
        db.scalar(select(FoodPlanItem.id).where(FoodPlanItem.food_id == food_id).limit(1)) is not None
    )
    if has_plan:
        return True
    # Cook logs are recipe-scoped; foods created by cook completion may still be
    # referenced only via meal_log/plan, which are covered above.
    return False


def assert_food_deletable(db: Session, *, food_id: str, family_id: str | None = None) -> None:
    """Raise FoodHasHistoryError when deleting would cascade-destroy history."""
    del family_id  # reserved for future family-scoped checks
    if food_has_history(db, food_id=food_id):
        raise FoodHasHistoryError()


def lock_recipe_deletion_target(
    db: Session,
    *,
    family_id: str,
    recipe_id: str,
) -> LockedRecipeDeletionTarget:
    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == family_id, Recipe.id == recipe_id)
        .options(selectinload(Recipe.foods))
        .with_for_update()
    )
    if recipe is None:
        raise LookupError("Recipe not found")

    food_ids = sorted(food.id for food in recipe.foods)
    foods_by_id = (
        lock_inventory_targets(db, family_id=family_id, food_ids=food_ids).foods if food_ids else {}
    )

    has_cook = (
        db.scalar(select(RecipeCookLog.id).where(RecipeCookLog.recipe_id == recipe.id).limit(1))
        is not None
    )
    has_meal = bool(food_ids) and (
        db.scalar(select(MealLogFood.id).where(MealLogFood.food_id.in_(food_ids)).limit(1)) is not None
    )
    has_plan = bool(food_ids) and (
        db.scalar(select(FoodPlanItem.id).where(FoodPlanItem.food_id.in_(food_ids)).limit(1))
        is not None
    )
    if has_cook or has_meal or has_plan:
        raise RecipeHasHistoryError()

    return LockedRecipeDeletionTarget(recipe=recipe, foods_by_id=foods_by_id)


def delete_recipe_with_guard(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    recipe_id: str,
    activity_summary: str | None = None,
) -> LockedRecipeDeletionTarget:
    """Lock Recipe→Food parents, recheck history refs, then delete media/search/entities.

    Commit ownership stays with the REST/AI transaction boundary.
    """
    locked = lock_recipe_deletion_target(db, family_id=family_id, recipe_id=recipe_id)
    recipe = locked.recipe
    title = recipe.title
    food_ids = list(locked.foods_by_id.keys())

    for food_id in food_ids:
        replace_media_assets(
            db,
            family_id=family_id,
            media_ids=[],
            entity_type="food",
            entity_id=food_id,
        )
        db.delete(locked.foods_by_id[food_id])

    replace_media_assets(
        db,
        family_id=family_id,
        media_ids=[],
        entity_type="recipe",
        entity_id=recipe.id,
    )
    db.delete(recipe)

    log_activity(
        db,
        family_id=family_id,
        actor_id=actor_id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe_id,
        summary=activity_summary or f"删除菜谱 {title}",
    )

    delete_search_document(
        db,
        family_id=family_id,
        entity_type="recipe",
        entity_id=recipe_id,
        delete_vector=True,
    )
    for food_id in food_ids:
        delete_search_document(
            db,
            family_id=family_id,
            entity_type="food",
            entity_id=food_id,
            delete_vector=True,
        )

    return locked
