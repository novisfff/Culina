from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ImageGenerationMode, MediaEntityType, MembershipStatus, UserRole
from app.core.utils import utcnow
from app.db.session import get_db
from app.main import app
from app.models.domain import AIImageGenerationJob, Base, Family, Membership, User


class AiImageJobApiTimestampTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            future=True,
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(
            bind=self.engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
            class_=Session,
        )
        with self.SessionLocal() as db:
            family = Family(id="family-test", name="测试家庭", motto="", location="")
            user = User(id="user-test", username="media", display_name="Media", avatar_seed="", is_active=True)
            membership = Membership(
                id="membership-test",
                family_id=family.id,
                user_id=user.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            )
            db.add_all([family, user, membership])
            db.commit()

        def override_db():
            with self.SessionLocal() as db:
                yield db

        def override_auth():
            with self.SessionLocal() as db:
                user = db.get(User, "user-test")
                membership = db.get(Membership, "membership-test")
                assert user is not None and membership is not None
                return user, membership

        self.settings_patcher = patch(
            "app.services.media.get_settings",
            return_value=SimpleNamespace(media_max_upload_bytes=128),
        )
        self.settings_patcher.start()
        self.put_object_patcher = patch("app.services.media._put_media_object")
        self.put_object_patcher.start()
        self.delete_object_patcher = patch("app.services.media.delete_media_file")
        self.delete_object_patcher.start()
        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_auth] = override_auth
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.delete_object_patcher.stop()
        self.put_object_patcher.stop()
        self.settings_patcher.stop()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

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

    def test_create_ai_render_exposes_created_at_and_null_completed_at(self) -> None:
        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
            },
        )
        self.assertEqual(response.status_code, 202)
        payload = response.json()
        job_id = payload["job_id"]
        self.assertTrue(job_id)

        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            assert job is not None
            self._assert_timestamp_fields(payload, created_at=job.created_at, completed_at=job.completed_at)
            self.assertIsNone(job.completed_at)

    def test_active_get_and_retry_ai_render_expose_timestamps(self) -> None:
        create_response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
            },
        )
        self.assertEqual(create_response.status_code, 202)
        job_id = create_response.json()["job_id"]
        completed_at = utcnow() - timedelta(minutes=1)
        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            assert job is not None
            job.status = "failed"
            job.error = "provider down"
            job.completed_at = completed_at
            db.commit()
            created_at = job.created_at

        active_response = self.client.get("/api/media/ai-render/active")
        self.assertEqual(active_response.status_code, 200)
        active_payload = next(item for item in active_response.json() if item["job_id"] == job_id)
        self._assert_timestamp_fields(active_payload, created_at=created_at, completed_at=completed_at)

        get_response = self.client.get(f"/api/media/ai-render/{job_id}")
        self.assertEqual(get_response.status_code, 200)
        self._assert_timestamp_fields(get_response.json(), created_at=created_at, completed_at=completed_at)

        retry_response = self.client.post(f"/api/media/ai-render/{job_id}/retry")
        self.assertEqual(retry_response.status_code, 202)
        retry_payload = retry_response.json()
        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            assert job is not None
            self._assert_timestamp_fields(retry_payload, created_at=job.created_at, completed_at=job.completed_at)
            self.assertIsNone(job.completed_at)


if __name__ == "__main__":
    unittest.main()
