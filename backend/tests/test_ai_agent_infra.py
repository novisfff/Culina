from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine

from app.ai.context import load_agent_context
from app.ai.provider import BaseChatProvider, ChatProviderResult, DisabledChatProvider
from app.ai.recipe_drafts import build_recipe_image_render_payload
from app.ai.runner import CulinaAgentService
from app.ai.schemas import AgentRunRequest
from app.ai.tools import run_readonly_tools
from app.core.deps import get_current_auth
from app.core.enums import AiMode, FoodType, ImageGenerationMode, IngredientExpiryMode, InventoryStatus, MediaEntityType, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import AIAgentRun, Base, Family, Food, Ingredient, InventoryItem, Membership, User
from app.services.image_generation import ImageGenerationRequest, build_ai_image_prompt


class FakeChatProvider(BaseChatProvider):
    model_name = "fake-model"

    def __init__(self, text: str | None = None) -> None:
        self.text = text or "模型回答：优先处理库存并安排清淡晚餐。"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        return ChatProviderResult(text=self.text, status="completed", model=self.model_name)


class AIAgentInfraTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.provider_patcher = patch("app.ai.runner.get_chat_provider", return_value=DisabledChatProvider(model_name="test-model"))
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

    def test_recipe_draft_api_returns_failed_and_records_run_when_provider_disabled(self) -> None:
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
        self.assertIsNone(data["image_render_payload"])
        self.assertEqual(data["draft"]["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
        self.assertGreaterEqual(len(data["draft"]["steps"]), 4)
        for step in data["draft"]["steps"]:
            self.assertTrue(step["title"])
            self.assertTrue(step["text"])
            self.assertTrue(step["summary"])
            self.assertIsNotNone(step["estimated_minutes"])
            self.assertTrue(step["tip"])
            self.assertTrue(step["key_points"])
        with self.SessionLocal() as db:
            run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == data["agent_run_id"]))
            self.assertIsNotNone(run)
            assert run is not None
            self.assertEqual(run.feature_key, "aiRecipeDraft")
            self.assertEqual(run.status, "failed")

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
                {"title": "备菜", "text": "番茄洗净切块，鸡蛋或蛋液备好。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "番茄切均匀。", "key_points": ["切块一致"]},
                {"title": "炖煮", "text": "锅中少油炒出番茄汁，加少量水炖煮。", "icon": "pan", "summary": "炒出汤汁", "estimated_minutes": 8, "tip": "保持中火。", "key_points": ["中火"]},
                {"title": "收尾", "text": "倒入蛋液或调味后煮熟，确认熟透后出锅。", "icon": "plate", "summary": "熟透出锅", "estimated_minutes": 5, "tip": "出锅前尝味。", "key_points": ["确认熟透"]}
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
        self.assertGreaterEqual(len(draft["steps"]), 4)

    def test_recipe_draft_runner_falls_back_on_invalid_json(self) -> None:
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
        self.assertEqual(result.data["recipeDraft"]["ingredient_items"][0]["ingredient_id"], "ingredient-tomato")
        self.assertEqual(result.error, "model returned invalid recipe draft JSON")
        self.assertIsNone(result.data["imageRenderPayload"])

    def test_recipe_draft_runner_enhances_low_quality_steps_and_ingredients(self) -> None:
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

        draft = result.data["recipeDraft"]
        self.assertEqual(result.status, "completed")
        self.assertGreaterEqual(len(draft["steps"]), 4)
        self.assertTrue(any("分钟" in step["text"] for step in draft["steps"]))
        self.assertTrue(any("火" in step["text"] or "中火" in step["text"] for step in draft["steps"]))
        self.assertTrue(any(step["summary"] for step in draft["steps"]))
        self.assertTrue(all(item["quantity"] > 0 for item in draft["ingredient_items"]))
        self.assertTrue(all(item["note"] for item in draft["ingredient_items"]))

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
                {"title": "处理", "text": "番茄切块，鸡蛋打散。", "icon": "tomato", "summary": "处理", "estimated_minutes": 4, "tip": "", "key_points": ["切块"]},
                {"title": "煮汤", "text": "加水煮开后下番茄。", "icon": "pan", "summary": "煮汤", "estimated_minutes": 5, "tip": "", "key_points": ["煮开"]},
                {"title": "收尾", "text": "加蛋液后出锅。", "icon": "plate", "summary": "收尾", "estimated_minutes": 3, "tip": "", "key_points": ["出锅"]},
                {"title": "完成", "text": "装盘即可。", "icon": "plate", "summary": "完成", "estimated_minutes": 1, "tip": "", "key_points": ["装盘"]}
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


if __name__ == "__main__":
    unittest.main()
