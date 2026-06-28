from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import Family, SearchDocument
from app.services.search.documents import SearchDocumentPayload
from app.services.search.indexing import upsert_search_document
from app.services.search.vector_indexing import index_pending_search_documents
from app.services.search.vector_store import VectorSearchHit, VectorStoreUnavailableError
from tests.search._support import FakeEmbeddingClient, session_factory


class MutatingEmbeddingClient(FakeEmbeddingClient):
    def __init__(self, db: Session) -> None:
        self.db = db

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        document = self.db.scalar(select(SearchDocument))
        assert document is not None
        document.semantic_text = f"{document.semantic_text}\n已变更"
        document.content_hash = "hash-changed-during-embedding"
        self.db.flush()
        return super().embed_batch(texts)


class RecordingVectorStore:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.points: list[tuple[str, list[float], dict[str, object]]] = []
        self.vector_size = 0

    def ensure_collection(self, *, vector_size: int) -> None:
        self.vector_size = vector_size

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        if self.fail:
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
