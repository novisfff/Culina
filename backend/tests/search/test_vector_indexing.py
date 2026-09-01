from __future__ import annotations

from unittest.mock import patch

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import FamilyModelSearchProfileStatus
from app.models.domain import Family, SearchDocument, SearchIndexJob
from app.models.family_model_settings import (
    FamilyModelSettings,
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
from app.services.search.embeddings import MeteredEmbeddingResult
from app.services.search.vector_indexing import index_pending_search_documents
from app.services.search.vector_store import VectorStoreUnavailableError
from tests.search._support import session_factory


class CountingEmbeddingClient:
    model = "profile-embedding"
    dimensions = 2

    def __init__(self) -> None:
        self.call_count = 0

    def embed_text(self, text, *, attribution, attempt_key, usage_snapshot=None):
        del text, attribution, attempt_key
        assert usage_snapshot is not None
        self.call_count += 1
        return MeteredEmbeddingResult(vectors=[[0.1, 0.2]], usage_event_id="usage-event")


class RecordingVectorStore:
    def __init__(self, *, fail_times: int = 0) -> None:
        self.fail_times = fail_times
        self.call_count = 0
        self.vector_size = 0
        self.points: list[tuple[str, list[float], dict[str, object]]] = []

    def ensure_collection(self, *, vector_size: int) -> None:
        self.vector_size = vector_size

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        self.call_count += 1
        if self.fail_times:
            self.fail_times -= 1
            raise VectorStoreUnavailableError("qdrant unavailable")
        self.points.append((point_id, vector, payload))


def _seed_profile_job(db: Session, *, suffix: str = "1") -> tuple[SearchDocument, SearchIndexJob]:
    family_id = f"family-{suffix}"
    profile_id = f"profile-{suffix}"
    document = SearchDocument(
        id=f"document-{suffix}",
        family_id=family_id,
        entity_type="ingredient",
        entity_id=f"ingredient-{suffix}",
        title_text="番茄",
        keyword_text="番茄",
        detail_text="",
        semantic_text="食材：番茄",
        metadata_json={},
        content_hash=f"{suffix}" * 64,
        document_builder_version="v1",
    )
    profile = FamilySearchProfile(
        id=profile_id,
        family_id=family_id,
        provider_profile_id=f"provider-{suffix}",
        provider_profile_version_id=f"provider-version-{suffix}",
        adapter_kind="openai_compatible_http",
        embedding_model="profile-embedding",
        dimensions=2,
        distance="Cosine",
        document_builder_version="v1",
        index_identity_checksum=f"identity-{suffix}",
        qdrant_collection=f"culina_fsp_{suffix}",
        status=FamilyModelSearchProfileStatus.ACTIVE,
    )
    profile_document = FamilySearchProfileDocument(
        id=f"profile-document-{suffix}",
        family_id=family_id,
        search_profile_id=profile_id,
        search_document_id=document.id,
        content_hash=document.content_hash,
        status="pending",
    )
    job = SearchIndexJob(
        id=f"job-{suffix}",
        family_id=family_id,
        search_profile_id=profile_id,
        config_revision_id=f"revision-{suffix}",
        price_version_id=f"price-{suffix}",
        user_id="owner",
        status="queued",
        entity_type=document.entity_type,
        entity_id=document.entity_id,
        vector_status="pending",
    )
    db.add_all(
        (
            Family(id=family_id, name="测试家庭"),
            FamilyModelSettings(
                family_id=family_id,
                active_config_revision_id=job.config_revision_id,
                active_price_version_id=job.price_version_id,
                active_search_profile_id=profile_id,
            ),
            document,
            profile,
            profile_document,
            job,
        )
    )
    db.flush()
    return document, job


def test_index_pending_search_documents_indexes_profile_job_without_mutating_canonical_vector_state() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    embedding = CountingEmbeddingClient()
    with SessionLocal() as db:
        document, job = _seed_profile_job(db)
        db.commit()
        stats = index_pending_search_documents(
            db,
            embedding_client=embedding,
            vector_store=vector_store,  # type: ignore[arg-type]
            session_factory=SessionLocal,
        )

        db.expire_all()
        persisted_job = db.get(SearchIndexJob, job.id)
        profile_document = db.scalar(select(FamilySearchProfileDocument))
        canonical = db.get(SearchDocument, document.id)

    assert stats == {"indexed": 1, "failed": 0, "skipped": 0}
    assert embedding.call_count == 1
    assert vector_store.vector_size == 2
    assert vector_store.points == [
        (
            "ingredient:ingredient-1",
            [0.1, 0.2],
            {
                "family_id": "family-1",
                "search_profile_id": "profile-1",
                "entity_type": "ingredient",
                "entity_id": "ingredient-1",
                "user_id": "",
                "content_hash": "1" * 64,
                "document_builder_version": "v1",
                "embedding_model": "profile-embedding",
                "embedding_dimensions": 2,
            },
        )
    ]
    assert persisted_job is not None and persisted_job.status == "succeeded"
    assert profile_document is not None and profile_document.status == "indexed"
    assert profile_document.vector_json is None
    assert canonical is not None
    assert canonical.pending_vector is None
    assert canonical.vector_status == "pending"
    assert canonical.embedding_model == ""
    assert canonical.embedding_dimensions == 0


def test_profile_worker_uses_immutable_identity_with_expiring_production_sessions() -> None:
    base_factory = session_factory()
    with base_factory() as db:
        bind = db.get_bind()
    expiring_factory = sessionmaker(bind=bind, expire_on_commit=True)
    vector_store = RecordingVectorStore()
    embedding = CountingEmbeddingClient()
    with expiring_factory() as db:
        _seed_profile_job(db, suffix="expiring")
        db.commit()

    with (
        patch("app.services.search.jobs.build_vector_store", return_value=vector_store),
        patch("app.services.search.jobs._build_profile_embedding_client", return_value=embedding),
        expiring_factory() as db,
    ):
        stats = index_pending_search_documents(db, session_factory=expiring_factory)

    with expiring_factory() as db:
        job = db.get(SearchIndexJob, "job-expiring")
        profile_document = db.get(FamilySearchProfileDocument, "profile-document-expiring")
    assert stats == {"indexed": 1, "failed": 0, "skipped": 0}
    assert job is not None and job.status == "succeeded"
    assert profile_document is not None and profile_document.status == "indexed"


def test_stale_profile_vector_handoff_requeues_job_and_releases_lock() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    embedding = CountingEmbeddingClient()
    with SessionLocal() as db:
        _seed_profile_job(db, suffix="stale-handoff")
        db.commit()

    # Simulate a concurrent document edit between the durable Provider result
    # and the Qdrant handoff.  The live profile document no longer matches the
    # worker snapshot, so the old vector must be discarded and retried.
    with patch(
        "app.services.search.jobs.prepare_profile_vector_handoff",
        return_value=None,
    ):
        with SessionLocal() as db:
            index_pending_search_documents(
                db,
                embedding_client=embedding,
                vector_store=vector_store,  # type: ignore[arg-type]
                session_factory=SessionLocal,
            )

    with SessionLocal() as db:
        job = db.get(SearchIndexJob, "job-stale-handoff")
        profile_document = db.get(FamilySearchProfileDocument, "profile-document-stale-handoff")

    assert job is not None
    assert job.status == "queued"
    assert job.locked_at is None
    assert job.completed_at is None
    assert job.usage_attempt_key is None
    assert profile_document is not None
    assert profile_document.status == "pending"
    assert profile_document.vector_json is None


def test_unexpected_profile_worker_exception_is_persisted_instead_of_staying_running() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        _seed_profile_job(db, suffix="worker-crash")
        db.commit()

    with patch("app.services.search.jobs.build_vector_store", side_effect=RuntimeError("worker crashed")):
        with SessionLocal() as db:
            stats = index_pending_search_documents(db, session_factory=SessionLocal)

    with SessionLocal() as db:
        job = db.get(SearchIndexJob, "job-worker-crash")
        profile_document = db.get(FamilySearchProfileDocument, "profile-document-worker-crash")
    assert stats == {"indexed": 0, "failed": 1, "skipped": 0}
    assert job is not None and job.status == "failed"
    assert job.error_code == "search_index_worker_failed"
    assert job.locked_at is None
    assert profile_document is not None and profile_document.status == "failed"


def test_qdrant_retry_reuses_profile_pending_vector_without_another_embedding_send() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore(fail_times=1)
    embedding = CountingEmbeddingClient()
    with SessionLocal() as db:
        _document, job = _seed_profile_job(db)
        db.commit()
        first = index_pending_search_documents(
            db,
            embedding_client=embedding,
            vector_store=vector_store,  # type: ignore[arg-type]
            session_factory=SessionLocal,
        )
        db.expire_all()
        profile_document = db.scalar(select(FamilySearchProfileDocument))
        failed_job = db.get(SearchIndexJob, job.id)
        assert profile_document is not None and profile_document.vector_json == [0.1, 0.2]
        assert failed_job is not None and failed_job.status == "failed"

        second = index_pending_search_documents(
            db,
            embedding_client=embedding,
            vector_store=vector_store,  # type: ignore[arg-type]
            session_factory=SessionLocal,
        )
        db.expire_all()
        profile_document = db.scalar(select(FamilySearchProfileDocument))
        succeeded_job = db.get(SearchIndexJob, job.id)

    assert first == {"indexed": 0, "failed": 1, "skipped": 0}
    assert second == {"indexed": 1, "failed": 0, "skipped": 0}
    assert embedding.call_count == 1
    assert vector_store.call_count == 2
    assert profile_document is not None and profile_document.vector_json is None
    assert profile_document.status == "indexed"
    assert succeeded_job is not None and succeeded_job.status == "succeeded"


def test_index_pending_search_documents_keeps_family_profile_work_separate() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    embedding = CountingEmbeddingClient()
    with SessionLocal() as db:
        _seed_profile_job(db, suffix="1")
        _seed_profile_job(db, suffix="2")
        db.commit()
        stats = index_pending_search_documents(
            db,
            batch_size=2,
            embedding_client=embedding,
            vector_store=vector_store,  # type: ignore[arg-type]
            session_factory=SessionLocal,
        )

    assert stats == {"indexed": 2, "failed": 0, "skipped": 0}
    assert embedding.call_count == 2
    assert {payload["family_id"] for _, _, payload in vector_store.points} == {
        "family-1",
        "family-2",
    }
