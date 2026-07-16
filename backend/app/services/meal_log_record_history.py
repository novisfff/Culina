from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.enums import ActivityAction, ActivityHighlightKind, MealLogRecordStatus, UserRole
from app.models.domain import Food, MealLog, MealLogFood, MealLogRecordOperation, MediaAsset
from app.repos.meal_log_record_operations import (
    get_family_record_operation,
    list_active_record_operations_for_actor,
)
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.meal_recording import (
    MealLogRecordOperationSummaryOut,
    RevertMealRecordResponse,
)
from app.services.activity import ActivityHighlight, log_activity
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets
from app.services.meal_log_foods import can_delete_record_created_food
from app.services.meal_log_versions import (
    bump_meal_log_collection,
    load_meal_log_for_serialization,
)
from app.services.media import replace_media_assets
from app.services.search.jobs import enqueue_search_index_job
from app.services.serializers import serialize_media, serialize_meal_log

RECORD_OPERATION_NOT_FOUND_CODE = "record_operation_not_found"
RECORD_OPERATION_NOT_FOUND_MESSAGE = "快速记录不存在或不属于当前家庭"
RECORD_OPERATION_FORBIDDEN_CODE = "record_operation_forbidden"
RECORD_OPERATION_FORBIDDEN_MESSAGE = "只有操作者或家庭管理员可以撤销"
RECORD_OPERATION_EXPIRED_CODE = "record_operation_expired"
RECORD_OPERATION_EXPIRED_MESSAGE = "撤销时间已过，可以打开记录修改"
RECORD_OPERATION_REVERTED_CODE = "record_operation_reverted"
RECORD_OPERATION_REVERTED_MESSAGE = "该快速记录已被撤销"


class MealRecordHistoryError(ValueError):
    def __init__(self, code: str, message: str, *, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class MealRecordHistoryNotFoundError(MealRecordHistoryError):
    def __init__(self, message: str = RECORD_OPERATION_NOT_FOUND_MESSAGE) -> None:
        super().__init__(RECORD_OPERATION_NOT_FOUND_CODE, message, status_code=404)


class MealRecordHistoryPermissionError(MealRecordHistoryError):
    def __init__(self, message: str = RECORD_OPERATION_FORBIDDEN_MESSAGE) -> None:
        super().__init__(RECORD_OPERATION_FORBIDDEN_CODE, message, status_code=403)


def _as_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _unique_sorted_ids(ids: list[str] | tuple[str, ...] | set[str]) -> list[str]:
    return sorted({str(item_id).strip() for item_id in ids if str(item_id).strip()})


def _sorted_media(assets: list[MediaAsset]) -> list[MediaAsset]:
    return sorted(
        assets,
        key=lambda asset: (
            asset.created_at or datetime.min.replace(tzinfo=timezone.utc),
            asset.id,
        ),
    )


def _compute_can_revert(
    operation: MealLogRecordOperation,
    *,
    user_id: str,
    user_role: UserRole | str,
    now: datetime,
) -> bool:
    if operation.status != MealLogRecordStatus.APPLIED:
        return False
    deadline = _as_aware(operation.revertible_until)
    current = _as_aware(now)
    if current > deadline:
        return False
    role = user_role if isinstance(user_role, UserRole) else UserRole(user_role)
    if operation.created_by == user_id:
        return True
    return role == UserRole.OWNER


def _effect_entry_ids(operation: MealLogRecordOperation) -> list[str]:
    return [str(item) for item in (operation.created_entry_ids_json or []) if str(item).strip()]


def _created_food_ids(operation: MealLogRecordOperation) -> list[str]:
    return [str(item) for item in (operation.created_food_ids_json or []) if str(item).strip()]


def _discover_effect_entry_food_ids(
    db: Session,
    *,
    entry_ids: list[str],
) -> list[str]:
    if not entry_ids:
        return []
    food_ids = list(
        db.scalars(
            select(MealLogFood.food_id).where(MealLogFood.id.in_(entry_ids)).order_by(MealLogFood.food_id.asc())
        )
    )
    return _unique_sorted_ids(food_ids)


def _serialize_meal_log_payload(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
) -> dict[str, Any] | None:
    cached = db.get(MealLog, meal_log_id)
    if cached is not None:
        db.expire(cached)
    meal_log = load_meal_log_for_serialization(db, family_id=family_id, meal_log_id=meal_log_id)
    if meal_log is None:
        return None
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="meal_log",
            entity_ids=[meal_log.id],
        )
    )
    return serialize_meal_log(meal_log, media_map)


