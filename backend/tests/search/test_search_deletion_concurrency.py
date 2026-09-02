from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from threading import Barrier, Lock, Thread
from typing import Callable, Iterator
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import FamilyModelSearchProfileStatus, FoodType, MealType
from app.models.domain import (
    Base,
    Family,
    Food,
    FoodPlanItem,
    SearchDocument,
    SearchIndexJob,
)
from app.models.family_model_settings import (
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
from app.services.search.jobs import (
    enqueue_search_document_deletion_job,
    process_search_index_job,
    retry_failed_search_index_job,
)
from app.services.search.vector_store import VectorStoreUnavailableError


POINT_ID = "meal_plan:plan-concurrency"


class ControlledVectorStore:
    def __init__(self) -> None:
        self.points: dict[str, tuple[list[float], dict[str, object]]] = {}
        self.lock = Lock()
        self.upsert_entered: Barrier | None = None
        self.release_upsert: Barrier | None = None
        self.upsert_written: Barrier | None = None
        self.release_upsert_return: Barrier | None = None
        self.fail_upsert_after_write_count = 0
        self.delete_written: Barrier | None = None
        self.release_delete_return: Barrier | None = None
        self.block_delete_call: int | None = None
        self.fail_delete_count = 0
        self.fail_delete_calls: set[int] = set()
        self.fail_delete_after_write_calls: set[int] = set()
        self.delete_calls = 0

    def ensure_collection(self, *, vector_size: int) -> None:
        assert vector_size == 2

    def upsert_point(
        self,
        *,
        point_id: str,
        vector: list[float],
        payload: dict[str, object],
    ) -> None:
        if self.upsert_entered is not None:
            self.upsert_entered.wait()
        if self.release_upsert is not None:
            self.release_upsert.wait()
        with self.lock:
            self.points[point_id] = (list(vector), dict(payload))
            fail_after_write = self.fail_upsert_after_write_count > 0
            if fail_after_write:
                self.fail_upsert_after_write_count -= 1
        if self.upsert_written is not None:
            self.upsert_written.wait()
        if self.release_upsert_return is not None:
            self.release_upsert_return.wait()
        if fail_after_write:
            raise VectorStoreUnavailableError("qdrant upsert response timed out")

    def delete_point(self, *, point_id: str) -> None:
        with self.lock:
            self.delete_calls += 1
            call_number = self.delete_calls
            fail_before_write = (
                call_number in self.fail_delete_calls
                or self.fail_delete_count > 0
            )
            fail_after_write = call_number in self.fail_delete_after_write_calls
            if fail_before_write:
                if call_number not in self.fail_delete_calls:
                    self.fail_delete_count -= 1
            else:
                self.points.pop(point_id, None)
        if call_number == self.block_delete_call:
            assert self.delete_written is not None
            assert self.release_delete_return is not None
            self.delete_written.wait()
            self.release_delete_return.wait()
        if fail_before_write or fail_after_write:
            raise VectorStoreUnavailableError("qdrant unavailable")


class VectorStoreRegistry:
    def __init__(self) -> None:
        self.stores: dict[str, ControlledVectorStore] = {}

    def store(self, collection: str) -> ControlledVectorStore:
        return self.stores.setdefault(collection, ControlledVectorStore())

    def build(self, _settings, *, qdrant_collection: str) -> ControlledVectorStore:
        return self.store(qdrant_collection)


@dataclass(frozen=True)
class SeededState:
    profile_job_id: str
    document_id: str
    profile_document_ids: tuple[str, ...]
    collections: tuple[str, ...]


@contextmanager
def _session_factory(path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(
        f"sqlite+pysqlite:///{path}",
        connect_args={"check_same_thread": False, "timeout": 10},
        future=True,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    try:
        yield factory
    finally:
        engine.dispose()


def _seed_state(
    factory: sessionmaker[Session],
    *,
    profile_count: int,
) -> SeededState:
    document = SearchDocument(
        id="document-concurrency",
        family_id="family-concurrency",
        entity_type="meal_plan",
        entity_id="plan-concurrency",
        title_text="番茄晚餐",
        keyword_text="番茄晚餐",
        detail_text="",
        semantic_text="餐食计划：番茄晚餐",
        metadata_json={},
        content_hash="a" * 64,
        document_builder_version="v1",
    )
    profiles = tuple(
        FamilySearchProfile(
            id=f"profile-concurrency-{index}",
            family_id="family-concurrency",
            provider_profile_id=f"provider-concurrency-{index}",
            provider_profile_version_id=f"provider-version-concurrency-{index}",
            adapter_kind="openai_compatible_http",
            embedding_model="embedding-test",
            dimensions=2,
            distance="Cosine",
            document_builder_version="v1",
            index_identity_checksum=f"identity-concurrency-{index}",
            qdrant_collection=f"culina_fsp_concurrency_{index}",
            status=FamilyModelSearchProfileStatus.ACTIVE,
        )
        for index in range(profile_count)
    )
    profile_documents = tuple(
        FamilySearchProfileDocument(
            id=f"profile-document-concurrency-{index}",
            family_id="family-concurrency",
            search_profile_id=profile.id,
            search_document_id=document.id,
            content_hash=document.content_hash,
            status="pending_handoff" if index == 0 else "indexed",
            vector_json=[0.1, 0.2] if index == 0 else None,
            vector_dimensions=2 if index == 0 else None,
        )
        for index, profile in enumerate(profiles)
    )
    profile_job = SearchIndexJob(
        id="profile-job-concurrency",
        family_id="family-concurrency",
        search_profile_id=profiles[0].id,
        user_id="owner-concurrency",
        status="queued",
        entity_type="meal_plan",
        entity_id="plan-concurrency",
        target_name="番茄晚餐",
        vector_status="pending",
        usage_attempt_key="embedding-attempt-concurrency",
        attempt_count=1,
    )
    with factory() as db:
        db.add_all(
            (
                Family(id="family-concurrency", name="并发测试家庭"),
                Food(
                    id="food-concurrency",
                    family_id="family-concurrency",
                    name="番茄晚餐",
                    type=FoodType.SELF_MADE,
                    category="家常菜",
                ),
                FoodPlanItem(
                    id="plan-concurrency",
                    family_id="family-concurrency",
                    user_id="owner-concurrency",
                    food_id="food-concurrency",
                    plan_date=date(2026, 8, 25),
                    meal_type=MealType.DINNER,
                    status="planned",
                ),
                document,
                *profiles,
                *profile_documents,
                profile_job,
            )
        )
        db.commit()
    return SeededState(
        profile_job_id=profile_job.id,
        document_id=document.id,
        profile_document_ids=tuple(row.id for row in profile_documents),
        collections=tuple(profile.qdrant_collection for profile in profiles),
    )


def _enqueue_deletion(factory: sessionmaker[Session]) -> str:
    with factory() as db:
        plan = db.get(FoodPlanItem, "plan-concurrency")
        assert plan is not None
        db.delete(plan)
        job = enqueue_search_document_deletion_job(
            db,
            family_id="family-concurrency",
            user_id="owner-concurrency",
            entity_type="meal_plan",
            entity_id="plan-concurrency",
            target_name="番茄晚餐",
        )
        db.commit()
        return job.id


def _start_thread(target: Callable[[], None]) -> tuple[Thread, list[BaseException]]:
    errors: list[BaseException] = []

    def run() -> None:
        try:
            target()
        except BaseException as exc:  # pragma: no cover - surfaced below
            errors.append(exc)

    thread = Thread(target=run, daemon=True)
    thread.start()
    return thread, errors


def _join(thread: Thread, errors: list[BaseException]) -> None:
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert errors == []


def _assert_cleanup_finished(factory: sessionmaker[Session], deletion_job_id: str) -> None:
    with factory() as db:
        deletion_job = db.get(SearchIndexJob, deletion_job_id)
        profile_job = db.get(SearchIndexJob, "profile-job-concurrency")
        assert deletion_job is not None and deletion_job.status == "succeeded"
        assert deletion_job.vector_status == "skipped"
        assert profile_job is not None and profile_job.status == "succeeded"
        assert profile_job.vector_status == "skipped"
        assert db.get(SearchDocument, "document-concurrency") is None
        assert db.scalar(
            select(FamilySearchProfileDocument).where(
                FamilySearchProfileDocument.search_document_id
                == "document-concurrency"
            )
        ) is None


def test_handoff_upsert_after_delete_is_compensated_before_deletion_finalizes(
    tmp_path: Path,
) -> None:
    with _session_factory(tmp_path / "delete-before-upsert.db") as factory:
        state = _seed_state(factory, profile_count=1)
        store = ControlledVectorStore()
        store.points[POINT_ID] = ([0.5, 0.6], {"content_hash": "old"})
        store.upsert_entered = Barrier(2, timeout=10)
        store.release_upsert = Barrier(2, timeout=10)
        store.block_delete_call = 1
        store.delete_written = Barrier(2, timeout=10)
        store.release_delete_return = Barrier(2, timeout=10)

        handoff_thread, handoff_errors = _start_thread(
            lambda: process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=store,  # type: ignore[arg-type]
            )
        )
        store.upsert_entered.wait()
        deletion_job_id = _enqueue_deletion(factory)
        deletion_thread, deletion_errors = _start_thread(
            lambda: process_search_index_job(
                deletion_job_id,
                session_factory=factory,
                vector_store=store,  # type: ignore[arg-type]
            )
        )
        store.delete_written.wait()
        store.release_upsert.wait()
        _join(handoff_thread, handoff_errors)
        store.release_delete_return.wait()
        _join(deletion_thread, deletion_errors)

        assert POINT_ID not in store.points
        _assert_cleanup_finished(factory, deletion_job_id)


def test_deletion_waits_for_handoff_that_upserted_before_database_finalization(
    tmp_path: Path,
) -> None:
    with _session_factory(tmp_path / "upsert-before-finalize.db") as factory:
        state = _seed_state(factory, profile_count=1)
        store = ControlledVectorStore()
        store.points[POINT_ID] = ([0.5, 0.6], {"content_hash": "old"})
        store.upsert_entered = Barrier(2, timeout=10)
        store.release_upsert = Barrier(2, timeout=10)
        store.upsert_written = Barrier(2, timeout=10)
        store.release_upsert_return = Barrier(2, timeout=10)
        store.block_delete_call = 1
        store.delete_written = Barrier(2, timeout=10)
        store.release_delete_return = Barrier(2, timeout=10)

        handoff_thread, handoff_errors = _start_thread(
            lambda: process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=store,  # type: ignore[arg-type]
            )
        )
        store.upsert_entered.wait()
        deletion_job_id = _enqueue_deletion(factory)
        deletion_thread, deletion_errors = _start_thread(
            lambda: process_search_index_job(
                deletion_job_id,
                session_factory=factory,
                vector_store=store,  # type: ignore[arg-type]
            )
        )
        store.delete_written.wait()
        store.release_upsert.wait()
        store.upsert_written.wait()
        store.release_delete_return.wait()
        _join(deletion_thread, deletion_errors)
        store.release_upsert_return.wait()
        _join(handoff_thread, handoff_errors)

        process_search_index_job(
            deletion_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )

        assert POINT_ID not in store.points
        _assert_cleanup_finished(factory, deletion_job_id)


def test_partial_delete_failure_keeps_fence_while_concurrent_handoff_is_compensated(
    tmp_path: Path,
) -> None:
    with _session_factory(tmp_path / "partial-delete.db") as factory:
        state = _seed_state(factory, profile_count=2)
        registry = VectorStoreRegistry()
        first_store = registry.store(state.collections[0])
        second_store = registry.store(state.collections[1])
        first_store.points[POINT_ID] = ([0.5, 0.6], {"content_hash": "old"})
        second_store.points[POINT_ID] = ([0.7, 0.8], {"content_hash": "old"})
        first_store.upsert_entered = Barrier(2, timeout=10)
        first_store.release_upsert = Barrier(2, timeout=10)
        first_store.block_delete_call = 1
        first_store.delete_written = Barrier(2, timeout=10)
        first_store.release_delete_return = Barrier(2, timeout=10)
        first_store.fail_delete_calls = {2}
        second_store.fail_delete_count = 1

        handoff_thread, handoff_errors = _start_thread(
            lambda: process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=first_store,  # type: ignore[arg-type]
            )
        )
        first_store.upsert_entered.wait()
        deletion_job_id = _enqueue_deletion(factory)
        with patch(
            "app.services.search.jobs.build_vector_store",
            side_effect=registry.build,
        ):
            deletion_thread, deletion_errors = _start_thread(
                lambda: process_search_index_job(
                    deletion_job_id,
                    session_factory=factory,
                )
            )
            first_store.delete_written.wait()
            first_store.release_upsert.wait()
            _join(handoff_thread, handoff_errors)
            first_store.release_delete_return.wait()
            _join(deletion_thread, deletion_errors)

            assert POINT_ID in first_store.points
            assert POINT_ID in second_store.points
            with factory() as db:
                deletion_job = db.get(SearchIndexJob, deletion_job_id)
                profile_job = db.get(SearchIndexJob, state.profile_job_id)
                assert deletion_job is not None and deletion_job.status == "failed"
                assert deletion_job.vector_status == "delete_pending"
                assert deletion_job.error_code == "search_vector_unavailable"
                assert profile_job is not None and profile_job.status == "failed"
                assert profile_job.vector_status == "point_delete_pending"
                assert profile_job.error_code == "search_vector_unavailable"
                assert db.get(SearchDocument, state.document_id) is not None
                assert all(
                    db.get(FamilySearchProfileDocument, row_id) is not None
                    for row_id in state.profile_document_ids
                )
                retried = retry_failed_search_index_job(
                    db,
                    family_id="family-concurrency",
                    job_id=deletion_job_id,
                )
                assert retried is not None
                db.commit()
            with factory() as db:
                retried_profile = retry_failed_search_index_job(
                    db,
                    family_id="family-concurrency",
                    job_id=state.profile_job_id,
                )
                assert retried_profile is not None
                db.commit()
            process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=first_store,  # type: ignore[arg-type]
            )
            assert POINT_ID not in first_store.points
            process_search_index_job(
                deletion_job_id,
                session_factory=factory,
            )

        assert POINT_ID not in first_store.points
        assert POINT_ID not in second_store.points
        _assert_cleanup_finished(factory, deletion_job_id)


