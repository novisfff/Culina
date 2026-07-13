from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.exc import StaleDataError
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, Difficulty, MealType
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Recipe, RecipeIngredient, RecipeStep
from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.recipes import (
    CookRecipePreviewRequest,
    CookRecipePreviewResponse,
    CookRecipeRequest,
    CookRecipeResponse,
    CreateRecipeRequest,
    RecipeAvailabilityOut,
    RecipeDiscoveryOut,
    RecipeOut,
    RecipeStatsOut,
    UpdateRecipeRequest,
)
from app.services.activity import log_activity
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.services.clock import today_for_family
from app.services.food_plan_locking import FoodPlanConflict, food_plan_conflict_detail
from app.services.ingredient_units import UnitConversionError
from app.services.inventory_usage import build_cook_inventory_plan, load_available_inventory_by_ingredient, recipe_availability_rank, recipe_availability_summary, serialize_cook_preview_item
from app.services.meal_log_references import MealLogReferenceError, meal_log_reference_error_detail
from app.services.media import bind_media_assets, replace_media_assets
from app.services.recipe_cook_completion import (
    CompletionConflict,
    RecipeCookCompletionCommand,
    complete_recipe_cook,
)
from app.services.recipe_deletion import RecipeHasHistoryError, delete_recipe_with_guard, recipe_has_history_detail
from app.services.recipe_ingredient_refs import RecipeIngredientReferenceError, normalize_recipe_ingredient_items, recipe_ingredient_reference_error_detail
from app.services.recipe_food_sync import ensure_food_for_recipe
from app.services.search.hybrid import hybrid_search
from app.services.search.jobs import enqueue_search_index_job
from app.services.recipe_recommendations import build_availability_map, build_recipe_discovery, build_recipe_stats, load_recipes_for_family
from app.services.serializers import serialize_recipe

logger = logging.getLogger(__name__)

router = APIRouter(tags=["recipes"])


def _load_recipe(db: Session, *, family_id: str, recipe_id: str) -> Recipe:
    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == family_id, Recipe.id == recipe_id)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.foods), selectinload(Recipe.cook_logs))
    )
    if recipe is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe not found")
    return recipe


def _replace_recipe_children(db: Session, recipe: Recipe, payload: CreateRecipeRequest | UpdateRecipeRequest) -> None:
    recipe.ingredient_items.clear()
    recipe.steps.clear()
    db.flush()

    ingredient_items = normalize_recipe_ingredient_items(
        db,
        family_id=recipe.family_id,
        items=payload.ingredient_items,
    )
    for index, item in enumerate(ingredient_items):
        db.add(
            RecipeIngredient(
                id=create_id("recipe-ingredient"),
                recipe_id=recipe.id,
                ingredient_id=item["ingredient_id"],
                ingredient_name=item["ingredient_name"],
                quantity=Decimal(str(item["quantity"])),
                unit=item["unit"],
                note=item["note"],
                sort_order=index,
            )
        )

    for index, step in enumerate([value for value in payload.steps if value.text.strip()]):
        db.add(
            RecipeStep(
                id=create_id("step"),
                recipe_id=recipe.id,
                title=step.title.strip() or None,
                text=step.text.strip(),
                icon=step.icon.strip() or "pan",
                summary=step.summary.strip(),
                estimated_minutes=step.estimated_minutes if step.estimated_minutes and step.estimated_minutes > 0 else None,
                tip=step.tip.strip(),
                key_points=[item.strip() for item in step.key_points if item.strip()],
                sort_order=index,
            )
        )



def _serialize_discovery_section(recipes: list[Recipe], media_map: dict[tuple[str, str], list[object]]) -> dict:
    return {
        "recipe_ids": [recipe.id for recipe in recipes],
        "recipes": [serialize_recipe(recipe, media_map) for recipe in recipes],
    }


def _recipe_matches_query(recipe: Recipe, query: str) -> bool:
    if not query:
        return True
    haystack_parts = [
        recipe.title,
        recipe.tips,
        *(recipe.scene_tags or []),
        *(item.ingredient_name for item in recipe.ingredient_items),
        *(item.note for item in recipe.ingredient_items),
        *(step.title or "" for step in recipe.steps),
        *(step.summary for step in recipe.steps),
        *(step.text for step in recipe.steps),
        *(step.tip for step in recipe.steps),
        *(point for step in recipe.steps for point in (step.key_points or [])),
    ]
    return query in " ".join(part.lower() for part in haystack_parts if part).strip()


