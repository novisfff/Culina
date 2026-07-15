from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, ActivityHighlightKind, MealLogRecordStatus, MealLogRecordTargetKind, MealType
from app.core.utils import create_id
from app.models.domain import MealLog, MealLogRecordOperation
from app.repos.meal_log_record_operations import (
    MealRecordIdempotencyError,
    claim_record_operation,
)
from app.repos.media import build_media_map, get_media_assets_for_entities
from app.schemas.meal_recording import (
    RecordMealRequest,
    RecordMealResponse,
    RecordMealTargetExisting,
)
from app.services.activity import ActivityHighlight, log_activity
from app.services.clock import today_for_family
from app.services.meal_log_foods import create_minimal_meal_food
from app.services.meal_log_references import MealLogReferenceError
from app.services.meal_log_versions import (
    MealLogConflictError,
    bump_meal_log_collection,
    load_meal_log_for_serialization,
    lock_meal_log_write_targets,
    require_meal_log_version,
)
from app.services.meal_log_writes import MealEntryWrite, append_meal_log_entries, create_meal_log_with_entries
from app.services.serializers import serialize_food, serialize_meal_log
from app.services.inventory_operation_locking import InventoryTargetNotFoundError, lock_inventory_targets

MEAL_TYPE_LABELS = {
    "breakfast": "早餐",
    "lunch": "午餐",
    "dinner": "晚餐",
    "snack": "加餐/夜宵",
}

MEAL_LOG_DATE_MISMATCH_CODE = "meal_log_date_mismatch"
MEAL_LOG_DATE_MISMATCH_MESSAGE = "目标餐食的日期或餐别不匹配"
MEAL_LOG_DUPLICATE_FOOD_CODE = "duplicate_meal_log_food"
MEAL_LOG_DUPLICATE_FOOD_MESSAGE = "同一食物不能重复加入一餐"
MEAL_LOG_FOOD_NOT_FOUND_CODE = "meal_log_food_not_found"
MEAL_LOG_FOOD_NOT_FOUND_MESSAGE = "食物不存在或不属于当前家庭"


class MealRecordValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _as_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _decimal_string(value: Decimal | float | int | str) -> str:
    return format(Decimal(str(value)).normalize(), "f")


