from __future__ import annotations

import json
from unittest.mock import patch

from sqlalchemy import select

from app.ai.runtime.provider import ChatProviderResult, ProviderUserInput
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.runner_support.attachments import provider_images_for_attachments
from app.ai.workflows.runner import WorkspaceGraphRunner
from app.core.enums import MediaSource
from app.models.domain import AIMessage, AITaskDraft, MediaAsset

from ._support import AIAgentInfraTestCase, FakeChatProvider


class VisionFakeChatProvider(FakeChatProvider):
    supports_vision = True


class AttachmentDraftFakeChatProvider(FakeChatProvider):
    supports_vision = True

    def __init__(self, draft_kind: str) -> None:
        super().__init__()
        self.draft_kind = draft_kind
        self.received_image_media_ids: list[str] = []
        self.called_tool_names: list[str] = []

    def generate_with_tools(
        self,
        *,
        system: str,
        user,
        tools,
        tool_handler,
        message_handler=None,
        tool_preview_handler=None,
        max_rounds: int = 8,
        trace_recorder=None,
    ) -> ChatProviderResult:
        del system, message_handler, tool_preview_handler, max_rounds, trace_recorder
        payload_text = user.text if isinstance(user, ProviderUserInput) else str(user)
        if isinstance(user, ProviderUserInput):
            self.received_image_media_ids = [image.media_id for image in user.images]
        payload = json.loads(payload_text)
        attachments = payload.get("currentAttachments") if isinstance(payload.get("currentAttachments"), list) else []
        if not attachments:
            raise AssertionError("expected currentAttachments in provider payload")
        media_id = str(attachments[0].get("mediaId") or "")
        if not media_id:
            raise AssertionError("expected current attachment mediaId")
        if self.received_image_media_ids != [media_id]:
            raise AssertionError("expected provider vision input to match current attachment mediaId")

        def call(name: str, args: dict) -> dict:
            self.called_tool_names.append(name)
            return tool_handler(name, args)

        skill_key = "food_profile" if self.draft_kind == "food" else "ingredient_profile"
        draft_tool = f"{skill_key}.create_draft"
        available_tool_names = {tool.name for tool in tools()}
        if draft_tool not in available_tool_names:
            if "skill.inject" not in available_tool_names:
                raise AssertionError(f"expected {draft_tool} or skill.inject to be available")
            call("skill.inject", {"skills": [skill_key], "reason": "根据用户当前图片创建资料草稿"})
            available_tool_names = {tool.name for tool in tools()}
        if draft_tool not in available_tool_names:
            raise AssertionError(f"expected {draft_tool} after skill injection")

        if self.draft_kind == "food":
            if "food.search" in available_tool_names:
                call("food.search", {"limit": 24})
            call(
                "food_profile.create_draft",
                {
                    "draft": {
                        "draftType": "food_profile",
                        "schemaVersion": "food_profile.v1",
                        "name": "蓝莓酸奶",
                        "type": "readyMade",
                        "category": "饮品",
                        "flavor_tags": [],
                        "scene_tags": [],
                        "suitable_meal_types": ["breakfast"],
                        "source_name": "",
                        "purchase_source": "",
                        "scene": "",
                        "notes": "用户要求按当前图片创建食物资料。",
                        "routine_note": "",
                        "price": None,
                        "rating": None,
                        "repurchase": None,
                        "expiry_date": None,
                        "stock_quantity": None,
                        "stock_unit": "",
                        "storage_location": "冷藏",
                        "favorite": False,
                        "recipe_id": None,
                        "media_ids": [media_id],
                    }
                },
            )
            raise AssertionError("draft tool should interrupt for approval")

        if "ingredient.search" in available_tool_names:
            call("ingredient.search", {"limit": 50})
        call(
            "ingredient_profile.create_draft",
            {
                "draft": {
                    "draftType": "ingredient_profile",
                    "schemaVersion": "ingredient_profile.v1",
                    "action": "create",
                    "payload": {
                        "name": "冷冻玉米粒",
                        "category": "蔬菜",
                        "default_unit": "袋",
                        "quantity_tracking_mode": "track_quantity",
                        "unit_conversions": [],
                        "default_storage": "冷冻",
                        "default_expiry_mode": "none",
                        "default_expiry_days": None,
                        "default_low_stock_threshold": None,
                        "notes": "用户要求按当前图片创建食材档案。",
                        "media_ids": [media_id],
                    },
                }
            },
        )
        raise AssertionError("draft tool should interrupt for approval")


