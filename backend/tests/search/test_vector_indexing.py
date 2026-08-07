from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import Family, SearchDocument
from app.services.model_usage.types import UsageAttribution
from app.services.search.documents import SearchDocumentPayload
from app.services.search.indexing import upsert_search_document
from app.services.search.vector_indexing import index_pending_search_documents
from app.services.search.vector_store import VectorSearchHit, VectorStoreUnavailableError
from tests.search._support import FakeEmbeddingClient, session_factory


class MutatingEmbeddingClient(FakeEmbeddingClient):
    def __init__(self, db: Session) -> None:
        self.db = db

    def embed_batch(
        self,
        texts: list[str],
        *,
        attribution: UsageAttribution,
        attempt_key: str,
    ):
        document = self.db.scalar(select(SearchDocument))
        assert document is not None
        document.semantic_text = f"{document.semantic_text}\n已变更"
        document.content_hash = "hash-changed-during-embedding"
        self.db.flush()
        return super().embed_batch(
            texts,
            attribution=attribution,
            attempt_key=attempt_key,
        )


class CountingEmbeddingClient(FakeEmbeddingClient):
    def __init__(self) -> None:
        self.call_count = 0
        self.batches: list[tuple[str, list[str]]] = []

    def embed_batch(self, *args, **kwargs):
        self.call_count += 1
        self.batches.append((kwargs["attribution"].family_id, list(args[0])))
        return super().embed_batch(*args, **kwargs)


class RecordingVectorStore:
    def __init__(self, *, fail: bool = False, fail_times: int = 0) -> None:
        self.fail = fail
        self.fail_times = fail_times
        self.call_count = 0
        self.points: list[tuple[str, list[float], dict[str, object]]] = []
        self.vector_size = 0

    def ensure_collection(self, *, vector_size: int) -> None:
        self.vector_size = vector_size

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        self.call_count += 1
        if self.fail or self.fail_times > 0:
            self.fail_times -= 1
            raise VectorStoreUnavailableError("qdrant unavailable")
        self.points.append((point_id, vector, payload))

    def delete_point(self, *, point_id: str) -> None:
        del point_id

    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        del family_id, scopes, vector, limit
        return []


def _seed_document(db: Session, *, embedding_model: str = "fake-embedding", embedding_dimensions: int = 2) -> SearchDocument:
    db.add(Family(id="family-1", name="一号家庭"))
    document = upsert_search_document(
        db,
        SearchDocumentPayload(
            family_id="family-1",
            entity_type="ingredient",
            entity_id="ingredient-tomato",
            title_text="番茄",
            keyword_text="番茄 蔬菜",
            detail_text="",
            semantic_text="食材：番茄",
            metadata_json={},
            content_hash="hash-1",
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
        ),
    )
    db.commit()
    return document


def test_index_pending_search_documents_upserts_vector_and_marks_indexed() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    with SessionLocal() as db:
        _seed_document(db)
        stats = index_pending_search_documents(
            db,
            embedding_client=FakeEmbeddingClient(),
            vector_store=vector_store,
        )
        db.commit()

    assert stats == {"indexed": 1, "failed": 0, "skipped": 0}
    assert vector_store.vector_size == 2
    assert vector_store.points[0][0] == "ingredient:ingredient-tomato"
    assert vector_store.points[0][2]["family_id"] == "family-1"
    with SessionLocal() as db:
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.vector_status == "indexed"
        assert document.embedding_model == "fake-embedding"
        assert document.embedding_dimensions == 2


def test_index_pending_search_documents_treats_null_attempt_count_as_zero() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    with SessionLocal() as db:
        document = _seed_document(db)
        document.vector_attempt_count = None  # type: ignore[assignment]
        stats = index_pending_search_documents(
            db,
            embedding_client=FakeEmbeddingClient(),
            vector_store=vector_store,
        )
        db.commit()

    assert stats == {"indexed": 1, "failed": 0, "skipped": 0}
    with SessionLocal() as db:
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.vector_status == "indexed"
        assert document.vector_attempt_count == 1


def test_index_pending_search_documents_records_failure() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        _seed_document(db)
        stats = index_pending_search_documents(
            db,
            embedding_client=FakeEmbeddingClient(),
            vector_store=RecordingVectorStore(fail=True),
        )
        db.commit()

    assert stats == {"indexed": 0, "failed": 1, "skipped": 0}
    with SessionLocal() as db:
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.vector_status == "failed"
        assert "qdrant unavailable" in (document.vector_error or "")


