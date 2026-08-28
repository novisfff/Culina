"""Durable maintenance for family-managed model resources.

External Qdrant work is represented by database tombstones and leases.  A
worker may crash at any point without losing either an ensure or a delete; the
next worker run resumes from the durable operation rather than discovering
work by scanning live profile rows.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Event, Thread
from typing import Protocol
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import (
    FamilyModelResourceOperationType,
    FamilyModelSearchProfileStatus,
)
from app.core.utils import utcnow
from app.db.session import SessionLocal
from app.models.domain import Family
from app.models.family_model_settings import (
    FamilyModelConfigDraft,
    FamilyModelSettings,
    FamilySearchProfile,
)
from app.repos.family_model_settings.configurations import get_config_draft
from app.repos.family_model_settings.resource_operations import (
    ClaimedResourceOperation,
    claim_next_resource_operation,
    complete_claimed_resource_operation,
    get_resource_operation,
    get_claimed_resource_operation,
    has_delete_collection_tombstone,
    insert_delete_collection_operation,
    retry_claimed_resource_operation,
    suppress_ensure_collection_operations,
)
from app.repos.family_model_settings.profiles import (
    get_family_model_settings,
    lock_family_model_settings,
)
from app.services.family_model_settings.credentials import destroy_eligible_revoked_secrets
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.publishing import (
    apply_validated_family_model_configuration,
)
from app.services.family_model_settings.drafts import (
    _active_runtime_baseline,
    _independent_validation,
    _safe_payload_from_raw,
)
from app.services.family_model_settings.search_profiles import seed_search_profile_documents
from app.services.search.vector_store import build_vector_store


logger = logging.getLogger(__name__)


class SearchCollectionAdmin(Protocol):
    def ensure_collection(self, *, collection: str, dimensions: int) -> None:
        ...

    def delete_collection(self, *, collection: str) -> None:
        ...


class VectorStoreCollectionAdmin:
    """Adapt the existing collection-bound VectorStore to maintenance work."""

    def ensure_collection(self, *, collection: str, dimensions: int) -> None:
        build_vector_store(get_settings(), qdrant_collection=collection).ensure_collection(
            vector_size=dimensions
        )

    def delete_collection(self, *, collection: str) -> None:
        build_vector_store(get_settings(), qdrant_collection=collection).delete_collection()


@dataclass(frozen=True, slots=True)
class FamilyModelMaintenanceStats:
    destroyed_secrets: int
    queued_collection_deletes: int
    applied_configurations: int


@dataclass(frozen=True, slots=True)
class ResourceOperationProcessingStats:
    completed: int = 0
    retried: int = 0
    suppressed: int = 0


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def queue_expired_search_profile_cleanup_tombstones(
    db: Session,
    *,
    cutoff: datetime,
) -> int:
    """Queue old inactive collections for deletion without making a network call."""

    queued = 0
    candidates = tuple(
        db.scalars(
            select(FamilySearchProfile)
            .where(
                FamilySearchProfile.status.in_(
                    (
                        FamilyModelSearchProfileStatus.SUPERSEDED,
                        FamilyModelSearchProfileStatus.FAILED,
                        FamilyModelSearchProfileStatus.CANCELLED,
                        FamilyModelSearchProfileStatus.RETIRED,
                    )
                )
            )
            .order_by(
                FamilySearchProfile.family_id.asc(),
                FamilySearchProfile.created_at.asc(),
                FamilySearchProfile.id.asc(),
            )
            .with_for_update()
        )
    )
    for profile in candidates:
        settings = get_family_model_settings(db, family_id=profile.family_id)
        if settings is not None and settings.active_search_profile_id == profile.id:
            continue
        inactive_since = profile.retired_at or profile.cancelled_at or profile.created_at
        if _as_utc(inactive_since) > _as_utc(cutoff):
            continue
        resource_key = f"delete-search-profile:{profile.id}"
        existing = get_resource_operation(
            db,
            family_id=profile.family_id,
            operation_type=FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION,
            resource_key=resource_key,
            for_update=True,
        )
        if existing is None:
            insert_delete_collection_operation(
                db,
                family_id=profile.family_id,
                search_profile_id=profile.id,
                qdrant_collection=profile.qdrant_collection,
            )
            queued += 1
    db.flush()
    return queued


def delete_family_with_model_cleanup(
    db: Session,
    *,
    family_id: str,
    now: datetime | None = None,
) -> bool:
    """Write collection tombstones before cascading family-owned rows away."""

    current = now or utcnow()
    family = db.get(Family, family_id)
    if family is None:
        return False
    profiles = tuple(
        db.scalars(
            select(FamilySearchProfile)
            .where(FamilySearchProfile.family_id == family_id)
            .order_by(FamilySearchProfile.created_at.asc(), FamilySearchProfile.id.asc())
            .with_for_update()
        )
    )
    collections = tuple(profile.qdrant_collection for profile in profiles if profile.qdrant_collection)
    for profile in profiles:
        if profile.qdrant_collection:
            insert_delete_collection_operation(
                db,
                family_id=family_id,
                search_profile_id=profile.id,
                qdrant_collection=profile.qdrant_collection,
            )
    suppress_ensure_collection_operations(
        db,
        family_id=family_id,
        qdrant_collections=collections,
        now=current,
    )
    db.delete(family)
    db.flush()
    return True


def maintain_family_model_settings(
    db: Session,
    *,
    now: datetime | None = None,
    network_policy: ProviderNetworkPolicy | None = None,
) -> FamilyModelMaintenanceStats:
    current = now or utcnow()
    app_settings = get_settings()
    applied = 0
    legacy_family_ids = tuple(
        db.scalars(
            select(FamilyModelConfigDraft.family_id)
            .join(
                FamilyModelSettings,
                FamilyModelSettings.family_id == FamilyModelConfigDraft.family_id,
            )
            .where(
                FamilyModelSettings.active_config_revision_id.is_(None),
                FamilyModelConfigDraft.validation_status.in_(("valid", "invalid")),
            )
            .order_by(FamilyModelConfigDraft.family_id.asc())
        )
    )
    policy = (
        network_policy or ProviderNetworkPolicy.from_settings(app_settings)
        if legacy_family_ids
        else None
    )
    for family_id in legacy_family_ids:
        assert policy is not None
        # Keep the same settings -> draft lock order as the request path. A
        # legacy valid/invalid draft may contain several cards; apply every
        # independently valid card and leave only the unresolved cards in the
        # draft instead of allowing one historical failure to block all of
        # them.
        family_settings = lock_family_model_settings(db, family_id=family_id)
        current_draft = get_config_draft(db, family_id=family_id, for_update=True)
        if (
            family_settings.active_config_revision_id is not None
            or current_draft is None
            or current_draft.updated_by is None
        ):
            continue
        actor_user_id = current_draft.updated_by
        payload, payload_issues = _safe_payload_from_raw(current_draft.payload_json)
        baseline_payload, baseline_rows = _active_runtime_baseline(
            db,
            settings=family_settings,
        )
        validation, issues, successful = _independent_validation(
            db,
            family_id=family_id,
            settings=family_settings,
            payload=payload,
            baseline_payload=baseline_payload,
            baseline_binding_rows=baseline_rows,
            network_policy=policy,
            draft_version_number=current_draft.draft_version_number,
            # Maintenance must never silently acknowledge creation of the
            # first vector index; that remains an explicit Owner action.
            confirm_initial_search_index=False,
        )
        if validation is None or not successful:
            all_issues = tuple(dict.fromkeys((*issues, *payload_issues)))
            current_draft.validation_status = "invalid" if all_issues else current_draft.validation_status
            current_draft.validation_errors_json = [issue.record() for issue in all_issues]
            continue
        apply_validated_family_model_configuration(
            db,
            family_id=family_id,
            actor_user_id=actor_user_id,
            settings=family_settings,
            draft=current_draft,
            validation=validation,
            network_policy=policy,
        )
        all_issues = tuple(dict.fromkeys((*issues, *payload_issues)))
        current_draft.validation_status = "invalid" if all_issues else "valid"
        current_draft.validation_errors_json = [issue.record() for issue in all_issues]
        applied += 1
    destroyed = destroy_eligible_revoked_secrets(
        db,
        cutoff=current
        - timedelta(hours=app_settings.family_model_revoked_secret_retention_hours),
    )
    queued = queue_expired_search_profile_cleanup_tombstones(
        db,
        cutoff=current
        - timedelta(days=app_settings.family_model_retired_collection_retention_days),
    )
    return FamilyModelMaintenanceStats(
        destroyed_secrets=len(destroyed),
        queued_collection_deletes=queued,
        applied_configurations=applied,
    )


def _run_remote_operation(
    operation: ClaimedResourceOperation,
    *,
    qdrant_admin: SearchCollectionAdmin,
) -> None:
    if operation.operation_type is FamilyModelResourceOperationType.ENSURE_SEARCH_PROFILE_COLLECTION:
        dimensions = operation.payload_json.get("dimensions")
        if isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions <= 0:
            raise ValueError("family_model_resource_operation_invalid_dimensions")
        qdrant_admin.ensure_collection(
            collection=operation.qdrant_collection_snapshot,
            dimensions=dimensions,
        )
        return
    if operation.operation_type is FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION:
        qdrant_admin.delete_collection(collection=operation.qdrant_collection_snapshot)
        return
    raise ValueError("family_model_resource_operation_unknown")


def _complete_operation_after_remote_success(
    db: Session,
    *,
    operation: ClaimedResourceOperation,
    now: datetime,
) -> bool:
    current = get_claimed_resource_operation(
        db,
        operation_id=operation.id,
        lease_owner=operation.lease_owner,
    )
    if current is None:
        return False
    if operation.operation_type is FamilyModelResourceOperationType.ENSURE_SEARCH_PROFILE_COLLECTION:
        if not has_delete_collection_tombstone(
            db,
            family_id=operation.family_id_snapshot,
            qdrant_collection=operation.qdrant_collection_snapshot,
        ) and operation.search_profile_id_snapshot:
            profile = db.scalar(
                select(FamilySearchProfile).where(
                    FamilySearchProfile.family_id == operation.family_id_snapshot,
                    FamilySearchProfile.id == operation.search_profile_id_snapshot,
                    FamilySearchProfile.qdrant_collection
                    == operation.qdrant_collection_snapshot,
                )
            )
            if profile is not None:
                # This is intentionally idempotent: a crash after Qdrant
                # creation but before this commit replays the ensure and fills
                # only missing profile-document jobs.
                seed_search_profile_documents(
                    db,
                    family_id=profile.family_id,
                    profile_id=profile.id,
                )
    elif operation.operation_type is FamilyModelResourceOperationType.DELETE_SEARCH_PROFILE_COLLECTION:
        if operation.search_profile_id_snapshot:
            profile = db.scalar(
                select(FamilySearchProfile)
                .where(
                    FamilySearchProfile.family_id == operation.family_id_snapshot,
                    FamilySearchProfile.id == operation.search_profile_id_snapshot,
                    FamilySearchProfile.qdrant_collection
                    == operation.qdrant_collection_snapshot,
                )
                .with_for_update()
            )
            if profile is not None and profile.status is not FamilyModelSearchProfileStatus.ACTIVE:
                profile.status = FamilyModelSearchProfileStatus.RETIRED
                profile.retired_at = now
    complete_claimed_resource_operation(current, now=now)
    db.flush()
    return True


def _retry_operation(
    db: Session,
    *,
    operation: ClaimedResourceOperation,
    now: datetime,
) -> bool:
    current = get_claimed_resource_operation(
        db,
        operation_id=operation.id,
        lease_owner=operation.lease_owner,
    )
    if current is None:
        return False
    retry_claimed_resource_operation(
        current,
        now=now,
        error_code="family_model_resource_operation_failed",
    )
    db.flush()
    return True


def _process_resource_operations_with_session_factory(
    *,
    session_factory: Callable[[], Session],
    now: datetime,
    qdrant_admin: SearchCollectionAdmin,
    limit: int,
) -> ResourceOperationProcessingStats:
    completed = retried = suppressed = 0
    lease_owner = f"family-model-maintenance:{uuid4().hex}"
    for _ in range(limit):
        with session_factory() as claim_db:
            with claim_db.begin():
                operation = claim_next_resource_operation(
                    claim_db,
                    now=now,
                    lease_owner=lease_owner,
                )
        if operation is None:
            break
        try:
            _run_remote_operation(operation, qdrant_admin=qdrant_admin)
        except Exception:
            # Do not log endpoint, collection or error-string data. Those can
            # include deployment topology or provider-controlled content.
            logger.warning(
                "Family model resource operation will retry operation_id=%s type=%s",
                operation.id,
                operation.operation_type.value,
            )
            with session_factory() as retry_db:
                with retry_db.begin():
                    retried += int(_retry_operation(retry_db, operation=operation, now=now))
            continue
        with session_factory() as completion_db:
            with completion_db.begin():
                completed_now = _complete_operation_after_remote_success(
                    completion_db,
                    operation=operation,
                    now=now,
                )
                completed += int(completed_now)
                suppressed += int(not completed_now)
    return ResourceOperationProcessingStats(
        completed=completed,
        retried=retried,
        suppressed=suppressed,
    )


def _process_resource_operations_in_session(
    db: Session,
    *,
    now: datetime,
    qdrant_admin: SearchCollectionAdmin,
    limit: int,
) -> ResourceOperationProcessingStats:
    """Test/in-process form; callers own the transaction boundary."""

    completed = retried = suppressed = 0
    lease_owner = f"family-model-maintenance:{uuid4().hex}"
    for _ in range(limit):
        operation = claim_next_resource_operation(db, now=now, lease_owner=lease_owner)
        if operation is None:
            break
        try:
            _run_remote_operation(operation, qdrant_admin=qdrant_admin)
        except Exception:
            retried += int(_retry_operation(db, operation=operation, now=now))
            continue
        completed_now = _complete_operation_after_remote_success(
            db,
            operation=operation,
            now=now,
        )
        completed += int(completed_now)
        suppressed += int(not completed_now)
    return ResourceOperationProcessingStats(
        completed=completed,
        retried=retried,
        suppressed=suppressed,
    )


def process_family_model_resource_operations(
    db: Session | None = None,
    *,
    now: datetime | None = None,
    qdrant_admin: SearchCollectionAdmin | None = None,
    session_factory: Callable[[], Session] | None = None,
    limit: int = 20,
) -> ResourceOperationProcessingStats:
    """Run due operations with durable leases and idempotent external calls."""

    if limit <= 0:
        raise ValueError("family model resource operation limit must be positive")
    current = now or utcnow()
    admin = qdrant_admin or VectorStoreCollectionAdmin()
    if db is not None:
        return _process_resource_operations_in_session(
            db,
            now=current,
            qdrant_admin=admin,
            limit=limit,
        )
    return _process_resource_operations_with_session_factory(
        session_factory=session_factory or SessionLocal,
        now=current,
        qdrant_admin=admin,
        limit=limit,
    )


class FamilyModelSettingsMaintenanceWorker:
    """Short-transaction worker for legacy activation, secret retention and collection outbox."""

    def __init__(
        self,
        *,
        session_factory: Callable[[], Session] = SessionLocal,
        qdrant_admin: SearchCollectionAdmin | None = None,
        poll_interval_seconds: float = 15.0,
        now: Callable[[], datetime] = utcnow,
    ) -> None:
        if poll_interval_seconds <= 0:
            raise ValueError("family model maintenance poll interval must be positive")
        self._session_factory = session_factory
        self._qdrant_admin = qdrant_admin
        self._poll_interval_seconds = poll_interval_seconds
        self._now = now
        self._stop_event = Event()
        self._thread: Thread | None = None

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def run_once(self) -> tuple[FamilyModelMaintenanceStats, ResourceOperationProcessingStats]:
        with self._session_factory() as db:
            with db.begin():
                maintenance = maintain_family_model_settings(db, now=self._now())
        operations = process_family_model_resource_operations(
            now=self._now(),
            qdrant_admin=self._qdrant_admin,
            session_factory=self._session_factory,
        )
        return maintenance, operations

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                logger.exception("Family model settings maintenance batch failed")
            self._stop_event.wait(self._poll_interval_seconds)

    def start(self) -> None:
        if self.is_running:
            return
        self._stop_event.clear()
        self._thread = Thread(
            target=self._run_loop,
            name="family-model-settings-maintenance",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self._poll_interval_seconds * 3))