def _normalize_for_hash(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return _normalize_for_hash(value.model_dump(mode="python"))
    if isinstance(value, dict):
        return {str(key): _normalize_for_hash(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_for_hash(item) for item in value]
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Decimal):
        return _decimal_string(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return value


def canonical_record_request_hash(request: RecordMealRequest) -> str:
    """SHA-256 of normalized business payload excluding client_request_id."""
    payload = {
        "date": request.date,
        "meal_type": request.meal_type,
        "target": request.target,
        "new_foods": request.new_foods,
        "entries": request.entries,
    }
    normalized = _normalize_for_hash(payload)
    canonical = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _compute_can_revert(operation: MealLogRecordOperation, *, now: datetime) -> bool:
    if operation.status != MealLogRecordStatus.APPLIED:
        return False
    return _as_aware(now) <= _as_aware(operation.revertible_until)


def _build_operation_out(operation: MealLogRecordOperation, *, now: datetime) -> dict[str, Any]:
    return {
        "id": operation.id,
        "status": operation.status.value if hasattr(operation.status, "value") else operation.status,
        "revertible_until": operation.revertible_until,
        "can_revert": _compute_can_revert(operation, now=now),
    }


def _response_from_saved(
    operation: MealLogRecordOperation,
    *,
    now: datetime,
    outcome: str = "replayed",
) -> RecordMealResponse:
    saved = dict(operation.result_json or {})
    saved["outcome"] = outcome
    saved["operation"] = _build_operation_out(operation, now=now)
    return RecordMealResponse.model_validate(saved)


def replay_record_operation(
    operation: MealLogRecordOperation,
    *,
    now: datetime,
) -> RecordMealResponse:
    if operation.status == MealLogRecordStatus.REVERTED:
        raise MealRecordIdempotencyError(
            "record_operation_reverted",
            "该快速记录已被撤销，请重新发起记录",
        )
    return _response_from_saved(operation, now=now, outcome="replayed")


def _meal_type_label(meal_type: MealType | str) -> str:
    value = meal_type.value if hasattr(meal_type, "value") else str(meal_type)
    return MEAL_TYPE_LABELS.get(value, value)


def _serialize_created_foods(db: Session, *, family_id: str, foods: list[Any]) -> list[dict[str, Any]]:
    if not foods:
        return []
    media_map = build_media_map(
        get_media_assets_for_entities(
            db,
            family_id=family_id,
            entity_type="food",
            entity_ids=[food.id for food in foods],
        )
    )
    return [serialize_food(food, media_map) for food in foods]


def _serialize_meal_log_payload(db: Session, *, family_id: str, meal_log_id: str) -> dict[str, Any]:
    # Expire any identity-mapped MealLog so selectinload re-reads food_entries after append.
    cached = db.get(MealLog, meal_log_id)
    if cached is not None:
        db.expire(cached)
    meal_log = load_meal_log_for_serialization(db, family_id=family_id, meal_log_id=meal_log_id)
    if meal_log is None:
        raise MealLogConflictError(
            "meal_log_not_found",
            "餐食记录不存在或已被删除",
            recovery_hint="refresh_and_review",
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


def _request_existing_food_ids(request: RecordMealRequest) -> list[str]:
    return sorted({entry.food_id for entry in request.entries if entry.food_id is not None})


def _create_inline_foods(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    request: RecordMealRequest,
) -> tuple[dict[str, str], list[Any]]:
    client_to_food_id: dict[str, str] = {}
    created_foods: list[Any] = []
    for item in request.new_foods:
        food = create_minimal_meal_food(
            db,
            family_id=family_id,
            user_id=actor_user_id,
            name=item.name,
            food_type=item.type,
        )
        client_to_food_id[item.client_food_id] = food.id
        created_foods.append(food)
    return client_to_food_id, created_foods


def _resolve_entry_writes(
    request: RecordMealRequest,
    *,
    client_to_food_id: dict[str, str],
) -> list[MealEntryWrite]:
    writes: list[MealEntryWrite] = []
    final_food_ids: list[str] = []
    for entry in request.entries:
        if entry.food_id is not None:
            food_id = entry.food_id
        else:
            assert entry.client_food_id is not None
            food_id = client_to_food_id[entry.client_food_id]
        final_food_ids.append(food_id)
        writes.append(
            MealEntryWrite(
                food_id=food_id,
                servings=Decimal(str(entry.servings)),
            )
        )
    if len(final_food_ids) != len(set(final_food_ids)):
        raise MealRecordValidationError(
            MEAL_LOG_DUPLICATE_FOOD_CODE,
            MEAL_LOG_DUPLICATE_FOOD_MESSAGE,
        )
    return writes


def _ensure_no_duplicate_existing_foods(meal_log: MealLog, final_food_ids: list[str]) -> None:
    existing = {entry.food_id for entry in meal_log.food_entries}
    if existing.intersection(final_food_ids):
        raise MealRecordValidationError(
            MEAL_LOG_DUPLICATE_FOOD_CODE,
            MEAL_LOG_DUPLICATE_FOOD_MESSAGE,
        )


def _validate_existing_target(
    meal_log: MealLog,
    *,
    request: RecordMealRequest,
    expected_row_version: int,
) -> None:
    require_meal_log_version(meal_log, expected_row_version)
    if meal_log.date != request.date or meal_log.meal_type != request.meal_type:
        raise MealLogConflictError(
            MEAL_LOG_DATE_MISMATCH_CODE,
            MEAL_LOG_DATE_MISMATCH_MESSAGE,
            recovery_hint="refresh_and_review",
        )


def record_meal(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    request: RecordMealRequest,
    now: datetime,
) -> RecordMealResponse:
    """Claim-first atomic meal recording. Never commits; route owns commit once."""
    request_hash = canonical_record_request_hash(request)
    allocated_meal_log_id = (
        request.target.meal_log_id
        if isinstance(request.target, RecordMealTargetExisting)
        else create_id("meal")
    )
    target_kind = (
        MealLogRecordTargetKind.EXISTING
        if isinstance(request.target, RecordMealTargetExisting)
        else MealLogRecordTargetKind.NEW
    )

    operation, created = claim_record_operation(
        db,
        family_id=family_id,
        actor_user_id=actor_user_id,
        client_request_id=request.client_request_id,
        request_hash=request_hash,
        target_kind=target_kind,
        meal_log_id=allocated_meal_log_id,
        now=now,
    )
    if not created:
        return replay_record_operation(operation, now=now)

    existing_food_ids = _request_existing_food_ids(request)

    try:
        if isinstance(request.target, RecordMealTargetExisting):
            try:
                locked = lock_meal_log_write_targets(
                    db,
                    family_id=family_id,
                    meal_log_id=request.target.meal_log_id,
                    additional_food_ids=existing_food_ids,
                )
            except InventoryTargetNotFoundError as exc:
                # Request-only missing/cross-family Food (not entry-set race).
                raise MealRecordValidationError(
                    MEAL_LOG_FOOD_NOT_FOUND_CODE,
                    MEAL_LOG_FOOD_NOT_FOUND_MESSAGE,
                ) from exc
            meal_log = locked.meal_log
            _validate_existing_target(
                meal_log,
                request=request,
                expected_row_version=request.target.expected_row_version,
            )
            # Existing foods from request must already be in the locked set.
            missing = [food_id for food_id in existing_food_ids if food_id not in locked.foods_by_id]
            if missing:
                raise MealRecordValidationError(
                    MEAL_LOG_FOOD_NOT_FOUND_CODE,
                    MEAL_LOG_FOOD_NOT_FOUND_MESSAGE,
                )

            client_to_food_id, created_foods = _create_inline_foods(
                db,
                family_id=family_id,
                actor_user_id=actor_user_id,
                request=request,
            )
            entry_writes = _resolve_entry_writes(request, client_to_food_id=client_to_food_id)
            _ensure_no_duplicate_existing_foods(
                meal_log,
                [item.food_id for item in entry_writes],
            )
            created_entries = append_meal_log_entries(db, meal_log=meal_log, entries=entry_writes)
            bump_meal_log_collection(meal_log, user_id=actor_user_id)
            outcome = "appended"
            action = ActivityAction.UPDATE
            summary = f"追加了{_meal_type_label(request.meal_type)}"
        else:
            if existing_food_ids:
                try:
                    locked_foods = lock_inventory_targets(
                        db,
                        family_id=family_id,
                        food_ids=existing_food_ids,
                    ).foods
                except InventoryTargetNotFoundError as exc:
                    raise MealRecordValidationError(
                        MEAL_LOG_FOOD_NOT_FOUND_CODE,
                        MEAL_LOG_FOOD_NOT_FOUND_MESSAGE,
                    ) from exc
                if len(locked_foods) != len(existing_food_ids):
                    raise MealRecordValidationError(
                        MEAL_LOG_FOOD_NOT_FOUND_CODE,
                        MEAL_LOG_FOOD_NOT_FOUND_MESSAGE,
                    )

            client_to_food_id, created_foods = _create_inline_foods(
                db,
                family_id=family_id,
                actor_user_id=actor_user_id,
                request=request,
            )
            entry_writes = _resolve_entry_writes(request, client_to_food_id=client_to_food_id)
            meal_log, created_entries = create_meal_log_with_entries(
                db,
                family_id=family_id,
                user_id=actor_user_id,
                date=request.date,
                meal_type=request.meal_type,
                entries=entry_writes,
                participant_user_ids=[actor_user_id],
                meal_log_id=operation.meal_log_id,
            )
            outcome = "created"
            action = ActivityAction.CREATE
            day_label = "今天" if request.date == today_for_family(family_id) else request.date.isoformat()
            summary = f"记录了{day_label}的{_meal_type_label(request.meal_type)}"

        operation.created_entry_ids_json = [entry.id for entry in created_entries]
        operation.created_food_ids_json = [food.id for food in created_foods]
        operation.meal_log_id = meal_log.id

        # Persist mutations before reload/serialize so row_version and entries are current.
        db.flush()

        meal_log_payload = _serialize_meal_log_payload(db, family_id=family_id, meal_log_id=meal_log.id)
        created_foods_payload = _serialize_created_foods(db, family_id=family_id, foods=created_foods)
        response_payload = {
            "meal_log": meal_log_payload,
            "created_foods": created_foods_payload,
            "outcome": outcome,
            "operation": _build_operation_out(operation, now=now),
        }
        operation.result_json = jsonable_encoder(response_payload)

        log_activity(
            db,
            family_id=family_id,
            actor_id=actor_user_id,
            action=action,
            entity_type="MealLog",
            entity_id=meal_log.id,
            summary=summary,
            highlight=ActivityHighlight(
                kind=ActivityHighlightKind.MEAL,
                summary=f"记录了{_meal_type_label(meal_log.meal_type)}",
            ),
        )
        db.flush()
        return RecordMealResponse.model_validate(response_payload)
    except Exception:
        # Route always rolls back on error; re-raise domain errors as-is.
        raise