def test_qdrant_failure_reuses_the_persisted_vector_without_another_embedding_call() -> None:
    SessionLocal = session_factory()
    embedding = CountingEmbeddingClient()
    vector_store = RecordingVectorStore(fail_times=1)
    with SessionLocal() as db:
        _seed_document(db)
        first = index_pending_search_documents(
            db,
            embedding_client=embedding,
            vector_store=vector_store,
        )
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.pending_vector == [0.1, 0.2]
        assert embedding.call_count == 1

        second = index_pending_search_documents(
            db,
            embedding_client=embedding,
            vector_store=vector_store,
        )
        db.commit()

    assert first == {"indexed": 0, "failed": 1, "skipped": 0}
    assert second == {"indexed": 1, "failed": 0, "skipped": 0}
    assert embedding.call_count == 1
    assert vector_store.call_count == 2
    with SessionLocal() as db:
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.pending_vector is None
        assert document.vector_status == "indexed"


def test_index_pending_search_documents_splits_provider_batches_by_family() -> None:
    SessionLocal = session_factory()
    embedding = CountingEmbeddingClient()
    vector_store = RecordingVectorStore()
    with SessionLocal() as db:
        _seed_document(db)
        db.add(Family(id="family-2", name="二号家庭"))
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-2",
                entity_type="ingredient",
                entity_id="ingredient-cucumber",
                title_text="黄瓜",
                keyword_text="黄瓜 蔬菜",
                detail_text="",
                semantic_text="食材：黄瓜",
                metadata_json={},
                content_hash="hash-2",
                embedding_model="fake-embedding",
                embedding_dimensions=2,
            ),
        )
        db.commit()

        stats = index_pending_search_documents(
            db,
            batch_size=2,
            embedding_client=embedding,
            vector_store=vector_store,
        )

    assert stats == {"indexed": 2, "failed": 0, "skipped": 0}
    assert [family_id for family_id, _ in embedding.batches] == ["family-1", "family-2"]
    assert all(len(texts) == 1 for _, texts in embedding.batches)


def test_index_pending_search_documents_rejects_stale_embedding_config() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    with SessionLocal() as db:
        _seed_document(db, embedding_model="", embedding_dimensions=0)
        stats = index_pending_search_documents(
            db,
            embedding_client=FakeEmbeddingClient(),
            vector_store=vector_store,
        )
        db.commit()

    assert stats == {"indexed": 0, "failed": 1, "skipped": 0}
    assert vector_store.points == []
    with SessionLocal() as db:
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.vector_status == "failed"
        assert "embedding config is stale" in (document.vector_error or "")


def test_index_pending_search_documents_respects_failed_retry_backoff() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    with SessionLocal() as db:
        document = _seed_document(db)
        document.vector_status = "failed"
        document.vector_attempt_count = 1
        document.last_vector_attempt_at = datetime.now(timezone.utc)
        db.commit()

        stats = index_pending_search_documents(
            db,
            embedding_client=FakeEmbeddingClient(),
            vector_store=vector_store,
        )

    assert stats == {"indexed": 0, "failed": 0, "skipped": 0}
    assert vector_store.points == []


def test_index_pending_search_documents_skips_stale_snapshot() -> None:
    SessionLocal = session_factory()
    vector_store = RecordingVectorStore()
    with SessionLocal() as db:
        _seed_document(db)
        stats = index_pending_search_documents(
            db,
            embedding_client=MutatingEmbeddingClient(db),
            vector_store=vector_store,
        )
        db.commit()

    assert stats == {"indexed": 0, "failed": 0, "skipped": 1}
    assert vector_store.points == []
    with SessionLocal() as db:
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.vector_status == "pending"
        assert document.content_hash == "hash-changed-during-embedding"


def test_upsert_search_document_keeps_indexed_embedding_metadata_when_hash_unchanged() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        document = _seed_document(db)
        document.vector_status = "indexed"
        document.embedding_model = "fake-embedding"
        document.embedding_dimensions = 2
        db.commit()

        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id="ingredient-tomato",
                title_text="番茄",
                keyword_text="番茄 蔬菜",
                detail_text="",
                semantic_text="食材：番茄",
                metadata_json={},
                content_hash="hash-1",
            ),
        )
        db.commit()

    with SessionLocal() as db:
        document = db.scalar(select(SearchDocument))
        assert document is not None
        assert document.vector_status == "indexed"
        assert document.embedding_model == "fake-embedding"
        assert document.embedding_dimensions == 2
