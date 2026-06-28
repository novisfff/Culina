from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.domain import SearchDocument
from app.services.search.vector_store import VectorPoint, VectorStore, VectorStoreUnavailableError, build_vector_store


def cleanup_stale_vector_points(
    db: Session,
    *,
    family_id: str | None = None,
    scopes: list[str] | None = None,
    batch_size: int = 100,
    max_pages: int | None = None,
    vector_store: VectorStore | None = None,
) -> dict[str, int]:
    vector_store = vector_store or build_vector_store()
    selected_scopes = scopes or ["ingredient", "food", "recipe"]
    family_ids = [family_id] if family_id else _family_ids_with_search_documents(db)
    stats = {"scanned": 0, "deleted": 0, "failed": 0}
    for current_family_id in family_ids:
        offset: object | None = None
        page_count = 0
        while True:
            if max_pages is not None and page_count >= max_pages:
                break
            try:
                page = vector_store.scroll_points(
                    family_id=current_family_id,
                    scopes=selected_scopes,
                    limit=batch_size,
                    offset=offset,
                )
            except VectorStoreUnavailableError:
                stats["failed"] += 1
                break
            page_count += 1
            stats["scanned"] += len(page.points)
            stale_point_ids = _stale_point_ids(db, family_id=current_family_id, points=page.points)
            for point_id in stale_point_ids:
                try:
                    vector_store.delete_point(point_id=point_id)
                    stats["deleted"] += 1
                except VectorStoreUnavailableError:
                    stats["failed"] += 1
            if not page.next_page_offset:
                break
            offset = page.next_page_offset
    return stats


def _family_ids_with_search_documents(db: Session) -> list[str]:
    return list(db.scalars(select(SearchDocument.family_id).distinct().order_by(SearchDocument.family_id.asc())))


def _stale_point_ids(db: Session, *, family_id: str, points: list[VectorPoint]) -> list[str]:
    keys = [
        (str(point.payload.get("entity_type") or ""), str(point.payload.get("entity_id") or ""))
        for point in points
    ]
    keys = [(entity_type, entity_id) for entity_type, entity_id in keys if entity_type and entity_id]
    if not keys:
        return [point.point_id for point in points]
    conditions = [
        (SearchDocument.entity_type == entity_type) & (SearchDocument.entity_id == entity_id)
        for entity_type, entity_id in keys
    ]
    documents = {
        (document.entity_type, document.entity_id): document
        for document in db.scalars(
            select(SearchDocument).where(
                SearchDocument.family_id == family_id,
                or_(*conditions),
            )
        )
    }
    stale = []
    for point in points:
        entity_type = str(point.payload.get("entity_type") or "")
        entity_id = str(point.payload.get("entity_id") or "")
        document = documents.get((entity_type, entity_id))
        if document is None:
            stale.append(point.point_id)
            continue
        if point.payload.get("content_hash") != document.content_hash:
            stale.append(point.point_id)
            continue
        if point.payload.get("document_builder_version") != document.document_builder_version:
            stale.append(point.point_id)
    return stale
