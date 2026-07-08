from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction
from app.core.utils import create_id, utcnow
from app.db.session import get_db
from app.db.transactions import commit_session
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.models.domain import Food, FoodPlanItem, InventoryDeductionSuggestion, MealLog, MealLogFood, Recipe
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.meal_logs import CreateMealLogRequest, MealLogOut, QuickAddMealLogRequest, UpdateMealLogRequest
from app.services.activity import log_activity
from app.services.clock import today_for_family
from app.services.food_stock import apply_food_stock_consume
from app.services.media import bind_media_assets, replace_media_assets
from app.services.search.jobs import enqueue_search_index_job
from app.services.serializers import serialize_meal_log

router = APIRouter(tags=["meal-logs"])

MEAL_TYPE_LABELS = {
    "breakfast": "早餐",
    "lunch": "午餐",
    "dinner": "晚餐",
    "snack": "加餐/夜宵",
}


def _select_food_for_quick_add(*, food_id: str, family_id: str, deduct_food_stock: bool):
    statement = select(Food).where(Food.id == food_id, Food.family_id == family_id)
    if deduct_food_stock:
        statement = statement.with_for_update()
    return statement


def _build_deduction_suggestions(db: Session, food_entries: list[MealLogFood]) -> list[InventoryDeductionSuggestion]:
    suggestions: list[InventoryDeductionSuggestion] = []
    food_ids = [entry.food_id for entry in food_entries]
    foods = list(
        db.scalars(
            select(Food)
            .where(Food.id.in_(food_ids))
            .options(selectinload(Food.recipe).selectinload(Recipe.ingredient_items))
        )
    )
    food_map = {food.id: food for food in foods}
    for entry in food_entries:
        food = food_map.get(entry.food_id)
        if not food or not food.recipe:
            continue
        for ingredient in food.recipe.ingredient_items:
            suggestions.append(
                InventoryDeductionSuggestion(
                    id=create_id("suggestion"),
                    ingredient_name=ingredient.ingredient_name,
                    suggested_amount=Decimal(str(ingredient.quantity)) * Decimal(str(entry.servings)),
                    unit=ingredient.unit,
                    based_on_food_name=food.name,
                )
            )
    return suggestions


@router.get("/api/meal-logs", response_model=list[MealLogOut])
def list_meal_logs(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    logs = list(
        db.scalars(
            select(MealLog)
            .where(MealLog.family_id == membership.family_id)
            .options(
                selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
                selectinload(MealLog.deduction_suggestions),
            )
            .order_by(MealLog.date.desc(), MealLog.created_at.desc())
        )
    )
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="meal_log", entity_ids=[item.id for item in logs]))
    return [serialize_meal_log(item, media_map) for item in logs]


@router.post("/api/meal-logs", response_model=MealLogOut, status_code=status.HTTP_201_CREATED)
def create_meal_log(
    payload: CreateMealLogRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    meal_log = MealLog(
        id=create_id("meal"),
        family_id=membership.family_id,
        date=payload.date,
        meal_type=payload.meal_type,
        participant_user_ids=payload.participant_user_ids,
        notes=payload.notes,
        mood=payload.mood,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(meal_log)
    db.flush()

    entries: list[MealLogFood] = []
    for item in payload.food_entries:
        entry = MealLogFood(
            id=create_id("meal-food"),
            meal_log_id=meal_log.id,
            food_id=item.food_id,
            servings=item.servings,
            note=item.note,
            rating=item.rating,
        )
        entries.append(entry)
        db.add(entry)
    db.flush()

    for suggestion in _build_deduction_suggestions(db, entries):
        suggestion.meal_log_id = meal_log.id
        db.add(suggestion)

    bind_media_assets(db, family_id=membership.family_id, media_ids=payload.media_ids, entity_type="meal_log", entity_id=meal_log.id)
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="meal_log",
                entity_id=meal_log.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary=f"记录了{'今天' if payload.date == today_for_family(membership.family_id) else payload.date.isoformat()}的{MEAL_TYPE_LABELS.get(payload.meal_type.value, payload.meal_type.value)}",
    )
    commit_session(db)
    db.refresh(meal_log)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="meal_log", entity_ids=[meal_log.id]))
    return serialize_meal_log(meal_log, media_map)


