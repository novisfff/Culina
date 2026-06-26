from __future__ import annotations

from datetime import timedelta
from io import BytesIO
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ImageGenerationMode, MediaEntityType, MediaSource, MembershipStatus, UserRole
from app.core.utils import utcnow
from app.db.session import get_db
from app.main import app
from app.models.domain import AIImageGenerationJob, Base, Family, Food, MediaAsset, Membership, User
from app.ai.images.jobs import (
    MAX_ATTEMPTS,
    claim_pending_image_generation_jobs,
    process_image_generation_job,
    recover_interrupted_image_generation_jobs,
)
from app.ai.images.generation import ImageGenerationResult
from app.services.media import build_media_variants, delete_media_file


def make_png_payload() -> bytes:
    output = BytesIO()
    Image.new("RGBA", (4, 3), (210, 107, 51, 255)).save(output, format="PNG")
    return output.getvalue()


PNG_PAYLOAD = make_png_payload()


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


class FakeRasterImageGenerationClient:
    def generate_from_text(self, request):
        return ImageGenerationResult(
            prompt="test",
            binary_content=PNG_PAYLOAD,
            file_extension=".png",
            mime_type="image/png",
            style_key="test-style",
            prompt_version="test-version",
        )

    def generate_from_reference(self, request):
        return self.generate_from_text(request)


class MediaVariantServiceTestCase(unittest.TestCase):
    def test_build_media_variants_writes_three_webp_objects(self) -> None:
        with patch("app.services.media._put_media_object") as put_object:
            variants = build_media_variants(family_id="family-test", asset_id="photo-test", payload=PNG_PAYLOAD)

        self.assertEqual(set(variants), {"thumb", "card", "large"})
        self.assertEqual(put_object.call_count, 3)
        self.assertEqual(variants["thumb"]["content_type"], "image/webp")
        self.assertEqual(variants["thumb"]["width"], 4)
        self.assertEqual(variants["thumb"]["height"], 3)
        self.assertIn("/media/family-test/variants/photo-test/thumb.webp", variants["thumb"]["url"])

    def test_build_media_variants_skips_invalid_payload(self) -> None:
        with patch("app.services.media._put_media_object") as put_object:
            variants = build_media_variants(family_id="family-test", asset_id="photo-test", payload=b"not an image")

        self.assertEqual(variants, {})
        put_object.assert_not_called()

    def test_delete_media_file_removes_original_and_variants(self) -> None:
        asset = MediaAsset(
            id="photo-test",
            family_id="family-test",
            name="cover",
            url="/media/family-test/cover.png",
            file_path="family-test/cover.png",
            source=MediaSource.AI,
            alt="cover",
            variants={
                "thumb": {"url": "/media/family-test/variants/photo-test/thumb.webp"},
                "card": {"url": "/media/family-test/variants/photo-test/card.webp"},
            },
        )
        with patch("app.services.media.get_settings", return_value=SimpleNamespace(minio_bucket="bucket")):
            with patch("app.services.media._storage_client") as storage_client:
                delete_media_file(asset)

        remove_object = storage_client.return_value.remove_object
        remove_object.assert_any_call("bucket", "family-test/variants/photo-test/thumb.webp")
        remove_object.assert_any_call("bucket", "family-test/variants/photo-test/card.webp")
        remove_object.assert_any_call("bucket", "family-test/cover.png")


