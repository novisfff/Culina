from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageAttributionKind, ModelUsageOperationSource
from app.core.utils import create_id
from app.models.domain import SearchDocument
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageError
from app.services.model_usage.types import UsageAttribution
from app.services.search.embeddings import EmbeddingClient, EmbeddingUnavailableError, build_embedding_client
from app.services.search.vector_store import VectorStore, VectorStoreUnavailableError, build_vector_store

VECTOR_RETRY_BASE_SECONDS = 60
VECTOR_RETRY_MAX_SECONDS = 3600


@dataclass(frozen=True, slots=True)
class SearchDocumentIndexSnapshot:
    document_id: str
    content_hash: str
    document_builder_version: str
    semantic_text: str
    embedding_model: str
    embedding_dimensions: int


@dataclass(frozen=True, slots=True)
class PendingVectorHandoff:
    document_id: str
    point_id: str
    vector: list[float]
    payload: dict[str, object]


def search_point_id(entity_type: str, entity_id: str) -> str:
    return f"{entity_type}:{entity_id}"


def system_embedding_attribution(*, family_id: str, logical_operation_id: str) -> UsageAttribution:
    return UsageAttribution(
        family_id=family_id,
        attribution_kind=ModelUsageAttributionKind.SYSTEM,
        actor_user_id=None,
        operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
        logical_operation_id=logical_operation_id,
    )


def snapshot_search_document(document: SearchDocument) -> SearchDocumentIndexSnapshot:
    return SearchDocumentIndexSnapshot(
        document_id=document.id,
        content_hash=document.content_hash,
        document_builder_version=document.document_builder_version,
        semantic_text=document.semantic_text,
        embedding_model=document.embedding_model,
        embedding_dimensions=document.embedding_dimensions,
    )


def pending_vector_is_current(document: SearchDocument) -> bool:
    return (
        document.pending_vector is not None
        and document.pending_vector_content_hash == document.content_hash
        and document.pending_vector_model == document.embedding_model
        and document.pending_vector_dimensions == document.embedding_dimensions
        and bool(document.pending_vector_model)
        and (document.pending_vector_dimensions or 0) > 0
    )


def clear_pending_vector(document: SearchDocument) -> None:
    document.pending_vector = None
    document.pending_vector_content_hash = None
    document.pending_vector_model = None
    document.pending_vector_dimensions = None


def persist_pending_vector(
    document: SearchDocument,
    *,
    vector: list[float],
    snapshot: SearchDocumentIndexSnapshot,
    now: datetime,
) -> None:
    """Persist provider output before any Qdrant write is attempted.

    The snapshot intentionally travels with the vector.  If the document was
    edited while the provider request was in flight, the handoff phase detects
    that mismatch, discards the stale vector, and lets the new content create
    a separate attempt rather than replaying the old provider send.
    """

    if len(vector) != snapshot.embedding_dimensions:
        raise EmbeddingUnavailableError("embedding vector dimension mismatch")
    document.pending_vector = list(vector)
    document.pending_vector_content_hash = snapshot.content_hash
    document.pending_vector_model = snapshot.embedding_model
    document.pending_vector_dimensions = snapshot.embedding_dimensions
    document.vector_status = "pending"
    document.vector_error = None
    document.vector_attempt_count = (document.vector_attempt_count or 0) + 1
    document.last_vector_attempt_at = now


def pending_vector_payload(document: SearchDocument) -> dict[str, object]:
    if document.pending_vector is None:
        raise ValueError("search document has no pending vector")
    return {
        "family_id": document.family_id,
        "entity_type": document.entity_type,
        "entity_id": document.entity_id,
        "user_id": str((document.metadata_json or {}).get("user_id") or ""),
        "embedding_model": document.pending_vector_model,
        "embedding_dimensions": document.pending_vector_dimensions,
        "content_hash": document.pending_vector_content_hash,
        "document_builder_version": document.document_builder_version,
        "updated_at": document.updated_at.isoformat() if document.updated_at else "",
    }


