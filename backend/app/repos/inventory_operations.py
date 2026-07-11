from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import InventoryOperationStatus, InventoryOperationType
from app.core.utils import create_id, utcnow
from app.models.domain import InventoryOperation
from app.schemas.inventory_operations import InventoryOperationDisplaySummary
from app.services.inventory_versions import InventoryConflictError

IDEMPOTENCY_KEY_REUSED_CODE = "idempotency_key_reused"
IDEMPOTENCY_KEY_REUSED_DETAIL = "相同请求标识已用于不同内容，请使用新的请求标识"


def _idempotency_conflict() -> InventoryConflictError:
    return InventoryConflictError(
        IDEMPOTENCY_KEY_REUSED_DETAIL,
        code=IDEMPOTENCY_KEY_REUSED_CODE,
        conflicts=[],
    )


def find_idempotent_operation(
    db: Session,
    *,
    family_id: str,
    client_request_id: str,
    request_hash: str,
) -> InventoryOperation | None:
    """Return the existing family-scoped operation when the hash matches.

    Raises InventoryConflictError(code=idempotency_key_reused) when the same
    client_request_id exists with a different request_hash.
    """
    existing = db.scalar(
        select(InventoryOperation).where(
            InventoryOperation.family_id == family_id,
            InventoryOperation.client_request_id == client_request_id,
        )
    )
    if existing is None:
        return None
    if existing.request_hash != request_hash:
        raise _idempotency_conflict()
    return existing


def claim_inventory_operation(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    operation_type: InventoryOperationType,
    client_request_id: str,
    request_hash: str,
    summary: InventoryOperationDisplaySummary,
) -> tuple[InventoryOperation, bool]:
    """Claim a unique (family_id, client_request_id) operation row.

    Returns (operation, created_by_this_request). Race-safe via begin_nested
    unique insert; same hash replays, different hash raises structured 409.
    """
    existing = find_idempotent_operation(
        db,
        family_id=family_id,
        client_request_id=client_request_id,
        request_hash=request_hash,
    )
    if existing is not None:
        return existing, False

    applied_at = utcnow()
    operation = InventoryOperation(
        id=create_id("inventory-operation"),
        family_id=family_id,
        operation_type=operation_type,
        status=InventoryOperationStatus.APPLIED,
        client_request_id=client_request_id,
        request_hash=request_hash,
        actor_id=actor_id,
        applied_at=applied_at,
        revertible_until=applied_at + timedelta(minutes=15),
        summary_json=summary.model_dump(mode="json"),
    )

    try:
        with db.begin_nested():
            db.add(operation)
            db.flush()
    except IntegrityError:
        winner = find_idempotent_operation(
            db,
            family_id=family_id,
            client_request_id=client_request_id,
            request_hash=request_hash,
        )
        if winner is None:
            raise
        return winner, False

    return operation, True
