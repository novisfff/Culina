from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import Difficulty, IngredientQuantityTrackingMode
from app.models.domain import Food, FoodPlanItem, Ingredient, IngredientInventoryState, InventoryItem, MealLog, Recipe, RecipeFavorite
from app.services.ingredient_inventory_state import state_is_physically_present
from app.services.inventory_usage import recipe_availability_summary, remaining_quantity, tracks_quantity


def recipe_search_text(recipe: Recipe) -> str:
    segments = [
        recipe.title,
        recipe.tips,
        " ".join(f"{item.ingredient_name} {item.note}" for item in recipe.ingredient_items),
        " ".join(step.text for step in recipe.steps),
    ]
    return " ".join(segments).lower()


def load_recipes_for_family(
    db: Session,
    family_id: str,
    *,
    difficulty: Difficulty | None = None,
    sort: str = "updated",
    limit: int | None = None,
    offset: int = 0,
    defer_pagination: bool = False,
) -> list[Recipe]:
    statement = (
        select(Recipe)
        .where(Recipe.family_id == family_id)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
    )
    if difficulty is not None:
        statement = statement.where(Recipe.difficulty == difficulty)
    if sort == "time":
        statement = statement.order_by(Recipe.prep_minutes.asc(), Recipe.updated_at.asc())
    elif sort == "difficulty":
        statement = statement.order_by(Recipe.difficulty.asc(), Recipe.prep_minutes.asc(), Recipe.updated_at.asc())
    else:
        statement = statement.order_by(Recipe.updated_at.desc())
    if not defer_pagination:
        if offset:
            statement = statement.offset(offset)
        if limit is not None:
            statement = statement.limit(limit)
    return list(db.scalars(statement))


def recipe_usage_maps(meal_logs: list[MealLog], foods: list[Food]) -> tuple[dict[str, int], dict[str, date]]:
    recipe_ids_by_food_id = {food.id: food.recipe_id for food in foods if food.recipe_id}
    counts: dict[str, int] = {}
    last_used_at: dict[str, date] = {}
    for log in meal_logs:
        recipe_ids = {
            recipe_ids_by_food_id.get(entry.food_id)
            for entry in log.food_entries
            if recipe_ids_by_food_id.get(entry.food_id)
        }
        for recipe_id in recipe_ids:
            if recipe_id is None:
                continue
            counts[recipe_id] = counts.get(recipe_id, 0) + 1
            if recipe_id not in last_used_at or log.date > last_used_at[recipe_id]:
                last_used_at[recipe_id] = log.date
    return counts, last_used_at


def recipe_recommendation_usage_maps(
    *,
    recipes: list[Recipe],
    meal_logs: list[MealLog],
    foods: list[Food],
    today: date,
) -> tuple[dict[str, int], dict[str, date]]:
    recipe_ids_by_food_id = {food.id: food.recipe_id for food in foods if food.recipe_id}
    event_dates_by_recipe_id: dict[str, list[date]] = {recipe.id: [] for recipe in recipes}
    for log in meal_logs:
        recipe_ids = {
            recipe_ids_by_food_id.get(entry.food_id)
            for entry in log.food_entries
            if recipe_ids_by_food_id.get(entry.food_id)
        }
        for recipe_id in recipe_ids:
            if recipe_id:
                if recipe_id not in event_dates_by_recipe_id:
                    event_dates_by_recipe_id[recipe_id] = []
                event_dates_by_recipe_id[recipe_id].append(log.date)
    for recipe in recipes:
        for cook_log in recipe.cook_logs:
            if recipe.id not in event_dates_by_recipe_id:
                event_dates_by_recipe_id[recipe.id] = []
            event_dates_by_recipe_id[recipe.id].append(cook_log.cook_date)

    window_start = today - timedelta(days=90)
    counts = {
        recipe_id: sum(1 for event_date in event_dates if window_start <= event_date <= today)
        for recipe_id, event_dates in event_dates_by_recipe_id.items()
    }
    last_used_at = {
        recipe_id: max(event_dates)
        for recipe_id, event_dates in event_dates_by_recipe_id.items()
        if event_dates
    }
    return counts, last_used_at


