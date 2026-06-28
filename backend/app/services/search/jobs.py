from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event, Thread
from typing import Callable

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import get_settings
from app.core.utils import create_id, utcnow
from app.db.session import SessionLocal
from app.db.transactions import commit_session
from app.models.domain import Food, Ingredient, Recipe, SearchDocument, SearchIndexJob
from app.services.search.embeddings import EmbeddingUnavailableError, build_embedding_client
from app.services.search.indexing import upsert_food_search_document, upsert_ingredient_search_document, upsert_recipe_search_document
from app.services.search.vector_indexing import search_point_id
from app.services.search.vector_store import VectorStoreUnavailableError, build_vector_store

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
JOB_LOCK_STALE_AFTER = timedelta(minutes=15)
WORKER_SCAN_INTERVAL_SECONDS = 3
ACTIVE_COMPLETED_WINDOW = timedelta(hours=24)
SEARCH_INDEX_ENTITY_TYPES = {"ingredient", "food", "recipe"}


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
    job.attempt_count = 0
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
                SearchIndexJob.status.in_(("queued", "running")),
                SearchIndexJob.completed_at >= cutoff,
            ),
        )
        .order_by(SearchIndexJob.created_at.desc(), SearchIndexJob.id)
        .limit(100)
    )
    return list(db.scalars(statement))


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
        attempt_count = job.attempt_count or 0
        job.status = "queued" if attempt_count < MAX_ATTEMPTS else "failed"
        job.locked_at = None
        job.updated_at = now
        if job.status == "queued":
            job.completed_at = None
            job.error = None
    if jobs:
        db.commit()
    return len(jobs)


def claim_pending_search_index_jobs(db: Session, *, limit: int = 4) -> list[str]:
    now = utcnow()
    stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
    jobs = list(
        db.scalars(
            select(SearchIndexJob)
            .where(
                or_(
                    SearchIndexJob.status == "queued",
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
    if job_ids:
        db.commit()
    return job_ids


def process_search_index_job(
    job_id: str,
    *,
    session_factory: Callable[[], Session] = SessionLocal,
    claimed: bool = False,
) -> None:
    with session_factory() as db:
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            return
        now = utcnow()
        stale_lock_cutoff = now - JOB_LOCK_STALE_AFTER
        if not claimed and job.status == "running" and job.locked_at and job.locked_at > stale_lock_cutoff:
            return
        if job.status == "succeeded":
            return
        attempt_count = job.attempt_count or 0
        if job.status == "failed" and attempt_count >= MAX_ATTEMPTS:
            return
        job.status = "running"
        job.vector_status = "pending"
        job.error = None
        job.attempt_count = attempt_count + 1
        job.locked_at = now
        job.started_at = job.started_at or now
        job.updated_at = now
        db.commit()

    try:
        with session_factory() as db:
            job = db.get(SearchIndexJob, job_id)
            if job is None:
                return
            document = _upsert_entity_search_document(db, job=job)
            vector_status = _index_vector_if_enabled(document)
            now = utcnow()
            job.status = "succeeded"
            job.vector_status = vector_status
            job.error = None
            job.locked_at = None
            job.completed_at = now
            job.updated_at = now
            commit_session(db)
    except Exception as exc:
        with session_factory() as db:
            job = db.get(SearchIndexJob, job_id)
            if job is not None:
                now = utcnow()
                job.status = "failed"
                job.vector_status = "failed"
                job.error = str(exc) or "搜索索引更新失败"
                job.locked_at = None
                job.completed_at = now
                job.updated_at = now
                db.commit()
        logger.exception("Search index job failed job_id=%s", job_id)


def _upsert_entity_search_document(db: Session, *, job: SearchIndexJob) -> SearchDocument:
    if job.entity_type == "ingredient":
        ingredient = db.scalar(select(Ingredient).where(Ingredient.family_id == job.family_id, Ingredient.id == job.entity_id))
        if ingredient is None:
            raise ValueError("索引对象不存在或已删除")
        job.target_name = ingredient.name[:255]
        return upsert_ingredient_search_document(db, ingredient)

    if job.entity_type == "food":
        food = db.scalar(select(Food).where(Food.family_id == job.family_id, Food.id == job.entity_id))
        if food is None:
            raise ValueError("索引对象不存在或已删除")
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

    raise ValueError("Unsupported search index entity type")


def _index_vector_if_enabled(document: SearchDocument) -> str:
    settings = get_settings()
    if settings.search_embedding_provider.strip().lower() in {"", "disabled", "mock"}:
        document.vector_status = "disabled"
        document.vector_error = None
        document.vector_attempt_count = document.vector_attempt_count or 0
        return "skipped"

    embedding_client = build_embedding_client()
    if not embedding_client.model or embedding_client.dimensions <= 0:
        document.vector_status = "disabled"
        document.vector_error = None
        document.vector_attempt_count = document.vector_attempt_count or 0
        return "skipped"
    if document.embedding_model != embedding_client.model or document.embedding_dimensions != embedding_client.dimensions:
        document.vector_status = "failed"
        document.vector_error = "search document embedding config is stale; rebuild search document before vector indexing"
        raise ValueError(document.vector_error)

    try:
        vector_store = build_vector_store()
        vector_store.ensure_collection(vector_size=embedding_client.dimensions)
        vector = embedding_client.embed_text(document.semantic_text)
        vector_store.upsert_point(
            point_id=search_point_id(document.entity_type, document.entity_id),
            vector=vector,
            payload={
                "family_id": document.family_id,
                "entity_type": document.entity_type,
                "entity_id": document.entity_id,
                "embedding_model": embedding_client.model,
                "embedding_dimensions": embedding_client.dimensions,
                "content_hash": document.content_hash,
                "document_builder_version": document.document_builder_version,
                "updated_at": document.updated_at.isoformat() if document.updated_at else "",
            },
        )
    except (EmbeddingUnavailableError, VectorStoreUnavailableError) as exc:
        document.vector_status = "failed"
        document.vector_error = str(exc)[:2000]
        raise

    now = utcnow()
    document.embedding_model = embedding_client.model
    document.embedding_dimensions = embedding_client.dimensions
    document.vector_status = "indexed"
    document.vector_error = None
    document.vector_attempt_count = (document.vector_attempt_count or 0) + 1
    document.last_vector_attempt_at = now
    document.indexed_at = now
    return "indexed"


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
