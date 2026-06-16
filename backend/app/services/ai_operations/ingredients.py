from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction
from app.core.utils import create_id
from app.models.domain import Ingredient
from app.schemas.ingredients import CreateIngredientRequest, UpdateIngredientRequest
from app.services.activity import log_activity
from app.services.ingredient_units import UnitConversionError, validate_unit_conversions
from app.services.media import bind_media_assets, replace_media_assets


UpdatedAtValidator = Callable[[datetime | None, str, str], None]


def execute_ingredient_profile_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
) -> Ingredient:
    action = str(payload.get("action") or "create")
    if action == "create":
        ingredient_in = CreateIngredientRequest.model_validate(payload.get("payload") or {})
        try:
            unit_conversions = validate_unit_conversions(
                ingredient_in.default_unit,
                [item.model_dump() for item in ingredient_in.unit_conversions],
            )
        except UnitConversionError as exc:
            raise ValueError(str(exc)) from exc
        ingredient = Ingredient(
            id=create_id("ingredient"),
            family_id=family_id,
            name=ingredient_in.name,
            category=ingredient_in.category,
            default_unit=ingredient_in.default_unit,
            unit_conversions=unit_conversions,
            default_storage=ingredient_in.default_storage,
            default_expiry_mode=ingredient_in.default_expiry_mode,
            default_expiry_days=ingredient_in.default_expiry_days,
            default_low_stock_threshold=ingredient_in.default_low_stock_threshold,
            notes=ingredient_in.notes,
            created_by=user_id,
            updated_by=user_id,
        )
        db.add(ingredient)
        db.flush()
        bind_media_assets(db, family_id=family_id, media_ids=ingredient_in.media_ids, entity_type="ingredient", entity_id=ingredient.id)
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.CREATE,
            entity_type="Ingredient",
            entity_id=ingredient.id,
            summary=f"AI 创建食材 {ingredient.name}",
        )
        return ingredient

    ingredient = db.scalar(
        select(Ingredient)
        .where(Ingredient.family_id == family_id, Ingredient.id == str(payload.get("targetId")))
        .options(selectinload(Ingredient.inventory_items))
        .with_for_update()
    )
    if ingredient is None:
        raise AIConflictError("食材不存在或已被删除")
    assert_updated_at_matches(actual=ingredient.updated_at, expected=str(payload.get("baseUpdatedAt")), label=f"食材 {ingredient.name}")
    ingredient_in = UpdateIngredientRequest.model_validate(payload.get("payload") or {})
    try:
        unit_conversions = validate_unit_conversions(
            ingredient_in.default_unit,
            [item.model_dump() for item in ingredient_in.unit_conversions],
        )
    except UnitConversionError as exc:
        raise ValueError(str(exc)) from exc
    if ingredient_in.default_unit != ingredient.default_unit and ingredient.inventory_items:
        raise ValueError("已有库存记录时暂不支持直接修改主单位，请保留当前主单位或新建食材。")
    ingredient.name = ingredient_in.name
    ingredient.category = ingredient_in.category
    ingredient.default_unit = ingredient_in.default_unit
    ingredient.unit_conversions = unit_conversions
    ingredient.default_storage = ingredient_in.default_storage
    ingredient.default_expiry_mode = ingredient_in.default_expiry_mode
    ingredient.default_expiry_days = ingredient_in.default_expiry_days
    ingredient.default_low_stock_threshold = ingredient_in.default_low_stock_threshold
    ingredient.notes = ingredient_in.notes
    ingredient.updated_by = user_id
    replace_media_assets(db, family_id=family_id, media_ids=ingredient_in.media_ids, entity_type="ingredient", entity_id=ingredient.id)
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Ingredient",
        entity_id=ingredient.id,
        summary=f"AI 更新食材 {ingredient.name}",
    )
    db.flush()
    return ingredient
