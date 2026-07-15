from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import ActivityAction, ActivityHighlightKind, MealType
from app.core.utils import utcnow
from app.models.domain import Food, FoodPlanItem, MealLog, MealLogFood
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.activity import ActivityHighlight, log_activity
from app.services.food_plan_locking import (
    FoodPlanConflict,
    assert_food_plan_base_updated_at_matches,
    normalize_food_plan_datetime,
)
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.meal_log_versions import (
    MEAL_LOG_DATE_MISMATCH_CODE,
    MEAL_LOG_DATE_MISMATCH_MESSAGE,
    MealLogConflictError,
    bump_meal_log_collection,
    load_meal_log_for_serialization,
    lock_meal_log_write_targets,
    require_meal_log_version,
)
from app.services.meal_log_writes import MealEntryWrite, append_meal_log_entries, create_meal_log_with_entries
from app.services.serializers import serialize_meal_log

MEAL_TYPE_LABELS = {
    "breakfast": "早餐",
    "lunch": "午餐",
    "dinner": "晚餐",
    "snack": "加餐/夜宵",
}


@dataclass(frozen=True, slots=True)
class CompleteFoodPlanItemCommand:
    family_id: str
    actor_user_id: str
    item_id: str
    food_plan_item_base_updated_at: datetime
    target_meal_log_id: str | None = None
    expected_meal_log_row_version: int | None = None


def _unique_sorted_ids(ids: list[str | None]) -> list[str]:
    return sorted({item_id for item_id in ids if item_id})


def _load_plan_item_unlocked(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    item_id: str,
) -> FoodPlanItem:
    item = db.scalar(
        select(FoodPlanItem)
        .where(
            FoodPlanItem.family_id == family_id,
            FoodPlanItem.user_id == user_id,
            FoodPlanItem.id == item_id,
        )
        .options(selectinload(FoodPlanItem.food))
    )
    if item is None:
        raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
    return item


def _serialize_current_meal_log(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
) -> dict:
    meal_log = load_meal_log_for_serialization(db, family_id=family_id, meal_log_id=meal_log_id)
    if meal_log is None:
        raise FoodPlanConflict(
            "food_plan_item_already_completed",
            "该菜单项已经记录完成",
            meal_log_id=meal_log_id,
        )
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="meal_log",
            entity_ids=[meal_log.id],
        )
    )
    return serialize_meal_log(meal_log, media_map)


def _validate_target_meal_log(
    meal_log: MealLog,
    *,
    plan_item: FoodPlanItem,
    expected_row_version: int | None,
) -> None:
    if expected_row_version is not None:
        require_meal_log_version(meal_log, expected_row_version)
    if meal_log.date != plan_item.plan_date or meal_log.meal_type != plan_item.meal_type:
        raise MealLogConflictError(
            MEAL_LOG_DATE_MISMATCH_CODE,
            MEAL_LOG_DATE_MISMATCH_MESSAGE,
            recovery_hint="refresh_and_review",
        )


