from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.domain import SearchDocument
from app.services.search.embeddings import EmbeddingClient, EmbeddingUnavailableError, build_embedding_client
from app.services.search.vector_store import VectorStore, VectorStoreUnavailableError, build_vector_store

VECTOR_RETRY_BASE_SECONDS = 60
VECTOR_RETRY_MAX_SECONDS = 3600


@dataclass(frozen=True)
class SearchDocumentIndexSnapshot:
    document_id: str
    content_hash: str
    document_builder_version: str
    semantic_text: str
    embedding_model: str
    embedding_dimensions: int


def search_point_id(entity_type: str, entity_id: str) -> str:
    return f"{entity_type}:{entity_id}"


def index_pending_search_documents(
    db: Session,
    *,
    batch_size: int = 20,
    embedding_client: EmbeddingClient | None = None,
    vector_store: VectorStore | None = None,
) -> dict[str, int]:
    embedding_client = embedding_client or build_embedding_client()
    vector_store = vector_store or build_vector_store()
    now = datetime.now(timezone.utc)
    documents = _select_indexable_documents(db, batch_size=batch_size, now=now)
    stats = {"indexed": 0, "failed": 0, "skipped": 0}
    if not documents:
        return stats
    documents = _compatible_documents(documents, embedding_client=embedding_client, stats=stats, now=now)
    if not documents:
        return stats
    snapshots = {document.id: _snapshot(document) for document in documents}

    try:
        vector_store.ensure_collection(vector_size=embedding_client.dimensions)
        vectors = embedding_client.embed_batch([document.semantic_text for document in documents])
    except (EmbeddingUnavailableError, VectorStoreUnavailableError) as exc:
        for document in documents:
            _mark_failed(document, str(exc), now=now)
            stats["failed"] += 1
        return stats

    for document, vector in zip(documents, vectors, strict=False):
        db.refresh(document)
        if not _is_snapshot_current(document, snapshots[document.id]):
            stats["skipped"] += 1
            continue
        try:
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
        except VectorStoreUnavailableError as exc:
            _mark_failed(document, str(exc), now=now)
            stats["failed"] += 1
            continue
        document.embedding_model = embedding_client.model
        document.embedding_dimensions = embedding_client.dimensions
        document.vector_status = "indexed"
        document.vector_error = None
        document.vector_attempt_count = (document.vector_attempt_count or 0) + 1
        document.last_vector_attempt_at = now
        document.indexed_at = now
        stats["indexed"] += 1
    return stats


def _select_indexable_documents(db: Session, *, batch_size: int, now: datetime) -> list[SearchDocument]:
    if batch_size <= 0:
        return []
    documents: list[SearchDocument] = []
    pending_statement = (
        select(SearchDocument)
        .where(SearchDocument.vector_status.in_(["pending", "stale"]))
        .order_by(SearchDocument.updated_at.asc(), SearchDocument.id.asc())
        .limit(batch_size)
        .with_for_update(skip_locked=True)
    )
    documents.extend(db.scalars(pending_statement))
    remaining = batch_size - len(documents)
    if remaining <= 0:
        return documents

    failed_statement = (
        select(SearchDocument)
        .where(SearchDocument.vector_status == "failed")
        .order_by(SearchDocument.last_vector_attempt_at.asc(), SearchDocument.updated_at.asc(), SearchDocument.id.asc())
        .limit(max(remaining * 5, remaining))
        .with_for_update(skip_locked=True)
    )
    for document in db.scalars(failed_statement):
        if _failed_document_ready(document, now=now):
            documents.append(document)
        if len(documents) >= batch_size:
            break
    return documents


def _failed_document_ready(document: SearchDocument, *, now: datetime) -> bool:
    if document.last_vector_attempt_at is None:
        return True
    last_attempt_at = document.last_vector_attempt_at
    if last_attempt_at.tzinfo is None:
        last_attempt_at = last_attempt_at.replace(tzinfo=timezone.utc)
    return last_attempt_at <= now - timedelta(seconds=_retry_delay_seconds(document.vector_attempt_count or 0))


def _retry_delay_seconds(attempt_count: int) -> int:
    attempts = max(attempt_count, 1)
    return min(VECTOR_RETRY_BASE_SECONDS * (2 ** (attempts - 1)), VECTOR_RETRY_MAX_SECONDS)


def _snapshot(document: SearchDocument) -> SearchDocumentIndexSnapshot:
    return SearchDocumentIndexSnapshot(
        document_id=document.id,
        content_hash=document.content_hash,
        document_builder_version=document.document_builder_version,
        semantic_text=document.semantic_text,
        embedding_model=document.embedding_model,
        embedding_dimensions=document.embedding_dimensions,
    )


def _is_snapshot_current(document: SearchDocument, snapshot: SearchDocumentIndexSnapshot) -> bool:
    return (
        document.id == snapshot.document_id
        and document.vector_status in {"pending", "stale", "failed"}
        and document.content_hash == snapshot.content_hash
        and document.document_builder_version == snapshot.document_builder_version
        and document.semantic_text == snapshot.semantic_text
        and document.embedding_model == snapshot.embedding_model
        and document.embedding_dimensions == snapshot.embedding_dimensions
    )


def _compatible_documents(
    documents: list[SearchDocument],
    *,
    embedding_client: EmbeddingClient,
    stats: dict[str, int],
    now: datetime,
) -> list[SearchDocument]:
    compatible = []
    for document in documents:
        if document.embedding_model == embedding_client.model and document.embedding_dimensions == embedding_client.dimensions:
            compatible.append(document)
            continue
        _mark_failed(
            document,
            "search document embedding config is stale; rebuild search documents before vector indexing",
            now=now,
        )
        stats["failed"] += 1
    return compatible


def _mark_failed(document: SearchDocument, message: str, *, now: datetime) -> None:
    document.vector_status = "failed"
    document.vector_error = message[:2000]
    document.vector_attempt_count = (document.vector_attempt_count or 0) + 1
    document.last_vector_attempt_at = now
