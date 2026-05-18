from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, FoodType, MealType
from app.core.utils import create_id, utcnow
from app.db.session import get_db
from app.models.domain import Food, InventoryItem, MealLog, MealLogFood, MediaAsset, Recipe, RecipeCookLog, RecipeIngredient, RecipePlanItem, RecipeStep
from app.repos.media import build_media_map, get_media_assets_for_family
from app.schemas.domain import (
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
from app.services.ingredient_units import UnitConversionError, convert_quantity_from_default_unit, convert_quantity_to_default_unit
from app.services.media import bind_media_assets, replace_media_assets
from app.services.serializers import serialize_recipe

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

    for index, item in enumerate(payload.ingredient_items):
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


def _remaining_quantity(item: InventoryItem) -> Decimal:
    return max(item.quantity - item.consumed_quantity, Decimal("0"))


def _expiry_sort_key(expiry_date: date | None) -> tuple[int, date]:
    return (1, date.max) if expiry_date is None else (0, expiry_date)


def _available_inventory_for_ingredient(db: Session, *, family_id: str, ingredient_id: str, today: date) -> list[InventoryItem]:
    items = list(
        db.scalars(
            select(InventoryItem)
            .where(InventoryItem.family_id == family_id, InventoryItem.ingredient_id == ingredient_id)
            .options(selectinload(InventoryItem.ingredient))
        )
    )
    available = [item for item in items if (item.expiry_date is None or item.expiry_date >= today) and _remaining_quantity(item) > 0]
    available.sort(key=lambda item: (*_expiry_sort_key(item.expiry_date), item.purchase_date, item.created_at))
    return available


def _inventory_remaining_in_default(item: InventoryItem, ingredient) -> Decimal:
    if item.unit == ingredient.default_unit:
        return _remaining_quantity(item)
    return convert_quantity_to_default_unit(
        _remaining_quantity(item),
        ingredient.default_unit,
        ingredient.unit_conversions,
        item.unit,
    )


def _convert_default_to_item_unit(quantity: Decimal, item: InventoryItem, ingredient) -> Decimal:
    if item.unit == ingredient.default_unit:
        return quantity
    return convert_quantity_from_default_unit(
        quantity,
        ingredient.default_unit,
        ingredient.unit_conversions,
        item.unit,
    )


def _validate_cook_payload(payload: CookRecipeRequest) -> None:
    if payload.servings <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Servings must be greater than 0")
    if payload.rating is not None and (payload.rating < 1 or payload.rating > 5):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Rating must be between 1 and 5")


def _build_cook_inventory_plan(db: Session, *, family_id: str, recipe: Recipe, payload: CookRecipeRequest) -> tuple[list[dict], list[dict]]:
    scale = Decimal(str(payload.servings)) / Decimal(str(recipe.servings or 1))
    today = date.today()
    consumption_plan: list[dict] = []
    shortages: list[dict] = []
    reserved_quantities_by_inventory_item: dict[str, Decimal] = {}

    for ingredient_item in recipe.ingredient_items:
        requested_quantity = Decimal(str(ingredient_item.quantity)) * scale
        if requested_quantity <= 0:
            continue
        if not ingredient_item.ingredient_id:
            shortages.append(
                {
                    "ingredient_id": None,
                    "ingredient_name": ingredient_item.ingredient_name,
                    "required_quantity": float(requested_quantity),
                    "available_quantity": 0,
                    "missing_quantity": float(requested_quantity),
                    "unit": ingredient_item.unit,
                }
            )
            continue

        available_items = _available_inventory_for_ingredient(
            db,
            family_id=family_id,
            ingredient_id=ingredient_item.ingredient_id,
            today=today,
        )
        ingredient = available_items[0].ingredient if available_items else None
        if ingredient is None:
            shortages.append(
                {
                    "ingredient_id": ingredient_item.ingredient_id,
                    "ingredient_name": ingredient_item.ingredient_name,
                    "required_quantity": float(requested_quantity),
                    "available_quantity": 0,
                    "missing_quantity": float(requested_quantity),
                    "unit": ingredient_item.unit,
                }
            )
            continue

        try:
            requested_in_default = convert_quantity_to_default_unit(
                requested_quantity,
                ingredient.default_unit,
                ingredient.unit_conversions,
                ingredient_item.unit,
            )
            available_in_default = sum(
                max(_inventory_remaining_in_default(item, ingredient) - reserved_quantities_by_inventory_item.get(item.id, Decimal("0")), Decimal("0"))
                for item in available_items
            )
        except UnitConversionError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

        if available_in_default < requested_in_default:
            try:
                available_in_requested_unit = convert_quantity_from_default_unit(
                    available_in_default,
                    ingredient.default_unit,
                    ingredient.unit_conversions,
                    ingredient_item.unit,
                )
            except UnitConversionError:
                available_in_requested_unit = available_in_default
            available_quantity = Decimal(str(available_in_requested_unit))
            shortages.append(
                {
                    "ingredient_id": ingredient_item.ingredient_id,
                    "ingredient_name": ingredient_item.ingredient_name,
                    "required_quantity": float(requested_quantity),
                    "available_quantity": float(available_quantity),
                    "missing_quantity": float(max(requested_quantity - available_quantity, Decimal("0"))),
                    "unit": ingredient_item.unit,
                }
            )
            continue

        remaining_to_consume = requested_in_default
        deductions: list[dict] = []
        for item in available_items:
            if remaining_to_consume <= 0:
                break
            remaining_in_default = max(
                _inventory_remaining_in_default(item, ingredient) - reserved_quantities_by_inventory_item.get(item.id, Decimal("0")),
                Decimal("0"),
            )
            deduction_in_default = min(remaining_in_default, remaining_to_consume)
            if deduction_in_default <= 0:
                continue
            deduction_in_item_unit = _convert_default_to_item_unit(deduction_in_default, item, ingredient)
            reserved_quantities_by_inventory_item[item.id] = reserved_quantities_by_inventory_item.get(item.id, Decimal("0")) + deduction_in_default
            deductions.append(
                {
                    "item": item,
                    "quantity": deduction_in_item_unit,
                    "quantity_in_default": deduction_in_default,
                }
            )
            remaining_to_consume -= deduction_in_default

        consumption_plan.append(
            {
                "ingredient": ingredient,
                "ingredient_item": ingredient_item,
                "requested_quantity": requested_quantity,
                "requested_in_default": requested_in_default,
                "deductions": deductions,
            }
        )

    return consumption_plan, shortages


def _serialize_cook_preview_item(plan: dict) -> dict:
    ingredient = plan["ingredient"]
    ingredient_item = plan["ingredient_item"]
    return {
        "ingredient_id": ingredient.id,
        "ingredient_name": ingredient_item.ingredient_name,
        "requested_quantity": float(plan["requested_quantity"]),
        "unit": ingredient_item.unit,
        "batches": [
            {
                "inventory_item_id": deduction["item"].id,
                "quantity": float(deduction["quantity"]),
                "unit": deduction["item"].unit,
                "purchase_date": deduction["item"].purchase_date,
                "expiry_date": deduction["item"].expiry_date,
                "storage_location": deduction["item"].storage_location,
            }
            for deduction in plan["deductions"]
        ],
    }


def _sync_recipe_foods(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    recipe: Recipe,
    recipe_media_ids: list[str],
) -> list[Food]:
    synced_foods = [food for food in recipe.foods if food.type == FoodType.SELF_MADE]
    if not synced_foods:
        return []

    recipe_media = list(db.scalars(select(MediaAsset).where(MediaAsset.family_id == family_id, MediaAsset.id.in_(recipe_media_ids))))
    for food in synced_foods:
        food.name = recipe.title
        food.flavor_tags = recipe.scene_tags
        food.scene = recipe.scene_tags[0] if recipe.scene_tags else "日常"
        food.notes = recipe.tips
        food.updated_by = user_id
        replace_media_assets(db, family_id=family_id, media_ids=[], entity_type="food", entity_id=food.id)
        for asset in recipe_media:
            db.add(
                MediaAsset(
                    id=create_id("photo"),
                    family_id=asset.family_id,
                    name=asset.name,
                    url=asset.url,
                    file_path=asset.file_path,
                    source=asset.source,
                    alt=asset.alt,
                    generation_mode=asset.generation_mode,
                    reference_media_id=asset.reference_media_id,
                    style_key=asset.style_key,
                    prompt_version=asset.prompt_version,
                    entity_type="food",
                    entity_id=food.id,
                    created_by=user_id,
                )
            )
    db.flush()
    return synced_foods


def _recipe_search_text(recipe: Recipe) -> str:
    segments = [
        recipe.title,
        recipe.tips,
        " ".join(recipe.scene_tags or []),
        " ".join(f"{item.ingredient_name} {item.note}" for item in recipe.ingredient_items),
        " ".join(step.text for step in recipe.steps),
    ]
    return " ".join(segments).lower()


def _recipe_availability_summary(db: Session, *, family_id: str, recipe: Recipe) -> dict:
    plan, shortages = _build_cook_inventory_plan(
        db,
        family_id=family_id,
        recipe=recipe,
        payload=CookRecipeRequest(servings=recipe.servings or 1, create_meal_log=False),
    )
    total_count = len(recipe.ingredient_items)
    ready_count = max(total_count - len(shortages), 0)
    availability_score = 0 if total_count == 0 else ready_count / total_count
    if not shortages:
        availability = "ready"
    elif availability_score >= 0.5:
        availability = "partial"
    else:
        availability = "missing"
    return {
        "recipe_id": recipe.id,
        "availability": availability,
        "availability_score": availability_score,
        "ready_count": ready_count,
        "total_count": total_count,
        "shortages": shortages,
        "plan_count": len(plan),
    }


def _recipe_availability(db: Session, *, family_id: str, recipe: Recipe) -> str:
    return _recipe_availability_summary(db, family_id=family_id, recipe=recipe)["availability"]


def _recipe_availability_rank(value: str) -> int:
    return {"ready": 0, "partial": 1, "missing": 2}.get(value, 3)


def _load_recipes_for_family(db: Session, family_id: str) -> list[Recipe]:
    return list(
        db.scalars(
            select(Recipe)
            .where(Recipe.family_id == family_id)
            .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps), selectinload(Recipe.cook_logs))
            .order_by(Recipe.updated_at.desc())
        )
    )


