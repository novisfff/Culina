from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy import create_engine

from app.ai.context import load_agent_context
from app.ai.provider import BaseChatProvider, ChatProviderResult, DisabledChatProvider
from app.ai.runner import CulinaAgentService
from app.ai.schemas import AgentRunRequest
from app.ai.tools import run_readonly_tools
from app.core.deps import get_current_auth
from app.core.enums import AiMode, FoodType, IngredientExpiryMode, InventoryStatus, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import AIAgentRun, Base, Family, Food, Ingredient, InventoryItem, Membership, User


class FakeChatProvider(BaseChatProvider):
    model_name = "fake-model"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        return ChatProviderResult(text="模型回答：优先处理库存并安排清淡晚餐。", status="completed", model=self.model_name)


class AIAgentInfraTestCase(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
