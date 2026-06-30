from __future__ import annotations

from sqlalchemy import select

from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.runner_support.attachments import provider_images_for_attachments
from app.ai.workflows.runner import WorkspaceGraphRunner
from app.core.enums import MediaSource
from app.models.domain import AIMessage, MediaAsset

from ._support import AIAgentInfraTestCase, FakeChatProvider


class VisionFakeChatProvider(FakeChatProvider):
    supports_vision = True


class AIWorkspaceMultimodalAttachmentTestCase(AIAgentInfraTestCase):
    def test_prepare_user_message_binds_images_and_persists_image_parts(self) -> None:
        with self.SessionLocal() as db:
            asset = MediaAsset(
                id="media-ai-upload-1",
                family_id=self.family.id,
                name="fridge.jpg",
                url="/media/family-test/fridge.jpg",
                file_path="family-test/fridge.jpg",
                source=MediaSource.UPLOAD,
                alt="冰箱里的蔬菜",
                variants={"thumb": {"url": "/media/family-test/variants/media-ai-upload-1/thumb.webp"}},
                created_by=self.user.id,
            )
            db.add(asset)
            db.commit()

            runner = WorkspaceGraphRunner(AIApplicationService(db, provider=VisionFakeChatProvider()))
            prepared = runner._prepare_user_message(
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id=None,
                prompt="看一下这张图",
                message_summary="看一下这张图",
                client_message_id="client-message-image-1",
                client_run_id="agent-run-image-1",
                quick_task=None,
                subject=None,
                attachments=[{"type": "image", "media_id": "media-ai-upload-1", "client_attachment_id": "local-image-1"}],
            )

            message = db.scalar(select(AIMessage).where(AIMessage.id == prepared["user_message_id"]))
            self.assertIsNotNone(message)
            assert message is not None
            self.assertEqual(message.content_type, "parts")
            self.assertEqual([part["type"] for part in message.parts], ["text", "image"])
            self.assertEqual(message.parts[1]["image"]["media_id"], "media-ai-upload-1")
            db.refresh(asset)
            self.assertEqual(asset.entity_type, "ai_message")
            self.assertEqual(asset.entity_id, message.id)
            self.assertEqual(prepared["attachments"][0]["mediaId"], "media-ai-upload-1")

    def test_provider_images_require_vision_and_read_current_family_media(self) -> None:
        with self.SessionLocal() as db:
            asset = MediaAsset(
                id="media-ai-upload-2",
                family_id=self.family.id,
                name="plate.jpg",
                url="/media/family-test/plate.jpg",
                file_path="family-test/plate.jpg",
                source=MediaSource.UPLOAD,
                alt="餐盘",
                created_by=self.user.id,
            )
            db.add(asset)
            db.commit()

            images = provider_images_for_attachments(
                db=db,
                family_id=self.family.id,
                attachments=[{"type": "image", "mediaId": "media-ai-upload-2"}],
                provider_supports_vision=True,
                read_media_object=lambda _asset: (b"jpeg-bytes", "image/jpeg"),
            )

            self.assertEqual(len(images), 1)
            self.assertEqual(images[0].media_id, "media-ai-upload-2")
            self.assertEqual(images[0].content_type, "image/jpeg")
            self.assertEqual(images[0].payload, b"jpeg-bytes")

            with self.assertRaisesRegex(ValueError, "暂不支持图片识别"):
                provider_images_for_attachments(
                    db=db,
                    family_id=self.family.id,
                    attachments=[{"type": "image", "mediaId": "media-ai-upload-2"}],
                    provider_supports_vision=False,
                    read_media_object=lambda _asset: (b"jpeg-bytes", "image/jpeg"),
                )
