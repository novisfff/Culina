from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.models.domain import Recipe, RecipeFavorite, RecipeIngredient, RecipeStep
from app.schemas.recipes import CreateRecipeRequest, UpdateRecipeRequest
from app.services.activity import log_activity
from app.services.media import bind_media_assets, replace_media_assets
from app.services.recipe_food_sync import ensure_food_for_recipe


UpdatedAtValidator = Callable[[datetime | None, str, str], None]


def execute_recipe_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
) -> Recipe:
    action = str(payload.get("action") or "")
    if not action or action == "create":
        effective_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
        return _create_recipe_from_draft(db, family_id=family_id, user_id=user_id, payload=effective_payload)

    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.family_id == family_id, Recipe.id == str(payload.get("targetId")))
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.foods), selectinload(Recipe.cook_logs))
        .with_for_update()
    )
    if recipe is None:
        raise AIConflictError("菜谱不存在或已被删除")
    assert_updated_at_matches(actual=recipe.updated_at, expected=str(payload.get("baseUpdatedAt")), label=f"菜谱 {recipe.title}")

    if action == "set_favorite":
        favorite = bool((payload.get("payload") or {}).get("favorite"))
        existing = db.scalar(
            select(RecipeFavorite).where(
                RecipeFavorite.family_id == family_id,
                RecipeFavorite.user_id == user_id,
                RecipeFavorite.recipe_id == recipe.id,
            )
        )
        if favorite and existing is None:
            db.add(
                RecipeFavorite(
                    id=create_id("recipe-favorite"),
                    family_id=family_id,
                    user_id=user_id,
                    recipe_id=recipe.id,
                )
            )
        elif not favorite and existing is not None:
            db.delete(existing)
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="Recipe",
            entity_id=recipe.id,
            summary=f"{'收藏' if favorite else '取消收藏'}菜谱 {recipe.title}",
        )
        db.flush()
        return recipe

    if action == "delete":
        title = recipe.title
        recipe_id = recipe.id
        for food in list(recipe.foods):
            replace_media_assets(
                db,
                family_id=family_id,
                media_ids=[],
                entity_type="food",
                entity_id=food.id,
            )
            db.delete(food)
        replace_media_assets(
            db,
            family_id=family_id,
            media_ids=[],
            entity_type="recipe",
            entity_id=recipe.id,
        )
        difficulty = recipe.difficulty
        db.delete(recipe)
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="Recipe",
            entity_id=recipe_id,
            summary=f"AI 删除菜谱 {title}",
        )
        return Recipe(
            id=recipe_id,
            family_id=family_id,
            title=title,
            servings=0,
            prep_minutes=0,
            difficulty=difficulty,
            tips="",
            scene_tags=[],
            created_by=user_id,
            updated_by=user_id,
        )

    recipe_in = UpdateRecipeRequest.model_validate(payload.get("payload") or {})
    recipe.title = recipe_in.title
    recipe.servings = recipe_in.servings
    recipe.prep_minutes = recipe_in.prep_minutes
    recipe.difficulty = recipe_in.difficulty
    recipe.tips = recipe_in.tips
    recipe.scene_tags = list(dict.fromkeys(tag.strip() for tag in recipe_in.scene_tags if tag.strip()))
    recipe.updated_by = user_id
    recipe.ingredient_items.clear()
    recipe.steps.clear()
    db.flush()
    for index, item in enumerate(recipe_in.ingredient_items):
        db.add(
            RecipeIngredient(
                id=create_id("recipe-ingredient"),
                recipe_id=recipe.id,
                ingredient_id=item.ingredient_id,
                ingredient_name=item.ingredient_name,
                quantity=Decimal(str(item.quantity)),
                unit=item.unit,
                note=item.note,
                sort_order=index,
            )
        )
    for index, step in enumerate([value for value in recipe_in.steps if value.text.strip()]):
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
    replace_media_assets(
        db,
        family_id=family_id,
        media_ids=recipe_in.media_ids,
        entity_type="recipe",
        entity_id=recipe.id,
    )
    synced_food, synced_food_created = ensure_food_for_recipe(
        db,
        family_id=family_id,
        user_id=user_id,
        recipe=recipe,
        recipe_media_ids=recipe_in.media_ids,
        sync_media=True,
    )
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"AI 更新菜谱 {recipe.title}",
    )
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.CREATE if synced_food_created else ActivityAction.UPDATE,
        entity_type="Food",
        entity_id=synced_food.id,
        summary=f"{'AI 补建' if synced_food_created else 'AI 同步更新'}家常菜 {synced_food.name}",
    )
    db.flush()
    refreshed = db.scalar(
        select(Recipe)
        .where(Recipe.id == recipe.id)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
    )
    assert refreshed is not None
    return refreshed


def _create_recipe_from_draft(db: Session, *, family_id: str, user_id: str, payload: dict[str, Any]) -> Recipe:
    recipe_in = CreateRecipeRequest.model_validate(payload)
    recipe = Recipe(
        id=create_id("recipe"),
        family_id=family_id,
        title=recipe_in.title,
        servings=recipe_in.servings,
        prep_minutes=recipe_in.prep_minutes,
        difficulty=recipe_in.difficulty,
        tips=recipe_in.tips,
        scene_tags=list(dict.fromkeys(tag.strip() for tag in recipe_in.scene_tags if tag.strip())),
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(recipe)
    db.flush()
    for index, item in enumerate(recipe_in.ingredient_items):
        db.add(
            RecipeIngredient(
                id=create_id("recipe-ingredient"),
                recipe_id=recipe.id,
                ingredient_id=item.ingredient_id,
                ingredient_name=item.ingredient_name,
                quantity=Decimal(str(item.quantity)),
                unit=item.unit,
                note=item.note,
                sort_order=index,
            )
        )
    for index, step in enumerate([value for value in recipe_in.steps if value.text.strip()]):
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
    bind_media_assets(db, family_id=family_id, media_ids=recipe_in.media_ids, entity_type="recipe", entity_id=recipe.id)
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.CREATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"AI 创建菜谱 {recipe.title}",
    )
    food, _ = ensure_food_for_recipe(
        db,
        family_id=family_id,
        user_id=user_id,
        recipe=recipe,
        recipe_media_ids=recipe_in.media_ids,
        sync_media=True,
    )
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.CREATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"AI 自动创建家常菜 {food.name}",
    )
    db.flush()
    recipe = db.scalar(
        select(Recipe)
        .where(Recipe.id == recipe.id)
        .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
    )
    assert recipe is not None
    return recipe