def _build_summary_foods(
    db: Session,
    *,
    family_id: str,
    operation: MealLogRecordOperation,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Build Food names/media summary for this operation's effect only.

    Prefer created_entry_ids so append summaries do not list the whole meal.
    """
    result = operation.result_json or {}
    meal_log_payload = result.get("meal_log") if isinstance(result, dict) else None
    created_foods_payload = result.get("created_foods") if isinstance(result, dict) else None
    effect_entry_ids = set(_effect_entry_ids(operation))

    foods: list[dict[str, Any]] = []
    seen_food_ids: set[str] = set()
    first_cover: dict[str, Any] | None = None

    if isinstance(meal_log_payload, dict):
        for entry in meal_log_payload.get("food_entries") or []:
            if not isinstance(entry, dict):
                continue
            entry_id = str(entry.get("id") or "").strip()
            # When effect entry ids are known, only include this-op entries.
            if effect_entry_ids and entry_id and entry_id not in effect_entry_ids:
                continue
            food_id = str(entry.get("food_id") or "").strip()
            if not food_id or food_id in seen_food_ids:
                continue
            seen_food_ids.add(food_id)
            foods.append(
                {
                    "food_id": food_id,
                    "name": str(entry.get("food_name") or ""),
                    "food_type": "",
                    "cover": None,
                }
            )

    if isinstance(created_foods_payload, list):
        for item in created_foods_payload:
            if not isinstance(item, dict):
                continue
            food_id = str(item.get("id") or "").strip()
            if not food_id:
                continue
            images = item.get("images") or []
            cover = images[0] if images else None
            if food_id in seen_food_ids:
                for food in foods:
                    if food["food_id"] == food_id:
                        food["name"] = str(item.get("name") or food["name"])
                        food["food_type"] = str(item.get("type") or food["food_type"])
                        if cover is not None and food["cover"] is None:
                            food["cover"] = cover
                        break
            else:
                seen_food_ids.add(food_id)
                foods.append(
                    {
                        "food_id": food_id,
                        "name": str(item.get("name") or ""),
                        "food_type": str(item.get("type") or ""),
                        "cover": cover,
                    }
                )
            if first_cover is None and cover is not None:
                first_cover = cover

    # Enrich missing type / cover from live Food + media when result is sparse.
    missing_ids = [food["food_id"] for food in foods if not food["food_type"] or food["cover"] is None]
    live_foods: dict[str, Food] = {}
    if missing_ids:
        live_foods = {
            food.id: food
            for food in db.scalars(
                select(Food).where(Food.family_id == family_id, Food.id.in_(missing_ids))
            )
        }
        food_media_map = build_media_map(
            get_media_assets_for_entities(
                db,
                family_id=family_id,
                entity_type="food",
                entity_ids=missing_ids,
            )
        )
        for food in foods:
            live = live_foods.get(food["food_id"])
            if live is not None and not food["food_type"]:
                food["food_type"] = live.type.value if hasattr(live.type, "value") else str(live.type)
            if food["cover"] is None:
                photos = _sorted_media(food_media_map.get(("food", food["food_id"]), []))
                if photos:
                    food["cover"] = serialize_media(photos[0])
                    if first_cover is None:
                        first_cover = food["cover"]

    meal_photos: list[MediaAsset] = []
    if operation.meal_log_id:
        meal_media_map = build_media_map(
            get_media_assets_for_entities(
                db,
                family_id=family_id,
                entity_type="meal_log",
                entity_ids=[operation.meal_log_id],
            )
        )
        meal_photos = _sorted_media(meal_media_map.get(("meal_log", operation.meal_log_id), []))

    preview_media = serialize_media(meal_photos[0]) if meal_photos else first_cover
    return foods, preview_media


def list_active_record_operations(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    user_role: UserRole | str,
    now: datetime,
) -> list[MealLogRecordOperationSummaryOut]:
    operations = list_active_record_operations_for_actor(
        db,
        family_id=family_id,
        actor_user_id=actor_user_id,
        now=now,
    )
    summaries: list[MealLogRecordOperationSummaryOut] = []
    for operation in operations:
        foods, preview_media = _build_summary_foods(db, family_id=family_id, operation=operation)
        summaries.append(
            MealLogRecordOperationSummaryOut.model_validate(
                {
                    "id": operation.id,
                    "meal_log_id": operation.meal_log_id,
                    "foods": foods,
                    "preview_media": preview_media,
                    "revertible_until": operation.revertible_until,
                    "can_revert": _compute_can_revert(
                        operation,
                        user_id=actor_user_id,
                        user_role=user_role,
                        now=now,
                    ),
                }
            )
        )
    return summaries


def _authorize_revert_actor(
    operation: MealLogRecordOperation,
    *,
    user_id: str,
    user_role: UserRole | str,
) -> None:
    """Actor/Owner authorization only — required for both first revert and REVERTED replay."""
    role = user_role if isinstance(user_role, UserRole) else UserRole(user_role)
    if operation.created_by != user_id and role != UserRole.OWNER:
        raise MealRecordHistoryPermissionError()


def _authorize_revert(
    operation: MealLogRecordOperation,
    *,
    user_id: str,
    user_role: UserRole | str,
    now: datetime,
) -> None:
    _authorize_revert_actor(operation, user_id=user_id, user_role=user_role)
    deadline = _as_aware(operation.revertible_until)
    current = _as_aware(now)
    if current > deadline:
        raise MealRecordHistoryError(
            RECORD_OPERATION_EXPIRED_CODE,
            RECORD_OPERATION_EXPIRED_MESSAGE,
            status_code=409,
        )


def _response_from_saved_revert(
    operation: MealLogRecordOperation,
    *,
    replayed: bool,
) -> RevertMealRecordResponse:
    saved = dict(operation.revert_result_json or {})
    saved["replayed"] = replayed
    if "status" not in saved:
        saved["status"] = "reverted"
    if "removed_food_ids" not in saved:
        saved["removed_food_ids"] = []
    if "meal_log" not in saved:
        saved["meal_log"] = None
    return RevertMealRecordResponse.model_validate(saved)


def _unbind_meal_log_media(
    db: Session,
    *,
    family_id: str,
    meal_log_id: str,
) -> None:
    replace_media_assets(
        db,
        family_id=family_id,
        media_ids=[],
        entity_type="meal_log",
        entity_id=meal_log_id,
    )


def _delete_created_foods_if_eligible(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    created_food_ids: list[str],
    locked_foods: dict[str, Food],
) -> list[str]:
    removed: list[str] = []
    for food_id in created_food_ids:
        food = locked_foods.get(food_id)
        if food is None:
            # Already gone; treat as removed for response stability only when previously deleted.
            continue
        if not can_delete_record_created_food(db, food):
            continue
        enqueue_search_index_job(
            db,
            family_id=family_id,
            user_id=actor_user_id,
            entity_type="food",
            entity_id=food.id,
            target_name=food.name,
        )
        db.delete(food)
        locked_foods.pop(food_id, None)
        removed.append(food_id)
    return removed


def _lock_present_foods(
    db: Session,
    *,
    family_id: str,
    food_ids: list[str],
) -> dict[str, Food]:
    """Lock as many of the requested Foods as currently exist.

    Retries present-only locking until stable so concurrent deletes cannot
    surface as 500 when some created Foods disappear between SELECT and lock.
    Deletes still only operate on foods that were successfully locked.
    """
    remaining = _unique_sorted_ids(food_ids)
    if not remaining:
        return {}

    # Bound retries: each miss shrinks the candidate set, so at most len(ids)+1 loops.
    for _ in range(len(remaining) + 1):
        try:
            return lock_inventory_targets(
                db,
                family_id=family_id,
                food_ids=remaining,
            ).foods
        except InventoryTargetNotFoundError:
            present_ids = list(
                db.scalars(
                    select(Food.id).where(
                        Food.family_id == family_id,
                        Food.id.in_(remaining),
                    )
                )
            )
            remaining = _unique_sorted_ids(present_ids)
            if not remaining:
                return {}
    # Exhausted retries with a non-empty set still racing; lock whatever is locked-stable
    # by falling through to empty rather than raising 500.
    return {}


def revert_record_operation(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    user_role: UserRole | str,
    operation_id: str,
    now: datetime,
) -> RevertMealRecordResponse:
    """Atomically revert one meal record operation by effect IDs. Never commits."""
    operation = get_family_record_operation(
        db,
        family_id=family_id,
        operation_id=operation_id,
        for_update=True,
    )
    if operation is None:
        raise MealRecordHistoryNotFoundError()

    if operation.status == MealLogRecordStatus.REVERTED:
        # Idempotent replay: auth required; deadline skipped for post-window network retry.
        # Never re-load MealLog/Food or re-mutate.
        _authorize_revert_actor(operation, user_id=actor_user_id, user_role=user_role)
        return _response_from_saved_revert(operation, replayed=True)

    if operation.status != MealLogRecordStatus.APPLIED:
        raise MealRecordHistoryError(
            RECORD_OPERATION_REVERTED_CODE,
            RECORD_OPERATION_REVERTED_MESSAGE,
            status_code=409,
        )

    _authorize_revert(operation, user_id=actor_user_id, user_role=user_role, now=now)

    effect_entry_ids = _effect_entry_ids(operation)
    created_food_ids = _created_food_ids(operation)

    # Pre-read effect entry Food IDs without row locks, then lock Foods then MealLog.
    effect_food_ids = _discover_effect_entry_food_ids(db, entry_ids=effect_entry_ids)
    ordered_food_ids = _unique_sorted_ids([*effect_food_ids, *created_food_ids])

    locked_foods: dict[str, Food] = {}
    if ordered_food_ids:
        locked_foods = _lock_present_foods(
            db,
            family_id=family_id,
            food_ids=ordered_food_ids,
        )

    meal_log = db.scalar(
        select(MealLog)
        .where(MealLog.id == operation.meal_log_id, MealLog.family_id == family_id)
        .options(
            selectinload(MealLog.food_entries).selectinload(MealLogFood.food),
            selectinload(MealLog.deduction_suggestions),
        )
        .with_for_update()
    )

    remaining_meal_log_payload: dict[str, Any] | None = None
    removed_food_ids: list[str] = []

    if meal_log is not None:
        entries_by_id = {entry.id: entry for entry in list(meal_log.food_entries)}
        # Revalidate: only delete matching effect entries that still belong to this MealLog.
        to_delete = [
            entries_by_id[entry_id]
            for entry_id in effect_entry_ids
            if entry_id in entries_by_id and entries_by_id[entry_id].meal_log_id == meal_log.id
        ]
        for entry in to_delete:
            db.delete(entry)
            meal_log.food_entries.remove(entry)

        db.flush()

        remaining_entries = list(meal_log.food_entries)
        if remaining_entries:
            bump_meal_log_collection(meal_log, user_id=actor_user_id)
            db.flush()
            remaining_meal_log_payload = _serialize_meal_log_payload(
                db,
                family_id=family_id,
                meal_log_id=meal_log.id,
            )
        else:
            _unbind_meal_log_media(db, family_id=family_id, meal_log_id=meal_log.id)
            db.delete(meal_log)
            db.flush()
            remaining_meal_log_payload = None
    else:
        # MealLog already gone; still attempt created-Food cleanup under locks.
        remaining_meal_log_payload = None

    removed_food_ids = _delete_created_foods_if_eligible(
        db,
        family_id=family_id,
        actor_user_id=actor_user_id,
        created_food_ids=created_food_ids,
        locked_foods=locked_foods,
    )
    db.flush()

    current = _as_aware(now)
    response_payload = {
        "status": "reverted",
        "meal_log": remaining_meal_log_payload,
        "removed_food_ids": removed_food_ids,
        "replayed": False,
    }
    operation.status = MealLogRecordStatus.REVERTED
    operation.reverted_at = current
    operation.reverted_by = actor_user_id
    operation.revert_result_json = jsonable_encoder(response_payload)

    log_activity(
        db,
        family_id=family_id,
        actor_id=actor_user_id,
        action=ActivityAction.REVERT,
        entity_type="MealLog",
        entity_id=operation.meal_log_id,
        summary="撤销了刚才的餐食记录",
        highlight=ActivityHighlight(
            kind=ActivityHighlightKind.MEAL,
            summary="撤销了刚才的餐食记录",
        ),
    )
    db.flush()
    return RevertMealRecordResponse.model_validate(response_payload)
