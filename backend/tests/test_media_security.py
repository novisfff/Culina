from __future__ import annotations

import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import ImageGenerationMode, MediaEntityType, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, MediaAsset, Membership, User
from app.ai.images.generation import ImageGenerationResult


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
        self.put_object_patcher.start()
        self.delete_object_patcher = patch("app.services.media.delete_media_file")
        self.delete_object_patcher.start()
        self.client_patcher = patch("app.ai.images.jobs.ImageGenerationClient", FakeImageGenerationClient)
        self.client_patcher.start()
        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_auth] = override_auth
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client_patcher.stop()
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

        final_payload = None
        for _ in range(20):
            poll_response = self.client.get(f"/api/media/ai-render/{job_id}")
            self.assertEqual(poll_response.status_code, 200)
            payload = poll_response.json()
            if payload["status"] == "succeeded" and payload["generated_asset"]:
                final_payload = payload
                break
            time.sleep(0.05)

        self.assertIsNotNone(final_payload)
        assert final_payload is not None
        self.assertEqual(final_payload["style_key"], "test-style")
        self.assertEqual(final_payload["prompt_version"], "test-version")
        self.assertEqual(final_payload["generated_asset"]["source"], "ai")
        finalized_asset_id = final_payload["generated_asset"]["id"]

        repeat_response = self.client.get(f"/api/media/ai-render/{job_id}")
        self.assertEqual(repeat_response.status_code, 200)
        self.assertEqual(repeat_response.json()["generated_asset"]["id"], finalized_asset_id)
        with self.SessionLocal() as db:
            self.assertEqual(db.query(MediaAsset).filter(MediaAsset.source == "ai").count(), 1)


if __name__ == "__main__":
    unittest.main()
