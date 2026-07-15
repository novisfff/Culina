from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.orm.exc import StaleDataError
from fastapi import APIRouter, Depends, HTTPException, status

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction, ActivityHighlightKind
from app.core.utils import create_id, utcnow
from app.db.session import get_db
from app.db.transactions import commit_session
from app.ai.images.jobs import attach_image_generation_job_to_entity
from app.models.domain import Food, FoodPlanItem, InventoryDeductionSuggestion, MealLog, MealLogFood, Recipe
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.meal_logs import CreateMealLogRequest, MealLogOut, QuickAddMealLogRequest, UpdateMealLogRequest
from app.services.activity import ActivityHighlight, log_activity
from app.services.clock import today_for_family
from app.services.food_stock import apply_food_stock_consume
from app.services.inventory_versions import (
    STALE_INVENTORY_DETAIL,
    InventoryConflictError,
    conflict_detail,
    require_expected_version,
)
from app.services.food_plan_locking import (
    FoodPlanConflict,
    food_plan_conflict_detail,
    lock_plan_item_after_food,
)
from app.services.meal_log_references import (
    MealLogReferenceError,
    lock_and_validate_meal_log_references,
    meal_log_reference_error_detail,
)
from app.services.meal_log_versions import (
    MEAL_LOG_NOT_FOUND_CODE,
    MEAL_LOG_STALE_CODE,
    MEAL_LOG_STALE_RECOVERY_HINT,
    MealLogConflictError,
    build_meal_log_conflict_detail,
    bump_meal_log_collection,
    lock_meal_log_write_targets,
    require_meal_log_version,
)
from app.services.meal_log_writes import MealEntryWrite, append_meal_log_entries, create_meal_log_with_entries
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


def _commit_meal_log_session(db: Session) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=STALE_INVENTORY_DETAIL,
        ) from exc


def _raise_meal_log_conflict(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
    exc: MealLogConflictError,
) -> None:
    if exc.code == MEAL_LOG_NOT_FOUND_CODE:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meal log not found") from exc
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=build_meal_log_conflict_detail(
            db,
            family_id=family_id,
            meal_log_id=meal_log_id,
            code=exc.code,
            recovery_hint=exc.recovery_hint,
            message=exc.message,
        ),
    ) from exc


def _commit_versioned_meal_log_session(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
) -> None:
    try:
        commit_session(db)
    except StaleDataError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=build_meal_log_conflict_detail(
                db,
                family_id=family_id,
                meal_log_id=meal_log_id,
                code=MEAL_LOG_STALE_CODE,
                recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
            ),
        ) from exc


def _select_food_for_quick_add(*, food_id: str, family_id: str, deduct_food_stock: bool):
    statement = select(Food).where(Food.id == food_id, Food.family_id == family_id)
    if deduct_food_stock:
        # Prefer the shared inventory lock helper at call sites that already hold a Session.
        statement = statement.with_for_update()
    return statement


def _raise_meal_log_reference_error(exc: MealLogReferenceError) -> None:
    status_code = (
        status.HTTP_404_NOT_FOUND
        if exc.code in {"meal_log_food_not_found", "meal_log_participant_not_found"}
        else status.HTTP_422_UNPROCESSABLE_ENTITY
    )
    raise HTTPException(status_code=status_code, detail=meal_log_reference_error_detail(exc)) from exc