def complete_food_plan_item(db: Session, command: CompleteFoodPlanItemCommand) -> dict:
    """Complete a non-Recipe plan item by creating or appending a MealLog.

    Does not create a record operation or another completion table. Route owns commit.
    Lock order: sorted Food → optional target MealLog → plan item, then revalidate.
    Completed replay is checked before base-timestamp staleness.
    """
    discovered = _load_plan_item_unlocked(
        db,
        family_id=command.family_id,
        user_id=command.actor_user_id,
        item_id=command.item_id,
    )
    discovered_food_id = discovered.food_id
    discovered_stored_meal_log_id = discovered.meal_log_id
    requested_target_id = command.target_meal_log_id

    meal_log_ids_to_consider = _unique_sorted_ids(
        [discovered_stored_meal_log_id, requested_target_id]
    )

    # Discover entry Food IDs for any MealLog we may lock, without holding locks.
    additional_food_ids: list[str] = [discovered_food_id]
    for meal_log_id in meal_log_ids_to_consider:
        entry_food_ids = list(
            db.scalars(
                select(MealLogFood.food_id)
                .where(MealLogFood.meal_log_id == meal_log_id)
                .order_by(MealLogFood.food_id.asc())
            )
        )
        additional_food_ids.extend(entry_food_ids)

    ordered_food_ids = _unique_sorted_ids(additional_food_ids)
    try:
        foods_by_id = (
            lock_inventory_targets(
                db,
                family_id=command.family_id,
                food_ids=ordered_food_ids,
            ).foods
            if ordered_food_ids
            else {}
        )
    except InventoryTargetNotFoundError as exc:
        raise FoodPlanConflict("food_plan_targets_changed", "菜单计划目标已变化，请刷新后重试") from exc

    if discovered_food_id not in foods_by_id:
        raise FoodPlanConflict("food_plan_food_not_found", "草稿包含不属于当前家庭的食物")

    locked_target_meal_log: MealLog | None = None
    # Prefer explicit target for write path; stored id is used for completed replay.
    # Foods already locked above — MealLog-only lock via prelocked_foods (no second Food pass).
    lock_meal_log_id = requested_target_id or None
    if lock_meal_log_id is not None:
        locked = lock_meal_log_write_targets(
            db,
            family_id=command.family_id,
            meal_log_id=lock_meal_log_id,
            additional_food_ids=[discovered_food_id],
            prelocked_foods=foods_by_id,
        )
        locked_target_meal_log = locked.meal_log
        foods_by_id.update(locked.foods_by_id)

    plan_item = db.scalar(
        select(FoodPlanItem)
        .where(
            FoodPlanItem.family_id == command.family_id,
            FoodPlanItem.user_id == command.actor_user_id,
            FoodPlanItem.id == command.item_id,
        )
        .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
        .with_for_update()
    )
    if plan_item is None:
        raise FoodPlanConflict("food_plan_item_not_found", "餐食计划不存在或已被删除")
    if plan_item.food_id != discovered_food_id:
        raise FoodPlanConflict("food_plan_targets_changed", "菜单计划目标已变化，请刷新后重试")
    if plan_item.food_id not in foods_by_id:
        raise FoodPlanConflict("food_plan_food_not_found", "草稿包含不属于当前家庭的食物")

    # Completed replay BEFORE base timestamp staleness.
    if plan_item.status == "cooked" or plan_item.meal_log_id:
        stored_meal_log_id = plan_item.meal_log_id
        if not stored_meal_log_id:
            raise FoodPlanConflict(
                "food_plan_item_already_completed",
                "该菜单项已经记录完成",
            )
        if requested_target_id is not None and requested_target_id != stored_meal_log_id:
            raise FoodPlanConflict(
                "food_plan_item_already_completed",
                "该菜单项已经记录完成",
                meal_log_id=stored_meal_log_id,
            )
        return _serialize_current_meal_log(
            db,
            family_id=command.family_id,
            meal_log_id=stored_meal_log_id,
        )

    # Only uncompleted items validate base timestamp / status / date / type.
    assert_food_plan_base_updated_at_matches(
        actual=plan_item.updated_at,
        expected=command.food_plan_item_base_updated_at,
        label="菜单计划",
    )
    if plan_item.status != "planned":
        raise FoodPlanConflict(
            "food_plan_item_not_planned",
            "该菜单项当前不可完成",
        )

    food = foods_by_id[plan_item.food_id]
    entry = MealEntryWrite(food_id=food.id, servings=Decimal("1"), note="")

    if locked_target_meal_log is not None:
        assert command.expected_meal_log_row_version is not None
        _validate_target_meal_log(
            locked_target_meal_log,
            plan_item=plan_item,
            expected_row_version=command.expected_meal_log_row_version,
        )
        append_meal_log_entries(db, meal_log=locked_target_meal_log, entries=[entry])
        bump_meal_log_collection(locked_target_meal_log, user_id=command.actor_user_id)
        meal_log = locked_target_meal_log
        activity_action = ActivityAction.UPDATE
        activity_summary = f"追加了{MEAL_TYPE_LABELS.get(plan_item.meal_type.value, plan_item.meal_type.value)}"
    else:
        meal_log, _ = create_meal_log_with_entries(
            db,
            family_id=command.family_id,
            user_id=command.actor_user_id,
            date=plan_item.plan_date,
            meal_type=plan_item.meal_type if isinstance(plan_item.meal_type, MealType) else MealType(plan_item.meal_type),
            entries=[entry],
            participant_user_ids=[command.actor_user_id],
            notes="",
            mood="",
        )
        activity_action = ActivityAction.CREATE
        activity_summary = f"记录了{MEAL_TYPE_LABELS.get(plan_item.meal_type.value, plan_item.meal_type.value)}"

    plan_item.status = "cooked"
    plan_item.completed_at = utcnow()
    plan_item.meal_log_id = meal_log.id
    plan_item.updated_by = command.actor_user_id

    food_name = food.name if food is not None else "食物"
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="FoodPlanItem",
        entity_id=plan_item.id,
        summary=f"完成菜单计划 {food_name}",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.MEAL_PLAN,
            summary=f"完成 {food_name} 的菜单计划",
        ),
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=activity_action,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary=activity_summary,
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.MEAL,
            summary=f"记下 {food_name}",
        ),
    )
    db.flush()

    return _serialize_current_meal_log(
        db,
        family_id=command.family_id,
        meal_log_id=meal_log.id,
    )


# Re-export for tests / callers that may need datetime normalization helpers.
normalize_plan_base_updated_at = normalize_food_plan_datetime
