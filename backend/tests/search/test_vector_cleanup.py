from __future__ import annotations

from app.core.enums import FamilyModelSearchProfileStatus
from app.models.domain import Family, SearchDocument
from app.models.family_model_settings import FamilySearchProfile, FamilySearchProfileDocument
from app.services.search.indexing import delete_search_document
from app.services.search.vector_cleanup import cleanup_stale_vector_points
from app.services.search.vector_store import VectorPoint, VectorPointPage, VectorStoreUnavailableError
from tests.search._support import session_factory


class FakeVectorStore:
    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.calls: list[dict[str, object]] = []
        self.pages = [
            VectorPointPage(
                points=[
                    VectorPoint(
                        point_id="ingredient:kept",
                        payload={
                            "family_id": "family-1",
                            "search_profile_id": "profile-1",
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
                            "search_profile_id": "profile-1",
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
                            "search_profile_id": "profile-1",
                            "entity_type": "ingredient",
                            "entity_id": "stale",
                            "content_hash": "old-hash",
                            "document_builder_version": "v1",
                        },
                    ),
                ]
            )
        ]

    def delete_point(self, *, point_id: str) -> None:
        self.deleted.append(point_id)

    def scroll_points(self, **kwargs) -> VectorPointPage:
        self.calls.append(kwargs)
        return self.pages.pop(0) if self.pages else VectorPointPage(points=[])


class FailingDeleteVectorStore(FakeVectorStore):
    def delete_point(self, *, point_id: str) -> None:
        del point_id
        raise VectorStoreUnavailableError("qdrant unavailable")


def _profile() -> FamilySearchProfile:
    return FamilySearchProfile(
        id="profile-1",
        family_id="family-1",
        provider_profile_id="provider-1",
        provider_profile_version_id="provider-version-1",
        adapter_kind="openai_compatible_http",
        embedding_model="embedding-1",
        dimensions=2,
        distance="Cosine",
        document_builder_version="v1",
        index_identity_checksum="identity-1",
        qdrant_collection="culina_fsp_1",
        status=FamilyModelSearchProfileStatus.ACTIVE,
    )


def _document(*, document_id: str, entity_id: str, content_hash: str) -> SearchDocument:
    return SearchDocument(
        id=document_id,
        family_id="family-1",
        entity_type="ingredient",
        entity_id=entity_id,
        title_text=entity_id,
        keyword_text=entity_id,
        detail_text="",
        semantic_text=entity_id,
        metadata_json={},
        content_hash=content_hash,
        document_builder_version="v1",
    )


def _seed_profile_documents(db) -> None:
    kept = _document(document_id="document-kept", entity_id="kept", content_hash="hash-kept")
    stale = _document(document_id="document-stale", entity_id="stale", content_hash="hash-current")
    db.add_all(
        (
            Family(id="family-1", name="一号家庭"),
            _profile(),
            kept,
            stale,
            FamilySearchProfileDocument(
                family_id="family-1",
                search_profile_id="profile-1",
                search_document_id=kept.id,
                content_hash=kept.content_hash,
                status="indexed",
            ),
            FamilySearchProfileDocument(
                family_id="family-1",
                search_profile_id="profile-1",
                search_document_id=stale.id,
                content_hash=stale.content_hash,
                status="indexed",
            ),
        )
    )
    db.commit()


def test_cleanup_stale_vector_points_uses_exact_profile_collection_state() -> None:
    SessionLocal = session_factory()
    vector_store = FakeVectorStore()
    with SessionLocal() as db:
        _seed_profile_documents(db)
        stats = cleanup_stale_vector_points(
            db,
            family_id="family-1",
            search_profile_id="profile-1",
            scopes=["ingredient"],
            vector_store=vector_store,  # type: ignore[arg-type]
        )

    assert stats == {"scanned": 3, "deleted": 2, "failed": 0}
    assert vector_store.deleted == ["ingredient:missing", "ingredient:stale"]
    assert vector_store.calls == [
        {
            "family_id": "family-1",
            "search_profile_id": "profile-1",
            "scopes": ["ingredient"],
            "limit": 100,
            "offset": None,
        }
    ]


def test_cleanup_retains_pending_handoff_point_for_qdrant_retry() -> None:
    SessionLocal = session_factory()
    vector_store = FakeVectorStore()
    vector_store.pages = [
        VectorPointPage(
            points=[
                VectorPoint(
                    point_id="ingredient:kept",
                    payload={
                        "family_id": "family-1",
                        "search_profile_id": "profile-1",
                        "entity_type": "ingredient",
                        "entity_id": "kept",
                        "content_hash": "hash-kept",
                        "document_builder_version": "v1",
                    },
                )
            ]
        )
    ]
    with SessionLocal() as db:
        _seed_profile_documents(db)
        # Locate via the composite query instead of relying on generated IDs.
        profile_document = next(
            item
            for item in db.query(FamilySearchProfileDocument).all()
            if item.search_document_id == "document-kept"
        )
        profile_document.status = "pending_handoff"
        profile_document.vector_json = [0.1, 0.2]
        profile_document.vector_dimensions = 2
        db.commit()
        stats = cleanup_stale_vector_points(
            db,
            family_id="family-1",
            search_profile_id="profile-1",
            vector_store=vector_store,  # type: ignore[arg-type]
        )

    assert stats == {"scanned": 1, "deleted": 0, "failed": 0}
    assert vector_store.deleted == []


def test_delete_search_document_defers_vector_deletion_to_profile_cleanup() -> None:
    SessionLocal = session_factory()
    vector_store = FakeVectorStore()
    with SessionLocal() as db:
        _seed_profile_documents(db)
        delete_search_document(
            db,
            family_id="family-1",
            entity_type="ingredient",
            entity_id="kept",
            delete_vector=True,
            vector_store=vector_store,  # type: ignore[arg-type]
        )
        db.commit()

    assert vector_store.deleted == []


def test_cleanup_records_point_delete_failure_without_losing_other_work() -> None:
    SessionLocal = session_factory()
    vector_store = FailingDeleteVectorStore()
    with SessionLocal() as db:
        _seed_profile_documents(db)
        stats = cleanup_stale_vector_points(
            db,
            family_id="family-1",
            search_profile_id="profile-1",
            vector_store=vector_store,  # type: ignore[arg-type]
        )

    assert stats == {"scanned": 3, "deleted": 0, "failed": 2}
