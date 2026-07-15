from __future__ import annotations

from collections.abc import Sequence
from decimal import Decimal

from sqlalchemy.orm import Session

from app.core.enums import ActivityAction
from app.models.domain import MealLog, MealLogFood
from app.services.activity import log_activity
from app.services.meal_log_versions import (
    MealLogConflictError,
    bump_meal_log_collection,
    lock_meal_log_write_targets,
    require_meal_log_version,
)
from app.services.meal_log_writes import MealEntryWrite, append_meal_log_entries

MEAL_LOG_FOOD_REQUIRED_CODE = "meal_log_food_required"
MEAL_LOG_FOOD_REQUIRED_MESSAGE = "餐食记录至少需要一个食物"
MEAL_LOG_DUPLICATE_FOOD_CODE = "duplicate_meal_log_food"
MEAL_LOG_DUPLICATE_FOOD_MESSAGE = "同一食物不能重复加入一餐"
MEAL_LOG_FOOD_NOT_FOUND_CODE = "meal_log_food_not_found"
MEAL_LOG_FOOD_NOT_FOUND_MESSAGE = "食物不存在或不属于当前家庭"
MEAL_LOG_ENTRY_NOT_FOUND_CODE = "meal_log_entry_not_found"
MEAL_LOG_ENTRY_NOT_FOUND_MESSAGE = "餐食菜品条目不存在或不属于该记录"
MEAL_LOG_ENTRY_FOOD_MISMATCH_CODE = "meal_log_entry_food_mismatch"
MEAL_LOG_ENTRY_FOOD_MISMATCH_MESSAGE = "已有菜品条目不能更换食物"


class MealCompositionValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize_note(note: str | None) -> str:
    return "" if note is None else str(note)


def update_meal_composition(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    meal_log_id: str,
    expected_row_version: int,
    food_entries: Sequence[object],
) -> MealLog:
    """Apply an entry-ID full composition diff under Food→MealLog locks.

    Never commits. Does not create record operations or reverse stock/plan facts.
    Existing entry IDs preserve rating and created_at; only servings/note update.
    """
    request_items = list(food_entries)
    if not request_items:
        raise MealCompositionValidationError(
            MEAL_LOG_FOOD_REQUIRED_CODE,
            MEAL_LOG_FOOD_REQUIRED_MESSAGE,
        )

    request_food_ids: list[str] = []
    for item in request_items:
        food_id = str(getattr(item, "food_id")).strip()
        if not food_id:
            raise MealCompositionValidationError(
                MEAL_LOG_FOOD_NOT_FOUND_CODE,
                MEAL_LOG_FOOD_NOT_FOUND_MESSAGE,
            )
        request_food_ids.append(food_id)

    # Discover current entry Foods unlocked via lock helper; pass request Foods as additional.
    locked = lock_meal_log_write_targets(
        db,
        family_id=family_id,
        meal_log_id=meal_log_id,
        additional_food_ids=request_food_ids,
    )
    meal_log = locked.meal_log

    # Expected version is the first business check after all required locks.
    require_meal_log_version(meal_log, expected_row_version)

    existing_by_id: dict[str, MealLogFood] = {entry.id: entry for entry in list(meal_log.food_entries)}
    final_food_ids: list[str] = []
    keep_ids: set[str] = set()
    to_create: list[MealEntryWrite] = []

    for item in request_items:
        food_id = str(getattr(item, "food_id")).strip()
        servings = Decimal(str(getattr(item, "servings")))
        note = _normalize_note(getattr(item, "note", ""))
        entry_id = getattr(item, "id", None)
        entry_id = str(entry_id).strip() if entry_id is not None and str(entry_id).strip() else None

        if entry_id is not None:
            existing = existing_by_id.get(entry_id)
            if existing is None:
                raise MealCompositionValidationError(
                    MEAL_LOG_ENTRY_NOT_FOUND_CODE,
                    MEAL_LOG_ENTRY_NOT_FOUND_MESSAGE,
                )
            if existing.food_id != food_id:
                raise MealCompositionValidationError(
                    MEAL_LOG_ENTRY_FOOD_MISMATCH_CODE,
                    MEAL_LOG_ENTRY_FOOD_MISMATCH_MESSAGE,
                )
            # Preserve id/rating/created_at; update only servings/note.
            existing.servings = servings
            existing.note = note
            keep_ids.add(entry_id)
            final_food_ids.append(existing.food_id)
        else:
            to_create.append(
                MealEntryWrite(
                    food_id=food_id,
                    servings=servings,
                    note=note,
                )
            )
            final_food_ids.append(food_id)

    if not final_food_ids:
        raise MealCompositionValidationError(
            MEAL_LOG_FOOD_REQUIRED_CODE,
            MEAL_LOG_FOOD_REQUIRED_MESSAGE,
        )
    if len(final_food_ids) != len(set(final_food_ids)):
        raise MealCompositionValidationError(
            MEAL_LOG_DUPLICATE_FOOD_CODE,
            MEAL_LOG_DUPLICATE_FOOD_MESSAGE,
        )

    # Validate all final Food IDs after version check (request + kept existing).
    missing = [food_id for food_id in final_food_ids if food_id not in locked.foods_by_id]
    if missing:
        raise MealCompositionValidationError(
            MEAL_LOG_FOOD_NOT_FOUND_CODE,
            MEAL_LOG_FOOD_NOT_FOUND_MESSAGE,
        )
    for food_id in final_food_ids:
        food = locked.foods_by_id[food_id]
        if food.family_id != family_id:
            raise MealCompositionValidationError(
                MEAL_LOG_FOOD_NOT_FOUND_CODE,
                MEAL_LOG_FOOD_NOT_FOUND_MESSAGE,
            )

    # Omitted existing IDs are deleted in place (no full rebuild).
    for entry_id, entry in list(existing_by_id.items()):
        if entry_id not in keep_ids:
            db.delete(entry)
            meal_log.food_entries.remove(entry)

    if to_create:
        created = append_meal_log_entries(db, meal_log=meal_log, entries=to_create)
        for entry in created:
            # Relationship may not auto-append depending on cascade config; ensure membership.
            if entry not in meal_log.food_entries:
                meal_log.food_entries.append(entry)

    db.flush()

    if not list(meal_log.food_entries):
        raise MealCompositionValidationError(
            MEAL_LOG_FOOD_REQUIRED_CODE,
            MEAL_LOG_FOOD_REQUIRED_MESSAGE,
        )

    bump_meal_log_collection(meal_log, user_id=actor_user_id)
    log_activity(
        db,
        family_id=family_id,
        actor_id=actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="MealLog",
        entity_id=meal_log.id,
        summary="调整了餐食内容",
    )
    db.flush()
    return meal_log


# Re-export for callers that need conflict typing from this module boundary.
__all__ = [
    "MealCompositionValidationError",
    "MealLogConflictError",
    "update_meal_composition",
    "MEAL_LOG_FOOD_REQUIRED_CODE",
    "MEAL_LOG_DUPLICATE_FOOD_CODE",
    "MEAL_LOG_FOOD_NOT_FOUND_CODE",
    "MEAL_LOG_ENTRY_NOT_FOUND_CODE",
    "MEAL_LOG_ENTRY_FOOD_MISMATCH_CODE",
]
