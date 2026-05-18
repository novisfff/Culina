from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.db.session import get_db
from app.models.domain import Food
from app.repos.media import build_media_map, get_media_assets_for_family
from app.schemas.domain import CreateFoodRequest, FoodOut, UpdateFoodFavoriteRequest
from app.services.activity import log_activity
from app.services.media import bind_media_assets
from app.services.serializers import serialize_food

router = APIRouter(tags=["foods"])


@router.get("/api/foods", response_model=list[FoodOut])
def list_foods(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    foods = list(db.scalars(select(Food).where(Food.family_id == membership.family_id).order_by(Food.updated_at.desc())))
    media_map = build_media_map(get_media_assets_for_family(db, membership.family_id))
    return [serialize_food(food, media_map) for food in foods]


@router.post("/api/foods", response_model=FoodOut, status_code=status.HTTP_201_CREATED)
def create_food(
    payload: CreateFoodRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = Food(
        id=create_id("food"),
        family_id=membership.family_id,
        name=payload.name,
        type=payload.type,
        category=payload.category,
        flavor_tags=payload.flavor_tags,
        source_name=payload.source_name,
        scene=payload.scene,
        notes=payload.notes,
        favorite=payload.favorite,
        recipe_id=payload.recipe_id,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(food)
    db.flush()
    bind_media_assets(db, family_id=membership.family_id, media_ids=payload.media_ids, entity_type="food", entity_id=food.id)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"新增{'自做菜' if food.type.value == 'selfMade' else '食物'} {food.name}",
    )
    db.commit()
    media_map = build_media_map(get_media_assets_for_family(db, membership.family_id))
    return serialize_food(food, media_map)


@router.patch("/api/foods/{food_id}/favorite", response_model=FoodOut)
def update_food_favorite(
    food_id: str,
    payload: UpdateFoodFavoriteRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = db.scalar(select(Food).where(Food.id == food_id, Food.family_id == membership.family_id))
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found")
    food.favorite = payload.favorite
    food.updated_by = user.id
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"{food.name}已{'加入' if food.favorite else '移出'}收藏",
    )
    db.commit()
    media_map = build_media_map(get_media_assets_for_family(db, membership.family_id))
    return serialize_food(food, media_map)
