from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import Ingredient
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.ingredients import CreateIngredientRequest, IngredientOut, UpdateIngredientRequest
from app.services.activity import log_activity
from app.services.ingredient_units import UnitConversionError, validate_unit_conversions
from app.services.media import bind_media_assets, replace_media_assets
from app.services.serializers import serialize_ingredient

router = APIRouter(tags=["ingredients"])


@router.get("/api/ingredients", response_model=list[IngredientOut])
def list_ingredients(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    ingredients = list(
        db.scalars(select(Ingredient).where(Ingredient.family_id == membership.family_id).order_by(Ingredient.updated_at.desc()))
    )
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="ingredient", entity_ids=[item.id for item in ingredients]))
    return [serialize_ingredient(item, media_map) for item in ingredients]


@router.post("/api/ingredients", response_model=IngredientOut, status_code=status.HTTP_201_CREATED)
def create_ingredient(
    payload: CreateIngredientRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        unit_conversions = validate_unit_conversions(
            payload.default_unit,
            [item.model_dump() for item in payload.unit_conversions],
        )
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    ingredient = Ingredient(
        id=create_id("ingredient"),
        family_id=membership.family_id,
        name=payload.name,
        category=payload.category,
        default_unit=payload.default_unit,
        unit_conversions=unit_conversions,
        default_storage=payload.default_storage,
        default_expiry_mode=payload.default_expiry_mode,
        default_expiry_days=payload.default_expiry_days,
        default_low_stock_threshold=payload.default_low_stock_threshold,
        notes=payload.notes,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(ingredient)
    db.flush()
    bind_media_assets(db, family_id=membership.family_id, media_ids=payload.media_ids, entity_type="ingredient", entity_id=ingredient.id)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"新增食材 {ingredient.name}",
    )
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="ingredient", entity_ids=[ingredient.id]))
    return serialize_ingredient(ingredient, media_map)


@router.patch("/api/ingredients/{ingredient_id}", response_model=IngredientOut)
def update_ingredient(
    ingredient_id: str,
    payload: UpdateIngredientRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    ingredient = db.scalar(
        select(Ingredient)
        .where(Ingredient.family_id == membership.family_id, Ingredient.id == ingredient_id)
        .options(selectinload(Ingredient.inventory_items))
    )
    if ingredient is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ingredient not found")
    try:
        unit_conversions = validate_unit_conversions(
            payload.default_unit,
            [item.model_dump() for item in payload.unit_conversions],
        )
    except UnitConversionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if payload.default_unit != ingredient.default_unit and ingredient.inventory_items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="已有库存记录时暂不支持直接修改主单位，请保留当前主单位或新建食材。",
        )

    ingredient.name = payload.name
    ingredient.category = payload.category
    ingredient.default_unit = payload.default_unit
    ingredient.unit_conversions = unit_conversions
    ingredient.default_storage = payload.default_storage
    ingredient.default_expiry_mode = payload.default_expiry_mode
    ingredient.default_expiry_days = payload.default_expiry_days
    ingredient.default_low_stock_threshold = payload.default_low_stock_threshold
    ingredient.notes = payload.notes
    ingredient.updated_by = user.id
    replace_media_assets(
        db,
        family_id=membership.family_id,
        media_ids=payload.media_ids,
        entity_type="ingredient",
        entity_id=ingredient.id,
    )
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"更新食材 {ingredient.name}",
    )
    commit_session(db)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="ingredient", entity_ids=[ingredient.id]))
    return serialize_ingredient(ingredient, media_map)
