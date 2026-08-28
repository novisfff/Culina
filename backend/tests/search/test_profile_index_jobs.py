from __future__ import annotations

from unittest.mock import patch

from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import FamilyModelSearchProfileStatus
from app.models.domain import Family, SearchDocument, SearchIndexJob
from app.models.family_model_settings import (
    FamilyModelSettings,
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
from app.repos.family_model_settings.search_profiles import get_profile_document
from app.services.family_model_settings.errors import FamilyModelSettingsError
from app.services.search.embeddings import MeteredEmbeddingResult
from app.services.search.jobs import (
    MAX_ATTEMPTS,
    _activate_profile_if_ready,
    _mark_profile_job_terminal_missing_output,
    _mark_unexpected_search_index_job_failure,
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


def _seed_candidate_failure_state(
    db: Session,
    *,
    profile_status: FamilyModelSearchProfileStatus = FamilyModelSearchProfileStatus.PROVISIONING,
    document_status: str = "indexing",
    job_status: str = "running",
    attempt_count: int = MAX_ATTEMPTS - 1,
) -> tuple[FamilySearchProfile, FamilySearchProfileDocument, SearchIndexJob, SearchIndexJob]:
    _active, candidate, document = _seed_profiles(db)
    profile_document = FamilySearchProfileDocument(
        id="candidate-profile-document",
        family_id=candidate.family_id,
        search_profile_id=candidate.id,
        search_document_id=document.id,
        content_hash=document.content_hash,
        status=document_status,
    )
    current_job = SearchIndexJob(
        id="candidate-running-job",
        family_id=candidate.family_id,
        search_profile_id=candidate.id,
        price_version_id=candidate.candidate_price_version_id,
        user_id="owner-a",
        status=job_status,
        entity_type=document.entity_type,
        entity_id=document.entity_id,
        target_name=document.title_text,
        vector_status="pending",
        attempt_count=attempt_count,
    )
    queued_job = SearchIndexJob(
        id="candidate-queued-job",
        family_id=candidate.family_id,
        search_profile_id=candidate.id,
        price_version_id=candidate.candidate_price_version_id,
        user_id="owner-a",
        status="queued",
        entity_type="recipe",
        entity_id="recipe-queued",
        target_name="待处理文档",
        vector_status="pending",
    )
    candidate.status = profile_status
    db.add_all((profile_document, current_job, queued_job))
    db.flush()
    return candidate, profile_document, current_job, queued_job


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


def test_missing_candidate_price_fails_only_candidate_and_pauses_queued_work(
    model_usage_db: Session,
) -> None:
    active, candidate, document = _seed_profiles(model_usage_db)
    candidate.candidate_price_version_id = None
    queued_job = SearchIndexJob(
        id="candidate-missing-price-job",
        family_id=candidate.family_id,
        search_profile_id=candidate.id,
        user_id="owner-a",
        status="queued",
        entity_type="recipe",
        entity_id="recipe-missing-price",
        vector_status="pending",
    )
    model_usage_db.add(queued_job)
    model_usage_db.flush()

    with patch(
        "app.services.family_model_settings.drafts."
        "restore_active_embedding_after_failed_search_replacement",
        return_value=True,
    ) as restore:
        jobs = enqueue_document_for_family_profiles(
            model_usage_db,
            document,
            user_id="owner-a",
        )

    assert {job.search_profile_id for job in jobs} == {active.id}
    assert candidate.status is FamilyModelSearchProfileStatus.FAILED
    assert queued_job.status == "cancelled"
    restore.assert_called_once()


def test_unexpected_terminal_candidate_failure_restores_active_embedding(
    model_usage_db: Session,
) -> None:
    candidate, _profile_document, current_job, queued_job = _seed_candidate_failure_state(
        model_usage_db
    )
    model_usage_db.commit()
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)

    with patch(
        "app.services.family_model_settings.drafts."
        "restore_active_embedding_after_failed_search_replacement",
        return_value=True,
    ) as restore:
        _mark_unexpected_search_index_job_failure(
            current_job.id,
            session_factory=factory,
        )

    model_usage_db.expire_all()
    assert model_usage_db.get(FamilySearchProfile, candidate.id).status is FamilyModelSearchProfileStatus.FAILED
    assert model_usage_db.get(SearchIndexJob, current_job.id).attempt_count == MAX_ATTEMPTS
    assert model_usage_db.get(SearchIndexJob, queued_job.id).status == "cancelled"
    restore.assert_called_once()


def test_terminal_missing_output_fails_candidate_and_restores_active_embedding(
    model_usage_db: Session,
) -> None:
    candidate, profile_document, current_job, queued_job = _seed_candidate_failure_state(
        model_usage_db,
        attempt_count=1,
    )
    model_usage_db.commit()
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)

    with patch(
        "app.services.family_model_settings.drafts."
        "restore_active_embedding_after_failed_search_replacement",
        return_value=True,
    ) as restore:
        _mark_profile_job_terminal_missing_output(
            current_job.id,
            session_factory=factory,
        )

    model_usage_db.expire_all()
    assert model_usage_db.get(FamilySearchProfile, candidate.id).status is FamilyModelSearchProfileStatus.FAILED
    assert model_usage_db.get(FamilySearchProfileDocument, profile_document.id).status == "failed"
    assert model_usage_db.get(SearchIndexJob, current_job.id).status == "failed"
    assert model_usage_db.get(SearchIndexJob, queued_job.id).status == "cancelled"
    restore.assert_called_once()


def test_activation_failure_fails_candidate_and_restores_active_embedding(
    model_usage_db: Session,
) -> None:
    candidate, profile_document, _current_job, queued_job = _seed_candidate_failure_state(
        model_usage_db,
        document_status="indexed",
        job_status="succeeded",
        attempt_count=1,
    )
    candidate.total_documents = 1
    candidate.indexed_documents = 1
    model_usage_db.commit()
    factory = sessionmaker(bind=model_usage_db.get_bind(), expire_on_commit=False)

    with (
        patch(
            "app.services.family_model_settings.search_profiles.activate_ready_search_profile",
            side_effect=FamilyModelSettingsError("family_search_profile_locked"),
        ),
        patch(
            "app.services.family_model_settings.drafts."
            "restore_active_embedding_after_failed_search_replacement",
            return_value=True,
        ) as restore,
    ):
        _activate_profile_if_ready(
            family_id=candidate.family_id,
            profile_id=candidate.id,
            session_factory=factory,
        )

    model_usage_db.expire_all()
    assert model_usage_db.get(FamilySearchProfile, candidate.id).status is FamilyModelSearchProfileStatus.FAILED
    assert model_usage_db.get(FamilySearchProfileDocument, profile_document.id).status == "indexed"
    assert model_usage_db.get(SearchIndexJob, queued_job.id).status == "cancelled"
    restore.assert_called_once()