def _expiry_bonus_for_date(expiry_date: date | None, today: date) -> int:
    if expiry_date is None:
        return 0
    days_until_expiry = (expiry_date - today).days
    if 0 <= days_until_expiry <= 3:
        return 35 - days_until_expiry * 8
    return 0


def recipe_expiring_inventory_bonus(
    recipe: Recipe,
    inventory_items: list[InventoryItem],
    today: date,
    *,
    presence_states_by_ingredient: dict[str, IngredientInventoryState] | None = None,
) -> int:
    ingredient_ids = {item.ingredient_id for item in recipe.ingredient_items if item.ingredient_id}
    if not ingredient_ids:
        return 0
    bonus = 0
    for item in inventory_items:
        # Callers should only pass track_quantity batches; skip residual presence placeholders.
        ingredient = getattr(item, "ingredient", None)
        if ingredient is not None and not tracks_quantity(ingredient):
            continue
        if item.ingredient_id not in ingredient_ids or item.expiry_date is None or remaining_quantity(item) <= 0:
            continue
        bonus = max(bonus, _expiry_bonus_for_date(item.expiry_date, today))
    if presence_states_by_ingredient:
        for ingredient_id in ingredient_ids:
            state = presence_states_by_ingredient.get(ingredient_id)
            if state is None or not state_is_physically_present(state):
                continue
            bonus = max(bonus, _expiry_bonus_for_date(state.expiry_date, today))
    return bonus


def recipe_rating_bonus(recipe: Recipe) -> float:
    ratings = [cook_log.rating for cook_log in recipe.cook_logs if cook_log.rating is not None]
    if not ratings:
        return 0
    return (sum(ratings) / len(ratings)) * 8


def build_recipe_discovery(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    recipes: list[Recipe],
    availability_by_recipe_id: dict[str, dict],
    today: date,
    limit: int,
) -> dict[str, list[Recipe]]:
    foods = list(db.scalars(select(Food).where(Food.family_id == family_id)))
    inventory_items = list(
        db.scalars(
            select(InventoryItem)
            .join(Ingredient, Ingredient.id == InventoryItem.ingredient_id)
            .where(
                InventoryItem.family_id == family_id,
                Ingredient.family_id == family_id,
                Ingredient.quantity_tracking_mode == IngredientQuantityTrackingMode.TRACK_QUANTITY,
            )
            .options(selectinload(InventoryItem.ingredient))
        )
    )
    presence_states = list(
        db.scalars(select(IngredientInventoryState).where(IngredientInventoryState.family_id == family_id))
    )
    presence_states_by_ingredient = {state.ingredient_id: state for state in presence_states}
    meal_logs = list(
        db.scalars(
            select(MealLog)
            .where(MealLog.family_id == family_id)
            .options(selectinload(MealLog.food_entries))
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
        )
    )
    usage_counts, last_used_at = recipe_recommendation_usage_maps(
        recipes=recipes,
        meal_logs=meal_logs,
        foods=foods,
        today=today,
    )
    favorite_recipe_ids = set(
        db.scalars(
            select(RecipeFavorite.recipe_id).where(
                RecipeFavorite.family_id == family_id,
                RecipeFavorite.user_id == user_id,
            )
        )
    )
    planned_recipe_ids = set(
        db.scalars(
            select(Food.recipe_id)
            .join(FoodPlanItem, FoodPlanItem.food_id == Food.id)
            .where(
                FoodPlanItem.family_id == family_id,
                FoodPlanItem.status == "planned",
                FoodPlanItem.plan_date >= today,
                FoodPlanItem.plan_date <= today + timedelta(days=2),
                Food.recipe_id.is_not(None),
            )
        )
    )

    def score(recipe: Recipe) -> float:
        availability = availability_by_recipe_id[recipe.id]
        availability_band = {"ready": 40, "partial": 15, "missing": 0}.get(availability["availability"], 0)
        last_used = last_used_at.get(recipe.id)
        recent_penalty = 0
        if last_used is not None:
            days_since_used = (today - last_used).days
            if days_since_used <= 0:
                recent_penalty = 200
            elif days_since_used <= 2:
                recent_penalty = 80
            elif days_since_used <= 7:
                recent_penalty = 25
        return (
            (120 if recipe.id in favorite_recipe_ids else 0)
            + availability["availability_score"] * 100
            + availability_band
            + min(usage_counts.get(recipe.id, 0) * 15, 60)
            + (20 if recipe.prep_minutes <= 20 else 10 if recipe.prep_minutes <= 35 else 0)
            + (10 if recipe.difficulty == Difficulty.EASY else 4 if recipe.difficulty == Difficulty.MEDIUM else 0)
            + recipe_expiring_inventory_bonus(
                recipe,
                inventory_items,
                today,
                presence_states_by_ingredient=presence_states_by_ingredient,
            )
            + recipe_rating_bonus(recipe)
            - recent_penalty
            - (60 if recipe.id in planned_recipe_ids else 0)
        )

    return {
        "recommended": sorted(
            recipes,
            key=lambda recipe: (
                score(recipe),
                availability_by_recipe_id[recipe.id]["availability_score"],
                recipe.updated_at,
            ),
            reverse=True,
        )[:limit],
        "ready": sorted(
            [recipe for recipe in recipes if availability_by_recipe_id[recipe.id]["availability"] == "ready"],
            key=lambda recipe: (recipe.prep_minutes, recipe.updated_at),
        )[:limit],
        "quick": sorted(
            [recipe for recipe in recipes if recipe.prep_minutes <= 20],
            key=lambda recipe: (recipe.prep_minutes, recipe.updated_at),
        )[:limit],
        "missing": sorted(
            [recipe for recipe in recipes if availability_by_recipe_id[recipe.id]["availability"] != "ready"],
            key=lambda recipe: (availability_by_recipe_id[recipe.id]["availability_score"], recipe.updated_at),
            reverse=True,
        )[:limit],
    }


