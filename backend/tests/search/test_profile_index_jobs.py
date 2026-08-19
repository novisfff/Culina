from __future__ import annotations

from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import FamilyModelSearchProfileStatus
from app.models.domain import Family, SearchDocument
from app.models.family_model_settings import FamilyModelSettings, FamilySearchProfile
from app.repos.family_model_settings.search_profiles import get_profile_document
from app.services.search.embeddings import MeteredEmbeddingResult
from app.services.search.jobs import (
    enqueue_document_for_family_profiles,
    process_search_index_job,
)


class _EmbeddingClient:
    model = "embedding-profile"
    dimensions = 2

    def __init__(self) -> None:
        self.calls = 0

    def embed_text(self, text, *, attribution, attempt_key, usage_snapshot=None):
        del text, attribution, attempt_key
        assert usage_snapshot is not None
        self.calls += 1
        return MeteredEmbeddingResult(vectors=[[0.1, 0.2]], usage_event_id="embedding-event")


class _VectorStore:
    def __init__(self) -> None:
        self.payloads: list[dict[str, object]] = []

    def ensure_collection(self, *, vector_size: int) -> None:
        assert vector_size == 2

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        assert point_id == "ingredient:ingredient-a"
        assert vector == [0.1, 0.2]
        self.payloads.append(payload)


def _profile(
    *,
    profile_id: str,
    family_id: str,
    status: FamilyModelSearchProfileStatus,
    base_search_profile_id: str | None = None,
    candidate_price_version_id: str | None = None,
) -> FamilySearchProfile:
    return FamilySearchProfile(
        id=profile_id,
        family_id=family_id,
        base_search_profile_id=base_search_profile_id,
        provider_profile_id=f"provider-{profile_id}",
        provider_profile_version_id=f"provider-version-{profile_id}",
        adapter_kind="openai_compatible_http",
        embedding_model=f"embedding-{profile_id}",
        dimensions=2,
        distance="Cosine",
        document_builder_version="v1",
        index_identity_checksum=f"identity-{profile_id}",
        qdrant_collection=f"culina_fsp_{profile_id}",
        candidate_price_version_id=candidate_price_version_id,
        status=status,
    )


def _document(*, content_hash: str = "a" * 64) -> SearchDocument:
    return SearchDocument(
        id="document-a",
        family_id="family-a",
        entity_type="ingredient",
        entity_id="ingredient-a",
        title_text="番茄",
        keyword_text="番茄",
        detail_text="",
        semantic_text="食材：番茄",
        metadata_json={},
        content_hash=content_hash,
        document_builder_version="v1",
    )


def _seed_profiles(db: Session) -> tuple[FamilySearchProfile, FamilySearchProfile, SearchDocument]:
    active = _profile(
        profile_id="profile-active",
        family_id="family-a",
        status=FamilyModelSearchProfileStatus.ACTIVE,
    )
    candidate = _profile(
        profile_id="profile-candidate",
        family_id="family-a",
        status=FamilyModelSearchProfileStatus.PROVISIONING,
        base_search_profile_id=active.id,
        candidate_price_version_id="candidate-price",
    )
    document = _document()
    db.add_all(
        (
            Family(id="family-a", name="A", motto="", location=""),
            FamilyModelSettings(
                family_id="family-a",
                active_config_revision_id="active-revision",
                active_price_version_id="active-price",
                active_search_profile_id=active.id,
            ),
            active,
            candidate,
            document,
        )
    )
    db.flush()
    return active, candidate, document


def test_same_document_can_have_active_and_candidate_jobs(model_usage_db: Session) -> None:
    active, candidate, document = _seed_profiles(model_usage_db)

    jobs = enqueue_document_for_family_profiles(model_usage_db, document, user_id="owner-a")

    assert {(job.search_profile_id, job.entity_id) for job in jobs} == {
        (active.id, document.entity_id),
        (candidate.id, document.entity_id),
    }
    active_job = next(job for job in jobs if job.search_profile_id == active.id)
    candidate_job = next(job for job in jobs if job.search_profile_id == candidate.id)
    assert (active_job.config_revision_id, active_job.price_version_id) == (
        "active-revision",
        "active-price",
    )
    assert (candidate_job.config_revision_id, candidate_job.price_version_id) == (
        None,
        "candidate-price",
    )


def test_active_job_created_after_reprice_uses_new_settings_price(model_usage_db: Session) -> None:
    active, _candidate, document = _seed_profiles(model_usage_db)
    before = next(
        job
        for job in enqueue_document_for_family_profiles(model_usage_db, document, user_id="owner-a")
        if job.search_profile_id == active.id
    )
    before.status = "succeeded"
    document.content_hash = "b" * 64
    settings = model_usage_db.get(FamilyModelSettings, "family-a")
    assert settings is not None
    settings.active_price_version_id = "active-price-new"

    after = next(
        job
        for job in enqueue_document_for_family_profiles(model_usage_db, document, user_id="owner-a")
        if job.search_profile_id == active.id
    )

    assert before.price_version_id == "active-price"
    assert after.config_revision_id == "active-revision"
    assert after.price_version_id == "active-price-new"
    assert after.id != before.id


def test_profile_job_writes_only_profile_vector_lifecycle(model_usage_db: Session) -> None:
    active, _candidate, document = _seed_profiles(model_usage_db)
    job = next(
        item
        for item in enqueue_document_for_family_profiles(model_usage_db, document, user_id="owner-a")
        if item.search_profile_id == active.id
    )
    model_usage_db.commit()
    embedding = _EmbeddingClient()
    vector_store = _VectorStore()
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)

    process_search_index_job(
        job.id,
        session_factory=factory,
        embedding_client=embedding,  # type: ignore[arg-type]
        vector_store=vector_store,  # type: ignore[arg-type]
    )

    model_usage_db.expire_all()
    persisted_job = model_usage_db.get(type(job), job.id)
    profile_document = get_profile_document(
        model_usage_db,
        family_id="family-a",
        search_profile_id=active.id,
        search_document_id=document.id,
    )
    assert persisted_job is not None and persisted_job.status == "succeeded"
    assert profile_document is not None and profile_document.status == "indexed"
    assert profile_document.vector_json is None
    assert document.pending_vector is None
    assert document.vector_status == "pending"
    assert embedding.calls == 1
    assert vector_store.payloads == [
        {
            "family_id": "family-a",
            "search_profile_id": active.id,
            "entity_type": "ingredient",
            "entity_id": "ingredient-a",
            "user_id": "",
            "content_hash": document.content_hash,
            "document_builder_version": "v1",
            "embedding_model": active.embedding_model,
            "embedding_dimensions": 2,
        }
    ]
