from __future__ import annotations

import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.ai.images.generation import ImageGenerationResult
from app.ai.images.jobs import _bind_generated_asset_to_target, process_image_generation_job
from app.core.deps import get_current_auth
from app.core.enums import FoodType, ImageGenerationMode, MealType, MediaEntityType, MediaSource, MembershipStatus, UserRole
from app.core.utils import create_id, utcnow
from app.db.session import get_db
from app.main import app
from app.models.domain import AIImageGenerationJob, Base, Family, Food, MealLog, MealLogFood, MediaAsset, Membership, User


class FakeImageGenerationClient:
    def generate_from_text(self, request):
        return ImageGenerationResult(
            prompt="test",
            svg_markup='<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"></svg>',
            file_extension=".svg",
            mime_type="image/svg+xml",
            style_key="test-style",
            prompt_version="test-version",
        )

    def generate_from_reference(self, request):
        return self.generate_from_text(request)


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
            food = Food(
                id="food-meal",
                family_id=family.id,
                name="番茄炒蛋",
                type=FoodType.SELF_MADE,
                category="家常",
                flavor_tags=[],
                scene_tags=[],
                suitable_meal_types=["dinner"],
                source_name="",
                purchase_source="",
                scene="",
                notes="",
                routine_note="",
                stock_quantity=None,
                stock_unit="",
                favorite=False,
                created_by=user.id,
                updated_by=user.id,
            )
            meal = MealLog(
                id="meal-bind-target",
                family_id=family.id,
                date=date(2026, 5, 16),
                meal_type=MealType.DINNER,
                participant_user_ids=[user.id],
                notes="",
                mood="",
                created_by=user.id,
                updated_by=user.id,
            )
            entry = MealLogFood(
                id="meal-food-bind",
                meal_log_id=meal.id,
                food_id=food.id,
                servings=1,
                note="",
            )
            db.add_all([family, user, membership, food, meal, entry])
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

    def test_meal_log_bind_bumps_parent_version_once(self) -> None:
        with self.SessionLocal() as db:
            meal = db.get(MealLog, "meal-bind-target")
            assert meal is not None
            self.assertEqual(meal.row_version, 1)

        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.MEAL_LOG.value,
                "title": "晚餐照片",
                "target_entity_type": "meal_log",
                "target_entity_id": "meal-bind-target",
            },
        )
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["job_id"]

        process_image_generation_job(
            job_id,
            session_factory=self.SessionLocal,
            client_factory=FakeImageGenerationClient,
        )

        payload = self.client.get(f"/api/media/ai-render/{job_id}").json()
        self.assertEqual(payload["bind_status"], "bound")
        with self.SessionLocal() as db:
            meal = db.get(MealLog, "meal-bind-target")
            assert meal is not None
            self.assertEqual(meal.row_version, 2)
            self.assertEqual(meal.notes, "")
            self.assertEqual(meal.mood, "")
            self.assertEqual(meal.participant_user_ids, ["user-test"])
            generated = db.get(MediaAsset, payload["generated_asset"]["id"])
            assert generated is not None
            self.assertEqual(generated.entity_type, "meal_log")
            self.assertEqual(generated.entity_id, "meal-bind-target")

    def test_meal_log_bind_skipped_or_unbound_does_not_bump_version(self) -> None:
        with self.SessionLocal() as db:
            user_asset = MediaAsset(
                id="photo-user-meal",
                family_id="family-test",
                name="user-meal.png",
                url="/media/family-test/user-meal.png",
                file_path="family-test/user-meal.png",
                source=MediaSource.UPLOAD,
                alt="user meal photo",
                entity_type="meal_log",
                entity_id="meal-bind-target",
                created_by="user-test",
            )
            db.add(user_asset)
            db.commit()

        skipped = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.MEAL_LOG.value,
                "title": "晚餐照片",
                "target_entity_type": "meal_log",
                "target_entity_id": "meal-bind-target",
            },
        )
        self.assertEqual(skipped.status_code, 202, skipped.text)
        skipped_job_id = skipped.json()["job_id"]
        process_image_generation_job(
            skipped_job_id,
            session_factory=self.SessionLocal,
            client_factory=FakeImageGenerationClient,
        )
        skipped_payload = self.client.get(f"/api/media/ai-render/{skipped_job_id}").json()
        self.assertEqual(skipped_payload["bind_status"], "skipped")

        unbound = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.MEAL_LOG.value,
                "title": "未绑定照片",
            },
        )
        self.assertEqual(unbound.status_code, 202, unbound.text)
        unbound_job_id = unbound.json()["job_id"]
        process_image_generation_job(
            unbound_job_id,
            session_factory=self.SessionLocal,
            client_factory=FakeImageGenerationClient,
        )
        unbound_payload = self.client.get(f"/api/media/ai-render/{unbound_job_id}").json()
        self.assertEqual(unbound_payload["bind_status"], "unbound")

        with self.SessionLocal() as db:
            meal = db.get(MealLog, "meal-bind-target")
            assert meal is not None
            self.assertEqual(meal.row_version, 1)

    def test_meal_log_bind_rechecks_non_ai_assets_under_lock(self) -> None:
        """Simulate a concurrent non-AI attach between pre-lock read and lock.

        Pre-lock sees only AI assets (would bind), but under the MealLog lock a
        user upload appears; bind must skip and not bump.
        """
        with self.SessionLocal() as db:
            generated = MediaAsset(
                id="photo-ai-generated",
                family_id="family-test",
                name="ai-meal.svg",
                url="/media/family-test/ai-meal.svg",
                file_path="family-test/ai-meal.svg",
                source=MediaSource.AI,
                alt="ai meal photo",
                entity_type=None,
                entity_id=None,
                created_by="user-test",
            )
            existing_ai = MediaAsset(
                id="photo-ai-existing",
                family_id="family-test",
                name="ai-existing.svg",
                url="/media/family-test/ai-existing.svg",
                file_path="family-test/ai-existing.svg",
                source=MediaSource.AI,
                alt="existing ai meal photo",
                entity_type="meal_log",
                entity_id="meal-bind-target",
                created_by="user-test",
            )
            job = AIImageGenerationJob(
                id=create_id("image-job"),
                family_id="family-test",
                user_id="user-test",
                status="succeeded",
                request_payload={
                    "mode": ImageGenerationMode.TEXT.value,
                    "entity_type": MediaEntityType.MEAL_LOG.value,
                    "title": "晚餐照片",
                },
                target_entity_type="meal_log",
                target_entity_id="meal-bind-target",
                generated_media_id=generated.id,
                bind_status="pending",
                created_at=utcnow(),
                updated_at=utcnow(),
            )
            db.add_all([generated, existing_ai, job])
            db.commit()
            job_id = job.id

        from app.ai.images import jobs as image_jobs

        real_lock = image_jobs.lock_meal_log_write_targets

        def lock_then_attach_non_ai(*args, **kwargs):
            locked = real_lock(*args, **kwargs)
            session = args[0]
            session.add(
                MediaAsset(
                    id="photo-user-race",
                    family_id="family-test",
                    name="user-race.png",
                    url="/media/family-test/user-race.png",
                    file_path="family-test/user-race.png",
                    source=MediaSource.UPLOAD,
                    alt="user race photo",
                    entity_type="meal_log",
                    entity_id="meal-bind-target",
                    created_by="user-test",
                )
            )
            session.flush()
            return locked

        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            assert job is not None
            with patch.object(image_jobs, "lock_meal_log_write_targets", side_effect=lock_then_attach_non_ai):
                bind_status = _bind_generated_asset_to_target(db, job)
            db.commit()

        self.assertEqual(bind_status, "skipped")
        with self.SessionLocal() as db:
            meal = db.get(MealLog, "meal-bind-target")
            assert meal is not None
            self.assertEqual(meal.row_version, 1)
            job = db.get(AIImageGenerationJob, job_id)
            assert job is not None
            self.assertEqual(job.bind_status, "skipped")
            generated = db.get(MediaAsset, "photo-ai-generated")
            assert generated is not None
            self.assertIsNone(generated.entity_type)
            self.assertIsNone(generated.entity_id)
            user_asset = db.get(MediaAsset, "photo-user-race")
            assert user_asset is not None
            self.assertEqual(user_asset.entity_type, "meal_log")
            self.assertEqual(user_asset.entity_id, "meal-bind-target")
            existing_ai = db.get(MediaAsset, "photo-ai-existing")
            assert existing_ai is not None
            self.assertEqual(existing_ai.entity_type, "meal_log")
            self.assertEqual(existing_ai.entity_id, "meal-bind-target")


if __name__ == "__main__":
    unittest.main()