def prepare_pending_vector_handoff(document: SearchDocument) -> PendingVectorHandoff | None:
    if document.pending_vector is None or not pending_vector_is_current(document):
        return None
    return PendingVectorHandoff(
        document_id=document.id,
        point_id=search_point_id(document.entity_type, document.entity_id),
        vector=list(document.pending_vector),
        payload=pending_vector_payload(document),
    )


def write_pending_vector_handoff(
    handoff: PendingVectorHandoff,
    *,
    vector_store: VectorStore,
) -> None:
    dimensions = handoff.payload.get("embedding_dimensions")
    if isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions <= 0:
        raise ValueError("pending vector dimensions invalid")
    vector_store.ensure_collection(vector_size=dimensions)
    vector_store.upsert_point(
        point_id=handoff.point_id,
        vector=handoff.vector,
        payload=handoff.payload,
    )


def handoff_pending_vector(
    document: SearchDocument,
    *,
    vector_store: VectorStore,
    now: datetime,
) -> str:
    """Write only an already-persisted vector to Qdrant.

    This function performs only the external call and does not mutate or
    commit.  Its caller commits before entering it, re-loads the pending
    identity after it returns, then clears that exact identity.  That prevents
    an in-flight Qdrant write from deleting a newer vector.
    """

    handoff = prepare_pending_vector_handoff(document)
    if handoff is None:
        return "skipped"
    write_pending_vector_handoff(handoff, vector_store=vector_store)
    del now
    return "indexed"


def index_pending_search_documents(
    db: Session,
    *,
    batch_size: int = 20,
    embedding_client: EmbeddingClient | None = None,
    vector_store: VectorStore | None = None,
) -> dict[str, int]:
    """Run durable vector handoff in two short phases.

    Phase A sends one provider batch per family and commits returned vectors to
    ``search_documents``.  Phase B only writes those persisted vectors to
    Qdrant.  A Qdrant retry therefore never sends another embedding request.
    """

    if batch_size <= 0:
        return {"indexed": 0, "failed": 0, "skipped": 0}
    embedding_client = embedding_client or build_embedding_client()
    vector_store = vector_store or build_vector_store()
    now = datetime.now(timezone.utc)
    stats = {"indexed": 0, "failed": 0, "skipped": 0}

    # Finish any durable Qdrant handoffs before allocating another embedding
    # send.  They are retry-safe and do not consume provider budget again.
    pending = _select_pending_handoffs(db, batch_size=batch_size)
    if pending:
        db.commit()
        _handoff_documents(db, pending, vector_store=vector_store, now=now, stats=stats)
        remaining = batch_size - len(pending)
        if remaining <= 0:
            return stats
    else:
        remaining = batch_size

    documents = _select_indexable_documents(db, batch_size=remaining, now=now)
    if not documents:
        return stats
    for document in documents:
        # Historical rows should have a database default, but normalize before
        # the phase boundary so an old nullable value cannot make the short
        # commit fail before it is repaired.
        if document.vector_attempt_count is None:  # type: ignore[comparison-overlap]
            document.vector_attempt_count = 0
    documents = _compatible_documents(
        documents,
        embedding_client=embedding_client,
        stats=stats,
        now=now,
    )
    if not documents:
        db.commit()
        return stats
    snapshots = {document.id: snapshot_search_document(document) for document in documents}
    # Release row locks before the external provider call.  The snapshot makes
    # a concurrent document edit observable in the handoff phase.
    db.commit()

    by_family: dict[str, list[SearchDocument]] = defaultdict(list)
    for document in documents:
        by_family[document.family_id].append(document)
    for family_id, family_documents in sorted(by_family.items()):
        attempt_key = create_id("search-vector-batch")
        try:
            result = embedding_client.embed_batch(
                [snapshots[document.id].semantic_text for document in family_documents],
                attribution=system_embedding_attribution(
                    family_id=family_id,
                    logical_operation_id=attempt_key,
                ),
                attempt_key=attempt_key,
            )
            if len(result.vectors) != len(family_documents):
                raise EmbeddingUnavailableError("embedding response count mismatch")
        except ModelUsageBlocked as exc:
            for document in family_documents:
                _mark_failed(document, exc.code, now=now)
                stats["failed"] += 1
            db.commit()
            continue
        except (EmbeddingUnavailableError, ModelUsageError) as exc:
            for document in family_documents:
                _mark_failed(document, str(exc), now=now)
                stats["failed"] += 1
            db.commit()
            continue

        for document, vector in zip(family_documents, result.vectors, strict=True):
            current = db.get(SearchDocument, document.id)
            if current is None:
                stats["skipped"] += 1
                continue
            persist_pending_vector(
                current,
                vector=vector,
                snapshot=snapshots[document.id],
                now=now,
            )
        # Provider success is durable before Qdrant sees even one vector.
        db.commit()
        persisted = [db.get(SearchDocument, document.id) for document in family_documents]
        _handoff_documents(
            db,
            [document for document in persisted if document is not None],
            vector_store=vector_store,
            now=now,
            stats=stats,
        )
    return stats


