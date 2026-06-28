from __future__ import annotations

from app.models.domain import Family
from app.services.search.documents import SearchDocumentPayload
from app.services.search.indexing import delete_search_document, upsert_search_document
from app.services.search.vector_cleanup import cleanup_stale_vector_points
from app.services.search.vector_store import VectorPoint, VectorPointPage, VectorSearchHit, VectorStoreUnavailableError
from tests.search._support import session_factory


class FakeVectorStore:
    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.pages = [
            VectorPointPage(
                points=[
                    VectorPoint(
                        point_id="ingredient:kept",
                        payload={
                            "family_id": "family-1",
                            "entity_type": "ingredient",
                            "entity_id": "kept",
                            "content_hash": "hash-kept",
                            "document_builder_version": "v1",
                        },
                    ),
                    VectorPoint(
                        point_id="ingredient:missing",
                        payload={
                            "family_id": "family-1",
                            "entity_type": "ingredient",
                            "entity_id": "missing",
                            "content_hash": "hash-missing",
                            "document_builder_version": "v1",
                        },
                    ),
                    VectorPoint(
                        point_id="ingredient:stale",
                        payload={
                            "family_id": "family-1",
                            "entity_type": "ingredient",
                            "entity_id": "stale",
                            "content_hash": "old-hash",
                            "document_builder_version": "v1",
                        },
                    ),
                ]
            )
        ]

    def ensure_collection(self, *, vector_size: int) -> None:
        del vector_size

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        del point_id, vector, payload

    def delete_point(self, *, point_id: str) -> None:
        self.deleted.append(point_id)

    def scroll_points(
        self,
        *,
        family_id: str,
        scopes: list[str],
        limit: int,
        offset: object | None = None,
    ) -> VectorPointPage:
        del family_id, scopes, limit, offset
        return self.pages.pop(0) if self.pages else VectorPointPage(points=[])

    def search(self, *, family_id: str, scopes: list[str], vector: list[float], limit: int) -> list[VectorSearchHit]:
        del family_id, scopes, vector, limit
        return []


class FailingDeleteVectorStore(FakeVectorStore):
    def delete_point(self, *, point_id: str) -> None:
        del point_id
        raise VectorStoreUnavailableError("qdrant unavailable")


def test_cleanup_stale_vector_points_deletes_missing_or_changed_documents() -> None:
    SessionLocal = session_factory()
    vector_store = FakeVectorStore()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id="kept",
                title_text="番茄",
                keyword_text="番茄",
                detail_text="",
                semantic_text="食材：番茄",
                metadata_json={},
                content_hash="hash-kept",
            ),
        )
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="ingredient",
                entity_id="stale",
                title_text="土豆",
                keyword_text="土豆",
                detail_text="",
                semantic_text="食材：土豆",
                metadata_json={},
                content_hash="hash-stale",
            ),
        )
        db.commit()

        stats = cleanup_stale_vector_points(
            db,
            family_id="family-1",
            scopes=["ingredient"],
            vector_store=vector_store,
        )

    assert stats == {"scanned": 3, "deleted": 2, "failed": 0}
    assert vector_store.deleted == ["ingredient:missing", "ingredient:stale"]


def test_delete_search_document_can_delete_matching_vector_point() -> None:
    SessionLocal = session_factory()
    vector_store = FakeVectorStore()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-1",
                title_text="番茄炒蛋",
                keyword_text="番茄 鸡蛋",
                detail_text="",
                semantic_text="菜谱：番茄炒蛋",
                metadata_json={},
                content_hash="hash-recipe",
            ),
        )
        db.commit()

        delete_search_document(
            db,
            family_id="family-1",
            entity_type="recipe",
            entity_id="recipe-1",
            delete_vector=True,
            vector_store=vector_store,
        )
        db.commit()

    assert vector_store.deleted == ["recipe:recipe-1"]


def test_delete_search_document_ignores_vector_store_failures() -> None:
    SessionLocal = session_factory()
    with SessionLocal() as db:
        db.add(Family(id="family-1", name="一号家庭"))
        upsert_search_document(
            db,
            SearchDocumentPayload(
                family_id="family-1",
                entity_type="recipe",
                entity_id="recipe-1",
                title_text="番茄炒蛋",
                keyword_text="番茄 鸡蛋",
                detail_text="",
                semantic_text="菜谱：番茄炒蛋",
                metadata_json={},
                content_hash="hash-recipe",
            ),
        )
        db.commit()

        delete_search_document(
            db,
            family_id="family-1",
            entity_type="recipe",
            entity_id="recipe-1",
            delete_vector=True,
            vector_store=FailingDeleteVectorStore(),
        )
        db.commit()
