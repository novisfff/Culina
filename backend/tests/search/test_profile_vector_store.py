from __future__ import annotations

import inspect
from types import SimpleNamespace

import pytest

from app.core.enums import FamilyModelSearchProfileStatus
from app.models.family_model_settings import FamilySearchProfile, FamilySearchProfileDocument
from app.services.search.vector_indexing import (
    SearchProfileDocumentSnapshot,
    prepare_profile_vector_handoff,
    write_profile_vector_handoff,
)
from app.services.search.vector_store import (
    QdrantVectorStore,
    VectorStoreUnavailableError,
    build_vector_store,
)


class RecordingVectorStore:
    def __init__(self, collection: str) -> None:
        self.collection = collection
        self.vector_size: int | None = None
        self.last_payload: dict[str, object] | None = None

    def ensure_collection(self, *, vector_size: int) -> None:
        self.vector_size = vector_size

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        del point_id, vector
        self.last_payload = payload


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        search_vector_backend="qdrant",
        qdrant_url="http://qdrant:6333",
        qdrant_api_key="",
        qdrant_timeout_seconds=10,
    )


def test_qdrant_store_uses_explicit_profile_collection() -> None:
    small = build_vector_store(_settings(), qdrant_collection="culina_fsp_small")
    large = build_vector_store(_settings(), qdrant_collection="culina_fsp_large")

    assert isinstance(small, QdrantVectorStore)
    assert isinstance(large, QdrantVectorStore)
    assert small.collection == "culina_fsp_small"
    assert large.collection == "culina_fsp_large"
    assert "qdrant_collection" in inspect.signature(build_vector_store).parameters


def test_vector_store_builder_rejects_missing_profile_collection() -> None:
    with pytest.raises(VectorStoreUnavailableError, match="collection required"):
        build_vector_store(_settings(), qdrant_collection="")


def test_pending_handoff_targets_exact_profile() -> None:
    profile = FamilySearchProfile(
        id="profile-a",
        family_id="family-a",
        provider_profile_id="provider-a",
        provider_profile_version_id="provider-version-a",
        adapter_kind="openai_compatible_http",
        embedding_model="embedding-a",
        dimensions=3,
        distance="Cosine",
        document_builder_version="v1",
        index_identity_checksum="a" * 64,
        qdrant_collection="culina_fsp_profile_a",
        status=FamilyModelSearchProfileStatus.ACTIVE,
    )
    profile_document = FamilySearchProfileDocument(
        id="profile-document-a",
        family_id="family-a",
        search_profile_id=profile.id,
        search_document_id="document-a",
        content_hash="b" * 64,
        status="pending_handoff",
        vector_json=[0.1, 0.2, 0.3],
        vector_dimensions=3,
    )
    snapshot = SearchProfileDocumentSnapshot(
        profile_document_id=profile_document.id,
        family_id="family-a",
        search_profile_id=profile.id,
        search_document_id="document-a",
        entity_type="ingredient",
        entity_id="ingredient-a",
        semantic_text="食材：番茄",
        content_hash=profile_document.content_hash,
        generation=profile_document.generation,
        document_builder_version="v1",
        embedding_model="embedding-a",
        embedding_dimensions=3,
        user_id=None,
    )
    handoff = prepare_profile_vector_handoff(
        profile_document,
        snapshot=snapshot,
        search_profile=profile,
    )
    assert handoff is not None
    store = RecordingVectorStore(profile.qdrant_collection)

    write_profile_vector_handoff(handoff, vector_store=store)  # type: ignore[arg-type]

    assert store.last_payload is not None
    assert store.vector_size == 3
    assert store.last_payload["family_id"] == profile.family_id
    assert store.last_payload["search_profile_id"] == profile.id
    assert store.collection == profile.qdrant_collection
