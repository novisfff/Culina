from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.core.enums import ActivityAction, FoodType
from app.core.utils import create_id
from app.models.domain import Food
from app.schemas.foods import CreateFoodRequest, UpdateFoodRequest
from app.services.activity import log_activity
from app.services.ai_operations.image_jobs import build_food_image_request, enqueue_ai_entity_image_generation
from app.services.media import bind_media_assets, replace_media_assets
from app.services.search.jobs import enqueue_search_index_job


UpdatedAtValidator = Callable[[datetime | None, str, str], None]
READY_LIKE_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}


def execute_food_profile_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
) -> Food:
    if payload.get("action") not in {"update", "set_favorite"}:
        effective_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
        return _create_food_from_profile(db, family_id=family_id, user_id=user_id, payload=effective_payload)

    food = db.scalar(
        select(Food).where(Food.family_id == family_id, Food.id == str(payload.get("targetId"))).with_for_update()
    )
    if food is None:
        raise AIConflictError("食物不存在或已被删除")
    assert_updated_at_matches(actual=food.updated_at, expected=str(payload.get("baseUpdatedAt")), label=f"食物 {food.name}")
    action = str(payload.get("action") or "")
    if action == "set_favorite":
        food.favorite = bool((payload.get("payload") or {}).get("favorite"))
        food.updated_by = user_id
        log_activity(
            db,
            family_id=family_id,
            actor_id=user_id,
            action=ActivityAction.UPDATE,
            entity_type="Food",
            entity_id=food.id,
            summary=f"{food.name}已{'加入' if food.favorite else '移出'}收藏",
        )
        db.flush()
        enqueue_search_index_job(db, family_id=family_id, user_id=user_id, entity_type="food", entity_id=food.id, target_name=food.name)
        return food

    update_payload = payload.get("payload") or {}
    food_in = UpdateFoodRequest.model_validate(update_payload)
    if food.recipe_id:
        food.flavor_tags = list(food_in.flavor_tags)
        food.scene_tags = list(dict.fromkeys([*food_in.scene_tags, *(food_in.scene.split("、") if food_in.scene else []), *food_in.flavor_tags]))
        food.suitable_meal_types = [item.value if hasattr(item, "value") else str(item) for item in food_in.suitable_meal_types]
        food.scene = food_in.scene
        food.notes = food_in.notes
        food.routine_note = food_in.routine_note
        food.favorite = food_in.favorite
    else:
        food.name = food_in.name
        food.type = food_in.type.value if hasattr(food_in.type, "value") else str(food_in.type)
        food.category = food_in.category
        food.flavor_tags = list(food_in.flavor_tags)
        food.scene_tags = list(dict.fromkeys([*food_in.scene_tags, *(food_in.scene.split("、") if food_in.scene else []), *food_in.flavor_tags]))
        food.suitable_meal_types = [item.value if hasattr(item, "value") else str(item) for item in food_in.suitable_meal_types]
        food.source_name = food_in.source_name
        food.purchase_source = food_in.purchase_source
        food.scene = food_in.scene
        food.notes = food_in.notes
        food.routine_note = food_in.routine_note
        food.price = Decimal(str(food_in.price)) if food_in.price is not None else None
        food.rating = food_in.rating
        food.repurchase = food_in.repurchase
        food.expiry_date = food_in.expiry_date
        food.stock_quantity = Decimal(str(food_in.stock_quantity)) if food_in.stock_quantity is not None else None
        food.stock_unit = food_in.stock_unit
        next_type = food_in.type.value if hasattr(food_in.type, "value") else str(food_in.type)
        if not (next_type in READY_LIKE_TYPES and not food_in.storage_location and food.storage_location):
            food.storage_location = food_in.storage_location
        food.favorite = food_in.favorite
    food.updated_by = user_id
    if not food.recipe_id:
        food.recipe_id = food_in.recipe_id
    replace_media_assets(db, family_id=family_id, media_ids=food_in.media_ids, entity_type="food", entity_id=food.id)
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.UPDATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"AI 更新食物资料 {food.name}",
    )
    db.flush()
    enqueue_search_index_job(db, family_id=family_id, user_id=user_id, entity_type="food", entity_id=food.id, target_name=food.name)
    return food


def _create_food_from_profile(db: Session, *, family_id: str, user_id: str, payload: dict[str, Any]) -> Food:
    food_in = CreateFoodRequest.model_validate(payload)
    food = Food(
        id=create_id("food"),
        family_id=family_id,
        name=food_in.name,
        type=food_in.type,
        category=food_in.category,
        flavor_tags=list(food_in.flavor_tags),
        scene_tags=list(food_in.scene_tags),
        suitable_meal_types=[item.value if hasattr(item, "value") else str(item) for item in food_in.suitable_meal_types],
        source_name=food_in.source_name,
        purchase_source=food_in.purchase_source,
        scene=food_in.scene,
        notes=food_in.notes,
        routine_note=food_in.routine_note,
        price=Decimal(str(food_in.price)) if food_in.price is not None else None,
        rating=food_in.rating,
        repurchase=food_in.repurchase,
        expiry_date=food_in.expiry_date,
        stock_quantity=Decimal(str(food_in.stock_quantity)) if food_in.stock_quantity is not None else None,
        stock_unit=food_in.stock_unit,
        storage_location=food_in.storage_location,
        favorite=food_in.favorite,
        recipe_id=food_in.recipe_id,
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(food)
    db.flush()
    bind_media_assets(db, family_id=family_id, media_ids=food_in.media_ids, entity_type="food", entity_id=food.id)
    if food_in.pending_image_job_id:
        attach_image_generation_job_to_entity(
            db,
            family_id=family_id,
            job_id=food_in.pending_image_job_id,
            entity_type="food",
            entity_id=food.id,
        )
    else:
        enqueue_ai_entity_image_generation(
            db,
            family_id=family_id,
            user_id=user_id,
            request=build_food_image_request(food_in.model_dump(mode="json")),
            media_ids=food_in.media_ids,
            target_entity_type="food",
            target_entity_id=food.id,
        )
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.CREATE,
        entity_type="Food",
        entity_id=food.id,
        summary=f"AI 创建食物资料 {food.name}",
    )
    enqueue_search_index_job(db, family_id=family_id, user_id=user_id, entity_type="food", entity_id=food.id, target_name=food.name)
    return food