def build_recipe_stats(
    db: Session,
    *,
    family_id: str,
    date_from: date | None,
    date_to: date | None,
    limit: int,
) -> dict:
    foods = list(db.scalars(select(Food).where(Food.family_id == family_id)))
    statement = (
        select(MealLog)
        .where(MealLog.family_id == family_id)
        .options(selectinload(MealLog.food_entries))
        .order_by(MealLog.date.desc(), MealLog.created_at.desc())
    )
    if date_from is not None:
        statement = statement.where(MealLog.date >= date_from)
    if date_to is not None:
        statement = statement.where(MealLog.date <= date_to)
    meal_logs = list(db.scalars(statement))
    counts, last_used_at = recipe_usage_maps(meal_logs, foods)
    recipes_by_id = {recipe.id: recipe for recipe in load_recipes_for_family(db, family_id)}

    items = [
        {
            "recipe_id": recipe_id,
            "recipe_title": recipes_by_id[recipe_id].title,
            "count": count,
            "last_used_at": last_used_at.get(recipe_id),
        }
        for recipe_id, count in counts.items()
        if recipe_id in recipes_by_id
    ]
    recently_cooked = sorted(items, key=lambda item: (item["last_used_at"] or date.min, item["count"]), reverse=True)[:limit]
    frequent = sorted(items, key=lambda item: (item["count"], item["last_used_at"] or date.min), reverse=True)[:limit]
    return {
        "total_cooks": sum(counts.values()),
        "recently_cooked": recently_cooked,
        "frequent": frequent,
    }


def build_availability_map(
    db: Session,
    *,
    family_id: str,
    recipes: list[Recipe],
    today: date,
    inventory_by_ingredient: dict[str, list[InventoryItem]] | None,
) -> dict[str, dict]:
    return {
        recipe.id: recipe_availability_summary(
            db,
            family_id=family_id,
            recipe=recipe,
            today=today,
            inventory_by_ingredient=inventory_by_ingredient,
        )
        for recipe in recipes
    }
