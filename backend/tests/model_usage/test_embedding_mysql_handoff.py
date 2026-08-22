from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Lock

from sqlalchemy import select

from app.core.enums import FamilyModelPricePurpose, FamilyModelSearchProfileStatus
from app.models.domain import SearchDocument, SearchIndexJob
from app.models.family_model_settings import (
    FamilyModelConfigRevision,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSettings,
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.services.search.embeddings import MeteredEmbeddingResult
from app.services.search.jobs import process_search_index_job
from app.services.search.vector_store import VectorStoreUnavailableError
from tests.model_usage.test_reservation_mysql_concurrency import MysqlReservationContext


pytest_plugins = ("tests.model_usage.test_reservation_mysql_concurrency",)


class RecordingEmbeddingClient:
    model = "mysql-test-embedding"
    dimensions = 2

    def __init__(self) -> None:
        self._lock = Lock()
        self.call_count = 0

    def embed_text(self, text: str, *, attribution, attempt_key: str, usage_snapshot) -> MeteredEmbeddingResult:
        del text, attribution, attempt_key
        assert usage_snapshot.config_revision_id == "revision-mysql-search"
        assert usage_snapshot.price_version_id == "price-mysql-search"
        assert usage_snapshot.candidate is False
        with self._lock:
            self.call_count += 1
            event_id = f"embedding-event-{self.call_count}"
        return MeteredEmbeddingResult(vectors=[[0.1, 0.2]], usage_event_id=event_id)


class FailOnceVectorStore:
    def __init__(self, *, fail_times: int = 0) -> None:
        self._lock = Lock()
        self.fail_times = fail_times
        self.call_count = 0

    def ensure_collection(self, *, vector_size: int) -> None:
        assert vector_size == 2

    def upsert_point(self, *, point_id: str, vector: list[float], payload: dict[str, object]) -> None:
        assert point_id.startswith("ingredient:")
        assert vector == [0.1, 0.2]
        assert payload["search_profile_id"] == "search-profile-mysql"
        with self._lock:
            self.call_count += 1
            if self.fail_times:
                self.fail_times -= 1
                raise VectorStoreUnavailableError("qdrant unavailable")


def _seed_profile_search_job(context: MysqlReservationContext, *, suffix: str) -> str:
    """Seed the immutable family identities required by a profile index job.

    The MySQL test intentionally constructs a normal active snapshot rather
    than patching legacy ``Settings`` values. This exercises the FK and row
    lock shape used in production while keeping the provider itself fake.
    """

    family_id = "family-mysql-reserve"
    profile_id = "search-profile-mysql"
    provider_profile_id = "provider-profile-mysql"
    provider_version_id = "provider-version-mysql"
    revision_id = "revision-mysql-search"
    price_version_id = "price-mysql-search"
    document_id = f"document-embedding-{suffix}"
    entity_id = f"ingredient-embedding-{suffix}"
    job_id = f"search-job-embedding-{suffix}"
    now = datetime(2026, 8, 19, tzinfo=timezone.utc)

    with context.SessionLocal() as db:
        provider = FamilyModelProviderProfile(
            id=provider_profile_id,
            family_id=family_id,
            display_name="MySQL embedding provider",
            credential_scope_checksum="a" * 64,
            created_by="owner-mysql-reserve",
            updated_by="owner-mysql-reserve",
        )
        db.add(provider)
        db.flush()
        provider_version = FamilyModelProviderProfileVersion(
            id=provider_version_id,
            family_id=family_id,
            profile_id=provider.id,
            version_number=1,
            adapter_kind="openai_compatible_http",
            auth_mode="no_auth",
            api_base_url="https://provider.example.test/v1",
            options_json={},
            credential_scope_checksum=provider.credential_scope_checksum,
            endpoint_fingerprint="b" * 64,
            created_by="owner-mysql-reserve",
        )
        revision = FamilyModelConfigRevision(
            id=revision_id,
            family_id=family_id,
            version_number=1,
            config_checksum="c" * 64,
            change_note="mysql profile handoff",
            published_by="owner-mysql-reserve",
        )
        db.add_all((provider_version, revision))
        db.flush()
        provider.current_profile_version_id = provider_version.id
        price = ModelUsagePriceVersion(
            id=price_version_id,
            family_id=family_id,
            config_revision_id=revision.id,
            purpose=FamilyModelPricePurpose.ACTIVE,
            version_number=2,
            status="published",
            effective_from=now,
            reviewed_at=now,
            source_ref="test",
            change_note="mysql profile handoff",
            operator="test",
            change_ticket="test",
            manifest_checksum="d" * 64,
            model_aliases_json={},
            fx_rates_json={"CNY": "1"},
        )
        db.add(price)
        db.flush()
        profile = FamilySearchProfile(
            id=profile_id,
            family_id=family_id,
            provider_profile_id=provider.id,
            provider_profile_version_id=provider_version.id,
            adapter_kind="openai_compatible_http",
            embedding_model="mysql-test-embedding",
            dimensions=2,
            distance="Cosine",
            document_builder_version="v1",
            index_identity_checksum="e" * 64,
            qdrant_collection="culina_fsp_mysql_profile",
            status=FamilyModelSearchProfileStatus.ACTIVE,
            created_by="owner-mysql-reserve",
        )
        document = SearchDocument(
            id=document_id,
            family_id=family_id,
            entity_type="ingredient",
            entity_id=entity_id,
            title_text="番茄",
            keyword_text="番茄",
            detail_text="",
            semantic_text="食材：番茄",
            metadata_json={},
            content_hash="f" * 64,
            document_builder_version="v1",
        )
        db.add_all((profile, document))
        db.flush()
        db.add_all(
            (
                FamilyModelSettings(
                    family_id=family_id,
                    active_config_revision_id=revision.id,
                    active_price_version_id=price.id,
                    active_search_profile_id=profile.id,
                    created_by="owner-mysql-reserve",
                    updated_by="owner-mysql-reserve",
                ),
                FamilySearchProfileDocument(
                    id=f"profile-document-embedding-{suffix}",
                    family_id=family_id,
                    search_profile_id=profile.id,
                    search_document_id=document.id,
                    content_hash=document.content_hash,
                    status="pending",
                ),
                SearchIndexJob(
                    id=job_id,
                    family_id=family_id,
                    search_profile_id=profile.id,
                    config_revision_id=revision.id,
                    price_version_id=price.id,
                    user_id="owner-mysql-reserve",
                    status="queued",
                    entity_type=document.entity_type,
                    entity_id=document.entity_id,
                    target_name=document.title_text,
                    vector_status="pending",
                ),
            )
        )
        db.commit()
    return job_id


def _profile_document(db, *, suffix: str) -> FamilySearchProfileDocument | None:
    return db.scalar(
        select(FamilySearchProfileDocument).where(
            FamilySearchProfileDocument.id == f"profile-document-embedding-{suffix}"
        )
    )


def test_mysql_qdrant_retry_reuses_profile_handoff_without_another_embedding_send(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    suffix = "qdrant-retry"
    job_id = _seed_profile_search_job(mysql_reservation_context, suffix=suffix)
    embedding = RecordingEmbeddingClient()
    vector_store = FailOnceVectorStore(fail_times=1)

    process_search_index_job(
        job_id,
        session_factory=mysql_reservation_context.SessionLocal,
        embedding_client=embedding,
        vector_store=vector_store,
    )

    with mysql_reservation_context.SessionLocal() as db:
        job = db.get(SearchIndexJob, job_id)
        document = db.get(SearchDocument, f"document-embedding-{suffix}")
        profile_document = _profile_document(db, suffix=suffix)
        assert job is not None and document is not None and profile_document is not None
        assert job.status == "failed"
        assert job.vector_status == "pending"
        assert job.usage_event_id == "embedding-event-1"
        assert profile_document.status == "pending_handoff"
        assert profile_document.vector_json == [0.1, 0.2]
        assert profile_document.vector_dimensions == 2
        assert document.pending_vector is None

    process_search_index_job(
        job_id,
        session_factory=mysql_reservation_context.SessionLocal,
        embedding_client=embedding,
        vector_store=vector_store,
    )

    assert embedding.call_count == 1
    assert vector_store.call_count == 2
    with mysql_reservation_context.SessionLocal() as db:
        job = db.get(SearchIndexJob, job_id)
        profile_document = _profile_document(db, suffix=suffix)
        assert job is not None and profile_document is not None
        assert job.status == "succeeded"
        assert job.vector_status == "indexed"
        assert profile_document.status == "indexed"
        assert profile_document.vector_json is None


def test_mysql_concurrent_workers_submit_one_profile_embedding_attempt_for_one_job(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    suffix = "concurrent"
    job_id = _seed_profile_search_job(mysql_reservation_context, suffix=suffix)
    embedding = RecordingEmbeddingClient()
    vector_store = FailOnceVectorStore()

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = [
            pool.submit(
                process_search_index_job,
                job_id,
                session_factory=mysql_reservation_context.SessionLocal,
                embedding_client=embedding,
                vector_store=vector_store,
            )
            for _ in range(16)
        ]
        for future in futures:
            future.result(timeout=30)

    assert embedding.call_count == 1
    with mysql_reservation_context.SessionLocal() as db:
        job = db.get(SearchIndexJob, job_id)
        profile_document = _profile_document(db, suffix=suffix)
        assert job is not None and profile_document is not None
        assert job.status == "succeeded"
        assert job.attempt_count == 1
        assert profile_document.status == "indexed"
