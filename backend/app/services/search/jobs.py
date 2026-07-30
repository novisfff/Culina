from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Event, Thread
from typing import Callable

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import DISABLED_SEARCH_PROVIDERS, get_settings
from app.core.enums import (
    ModelUsageExecutionCertainty,
    ModelUsageReservationStatus,
)
from app.core.utils import create_id, utcnow
from app.db.session import SessionLocal
from app.models.domain import Food, FoodPlanItem, Ingredient, Recipe, SearchDocument, SearchIndexJob
from app.models.model_usage import ModelUsageEvent, ModelUsageFamilyPolicy, ModelUsageReservation
from app.services.model_usage.errors import (
    ModelUsageAttemptAlreadyAccounted,
    ModelUsageBlocked,
    ModelUsageError,
)
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.reservations import release_undispatched_reservation_in_session
from app.services.search.embeddings import EmbeddingClient, EmbeddingUnavailableError, build_embedding_client
from app.services.search.indexing import (
    delete_search_document,
    upsert_food_search_document,
    upsert_ingredient_search_document,
    upsert_meal_plan_search_document,
    upsert_recipe_search_document,
)
from app.services.search.vector_indexing import (
    clear_pending_vector,
    pending_vector_is_current,
    persist_pending_vector,
    prepare_pending_vector_handoff,
    snapshot_search_document,
    system_embedding_attribution,
    write_pending_vector_handoff,
)
from app.services.search.vector_store import VectorStore, VectorStoreUnavailableError, build_vector_store

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
JOB_LOCK_STALE_AFTER = timedelta(minutes=15)
WORKER_SCAN_INTERVAL_SECONDS = 3
ACTIVE_COMPLETED_WINDOW = timedelta(hours=24)
SEARCH_INDEX_ENTITY_TYPES = {"ingredient", "food", "recipe", "meal_plan"}
EMBEDDING_OUTPUT_UNAVAILABLE = "embedding_output_unavailable_after_provider_success"


