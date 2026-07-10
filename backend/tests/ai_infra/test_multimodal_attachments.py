from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from sqlalchemy import select

from app.ai.runtime.provider import ChatProviderResult, ProviderUserInput
from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.food import food_profile_create_draft
from app.ai.tools.catalog.ingredient import ingredient_profile_create_draft
from app.ai.tools.catalog.meal_log import meal_log_create_draft
from app.ai.tools.catalog.recipe import recipe_create_draft
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.runner_support.attachments import (
    provider_images_for_attachments,
    validate_current_attachment_ids,
)
from app.ai.workflows.runner import WorkspaceGraphRunner
from app.core.enums import Difficulty, MealType, MediaSource
from app.models.domain import AIMessage, AITaskDraft, Food, Ingredient, MealLog, MediaAsset, Recipe, RecipeIngredient, RecipeStep
from app.services.ai_operations.registry import draft_operation_registry

from ._support import AIAgentInfraTestCase, FakeChatProvider


class VisionFakeChatProvider(FakeChatProvider):
    supports_vision = True


class AttachmentDraftFakeChatProvider(FakeChatProvider):
    supports_vision = True

    def __init__(self, draft_kind: str, *, requested_media_id: str | None = None) -> None:
        super().__init__()
        self.draft_kind = draft_kind
        self.requested_media_id = requested_media_id
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

        skill_key_by_kind = {
            "food": "food_profile",
            "ingredient": "ingredient_profile",
            "recipe": "recipe_draft",
            "meal": "meal_log",
        }
        draft_tool_by_kind = {
            "food": "food_profile.create_draft",
            "ingredient": "ingredient_profile.create_draft",
            "recipe": "recipe.create_draft",
            "meal": "meal_log.create_draft",
        }
        skill_key = skill_key_by_kind[self.draft_kind]
        draft_tool = draft_tool_by_kind[self.draft_kind]
        requested_media_id = self.requested_media_id or media_id
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
                        "media_ids": [requested_media_id],
                    }
                },
            )
            raise AssertionError("draft tool should interrupt for approval")

        if self.draft_kind == "recipe":
            if "ingredient.search" in available_tool_names:
                call("ingredient.search", {"limit": 50})
            call(
                "recipe.create_draft",
                {
                    "draft": {
                        "draftType": "recipe",
                        "schemaVersion": "recipe.v1",
                        "title": "番茄小炒",
                        "servings": 2,
                        "prep_minutes": 15,
                        "difficulty": "easy",
                        "ingredient_items": [
                            {
                                "ingredient_id": "ingredient-tomato",
                                "ingredient_name": "番茄",
                                "quantity": 2,
                                "unit": "个",
                                "note": "切块",
                            }
                        ],
                        "steps": [
                            {
                                "title": "备菜",
                                "text": "番茄洗净后切成大小均匀的小块。",
                                "icon": "bowl",
                                "summary": "切番茄",
                                "estimated_minutes": 4,
                                "tip": "切块大小保持一致。",
                                "key_points": ["均匀切块"],
                            },
                            {
                                "title": "炒制",
                                "text": "热锅后放入番茄，中火翻炒至充分出汁。",
                                "icon": "pan",
                                "summary": "炒番茄",
                                "estimated_minutes": 8,
                                "tip": "保持中火。",
                                "key_points": ["炒出汁"],
                            },
                            {
                                "title": "装盘",
                                "text": "调味后关火，把番茄小炒盛入盘中。",
                                "icon": "plate",
                                "summary": "调味装盘",
                                "estimated_minutes": 3,
                                "tip": "出锅前尝味。",
                                "key_points": ["及时关火"],
                            },
                        ],
                        "tips": "趁热食用。",
                        "scene_tags": ["家常"],
                        "media_ids": [requested_media_id],
                    }
                },
            )
            raise AssertionError("draft tool should interrupt for approval")

        if self.draft_kind == "meal":
            if "food.search" in available_tool_names:
                call("food.search", {"limit": 24})
            call(
                "meal_log.create_draft",
                {
                    "draft": {
                        "draftType": "meal_log",
                        "schemaVersion": "meal_log.v1",
                        "date": "2026-07-10",
                        "mealType": "dinner",
                        "foods": [
                            {
                                "foodId": "food-tomato",
                                "name": "番茄小炒",
                                "servings": 1,
                                "note": "",
                            }
                        ],
                        "notes": "用户要求把当前图片保存为本餐证据。",
                        "mood": "满足",
                        "mediaIds": [requested_media_id],
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
                        "media_ids": [requested_media_id],
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

    def test_update_drafts_preserve_bound_media_when_media_field_is_omitted(self) -> None:
        with self.SessionLocal() as db:
            recipe = Recipe(
                id="recipe-media-preserve",
                family_id=self.family.id,
                title="番茄小炒",
                servings=2,
                prep_minutes=15,
                difficulty=Difficulty.EASY,
                tips="",
                scene_tags=["家常"],
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            meal_log = MealLog(
                id="meal-media-preserve",
                family_id=self.family.id,
                date=date.today(),
                meal_type=MealType.DINNER,
                participant_user_ids=[self.user.id],
                notes="原记录",
                mood="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([recipe, meal_log])
            db.flush()
            db.add_all(
                [
                    RecipeIngredient(
                        id="recipe-media-preserve-ingredient",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=2,
                        unit="个",
                        note="切块",
                        sort_order=0,
                    ),
                    RecipeStep(
                        id="recipe-media-preserve-step",
                        recipe_id=recipe.id,
                        title="炒制",
                        text="翻炒至出汁。",
                        icon="pan",
                        summary="炒番茄",
                        estimated_minutes=8,
                        tip="",
                        key_points=[],
                        sort_order=0,
                    ),
                    MediaAsset(
                        id="media-recipe-preserve",
                        family_id=self.family.id,
                        name="菜谱旧图",
                        url="/media/family-ai/recipe-preserve.jpg",
                        file_path="family-ai/recipe-preserve.jpg",
                        source=MediaSource.UPLOAD,
                        alt="菜谱旧图",
                        entity_type="recipe",
                        entity_id=recipe.id,
                        created_by=self.user.id,
                    ),
                    MediaAsset(
                        id="media-meal-preserve",
                        family_id=self.family.id,
                        name="餐食旧图",
                        url="/media/family-ai/meal-preserve.jpg",
                        file_path="family-ai/meal-preserve.jpg",
                        source=MediaSource.UPLOAD,
                        alt="餐食旧图",
                        entity_type="meal_log",
                        entity_id=meal_log.id,
                        created_by=self.user.id,
                    ),
                ]
            )
            db.flush()
            context = ToolContext(
                db=db,
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-media-preserve",
                run_id="run-media-preserve",
            )

            food = db.get(Food, "food-tomato")
            assert food is not None
            food_result = food_profile_create_draft(
                context,
                {
                    "draft": {
                        "action": "update",
                        "targetId": "food-tomato",
                        "baseUpdatedAt": food.updated_at.isoformat(),
                        "payload": {
                            "name": food.name,
                            "type": "selfMade",
                            "category": food.category,
                            "flavor_tags": [],
                            "scene_tags": [],
                            "suitable_meal_types": [],
                            "source_name": "",
                            "purchase_source": "",
                            "scene": food.scene,
                            "notes": "只更新备注",
                            "routine_note": "",
                            "price": None,
                            "rating": None,
                            "repurchase": None,
                            "expiry_date": None,
                            "stock_quantity": None,
                            "stock_unit": "",
                            "storage_location": "",
                            "favorite": False,
                            "recipe_id": None,
                        },
                    }
                },
            )
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            ingredient_result = ingredient_profile_create_draft(
                context,
                {
                    "draft": {
                        "action": "update",
                        "targetId": ingredient.id,
                        "baseUpdatedAt": ingredient.updated_at.isoformat(),
                        "payload": {
                            "name": ingredient.name,
                            "category": ingredient.category,
                            "default_unit": ingredient.default_unit,
                            "unit_conversions": [],
                            "quantity_tracking_mode": "track_quantity",
                            "default_storage": ingredient.default_storage,
                            "default_expiry_mode": "none",
                            "default_expiry_days": None,
                            "default_low_stock_threshold": None,
                            "notes": "只更新备注",
                        },
                    }
                },
            )
            recipe_result = recipe_create_draft(
                context,
                {
                    "draft": {
                        "action": "update",
                        "targetId": recipe.id,
                        "baseUpdatedAt": recipe.updated_at.isoformat(),
                        "payload": {
                            "title": recipe.title,
                            "servings": recipe.servings,
                            "prep_minutes": recipe.prep_minutes,
                            "difficulty": "easy",
                            "ingredient_items": [
                                {
                                    "ingredient_id": "ingredient-tomato",
                                    "ingredient_name": "番茄",
                                    "quantity": 2,
                                    "unit": "个",
                                    "note": "切块",
                                }
                            ],
                            "steps": [
                                {
                                    "title": "炒制",
                                    "text": "翻炒至充分出汁。",
                                    "icon": "pan",
                                    "summary": "炒番茄",
                                    "estimated_minutes": 8,
                                    "tip": "",
                                    "key_points": [],
                                }
                            ],
                            "tips": "只更新技巧",
                            "scene_tags": ["家常"],
                        },
                    }
                },
            )
            meal_result = meal_log_create_draft(
                context,
                {
                    "draft": {
                        "action": "update_details",
                        "targetId": meal_log.id,
                        "baseUpdatedAt": meal_log.updated_at.isoformat(),
                        "payload": {
                            "participantUserIds": [self.user.id],
                            "notes": "只更新备注",
                            "mood": "满足",
                        },
                    }
                },
            )

            self.assertEqual(food_result["draft"]["payload"]["media_ids"], ["media-food-tomato"])
            self.assertEqual(ingredient_result["draft"]["payload"]["media_ids"], ["media-ingredient-tomato"])
            self.assertEqual(recipe_result["draft"]["payload"]["media_ids"], ["media-recipe-preserve"])
            self.assertEqual(meal_result["draft"]["payload"]["mediaIds"], ["media-meal-preserve"])

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

    def test_current_attachment_validation_rejects_stale_cross_family_and_unknown_media(self) -> None:
        with self.SessionLocal() as db:
            current = MediaAsset(
                id="media-current-message",
                family_id=self.family.id,
                name="current.jpg",
                url="/media/family-ai/current.jpg",
                file_path="family-ai/current.jpg",
                source=MediaSource.UPLOAD,
                alt="当前消息图片",
                created_by=self.user.id,
            )
            stale = MediaAsset(
                id="media-previous-message",
                family_id=self.family.id,
                name="stale.jpg",
                url="/media/family-ai/stale.jpg",
                file_path="family-ai/stale.jpg",
                source=MediaSource.UPLOAD,
                alt="历史消息图片",
                created_by=self.user.id,
            )
            other_family = MediaAsset(
                id="media-other-family",
                family_id=self.other_family.id,
                name="other.jpg",
                url="/media/family-other/other.jpg",
                file_path="family-other/other.jpg",
                source=MediaSource.UPLOAD,
                alt="其他家庭图片",
                created_by=self.user.id,
            )
            db.add_all([current, stale, other_family])
            db.flush()
            trusted = [{"type": "image", "mediaId": current.id, "source": "current_message"}]

            self.assertEqual(
                validate_current_attachment_ids(
                    db,
                    family_id=self.family.id,
                    requested_media_ids=[current.id, current.id],
                    current_attachments=trusted,
                ),
                [current.id],
            )
            for invalid_id in (stale.id, other_family.id, "media-unknown"):
                with self.subTest(invalid_id=invalid_id), self.assertRaisesRegex(ValueError, "invalid_current_attachment"):
                    validate_current_attachment_ids(
                        db,
                        family_id=self.family.id,
                        requested_media_ids=[invalid_id],
                        current_attachments=trusted,
                    )

    def test_recipe_and_meal_approval_cannot_add_media_outside_verified_draft(self) -> None:
        cases = [
            (
                "food_profile",
                {"draftType": "food_profile", "media_ids": ["media-current-message"]},
                {"draftType": "food_profile", "media_ids": ["media-previous-message"]},
            ),
            (
                "ingredient_profile",
                {
                    "draftType": "ingredient_profile",
                    "action": "create",
                    "payload": {"media_ids": ["media-current-message"]},
                },
                {
                    "draftType": "ingredient_profile",
                    "action": "create",
                    "payload": {"media_ids": ["media-previous-message"]},
                },
            ),
            (
                "recipe",
                {"draftType": "recipe", "media_ids": ["media-current-message"]},
                {"draftType": "recipe", "media_ids": ["media-current-message", "media-previous-message"]},
            ),
            (
                "meal_log",
                {"draftType": "meal_log", "mediaIds": ["media-current-message"]},
                {"draftType": "meal_log", "mediaIds": ["media-previous-message"]},
            ),
        ]
        for draft_type, original, submitted in cases:
            with self.subTest(draft_type=draft_type), self.assertRaisesRegex(ValueError, "invalid_current_attachment"):
                draft_operation_registry.validate_approval_value(draft_type, original, submitted)

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

    def test_recipe_draft_can_use_current_attachment_media_id(self) -> None:
        media_id = "media-ai-recipe-upload"
        self._add_unbound_upload(media_id=media_id, name="recipe.jpg", alt="番茄小炒成品图")
        provider = AttachmentDraftFakeChatProvider("recipe")
        self._replace_workspace_provider(provider)

        with patch(
            "app.ai.workflows.runner_support.orchestrator_context.read_media_object_for_ai",
            return_value=(b"jpeg-bytes", "image/jpeg"),
        ):
            response = self.client.post(
                "/api/ai/chat",
                json={
                    "message": "按这张图整理番茄小炒菜谱，并把图片保存到菜谱",
                    "quick_task": "recipe_draft",
                    "attachments": [{"type": "image", "media_id": media_id, "client_attachment_id": "local-recipe"}],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        response_draft = response.json()["included"]["drafts"][0]
        self.assertEqual(response_draft["draft_type"], "recipe")
        self.assertEqual(response_draft["payload"]["media_ids"], [media_id])

    def test_meal_log_draft_can_use_current_attachment_media_id(self) -> None:
        media_id = "media-ai-meal-upload"
        self._add_unbound_upload(media_id=media_id, name="meal.jpg", alt="晚餐照片")
        provider = AttachmentDraftFakeChatProvider("meal")
        self._replace_workspace_provider(provider)

        with patch(
            "app.ai.workflows.runner_support.orchestrator_context.read_media_object_for_ai",
            return_value=(b"jpeg-bytes", "image/jpeg"),
        ):
            response = self.client.post(
                "/api/ai/chat",
                json={
                    "message": "记录今晚的番茄小炒，并把这张图保存为本餐照片",
                    "quick_task": "meal_log",
                    "attachments": [{"type": "image", "media_id": media_id, "client_attachment_id": "local-meal"}],
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        response_draft = response.json()["included"]["drafts"][0]
        self.assertEqual(response_draft["draft_type"], "meal_log")
        self.assertEqual(response_draft["payload"]["mediaIds"], [media_id])
