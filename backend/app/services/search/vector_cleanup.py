from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.domain import SearchDocument
from app.models.family_model_settings import FamilySearchProfile, FamilySearchProfileDocument
from app.services.search.vector_store import (
    VectorPoint,
    VectorStore,
    VectorStoreUnavailableError,
    build_vector_store,
)


def cleanup_stale_vector_points(
    db: Session,
    *,
    family_id: str | None = None,
    search_profile_id: str | None = None,
    scopes: list[str] | None = None,
    batch_size: int = 100,
    max_pages: int | None = None,
    vector_store: VectorStore | None = None,
    vector_store_factory: Callable[[FamilySearchProfile], VectorStore] | None = None,
) -> dict[str, int]:
    """Delete points that no longer match one profile's durable state.

    Qdrant collections are profile identities, not family-global resources.
    A point is retained only if its payload and the matching
    ``FamilySearchProfileDocument`` agree with the canonical document.  A
    pending handoff is retained as well: it may be the result of a successful
    Qdrant write immediately before the database completion transaction.
    """

    if batch_size <= 0:
        raise ValueError("vector cleanup batch_size must be positive")
    profiles = _profiles_for_cleanup(
        db,
        family_id=family_id,
        search_profile_id=search_profile_id,
    )
    if vector_store is not None and len(profiles) > 1:
        raise ValueError("an explicit vector store requires exactly one search profile")
    selected_scopes = scopes or ["ingredient", "food", "recipe"]
    stats = {"scanned": 0, "deleted": 0, "failed": 0}
    settings = get_settings()

    for profile in profiles:
        store = (
            vector_store
            if vector_store is not None
            else (
                vector_store_factory(profile)
                if vector_store_factory is not None
                else build_vector_store(settings, qdrant_collection=profile.qdrant_collection)
            )
        )
        offset: object | None = None
        page_count = 0
        while True:
            if max_pages is not None and page_count >= max_pages:
                break
            try:
                page = store.scroll_points(
                    family_id=profile.family_id,
                    search_profile_id=profile.id,
                    scopes=selected_scopes,
                    limit=batch_size,
                    offset=offset,
                )
            except VectorStoreUnavailableError:
                stats["failed"] += 1
                break
            page_count += 1
            stats["scanned"] += len(page.points)
            stale_point_ids = _stale_point_ids(
                db,
                profile=profile,
                points=page.points,
            )
            for point_id in stale_point_ids:
                try:
                    store.delete_point(point_id=point_id)
                    stats["deleted"] += 1
                except VectorStoreUnavailableError:
                    stats["failed"] += 1
            if not page.next_page_offset:
                break
            offset = page.next_page_offset
    return stats


def _profiles_for_cleanup(
    db: Session,
    *,
    family_id: str | None,
    search_profile_id: str | None,
) -> tuple[FamilySearchProfile, ...]:
    statement = select(FamilySearchProfile).where(FamilySearchProfile.qdrant_collection != "")
    if family_id is not None:
        statement = statement.where(FamilySearchProfile.family_id == family_id)
    if search_profile_id is not None:
        statement = statement.where(FamilySearchProfile.id == search_profile_id)
    return tuple(
        db.scalars(
            statement.order_by(
                FamilySearchProfile.family_id.asc(),
                FamilySearchProfile.created_at.asc(),
                FamilySearchProfile.id.asc(),
            )
        )
    )


def _stale_point_ids(
    db: Session,
    *,
    profile: FamilySearchProfile,
    points: list[VectorPoint],
) -> list[str]:
    keys = [
        (str(point.payload.get("entity_type") or ""), str(point.payload.get("entity_id") or ""))
        for point in points
    ]
    keys = [(entity_type, entity_id) for entity_type, entity_id in keys if entity_type and entity_id]
    documents: dict[tuple[str, str], tuple[FamilySearchProfileDocument, SearchDocument]] = {}
    if keys:
        conditions = [
            (SearchDocument.entity_type == entity_type) & (SearchDocument.entity_id == entity_id)
            for entity_type, entity_id in keys
        ]
        documents = {
            (document.entity_type, document.entity_id): (profile_document, document)
            for profile_document, document in db.execute(
                select(FamilySearchProfileDocument, SearchDocument)
                .join(
                    SearchDocument,
                    SearchDocument.id == FamilySearchProfileDocument.search_document_id,
                )
                .where(
                    FamilySearchProfileDocument.family_id == profile.family_id,
                    FamilySearchProfileDocument.search_profile_id == profile.id,
                    SearchDocument.family_id == profile.family_id,
                    or_(*conditions),
                )
            )
        }

    stale: list[str] = []
    for point in points:
        payload = point.payload
        entity_type = str(payload.get("entity_type") or "")
        entity_id = str(payload.get("entity_id") or "")
        profile_document_and_document = documents.get((entity_type, entity_id))
        if (
            payload.get("family_id") != profile.family_id
            or payload.get("search_profile_id") != profile.id
            or profile_document_and_document is None
        ):
            stale.append(point.point_id)
            continue
        profile_document, document = profile_document_and_document
        if (
            profile_document.status not in {"indexed", "pending_handoff"}
            or profile_document.content_hash != document.content_hash
            or payload.get("content_hash") != document.content_hash
            or payload.get("document_builder_version") != profile.document_builder_version
        ):
            stale.append(point.point_id)
    return stale
