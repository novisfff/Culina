from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction
from app.core.utils import create_id, utcnow
from app.models.domain import Food, FoodPlanItem, MealLog, MealLogFood
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.meal_logs import CreateMealLogRequest, UpdateMealLogRequest
from app.services.activity import log_activity
from app.services.media import bind_media_assets, replace_media_assets
from app.services.serializers import serialize_meal_log


UpdatedAtValidator = Callable[[datetime | None, str, str], None]


def execute_meal_log_draft(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    payload: dict[str, Any],
    assert_updated_at_matches: UpdatedAtValidator,
) -> tuple[dict[str, Any], list[str]]:
    action = str(payload.get("action") or "")
    if action in {"update_details", "rate_food"}:
        meal_log = db.scalar(
            select(MealLog)
            .where(MealLog.family_id == family_id, MealLog.id == str(payload.get("targetId")))
            .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food), selectinload(MealLog.deduction_suggestions))
            .with_for_update()
        )
        if meal_log is None:
            raise AIConflictError("餐食记录不存在或已被删除")
        assert_updated_at_matches(actual=meal_log.updated_at, expected=str(payload.get("baseUpdatedAt")), label="餐食记录")
        if action == "update_details":
            update = UpdateMealLogRequest.model_validate(
                {
                    "participant_user_ids": (payload.get("payload") or {}).get("participantUserIds"),
                    "notes": (payload.get("payload") or {}).get("notes"),
                    "mood": (payload.get("payload") or {}).get("mood"),
                    "media_ids": (payload.get("payload") or {}).get("mediaIds"),
                }
            )
            meal_log.participant_user_ids = list(update.participant_user_ids or [])
            meal_log.notes = update.notes or ""
            meal_log.mood = update.mood or ""
            meal_log.updated_by = user_id
            replace_media_assets(
                db,
                family_id=family_id,
                media_ids=list(update.media_ids or []),
                entity_type="meal_log",
                entity_id=meal_log.id,
            )
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="MealLog",
                entity_id=meal_log.id,
                summary="AI 补充餐食记录详情",
            )
        else:
            ratings = UpdateMealLogRequest.model_validate(
                {"food_entry_ratings": (payload.get("payload") or {}).get("foodEntryRatings") or []}
            ).food_entry_ratings or []
            entries_by_id = {entry.id: entry for entry in meal_log.food_entries}
            for item in ratings:
                entry = entries_by_id.get(item.id)
                if entry is None:
                    raise ValueError("评分草稿引用了不属于该餐食记录的食物项")
                entry.rating = Decimal(str(item.rating)) if item.rating is not None else None
            meal_log.updated_by = user_id
            log_activity(
                db,
                family_id=family_id,
                actor_id=user_id,
                action=ActivityAction.UPDATE,
                entity_type="MealLog",
                entity_id=meal_log.id,
                summary="AI 更新餐食记录评分",
            )
        db.flush()
        refreshed = db.scalar(
            select(MealLog)
            .where(MealLog.id == meal_log.id)
            .options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food), selectinload(MealLog.deduction_suggestions))
        )
        assert refreshed is not None
        media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="meal_log", entity_ids=[refreshed.id]))
        return serialize_meal_log(refreshed, media_map), [refreshed.id]

    effective_payload = payload.get("payload") if action == "create" and isinstance(payload.get("payload"), dict) else payload
    food_entries = []
    for item in effective_payload.get("foods") or []:
        food_id = item.get("foodId")
        if not food_id:
            raise ValueError("餐食记录草稿必须引用食物库里的食物")
        food = db.scalar(select(Food).where(Food.id == food_id, Food.family_id == family_id))
        if food is None:
            raise ValueError("草稿包含不属于当前家庭的食物")
        food_entries.append((food, item))
    request = CreateMealLogRequest.model_validate(
        {
            "date": effective_payload["date"],
            "meal_type": effective_payload["mealType"],
            "food_entries": [
                {"food_id": food.id, "servings": item.get("servings") or 1, "note": item.get("note") or "", "rating": item.get("rating")}
                for food, item in food_entries
            ],
            "participant_user_ids": effective_payload.get("participantUserIds") or [user_id],
            "notes": effective_payload.get("notes") or "",
            "mood": effective_payload.get("mood") or "",
            "media_ids": effective_payload.get("mediaIds") or [],
        }
    )
    meal_log = MealLog(
        id=create_id("meal"),
        family_id=family_id,
        date=request.date,
        meal_type=request.meal_type,
        participant_user_ids=request.participant_user_ids,
        notes=request.notes,
        mood=request.mood,
        created_by=user_id,
        updated_by=user_id,
    )
    db.add(meal_log)
    db.flush()
    for entry_payload in request.food_entries:
        db.add(
            MealLogFood(
                id=create_id("meal-food"),
                meal_log_id=meal_log.id,
                food_id=entry_payload.food_id,
                servings=Decimal(str(entry_payload.servings)),
                note=entry_payload.note,
                rating=Decimal(str(entry_payload.rating)) if entry_payload.rating is not None else None,
            )
        )
    db.flush()
    if request.media_ids:
        bind_media_assets(
            db,
            family_id=family_id,
            media_ids=list(request.media_ids),
            entity_type="meal_log",
            entity_id=meal_log.id,
        )
    plan_item_id = effective_payload.get("planItemId")
    if plan_item_id:
        plan_item = db.scalar(
            select(FoodPlanItem)
            .where(
                FoodPlanItem.family_id == family_id,
                FoodPlanItem.user_id == user_id,
                FoodPlanItem.id == str(plan_item_id),
            )
            .with_for_update()
        )
        if plan_item is None:
            raise AIConflictError("关联计划项不存在或已被删除")
        expected = effective_payload.get("planItemBaseUpdatedAt")
        if expected:
            assert_updated_at_matches(actual=plan_item.updated_at, expected=str(expected), label="关联餐食计划")
        plan_item.status = "cooked"
        plan_item.completed_at = utcnow()
        plan_item.meal_log_id = meal_log.id
        plan_item.updated_by = user_id
    log_activity(
        db,
        family_id=family_id,
        actor_id=user_id,
        action=ActivityAction.CREATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary="AI 创建餐食记录",
    )
    meal_log = db.scalar(select(MealLog).where(MealLog.id == meal_log.id).options(selectinload(MealLog.food_entries).selectinload(MealLogFood.food)))
    assert meal_log is not None
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=family_id, entity_type="meal_log", entity_ids=[meal_log.id]))
    return serialize_meal_log(meal_log, media_map), [meal_log.id]