class MediaSecurityTestCase(unittest.TestCase):
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
            return_value=SimpleNamespace(
                media_max_upload_bytes=128,
            ),
        )
        self.settings_patcher.start()
        self.put_object_patcher = patch("app.services.media._put_media_object")
        self.put_object = self.put_object_patcher.start()
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

    def test_upload_rejects_svg(self) -> None:
        response = self.client.post(
            "/api/media/upload",
            files={"file": ("cover.svg", b"<svg></svg>", "image/svg+xml")},
            data={"source": "upload", "alt": "cover"},
        )

        self.assertEqual(response.status_code, 400)

    def test_upload_rejects_spoofed_content_type(self) -> None:
        response = self.client.post(
            "/api/media/upload",
            files={"file": ("cover.png", b"not really png", "image/png")},
            data={"source": "upload", "alt": "cover"},
        )

        self.assertEqual(response.status_code, 400)

    def test_upload_rejects_oversized_file(self) -> None:
        payload = b"\x89PNG\r\n\x1a\n" + (b"0" * 256)
        response = self.client.post(
            "/api/media/upload",
            files={"file": ("cover.png", payload, "image/png")},
            data={"source": "upload", "alt": "cover"},
        )

        self.assertEqual(response.status_code, 413)

    def test_ai_render_returns_job_and_finalizes_asset_on_poll(self) -> None:
        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
            },
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]
        self.assertTrue(job_id)
        self.assertEqual(response.json()["status"], "queued")

        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            self.assertIsNotNone(job)
            assert job is not None
            self.assertEqual(job.status, "queued")

        process_image_generation_job(
            job_id,
            session_factory=self.SessionLocal,
            client_factory=FakeImageGenerationClient,
        )

        poll_response = self.client.get(f"/api/media/ai-render/{job_id}")
        self.assertEqual(poll_response.status_code, 200)
        final_payload = poll_response.json()

        self.assertEqual(final_payload["status"], "succeeded")
        self.assertEqual(final_payload["style_key"], "test-style")
        self.assertEqual(final_payload["prompt_version"], "test-version")
        self.assertEqual(final_payload["generated_asset"]["source"], "ai")
        self.assertIsNone(final_payload["generated_asset"]["variants"])
        finalized_asset_id = final_payload["generated_asset"]["id"]

        repeat_response = self.client.get(f"/api/media/ai-render/{job_id}")
        self.assertEqual(repeat_response.status_code, 200)
        self.assertEqual(repeat_response.json()["generated_asset"]["id"], finalized_asset_id)
        with self.SessionLocal() as db:
            self.assertEqual(db.query(MediaAsset).filter(MediaAsset.source == "ai").count(), 1)

    def test_ai_render_returns_variants_for_raster_asset(self) -> None:
        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
            },
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]

        process_image_generation_job(
            job_id,
            session_factory=self.SessionLocal,
            client_factory=FakeRasterImageGenerationClient,
        )

        poll_response = self.client.get(f"/api/media/ai-render/{job_id}")
        self.assertEqual(poll_response.status_code, 200)
        final_payload = poll_response.json()

        self.assertEqual(final_payload["status"], "succeeded")
        variants = final_payload["generated_asset"]["variants"]
        self.assertEqual(set(variants), {"thumb", "card", "large"})
        self.assertEqual(variants["card"]["content_type"], "image/webp")
        self.assertEqual(variants["card"]["width"], 4)
        self.assertEqual(variants["card"]["height"], 3)
        self.assertTrue(variants["card"]["url"].endswith("/card.webp"))

    def test_retry_failed_ai_render_requeues_job(self) -> None:
        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
            },
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]
        failed_at = utcnow()
        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            self.assertIsNotNone(job)
            assert job is not None
            job.status = "failed"
            job.error = "provider down"
            job.attempt_count = 3
            job.locked_at = failed_at
            job.started_at = failed_at
            job.completed_at = failed_at
            db.commit()

        retry_response = self.client.post(f"/api/media/ai-render/{job_id}/retry")
        self.assertEqual(retry_response.status_code, 202)
        payload = retry_response.json()
        self.assertEqual(payload["job_id"], job_id)
        self.assertEqual(payload["status"], "queued")
        self.assertIsNone(payload["error"])

        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            self.assertIsNotNone(job)
            assert job is not None
            self.assertEqual(job.status, "queued")
            self.assertIsNone(job.error)
            self.assertEqual(job.attempt_count, 0)
            self.assertIsNone(job.locked_at)
            self.assertIsNone(job.started_at)
            self.assertIsNone(job.completed_at)

    def test_startup_recovery_requeues_interrupted_ai_render_job(self) -> None:
        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
            },
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]
        locked_at = utcnow()
        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            self.assertIsNotNone(job)
            assert job is not None
            job.status = "running"
            job.error = "worker interrupted"
            job.attempt_count = 1
            job.locked_at = locked_at
            job.started_at = locked_at
            db.commit()

        with self.SessionLocal() as db:
            recovered_count = recover_interrupted_image_generation_jobs(db, include_all_running=True)
            self.assertEqual(recovered_count, 1)

        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            self.assertIsNotNone(job)
            assert job is not None
            self.assertEqual(job.status, "queued")
            self.assertIsNone(job.error)
            self.assertEqual(job.attempt_count, 1)
            self.assertIsNone(job.locked_at)
            self.assertIsNone(job.completed_at)
            claimed_ids = claim_pending_image_generation_jobs(db)
            self.assertEqual(claimed_ids, [job_id])

    def test_recovery_fails_interrupted_ai_render_after_max_attempts(self) -> None:
        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
            },
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]
        locked_at = utcnow() - timedelta(minutes=30)
        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            self.assertIsNotNone(job)
            assert job is not None
            job.status = "running"
            job.error = "worker interrupted"
            job.attempt_count = MAX_ATTEMPTS
            job.locked_at = locked_at
            job.started_at = locked_at
            db.commit()

        with self.SessionLocal() as db:
            recovered_count = recover_interrupted_image_generation_jobs(db)
            self.assertEqual(recovered_count, 1)

        poll_response = self.client.get(f"/api/media/ai-render/{job_id}")
        self.assertEqual(poll_response.status_code, 200)
        payload = poll_response.json()
        self.assertEqual(payload["status"], "failed")
        self.assertIn("最大重试次数", payload["error"])

        with self.SessionLocal() as db:
            job = db.get(AIImageGenerationJob, job_id)
            self.assertIsNotNone(job)
            assert job is not None
            self.assertEqual(job.status, "failed")
            self.assertIsNone(job.locked_at)
            self.assertIsNotNone(job.completed_at)
            claimed_ids = claim_pending_image_generation_jobs(db)
            self.assertEqual(claimed_ids, [])

    def test_ai_render_binds_target_when_entity_has_no_user_image(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-target",
                family_id="family-test",
                name="番茄炒蛋",
                type="dish",
                category="家常菜",
                created_by="user-test",
                updated_by="user-test",
            )
            db.add(food)
            db.commit()

        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
                "target_entity_type": "food",
                "target_entity_id": "food-target",
            },
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]

        process_image_generation_job(
            job_id,
            session_factory=self.SessionLocal,
            client_factory=FakeImageGenerationClient,
        )

        payload = self.client.get(f"/api/media/ai-render/{job_id}").json()
        self.assertEqual(payload["bind_status"], "bound")
        generated_asset_id = payload["generated_asset"]["id"]
        with self.SessionLocal() as db:
            generated = db.get(MediaAsset, generated_asset_id)
            self.assertIsNotNone(generated)
            assert generated is not None
            self.assertEqual(generated.entity_type, "food")
            self.assertEqual(generated.entity_id, "food-target")

    def test_ai_render_skips_target_bind_when_user_uploaded_image_during_wait(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-with-upload",
                family_id="family-test",
                name="番茄炒蛋",
                type="dish",
                category="家常菜",
                created_by="user-test",
                updated_by="user-test",
            )
            user_asset = MediaAsset(
                id="photo-user",
                family_id="family-test",
                name="user.png",
                url="/media/family-test/user.png",
                file_path="family-test/user.png",
                source=MediaSource.UPLOAD,
                alt="用户上传图",
                entity_type="food",
                entity_id="food-with-upload",
                created_by="user-test",
            )
            db.add_all([food, user_asset])
            db.commit()

        response = self.client.post(
            "/api/media/ai-render",
            json={
                "mode": ImageGenerationMode.TEXT.value,
                "entity_type": MediaEntityType.FOOD.value,
                "title": "番茄炒蛋",
                "target_entity_type": "food",
                "target_entity_id": "food-with-upload",
            },
        )
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["job_id"]

        process_image_generation_job(
            job_id,
            session_factory=self.SessionLocal,
            client_factory=FakeImageGenerationClient,
        )

        payload = self.client.get(f"/api/media/ai-render/{job_id}").json()
        self.assertEqual(payload["bind_status"], "skipped")
        generated_asset_id = payload["generated_asset"]["id"]
        with self.SessionLocal() as db:
            generated = db.get(MediaAsset, generated_asset_id)
            self.assertIsNotNone(generated)
            assert generated is not None
            self.assertIsNone(generated.entity_type)
            self.assertIsNone(generated.entity_id)

    def test_media_route_reads_object_from_storage(self) -> None:
        with patch("app.api.media.read_media_object_by_key", return_value=(b"png", "image/png")) as read_object:
            response = self.client.get("/media/family-test/cover.png")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"png")
        self.assertEqual(response.headers["content-type"], "image/png")
        read_object.assert_called_once_with("family-test/cover.png")


if __name__ == "__main__":
    unittest.main()
