from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.domain import Food, MealLog, MealLogFood
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.serializers import serialize_meal_log

MEAL_LOG_STALE_CODE = "meal_log_stale"
MEAL_LOG_STALE_MESSAGE = "这顿饭刚被家人更新，请刷新后确认"
MEAL_LOG_STALE_RECOVERY_HINT = "refresh_and_review"
MEAL_LOG_TARGETS_CHANGED_CODE = "meal_log_targets_changed"
MEAL_LOG_TARGETS_CHANGED_MESSAGE = "这顿饭的菜品组合刚被更新，请刷新后重试"
MEAL_LOG_NOT_FOUND_CODE = "meal_log_not_found"
MEAL_LOG_NOT_FOUND_MESSAGE = "餐食记录不存在或已被删除"
MEAL_LOG_DATE_MISMATCH_CODE = "meal_log_date_mismatch"
MEAL_LOG_DATE_MISMATCH_MESSAGE = "目标餐食的日期或餐别不匹配"


class MealLogConflictError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        current: dict | None = None,
        recovery_hint: str,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.current = current
        self.recovery_hint = recovery_hint


@dataclass(slots=True)
class LockedMealLogWriteTargets:
    meal_log: MealLog
    foods_by_id: dict[str, Any]
    discovered_food_ids: tuple[str, ...]


def _unique_sorted_ids(ids: Sequence[str]) -> list[str]:
    return sorted({str(item_id).strip() for item_id in ids if str(item_id).strip()})


def discover_meal_log_entry_food_ids(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
) -> tuple[str, ...]:
    """Return sorted entry Food IDs for a family-scoped MealLog without locking.

    Raises meal_log_not_found when the MealLog is missing or cross-family.
    Callers that already hold parent locks may use this to discover Foods to union
    into an earlier Food lock set and avoid reverse-locking after InventoryItems.
    """
    meal_log_id_found = db.scalar(
        select(MealLog.id).where(MealLog.id == meal_log_id, MealLog.family_id == family_id)
    )
    if meal_log_id_found is None:
        raise MealLogConflictError(
            MEAL_LOG_NOT_FOUND_CODE,
            MEAL_LOG_NOT_FOUND_MESSAGE,
            recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
        )
    food_ids = list(
        db.scalars(
            select(MealLogFood.food_id)
            .where(MealLogFood.meal_log_id == meal_log_id)
            .order_by(MealLogFood.food_id.asc())
        )
    )
    return tuple(_unique_sorted_ids(food_ids))