def _raise_food_plan_conflict(exc: FoodPlanConflict) -> None:
    if exc.code == "food_plan_item_not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Food plan item not found") from exc
    if exc.code in {
        "food_plan_item_already_completed",
        "food_plan_item_stale",
        "food_plan_targets_changed",
        "food_plan_food_mismatch",
        "food_plan_item_not_planned",
    }:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=food_plan_conflict_detail(exc)) from exc
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=food_plan_conflict_detail(exc)) from exc


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
    try:
        references = lock_and_validate_meal_log_references(
            db,
            family_id=membership.family_id,
            actor_user_id=user.id,
            food_ids=[entry.food_id for entry in payload.food_entries],
            participant_user_ids=payload.participant_user_ids,
        )
    except MealLogReferenceError as exc:
        _raise_meal_log_reference_error(exc)

    meal_log, entries = create_meal_log_with_entries(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        date=payload.date,
        meal_type=payload.meal_type,
        entries=[
            MealEntryWrite(
                food_id=item.food_id,
                servings=Decimal(str(item.servings)),
                note=item.note,
                rating=Decimal(str(item.rating)) if item.rating is not None else None,
            )
            for item in payload.food_entries
        ],
        participant_user_ids=list(references.participant_user_ids),
        notes=payload.notes,
        mood=payload.mood,
    )

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
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.MEAL,
            summary=f"记录了{MEAL_TYPE_LABELS.get(meal_log.meal_type.value, meal_log.meal_type.value)}",
        ),
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
    try:
        locked = lock_meal_log_write_targets(
            db,
            family_id=membership.family_id,
            meal_log_id=meal_log_id,
        )
    except MealLogConflictError as exc:
        _raise_meal_log_conflict(
            db,
            family_id=membership.family_id,
            meal_log_id=meal_log_id,
            exc=exc,
        )

    meal_log = locked.meal_log
    try:
        # Expected row version is the first business check after all locks.
        require_meal_log_version(meal_log, payload.expected_row_version)
    except MealLogConflictError as exc:
        _raise_meal_log_conflict(
            db,
            family_id=membership.family_id,
            meal_log_id=meal_log_id,
            exc=exc,
        )

    if payload.participant_user_ids is not None or payload.food_entry_ratings is not None:
        # Rating-only updates re-validate actor foods but must not revalidate historical
        # participants (a departed family member would otherwise block ratings).
        if payload.participant_user_ids is not None:
            try:
                references = lock_and_validate_meal_log_references(
                    db,
                    family_id=membership.family_id,
                    actor_user_id=user.id,
                    food_ids=[entry.food_id for entry in meal_log.food_entries],
                    participant_user_ids=payload.participant_user_ids,
                    prelocked_foods=locked.foods_by_id,
                )
            except MealLogReferenceError as exc:
                _raise_meal_log_reference_error(exc)
            meal_log.participant_user_ids = list(references.participant_user_ids)
        else:
            try:
                lock_and_validate_meal_log_references(
                    db,
                    family_id=membership.family_id,
                    actor_user_id=user.id,
                    food_ids=[entry.food_id for entry in meal_log.food_entries],
                    participant_user_ids=[user.id],
                    prelocked_foods=locked.foods_by_id,
                )
            except MealLogReferenceError as exc:
                _raise_meal_log_reference_error(exc)
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

    bump_meal_log_collection(meal_log, user_id=user.id)
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.UPDATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary=f"补充了{MEAL_TYPE_LABELS.get(meal_log.meal_type.value, meal_log.meal_type.value)}记录",
    )
    _commit_versioned_meal_log_session(
        db,
        family_id=membership.family_id,
        meal_log_id=meal_log.id,
    )
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
    try:
        references = lock_and_validate_meal_log_references(
            db,
            family_id=membership.family_id,
            actor_user_id=user.id,
            food_ids=[payload.food_id],
            participant_user_ids=[user.id],
        )
    except MealLogReferenceError as exc:
        _raise_meal_log_reference_error(exc)
    food = references.foods_by_id[payload.food_id]

    plan_item: FoodPlanItem | None = None
    if payload.food_plan_item_id:
        # Food is already locked via meal-log references; lock plan item after Food.
        try:
            plan_item = lock_plan_item_after_food(
                db,
                family_id=membership.family_id,
                user_id=user.id,
                item_id=payload.food_plan_item_id,
                expected_food_id=food.id,
                base_updated_at=payload.food_plan_item_base_updated_at,
                require_planned=True,
            )
        except FoodPlanConflict as exc:
            _raise_food_plan_conflict(exc)

    # Plan-origin completion always creates a fresh exact MealLog in one transaction.
    # Non-plan quick-add may append to the latest same-day/same-meal log.
    meal_log = None
    if plan_item is None:
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
    entry_payload = MealEntryWrite(
        food_id=food.id,
        servings=Decimal(str(payload.servings)),
        note=payload.note,
    )
    if meal_log is None:
        meal_log, created_entries = create_meal_log_with_entries(
            db,
            family_id=membership.family_id,
            user_id=user.id,
            date=payload.date,
            meal_type=payload.meal_type,
            entries=[entry_payload],
            participant_user_ids=list(references.participant_user_ids),
            notes="",
            mood="",
        )
        entry = created_entries[0]
    else:
        created_entries = append_meal_log_entries(db, meal_log=meal_log, entries=[entry_payload])
        entry = created_entries[0]
        bump_meal_log_collection(meal_log, user_id=user.id)
    entry_created = True

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
            require_expected_version(
                food,
                payload.expected_food_row_version,
                entity_type="food",
                entity_id=food.id,
            )
        except InventoryConflictError as exc:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=conflict_detail(exc),
            ) from exc
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

    should_highlight = created or entry_created
    log_activity(
        db,
        family_id=membership.family_id,
        actor_id=user.id,
        action=ActivityAction.CREATE if created else ActivityAction.UPDATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary=f"{'记录' if created else '追加'}了{MEAL_TYPE_LABELS.get(payload.meal_type.value, payload.meal_type.value)}：{food.name}",
        highlight=(
            ActivityHighlight(
                kind=ActivityHighlightKind.MEAL,
                summary=f"记录了{MEAL_TYPE_LABELS.get(meal_log.meal_type.value, meal_log.meal_type.value)}",
            )
            if should_highlight
            else None
        ),
    )
    _commit_meal_log_session(db)
    db.refresh(meal_log)
    media_map = build_media_map(get_media_assets_for_entities(db, family_id=membership.family_id, entity_type="meal_log", entity_ids=[meal_log.id]))
    return serialize_meal_log(meal_log, media_map)
