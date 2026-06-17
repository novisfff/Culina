from __future__ import annotations

import unittest
from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import FoodType, IngredientExpiryMode, InventoryStatus, MealType, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Food, Ingredient, InventoryItem, MealLog, MealLogFood, Membership, RecipeCookLog, RecipeFavorite, User


class RecipeApiTestCase(unittest.TestCase):
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
            self.family = Family(id="family-test", name="测试家庭", motto="", location="")
            self.user = User(id="user-test", username="owner", display_name="Owner", avatar_seed="", is_active=True)
            self.membership = Membership(
                id="membership-test",
                family_id=self.family.id,
                user_id=self.user.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            )
            self.tomato = Ingredient(
                id="ingredient-tomato",
                family_id=self.family.id,
                name="番茄",
                category="蔬菜",
                default_unit="个",
                unit_conversions=[],
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            self.egg = Ingredient(
                id="ingredient-egg",
                family_id=self.family.id,
                name="鸡蛋",
                category="蛋奶",
                default_unit="个",
                unit_conversions=[],
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([self.family, self.user, self.membership, self.tomato, self.egg])
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

    def create_recipe(
        self,
        *,
        auto_create_food: bool = False,
        title: str = "番茄炒蛋",
        prep_minutes: int = 15,
        difficulty: str = "easy",
        ingredient_items: list[dict] | None = None,
    ) -> dict:
        response = self.client.post(
            "/api/recipes",
            json={
                "title": title,
                "servings": 2,
                "prep_minutes": prep_minutes,
                "difficulty": difficulty,
                "ingredient_items": ingredient_items or [
                    {
                        "ingredient_id": self.tomato.id,
                        "ingredient_name": "番茄",
                        "quantity": 2,
                        "unit": "个",
                        "note": "切块",
                    },
                    {
                        "ingredient_id": self.egg.id,
                        "ingredient_name": "鸡蛋",
                        "quantity": 3,
                        "unit": "个",
                        "note": "打散",
                    },
                ],
                "steps": [
                    {
                        "title": "炒鸡蛋",
                        "text": "先炒鸡蛋到七分熟",
                        "icon": "pan",
                        "summary": "快速炒蛋",
                        "estimated_minutes": 6,
                        "tip": "火力中大",
                        "key_points": ["鸡蛋打散", "凝固即盛出"],
                    },
                    "炒番茄",
                    "合炒调味",
                ],
                "tips": "少油版",
                "scene_tags": ["工作日晚餐"],
                "media_ids": [],
                "auto_create_food": auto_create_food,
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()