def test_ambiguous_upsert_timeout_while_deletion_is_fenced_keeps_cleanup_obligation(
    tmp_path: Path,
) -> None:
    with _session_factory(tmp_path / "ambiguous-upsert-fenced.db") as factory:
        state = _seed_state(factory, profile_count=1)
        store = ControlledVectorStore()
        store.points[POINT_ID] = ([0.5, 0.6], {"content_hash": "old"})
        store.upsert_entered = Barrier(2, timeout=10)
        store.release_upsert = Barrier(2, timeout=10)
        store.fail_upsert_after_write_count = 1
        store.fail_delete_calls = {1}

        handoff_thread, handoff_errors = _start_thread(
            lambda: process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=store,  # type: ignore[arg-type]
            )
        )
        store.upsert_entered.wait()
        deletion_job_id = _enqueue_deletion(factory)
        store.release_upsert.wait()
        _join(handoff_thread, handoff_errors)

        with factory() as db:
            deletion_job = db.get(SearchIndexJob, deletion_job_id)
            profile_job = db.get(SearchIndexJob, state.profile_job_id)
            assert deletion_job is not None and deletion_job.status == "queued"
            assert deletion_job.vector_status == "delete_pending"
            assert profile_job is not None and profile_job.status == "failed"
            assert profile_job.vector_status == "point_delete_pending"
            assert profile_job.error_code == "search_vector_unavailable"
            assert db.get(SearchDocument, state.document_id) is not None
            assert db.get(
                FamilySearchProfileDocument,
                state.profile_document_ids[0],
            ) is not None

        process_search_index_job(
            deletion_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )
        assert POINT_ID not in store.points
        with factory() as db:
            deletion_job = db.get(SearchIndexJob, deletion_job_id)
            assert deletion_job is not None and deletion_job.status == "queued"
            assert db.get(SearchDocument, state.document_id) is not None
            retried_profile = retry_failed_search_index_job(
                db,
                family_id="family-concurrency",
                job_id=state.profile_job_id,
            )
            assert retried_profile is not None
            db.commit()

        process_search_index_job(
            state.profile_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )
        process_search_index_job(
            state.profile_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )
        process_search_index_job(
            deletion_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )
        process_search_index_job(
            deletion_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )

        assert POINT_ID not in store.points
        _assert_cleanup_finished(factory, deletion_job_id)


