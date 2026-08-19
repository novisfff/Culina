from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.enums import (
    FamilyModelResourceOperationStatus,
    FamilyModelResourceOperationType,
)
from app.core.utils import create_id
from app.models.family_model_settings import (
    FamilyModelResourceOperation,
    FamilySearchProfile,
)


RESOURCE_OPERATION_LEASE = timedelta(minutes=2)


@dataclass(frozen=True, slots=True)
class ClaimedResourceOperation:
    """Serializable work leased to the maintenance worker.

    The worker deliberately carries only snapshots across the database/network
    boundary.  It never keeps an ORM instance or an application request
    session open while talking to Qdrant.
    """

    id: str
    lease_owner: str
    operation_type: FamilyModelResourceOperationType
    family_id_snapshot: str
    search_profile_id_snapshot: str | None
    qdrant_collection_snapshot: str
    payload_json: dict[str, object]


def get_resource_operation(
    db: Session,
    *,
    family_id: str,
    operation_type: FamilyModelResourceOperationType,
    resource_key: str,
    for_update: bool = False,
) -> FamilyModelResourceOperation | None:
    statement = select(FamilyModelResourceOperation).where(
        FamilyModelResourceOperation.family_id_snapshot == family_id,
        FamilyModelResourceOperation.operation_type == operation_type,
        FamilyModelResourceOperation.resource_key == resource_key,
    )
    if for_update:
        statement = statement.with_for_update()
    return db.scalar(statement)


def insert_ensure_collection_operation(
    db: Session,
    *,
    search_profile: FamilySearchProfile,
) -> FamilyModelResourceOperation:
    """Persist an idempotent post-commit Qdrant ensure operation.

    The operation's family/profile fields are snapshots by design: cleanup and
    repair workers can still process it after ordinary family rows have been
    removed by cascades.
    """

    resource_key = f"ensure-search-profile:{search_profile.id}"
    existing = get_resource_operation(
        db,
        family_id=search_profile.family_id,
        operation_type=FamilyModelResourceOperationType.ENSURE_SEARCH_PROFILE_COLLECTION,
        resource_key=resource_key,
    )
    if existing is not None:
        return existing
    operation = FamilyModelResourceOperation(
        id=create_id("family-model-resource-operation"),
        operation_type=FamilyModelResourceOperationType.ENSURE_SEARCH_PROFILE_COLLECTION,
        resource_key=resource_key,
        family_id_snapshot=search_profile.family_id,
        search_profile_id_snapshot=search_profile.id,
        qdrant_collection_snapshot=search_profile.qdrant_collection,
        payload_json={
            "document_builder_version": search_profile.document_builder_version,
            "dimensions": search_profile.dimensions,
            "distance": search_profile.distance,
        },
        status=FamilyModelResourceOperationStatus.PENDING,
    )
    db.add(operation)
    db.flush()
    return operation


def insert_delete_collection_operation(
    db: Session,
    *,
    family_id: str,
    search_profile_id: str | None,
    qdrant_collection: str,
) -> FamilyModelResourceOperation:
    """Persist a non-cascading tombstone for an obsolete collection."""

    if not family_id or not qdrant_collection:
        raise ValueError("family model collection cleanup identity is required")
    resource_key = (
        f"delete-search-profile:{search_profile_id}"
        if search_profile_id
        else f"delete-search-collection:{family_id}:{qdrant_collection}"
    )
    existing = get_resource_operation(
        db,
        family_id=family_id,
        operation_type=FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION,
        resource_key=resource_key,
    )
    if existing is not None:
        return existing
    operation = FamilyModelResourceOperation(
        id=create_id("family-model-resource-operation"),
        operation_type=FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION,
        resource_key=resource_key,
        family_id_snapshot=family_id,
        search_profile_id_snapshot=search_profile_id,
        qdrant_collection_snapshot=qdrant_collection,
        payload_json={},
        status=FamilyModelResourceOperationStatus.PENDING,
    )
    db.add(operation)
    db.flush()
    return operation


def has_delete_collection_tombstone(
    db: Session,
    *,
    family_id: str,
    qdrant_collection: str,
) -> bool:
    """A completed tombstone also suppresses a stale ensure forever."""

    return (
        db.scalar(
            select(FamilyModelResourceOperation.id).where(
                FamilyModelResourceOperation.family_id_snapshot == family_id,
                FamilyModelResourceOperation.qdrant_collection_snapshot == qdrant_collection,
                FamilyModelResourceOperation.operation_type
                == FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION,
            )
        )
        is not None
    )