@router.get("/api/recipes", response_model=list[RecipeOut])
def list_recipes(
    q: str | None = Query(default=None),
    scene: str | None = Query(default=None),
    difficulty: Difficulty | None = Query(default=None),
    sort: str = Query(default="updated"),
    availability: str | None = Query(default=None),
    limit: int | None = Query(default=None, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    normalized_q = (q or "").strip().lower()
    normalized_scene = (scene or "").strip()
    normalized_availability = (availability or "").strip()
    needs_python_pagination = bool(normalized_q or normalized_scene or normalized_availability or sort == "availability")

    if normalized_q:
        requested_window = offset + (limit or 100)
        search_result = hybrid_search(
            db,
            family_id=membership.family_id,
            query=normalized_q,
            scopes=["recipe"],
            limit=max(100, requested_window * 4),
            offset=0,
        )
        recipe_ids = [item.entity_id for item in search_result.items if item.entity_type == "recipe"]
        recipes_by_id: dict[str, Recipe] = {}
        recipes: list[Recipe] = []
        if recipe_ids:
            statement = (
                select(Recipe)
                .where(Recipe.family_id == membership.family_id, Recipe.id.in_(recipe_ids))
                .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
            )
            if difficulty is not None:
                statement = statement.where(Recipe.difficulty == difficulty)
            recipes_by_id = {recipe.id: recipe for recipe in db.scalars(statement)}
            recipes = [recipes_by_id[recipe_id] for recipe_id in recipe_ids if recipe_id in recipes_by_id]
        fallback_recipes = load_recipes_for_family(
            db,
            membership.family_id,
            difficulty=difficulty,
            defer_pagination=True,
        )
        recipes.extend(
            recipe
            for recipe in fallback_recipes
            if recipe.id not in recipes_by_id and _recipe_matches_query(recipe, normalized_q)
        )
    else:
        recipes = load_recipes_for_family(
            db,
            membership.family_id,
            difficulty=difficulty,
            sort=sort,
            limit=limit,
            offset=offset,
            defer_pagination=needs_python_pagination,
        )
    if normalized_scene:
        recipes = [recipe for recipe in recipes if normalized_scene in (recipe.scene_tags or [])]

    availability_map: dict[str, dict] = {}
    if normalized_availability or sort == "availability":
        today = today_for_family(membership.family_id)
        ingredient_ids = [item.ingredient_id for recipe in recipes for item in recipe.ingredient_items if item.ingredient_id]
        inventory_by_ingredient = load_available_inventory_by_ingredient(db, family_id=membership.family_id, ingredient_ids=ingredient_ids, today=today)
        try:
            availability_map = build_availability_map(
                db,
                family_id=membership.family_id,
                recipes=recipes,
                today=today,
                inventory_by_ingredient=inventory_by_ingredient,
            )
        except UnitConversionError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if normalized_availability:
        recipes = [recipe for recipe in recipes if availability_map.get(recipe.id, {}).get("availability") == normalized_availability]

    if needs_python_pagination and sort == "time":
        recipes.sort(key=lambda recipe: (recipe.prep_minutes, recipe.updated_at), reverse=False)
    elif needs_python_pagination and sort == "difficulty":
        difficulty_weight = {Difficulty.EASY: 0, Difficulty.MEDIUM: 1, Difficulty.HARD: 2}
        recipes.sort(key=lambda recipe: (difficulty_weight.get(recipe.difficulty, 9), recipe.prep_minutes, recipe.updated_at))
    elif sort == "availability":
        recipes.sort(key=lambda recipe: (recipe_availability_rank(availability_map.get(recipe.id, {}).get("availability", "missing")), recipe.prep_minutes, recipe.updated_at))
    elif needs_python_pagination and not normalized_q:
        recipes.sort(key=lambda recipe: recipe.updated_at, reverse=True)

    if needs_python_pagination and offset:
        recipes = recipes[offset:]
    if needs_python_pagination and limit is not None:
        recipes = recipes[:limit]

    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="recipe", entity_ids=[recipe.id for recipe in recipes]))
    return [serialize_recipe(item, media_map) for item in recipes]


