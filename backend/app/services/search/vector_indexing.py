from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Callable

from sqlalchemy.orm import Session

from app.core.enums import (
    FamilyModelSearchProfileStatus,
    ModelUsageAttributionKind,
    ModelUsageOperationSource,
)
from app.db.session import SessionLocal
from app.models.domain import SearchDocument, SearchIndexJob
from app.models.family_model_settings import FamilySearchProfile, FamilySearchProfileDocument
from app.services.model_usage.types import UsageAttribution
from app.services.search.embeddings import EmbeddingClient, EmbeddingUnavailableError
from app.services.search.vector_store import VectorStore


@dataclass(frozen=True, slots=True)
class SearchProfileDocumentSnapshot:
    """Immutable text/index identity used for exactly one profile send."""

    profile_document_id: str
    family_id: str
    search_profile_id: str
    search_document_id: str
    entity_type: str
    entity_id: str
    semantic_text: str
    content_hash: str
    generation: int
    document_builder_version: str
    embedding_model: str
    embedding_dimensions: int
    user_id: str | None


@dataclass(frozen=True, slots=True)
class ProfilePendingVectorHandoff:
    """A durable, Qdrant-only handoff for one profile document."""

    profile_document_id: str
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


def snapshot_profile_document(
    profile_document: FamilySearchProfileDocument,
    *,
    document: SearchDocument,
    search_profile: FamilySearchProfile,
) -> SearchProfileDocumentSnapshot:
    """Capture canonical text together with an immutable profile identity."""

    if (
        profile_document.family_id != search_profile.family_id
        or profile_document.search_profile_id != search_profile.id
        or profile_document.search_document_id != document.id
        or document.family_id != search_profile.family_id
    ):
        raise ValueError("search profile document identity mismatch")
    if profile_document.content_hash != document.content_hash:
        raise ValueError("search profile document content is stale")
    if search_profile.dimensions <= 0 or not search_profile.embedding_model:
        raise EmbeddingUnavailableError("search profile embedding identity invalid")
    metadata = document.metadata_json if isinstance(document.metadata_json, dict) else {}
    raw_user_id = metadata.get("user_id")
    return SearchProfileDocumentSnapshot(
        profile_document_id=profile_document.id,
        family_id=search_profile.family_id,
        search_profile_id=search_profile.id,
        search_document_id=document.id,
        entity_type=document.entity_type,
        entity_id=document.entity_id,
        semantic_text=document.semantic_text,
        content_hash=document.content_hash,
        generation=profile_document.generation,
        document_builder_version=search_profile.document_builder_version,
        embedding_model=search_profile.embedding_model,
        embedding_dimensions=search_profile.dimensions,
        user_id=str(raw_user_id) if raw_user_id else None,
    )


def profile_pending_vector_is_current(
    row: FamilySearchProfileDocument,
    snapshot: SearchProfileDocumentSnapshot,
) -> bool:
    return (
        row.id == snapshot.profile_document_id
        and row.family_id == snapshot.family_id
        and row.search_profile_id == snapshot.search_profile_id
        and row.search_document_id == snapshot.search_document_id
        and row.content_hash == snapshot.content_hash
        and row.generation == snapshot.generation
        and row.vector_json is not None
        and row.vector_dimensions == snapshot.embedding_dimensions
        and row.status == "pending_handoff"
    )


def profile_pending_vector_is_current_without_vector(
    row: FamilySearchProfileDocument,
    snapshot: SearchProfileDocumentSnapshot,
) -> bool:
    return (
        row.id == snapshot.profile_document_id
        and row.family_id == snapshot.family_id
        and row.search_profile_id == snapshot.search_profile_id
        and row.search_document_id == snapshot.search_document_id
        and row.content_hash == snapshot.content_hash
        and row.generation == snapshot.generation
        and row.status in {"pending", "indexing", "pending_handoff"}
    )


def clear_profile_pending_vector(row: FamilySearchProfileDocument) -> None:
    row.vector_json = None
    row.vector_dimensions = None