def enqueue_search_index_job(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    entity_type: str,
    entity_id: str,
    target_name: str = "",
) -> SearchIndexJob:
    if entity_type not in SEARCH_INDEX_ENTITY_TYPES:
        raise ValueError("Unsupported search index entity type")
    now = utcnow()
    job = SearchIndexJob(
        id=create_id("search-index-job"),
        family_id=family_id,
        user_id=user_id,
        status="queued",
        entity_type=entity_type,
        entity_id=entity_id,
        target_name=target_name[:255],
        vector_status="pending",
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    db.flush()
    return job


def get_search_index_job(db: Session, *, family_id: str, job_id: str) -> SearchIndexJob | None:
    return db.scalar(select(SearchIndexJob).where(SearchIndexJob.family_id == family_id, SearchIndexJob.id == job_id))


def retry_failed_search_index_job(db: Session, *, family_id: str, job_id: str) -> SearchIndexJob | None:
    job = get_search_index_job(db, family_id=family_id, job_id=job_id)
    if job is None:
        return None
    if job.status != "failed":
        raise ValueError("Only failed search index jobs can be retried")
    now = utcnow()
    job.status = "queued"
    job.vector_status = "pending"
    job.error = None
    job.error_code = None
    job.budget_blocked_period_start = None
    job.budget_blocked_policy_version_id = None
    # Retain usage diagnostics and any durable pending vector.  A retry after a
    # Qdrant error must write the same vector, not start another provider send.
    job.locked_at = None
    job.started_at = None
    job.completed_at = None
    job.updated_at = now
    db.flush()
    return job


def list_active_search_index_jobs(db: Session, *, family_id: str) -> list[SearchIndexJob]:
    cutoff = utcnow() - ACTIVE_COMPLETED_WINDOW
    statement = (
        select(SearchIndexJob)
        .where(
            SearchIndexJob.family_id == family_id,
            or_(
                SearchIndexJob.status.in_(("queued", "running", "budget_blocked")),
                SearchIndexJob.completed_at >= cutoff,
            ),
        )
        .order_by(SearchIndexJob.created_at.desc(), SearchIndexJob.id)
        .limit(100)
    )
    return list(db.scalars(statement))


def can_requeue_budget_blocked(
    job: SearchIndexJob,
    *,
    period_start: datetime,
    policy_version_id: str,
) -> bool:
    return (
        _normalize_period_start(job.budget_blocked_period_start)
        != _normalize_period_start(period_start)
        or job.budget_blocked_policy_version_id != policy_version_id
    )


def _normalize_period_start(value: datetime | None) -> datetime | None:
    """Compare billing boundaries consistently across MySQL/SQLite reloads."""

    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _current_budget_scope(db: Session, *, family_id: str) -> tuple[datetime, str] | None:
    # Lock the policy pointer before a dependent job row.  That gives a policy
    # update and a blocked-job recovery one deterministic serialization point.
    pointer = db.scalar(
        select(ModelUsageFamilyPolicy)
        .where(ModelUsageFamilyPolicy.family_id == family_id)
        .with_for_update()
    )
    if pointer is None:
        return None
    return (
        shanghai_billing_period(utcnow()).start_at,
        pointer.current_policy_version_id,
    )


def _requeue_changed_budget_blocks(db: Session, *, limit: int) -> None:
    if limit <= 0:
        return
    now = utcnow()
    current_period_start = shanghai_billing_period(now).start_at
    # Filter at the database boundary first.  Selecting the oldest fixed
    # window and then discarding unchanged rows starves a later job whose
    # policy was actually relaxed, because the same old rows are selected on
    # every worker pass.
    candidate_rows = db.execute(
        select(SearchIndexJob.id, SearchIndexJob.family_id)
        .outerjoin(
            ModelUsageFamilyPolicy,
            ModelUsageFamilyPolicy.family_id == SearchIndexJob.family_id,
        )
        .where(
            SearchIndexJob.status == "budget_blocked",
            or_(
                ModelUsageFamilyPolicy.family_id.is_(None),
                SearchIndexJob.budget_blocked_period_start.is_(None),
                SearchIndexJob.budget_blocked_period_start != current_period_start,
                SearchIndexJob.budget_blocked_policy_version_id.is_(None),
                SearchIndexJob.budget_blocked_policy_version_id
                != ModelUsageFamilyPolicy.current_policy_version_id,
            ),
        )
        .order_by(SearchIndexJob.updated_at, SearchIndexJob.id)
        .limit(limit)
    ).all()
    for job_id, family_id in candidate_rows:
        # Re-read under pointer -> job locks, because the policy can have
        # changed between the candidate scan and this worker's decision.
        scope = _current_budget_scope(db, family_id=family_id)
        if scope is None:
            continue
        job = db.scalar(
            select(SearchIndexJob)
            .where(
                SearchIndexJob.id == job_id,
                SearchIndexJob.family_id == family_id,
                SearchIndexJob.status == "budget_blocked",
            )
            .with_for_update(skip_locked=True)
        )
        if job is None:
            continue
        if not can_requeue_budget_blocked(
            job,
            period_start=scope[0],
            policy_version_id=scope[1],
        ):
            continue
        job.status = "queued"
        job.vector_status = "pending"
        job.error = None
        job.error_code = None
        job.budget_blocked_period_start = None
        job.budget_blocked_policy_version_id = None
        job.locked_at = None
        job.started_at = None
        job.completed_at = None
        job.updated_at = now


def recover_interrupted_search_index_jobs(
    db: Session,
    *,
    include_all_running: bool = False,
    limit: int = 100,
) -> int:
    now = utcnow()
    stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
    running_filter = SearchIndexJob.status == "running"
    if not include_all_running:
        running_filter = and_(
            running_filter,
            or_(
                SearchIndexJob.locked_at.is_(None),
                SearchIndexJob.locked_at < stale_lock_cutoff,
            ),
        )
    jobs = list(
        db.scalars(
            select(SearchIndexJob)
            .where(running_filter)
            .order_by(SearchIndexJob.created_at, SearchIndexJob.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    )
    for job in jobs:
        if _attempt_output_is_unrecoverable(db, job=job):
            _mark_terminal_missing_output(job, now=now)
            continue
        pending = _job_document(db, job=job)
        has_pending = pending is not None and pending.pending_vector is not None
        attempt_count = job.attempt_count or 0
        job.status = "queued" if has_pending or attempt_count < MAX_ATTEMPTS else "failed"
        job.locked_at = None
        job.updated_at = now
        if job.status == "queued":
            job.completed_at = None
            job.error = None
            job.error_code = None
    if jobs:
        db.commit()
    return len(jobs)


def claim_pending_search_index_jobs(db: Session, *, limit: int = 4) -> list[str]:
    now = utcnow()
    _requeue_changed_budget_blocks(db, limit=max(limit * 4, 20))
    # The repository session deliberately uses ``autoflush=False``.  Make
    # freshly requeued jobs visible to this same worker scan rather than
    # delaying an already-relaxed budget block until its next interval.
    db.flush()
    stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
    jobs = list(
        db.scalars(
            select(SearchIndexJob)
            .where(
                or_(
                    SearchIndexJob.status == "queued",
                    # A failed job whose provider output is already durable
                    # gets unlimited Qdrant-only retries.
                    and_(
                        SearchIndexJob.status == "failed",
                        SearchIndexJob.vector_status == "pending",
                        SearchIndexJob.usage_attempt_key.is_not(None),
                    ),
                    and_(SearchIndexJob.status == "failed", SearchIndexJob.attempt_count < MAX_ATTEMPTS),
                    and_(SearchIndexJob.status == "running", SearchIndexJob.locked_at < stale_lock_cutoff),
                )
            )
            .order_by(SearchIndexJob.created_at, SearchIndexJob.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    )
    job_ids: list[str] = []
    for job in jobs:
        job.status = "running"
        job.locked_at = now
        job.started_at = job.started_at or now
        job.updated_at = now
        job_ids.append(job.id)
    if job_ids or db.dirty:
        db.commit()
    return job_ids


def process_search_index_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    claimed: bool = False,
    embedding_client: EmbeddingClient | None = None,
    vector_store: VectorStore | None = None,
) -> None:
    if not _start_job(job_id, session_factory=session_factory, claimed=claimed):
        return

    try:
        document_id = _upsert_job_document(job_id, session_factory=session_factory)
        if document_id is None:
            _finish_job(job_id, session_factory=session_factory, vector_status="skipped")
            return

        client = embedding_client or build_embedding_client()
        if not _embedding_enabled(client):
            _disable_document_vector(
                job_id,
                document_id=document_id,
                session_factory=session_factory,
            )
            _finish_job(job_id, session_factory=session_factory, vector_status="skipped")
            return

        store = vector_store or build_vector_store()
        if _handoff_existing_pending_vector(
            job_id,
            document_id=document_id,
            session_factory=session_factory,
            vector_store=store,
        ):
            return

        prepared = _prepare_embedding_attempt(
            job_id,
            document_id=document_id,
            session_factory=session_factory,
        )
        if prepared is None:
            return
        family_id, attempt_key, snapshot = prepared
        try:
            result = client.embed_text(
                snapshot.semantic_text,
                attribution=system_embedding_attribution(
                    family_id=family_id,
                    logical_operation_id=attempt_key,
                ),
                attempt_key=attempt_key,
            )
        except ModelUsageBlocked as exc:
            _mark_budget_blocked(
                job_id,
                exc=exc,
                session_factory=session_factory,
            )
            return
        except ModelUsageAttemptAlreadyAccounted:
            # A prior event exists but its provider output was not persisted.
            # The next recovery check turns this into the stable terminal state.
            _mark_terminal_from_attempt(job_id, session_factory=session_factory)
            return
        except EmbeddingUnavailableError:
            _mark_provider_failure(
                job_id,
                session_factory=session_factory,
                error="嵌入服务暂时不可用",
                error_code="search_embedding_unavailable",
            )
            return
        except ModelUsageError as exc:
            _mark_job_failure(
                job_id,
                session_factory=session_factory,
                error="模型用量服务暂时不可用",
                error_code=exc.code,
                increment_provider_attempt=False,
            )
            return

        if len(result.vectors) != 1:
            _mark_provider_failure(
                job_id,
                session_factory=session_factory,
                error="嵌入服务返回结果不完整",
                error_code="search_embedding_response_invalid",
            )
            return
        _persist_provider_vector(
            job_id,
            document_id=document_id,
            attempt_key=attempt_key,
            snapshot=snapshot,
            vector=result.vectors[0],
            usage_event_id=result.usage_event_id,
            session_factory=session_factory,
        )
        _handoff_existing_pending_vector(
            job_id,
            document_id=document_id,
            session_factory=session_factory,
            vector_store=store,
        )
    except ValueError as exc:
        _mark_provider_failure(
            job_id,
            session_factory=session_factory,
            error=str(exc) or "索引对象不存在或已删除",
            error_code="search_index_target_missing",
        )
    except Exception:
        # Do not include arbitrary provider/database details in the user-safe
        # job record.  The attempt key remains durable for conservative recovery.
        _mark_provider_failure(
            job_id,
            session_factory=session_factory,
            error="搜索索引更新失败",
            error_code="search_index_failed",
        )
        logger.exception("Search index job failed job_id=%s", job_id)


def _start_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
    claimed: bool,
) -> bool:
    with session_factory() as db:
        # A job can be submitted by the worker and an explicit retry at the
        # same time.  Lock its state transition so only one caller obtains the
        # provider-send ownership before the external embedding call.
        job = db.scalar(
            select(SearchIndexJob)
            .where(SearchIndexJob.id == job_id)
            .with_for_update()
        )
        if job is None:
            return False
        now = utcnow()
        stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
        if not claimed and job.status == "running" and job.locked_at and job.locked_at > stale_lock_cutoff:
            return False
        if job.status in {"succeeded", "budget_blocked"}:
            return False
        if job.status == "failed" and (job.attempt_count or 0) >= MAX_ATTEMPTS and job.vector_status != "pending":
            return False
        job.status = "running"
        job.locked_at = now
        job.started_at = job.started_at or now
        job.error = None
        job.error_code = None
        job.updated_at = now
        db.commit()
    return True


def _upsert_job_document(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> str | None:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            return None
        old_document = _job_document(db, job=job)
        old_content_hash = old_document.content_hash if old_document is not None else None
        document = _upsert_entity_search_document(db, job=job)
        if document is None:
            db.commit()
            return None
        if old_content_hash is not None and old_content_hash != document.content_hash:
            # This is a new content revision, not a retry of the old provider
            # attempt.  Clear only job diagnostics; the document helper has
            # already cleared any stale vector handoff state.
            job.usage_attempt_key = None
            job.usage_event_id = None
        job.vector_status = document.vector_status
        job.updated_at = utcnow()
        db.commit()
        return document.id


def _embedding_enabled(client: EmbeddingClient) -> bool:
    settings = get_settings()
    provider = str(getattr(settings, "search_embedding_provider", "disabled") or "disabled").strip().lower()
    return provider not in DISABLED_SEARCH_PROVIDERS and bool(client.model) and client.dimensions > 0


def _disable_document_vector(
    job_id: str,
    *,
    document_id: str,
    session_factory: Callable[[], Session],
) -> None:
    """Make disabled-provider work terminal without leaving a stale handoff."""

    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        document = _job_document(db, job=job, document_id=document_id)
        if document is None:
            return
        clear_pending_vector(document)
        document.vector_status = "disabled"
        document.vector_error = None
        document.vector_attempt_count = document.vector_attempt_count or 0
        document.last_vector_attempt_at = None
        document.indexed_at = None
        db.commit()


def _prepare_embedding_attempt(
    job_id: str,
    *,
    document_id: str,
    session_factory: Callable[[], Session],
) -> tuple[str, str, object] | None:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            return None
        document = _job_document(db, job=job, document_id=document_id)
        if document is None:
            _mark_job_failure_in_session(
                job,
                error="索引对象不存在或已删除",
                error_code="search_index_target_missing",
                increment_provider_attempt=False,
                now=utcnow(),
            )
            db.commit()
            return None
        if _attempt_output_is_unrecoverable(db, job=job):
            _mark_terminal_missing_output(job, now=utcnow())
            db.commit()
            return None
        if _attempt_was_never_dispatched(db, job=job):
            reservation = db.scalar(
                select(ModelUsageReservation).where(
                    ModelUsageReservation.family_id == job.family_id,
                    ModelUsageReservation.attempt_key == job.usage_attempt_key,
                )
            )
            if reservation is None or not release_undispatched_reservation_in_session(
                db,
                reservation_id=reservation.id,
                error_code="search_embedding_superseded_before_dispatch",
            ):
                _mark_terminal_missing_output(job, now=utcnow())
                db.commit()
                return None
        attempt_key = create_id("search-index-embedding")
        snapshot = snapshot_search_document(document)
        job.usage_attempt_key = attempt_key
        job.usage_event_id = None
        job.vector_status = "pending"
        job.error = None
        job.error_code = None
        job.updated_at = utcnow()
        db.commit()
        return job.family_id, attempt_key, snapshot


def _persist_provider_vector(
    job_id: str,
    *,
    document_id: str,
    attempt_key: str,
    snapshot: object,
    vector: list[float],
    usage_event_id: str | None,
    session_factory: Callable[[], Session],
) -> None:
    from app.services.search.vector_indexing import SearchDocumentIndexSnapshot

    if not isinstance(snapshot, SearchDocumentIndexSnapshot):
        raise TypeError("search document snapshot required")
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None or job.usage_attempt_key != attempt_key:
            return
        document = _job_document(db, job=job, document_id=document_id)
        if document is None:
            _mark_terminal_missing_output(job, now=utcnow())
            db.commit()
            return
        persist_pending_vector(document, vector=vector, snapshot=snapshot, now=utcnow())
        job.usage_event_id = usage_event_id
        job.vector_status = "pending"
        job.attempt_count = (job.attempt_count or 0) + 1
        job.error = None
        job.error_code = None
        job.updated_at = utcnow()
        db.commit()


def _handoff_existing_pending_vector(
    job_id: str,
    *,
    document_id: str,
    session_factory: Callable[[], Session],
    vector_store: VectorStore,
) -> bool:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            return True
        document = _job_document(db, job=job, document_id=document_id)
        if document is None or document.pending_vector is None:
            return False
        if not pending_vector_is_current(document):
            clear_pending_vector(document)
            job.usage_attempt_key = None
            job.usage_event_id = None
            job.status = "queued"
            job.vector_status = "pending"
            job.error = None
            job.error_code = None
            job.locked_at = None
            job.completed_at = None
            job.updated_at = utcnow()
            db.commit()
            return True
        pending_identity = _pending_identity(document)
        handoff = prepare_pending_vector_handoff(document)
        if handoff is None:
            clear_pending_vector(document)
            job.usage_attempt_key = None
            job.usage_event_id = None
            job.status = "queued"
            job.vector_status = "pending"
            job.error = None
            job.error_code = None
            job.locked_at = None
            job.completed_at = None
            job.updated_at = utcnow()
            db.commit()
            return True
        db.commit()

    try:
        write_pending_vector_handoff(handoff, vector_store=vector_store)
    except VectorStoreUnavailableError:
        with session_factory() as db:
            job = db.get(SearchIndexJob, job_id)
            document = _job_document(db, job=job, document_id=document_id) if job is not None else None
            if job is not None and document is not None and _pending_identity(document) == pending_identity:
                document.vector_status = "failed"
                document.vector_error = "搜索向量服务暂时不可用"
                _mark_job_failure_in_session(
                    job,
                    error="搜索向量服务暂时不可用",
                    error_code="search_vector_unavailable",
                    increment_provider_attempt=False,
                    vector_status="pending",
                    now=utcnow(),
                )
                db.commit()
        return True

    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        document = _job_document(db, job=job, document_id=document_id) if job is not None else None
        if job is None or document is None:
            return True
        if _pending_identity(document) != pending_identity:
            # A newer document/vector was installed while Qdrant was writing.
            # Do not clear it; queue a fresh handoff for the new state.
            job.status = "queued"
            job.vector_status = "pending"
            job.locked_at = None
            job.completed_at = None
            job.updated_at = utcnow()
            db.commit()
            return True
        clear_pending_vector(document)
        document.vector_status = "indexed"
        document.vector_error = None
        document.last_vector_attempt_at = utcnow()
        document.indexed_at = utcnow()
        _finish_job_in_session(job, vector_status="indexed", now=utcnow())
        db.commit()
    return True


def _pending_identity(document: SearchDocument) -> tuple[object, ...] | None:
    if document.pending_vector is None:
        return None
    return (
        tuple(document.pending_vector),
        document.pending_vector_content_hash,
        document.pending_vector_model,
        document.pending_vector_dimensions,
    )


def _attempt_output_is_unrecoverable(db: Session, *, job: SearchIndexJob) -> bool:
    if not job.usage_attempt_key:
        return False
    event = db.scalar(
        select(ModelUsageEvent).where(
            ModelUsageEvent.family_id == job.family_id,
            ModelUsageEvent.attempt_key == job.usage_attempt_key,
        )
    )
    if event is not None:
        return event.execution_certainty is not ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
    reservation = db.scalar(
        select(ModelUsageReservation).where(
            ModelUsageReservation.family_id == job.family_id,
            ModelUsageReservation.attempt_key == job.usage_attempt_key,
        )
    )
    return reservation is not None and reservation.status in {
        ModelUsageReservationStatus.DISPATCHING,
        ModelUsageReservationStatus.UNCERTAIN,
        ModelUsageReservationStatus.SETTLED,
    }


def _attempt_was_never_dispatched(db: Session, *, job: SearchIndexJob) -> bool:
    if not job.usage_attempt_key:
        return False
    reservation = db.scalar(
        select(ModelUsageReservation).where(
            ModelUsageReservation.family_id == job.family_id,
            ModelUsageReservation.attempt_key == job.usage_attempt_key,
        )
    )
    return reservation is not None and reservation.status is ModelUsageReservationStatus.RESERVED


def _mark_budget_blocked(
    job_id: str,
    *,
    exc: ModelUsageBlocked,
    session_factory: Callable[[], Session],
) -> None:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            return
        scope = _current_budget_scope(db, family_id=job.family_id)
        job.status = "budget_blocked"
        job.vector_status = "pending"
        job.error = "模型用量受当前家庭预算限制，稍后会自动重试"
        job.error_code = exc.code
        job.budget_blocked_period_start = exc.period_start or (scope[0] if scope else None)
        job.budget_blocked_policy_version_id = exc.policy_version_id or (scope[1] if scope else None)
        job.locked_at = None
        job.completed_at = utcnow()
        job.updated_at = utcnow()
        db.commit()


def _mark_provider_failure(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
    error: str,
    error_code: str,
) -> None:
    _mark_job_failure(
        job_id,
        session_factory=session_factory,
        error=error,
        error_code=error_code,
        increment_provider_attempt=True,
    )


def _mark_job_failure(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
    error: str,
    error_code: str,
    increment_provider_attempt: bool,
    vector_status: str = "failed",
) -> None:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            return
        _mark_job_failure_in_session(
            job,
            error=error,
            error_code=error_code,
            increment_provider_attempt=increment_provider_attempt,
            vector_status=vector_status,
            now=utcnow(),
        )
        db.commit()


def _mark_job_failure_in_session(
    job: SearchIndexJob,
    *,
    error: str,
    error_code: str,
    increment_provider_attempt: bool,
    vector_status: str = "failed",
    now: datetime,
) -> None:
    job.status = "failed"
    job.vector_status = vector_status
    job.error = error
    job.error_code = error_code
    if increment_provider_attempt:
        job.attempt_count = (job.attempt_count or 0) + 1
    job.locked_at = None
    job.completed_at = now
    job.updated_at = now


def _mark_terminal_missing_output(job: SearchIndexJob, *, now: datetime) -> None:
    _mark_job_failure_in_session(
        job,
        error="嵌入结果无法恢复，请更新内容后重试",
        error_code=EMBEDDING_OUTPUT_UNAVAILABLE,
        increment_provider_attempt=False,
        now=now,
    )


def _mark_terminal_from_attempt(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> None:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is not None:
            _mark_terminal_missing_output(job, now=utcnow())
            db.commit()


def _finish_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
    vector_status: str,
) -> None:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is not None:
            _finish_job_in_session(job, vector_status=vector_status, now=utcnow())
            db.commit()


def _finish_job_in_session(job: SearchIndexJob, *, vector_status: str, now: datetime) -> None:
    job.status = "succeeded"
    job.vector_status = vector_status
    job.error = None
    job.error_code = None
    job.locked_at = None
    job.completed_at = now
    job.updated_at = now


def _job_document(
    db: Session,
    *,
    job: SearchIndexJob | None,
    document_id: str | None = None,
) -> SearchDocument | None:
    if job is None:
        return None
    clauses = [
        SearchDocument.family_id == job.family_id,
        SearchDocument.entity_type == job.entity_type,
        SearchDocument.entity_id == job.entity_id,
    ]
    if document_id is not None:
        clauses.append(SearchDocument.id == document_id)
    return db.scalar(select(SearchDocument).where(*clauses))


def _upsert_entity_search_document(db: Session, *, job: SearchIndexJob) -> SearchDocument | None:
    if job.entity_type == "ingredient":
        ingredient = db.scalar(select(Ingredient).where(Ingredient.family_id == job.family_id, Ingredient.id == job.entity_id))
        if ingredient is None:
            raise ValueError("索引对象不存在或已删除")
        job.target_name = ingredient.name[:255]
        return upsert_ingredient_search_document(db, ingredient)

    if job.entity_type == "food":
        food = db.scalar(select(Food).where(Food.family_id == job.family_id, Food.id == job.entity_id))
        if food is None:
            delete_search_document(
                db,
                family_id=job.family_id,
                entity_type="food",
                entity_id=job.entity_id,
                delete_vector=True,
            )
            return None
        job.target_name = food.name[:255]
        return upsert_food_search_document(db, food)

    if job.entity_type == "recipe":
        recipe = db.scalar(
            select(Recipe)
            .where(Recipe.family_id == job.family_id, Recipe.id == job.entity_id)
            .options(selectinload(Recipe.ingredient_items), selectinload(Recipe.steps))
        )
        if recipe is None:
            raise ValueError("索引对象不存在或已删除")
        job.target_name = recipe.title[:255]
        return upsert_recipe_search_document(db, recipe)

    if job.entity_type == "meal_plan":
        item = db.scalar(
            select(FoodPlanItem)
            .where(FoodPlanItem.family_id == job.family_id, FoodPlanItem.id == job.entity_id)
            .options(selectinload(FoodPlanItem.food).selectinload(Food.recipe))
        )
        if item is None:
            raise ValueError("索引对象不存在或已删除")
        job.target_name = ((item.food.name if item.food is not None else "") or item.note or "餐食计划")[:255]
        return upsert_meal_plan_search_document(db, item)

    raise ValueError("Unsupported search index entity type")


class SearchIndexWorker:
    def __init__(self, *, session_factory: Callable[[], Session] = SessionLocal) -> None:
        self._session_factory = session_factory
        self._stop_event = Event()
        self._thread: Thread | None = None
        self._executor: ThreadPoolExecutor | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._recover_startup_jobs()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="culina-search-index")
        self._thread = Thread(target=self._run, name="culina-search-index-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                with self._session_factory() as db:
                    recover_interrupted_search_index_jobs(db)
                    job_ids = claim_pending_search_index_jobs(db)
                if self._executor is None:
                    return
                for job_id in job_ids:
                    self._executor.submit(process_search_index_job, job_id, session_factory=self._session_factory, claimed=True)
            except Exception:
                logger.exception("Search index worker scan failed")
            self._stop_event.wait(WORKER_SCAN_INTERVAL_SECONDS)

    def _recover_startup_jobs(self) -> None:
        try:
            with self._session_factory() as db:
                recovered_count = recover_interrupted_search_index_jobs(db, include_all_running=True)
            if recovered_count:
                logger.info("Recovered interrupted search index jobs count=%s", recovered_count)
        except Exception:
            logger.exception("Search index worker startup recovery failed")