def _recipe_usage_maps(meal_logs: list[MealLog], foods: list[Food]) -> tuple[dict[str, int], dict[str, date]]:
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


def _serialize_discovery_section(recipes: list[Recipe], media_map: dict[tuple[str, str], list[MediaAsset]]) -> dict:
    return {
        "recipe_ids": [recipe.id for recipe in recipes],
        "recipes": [serialize_recipe(recipe, media_map) for recipe in recipes],
    }


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
    recipes = _load_recipes_for_family(db, membership.family_id)

    normalized_q = (q or "").strip().lower()
    normalized_scene = (scene or "").strip()
    normalized_availability = (availability or "").strip()
    if normalized_q:
        recipes = [recipe for recipe in recipes if normalized_q in _recipe_search_text(recipe)]
    if normalized_scene and normalized_scene != "all":
        recipes = [recipe for recipe in recipes if normalized_scene in (recipe.scene_tags or [])]
    if difficulty is not None:
        recipes = [recipe for recipe in recipes if recipe.difficulty == difficulty]

    availability_map: dict[str, str] = {}
    if normalized_availability or sort == "availability":
        availability_map = {
            recipe.id: _recipe_availability(db, family_id=membership.family_id, recipe=recipe)
            for recipe in recipes
        }
    if normalized_availability:
        recipes = [recipe for recipe in recipes if availability_map.get(recipe.id) == normalized_availability]

    if sort == "time":
        recipes.sort(key=lambda recipe: (recipe.prep_minutes, recipe.updated_at), reverse=False)
    elif sort == "difficulty":
        difficulty_weight = {Difficulty.EASY: 0, Difficulty.MEDIUM: 1, Difficulty.HARD: 2}
        recipes.sort(key=lambda recipe: (difficulty_weight.get(recipe.difficulty, 9), recipe.prep_minutes, recipe.updated_at))
    elif sort == "availability":
        recipes.sort(key=lambda recipe: (_recipe_availability_rank(availability_map.get(recipe.id, "missing")), recipe.prep_minutes, recipe.updated_at))
    else:
        recipes.sort(key=lambda recipe: recipe.updated_at, reverse=True)

    if offset:
        recipes = recipes[offset:]
    if limit is not None:
        recipes = recipes[:limit]

    media_map = build_media_map(get_media_assets_for_family(db, membership.family_id))
    return [serialize_recipe(item, media_map) for item in recipes]


