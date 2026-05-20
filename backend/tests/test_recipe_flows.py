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
from app.models.domain import Base, Family, Food, Ingredient, InventoryItem, Membership, RecipeCookLog, RecipeFavorite, User


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

    def test_recipe_crud_favorite_plan_and_scene_flow(self) -> None:
        recipe = self.create_recipe(auto_create_food=True)
        recipe_id = recipe["id"]

        list_response = self.client.get("/api/recipes")
        self.assertEqual(list_response.status_code, 200, list_response.text)
        self.assertEqual(list_response.json()[0]["title"], "番茄炒蛋")
        self.assertEqual(recipe["steps"][0]["icon"], "pan")
        self.assertEqual(recipe["steps"][0]["summary"], "快速炒蛋")
        self.assertEqual(recipe["steps"][0]["estimated_minutes"], 6)
        self.assertEqual(recipe["steps"][0]["tip"], "火力中大")
        self.assertEqual(recipe["steps"][0]["key_points"], ["鸡蛋打散", "凝固即盛出"])
        self.assertEqual(recipe["steps"][1]["icon"], "pan")
        self.assertEqual(recipe["steps"][1]["summary"], "")

        update_response = self.client.patch(
            f"/api/recipes/{recipe_id}",
            json={
                "title": "少油番茄炒蛋",
                "servings": 2,
                "prep_minutes": 18,
                "difficulty": "easy",
                "ingredient_items": recipe["ingredient_items"],
                "steps": ["先炒蛋", "番茄出汁后合炒"],
                "tips": "少油少盐",
                "scene_tags": ["孩子也能吃"],
                "media_ids": [],
            },
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        self.assertEqual(update_response.json()["title"], "少油番茄炒蛋")
        foods_response = self.client.get("/api/foods")
        self.assertEqual(foods_response.status_code, 200, foods_response.text)
        linked_food = next(item for item in foods_response.json() if item["recipe_id"] == recipe_id)
        self.assertEqual(linked_food["name"], "少油番茄炒蛋")
        self.assertEqual(linked_food["flavor_tags"], ["孩子也能吃"])
        self.assertEqual(linked_food["scene"], "孩子也能吃")
        self.assertEqual(linked_food["notes"], "少油少盐")

        favorite_response = self.client.put(f"/api/recipe-favorites/{recipe_id}")
        self.assertEqual(favorite_response.status_code, 200, favorite_response.text)
        self.assertEqual(favorite_response.json()["recipe_id"], recipe_id)
        favorites = self.client.get("/api/recipe-favorites").json()
        self.assertEqual(len(favorites), 1)

        plan_response = self.client.post(
            "/api/recipe-plan",
            json={"recipe_id": recipe_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": "周四晚餐"},
        )
        self.assertEqual(plan_response.status_code, 201, plan_response.text)
        plan_id = plan_response.json()["id"]
        self.assertEqual(plan_response.json()["recipe_title"], "少油番茄炒蛋")

        plan_update = self.client.patch(f"/api/recipe-plan/{plan_id}", json={"meal_type": "lunch"})
        self.assertEqual(plan_update.status_code, 200, plan_update.text)
        self.assertEqual(plan_update.json()["meal_type"], "lunch")
        self.assertEqual(plan_update.json()["status"], "planned")

        scene_response = self.client.post(
            "/api/recipe-scenes",
            json={
                "name": "孩子也能吃",
                "description": "清淡少油",
                "image_prompt": "明亮干净的家庭晚餐",
                "hidden": False,
                "custom": True,
                "sort_order": 1,
            },
        )
        self.assertEqual(scene_response.status_code, 201, scene_response.text)
        scene_id = scene_response.json()["id"]

        scene_update = self.client.patch(f"/api/recipe-scenes/{scene_id}", json={"hidden": True})
        self.assertEqual(scene_update.status_code, 200, scene_update.text)
        self.assertTrue(scene_update.json()["hidden"])
        scenes = self.client.get("/api/recipe-scenes").json()
        self.assertEqual(scenes[0]["name"], "孩子也能吃")

        delete_plan = self.client.delete(f"/api/recipe-plan/{plan_id}")
        self.assertEqual(delete_plan.status_code, 204, delete_plan.text)
        delete_favorite = self.client.delete(f"/api/recipe-favorites/{recipe_id}")
        self.assertEqual(delete_favorite.status_code, 204, delete_favorite.text)
        delete_scene = self.client.delete(f"/api/recipe-scenes/{scene_id}")
        self.assertEqual(delete_scene.status_code, 204, delete_scene.text)
        delete_recipe = self.client.delete(f"/api/recipes/{recipe_id}")
        self.assertEqual(delete_recipe.status_code, 204, delete_recipe.text)

    def test_recipe_update_only_syncs_linked_self_made_food(self) -> None:
        recipe = self.create_recipe(auto_create_food=True)
        recipe_id = recipe["id"]
        with self.SessionLocal() as db:
            db.add(
                Food(
                    id="food-linked-restaurant",
                    family_id=self.family.id,
                    name="餐厅版番茄炒蛋",
                    type=FoodType.DINING_OUT,
                    category="外食",
                    flavor_tags=["原始标签"],
                    source_name="小馆",
                    scene="外食",
                    notes="不要被菜谱覆盖",
                    favorite=False,
                    recipe_id=recipe_id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
            )
            db.commit()

        update_response = self.client.patch(
            f"/api/recipes/{recipe_id}",
            json={
                "title": "新版番茄炒蛋",
                "servings": 2,
                "prep_minutes": 16,
                "difficulty": "easy",
                "ingredient_items": recipe["ingredient_items"],
                "steps": ["先炒蛋", "再炒番茄"],
                "tips": "加一点葱花",
                "scene_tags": ["周末午餐"],
                "media_ids": [],
            },
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)

        foods = self.client.get("/api/foods").json()
        self_made = next(item for item in foods if item["type"] == "selfMade")
        restaurant = next(item for item in foods if item["id"] == "food-linked-restaurant")
        self.assertEqual(self_made["name"], "新版番茄炒蛋")
        self.assertEqual(self_made["flavor_tags"], ["周末午餐"])
        self.assertEqual(restaurant["name"], "餐厅版番茄炒蛋")
        self.assertEqual(restaurant["flavor_tags"], ["原始标签"])
        self.assertEqual(restaurant["notes"], "不要被菜谱覆盖")

    def test_recipe_list_supports_query_filters_sort_and_pagination(self) -> None:
        tomato_recipe = self.create_recipe(auto_create_food=False)
        pancake_response = self.client.post(
            "/api/recipes",
            json={
                "title": "鸡蛋松饼",
                "servings": 2,
                "prep_minutes": 8,
                "difficulty": "medium",
                "ingredient_items": [
                    {
                        "ingredient_id": self.egg.id,
                        "ingredient_name": "鸡蛋",
                        "quantity": 1,
                        "unit": "个",
                        "note": "打散",
                    }
                ],
                "steps": ["搅拌", "小火煎"],
                "tips": "早餐快手",
                "scene_tags": ["早餐"],
                "media_ids": [],
                "auto_create_food": False,
            },
        )
        self.assertEqual(pancake_response.status_code, 201, pancake_response.text)

        search_response = self.client.get("/api/recipes?q=松饼&scene=早餐&difficulty=medium")
        self.assertEqual(search_response.status_code, 200, search_response.text)
        self.assertEqual([item["title"] for item in search_response.json()], ["鸡蛋松饼"])

        time_sorted = self.client.get("/api/recipes?sort=time").json()
        self.assertEqual([item["title"] for item in time_sorted], ["鸡蛋松饼", tomato_recipe["title"]])
        paged = self.client.get("/api/recipes?sort=time&limit=1&offset=1").json()
        self.assertEqual([item["title"] for item in paged], [tomato_recipe["title"]])

        with self.SessionLocal() as db:
            db.add(
                InventoryItem(
                    id="inventory-egg-filter",
                    family_id=self.family.id,
                    ingredient_id=self.egg.id,
                    quantity=Decimal("2"),
                    consumed_quantity=Decimal("0"),
                    unit="个",
                    status=InventoryStatus.FRESH,
                    purchase_date=date(2026, 5, 14),
                    storage_location="冷藏",
                    notes="",
                    low_stock_threshold=Decimal("0"),
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
            )
            db.commit()

        ready_response = self.client.get("/api/recipes?availability=ready")
        self.assertEqual(ready_response.status_code, 200, ready_response.text)
        self.assertEqual([item["title"] for item in ready_response.json()], ["鸡蛋松饼"])

    def test_cook_recipe_deducts_inventory_and_creates_meal_log(self) -> None:
        recipe = self.create_recipe(auto_create_food=False)
        recipe_id = recipe["id"]
        plan_response = self.client.post(
            "/api/recipe-plan",
            json={"recipe_id": recipe_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
        )
        self.assertEqual(plan_response.status_code, 201, plan_response.text)
        plan_id = plan_response.json()["id"]
        with self.SessionLocal() as db:
            db.add_all(
                [
                    InventoryItem(
                        id="inventory-tomato",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("2"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 14),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    InventoryItem(
                        id="inventory-egg",
                        family_id=self.family.id,
                        ingredient_id=self.egg.id,
                        quantity=Decimal("3"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 14),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.commit()

        cook_response = self.client.post(
            f"/api/recipes/{recipe_id}/cook",
            json={
                "servings": 2,
                "date": "2026-05-14",
                "meal_type": "dinner",
                "participant_user_ids": [self.user.id],
                "notes": "测试做菜",
                "create_meal_log": True,
                "recipe_plan_item_id": plan_id,
            },
        )
        self.assertEqual(cook_response.status_code, 200, cook_response.text)
        payload = cook_response.json()
        self.assertEqual(payload["shortages"], [])
        self.assertEqual(len(payload["consumed_items"]), 2)
        self.assertIsNotNone(payload["meal_log_id"])
        self.assertIsNotNone(payload["cook_log_id"])
        plan_items = self.client.get("/api/recipe-plan?date_from=2026-05-14&date_to=2026-05-14").json()
        self.assertEqual(plan_items[0]["status"], "cooked")
        self.assertEqual(plan_items[0]["meal_log_id"], payload["meal_log_id"])
        self.assertIsNotNone(plan_items[0]["completed_at"])
        recipes = self.client.get("/api/recipes").json()
        self.assertEqual(recipes[0]["cook_logs"][0]["id"], payload["cook_log_id"])
        self.assertEqual(recipes[0]["cook_logs"][0]["rating"], None)

        with self.SessionLocal() as db:
            tomato_item = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-tomato"))
            egg_item = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-egg"))
            self.assertEqual(tomato_item.consumed_quantity, Decimal("2.00"))
            self.assertEqual(egg_item.consumed_quantity, Decimal("3.00"))

    def test_recipe_discovery_availability_and_stats(self) -> None:
        recipe = self.create_recipe(auto_create_food=True)
        recipe_id = recipe["id"]
        with self.SessionLocal() as db:
            db.add_all(
                [
                    InventoryItem(
                        id="inventory-tomato-discovery",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("2"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 14),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    InventoryItem(
                        id="inventory-egg-discovery",
                        family_id=self.family.id,
                        ingredient_id=self.egg.id,
                        quantity=Decimal("3"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 14),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.commit()

        availability = self.client.get(f"/api/recipes/{recipe_id}/availability")
        self.assertEqual(availability.status_code, 200, availability.text)
        self.assertEqual(availability.json()["availability"], "ready")
        self.assertEqual(availability.json()["ready_count"], 2)

        discovery = self.client.get("/api/recipes/discovery?limit=3")
        self.assertEqual(discovery.status_code, 200, discovery.text)
        self.assertIn(recipe_id, discovery.json()["ready"]["recipe_ids"])
        self.assertIn(recipe_id, discovery.json()["recommended"]["recipe_ids"])

        cook_response = self.client.post(
            f"/api/recipes/{recipe_id}/cook",
            json={"servings": 2, "date": "2026-05-14", "meal_type": "dinner", "create_meal_log": True},
        )
        self.assertEqual(cook_response.status_code, 200, cook_response.text)
        stats = self.client.get("/api/recipes/stats?date_from=2026-05-01&date_to=2026-05-31")
        self.assertEqual(stats.status_code, 200, stats.text)
        self.assertEqual(stats.json()["total_cooks"], 1)
        self.assertEqual(stats.json()["recently_cooked"][0]["recipe_id"], recipe_id)
        self.assertEqual(stats.json()["frequent"][0]["count"], 1)

    def test_recipe_discovery_recommendation_ranking_uses_household_context(self) -> None:
        today = date.today()
        favorite = self.create_recipe(title="收藏番茄", ingredient_items=[
            {"ingredient_id": self.tomato.id, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""}
        ])
        recent = self.create_recipe(title="刚吃番茄", ingredient_items=[
            {"ingredient_id": self.tomato.id, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""}
        ])
        expiring = self.create_recipe(title="临期鸡蛋", prep_minutes=25, difficulty="medium", ingredient_items=[
            {"ingredient_id": self.egg.id, "ingredient_name": "鸡蛋", "quantity": 1, "unit": "个", "note": ""}
        ])
        rated = self.create_recipe(title="高分番茄", prep_minutes=25, difficulty="medium", ingredient_items=[
            {"ingredient_id": self.tomato.id, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""}
        ])
        plain = self.create_recipe(title="普通番茄", prep_minutes=25, difficulty="medium", ingredient_items=[
            {"ingredient_id": self.tomato.id, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""}
        ])
        missing = self.create_recipe(title="缺料鸡蛋", ingredient_items=[
            {"ingredient_id": self.egg.id, "ingredient_name": "鸡蛋", "quantity": 99, "unit": "个", "note": ""}
        ])

        with self.SessionLocal() as db:
            db.add_all(
                [
                    InventoryItem(
                        id="inventory-tomato-ranking",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("30"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=today,
                        expiry_date=today + timedelta(days=10),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    InventoryItem(
                        id="inventory-egg-ranking",
                        family_id=self.family.id,
                        ingredient_id=self.egg.id,
                        quantity=Decimal("2"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=today,
                        expiry_date=today + timedelta(days=1),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    RecipeFavorite(
                        id="favorite-ranking",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        recipe_id=favorite["id"],
                    ),
                    RecipeCookLog(
                        id="cook-recent-today",
                        family_id=self.family.id,
                        recipe_id=recent["id"],
                        cook_date=today,
                        meal_type=MealType.DINNER,
                        servings=Decimal("2"),
                        result_note="刚吃过",
                        adjustments="",
                        rating=5,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    RecipeCookLog(
                        id="cook-recent-old",
                        family_id=self.family.id,
                        recipe_id=recent["id"],
                        cook_date=today - timedelta(days=20),
                        meal_type=MealType.DINNER,
                        servings=Decimal("2"),
                        result_note="常做",
                        adjustments="",
                        rating=5,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    RecipeCookLog(
                        id="cook-rated",
                        family_id=self.family.id,
                        recipe_id=rated["id"],
                        cook_date=today - timedelta(days=20),
                        meal_type=MealType.DINNER,
                        servings=Decimal("2"),
                        result_note="很好吃",
                        adjustments="",
                        rating=5,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.commit()

        response = self.client.get("/api/recipes/discovery?limit=10")
        self.assertEqual(response.status_code, 200, response.text)
        recommended_ids = response.json()["recommended"]["recipe_ids"]

        self.assertEqual(recommended_ids[0], favorite["id"])
        self.assertLess(recommended_ids.index(recent["id"]), len(recommended_ids))
        self.assertGreater(recommended_ids.index(recent["id"]), recommended_ids.index(plain["id"]))
        self.assertLess(recommended_ids.index(expiring["id"]), recommended_ids.index(plain["id"]))
        self.assertLess(recommended_ids.index(rated["id"]), recommended_ids.index(plain["id"]))
        self.assertLess(recommended_ids.index(plain["id"]), recommended_ids.index(missing["id"]))

    def test_cook_preview_returns_batches_without_deducting_inventory(self) -> None:
        recipe = self.create_recipe(auto_create_food=False)
        recipe_id = recipe["id"]
        today = date.today()
        with self.SessionLocal() as db:
            db.add_all(
                [
                    InventoryItem(
                        id="inventory-tomato-old",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("1"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=today - timedelta(days=2),
                        expiry_date=today + timedelta(days=1),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    InventoryItem(
                        id="inventory-tomato-new",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("2"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=today - timedelta(days=1),
                        expiry_date=today + timedelta(days=5),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    InventoryItem(
                        id="inventory-egg-preview",
                        family_id=self.family.id,
                        ingredient_id=self.egg.id,
                        quantity=Decimal("3"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=today - timedelta(days=1),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.commit()

        preview_response = self.client.post(
            f"/api/recipes/{recipe_id}/cook-preview",
            json={"servings": 2, "create_meal_log": True},
        )
        self.assertEqual(preview_response.status_code, 200, preview_response.text)
        payload = preview_response.json()
        self.assertEqual(payload["shortages"], [])
        tomato_preview = next(item for item in payload["preview_items"] if item["ingredient_id"] == self.tomato.id)
        self.assertEqual([batch["inventory_item_id"] for batch in tomato_preview["batches"]], ["inventory-tomato-old", "inventory-tomato-new"])
        self.assertEqual([batch["quantity"] for batch in tomato_preview["batches"]], [1.0, 1.0])

        with self.SessionLocal() as db:
            tomato_old = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-tomato-old"))
            tomato_new = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-tomato-new"))
            self.assertEqual(tomato_old.consumed_quantity, Decimal("0.00"))
            self.assertEqual(tomato_new.consumed_quantity, Decimal("0.00"))

    def test_cook_recipe_returns_shortages_without_deducting(self) -> None:
        recipe = self.create_recipe(auto_create_food=False)
        response = self.client.post(
            f"/api/recipes/{recipe['id']}/cook",
            json={"servings": 2, "create_meal_log": False},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["consumed_items"], [])
        self.assertEqual({item["ingredient_name"] for item in payload["shortages"]}, {"番茄", "鸡蛋"})


if __name__ == "__main__":
    unittest.main()