def test_ambiguous_upsert_after_delete_side_effect_waits_for_idempotent_cleanup(
    tmp_path: Path,
) -> None:
    with _session_factory(tmp_path / "ambiguous-upsert-after-delete.db") as factory:
        state = _seed_state(factory, profile_count=1)
        store = ControlledVectorStore()
        store.points[POINT_ID] = ([0.5, 0.6], {"content_hash": "old"})
        store.upsert_entered = Barrier(2, timeout=10)
        store.release_upsert = Barrier(2, timeout=10)
        store.fail_upsert_after_write_count = 1
        store.block_delete_call = 1
        store.delete_written = Barrier(2, timeout=10)
        store.release_delete_return = Barrier(2, timeout=10)
        store.fail_delete_after_write_calls = {2}

        handoff_thread, handoff_errors = _start_thread(
            lambda: process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=store,  # type: ignore[arg-type]
            )
        )
        store.upsert_entered.wait()
        deletion_job_id = _enqueue_deletion(factory)
        deletion_thread, deletion_errors = _start_thread(
            lambda: process_search_index_job(
                deletion_job_id,
                session_factory=factory,
                vector_store=store,  # type: ignore[arg-type]
            )
        )
        store.delete_written.wait()
        assert POINT_ID not in store.points
        store.release_upsert.wait()
        _join(handoff_thread, handoff_errors)
        store.release_delete_return.wait()
        _join(deletion_thread, deletion_errors)

        assert POINT_ID not in store.points
        with factory() as db:
            deletion_job = db.get(SearchIndexJob, deletion_job_id)
            profile_job = db.get(SearchIndexJob, state.profile_job_id)
            assert deletion_job is not None and deletion_job.status == "queued"
            assert deletion_job.vector_status == "delete_pending"
            assert profile_job is not None and profile_job.status == "failed"
            assert profile_job.vector_status == "point_delete_pending"
            assert profile_job.error_code == "search_vector_unavailable"
            assert db.get(SearchDocument, state.document_id) is not None
            assert db.get(
                FamilySearchProfileDocument,
                state.profile_document_ids[0],
            ) is not None
            retried_profile = retry_failed_search_index_job(
                db,
                family_id="family-concurrency",
                job_id=state.profile_job_id,
            )
            assert retried_profile is not None
            db.commit()

        process_search_index_job(
            state.profile_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )
        process_search_index_job(
            state.profile_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )
        process_search_index_job(
            deletion_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )
        process_search_index_job(
            deletion_job_id,
            session_factory=factory,
            vector_store=store,  # type: ignore[arg-type]
        )

        assert POINT_ID not in store.points
        _assert_cleanup_finished(factory, deletion_job_id)