@router.patch("/api/meal-logs/{meal_log_id}", response_model=MealLogOut)
def update_meal_log(
    meal_log_id: str,
    payload: UpdateMealLogRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    meal_log = db.scalar(
        select(MealLog)
        .where(MealLog.id == meal_log_id, MealLog.family_id == membership.family_id)
        .options(
            selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
            selectinload(MealLog.deduction_suggestions),
        )
    )
    if meal_log is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal log not found")

    if payload.participant_user_ids is not None:
        meal_log.participant_user_ids = payload.participant_user_ids
    if payload.notes is not None:
        meal_log.notes = payload.notes
    if payload.mood is not None:
        meal_log.mood = payload.mood
    if payload.food_entry_ratings is not None:
        entries_by_id = {entry.id: entry for entry in meal_log.food_entries}
        for item in payload.food_entry_ratings:
            entry = entries_by_id.get(item.id)
            if entry is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Meal food entry not found")
            entry.rating = item.rating
    meal_log.updated_by = user.id

    if payload.media_ids is not None:
        replace_media_assets(
            db,
            family_id=membership.family_id,
            media_ids=payload.media_ids,
            entity_type="meal_log",
            entity_id=meal_log.id,
        )
    if payload.pending_image_job_id:
        try:
            attach_image_generation_job_to_entity(
                db,
                family_id=membership.family_id,
                job_id=payload.pending_image_job_id,
                entity_type="meal_log",
                entity_id=meal_log.id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary=f"补充了{MEAL_TYPE_LABELS.get(meal_log.meal_type.value, meal_log.meal_type.value)}记录",
    )
    commit_session(db)
    db.refresh(meal_log)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="meal_log", entity_ids=[meal_log.id]))
    return serialize_meal_log(meal_log, media_map)


@router.post("/api/meal-logs/quick-add", response_model=MealLogOut, status_code=status.HTTP_201_CREATED)
def quick_add_meal_log(
    payload: QuickAddMealLogRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    food = db.scalar(
        _select_food_for_quick_add(
            food_id=payload.food_id,
            family_id=membership.family_id,
            deduct_food_stock=payload.deduct_food_stock,
        )
    )
    if food is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food not found")

    plan_item: FoodPlanItem | None = None
    if payload.food_plan_item_id:
        plan_item = db.scalar(
            select(FoodPlanItem).where(
                FoodPlanItem.family_id == membership.family_id,
                FoodPlanItem.user_id == user.id,
                FoodPlanItem.id == payload.food_plan_item_id,
                FoodPlanItem.food_id == food.id,
            )
        )
        if plan_item is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food plan item not found")

    meal_log = None
    if plan_item is not None and plan_item.meal_log_id:
        meal_log = db.scalar(
            select(MealLog)
            .where(MealLog.id == plan_item.meal_log_id, MealLog.family_id == membership.family_id)
            .options(
                selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
                selectinload(MealLog.deduction_suggestions),
            )
        )

    if meal_log is None and plan_item is None:
        meal_log = db.scalar(
            select(MealLog)
            .where(
                MealLog.family_id == membership.family_id,
                MealLog.date == payload.date,
                MealLog.meal_type == payload.meal_type,
            )
            .options(
                selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
                selectinload(MealLog.deduction_suggestions),
            )
            .order_by(MealLog.created_at.desc())
        )

    created = meal_log is None
    if meal_log is None:
        meal_log = MealLog(
            id=create_id("meal"),
            family_id=membership.family_id,
            date=payload.date,
            meal_type=payload.meal_type,
            participant_user_ids=[user.id],
            notes="",
            mood="",
            created_by=user.id,
            updated_by=user.id,
        )
        db.add(meal_log)
        db.flush()
    else:
        meal_log.updated_by = user.id

    entry = None
    if plan_item is not None:
        entry = next((item for item in meal_log.food_entries if item.food_id == food.id and item.note == payload.note), None)
    entry_created = entry is None
    if entry_created:
        entry = MealLogFood(
            id=create_id("meal-food"),
            meal_log_id=meal_log.id,
            food_id=food.id,
            servings=payload.servings,
            note=payload.note,
        )
        db.add(entry)
        db.flush()

        for suggestion in _build_deduction_suggestions(db, [entry]):
            suggestion.meal_log_id = meal_log.id
            db.add(suggestion)

    if plan_item is not None:
        plan_item.status = "cooked"
        plan_item.completed_at = utcnow()
        plan_item.meal_log_id = meal_log.id
        plan_item.updated_by = user.id
        enqueue_search_index_job(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            entity_type="meal_plan",
            entity_id=plan_item.id,
            target_name=food.name,
        )

    if payload.deduct_food_stock and entry_created:
        try:
            apply_food_stock_consume(
                db,
                family_id=membership.family_id,
                user_id=user.id,
                food=food,
                quantity=Decimal(str(payload.stock_quantity or payload.servings)),
                unit=payload.stock_unit or food.stock_unit or "份",
                note="随餐食记录扣减",
            )
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE if created else ActivityAction.UPDATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary=f"{'记录' if created else '追加'}了{MEAL_TYPE_LABELS.get(payload.meal_type.value, payload.meal_type.value)}：{food.name}",
    )
    commit_session(db)
    db.refresh(meal_log)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="meal_log", entity_ids=[meal_log.id]))
    return serialize_meal_log(meal_log, media_map)