def lock_meal_log_write_targets(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
    additional_food_ids: Sequence[str] = (),
    prelocked_foods: Mapping[str, Food] | None = None,
) -> LockedMealLogWriteTargets:
    """Discover entry Foods unlocked, lock Foods then MealLog, and revalidate the set.

    Lock order is fixed: sorted Food FOR UPDATE → family-scoped MealLog FOR UPDATE.
    If the locked MealLog's entry Food set differs from the pre-lock discovery set,
    raise meal_log_targets_changed and never reverse-lock Food after MealLog.

    When ``prelocked_foods`` is provided, Foods are assumed already locked in global
    order and this helper only locks MealLog (no second Food FOR UPDATE pass).

    Missing / cross-family Foods that belong only to ``additional_food_ids`` (request
    Foods, not the discovered entry set) re-raise ``InventoryTargetNotFoundError`` so
    callers such as ``record_meal`` can map them to 404 ``meal_log_food_not_found``.
    Incomplete discovered entry Foods still map to ``meal_log_targets_changed``.
    """
    discovered_food_ids = discover_meal_log_entry_food_ids(
        db,
        family_id=family_id,
        meal_log_id=meal_log_id,
    )
    ordered_additional_food_ids = _unique_sorted_ids(additional_food_ids)
    ordered_food_ids = _unique_sorted_ids([*discovered_food_ids, *ordered_additional_food_ids])

    foods_by_id: dict[str, Any] = {}
    if ordered_food_ids:
        if prelocked_foods is not None:
            foods_by_id = {
                food_id: prelocked_foods[food_id]
                for food_id in ordered_food_ids
                if food_id in prelocked_foods and prelocked_foods[food_id].family_id == family_id
            }
            if len(foods_by_id) != len(ordered_food_ids):
                missing_ids = set(ordered_food_ids) - set(foods_by_id)
                discovered_missing = missing_ids.intersection(discovered_food_ids)
                additional_missing = missing_ids.intersection(ordered_additional_food_ids)
                # Request-only Food absence is not an entry-set race.
                if additional_missing and not discovered_missing:
                    raise InventoryTargetNotFoundError("食物不存在或不属于当前家庭")
                raise MealLogConflictError(
                    MEAL_LOG_TARGETS_CHANGED_CODE,
                    MEAL_LOG_TARGETS_CHANGED_MESSAGE,
                    recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
                )
        else:
            try:
                foods_by_id = lock_inventory_targets(
                    db,
                    family_id=family_id,
                    food_ids=ordered_food_ids,
                ).foods
            except InventoryTargetNotFoundError as exc:
                if ordered_additional_food_ids:
                    present_ids = set(
                        db.scalars(
                            select(Food.id).where(
                                Food.family_id == family_id,
                                Food.id.in_(ordered_food_ids),
                            )
                        )
                    )
                    missing_ids = set(ordered_food_ids) - present_ids
                    discovered_missing = missing_ids.intersection(discovered_food_ids)
                    additional_missing = missing_ids.intersection(ordered_additional_food_ids)
                    # Request-only Food absence is not an entry-set race.
                    if additional_missing and not discovered_missing:
                        raise
                raise MealLogConflictError(
                    MEAL_LOG_TARGETS_CHANGED_CODE,
                    MEAL_LOG_TARGETS_CHANGED_MESSAGE,
                    recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
                ) from exc

    meal_log = db.scalar(
        select(MealLog)
        .where(MealLog.id == meal_log_id, MealLog.family_id == family_id)
        .options(
            selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
            selectinload(MealLog.deduction_suggestions),
        )
        .with_for_update()
    )
    if meal_log is None:
        raise MealLogConflictError(
            MEAL_LOG_NOT_FOUND_CODE,
            MEAL_LOG_NOT_FOUND_MESSAGE,
            recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
        )

    locked_entry_food_ids = tuple(_unique_sorted_ids([entry.food_id for entry in meal_log.food_entries]))
    if locked_entry_food_ids != discovered_food_ids:
        raise MealLogConflictError(
            MEAL_LOG_TARGETS_CHANGED_CODE,
            MEAL_LOG_TARGETS_CHANGED_MESSAGE,
            recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
        )

    return LockedMealLogWriteTargets(
        meal_log=meal_log,
        foods_by_id=foods_by_id,
        discovered_food_ids=discovered_food_ids,
    )


def require_meal_log_version(meal_log: MealLog, expected_row_version: int) -> None:
    if int(meal_log.row_version) != int(expected_row_version):
        raise MealLogConflictError(
            MEAL_LOG_STALE_CODE,
            MEAL_LOG_STALE_MESSAGE,
            recovery_hint=MEAL_LOG_STALE_RECOVERY_HINT,
        )


def bump_meal_log_collection(meal_log: MealLog, *, user_id: str) -> None:
    meal_log.row_version += 1
    meal_log.updated_by = user_id


def load_meal_log_for_serialization(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
) -> MealLog | None:
    return db.scalar(
        select(MealLog)
        .where(MealLog.id == meal_log_id, MealLog.family_id == family_id)
        .options(
            selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
            selectinload(MealLog.deduction_suggestions),
        )
    )


def build_meal_log_conflict_detail(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
    code: str,
    recovery_hint: str,
    message: str | None = None,
) -> dict[str, Any]:
    """Reload the full MealLog view and build a stable conflict payload."""
    meal_log = load_meal_log_for_serialization(db, family_id=family_id, meal_log_id=meal_log_id)
    if meal_log is None:
        return {
            "code": MEAL_LOG_NOT_FOUND_CODE,
            "message": MEAL_LOG_NOT_FOUND_MESSAGE,
            "current": None,
            "recovery_hint": recovery_hint,
        }

    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="meal_log",
            entity_ids=[meal_log.id],
        )
    )
    resolved_message = message
    if resolved_message is None:
        if code == MEAL_LOG_STALE_CODE:
            resolved_message = MEAL_LOG_STALE_MESSAGE
        elif code == MEAL_LOG_TARGETS_CHANGED_CODE:
            resolved_message = MEAL_LOG_TARGETS_CHANGED_MESSAGE
        else:
            resolved_message = MEAL_LOG_STALE_MESSAGE

    return {
        "code": code,
        "message": resolved_message,
        "current": jsonable_encoder(serialize_meal_log(meal_log, media_map)),
        "recovery_hint": recovery_hint,
    }
