from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import select

from app.core.enums import IngredientExpiryMode
from app.models.domain import Ingredient, SearchDocument, SearchIndexJob
from app.services.search.embeddings import MeteredEmbeddingResult
from app.services.search.jobs import enqueue_search_index_job, process_search_index_job
from app.services.search.vector_store import VectorStoreUnavailableError
from tests.model_usage.test_reservation_mysql_concurrency import MysqlReservationContext


pytest_plugins = ("tests.model_usage.test_reservation_mysql_concurrency",)


EMBEDDING_SETTINGS = SimpleNamespace(
    search_embedding_provider="openai",
    search_embedding_model="mysql-test-embedding",
    search_embedding_dimensions=2,
)


class RecordingEmbeddingClient:
    model = "mysql-test-embedding"
    dimensions = 2

    def __init__(self) -> None:
        self._lock = Lock()
        self.call_count = 0

    def embed_text(self, text: str, *, attribution, attempt_key: str) -> MeteredEmbeddingResult:
        del text, attribution, attempt_key
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
        del point_id, vector, payload
        with self._lock:
            self.call_count += 1
            if self.fail_times:
                self.fail_times -= 1
                raise VectorStoreUnavailableError("qdrant unavailable")


def _seed_search_job(context: MysqlReservationContext, *, suffix: str) -> str:
    ingredient_id = f"ingredient-embedding-{suffix}"
    with context.SessionLocal() as db:
        db.add(
            Ingredient(
                id=ingredient_id,
                family_id="family-mysql-reserve",
                name=f"番茄 {suffix}",
                category="蔬菜",
                default_unit="个",
                unit_conversions=[],
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
                created_by="owner-mysql-reserve",
                updated_by="owner-mysql-reserve",
            )
        )
        job = enqueue_search_index_job(
            db,
            family_id="family-mysql-reserve",
            user_id="owner-mysql-reserve",
            entity_type="ingredient",
            entity_id=ingredient_id,
            target_name="番茄",
        )
        db.commit()
        return job.id


def test_mysql_qdrant_retry_reuses_durable_vector_without_another_embedding_send(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    job_id = _seed_search_job(mysql_reservation_context, suffix="qdrant-retry")
    embedding = RecordingEmbeddingClient()
    vector_store = FailOnceVectorStore(fail_times=1)

    with (
        patch("app.services.search.jobs.get_settings", return_value=EMBEDDING_SETTINGS),
        patch("app.services.search.indexing.get_settings", return_value=EMBEDDING_SETTINGS),
    ):
        process_search_index_job(
            job_id,
            session_factory=mysql_reservation_context.SessionLocal,
            embedding_client=embedding,
            vector_store=vector_store,
        )

    with mysql_reservation_context.SessionLocal() as db:
        job = db.get(SearchIndexJob, job_id)
        document = db.scalar(select(SearchDocument).where(SearchDocument.entity_id == "ingredient-embedding-qdrant-retry"))
        assert job is not None and document is not None
        assert job.status == "failed"
        assert job.vector_status == "pending"
        assert document.pending_vector == [0.1, 0.2]
        assert job.usage_event_id == "embedding-event-1"

    with (
        patch("app.services.search.jobs.get_settings", return_value=EMBEDDING_SETTINGS),
        patch("app.services.search.indexing.get_settings", return_value=EMBEDDING_SETTINGS),
    ):
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
        document = db.scalar(select(SearchDocument).where(SearchDocument.entity_id == "ingredient-embedding-qdrant-retry"))
        assert job is not None and document is not None
        assert job.status == "succeeded"
        assert document.pending_vector is None


def test_mysql_concurrent_workers_submit_one_embedding_attempt_for_one_job(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    job_id = _seed_search_job(mysql_reservation_context, suffix="concurrent")
    embedding = RecordingEmbeddingClient()
    vector_store = FailOnceVectorStore()

    with (
        patch("app.services.search.jobs.get_settings", return_value=EMBEDDING_SETTINGS),
        patch("app.services.search.indexing.get_settings", return_value=EMBEDDING_SETTINGS),
    ):
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
        assert job is not None
        assert job.status == "succeeded"
        assert job.attempt_count == 1