@router.get("/api/recipes/discovery", response_model=RecipeDiscoveryOut)
def discover_recipes(
    limit: int = Query(default=6, ge=1, le=20),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    today = today_for_family(membership.family_id)
    recipes = load_recipes_for_family(db, membership.family_id)
    ingredient_ids = [item.ingredient_id for recipe in recipes for item in recipe.ingredient_items if item.ingredient_id]
    inventory_by_ingredient = load_available_inventory_by_ingredient(db, family_id=membership.family_id, ingredient_ids=ingredient_ids, today=today)
    try:
        availability_by_recipe_id = build_availability_map(
            db,
            family_id=membership.family_id,
            recipes=recipes,
            today=today,
            inventory_by_ingredient=inventory_by_ingredient,
        )
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    sections = build_recipe_discovery(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        recipes=recipes,
        availability_by_recipe_id=availability_by_recipe_id,
        today=today,
        limit=limit,
    )
    section_recipe_ids = list({recipe.id for values in sections.values() for recipe in values})
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="recipe", entity_ids=section_recipe_ids))
    return {
        "recommended": _serialize_discovery_section(sections["recommended"], media_map),
        "ready": _serialize_discovery_section(sections["ready"], media_map),
        "quick": _serialize_discovery_section(sections["quick"], media_map),
        "missing": _serialize_discovery_section(sections["missing"], media_map),
    }


@router.get("/api/recipes/{recipe_id}/availability", response_model=RecipeAvailabilityOut)
def get_recipe_availability(
    recipe_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    try:
        summary = recipe_availability_summary(db, family_id=membership.family_id, recipe=recipe, today=today_for_family(membership.family_id))
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {key: value for key, value in summary.items() if key != "plan_count"}


@router.get("/api/recipes/stats", response_model=RecipeStatsOut)
def get_recipe_stats(
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    limit: int = Query(default=10, ge=1, le=50),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    return build_recipe_stats(db, family_id=membership.family_id, date_from=date_from, date_to=date_to, limit=limit)


@router.post("/api/recipes", response_model=RecipeOut, status_code=status.HTTP_201_CREATED)
def create_recipe(
    payload: CreateRecipeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    recipe = Recipe(
        id=create_id("recipe"),
        family_id=membership.family_id,
        title=payload.title,
        servings=payload.servings,
        prep_minutes=payload.prep_minutes,
        difficulty=payload.difficulty,
        tips=payload.tips,
        scene_tags=list(dict.fromkeys(tag.strip() for tag in payload.scene_tags if tag.strip())),
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(recipe)
    db.flush()
    try:
        _replace_recipe_children(db, recipe, payload)
    except RecipeIngredientReferenceError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=recipe_ingredient_reference_error_detail(exc)) from exc

    bind_media_assets(db, family_id=membership.family_id, media_ids=payload.media_ids, entity_type="recipe", entity_id=recipe.id)
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="recipe",
                entity_id=recipe.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"新增菜谱 {recipe.title}",
    )

    food, _ = ensure_food_for_recipe(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        recipe=recipe,
        recipe_media_ids=payload.media_ids,
        sync_media=True,
    )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"自动创建家常菜 {food.name}",
    )
    enqueue_search_index_job(db, family_id=membership.family_id, user_id=user.id, entity_type="recipe", entity_id=recipe.id, target_name=recipe.title)
    enqueue_search_index_job(db, family_id=membership.family_id, user_id=user.id, entity_type="food", entity_id=food.id, target_name=food.name)

    commit_session(db)
    db.refresh(recipe)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="recipe", entity_ids=[recipe.id]))
    return serialize_recipe(recipe, media_map)


@router.patch("/api/recipes/{recipe_id}", response_model=RecipeOut)
def update_recipe(
    recipe_id: str,
    payload: UpdateRecipeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    recipe.title = payload.title
    recipe.servings = payload.servings
    recipe.prep_minutes = payload.prep_minutes
    recipe.difficulty = payload.difficulty
    recipe.tips = payload.tips
    recipe.scene_tags = list(dict.fromkeys(tag.strip() for tag in payload.scene_tags if tag.strip()))
    recipe.updated_by = user.id
    try:
        _replace_recipe_children(db, recipe, payload)
    except RecipeIngredientReferenceError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=recipe_ingredient_reference_error_detail(exc)) from exc
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=payload.media_ids,
        entity_type="recipe",
        entity_id=recipe.id,
    )
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="recipe",
                entity_id=recipe.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    synced_food, synced_food_created = ensure_food_for_recipe(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        recipe=recipe,
        recipe_media_ids=payload.media_ids,
        sync_media=True,
    )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"更新菜谱 {recipe.title}",
    )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE if synced_food_created else ActivityAction.UPDATE,
        entity_type="Food",
        entity_id=synced_food.id,
        summary=f"{'补建' if synced_food_created else '同步更新'}家常菜 {synced_food.name}",
    )
    enqueue_search_index_job(db, family_id=membership.family_id, user_id=user.id, entity_type="recipe", entity_id=recipe.id, target_name=recipe.title)
    enqueue_search_index_job(db, family_id=membership.family_id, user_id=user.id, entity_type="food", entity_id=synced_food.id, target_name=synced_food.name)
    commit_session(db)
    db.refresh(recipe)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="recipe", entity_ids=[recipe.id]))
    return serialize_recipe(recipe, media_map)