def suppress_ensure_collection_operations(
    db: Session,
    *,
    family_id: str,
    qdrant_collections: tuple[str, ...],
    now: datetime,
) -> int:
    """Mark queued ensure work superseded by durable delete tombstones."""

    if not qdrant_collections:
        return 0
    operations = tuple(
        db.scalars(
            select(FamilyModelResourceOperation)
            .where(
                FamilyModelResourceOperation.family_id_snapshot == family_id,
                FamilyModelResourceOperation.qdrant_collection_snapshot.in_(qdrant_collections),
                FamilyModelResourceOperation.operation_type
                == FamilyModelResourceOperationType.ENSURE_SEARCH_PROFILE_COLLECTION,
                FamilyModelResourceOperation.status.in_(
                    (
                        FamilyModelResourceOperationStatus.PENDING,
                        FamilyModelResourceOperationStatus.RUNNING,
                        FamilyModelResourceOperationStatus.RETRY_WAIT,
                    )
                ),
            )
            .with_for_update()
        )
    )
    for operation in operations:
        operation.status = FamilyModelResourceOperationStatus.COMPLETED
        operation.completed_at = now
        operation.lease_owner = None
        operation.lease_expires_at = None
        operation.last_error_code = "family_model_collection_delete_supersedes_ensure"
    db.flush()
    return len(operations)


def claim_next_resource_operation(
    db: Session,
    *,
    now: datetime,
    lease_owner: str,
    lease_duration: timedelta = RESOURCE_OPERATION_LEASE,
) -> ClaimedResourceOperation | None:
    """Lease one due operation, recovering an expired worker lease safely."""

    due = or_(
        # A newly committed operation is immediately eligible.  ``available_at``
        # is a retry backoff field, not a delay for pending work; treating it as
        # one can strand an operation when the worker's clock is marginally
        # behind the transaction that inserted it.
        FamilyModelResourceOperation.status
        == FamilyModelResourceOperationStatus.PENDING,
        and_(
            FamilyModelResourceOperation.status
            == FamilyModelResourceOperationStatus.RETRY_WAIT,
            FamilyModelResourceOperation.available_at <= now,
        ),
        and_(
            FamilyModelResourceOperation.status == FamilyModelResourceOperationStatus.RUNNING,
            FamilyModelResourceOperation.lease_expires_at.is_not(None),
            FamilyModelResourceOperation.lease_expires_at <= now,
        ),
    )
    while True:
        operation = db.scalar(
            select(FamilyModelResourceOperation)
            .where(due)
            .order_by(
                FamilyModelResourceOperation.available_at.asc(),
                FamilyModelResourceOperation.created_at.asc(),
                FamilyModelResourceOperation.id.asc(),
            )
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if operation is None:
            return None
        if (
            operation.operation_type
            is FamilyModelResourceOperationType.ENSURE_SEARCH_PROFILE_COLLECTION
            and has_delete_collection_tombstone(
                db,
                family_id=operation.family_id_snapshot,
                qdrant_collection=operation.qdrant_collection_snapshot,
            )
        ):
            operation.status = FamilyModelResourceOperationStatus.COMPLETED
            operation.completed_at = now
            operation.lease_owner = None
            operation.lease_expires_at = None
            operation.last_error_code = "family_model_collection_delete_supersedes_ensure"
            db.flush()
            continue
        operation.status = FamilyModelResourceOperationStatus.RUNNING
        operation.attempt_count += 1
        operation.lease_owner = lease_owner
        operation.lease_expires_at = now + lease_duration
        operation.last_error_code = None
        db.flush()
        return ClaimedResourceOperation(
            id=operation.id,
            lease_owner=lease_owner,
            operation_type=operation.operation_type,
            family_id_snapshot=operation.family_id_snapshot,
            search_profile_id_snapshot=operation.search_profile_id_snapshot,
            qdrant_collection_snapshot=operation.qdrant_collection_snapshot,
            payload_json=dict(operation.payload_json or {}),
        )


def get_claimed_resource_operation(
    db: Session,
    *,
    operation_id: str,
    lease_owner: str,
) -> FamilyModelResourceOperation | None:
    return db.scalar(
        select(FamilyModelResourceOperation)
        .where(
            FamilyModelResourceOperation.id == operation_id,
            FamilyModelResourceOperation.status == FamilyModelResourceOperationStatus.RUNNING,
            FamilyModelResourceOperation.lease_owner == lease_owner,
        )
        .with_for_update()
    )


def complete_claimed_resource_operation(
    operation: FamilyModelResourceOperation,
    *,
    now: datetime,
) -> None:
    operation.status = FamilyModelResourceOperationStatus.COMPLETED
    operation.completed_at = now
    operation.available_at = now
    operation.lease_owner = None
    operation.lease_expires_at = None
    operation.last_error_code = None


def retry_claimed_resource_operation(
    operation: FamilyModelResourceOperation,
    *,
    now: datetime,
    error_code: str,
) -> None:
    """Schedule bounded exponential retry without losing the tombstone."""

    delay_seconds = min(3600, 2 ** min(max(operation.attempt_count, 1), 11))
    operation.status = FamilyModelResourceOperationStatus.RETRY_WAIT
    operation.available_at = now + timedelta(seconds=delay_seconds)
    operation.lease_owner = None
    operation.lease_expires_at = None
    operation.last_error_code = error_code[:120]