class AIWorkspaceMultimodalAttachmentTestCase(AIAgentInfraTestCase):
    def _replace_workspace_provider(self, provider: FakeChatProvider) -> None:
        self.workspace_provider_patcher.stop()
        self.workspace_provider_patcher = patch("app.ai.workspace_service.get_chat_provider", return_value=provider)
        self.workspace_provider_patcher.start()

    def _add_unbound_upload(self, *, media_id: str, name: str, alt: str) -> None:
        with self.SessionLocal() as db:
            asset = MediaAsset(
                id=media_id,
                family_id=self.family.id,
                name=name,
                url=f"/media/family-test/{media_id}.jpg",
                file_path=f"family-test/{media_id}.jpg",
                source=MediaSource.UPLOAD,
                alt=alt,
                created_by=self.user.id,
            )
            db.add(asset)
            db.commit()

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

    def test_food_profile_draft_can_use_current_attachment_media_id(self) -> None:
        media_id = "media-ai-food-upload"
        self._add_unbound_upload(media_id=media_id, name="food.jpg", alt="蓝莓酸奶")
        provider = AttachmentDraftFakeChatProvider("food")
        self._replace_workspace_provider(provider)

        with patch(
            "app.ai.workflows.runner_support.orchestrator_context.read_media_object_for_ai",
            return_value=(b"jpeg-bytes", "image/jpeg"),
        ) as read_media_object:
            response = self.client.post(
                "/api/ai/chat",
                json={
                    "message": "用这张图创建食物资料 蓝莓酸奶",
                    "quick_task": "food_profile",
                    "attachments": [{"type": "image", "media_id": media_id, "client_attachment_id": "local-food"}],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(provider.received_image_media_ids, [media_id])
        self.assertIn("food_profile.create_draft", provider.called_tool_names)
        read_media_object.assert_called_once()
        response_draft = data["included"]["drafts"][0]
        self.assertEqual(response_draft["draft_type"], "food_profile")
        self.assertEqual(response_draft["payload"]["media_ids"], [media_id])

        with self.SessionLocal() as db:
            stored_draft = db.get(AITaskDraft, response_draft["id"])
            self.assertIsNotNone(stored_draft)
            assert stored_draft is not None
            self.assertEqual(stored_draft.payload["media_ids"], [media_id])

    def test_ingredient_profile_draft_can_use_current_attachment_media_id(self) -> None:
        media_id = "media-ai-ingredient-upload"
        self._add_unbound_upload(media_id=media_id, name="ingredient.jpg", alt="冷冻玉米粒")
        provider = AttachmentDraftFakeChatProvider("ingredient")
        self._replace_workspace_provider(provider)

        with patch(
            "app.ai.workflows.runner_support.orchestrator_context.read_media_object_for_ai",
            return_value=(b"jpeg-bytes", "image/jpeg"),
        ) as read_media_object:
            response = self.client.post(
                "/api/ai/chat",
                json={
                    "message": "用这张图创建食材档案 冷冻玉米粒",
                    "quick_task": "ingredient_profile",
                    "attachments": [{"type": "image", "media_id": media_id, "client_attachment_id": "local-ingredient"}],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(provider.received_image_media_ids, [media_id])
        self.assertIn("ingredient_profile.create_draft", provider.called_tool_names)
        read_media_object.assert_called_once()
        response_draft = data["included"]["drafts"][0]
        self.assertEqual(response_draft["draft_type"], "ingredient_profile")
        self.assertEqual(response_draft["payload"]["payload"]["media_ids"], [media_id])

        with self.SessionLocal() as db:
            stored_draft = db.get(AITaskDraft, response_draft["id"])
            self.assertIsNotNone(stored_draft)
            assert stored_draft is not None
            self.assertEqual(stored_draft.payload["payload"]["media_ids"], [media_id])
