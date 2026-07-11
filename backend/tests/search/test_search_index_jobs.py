from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.utils import utcnow
from app.models.domain import SearchIndexJob
from app.services.search.jobs import (
    JOB_LOCK_STALE_AFTER,
    MAX_ATTEMPTS,
    claim_pending_search_index_jobs,
    process_search_index_job,
    recover_interrupted_search_index_jobs,
)
from tests.recipes._support import RecipeApiTestCase


class SearchIndexJobsTestCase(RecipeApiTestCase):
    def _create_job(
        self,
        *,
        job_id: str,
        status: str = "queued",
        attempt_count: int = 0,
        locked_delta: timedelta | None = None,
        entity_id: str = "ingredient-tomato",
        error: str | None = None,
        completed_at=None,
        created_at=None,
    ) -> None:
        now = utcnow()
        locked_at = now + locked_delta if locked_delta is not None else None
        with self.SessionLocal() as db:
            db.add(
                SearchIndexJob(
                    id=job_id,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    status=status,
                    entity_type="ingredient",
                    entity_id=entity_id,
                    target_name="番茄",
                    vector_status="pending",
                    error=error,
                    attempt_count=attempt_count,
                    locked_at=locked_at,
                    started_at=locked_at,
                    completed_at=completed_at,
                    created_at=created_at or now,
                    updated_at=now,
                )
            )
            db.commit()

    def _assert_timestamp_fields(self, payload: dict, *, created_at: datetime, completed_at: datetime | None) -> None:
        def normalize(value: datetime) -> datetime:
            if value.tzinfo is not None:
                value = value.astimezone(timezone.utc).replace(tzinfo=None)
            return value.replace(microsecond=0)

        self.assertIn("created_at", payload)
        self.assertIn("completed_at", payload)
        self.assertIsNotNone(payload["created_at"])
        created = datetime.fromisoformat(payload["created_at"].replace("Z", "+00:00"))
        self.assertEqual(normalize(created), normalize(created_at))
        if completed_at is None:
            self.assertIsNone(payload["completed_at"])
        else:
            completed = datetime.fromisoformat(payload["completed_at"].replace("Z", "+00:00"))
            self.assertEqual(normalize(completed), normalize(completed_at))

    def test_claim_pending_jobs_claims_queued_failed_and_stale_running_only(self) -> None:
        stale_delta = -(JOB_LOCK_STALE_AFTER + timedelta(minutes=1))
        fresh_delta = -timedelta(minutes=1)
        self._create_job(job_id="job-queued")
        self._create_job(job_id="job-failed-retry", status="failed", attempt_count=MAX_ATTEMPTS - 1)
        self._create_job(job_id="job-failed-max", status="failed", attempt_count=MAX_ATTEMPTS)
        self._create_job(job_id="job-running-stale", status="running", locked_delta=stale_delta)
        self._create_job(job_id="job-running-fresh", status="running", locked_delta=fresh_delta)

        with self.SessionLocal() as db:
            claimed_ids = claim_pending_search_index_jobs(db, limit=10)

        self.assertEqual(claimed_ids, ["job-queued", "job-failed-retry", "job-running-stale"])
        with self.SessionLocal() as db:
            jobs = {job.id: job for job in db.query(SearchIndexJob).all()}
            for job_id in claimed_ids:
                self.assertEqual(jobs[job_id].status, "running")
                self.assertIsNotNone(jobs[job_id].locked_at)
                self.assertIsNotNone(jobs[job_id].started_at)
            self.assertEqual(jobs["job-failed-max"].status, "failed")
            self.assertEqual(jobs["job-running-fresh"].status, "running")

    def test_recovery_requeues_stale_running_and_fails_max_attempts(self) -> None:
        stale_delta = -(JOB_LOCK_STALE_AFTER + timedelta(minutes=1))
        fresh_delta = -timedelta(minutes=1)
        self._create_job(
            job_id="job-running-stale",
            status="running",
            attempt_count=1,
            locked_delta=stale_delta,
            error="worker interrupted",
        )
        self._create_job(
            job_id="job-running-max",
            status="running",
            attempt_count=MAX_ATTEMPTS,
            locked_delta=stale_delta,
            error="worker interrupted",
        )
        self._create_job(job_id="job-running-fresh", status="running", locked_delta=fresh_delta)

        with self.SessionLocal() as db:
            recovered_count = recover_interrupted_search_index_jobs(db)

        self.assertEqual(recovered_count, 2)
        with self.SessionLocal() as db:
            stale = db.get(SearchIndexJob, "job-running-stale")
            maxed = db.get(SearchIndexJob, "job-running-max")
            fresh = db.get(SearchIndexJob, "job-running-fresh")
            assert stale is not None and maxed is not None and fresh is not None
            self.assertEqual(stale.status, "queued")
            self.assertIsNone(stale.error)
            self.assertIsNone(stale.locked_at)
            self.assertIsNone(stale.completed_at)
            self.assertEqual(maxed.status, "failed")
            self.assertIsNone(maxed.locked_at)
            self.assertEqual(maxed.error, "worker interrupted")
            self.assertEqual(fresh.status, "running")
            self.assertIsNotNone(fresh.locked_at)

    def test_process_failure_marks_job_failed_and_releases_lock(self) -> None:
        self._create_job(job_id="job-missing-ingredient", entity_id="ingredient-missing")

        process_search_index_job("job-missing-ingredient", session_factory=self.SessionLocal)

        with self.SessionLocal() as db:
            job = db.get(SearchIndexJob, "job-missing-ingredient")
            assert job is not None
            self.assertEqual(job.status, "failed")
            self.assertEqual(job.vector_status, "failed")
            self.assertEqual(job.attempt_count, 1)
            self.assertIsNone(job.locked_at)
            self.assertIsNotNone(job.completed_at)
            self.assertIn("索引对象不存在或已删除", job.error or "")


    def test_active_get_and_retry_search_index_jobs_expose_timestamps(self) -> None:
        created_at = utcnow() - timedelta(minutes=5)
        completed_at = utcnow() - timedelta(minutes=1)
        self._create_job(
            job_id="job-failed-timestamps",
            status="failed",
            attempt_count=MAX_ATTEMPTS,
            error="index failed",
            completed_at=completed_at,
            created_at=created_at,
        )

        active_response = self.client.get("/api/search/index-jobs/active")
        self.assertEqual(active_response.status_code, 200)
        active_payload = next(item for item in active_response.json() if item["job_id"] == "job-failed-timestamps")
        self._assert_timestamp_fields(active_payload, created_at=created_at, completed_at=completed_at)

        get_response = self.client.get("/api/search/index-jobs/job-failed-timestamps")
        self.assertEqual(get_response.status_code, 200)
        self._assert_timestamp_fields(get_response.json(), created_at=created_at, completed_at=completed_at)

        retry_response = self.client.post("/api/search/index-jobs/job-failed-timestamps/retry")
        self.assertEqual(retry_response.status_code, 200)
        retry_payload = retry_response.json()
        with self.SessionLocal() as db:
            job = db.get(SearchIndexJob, "job-failed-timestamps")
            assert job is not None
            self._assert_timestamp_fields(retry_payload, created_at=job.created_at, completed_at=job.completed_at)
            self.assertIsNone(job.completed_at)
