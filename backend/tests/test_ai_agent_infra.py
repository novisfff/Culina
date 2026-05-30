from __future__ import annotations

import base64
import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine

from app.ai.kitchen.context import load_agent_context
from app.ai.kitchen.recipe_drafts import build_recipe_image_render_payload
from app.ai.kitchen.service import CulinaAgentService
from app.ai.kitchen.tools import run_readonly_tools
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult, DisabledChatProvider
from app.ai.runtime.schemas import AgentRunRequest
from app.core.deps import get_current_auth
from app.core.enums import AiMode, FoodType, ImageGenerationMode, IngredientExpiryMode, InventoryStatus, MediaEntityType, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIMessage,
    AIOperation,
    AIRunEvent,
    AITaskDraft,
    Base,
    Family,
    Food,
    Ingredient,
    InventoryItem,
    Membership,
    Recipe,
    User,
)
from app.ai.images.generation import ImageGenerationRequest, ImageProviderConfig, OpenAIImageGenerationProvider, build_ai_image_prompt, _build_provider_config


class FakeChatProvider(BaseChatProvider):
    model_name = "fake-model"

    def __init__(self, text: str | None = None) -> None:
        self.text = text or "模型回答：优先处理库存并安排清淡晚餐。"

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        return ChatProviderResult(text=self.text, status="completed", model=self.model_name)


class AIAgentInfraTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.provider_patcher = patch("app.ai.runtime.runner.get_chat_provider", return_value=DisabledChatProvider(model_name="test-model"))
        self.provider_patcher.start()
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
            self.family = Family(id="family-ai", name="AI 测试家庭", motto="", location="")
            self.other_family = Family(id="family-other", name="其他家庭", motto="", location="")
            self.user = User(id="user-ai", username="ai-owner", display_name="AI Owner", avatar_seed="", is_active=True)
            self.membership = Membership(
                id="membership-ai",
                family_id=self.family.id,
                user_id=self.user.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            )
            tomato = Ingredient(
                id="ingredient-tomato",
                family_id=self.family.id,
                name="番茄",
                category="蔬菜",
                default_unit="个",
                unit_conversions=[],
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
            )
            secret = Ingredient(
                id="ingredient-secret",
                family_id=self.other_family.id,
                name="其他家庭牛排",
                category="肉类",
                default_unit="块",
                unit_conversions=[],
                default_storage="冷冻",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
            )
            inventory = InventoryItem(
                id="inventory-tomato",
                family_id=self.family.id,
                ingredient_id=tomato.id,
                quantity=Decimal("3"),
                consumed_quantity=Decimal("0"),
                unit="个",
                status=InventoryStatus.FRESH,
                purchase_date=date.today(),
                storage_location="冷藏",
                low_stock_threshold=Decimal("0"),
            )
            other_inventory = InventoryItem(
                id="inventory-secret",
                family_id=self.other_family.id,
                ingredient_id=secret.id,
                quantity=Decimal("2"),
                consumed_quantity=Decimal("0"),
                unit="块",
                status=InventoryStatus.FRESH,
                purchase_date=date.today(),
                storage_location="冷冻",
                low_stock_threshold=Decimal("0"),
            )
            food = Food(
                id="food-tomato",
                family_id=self.family.id,
                name="番茄小炒",
                type=FoodType.SELF_MADE,
                category="家常菜",
                flavor_tags=[],
                scene="晚餐",
                notes="",
            )
            db.add_all(
                [
                    self.family,
                    self.other_family,
                    self.user,
                    self.membership,
                    tomato,
                    secret,
                    inventory,
                    other_inventory,
                    food,
                ]
            )
            db.commit()

        def override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        def override_auth():
            with self.SessionLocal() as db:
                user = db.get(User, self.user.id)
                membership = db.get(Membership, self.membership.id)
                assert user is not None and membership is not None
                return user, membership

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_auth] = override_auth
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.provider_patcher.stop()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_disabled_provider_returns_fallback_without_network(self) -> None:
        result = DisabledChatProvider(model_name="test-model").generate(system="s", user="u")
        self.assertIsNone(result.text)
        self.assertEqual(result.status, "fallback")
        self.assertEqual(result.model, "test-model")

    def test_context_tools_are_family_scoped(self) -> None:
        with self.SessionLocal() as db:
            context = load_agent_context(
                db,
                family_id=self.family.id,
                mode=AiMode.INVENTORY_QA,
                subject={},
            )
            tool_calls = run_readonly_tools(
                context,
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    mode=AiMode.INVENTORY_QA,
                    prompt="库存怎么样",
                ),
            )
        output_text = str([item.to_record() for item in tool_calls])
        self.assertIn("番茄", output_text)
        self.assertNotIn("其他家庭牛排", output_text)

    def test_runner_records_completed_graph_run_with_tools(self) -> None:
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=FakeChatProvider()).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    mode=AiMode.INVENTORY_QA,
                    feature_key="inventoryQa",
                    prompt="库存怎么样",
                )
            )
            db.commit()
            run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == result.run_id))
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.status, "completed")
            self.assertGreaterEqual(len(run.tool_calls), 1)
            self.assertEqual(result.conversation["response"], result.text)

    def test_ai_query_api_keeps_existing_response_shape_for_modes(self) -> None:
        payloads = [
            {"mode": "foodQa", "prompt": "这道菜怎么做", "food_id": "food-tomato"},
            {"mode": "inventoryQa", "prompt": "库存怎么样"},
            {"mode": "recommendation", "prompt": "今晚吃什么"},
            {"mode": "recipeDraft", "prompt": "清淡一点", "ingredient_ids": ["ingredient-tomato"]},
        ]
        for payload in payloads:
            with self.subTest(mode=payload["mode"]):
                response = self.client.post("/api/ai/query", json=payload)
                self.assertEqual(response.status_code, 200, response.text)
                data = response.json()
                self.assertIn("conversation", data)
                self.assertIn("response", data["conversation"])
                if payload["mode"] == "recommendation":
                    self.assertIsNotNone(data["recommendation"])

    def test_ai_workspace_chat_returns_today_recommendation_card_and_persists_lifecycle(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "今日吃什么？", "quick_task": "today_recommendation"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertIn("conversation_id", data)
        self.assertEqual(data["run"]["agent_key"], "today_recommendation_agent")
        self.assertEqual(data["run"]["intent"], "today_recommendation")
        self.assertGreaterEqual(len(data["events"]), 3)
        card_parts = [part for part in data["message"]["parts"] if part["type"] == "result_card"]
        self.assertEqual(card_parts[0]["card"]["type"], "today_recommendation")
        recommendations = card_parts[0]["card"]["data"]["recommendations"]
        self.assertGreaterEqual(len(recommendations), 1)
        self.assertIn("reason", recommendations[0])
        self.assertIn("evidence", recommendations[0])

        with self.SessionLocal() as db:
            messages = list(db.scalars(select(AIMessage).where(AIMessage.conversation_id == data["conversation_id"])))
            events = list(db.scalars(select(AIRunEvent).where(AIRunEvent.run_id == data["run"]["id"])))
            run = db.get(AIAgentRun, data["run"]["id"])
            self.assertEqual(len(messages), 2)
            self.assertGreaterEqual(len(events), 3)
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.intent, "today_recommendation")
            self.assertEqual(run.context_summary["inventoryItemCount"], 1)

    def test_ai_workspace_messages_are_family_scoped(self) -> None:
        create_response = self.client.post("/api/ai/chat", json={"message": "随便聊聊"})
        self.assertEqual(create_response.status_code, 200, create_response.text)
        conversation_id = create_response.json()["conversation_id"]

        response = self.client.get(f"/api/ai/conversations/{conversation_id}/messages")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 2)

    def test_ai_workspace_recipe_draft_approval_creates_recipe_after_decision(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄鸡蛋面",
              "servings": 2,
              "prep_minutes": 20,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                {"ingredient_id": null, "ingredient_name": "鸡蛋", "quantity": 2, "unit": "个", "note": "打散"},
                {"ingredient_id": null, "ingredient_name": "面条", "quantity": 200, "unit": "克", "note": "提前备好"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成 2 厘米块，鸡蛋打到没有透明蛋清。面条提前称好，葱花和调味料放在手边，方便后续连续操作。", "icon": "bowl", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["番茄切块", "鸡蛋打散"]},
                {"title": "炒汤底", "text": "锅中放少量油，中火加热 30 秒后倒入蛋液炒到刚凝固盛出。继续用中火炒番茄 3 分钟，看到出汁变软后加入热水煮沸。", "icon": "pan", "summary": "炒出汤底", "estimated_minutes": 8, "tip": "番茄要炒出汁。", "key_points": ["中火", "炒出汁"]},
                {"title": "煮面收尾", "text": "汤汁沸腾后下面条煮 5 分钟，保持微沸并不时搅动防止粘连。面条变软熟透后倒回鸡蛋，加盐调味，确认汤汁冒泡后出锅。", "icon": "plate", "summary": "煮熟装盘", "estimated_minutes": 7, "tip": "出锅前尝味。", "key_points": ["煮熟", "尝味"]}
              ],
              "tips": "少油少盐，适合晚餐。",
              "scene_tags": ["家常菜", "快手菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄鸡蛋面的菜谱，2 人份。", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["run"]["agent_key"], "recipe_draft_agent")
        self.assertEqual(data["run"]["intent"], "recipe_draft")
        self.assertEqual(len(data["included"]["drafts"]), 1)
        self.assertEqual(len(data["included"]["approvals"]), 1)
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]
        self.assertEqual(approval["status"], "pending")
        self.assertEqual(draft["status"], "pending")

        with self.SessionLocal() as db:
            self.assertEqual(db.query(Recipe).count(), 0)
            self.assertEqual(db.query(AITaskDraft).count(), 1)
            self.assertEqual(db.query(AIApprovalRequest).count(), 1)

        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        self.assertEqual(pending_response.json()[0]["id"], approval["id"])

        recipe_payload = draft["payload"]
        recipe_payload["title"] = "番茄鸡蛋面（确认版）"
        decision_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": draft["version"],
                "values": {"recipe": recipe_payload},
            },
        )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["approval"]["status"], "approved")
        self.assertEqual(decision_data["draft"]["status"], "confirmed")
        self.assertEqual(decision_data["operation"]["status"], "succeeded")
        self.assertEqual(decision_data["business_entity"]["title"], "番茄鸡蛋面（确认版）")

        repeat_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": draft["version"],
                "values": {"recipe": recipe_payload},
            },
        )
        self.assertEqual(repeat_response.status_code, 409, repeat_response.text)
        with self.SessionLocal() as db:
            self.assertEqual(db.query(Recipe).count(), 1)
            self.assertEqual(db.query(AIOperation).count(), 1)

    def test_ai_workspace_approval_rejects_stale_draft_version(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄小炒",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                {"title": "翻炒", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入少量水，保持冒泡继续煮 5 分钟。", "icon": "pan", "summary": "炒软", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["中火"]},
                {"title": "收尾", "text": "汤汁略微浓稠后加盐调味，再继续翻炒 1 分钟。确认番茄软烂且汤汁冒泡后关火装盘。", "icon": "plate", "summary": "装盘", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
              ],
              "tips": "清淡少油。",
              "scene_tags": ["家常菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄小炒的菜谱", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]
        stale_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "approved",
                "draft_version": draft["version"] + 1,
                "values": {"recipe": draft["payload"]},
            },
        )
        self.assertEqual(stale_response.status_code, 409, stale_response.text)
        self.assertIn("草稿已更新", stale_response.json()["detail"])

    def test_ai_workspace_operation_failure_returns_recoverable_state(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄汤",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                {"title": "煮汤", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入热水，保持冒泡继续煮 8 分钟。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["出汁"]},
                {"title": "调味", "text": "汤汁沸腾且略微浓稠后加盐调味，再继续煮 1 分钟。确认番茄软烂且汤汁冒泡后关火装碗。", "icon": "plate", "summary": "装碗", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
              ],
              "tips": "清淡少油。",
              "scene_tags": ["家常菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄汤的菜谱", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]

        with patch("app.ai.workspace_service.ensure_food_for_recipe", side_effect=RuntimeError("sync failed")):
            decision_response = self.client.post(
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": draft["version"],
                    "values": {"recipe": draft["payload"]},
                },
            )
        self.assertEqual(decision_response.status_code, 200, decision_response.text)
        decision_data = decision_response.json()
        self.assertEqual(decision_data["approval"]["status"], "pending")
        self.assertEqual(decision_data["approval"]["approval_type"], "recipe.create.retry")
        self.assertEqual(decision_data["draft"]["status"], "pending_retry")
        self.assertEqual(decision_data["operation"]["status"], "failed")
        self.assertIn("sync failed", decision_data["operation"]["error_message"])
        pending_response = self.client.get(f"/api/ai/conversations/{data['conversation_id']}/approvals/pending")
        self.assertEqual(pending_response.status_code, 200, pending_response.text)
        self.assertEqual(pending_response.json()[0]["id"], decision_data["approval"]["id"])
        with self.SessionLocal() as db:
            self.assertEqual(db.query(Recipe).count(), 0)
            self.assertEqual(db.query(AIOperation).count(), 1)
            self.assertEqual(db.query(AIApprovalRequest).count(), 2)

    def test_ai_workspace_reject_does_not_validate_broken_recipe_payload(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄汤",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"}],
              "steps": [
                {"title": "备菜", "text": "番茄洗净后处理 5 分钟，切成均匀小块并沥干到表面没有透明水膜。调味料提前放好，这样下锅后可以连续操作，避免中途停顿导致受热不均。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "切块一致。", "key_points": ["切块"]},
                {"title": "煮汤", "text": "锅中少油中火加热 30 秒，倒入番茄翻炒 3 分钟。看到番茄变软出汁后加入热水，保持冒泡继续煮 8 分钟。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["出汁"]},
                {"title": "调味", "text": "汤汁沸腾且略微浓稠后加盐调味，再继续煮 1 分钟。确认番茄软烂且汤汁冒泡后关火装碗。", "icon": "plate", "summary": "装碗", "estimated_minutes": 5, "tip": "先少量盐。", "key_points": ["尝味"]}
              ],
              "tips": "清淡少油。",
              "scene_tags": ["家常菜"]
            }
            """
        )
        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "帮我生成一份番茄汤的菜谱", "quick_task": "recipe_draft"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        approval = data["included"]["approvals"][0]
        draft = data["included"]["drafts"][0]
        reject_response = self.client.post(
            f"/api/ai/conversations/{data['conversation_id']}/approvals/{approval['id']}/decision",
            json={
                "decision": "rejected",
                "draft_version": draft["version"],
                "values": {"recipe": {"title": ""}},
            },
        )
        self.assertEqual(reject_response.status_code, 200, reject_response.text)
        reject_data = reject_response.json()
        self.assertEqual(reject_data["approval"]["status"], "rejected")
        self.assertEqual(reject_data["draft"]["status"], "rejected")

    def test_recipe_draft_api_returns_failed_without_fallback_draft_when_provider_disabled(self) -> None:
        response = self.client.post(
            "/api/ai/recipes/draft",
            json={
                "title": "番茄快手菜",
                "prompt": "清淡一点",
                "ingredient_ids": ["ingredient-tomato"],
                "extra_ingredients": ["葱花"],
                "generate_image": True,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "failed")
        self.assertIsNone(data["draft"])
        self.assertIsNone(data["image_render_payload"])
        with self.SessionLocal() as db:
            run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == data["agent_run_id"]))
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.feature_key, "aiRecipeDraft")
            self.assertEqual(run.status, "failed")
            self.assertEqual(run.input["context"]["inventoryItemCount"], 0)
            self.assertEqual(run.input["context"]["mealLogCount"], 0)

    def test_recipe_draft_api_requires_minimum_input(self) -> None:
        response = self.client.post("/api/ai/recipes/draft", json={})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("菜名", response.json()["detail"])

    def test_recipe_draft_runner_preserves_family_scoped_ingredients_from_valid_json(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄炖蛋",
              "servings": 2,
              "prep_minutes": 18,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "错名", "quantity": 2, "unit": "斤", "note": "切块"},
                {"ingredient_id": "ingredient-secret", "ingredient_name": "其他家庭牛排", "quantity": 1, "unit": "块", "note": ""}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切成 2 厘米块，鸡蛋或蛋液提前备好。保持食材大小接近，后面中火炖煮 8 分钟时更容易均匀熟透。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "炖煮", "text": "锅中少油，中火炒番茄 3 分钟到出汁变软。加入少量水后继续炖煮 5 分钟，看到汤汁冒泡并略微浓稠。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["中火"]},
                {"title": "收尾", "text": "倒入蛋液后保持小火 2 分钟，让蛋液完全凝固。确认没有透明蛋液、汤汁略收后再调味出锅。", "icon": "plate", "summary": "熟透出锅", "estimated_minutes": 5, "tip": "出锅前尝味。", "key_points": ["确认熟透"]}
              ],
              "tips": "少油少盐。",
              "scene_tags": ["晚餐", "清淡"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=provider).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    feature_key="aiRecipeDraft",
                    prompt="清淡",
                    subject={"ingredientIds": ["ingredient-tomato", "ingredient-secret"]},
                    response_format="recipe_draft",
                    persist_conversation=False,
                )
            )
        draft = result.data["recipeDraft"]
        self.assertEqual(result.status, "completed")
        self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
        self.assertEqual(draft["ingredient_items"][0]["ingredient_name"], "番茄")
        self.assertNotIn("ingredient-secret", [item["ingredient_id"] for item in draft["ingredient_items"]])
        self.assertIsInstance(draft["steps"][0], dict)

    def test_recipe_draft_runner_parses_fenced_json_response(self) -> None:
        provider = FakeChatProvider(
            """
            ```json
            {
              "title": "番茄炒蛋",
              "servings": 2,
              "prep_minutes": 15,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "洗净切块"},
                {"ingredient_id": null, "ingredient_name": "鸡蛋", "quantity": 3, "unit": "个", "note": "打散备用"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切块，鸡蛋打散备用。保持食材大小接近，方便后面均匀受热。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "炒蛋", "text": "热锅少油，中火倒入蛋液炒到刚凝固。看到表面还有少量嫩液时盛出备用。", "icon": "pan", "summary": "先炒鸡蛋", "estimated_minutes": 4, "tip": "不要久炒。", "key_points": ["中火", "刚凝固"]},
                {"title": "炒番茄", "text": "锅中补少量油，中火下番茄炒 3 分钟。看到番茄出汁变软后再调味。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 5, "tip": "番茄要炒出汁。", "key_points": ["炒出汁"]},
                {"title": "收尾", "text": "鸡蛋回锅后加盐翻匀 1 分钟。确认鸡蛋熟透、汤汁略收后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 2, "tip": "出锅前尝味。", "key_points": ["熟透", "尝味"]}
              ],
              "tips": "中火快炒，保留鸡蛋嫩度。",
              "scene_tags": ["家常菜", "快手菜"]
            }
            ```
            """
        )
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=provider).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    feature_key="aiRecipeDraft",
                    prompt="番茄炒蛋",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                    response_format="recipe_draft",
                    persist_conversation=False,
                )
            )

        draft = result.data["recipeDraft"]
        self.assertEqual(result.status, "completed")
        self.assertEqual(draft["title"], "番茄炒蛋")
        self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")

    def test_recipe_draft_runner_splits_merged_scene_tags(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄快手菜",
              "servings": 2,
              "prep_minutes": 15,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "洗净切块"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切成 2 厘米块，蒜末提前备好。食材大小保持接近，后面中火快炒时更容易均匀熟透。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "翻炒", "text": "热锅少油，中火下番茄翻炒 3 到 4 分钟。看到番茄边缘变软并出汁后再调味。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 6, "tip": "保持中火。", "key_points": ["中火", "出汁"]},
                {"title": "收尾", "text": "加盐后继续翻炒 1 分钟，让味道进入汤汁。确认番茄软而不碎、汤汁略收后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 3, "tip": "出锅前尝味。", "key_points": ["尝味", "装盘"]}
              ],
              "tips": "适合临时加一道清爽小菜。",
              "scene_tags": ["家常菜、快手菜", "晚餐/午餐", "快手菜"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=provider).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    feature_key="aiRecipeDraft",
                    prompt="快手",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                    response_format="recipe_draft",
                    persist_conversation=False,
                )
            )

        draft = result.data["recipeDraft"]
        self.assertEqual(result.status, "completed")
        self.assertEqual(draft["scene_tags"], ["家常菜", "快手菜", "晚餐", "午餐"])

    def test_recipe_draft_runner_parses_json_surrounded_by_text(self) -> None:
        provider = FakeChatProvider(
            """
            下面是生成结果：
            {
              "title": "清炒番茄",
              "servings": 2,
              "prep_minutes": 12,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                {"ingredient_id": null, "ingredient_name": "蒜", "quantity": 2, "unit": "瓣", "note": "拍碎"}
              ],
              "steps": [
                {"title": "备菜", "text": "番茄洗净切块，蒜瓣拍碎备用。切块尽量均匀，方便中火快炒。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "爆香", "text": "锅热后加少量油，小火下蒜炒 30 秒。闻到蒜香但没有焦色时加入番茄。", "icon": "pan", "summary": "炒香蒜", "estimated_minutes": 2, "tip": "蒜不要炒焦。", "key_points": ["小火"]},
                {"title": "翻炒", "text": "转中火翻炒番茄 3 到 4 分钟。看到番茄边缘变软并出汁后再调味。", "icon": "pan", "summary": "炒软出汁", "estimated_minutes": 4, "tip": "中火更稳。", "key_points": ["出汁"]},
                {"title": "收尾", "text": "加盐后翻匀 1 分钟，让味道进入汤汁。确认番茄软而不碎后装盘。", "icon": "plate", "summary": "调味装盘", "estimated_minutes": 1, "tip": "最后调味更容易控制咸淡。", "key_points": ["尝味", "装盘"]}
              ],
              "tips": "适合搭配米饭或面条。",
              "scene_tags": ["家常菜"]
            }
            以上 JSON 可直接使用。
            """
        )
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=provider).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    feature_key="aiRecipeDraft",
                    prompt="清淡",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                    response_format="recipe_draft",
                    persist_conversation=False,
                )
            )

        draft = result.data["recipeDraft"]
        self.assertEqual(result.status, "completed")
        self.assertEqual(draft["title"], "清炒番茄")
        self.assertGreaterEqual(len(draft["steps"]), 3)

    def test_recipe_draft_runner_fails_without_fallback_on_invalid_json(self) -> None:
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=FakeChatProvider("不是 JSON")).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    feature_key="aiRecipeDraft",
                    prompt="清淡",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                    response_format="recipe_draft",
                    persist_conversation=False,
                )
            )
        self.assertEqual(result.status, "failed")
        self.assertIsNone(result.data["recipeDraft"])
        self.assertEqual(result.error, "model returned invalid recipe draft JSON")
        self.assertIsNone(result.data["imageRenderPayload"])

    def test_recipe_draft_runner_rejects_low_quality_steps_without_local_fallback(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄炒蛋",
              "servings": 2,
              "prep_minutes": 16,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "个", "note": ""},
                {"ingredient_id": null, "ingredient_name": "鸡蛋", "quantity": 1, "unit": "个", "note": ""}
              ],
              "steps": [
                {"title": "备菜", "text": "处理食材", "icon": "pan", "summary": "", "estimated_minutes": 2, "tip": "", "key_points": []},
                {"title": "炒熟", "text": "翻炒均匀", "icon": "pan", "summary": "", "estimated_minutes": 3, "tip": "", "key_points": []}
              ],
              "tips": "",
              "scene_tags": ["晚餐"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=provider).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    feature_key="aiRecipeDraft",
                    prompt="更细一点",
                    subject={"ingredientIds": ["ingredient-tomato"]},
                    response_format="recipe_draft",
                    persist_conversation=False,
                )
            )

        self.assertEqual(result.status, "failed")
        self.assertIsNone(result.data["recipeDraft"])
        self.assertEqual(result.error, "model returned invalid recipe draft JSON")

    def test_recipe_draft_runner_keeps_selected_ingredient_ids_and_default_units(self) -> None:
        provider = FakeChatProvider(
            """
            {
              "title": "番茄鸡蛋汤",
              "servings": 3,
              "prep_minutes": 12,
              "difficulty": "easy",
              "ingredient_items": [
                {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 1, "unit": "斤", "note": "切块"},
                {"ingredient_id": "ingredient-secret", "ingredient_name": "其他家庭牛排", "quantity": 1, "unit": "块", "note": ""}
              ],
              "steps": [
                {"title": "处理", "text": "番茄切成小块，鸡蛋打散后加 1 勺清水。食材提前备好，后面中火煮 5 分钟时能更快熟透。", "icon": "tomato", "summary": "处理", "estimated_minutes": 4, "tip": "", "key_points": ["切块"]},
                {"title": "煮汤", "text": "锅中加水煮到沸腾后下番茄，中火煮 5 分钟。看到番茄变软出汁、汤色微红后再倒蛋液。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 5, "tip": "", "key_points": ["煮开"]},
                {"title": "收尾", "text": "沿锅边倒入蛋液，小火保持 2 分钟让蛋花凝固。确认蛋液熟透、汤面重新冒泡后加盐调味出锅。", "icon": "plate", "summary": "收尾", "estimated_minutes": 3, "tip": "", "key_points": ["出锅"]}
              ],
              "tips": "清淡。",
              "scene_tags": ["午餐"]
            }
            """
        )
        with self.SessionLocal() as db:
            result = CulinaAgentService(db, provider=provider).run(
                AgentRunRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    feature_key="aiRecipeDraft",
                    prompt="清淡一点",
                    subject={"ingredientIds": ["ingredient-tomato", "ingredient-secret"]},
                    response_format="recipe_draft",
                    persist_conversation=False,
                )
            )

        draft = result.data["recipeDraft"]
        self.assertEqual(draft["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
        self.assertEqual(draft["ingredient_items"][0]["unit"], "个")
        self.assertNotIn("ingredient-secret", [item["ingredient_id"] for item in draft["ingredient_items"]])

    def test_recipe_image_prompts_do_not_force_banner_composition(self) -> None:
        draft = {
            "title": "番茄炒蛋",
            "tips": "少油少盐。",
            "scene_tags": ["晚餐", "家常"],
            "ingredient_items": [{"ingredient_name": "番茄"}, {"ingredient_name": "鸡蛋"}],
        }
        payload = build_recipe_image_render_payload(draft)
        prompt = build_ai_image_prompt(
            ImageGenerationRequest(
                entity_type=MediaEntityType.RECIPE,
                mode=ImageGenerationMode.TEXT,
                title=payload["title"],
                category=payload["category"],
                notes=payload["notes"],
                tags=payload["tags"],
                scene=payload["scene"],
                ingredient_names=payload["ingredient_names"],
                size=payload["size"],
            )
        )

        forbidden_terms = ["banner", "Banner", "横幅", "横向", "页面顶部", "顶部主图"]
        for term in forbidden_terms:
            with self.subTest(term=term):
                self.assertNotIn(term, payload["notes"])
                self.assertNotIn(term, prompt)

    def test_reference_image_prompt_prioritizes_unified_style_over_copying_source(self) -> None:
        prompt = build_ai_image_prompt(
            ImageGenerationRequest(
                entity_type=MediaEntityType.INGREDIENT,
                mode=ImageGenerationMode.REFERENCE,
                title="番茄",
                category="蔬菜",
                notes="新鲜红番茄",
                reference_image_bytes=b"fake",
                reference_filename="tomato.jpg",
            )
        )

        self.assertIn("参考图只用于识别主体", prompt)
        self.assertIn("重新在 Culina 统一摄影棚里拍了一张标准主图", prompt)
        self.assertIn("与纯文字生成模式一致", prompt)
        self.assertIn("不要复制原图的拍摄角度", prompt)
        self.assertIn("参考图仅作为主体识别补充", prompt)
        self.assertIn("统一为约 4:3 卡片比例", prompt)

    def test_image_generation_normalizes_all_modes_to_standard_card_size(self) -> None:
        calls: list[dict] = []

        class FakeHttpxClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback) -> None:
                return None

            def post(self, url: str, **kwargs):
                calls.append({"url": url, **kwargs})
                return httpx.Response(
                    200,
                    json={"data": [{"b64_json": base64.b64encode(b"fake-image").decode("ascii")}]},
                )

        provider = OpenAIImageGenerationProvider(
            ImageProviderConfig(
                provider="openai",
                api_base="https://example.test/v1",
                api_key="test-key",
                model="gpt-image-2",
            )
        )
        with patch("app.ai.images.generation.httpx.Client", FakeHttpxClient):
            provider.generate_from_text(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.RECIPE,
                    mode=ImageGenerationMode.TEXT,
                    title="番茄炒蛋",
                    size="1792*1008",
                )
            )
            provider.generate_from_reference(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.INGREDIENT,
                    mode=ImageGenerationMode.REFERENCE,
                    title="番茄",
                    size="960*1280",
                    reference_image_bytes=b"fake",
                    reference_filename="tomato.jpg",
                )
            )

        self.assertEqual(calls[0]["json"]["size"], "1536x1024")
        self.assertEqual(calls[1]["data"]["size"], "1536x1024")

    def test_openai_image_provider_uses_configured_endpoint_and_key(self) -> None:
        calls: list[dict] = []

        class FakeHttpxClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback) -> None:
                return None

            def post(self, url: str, **kwargs):
                calls.append({"url": url, **kwargs})
                return httpx.Response(
                    200,
                    json={"data": [{"b64_json": base64.b64encode(b"fake-image").decode("ascii")}]},
                )

        provider = OpenAIImageGenerationProvider(
            ImageProviderConfig(
                provider="openai",
                api_base="https://example.test/v1",
                api_key="test-key",
                model="gpt-image-2",
            )
        )
        with patch("app.ai.images.generation.httpx.Client", FakeHttpxClient):
            result = provider.generate_from_text(
                ImageGenerationRequest(
                    entity_type=MediaEntityType.FOOD,
                    mode=ImageGenerationMode.TEXT,
                    title="番茄炒蛋",
                    size="1664*1040",
                )
            )

        self.assertEqual(result.binary_content, b"fake-image")
        self.assertEqual(result.file_extension, ".png")
        self.assertEqual(result.mime_type, "image/png")
        self.assertEqual(calls[0]["url"], "https://example.test/v1/images/generations")
        self.assertEqual(calls[0]["headers"]["Authorization"], "Bearer test-key")
        self.assertEqual(calls[0]["json"]["model"], "gpt-image-2")
        self.assertEqual(calls[0]["json"]["size"], "1536x1024")
        self.assertEqual(calls[0]["json"]["output_format"], "png")

    def test_openai_image_provider_config_defaults_to_openai_base(self) -> None:
        class FakeSettings:
            ai_image_reference_provider = "openai"
            ai_image_reference_api_base = ""
            ai_image_reference_api_key = "reference-key"
            ai_image_reference_model = ""
            ai_image_text_provider = "openai"
            ai_image_text_api_base = ""
            ai_image_text_api_key = "text-key"
            ai_image_text_model = ""

        with patch("app.ai.images.generation.get_settings", return_value=FakeSettings()):
            text_config = _build_provider_config(ImageGenerationMode.TEXT)
            reference_config = _build_provider_config(ImageGenerationMode.REFERENCE)

        self.assertEqual(text_config.api_base, "https://api.openai.com/v1")
        self.assertEqual(text_config.model, "gpt-image-2")
        self.assertEqual(reference_config.api_base, "https://api.openai.com/v1")
        self.assertEqual(reference_config.model, "gpt-image-2")


if __name__ == "__main__":
    unittest.main()