@router.delete("/api/recipes/{recipe_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_recipe(
    recipe_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> None:
    user, membership = auth
    try:
        delete_recipe_with_guard(
            db,
            family_id=membership.family_id,
            actor_id=user.id,
            recipe_id=recipe_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe not found") from exc
    except RecipeHasHistoryError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=recipe_has_history_detail(exc),
        ) from exc
    commit_session(db)
    return None


@router.post("/api/recipes/{recipe_id}/cook-preview", response_model=CookRecipePreviewResponse)
def preview_cook_recipe(
    recipe_id: str,
    payload: CookRecipePreviewRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    try:
        consumption_plan, shortages = build_cook_inventory_plan(
            db,
            family_id=membership.family_id,
            recipe=recipe,
            servings=payload.servings,
            today=today_for_family(membership.family_id),
            allow_partial_deduction=payload.allow_partial_inventory_deduction,
        )
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {
        "recipe_id": recipe.id,
        "preview_items": [serialize_cook_preview_item(plan) for plan in consumption_plan]
        if payload.allow_partial_inventory_deduction or not shortages
        else [],
        "shortages": shortages,
    }


def _completion_conflict_detail(exc: CompletionConflict) -> dict[str, str]:
    return {"code": exc.code, "message": exc.message}


def _raise_completion_conflict(exc: CompletionConflict) -> None:
    if exc.code == "recipe_not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe not found") from exc
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=_completion_conflict_detail(exc),
    ) from exc


def _raise_meal_log_reference_error(exc: MealLogReferenceError) -> None:
    status_code = (
        status.HTTP_404_NOT_FOUND
        if exc.code in {"meal_log_food_not_found", "meal_log_participant_not_found"}
        else status.HTTP_422_UNPROCESSABLE_ENTITY
    )
    raise HTTPException(status_code=status_code, detail=meal_log_reference_error_detail(exc)) from exc


def _raise_food_plan_conflict(exc: FoodPlanConflict) -> None:
    if exc.code == "food_plan_item_not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food plan item not found") from exc
    if exc.code in {
        "food_plan_item_already_completed",
        "food_plan_item_stale",
        "food_plan_targets_changed",
        "food_plan_food_mismatch",
        "food_plan_item_not_planned",
    }:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=food_plan_conflict_detail(exc)) from exc
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=food_plan_conflict_detail(exc)) from exc


@router.post("/api/recipes/{recipe_id}/cook", response_model=CookRecipeResponse)
def cook_recipe(
    recipe_id: str,
    payload: CookRecipeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    command = RecipeCookCompletionCommand(
        completion_request_id=payload.completion_request_id,
        family_id=membership.family_id,
        actor_user_id=user.id,
        recipe_id=recipe_id,
        cook_date=payload.date or today_for_family(membership.family_id),
        meal_type=payload.meal_type or MealType.DINNER,
        servings=Decimal(str(payload.servings)),
        participant_user_ids=tuple(payload.participant_user_ids),
        notes=payload.notes,
        food_plan_item_id=payload.food_plan_item_id,
        food_plan_item_base_updated_at=payload.food_plan_item_base_updated_at,
        result_note=payload.result_note.strip(),
        adjustments=payload.adjustments.strip(),
        rating=payload.rating,
        allow_partial_inventory_deduction=payload.allow_partial_inventory_deduction,
    )
    try:
        result = complete_recipe_cook(db, command)
        commit_session(db)
    except CompletionConflict as exc:
        db.rollback()
        _raise_completion_conflict(exc)
    except FoodPlanConflict as exc:
        db.rollback()
        _raise_food_plan_conflict(exc)
    except MealLogReferenceError as exc:
        db.rollback()
        _raise_meal_log_reference_error(exc)
    except UnitConversionError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc
    return result.model_dump(mode="json")