def persist_profile_pending_vector(
    row: FamilySearchProfileDocument,
    *,
    vector: list[float],
    snapshot: SearchProfileDocumentSnapshot,
    now: datetime,
) -> None:
    """Durably store a Provider result before its Qdrant handoff.

    The canonical ``SearchDocument`` is intentionally absent from this API:
    active and candidate profiles may hold vectors with different dimensions
    for the same document at the same time.
    """

    if not profile_pending_vector_is_current_without_vector(row, snapshot):
        raise ValueError("search profile document snapshot is stale")
    if len(vector) != snapshot.embedding_dimensions:
        raise EmbeddingUnavailableError("embedding vector dimension mismatch")
    row.vector_json = list(vector)
    row.vector_dimensions = snapshot.embedding_dimensions
    row.status = "pending_handoff"
    row.error_code = None
    row.attempt_count = (row.attempt_count or 0) + 1
    row.last_attempt_at = now


def prepare_profile_vector_handoff(
    profile_document: FamilySearchProfileDocument,
    *,
    snapshot: SearchProfileDocumentSnapshot,
    search_profile: FamilySearchProfile,
) -> ProfilePendingVectorHandoff | None:
    if (
        search_profile.id != snapshot.search_profile_id
        or search_profile.family_id != snapshot.family_id
        or profile_document.search_profile_id != search_profile.id
        or search_profile.status
        not in {
            FamilyModelSearchProfileStatus.PROVISIONING,
            FamilyModelSearchProfileStatus.ACTIVE,
        }
        or not profile_pending_vector_is_current(profile_document, snapshot)
    ):
        return None
    assert profile_document.vector_json is not None
    return ProfilePendingVectorHandoff(
        profile_document_id=profile_document.id,
        point_id=search_point_id(snapshot.entity_type, snapshot.entity_id),
        vector=list(profile_document.vector_json),
        payload={
            "family_id": snapshot.family_id,
            "search_profile_id": snapshot.search_profile_id,
            "entity_type": snapshot.entity_type,
            "entity_id": snapshot.entity_id,
            "user_id": snapshot.user_id or "",
            "content_hash": snapshot.content_hash,
            "document_builder_version": snapshot.document_builder_version,
            "embedding_model": snapshot.embedding_model,
            "embedding_dimensions": snapshot.embedding_dimensions,
        },
    )


def write_profile_vector_handoff(
    handoff: ProfilePendingVectorHandoff,
    *,
    vector_store: VectorStore,
) -> None:
    dimensions = handoff.payload.get("embedding_dimensions")
    if isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions <= 0:
        raise ValueError("profile vector dimensions invalid")
    vector_store.ensure_collection(vector_size=dimensions)
    vector_store.upsert_point(
        point_id=handoff.point_id,
        vector=handoff.vector,
        payload=handoff.payload,
    )


def index_pending_search_documents(
    db: Session,
    *,
    batch_size: int = 20,
    embedding_client: EmbeddingClient | None = None,
    vector_store: VectorStore | None = None,
    session_factory: Callable[[], Session] = SessionLocal,
) -> dict[str, int]:
    """Synchronously run profile-aware work for the rebuild command.

    The historical function name is retained for callers, but this function
    only claims jobs and delegates to the profile worker.  It never reads or
    writes legacy vector lifecycle fields on ``SearchDocument``.
    """

    if batch_size <= 0:
        return {"indexed": 0, "failed": 0, "skipped": 0}
    # Avoid a module cycle: jobs imports the profile handoff helpers above.
    from app.services.search.jobs import claim_pending_search_index_jobs, process_search_index_job

    job_ids = claim_pending_search_index_jobs(db, limit=batch_size)
    stats = {"indexed": 0, "failed": 0, "skipped": 0}
    for job_id in job_ids:
        process_search_index_job(
            job_id,
            session_factory=session_factory,
            claimed=True,
            embedding_client=embedding_client,
            vector_store=vector_store,
        )
        db.expire_all()
        job = db.get(SearchIndexJob, job_id)
        if job is None:
            stats["skipped"] += 1
        elif job.status == "succeeded" and job.vector_status == "indexed":
            stats["indexed"] += 1
        elif job.status == "failed":
            stats["failed"] += 1
        else:
            stats["skipped"] += 1
    return stats