def test_partial_delete_failure_keeps_ambiguous_upsert_cleanup_markers(
    tmp_path: Path,
) -> None:
    with _session_factory(tmp_path / "ambiguous-upsert-partial-delete.db") as factory:
        state = _seed_state(factory, profile_count=2)
        registry = VectorStoreRegistry()
        first_store = registry.store(state.collections[0])
        second_store = registry.store(state.collections[1])
        first_store.points[POINT_ID] = ([0.5, 0.6], {"content_hash": "old"})
        second_store.points[POINT_ID] = ([0.7, 0.8], {"content_hash": "old"})
        first_store.upsert_entered = Barrier(2, timeout=10)
        first_store.release_upsert = Barrier(2, timeout=10)
        first_store.fail_upsert_after_write_count = 1
        first_store.block_delete_call = 1
        first_store.delete_written = Barrier(2, timeout=10)
        first_store.release_delete_return = Barrier(2, timeout=10)
        first_store.fail_delete_calls = {2}
        second_store.fail_delete_count = 1

        handoff_thread, handoff_errors = _start_thread(
            lambda: process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=first_store,  # type: ignore[arg-type]
            )
        )
        first_store.upsert_entered.wait()
        deletion_job_id = _enqueue_deletion(factory)
        with patch(
            "app.services.search.jobs.build_vector_store",
            side_effect=registry.build,
        ):
            deletion_thread, deletion_errors = _start_thread(
                lambda: process_search_index_job(
                    deletion_job_id,
                    session_factory=factory,
                )
            )
            first_store.delete_written.wait()
            first_store.release_upsert.wait()
            _join(handoff_thread, handoff_errors)
            first_store.release_delete_return.wait()
            _join(deletion_thread, deletion_errors)

            assert POINT_ID in first_store.points
            assert POINT_ID in second_store.points
            with factory() as db:
                deletion_job = db.get(SearchIndexJob, deletion_job_id)
                profile_job = db.get(SearchIndexJob, state.profile_job_id)
                assert deletion_job is not None and deletion_job.status == "failed"
                assert deletion_job.vector_status == "delete_pending"
                assert deletion_job.error_code == "search_vector_unavailable"
                assert profile_job is not None and profile_job.status == "failed"
                assert profile_job.vector_status == "point_delete_pending"
                assert profile_job.error_code == "search_vector_unavailable"
                assert db.get(SearchDocument, state.document_id) is not None
                assert all(
                    db.get(FamilySearchProfileDocument, row_id) is not None
                    for row_id in state.profile_document_ids
                )
                retried_profile = retry_failed_search_index_job(
                    db,
                    family_id="family-concurrency",
                    job_id=state.profile_job_id,
                )
                assert retried_profile is not None
                db.commit()

            process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=first_store,  # type: ignore[arg-type]
            )
            process_search_index_job(
                state.profile_job_id,
                session_factory=factory,
                vector_store=first_store,  # type: ignore[arg-type]
            )
            assert POINT_ID not in first_store.points
            with factory() as db:
                retried_deletion = retry_failed_search_index_job(
                    db,
                    family_id="family-concurrency",
                    job_id=deletion_job_id,
                )
                assert retried_deletion is not None
                db.commit()
            process_search_index_job(
                deletion_job_id,
                session_factory=factory,
            )
            process_search_index_job(
                deletion_job_id,
                session_factory=factory,
            )

        assert POINT_ID not in first_store.points
        assert POINT_ID not in second_store.points
        _assert_cleanup_finished(factory, deletion_job_id)
