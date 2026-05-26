from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.db.session import get_db
from app.models.domain import FoodScene, Recipe, RecipeFavorite, RecipePlanItem
from app.repos.media import build_media_map, get_media_assets_for_family
from app.schemas.domain import (
    CreateRecipePlanItemRequest,
    CreateFoodSceneRequest,
    RecipeFavoriteOut,
    RecipePlanItemOut,
    FoodSceneOut,
    UpdateFoodSceneRequest,
    UpdateRecipePlanItemRequest,
)
from app.services.activity import log_activity
from app.services.media import replace_media_assets
from app.services.serializers import serialize_food_scene, serialize_recipe_favorite, serialize_recipe_plan_item

router = APIRouter(tags=["recipe-meta"])


def _load_recipe(db: Session, *, family_id: str, recipe_id: str) -> Recipe:
    recipe = db.scalar(select(Recipe).where(Recipe.family_id == family_id, Recipe.id == recipe_id))
    if recipe is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe not found")
    return recipe


def _load_plan_item(db: Session, *, family_id: str, user_id: str, item_id: str) -> RecipePlanItem:
    item = db.scalar(
        select(RecipePlanItem)
        .where(
            RecipePlanItem.family_id == family_id,
            RecipePlanItem.user_id == user_id,
            RecipePlanItem.id == item_id,
        )
        .options(selectinload(RecipePlanItem.recipe))
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recipe plan item not found")
    return item


def _load_scene(db: Session, *, family_id: str, scene_id: str) -> FoodScene:
    scene = db.scalar(select(FoodScene).where(FoodScene.family_id == family_id, FoodScene.id == scene_id))
    if scene is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food scene not found")
    return scene


def _scene_media_map(db: Session, family_id: str) -> dict:
    return build_media_map(get_media_assets_for_family(db, family_id))


@router.get("/api/food-scenes", response_model=list[FoodSceneOut])
def list_food_scenes(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    scenes = list(
        db.scalars(
            select(FoodScene)
            .where(FoodScene.family_id == membership.family_id)
            .order_by(FoodScene.sort_order.asc(), FoodScene.created_at.asc())
        )
    )
    media_map = _scene_media_map(db, membership.family_id)
    return [serialize_food_scene(item, media_map) for item in scenes]


@router.post("/api/food-scenes", response_model=FoodSceneOut, status_code=status.HTTP_201_CREATED)
def create_food_scene(
    payload: CreateFoodSceneRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scene name is required")
    existing = db.scalar(select(FoodScene).where(FoodScene.family_id == membership.family_id, FoodScene.name == name))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Food scene already exists")

    scene = FoodScene(
        id=create_id("food-scene"),
        family_id=membership.family_id,
        name=name,
        description=payload.description.strip(),
        image_prompt=payload.image_prompt.strip(),
        hidden=payload.hidden,
        custom=payload.custom,
        sort_order=payload.sort_order,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(scene)
    db.flush()
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=[payload.image_asset_id] if payload.image_asset_id else [],
        entity_type="food_scene",
        entity_id=scene.id,
    )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="FoodScene",
        entity_id=scene.id,
        summary=f"新增食物场景 {scene.name}",
    )
    db.commit()
    db.refresh(scene)
    return serialize_food_scene(scene, _scene_media_map(db, membership.family_id))


@router.patch("/api/food-scenes/{scene_id}", response_model=FoodSceneOut)
def update_food_scene(
    scene_id: str,
    payload: UpdateFoodSceneRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    scene = _load_scene(db, family_id=membership.family_id, scene_id=scene_id)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Scene name is required")
        duplicate = db.scalar(
            select(FoodScene).where(
                FoodScene.family_id == membership.family_id,
                FoodScene.name == name,
                FoodScene.id != scene.id,
            )
        )
        if duplicate is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Food scene already exists")
        scene.name = name
    if payload.description is not None:
        scene.description = payload.description.strip()
    if payload.image_prompt is not None:
        scene.image_prompt = payload.image_prompt.strip()
    if payload.hidden is not None:
        scene.hidden = payload.hidden
    if payload.custom is not None:
        scene.custom = payload.custom
    if payload.sort_order is not None:
        scene.sort_order = payload.sort_order
    scene.updated_by = user.id
    if payload.image_asset_id is not None:
        replace_media_assets(
            db,
            family_id=membership.family_id,
            media_ids=[payload.image_asset_id] if payload.image_asset_id else [],
            entity_type="food_scene",
            entity_id=scene.id,
        )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="FoodScene",
        entity_id=scene.id,
        summary=f"更新食物场景 {scene.name}",
    )
    db.commit()
    db.refresh(scene)
    return serialize_food_scene(scene, _scene_media_map(db, membership.family_id))


@router.delete("/api/food-scenes/{scene_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_food_scene(
    scene_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> None:
    user, membership = auth
    scene = _load_scene(db, family_id=membership.family_id, scene_id=scene_id)
    title = scene.name
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=[],
        entity_type="food_scene",
        entity_id=scene.id,
    )
    db.delete(scene)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="FoodScene",
        entity_id=scene_id,
        summary=f"删除食物场景 {title}",
    )
    db.commit()
    return None


@router.get("/api/recipe-favorites", response_model=list[RecipeFavoriteOut])
def list_recipe_favorites(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    user, membership = auth
    items = list(
        db.scalars(
            select(RecipeFavorite)
            .where(RecipeFavorite.family_id == membership.family_id, RecipeFavorite.user_id == user.id)
            .order_by(RecipeFavorite.created_at.desc())
        )
    )
    return [serialize_recipe_favorite(item) for item in items]


@router.put("/api/recipe-favorites/{recipe_id}", response_model=RecipeFavoriteOut)
def add_recipe_favorite(
    recipe_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=recipe_id)
    existing = db.scalar(
        select(RecipeFavorite).where(
            RecipeFavorite.family_id == membership.family_id,
            RecipeFavorite.user_id == user.id,
            RecipeFavorite.recipe_id == recipe_id,
        )
    )
    if existing is not None:
        return serialize_recipe_favorite(existing)

    favorite = RecipeFavorite(
        id=create_id("recipe-favorite"),
        family_id=membership.family_id,
        user_id=user.id,
        recipe_id=recipe_id,
    )
    db.add(favorite)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Recipe",
        entity_id=recipe.id,
        summary=f"收藏菜谱 {recipe.title}",
    )
    db.commit()
    db.refresh(favorite)
    return serialize_recipe_favorite(favorite)


@router.delete("/api/recipe-favorites/{recipe_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def remove_recipe_favorite(
    recipe_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> None:
    user, membership = auth
    favorite = db.scalar(
        select(RecipeFavorite).where(
            RecipeFavorite.family_id == membership.family_id,
            RecipeFavorite.user_id == user.id,
            RecipeFavorite.recipe_id == recipe_id,
        )
    )
    if favorite is not None:
        db.delete(favorite)
        log_activity(
            db,
            family_id=membership.family_id,
            actor_id=user.id,
            action=ActivityAction.UPDATE,
            entity_type="Recipe",
            entity_id=recipe_id,
            summary="取消收藏菜谱",
        )
        db.commit()
    return None


@router.get("/api/recipe-plan", response_model=list[RecipePlanItemOut])
def list_recipe_plan(
    date_from: date = Query(...),
    date_to: date = Query(...),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    user, membership = auth
    items = list(
        db.scalars(
            select(RecipePlanItem)
            .where(
                RecipePlanItem.family_id == membership.family_id,
                RecipePlanItem.user_id == user.id,
                RecipePlanItem.plan_date >= date_from,
                RecipePlanItem.plan_date <= date_to,
            )
            .options(selectinload(RecipePlanItem.recipe))
            .order_by(RecipePlanItem.plan_date.asc(), RecipePlanItem.meal_type.asc(), RecipePlanItem.created_at.asc())
        )
    )
    return [serialize_recipe_plan_item(item) for item in items]


@router.post("/api/recipe-plan", response_model=RecipePlanItemOut, status_code=status.HTTP_201_CREATED)
def create_recipe_plan_item(
    payload: CreateRecipePlanItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=payload.recipe_id)
    item = RecipePlanItem(
        id=create_id("recipe-plan"),
        family_id=membership.family_id,
        user_id=user.id,
        recipe_id=payload.recipe_id,
        plan_date=payload.plan_date,
        meal_type=payload.meal_type,
        note=payload.note,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(item)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="RecipePlanItem",
        entity_id=item.id,
        summary=f"加入菜单计划 {recipe.title}",
    )
    db.commit()
    db.refresh(item)
    item.recipe = recipe
    return serialize_recipe_plan_item(item)


@router.patch("/api/recipe-plan/{item_id}", response_model=RecipePlanItemOut)
def update_recipe_plan_item(
    item_id: str,
    payload: UpdateRecipePlanItemRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    item = _load_plan_item(db, family_id=membership.family_id, user_id=user.id, item_id=item_id)
    if payload.recipe_id is not None:
        item.recipe = _load_recipe(db, family_id=membership.family_id, recipe_id=payload.recipe_id)
        item.recipe_id = payload.recipe_id
    if payload.plan_date is not None:
        item.plan_date = payload.plan_date
    if payload.meal_type is not None:
        item.meal_type = payload.meal_type
    if payload.note is not None:
        item.note = payload.note
    if payload.status is not None:
        if payload.status not in {"planned", "cooked", "skipped"}:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid plan status")
        item.status = payload.status
        if payload.status != "cooked":
            item.completed_at = None
            item.meal_log_id = None
    item.updated_by = user.id
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="RecipePlanItem",
        entity_id=item.id,
        summary=f"更新菜单计划 {item.recipe.title if item.recipe else '菜谱'}",
    )
    db.commit()
    db.refresh(item)
    return serialize_recipe_plan_item(item)


@router.delete("/api/recipe-plan/{item_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
def delete_recipe_plan_item(
    item_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> None:
    user, membership = auth
    item = _load_plan_item(db, family_id=membership.family_id, user_id=user.id, item_id=item_id)
    db.delete(item)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="RecipePlanItem",
        entity_id=item.id,
        summary=f"移除菜单计划 {item.recipe.title if item.recipe else '菜谱'}",
    )
    db.commit()
    return None