@router.get("/api/recipes/discovery", response_model=RecipeDiscoveryOut)
def discover_recipes(
    limit: int = Query(default=6, ge=1, le=20),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    recipes = _load_recipes_for_family(db, membership.family_id)
    foods = list(db.scalars(select(Food).where(Food.family_id == membership.family_id)))
    meal_logs = list(
        db.scalars(
            select(MealLog)
            .where(MealLog.family_id == membership.family_id)
            .options(selectinload(MealLog.food_entries))
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
        )
    )
    usage_counts, _ = _recipe_usage_maps(meal_logs, foods)
    availability_by_recipe_id = {
        recipe.id: _recipe_availability_summary(db, family_id=membership.family_id, recipe=recipe)
        for recipe in recipes
    }

    def score(recipe: Recipe) -> float:
        availability = availability_by_recipe_id[recipe.id]
        return (
            usage_counts.get(recipe.id, 0) * 80
            + availability["availability_score"] * 60
            + (20 if recipe.prep_minutes <= 20 else 0)
            + (8 if recipe.difficulty == Difficulty.EASY else 3 if recipe.difficulty == Difficulty.MEDIUM else 0)
        )

    recommended = sorted(recipes, key=lambda recipe: (score(recipe), recipe.updated_at), reverse=True)[:limit]
    ready = sorted(
        [recipe for recipe in recipes if availability_by_recipe_id[recipe.id]["availability"] == "ready"],
        key=lambda recipe: (recipe.prep_minutes, recipe.updated_at),
    )[:limit]
    quick = sorted(
        [recipe for recipe in recipes if recipe.prep_minutes <= 20],
        key=lambda recipe: (recipe.prep_minutes, recipe.updated_at),
    )[:limit]
    missing = sorted(
        [recipe for recipe in recipes if availability_by_recipe_id[recipe.id]["availability"] != "ready"],
        key=lambda recipe: (availability_by_recipe_id[recipe.id]["availability_score"], recipe.updated_at),
        reverse=True,
    )[:limit]
    media_map = build_media_map(get_media_assets_for_family(db, membership.family_id))
    return {
        "recommended": _serialize_discovery_section(recommended, media_map),
        "ready": _serialize_discovery_section(ready, media_map),
        "quick": _serialize_discovery_section(quick, media_map),
        "missing": _serialize_discovery_section(missing, media_map),
    }


@router.get("/api/recipes/{recipe_id}/availability", response_model=RecipeAvailabilityOut)
def get_recipe_availability(
    recipe_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    summary = _recipe_availability_summary(db, family_id=membership.family_id, recipe=recipe)
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
    foods = list(db.scalars(select(Food).where(Food.family_id == membership.family_id)))
    statement = (
        select(MealLog)
        .where(MealLog.family_id == membership.family_id)
        .options(selectinload(MealLog.food_entries))
        .order_by(MealLog.date.desc(), MealLog.created_at.desc())
    )
    if date_from is not None:
        statement = statement.where(MealLog.date >= date_from)
    if date_to is not None:
        statement = statement.where(MealLog.date <= date_to)
    meal_logs = list(db.scalars(statement))
    counts, last_used_at = _recipe_usage_maps(meal_logs, foods)
    recipes_by_id = {recipe.id: recipe for recipe in _load_recipes_for_family(db, membership.family_id)}

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
        scene_tags=payload.scene_tags,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(recipe)
    db.flush()
    _replace_recipe_children(db, recipe, payload)

    bind_media_assets(db, family_id=membership.family_id, media_ids=payload.media_ids, entity_type="recipe", entity_id=recipe.id)

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"新增菜谱 {recipe.title}",
    )

    if payload.auto_create_food:
        food = Food(
            id=create_id("food"),
            family_id=membership.family_id,
            name=recipe.title,
            type=FoodType.SELF_MADE,
            category="家常菜",
            flavor_tags=payload.scene_tags,
            source_name="家庭厨房",
            scene=payload.scene_tags[0] if payload.scene_tags else "日常",
            notes=payload.tips,
            favorite=False,
            recipe_id=recipe.id,
            created_by=user.id,
            updated_by=user.id,
        )
        db.add(food)
        db.flush()
        log_activity(
            db,
            family_id=membership.family_id,
            actor_id=user.id,
            action=ActivityAction.CREATE,
            entity_type="Food",
            entity_id=food.id,
            summary=f"自动创建自做菜 {food.name}",
        )

    db.commit()
    db.refresh(recipe)
    media_map = build_media_map(get_media_assets_for_family(db, membership.family_id))
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
    recipe.scene_tags = payload.scene_tags
    recipe.updated_by = user.id
    _replace_recipe_children(db, recipe, payload)
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=payload.media_ids,
        entity_type="recipe",
        entity_id=recipe.id,
    )
    synced_foods = _sync_recipe_foods(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        recipe=recipe,
        recipe_media_ids=payload.media_ids,
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
    for food in synced_foods:
        log_activity(
            db,
            family_id=membership.family_id,
            actor_id=user.id,
            action=ActivityAction.UPDATE,
            entity_type="Food",
            entity_id=food.id,
            summary=f"同步更新自做菜 {food.name}",
        )
    db.commit()
    db.refresh(recipe)
    media_map = build_media_map(get_media_assets_for_family(db, membership.family_id))
    return serialize_recipe(recipe, media_map)


@router.delete("/api/recipes/{recipe_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_recipe(
    recipe_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> None:
    user, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    title = recipe.title
    for food in list(recipe.foods):
        food.recipe_id = None
        food.updated_by = user.id
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=[],
        entity_type="recipe",
        entity_id=recipe.id,
    )
    db.delete(recipe)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe_id,
        summary=f"删除菜谱 {title}",
    )
    db.commit()
    return None


