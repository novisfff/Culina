from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Event, Thread
from typing import Callable

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import get_settings
from app.core.enums import (
    FamilyModelSearchProfileStatus,
    ModelUsageExecutionCertainty,
    ModelUsageReservationStatus,
)
from app.core.utils import create_id, utcnow
from app.db.session import SessionLocal
from app.models.domain import Food, FoodPlanItem, Ingredient, Recipe, SearchDocument, SearchIndexJob
from app.models.family_model_settings import FamilySearchProfile, FamilySearchProfileDocument
from app.models.model_usage import ModelUsageEvent, ModelUsageFamilyPolicy, ModelUsageReservation
from app.services.model_usage.errors import (
    ModelUsageAttemptAlreadyAccounted,
    ModelUsageBlocked,
    ModelUsageError,
)
from app.services.model_usage.adapters.embedding import EmbeddingUsageDependencies
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.reservations import release_undispatched_reservation_in_session
from app.services.family_model_settings.resolver import FamilyModelConfigurationResolver
from app.services.family_model_settings.transport import ProviderTransport
from app.services.family_model_settings.types import EmbeddingUsageSnapshot, ResolvedSearchProfile
from app.repos.family_model_settings.profiles import (
    get_family_model_settings,
    lock_family_model_settings,
)
from app.repos.family_model_settings.search_profiles import (
    candidate_price_version_id,
    list_profiles_accepting_document_updates,
    refresh_profile_progress,
    require_search_profile,
    upsert_profile_document_snapshot,
)
from app.services.search.embeddings import EmbeddingClient, EmbeddingUnavailableError, build_embedding_client
from app.services.search.indexing import (
    delete_search_document,
    upsert_food_search_document,
    upsert_ingredient_search_document,
    upsert_meal_plan_search_document,
    upsert_recipe_search_document,
)
from app.services.search.vector_indexing import (
    system_embedding_attribution,
    clear_profile_pending_vector,
    persist_profile_pending_vector,
    prepare_profile_vector_handoff,
    profile_pending_vector_is_current,
    snapshot_profile_document,
    write_profile_vector_handoff,
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


def enqueue_search_profile_document_job(
    db: Session,
    *,
    profile: FamilySearchProfile,
    profile_document: FamilySearchProfileDocument,
    config_revision_id: str | None,
    price_version_id: str,
    user_id: str,
    target_name: str = "",
) -> SearchIndexJob:
    """Create (or coalesce) work for exactly one profile/document pair.

    There is intentionally no global embedding setting in this boundary.  A
    queued/running job can be reused after a text edit because its
    ``FamilySearchProfileDocument`` row is updated first and the worker
    snapshots that latest content under lock.
    """

    if (
        profile.family_id != profile_document.family_id
        or profile.id != profile_document.search_profile_id
        or not price_version_id
    ):
        raise ValueError("search profile job identity invalid")
    document = db.get(SearchDocument, profile_document.search_document_id)
    if document is None or document.family_id != profile.family_id:
        raise ValueError("search profile job document missing")
    existing = db.scalar(
        select(SearchIndexJob)
        .where(
            SearchIndexJob.family_id == profile.family_id,
            SearchIndexJob.search_profile_id == profile.id,
            SearchIndexJob.entity_type == document.entity_type,
            SearchIndexJob.entity_id == document.entity_id,
            SearchIndexJob.status.in_(("queued", "running", "budget_blocked")),
        )
        .order_by(SearchIndexJob.created_at.desc(), SearchIndexJob.id.desc())
        .with_for_update()
    )
    if existing is not None:
        # A budget block is deliberately retained until its policy/period
        # changes.  New content must not silently reset that admission gate.
        return existing
    now = utcnow()
    job = SearchIndexJob(
        id=create_id("search-index-job"),
        family_id=profile.family_id,
        search_profile_id=profile.id,
        config_revision_id=config_revision_id,
        price_version_id=price_version_id,
        user_id=user_id,
        status="queued",
        entity_type=document.entity_type,
        entity_id=document.entity_id,
        target_name=(target_name or document.title_text)[:255],
        vector_status="pending",
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    db.flush()
    return job


def enqueue_document_for_family_profiles(
    db: Session,
    document: SearchDocument,
    *,
    user_id: str,
) -> tuple[SearchIndexJob, ...]:
    """Fan one canonical document update out to active/provisioning profiles.

    Settings are locked before profile/document rows.  This linearizes an
    active job against a simultaneous price/config publication: whichever
    transaction wins supplies the immutable job snapshot.  A candidate keeps
    its dedicated candidate price pointer regardless of later active reprices.
    """

    if get_family_model_settings(db, family_id=document.family_id) is None:
        return ()
    settings = lock_family_model_settings(db, family_id=document.family_id)
    profiles = list_profiles_accepting_document_updates(db, family_id=document.family_id)
    if not profiles:
        return ()
    active_config_revision_id = settings.active_config_revision_id
    active_price_version_id = settings.active_price_version_id
    jobs: list[SearchIndexJob] = []
    for profile in profiles:
        profile_document = upsert_profile_document_snapshot(
            db,
            profile=profile,
            document=document,
        )
        is_active_or_initial = (
            profile.id == settings.active_search_profile_id
            or (
                settings.active_search_profile_id is None
                and profile.base_search_profile_id is None
                and profile.candidate_price_version_id is None
            )
        )
        if is_active_or_initial:
            if active_config_revision_id is None or active_price_version_id is None:
                # A profile cannot be serviceable without its published
                # configuration/price snapshot; leave the canonical document
                # available to keyword search and wait for publication.
                continue
            config_revision_id = active_config_revision_id
            price_version_id = active_price_version_id
        else:
            config_revision_id = None
            price_version_id = candidate_price_version_id(db, profile=profile)
            if price_version_id is None:
                # A partially-created/invalid candidate is never eligible for
                # a remote send. Task 11 exposes it as failed rather than
                # guessing a mutable active price.
                profile.status = FamilyModelSearchProfileStatus.FAILED
                continue
        jobs.append(
            enqueue_search_profile_document_job(
                db,
                profile=profile,
                profile_document=profile_document,
                config_revision_id=config_revision_id,
                price_version_id=price_version_id,
                user_id=user_id,
                target_name=document.title_text,
            )
        )
    return tuple(jobs)


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
    if job.search_profile_id is not None:
        resolved = _profile_job_document(db, job=job, for_update=True)
        if resolved is not None:
            profile, profile_document, _document = resolved
            # Retain a durable handoff vector so a Qdrant-only retry never
            # sends another embedding request.  Provider failures instead
            # return the row to a fresh profile-local attempt.
            if profile_document.status != "pending_handoff":
                clear_profile_pending_vector(profile_document)
                profile_document.status = "pending"
                profile_document.error_code = None
            refresh_profile_progress(db, profile=profile)
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


def _normalize_utc_datetime(value: datetime | None) -> datetime | None:
    """Compare persisted datetimes consistently across MySQL/SQLite reloads."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _normalize_period_start(value: datetime | None) -> datetime | None:
    return _normalize_utc_datetime(value)


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
        if job.search_profile_id is not None:
            resolved = _profile_job_document(db, job=job, for_update=True)
            if resolved is not None:
                profile, profile_document, _document = resolved
                if profile_document.status == "budget_blocked":
                    profile_document.status = "pending"
                    profile_document.error_code = None
                refresh_profile_progress(db, profile=profile)


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
        if job.search_profile_id is None:
            # Canonical refresh jobs have no Provider side effect.  They can
            # always be replayed to rebuild text and fan out fresh profile
            # jobs, without consulting the retired SearchDocument vector
            # fields.
            job.status = "queued"
            job.locked_at = None
            job.completed_at = None
            job.error = None
            job.error_code = None
            job.updated_at = now
            continue
        try:
            resolved = _profile_job_document(db, job=job, for_update=True)
        except Exception:
            resolved = None
        if resolved is None:
            _finish_job_in_session(job, vector_status="skipped", now=now)
            continue
        profile, profile_document, _document = resolved
        if profile.status not in {
            FamilyModelSearchProfileStatus.PROVISIONING,
            FamilyModelSearchProfileStatus.ACTIVE,
        }:
            _finish_job_in_session(job, vector_status="skipped", now=now)
            continue
        if _attempt_output_is_unrecoverable(db, job=job):
            _mark_profile_terminal_missing_output_in_session(
                db,
                job,
                profile_document=profile_document,
                profile=profile,
                now=now,
            )
            continue
        has_pending = (
            profile_document.status == "pending_handoff"
            and profile_document.vector_json is not None
        )
        attempt_count = job.attempt_count or 0
        job.status = "queued" if has_pending or attempt_count < MAX_ATTEMPTS else "failed"
        job.locked_at = None
        job.updated_at = now
        if job.status == "queued":
            job.completed_at = None
            job.error = None
            job.error_code = None
        refresh_profile_progress(db, profile=profile)
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

    if _job_has_search_profile(job_id, session_factory=session_factory):
        _process_family_search_profile_job(
            job_id,
            session_factory=session_factory,
            embedding_client=embedding_client,
            vector_store=vector_store,
        )
        return
    _process_canonical_search_document_job(job_id, session_factory=session_factory)


def _process_canonical_search_document_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> None:
    """Refresh canonical text and fan it out to serviceable profiles.

    A canonical job deliberately never sends an embedding itself.  Canonical
    documents are shared text records; the resulting vectors, usage snapshot
    and retry state belong to one ``FamilySearchProfileDocument`` each.  When
    a family has no active/provisioning profile, keyword search stays usable
    and this job finishes without reading legacy global-vector fields.
    """

    with session_factory() as db:
        job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
        if job is None:
            return
        try:
            document = _upsert_entity_search_document(db, job=job)
        except ValueError as exc:
            _mark_job_failure_in_session(
                job,
                error=str(exc) or "索引对象不存在或已删除",
                error_code="search_index_target_missing",
                increment_provider_attempt=True,
                now=utcnow(),
            )
            db.commit()
            return
        except Exception:
            _mark_job_failure_in_session(
                job,
                error="搜索索引更新失败",
                error_code="search_index_failed",
                increment_provider_attempt=True,
                now=utcnow(),
            )
            db.commit()
            logger.exception("Canonical search document refresh failed job_id=%s", job_id)
            return

        if document is None:
            _finish_job_in_session(job, vector_status="skipped", now=utcnow())
            db.commit()
            return
        profile_jobs = enqueue_document_for_family_profiles(
            db,
            document,
            user_id=job.user_id,
        )
        _finish_job_in_session(
            job,
            vector_status="profile_enqueued" if profile_jobs else "keyword_only",
            now=utcnow(),
        )
        db.commit()


def _job_has_search_profile(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> bool:
    with session_factory() as db:
        return db.scalar(
            select(SearchIndexJob.search_profile_id).where(SearchIndexJob.id == job_id)
        ) is not None


def _profile_job_document(
    db: Session,
    *,
    job: SearchIndexJob,
    for_update: bool = False,
) -> tuple[FamilySearchProfile, FamilySearchProfileDocument, SearchDocument] | None:
    if job.search_profile_id is None:
        return None
    profile = require_search_profile(
        db,
        family_id=job.family_id,
        search_profile_id=job.search_profile_id,
        for_update=for_update,
    )
    statement = (
        select(FamilySearchProfileDocument, SearchDocument)
        .join(
            SearchDocument,
            SearchDocument.id == FamilySearchProfileDocument.search_document_id,
        )
        .where(
            FamilySearchProfileDocument.family_id == job.family_id,
            FamilySearchProfileDocument.search_profile_id == profile.id,
            SearchDocument.family_id == job.family_id,
            SearchDocument.entity_type == job.entity_type,
            SearchDocument.entity_id == job.entity_id,
        )
    )
    if for_update:
        statement = statement.with_for_update()
    row = db.execute(statement).first()
    if row is None:
        return None
    profile_document, document = row
    return profile, profile_document, document


def _process_family_search_profile_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
    embedding_client: EmbeddingClient | None,
    vector_store: VectorStore | None,
) -> None:
    """Execute one durable profile/document index job.

    The provider send and Qdrant handoff are deliberately split.  A persisted
    vector can be retried against Qdrant without a second embedding charge;
    an accounted send lacking durable vector output becomes terminal instead
    of being resent.
    """

    prepared = _prepare_profile_embedding_attempt(
        job_id,
        session_factory=session_factory,
    )
    if prepared is None:
        return
    profile, snapshot, attempt_key, handoff_only = prepared
    store = vector_store or build_vector_store(
        get_settings(),
        qdrant_collection=profile.qdrant_collection,
    )
    if handoff_only:
        _handoff_profile_pending_vector(
            job_id,
            snapshot=snapshot,
            profile=profile,
            vector_store=store,
            session_factory=session_factory,
        )
        return

    try:
        client = embedding_client or _build_profile_embedding_client(
            profile,
            session_factory=session_factory,
        )
        job = _load_profile_job_snapshot(job_id, session_factory=session_factory)
        if job is None:
            return
        result = client.embed_text(
            snapshot.semantic_text,
            attribution=system_embedding_attribution(
                family_id=job.family_id,
                logical_operation_id=attempt_key,
            ),
            attempt_key=attempt_key,
            usage_snapshot=EmbeddingUsageSnapshot(
                config_revision_id=job.config_revision_id,
                price_version_id=_require_job_price_version_id(job),
                candidate=job.config_revision_id is None,
            ),
        )
    except ModelUsageBlocked as exc:
        _mark_profile_job_budget_blocked(job_id, exc=exc, session_factory=session_factory)
        return
    except ModelUsageAttemptAlreadyAccounted:
        _mark_profile_job_terminal_missing_output(job_id, session_factory=session_factory)
        return
    except EmbeddingUnavailableError:
        _mark_profile_job_failure(
            job_id,
            session_factory=session_factory,
            error="嵌入服务暂时不可用",
            error_code="search_embedding_unavailable",
            profile_status="failed",
            increment_provider_attempt=True,
        )
        return
    except ModelUsageError as exc:
        _mark_profile_job_failure(
            job_id,
            session_factory=session_factory,
            error="模型用量服务暂时不可用",
            error_code=exc.code,
            profile_status="failed",
            increment_provider_attempt=False,
        )
        return
    except Exception:
        _mark_profile_job_failure(
            job_id,
            session_factory=session_factory,
            error="搜索索引更新失败",
            error_code="search_index_failed",
            profile_status="failed",
            increment_provider_attempt=True,
        )
        logger.exception("Family search profile index job failed job_id=%s", job_id)
        return

    if len(result.vectors) != 1:
        _mark_profile_job_failure(
            job_id,
            session_factory=session_factory,
            error="嵌入服务返回结果不完整",
            error_code="search_embedding_response_invalid",
            profile_status="failed",
            increment_provider_attempt=True,
        )
        return
    _persist_profile_provider_vector(
        job_id,
        snapshot=snapshot,
        attempt_key=attempt_key,
        vector=result.vectors[0],
        usage_event_id=result.usage_event_id,
        session_factory=session_factory,
    )
    _handoff_profile_pending_vector(
        job_id,
        snapshot=snapshot,
        profile=profile,
        vector_store=store,
        session_factory=session_factory,
    )


def _load_profile_job_snapshot(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> SearchIndexJob | None:
    with session_factory() as db:
        return db.get(SearchIndexJob, job_id)


def _require_job_price_version_id(job: SearchIndexJob) -> str:
    if not job.price_version_id:
        raise ValueError("search profile job price snapshot missing")
    return job.price_version_id


def _prepare_profile_embedding_attempt(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> tuple[FamilySearchProfile, object, str, bool] | None:
    from app.services.search.vector_indexing import SearchProfileDocumentSnapshot

    with session_factory() as db:
        job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
        if job is None or job.search_profile_id is None:
            return None
        try:
            resolved = _profile_job_document(db, job=job, for_update=True)
        except Exception:
            resolved = None
        if resolved is None:
            _mark_job_failure_in_session(
                job,
                error="索引对象不存在或已删除",
                error_code="search_index_target_missing",
                increment_provider_attempt=False,
                now=utcnow(),
            )
            db.commit()
            return None
        profile, profile_document, document = resolved
        if profile.status not in {
            FamilyModelSearchProfileStatus.PROVISIONING,
            FamilyModelSearchProfileStatus.ACTIVE,
        }:
            _finish_job_in_session(job, vector_status="skipped", now=utcnow())
            db.commit()
            return None
        if profile_document.content_hash != document.content_hash:
            profile_document = upsert_profile_document_snapshot(
                db,
                profile=profile,
                document=document,
            )
        snapshot = snapshot_profile_document(
            profile_document,
            document=document,
            search_profile=profile,
        )
        if profile_pending_vector_is_current(profile_document, snapshot):
            job.vector_status = "pending"
            job.updated_at = utcnow()
            db.commit()
            return profile, snapshot, job.usage_attempt_key or "", True
        if _attempt_output_is_unrecoverable(db, job=job):
            _mark_profile_terminal_missing_output_in_session(
                db,
                job,
                profile_document=profile_document,
                profile=profile,
                now=utcnow(),
            )
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
                _mark_profile_terminal_missing_output_in_session(
                    db,
                    job,
                    profile_document=profile_document,
                    profile=profile,
                    now=utcnow(),
                )
                db.commit()
                return None
        attempt_key = create_id("search-index-embedding")
        job.usage_attempt_key = attempt_key
        job.usage_event_id = None
        job.vector_status = "pending"
        job.error = None
        job.error_code = None
        job.updated_at = utcnow()
        profile_document.status = "indexing"
        profile_document.error_code = None
        profile_document.last_attempt_at = utcnow()
        db.commit()
        assert isinstance(snapshot, SearchProfileDocumentSnapshot)
        return profile, snapshot, attempt_key, False


def _build_profile_embedding_client(
    profile: FamilySearchProfile,
    *,
    session_factory: Callable[[], Session],
) -> EmbeddingClient:
    """Resolve immutable metadata now; decrypt later through a fresh session."""

    with session_factory() as db:
        resolver = FamilyModelConfigurationResolver(db)
        binding = resolver.resolve_search_profile(profile.family_id, profile.id)
        settings = get_settings()
        transport = ProviderTransport.from_settings(settings, policy=resolver.network_policy)
        usage_dependencies = EmbeddingUsageDependencies(
            usage_facade=ModelUsageFacade(session_factory=session_factory),
            session_factory=session_factory,
            signer=decode_receipt_integrity_keyring(settings).signer(),
        )

    def resolve_credential(
        search_profile: ResolvedSearchProfile,
        secret_version_id: str | None,
    ):
        with session_factory() as credential_db:
            return FamilyModelConfigurationResolver(
                credential_db
            ).resolve_dispatch_credential(search_profile, secret_version_id)

    return build_embedding_client(
        binding,
        transport=transport,
        usage_dependencies=usage_dependencies,
        resolve_dispatch_credential=resolve_credential,
    )


def _persist_profile_provider_vector(
    job_id: str,
    *,
    snapshot: object,
    attempt_key: str,
    vector: list[float],
    usage_event_id: str | None,
    session_factory: Callable[[], Session],
) -> None:
    from app.services.search.vector_indexing import SearchProfileDocumentSnapshot

    if not isinstance(snapshot, SearchProfileDocumentSnapshot):
        raise TypeError("search profile document snapshot required")
    with session_factory() as db:
        job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
        if job is None or job.search_profile_id != snapshot.search_profile_id or job.usage_attempt_key != attempt_key:
            return
        resolved = _profile_job_document(db, job=job, for_update=True)
        if resolved is None:
            _mark_job_failure_in_session(
                job,
                error="索引对象不存在或已删除",
                error_code="search_index_target_missing",
                increment_provider_attempt=False,
                now=utcnow(),
            )
            db.commit()
            return
        profile, profile_document, _document = resolved
        try:
            persist_profile_pending_vector(
                profile_document,
                vector=vector,
                snapshot=snapshot,
                now=utcnow(),
            )
        except ValueError:
            # Content changed while the Provider request was in flight.  The
            # old output may not be attached to new text, so retain neither it
            # nor a retryable send identity.
            job.usage_attempt_key = None
            job.usage_event_id = None
            job.status = "queued"
            job.vector_status = "pending"
            job.locked_at = None
            job.completed_at = None
            job.updated_at = utcnow()
            profile_document.status = "pending"
            profile_document.vector_json = None
            profile_document.vector_dimensions = None
            refresh_profile_progress(db, profile=profile)
            db.commit()
            return
        job.usage_event_id = usage_event_id
        job.vector_status = "pending"
        job.attempt_count = (job.attempt_count or 0) + 1
        job.updated_at = utcnow()
        refresh_profile_progress(db, profile=profile)
        db.commit()


def _handoff_profile_pending_vector(
    job_id: str,
    *,
    snapshot: object,
    profile: FamilySearchProfile,
    vector_store: VectorStore,
    session_factory: Callable[[], Session],
) -> None:
    from app.services.search.vector_indexing import SearchProfileDocumentSnapshot

    if not isinstance(snapshot, SearchProfileDocumentSnapshot):
        raise TypeError("search profile document snapshot required")
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            return
        resolved = _profile_job_document(db, job=job, for_update=True)
        if resolved is None:
            return
        live_profile, profile_document, _document = resolved
        handoff = prepare_profile_vector_handoff(
            profile_document,
            snapshot=snapshot,
            search_profile=live_profile,
        )
        if handoff is None:
            return
        db.commit()
    try:
        write_profile_vector_handoff(handoff, vector_store=vector_store)
    except VectorStoreUnavailableError:
        with session_factory() as db:
            job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
            if job is None:
                return
            resolved = _profile_job_document(db, job=job, for_update=True)
            if resolved is not None:
                live_profile, profile_document, _document = resolved
                if profile_pending_vector_is_current(profile_document, snapshot):
                    _mark_job_failure_in_session(
                        job,
                        error="搜索向量服务暂时不可用",
                        error_code="search_vector_unavailable",
                        increment_provider_attempt=False,
                        vector_status="pending",
                        now=utcnow(),
                    )
                    refresh_profile_progress(db, profile=live_profile)
                    db.commit()
        return
    with session_factory() as db:
        job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
        if job is None:
            return
        resolved = _profile_job_document(db, job=job, for_update=True)
        if resolved is None:
            return
        live_profile, profile_document, _document = resolved
        if not profile_pending_vector_is_current(profile_document, snapshot):
            job.status = "queued"
            job.vector_status = "pending"
            job.locked_at = None
            job.completed_at = None
            job.updated_at = utcnow()
            db.commit()
            return
        clear_profile_pending_vector(profile_document)
        profile_document.status = "indexed"
        profile_document.error_code = None
        profile_document.indexed_at = utcnow()
        _finish_job_in_session(job, vector_status="indexed", now=utcnow())
        refresh_profile_progress(db, profile=live_profile)
        db.commit()


def _mark_profile_job_failure(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
    error: str,
    error_code: str,
    profile_status: str,
    increment_provider_attempt: bool,
) -> None:
    with session_factory() as db:
        job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
        if job is None:
            return
        resolved = _profile_job_document(db, job=job, for_update=True)
        if resolved is None:
            _mark_job_failure_in_session(
                job,
                error=error,
                error_code=error_code,
                increment_provider_attempt=increment_provider_attempt,
                now=utcnow(),
            )
            db.commit()
            return
        profile, profile_document, _document = resolved
        profile_document.status = profile_status
        profile_document.error_code = error_code
        if profile_status != "pending_handoff":
            clear_profile_pending_vector(profile_document)
        _mark_job_failure_in_session(
            job,
            error=error,
            error_code=error_code,
            increment_provider_attempt=increment_provider_attempt,
            now=utcnow(),
        )
        refresh_profile_progress(db, profile=profile)
        db.commit()


def _mark_profile_job_budget_blocked(
    job_id: str,
    *,
    exc: ModelUsageBlocked,
    session_factory: Callable[[], Session],
) -> None:
    with session_factory() as db:
        job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
        if job is None:
            return
        resolved = _profile_job_document(db, job=job, for_update=True)
        if resolved is not None:
            profile, profile_document, _document = resolved
            profile_document.status = "budget_blocked"
            profile_document.error_code = exc.code
            clear_profile_pending_vector(profile_document)
            refresh_profile_progress(db, profile=profile)
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


def _mark_profile_terminal_missing_output_in_session(
    db: Session,
    job: SearchIndexJob,
    *,
    profile_document: FamilySearchProfileDocument,
    profile: FamilySearchProfile,
    now: datetime,
) -> None:
    profile_document.status = "failed"
    profile_document.error_code = EMBEDDING_OUTPUT_UNAVAILABLE
    clear_profile_pending_vector(profile_document)
    _mark_terminal_missing_output(job, now=now)
    refresh_profile_progress(db, profile=profile)


def _mark_profile_job_terminal_missing_output(
    job_id: str,
    *,
    session_factory: Callable[[], Session],
) -> None:
    with session_factory() as db:
        job = db.scalar(select(SearchIndexJob).where(SearchIndexJob.id == job_id).with_for_update())
        if job is None:
            return
        resolved = _profile_job_document(db, job=job, for_update=True)
        if resolved is None:
            _mark_terminal_missing_output(job, now=utcnow())
        else:
            profile, profile_document, _document = resolved
            profile_document.status = "failed"
            profile_document.error_code = EMBEDDING_OUTPUT_UNAVAILABLE
            clear_profile_pending_vector(profile_document)
            _mark_terminal_missing_output(job, now=utcnow())
            refresh_profile_progress(db, profile=profile)
        db.commit()


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
        locked_at = _normalize_utc_datetime(job.locked_at)
        if (
            not claimed
            and job.status == "running"
            and locked_at is not None
            and locked_at > stale_lock_cutoff
        ):
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


def _finish_job_in_session(job: SearchIndexJob, *, vector_status: str, now: datetime) -> None:
    job.status = "succeeded"
    job.vector_status = vector_status
    job.error = None
    job.error_code = None
    job.locked_at = None
    job.completed_at = now
    job.updated_at = now


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
