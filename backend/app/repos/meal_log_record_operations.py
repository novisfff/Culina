from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import MealLogRecordStatus, MealLogRecordTargetKind
from app.core.utils import create_id
from app.models.domain import MealLogRecordOperation

IDEMPOTENCY_KEY_REUSED_CODE = "idempotency_key_reused"
IDEMPOTENCY_KEY_REUSED_MESSAGE = "相同请求标识已用于不同内容，请使用新的请求标识"
RECORD_OPERATION_REVERTED_CODE = "record_operation_reverted"
RECORD_OPERATION_REVERTED_MESSAGE = "该快速记录已被撤销，请重新发起记录"
RECORD_REVERT_WINDOW = timedelta(minutes=15)


def _as_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class MealRecordIdempotencyError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def find_record_operation(
    db: Session,
    *,
    family_id: str,
    client_request_id: str,
) -> MealLogRecordOperation | None:
    return db.scalar(
        select(MealLogRecordOperation).where(
            MealLogRecordOperation.family_id == family_id,
            MealLogRecordOperation.client_request_id == client_request_id,
        )
    )


def find_idempotent_record_operation(
    db: Session,
    *,
    family_id: str,
    client_request_id: str,
    request_hash: str,
) -> MealLogRecordOperation | None:
    """Return the existing operation when hash matches; raise on hash conflict or revert."""
    existing = find_record_operation(
        db,
        family_id=family_id,
        client_request_id=client_request_id,
    )
    if existing is None:
        return None
    if existing.request_hash != request_hash:
        raise MealRecordIdempotencyError(
            IDEMPOTENCY_KEY_REUSED_CODE,
            IDEMPOTENCY_KEY_REUSED_MESSAGE,
        )
    if existing.status == MealLogRecordStatus.REVERTED:
        raise MealRecordIdempotencyError(
            RECORD_OPERATION_REVERTED_CODE,
            RECORD_OPERATION_REVERTED_MESSAGE,
        )
    return existing


def claim_record_operation(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    client_request_id: str,
    request_hash: str,
    target_kind: MealLogRecordTargetKind | str,
    meal_log_id: str,
    now: datetime,
) -> tuple[MealLogRecordOperation, bool]:
    """Claim a unique (family_id, client_request_id) operation with non-null meal_log_id.

    Returns (operation, created_by_this_request). Race-safe via unique insert;
    same hash replays, different hash / reverted status raise structured errors.
    Losers never continue with their preallocated meal_log_id.
    """
    existing = find_idempotent_record_operation(
        db,
        family_id=family_id,
        client_request_id=client_request_id,
        request_hash=request_hash,
    )
    if existing is not None:
        return existing, False

    resolved_kind = (
        target_kind
        if isinstance(target_kind, MealLogRecordTargetKind)
        else MealLogRecordTargetKind(target_kind)
    )
    operation = MealLogRecordOperation(
        id=create_id("meal-record-op"),
        family_id=family_id,
        client_request_id=client_request_id,
        request_hash=request_hash,
        status=MealLogRecordStatus.APPLIED,
        target_kind=resolved_kind,
        meal_log_id=meal_log_id,
        created_entry_ids_json=[],
        created_food_ids_json=[],
        result_json={},
        revert_result_json=None,
        created_by=actor_user_id,
        applied_at=now,
        revertible_until=now + RECORD_REVERT_WINDOW,
    )
    db.add(operation)
    try:
        db.flush()
    except IntegrityError:
        # Claim is the first write. Full rollback is safe and avoids SAVEPOINT quirks.
        db.rollback()
        winner = find_idempotent_record_operation(
            db,
            family_id=family_id,
            client_request_id=client_request_id,
            request_hash=request_hash,
        )
        if winner is None:
            raise
        return winner, False

    return operation, True


def get_family_record_operation(
    db: Session,
    *,
    family_id: str,
    operation_id: str,
    for_update: bool = False,
) -> MealLogRecordOperation | None:
    """Load one family-scoped record operation, optionally with FOR UPDATE."""
    stmt = select(MealLogRecordOperation).where(
        MealLogRecordOperation.family_id == family_id,
        MealLogRecordOperation.id == operation_id,
    )
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def list_active_record_operations_for_actor(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    now: datetime,
) -> list[MealLogRecordOperation]:
    """Return the actor's APPLIED operations still inside the revert window, newest first."""
    current = _as_aware(now)
    operations = list(
        db.scalars(
            select(MealLogRecordOperation)
            .where(
                MealLogRecordOperation.family_id == family_id,
                MealLogRecordOperation.created_by == actor_user_id,
                MealLogRecordOperation.status == MealLogRecordStatus.APPLIED,
            )
            .order_by(
                MealLogRecordOperation.applied_at.desc(),
                MealLogRecordOperation.id.desc(),
            )
        )
    )
    return [item for item in operations if _as_aware(item.revertible_until) >= current]