@router.post("/api/recipes/{recipe_id}/cook-preview", response_model=CookRecipePreviewResponse)
def preview_cook_recipe(
    recipe_id: str,
    payload: CookRecipeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    _validate_cook_payload(payload)
    consumption_plan, shortages = _build_cook_inventory_plan(db, family_id=membership.family_id, recipe=recipe, payload=payload)
    return {
        "recipe_id": recipe.id,
        "preview_items": [] if shortages else [_serialize_cook_preview_item(plan) for plan in consumption_plan],
        "shortages": shortages,
    }


@router.post("/api/recipes/{recipe_id}/cook", response_model=CookRecipeResponse)
def cook_recipe(
    recipe_id: str,
    payload: CookRecipeRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    _validate_cook_payload(payload)
    consumption_plan, shortages = _build_cook_inventory_plan(db, family_id=membership.family_id, recipe=recipe, payload=payload)

    if shortages:
        return {
            "recipe_id": recipe.id,
            "consumed_items": [],
            "shortages": shortages,
            "meal_log_id": None,
        }

    consumed_items: list[dict] = []
    for plan in consumption_plan:
        ingredient = plan["ingredient"]
        ingredient_item = plan["ingredient_item"]
        affected_item_ids: list[str] = []
        for deduction in plan["deductions"]:
            item = deduction["item"]
            deduction_in_item_unit = deduction["quantity"]
            item.consumed_quantity = item.consumed_quantity + deduction_in_item_unit
            item.updated_by = user.id
            affected_item_ids.append(item.id)

        consumed_items.append(
            {
                "ingredient_id": ingredient.id,
                "ingredient_name": ingredient_item.ingredient_name,
                "requested_quantity": float(plan["requested_quantity"]),
                "unit": ingredient_item.unit,
                "affected_item_ids": affected_item_ids,
            }
        )

    meal_log_id: str | None = None
    if payload.create_meal_log:
        food = db.scalar(select(Food).where(Food.family_id == membership.family_id, Food.recipe_id == recipe.id))
        if food is None:
            food = Food(
                id=create_id("food"),
                family_id=membership.family_id,
                name=recipe.title,
                type=FoodType.SELF_MADE,
                category="家常菜",
                flavor_tags=recipe.scene_tags,
                source_name="家庭厨房",
                scene=recipe.scene_tags[0] if recipe.scene_tags else "日常",
                notes=recipe.tips,
                favorite=False,
                recipe_id=recipe.id,
                created_by=user.id,
                updated_by=user.id,
            )
            db.add(food)
            db.flush()

        meal_log = MealLog(
            id=create_id("meal"),
            family_id=membership.family_id,
            date=payload.date or utcnow().date(),
            meal_type=payload.meal_type or MealType.DINNER,
            participant_user_ids=payload.participant_user_ids,
            notes=payload.notes,
            mood="已做菜谱",
            created_by=user.id,
            updated_by=user.id,
        )
        db.add(meal_log)
        db.flush()
        db.add(
            MealLogFood(
                id=create_id("meal-food"),
                meal_log_id=meal_log.id,
                food_id=food.id,
                servings=Decimal(str(payload.servings)),
                note=f"来自菜谱：{recipe.title}",
            )
        )
        meal_log_id = meal_log.id

    if payload.recipe_plan_item_id:
        plan_item = db.scalar(
            select(RecipePlanItem).where(
                RecipePlanItem.family_id == membership.family_id,
                RecipePlanItem.user_id == user.id,
                RecipePlanItem.id == payload.recipe_plan_item_id,
                RecipePlanItem.recipe_id == recipe.id,
            )
        )
        if plan_item is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe plan item not found")
        plan_item.status = "cooked"
        plan_item.completed_at = utcnow()
        plan_item.meal_log_id = meal_log_id
        plan_item.updated_by = user.id

    cook_log = RecipeCookLog(
        id=create_id("recipe-cook"),
        family_id=membership.family_id,
        recipe_id=recipe.id,
        meal_log_id=meal_log_id,
        cook_date=payload.date or utcnow().date(),
        meal_type=payload.meal_type or MealType.DINNER,
        servings=Decimal(str(payload.servings)),
        result_note=payload.result_note.strip(),
        adjustments=payload.adjustments.strip(),
        rating=payload.rating,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(cook_log)

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"完成菜谱 {recipe.title}，扣减 {len(consumed_items)} 项食材",
    )
    db.commit()

    return {
        "recipe_id": recipe.id,
        "consumed_items": consumed_items,
        "shortages": [],
        "meal_log_id": meal_log_id,
        "cook_log_id": cook_log.id,
    }