def _handoff_documents(
    db: Session,
    documents: list[SearchDocument],
    *,
    vector_store: VectorStore,
    now: datetime,
    stats: dict[str, int],
) -> None:
    for document in documents:
        # No transaction is held while calling Qdrant.  Capture the current
        # pending identity, commit, then re-load before clearing it.
        document_id = document.id
        db.refresh(document)
        if document.pending_vector is None:
            continue
        pending_identity = _pending_vector_identity(document)
        handoff = prepare_pending_vector_handoff(document)
        if handoff is None:
            clear_pending_vector(document)
            document.vector_status = "pending"
            document.vector_error = None
            db.commit()
            stats["skipped"] += 1
            continue
        db.commit()
        try:
            write_pending_vector_handoff(handoff, vector_store=vector_store)
            status = "indexed"
        except VectorStoreUnavailableError as exc:
            db.expire_all()
            current = db.get(SearchDocument, document_id)
            if current is not None and _pending_vector_identity(current) == pending_identity:
                _mark_qdrant_failure(current, str(exc), now=now)
                db.commit()
            stats["failed"] += 1
            continue
        db.expire_all()
        current = db.get(SearchDocument, document_id)
        if current is None:
            stats["skipped"] += 1
            continue
        if status == "indexed" and _pending_vector_identity(current) == pending_identity:
            clear_pending_vector(current)
            current.vector_status = "indexed"
            current.vector_error = None
            current.last_vector_attempt_at = now
            current.indexed_at = now
            db.commit()
            stats["indexed"] += 1
        else:
            db.commit()
            stats["skipped"] += 1


def _pending_vector_identity(document: SearchDocument) -> tuple[object, ...] | None:
    if document.pending_vector is None:
        return None
    return (
        tuple(document.pending_vector),
        document.pending_vector_content_hash,
        document.pending_vector_model,
        document.pending_vector_dimensions,
    )


def _select_pending_handoffs(db: Session, *, batch_size: int) -> list[SearchDocument]:
    return list(
        db.scalars(
            select(SearchDocument)
            .where(SearchDocument.pending_vector.is_not(None))
            .order_by(SearchDocument.updated_at.asc(), SearchDocument.id.asc())
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        )
    )


def _select_indexable_documents(db: Session, *, batch_size: int, now: datetime) -> list[SearchDocument]:
    if batch_size <= 0:
        return []
    documents: list[SearchDocument] = []
    pending_statement = (
        select(SearchDocument)
        .where(
            SearchDocument.vector_status.in_(["pending", "stale"]),
            SearchDocument.pending_vector.is_(None),
        )
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
        .where(
            SearchDocument.vector_status == "failed",
            SearchDocument.pending_vector.is_(None),
        )
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


def _mark_qdrant_failure(document: SearchDocument, message: str, *, now: datetime) -> None:
    # The vector is already durable, so this must not consume another provider
    # attempt or discard data needed by the next Qdrant-only retry.
    document.vector_status = "failed"
    document.vector_error = message[:2000]
    document.last_vector_attempt_at = now
