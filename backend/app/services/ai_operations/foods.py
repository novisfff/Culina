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
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.foods import CreateFoodRequest, UpdateFoodRequest
from app.services.activity import log_activity
from app.services.ai_auto_execution.policy_types import ConcurrencyStrategy, DraftExecutionReceipt
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.ai_operations.image_jobs import build_food_image_request, enqueue_ai_entity_image_generation
from app.services.ai_operations.registry_types import DraftExecuteContext
from app.services.food_stock_quantity import normalize_food_stock_quantity, validate_food_stock_quantity_precision
from app.services.media import bind_media_assets, replace_media_assets
from app.services.search.jobs import enqueue_search_index_job
from app.services.serializers import serialize_food


UpdatedAtValidator = Callable[[datetime | None, str, str], None]
READY_LIKE_TYPES = {FoodType.READY_MADE.value, FoodType.INSTANT.value, FoodType.PACKAGED.value}
_FAVORITE_FIELDS = {
    "draftType",
    "schemaVersion",
    "action",
    "targetId",
    "baseUpdatedAt",
    "before",
    "payload",
}


def _resolve_food_stock_quantity(value: float | None) -> Decimal | None:
    if value is None:
        return None
    quantity = Decimal(str(value))
    validate_food_stock_quantity_precision(quantity, field_label="剩余数量")
    return normalize_food_stock_quantity(quantity)


def execute_food_profile_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
    concurrency_strategy: ConcurrencyStrategy = "entity_version",
    revert_capture: dict[str, Any] | None = None,
) -> Food:
    if payload.get("action") not in {"update", "set_favorite"}:
        effective_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
        return _create_food_from_profile(db, family_id=family_id, user_id=user_id, payload=effective_payload)

    try:
        food = lock_inventory_targets(
            db,
            family_id=family_id,
            food_ids=[str(payload.get("targetId"))],
        ).foods[str(payload.get("targetId"))]
    except (InventoryTargetNotFoundError, KeyError):
        raise AIConflictError("食物不存在或已被删除")
    action = str(payload.get("action") or "")
    relaxed_concurrency = action == "set_favorite" and concurrency_strategy == "idempotent_set"
    if not relaxed_concurrency:
        assert_updated_at_matches(actual=food.updated_at, expected=str(payload.get("baseUpdatedAt")), label=f"食物 {food.name}")
    if action == "set_favorite":
        before_favorite = bool(food.favorite)
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
        if revert_capture is not None and before_favorite is not bool(food.favorite):
            revert_capture.update(
                {
                    "schema_version": 1,
                    "food_id": food.id,
                    "before_favorite": before_favorite,
                    "after_favorite": bool(food.favorite),
                    "after_row_version": int(food.row_version),
                }
            )
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
        food.stock_quantity = _resolve_food_stock_quantity(food_in.stock_quantity)
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


def execute_food_profile_draft_receipt(context: DraftExecuteContext) -> DraftExecutionReceipt:
    revert_context: dict[str, Any] = {}
    food = execute_food_profile_draft(
        context.db,
        family_id=context.family_id,
        user_id=context.user_id,
        payload=context.payload,
        assert_updated_at_matches=context.assert_updated_at_matches,
        concurrency_strategy=context.concurrency_strategy,
        revert_capture=revert_context,
    )
    media_map = build_media_map(
        get_media_assets_for_entities(
            context.db,
            family_id=context.family_id,
            entity_type="food",
            entity_ids=[food.id],
        )
    )
    favorite_payload = context.payload.get("payload")
    eligible = (
        set(context.payload) == _FAVORITE_FIELDS
        and context.payload.get("draftType") == "food_profile"
        and context.payload.get("schemaVersion") == "food_profile_operation.v1"
        and context.payload.get("action") == "set_favorite"
        and isinstance(context.payload.get("before"), dict)
        and isinstance(favorite_payload, dict)
        and set(favorite_payload) == {"favorite"}
        and type(favorite_payload.get("favorite")) is bool
        and bool(revert_context)
    )
    return DraftExecutionReceipt(
        business_entity=serialize_food(food, media_map),
        entity_ids=(food.id,),
        cache_scopes=("food", "ai_conversation"),
        revert_adapter_key="food.favorite.v1" if eligible else None,
        revert_context=revert_context if eligible else None,
    )


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
        stock_quantity=_resolve_food_stock_quantity(food_in.stock_quantity),
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
