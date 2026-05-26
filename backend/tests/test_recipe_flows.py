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
        self.assertEqual(linked_food["flavor_tags"], [])
        self.assertEqual(linked_food["scene_tags"], [])
        self.assertEqual(linked_food["scene"], "日常")
        self.assertEqual(linked_food["notes"], "少油版")

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
            "/api/food-scenes",
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

        scene_update = self.client.patch(f"/api/food-scenes/{scene_id}", json={"hidden": True})
        self.assertEqual(scene_update.status_code, 200, scene_update.text)
        self.assertTrue(scene_update.json()["hidden"])
        scenes = self.client.get("/api/food-scenes").json()
        self.assertEqual(scenes[0]["name"], "孩子也能吃")

        delete_plan = self.client.delete(f"/api/recipe-plan/{plan_id}")
        self.assertEqual(delete_plan.status_code, 204, delete_plan.text)
        delete_favorite = self.client.delete(f"/api/recipe-favorites/{recipe_id}")
        self.assertEqual(delete_favorite.status_code, 204, delete_favorite.text)
        delete_scene = self.client.delete(f"/api/food-scenes/{scene_id}")
        self.assertEqual(delete_scene.status_code, 204, delete_scene.text)
        delete_recipe = self.client.delete(f"/api/recipes/{recipe_id}")
        self.assertEqual(delete_recipe.status_code, 204, delete_recipe.text)
        remaining_foods = self.client.get("/api/foods").json()
        self.assertFalse(any(item["recipe_id"] == recipe_id for item in remaining_foods))

    def test_recipe_always_creates_and_repairs_one_self_made_food(self) -> None:
        recipe = self.create_recipe(auto_create_food=False)
        recipe_id = recipe["id"]

        foods = self.client.get("/api/foods").json()
        linked_foods = [item for item in foods if item["recipe_id"] == recipe_id]
        self.assertEqual(len(linked_foods), 1)
        self.assertEqual(linked_foods[0]["type"], "selfMade")
        self.assertEqual(linked_foods[0]["name"], "番茄炒蛋")

        with self.SessionLocal() as db:
            food = db.scalar(select(Food).where(Food.recipe_id == recipe_id))
            self.assertIsNotNone(food)
            db.delete(food)
            db.commit()

        update_response = self.client.patch(
            f"/api/recipes/{recipe_id}",
            json={
                "title": "修复后的番茄炒蛋",
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

        repaired_foods = [item for item in self.client.get("/api/foods").json() if item["recipe_id"] == recipe_id]
        self.assertEqual(len(repaired_foods), 1)
        self.assertEqual(repaired_foods[0]["name"], "修复后的番茄炒蛋")

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
        self.assertEqual(self_made["flavor_tags"], [])
        self.assertEqual(self_made["scene_tags"], [])
        self.assertEqual(restaurant["name"], "餐厅版番茄炒蛋")
        self.assertEqual(restaurant["flavor_tags"], ["原始标签"])
        self.assertEqual(restaurant["notes"], "不要被菜谱覆盖")

    def test_self_made_food_profile_can_be_edited_without_breaking_recipe_sync(self) -> None:
        recipe = self.create_recipe(auto_create_food=True)
        recipe_id = recipe["id"]
        self_made = next(item for item in self.client.get("/api/foods").json() if item["recipe_id"] == recipe_id)

        update_food = self.client.patch(
            f"/api/foods/{self_made['id']}",
            json={
                **self_made,
                "flavor_tags": ["清淡", "快手"],
                "suitable_meal_types": ["lunch", "dinner"],
                "scene": "工作日",
                "notes": "少油一点",
                "routine_note": "适合带饭",
                "favorite": True,
                "media_ids": [],
            },
        )
        self.assertEqual(update_food.status_code, 200, update_food.text)
        self.assertEqual(update_food.json()["name"], "番茄炒蛋")
        self.assertEqual(update_food.json()["flavor_tags"], ["清淡", "快手"])
        self.assertEqual(update_food.json()["suitable_meal_types"], ["lunch", "dinner"])
        self.assertEqual(update_food.json()["routine_note"], "适合带饭")
        self.assertTrue(update_food.json()["favorite"])

        update_recipe = self.client.patch(
            f"/api/recipes/{recipe_id}",
            json={
                "title": "新版番茄炒蛋",
                "servings": 2,
                "prep_minutes": 16,
                "difficulty": "easy",
                "ingredient_items": recipe["ingredient_items"],
                "steps": ["先炒蛋", "再炒番茄"],
                "tips": "菜谱技巧更新",
                "scene_tags": ["周末午餐"],
                "media_ids": [],
            },
        )
        self.assertEqual(update_recipe.status_code, 200, update_recipe.text)

        synced = next(item for item in self.client.get("/api/foods").json() if item["recipe_id"] == recipe_id)
        self.assertEqual(synced["name"], "新版番茄炒蛋")
        self.assertEqual(synced["flavor_tags"], ["清淡", "快手"])
        self.assertEqual(synced["suitable_meal_types"], ["lunch", "dinner"])
        self.assertEqual(synced["routine_note"], "适合带饭")

    def test_food_workspace_fields_update_and_quick_add(self) -> None:
        create_response = self.client.post(
            "/api/foods",
            json={
                "name": "冷冻牛肉饭",
                "type": "instant",
                "category": "速食",
                "flavor_tags": ["省心", "微辣"],
                "suitable_meal_types": ["lunch", "dinner"],
                "source_name": "便利店",
                "purchase_source": "楼下便利店",
                "scene": "加班晚餐",
                "notes": "微波炉 4 分钟",
                "routine_note": "家里没菜时备用",
                "price": 18.9,
                "rating": 4,
                "repurchase": True,
                "expiry_date": "2026-06-01",
                "stock_quantity": 2,
                "stock_unit": "盒",
                "favorite": True,
                "media_ids": [],
            },
        )
        self.assertEqual(create_response.status_code, 201, create_response.text)
        food = create_response.json()
        self.assertEqual(food["type"], "instant")
        self.assertEqual(food["suitable_meal_types"], ["lunch", "dinner"])
        self.assertEqual(food["purchase_source"], "楼下便利店")
        self.assertEqual(food["price"], 18.9)
        self.assertEqual(food["stock_quantity"], 2)

        update_response = self.client.patch(
            f"/api/foods/{food['id']}",
            json={
                **food,
                "name": "冷冻牛肉饭 Pro",
                "rating": 5,
                "repurchase": False,
                "media_ids": [],
            },
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        self.assertEqual(update_response.json()["name"], "冷冻牛肉饭 Pro")
        self.assertEqual(update_response.json()["rating"], 5)
        self.assertFalse(update_response.json()["repurchase"])

        create_self_made = self.client.post(
            "/api/foods",
            json={
                **food,
                "id": "ignored",
                "name": "手动家常菜",
                "type": "selfMade",
                "recipe_id": None,
                "media_ids": [],
            },
        )
        self.assertEqual(create_self_made.status_code, 400, create_self_made.text)
        self.assertEqual(create_self_made.json()["detail"], "家常菜由菜谱自动同步")

        update_to_self_made = self.client.patch(
            f"/api/foods/{food['id']}",
            json={
                **food,
                "type": "selfMade",
                "recipe_id": "recipe-any",
                "media_ids": [],
            },
        )
        self.assertEqual(update_to_self_made.status_code, 400, update_to_self_made.text)

        update_recipe_link = self.client.patch(
            f"/api/foods/{food['id']}",
            json={
                **food,
                "recipe_id": "recipe-any",
                "media_ids": [],
            },
        )
        self.assertEqual(update_recipe_link.status_code, 400, update_recipe_link.text)

        first_add = self.client.post(
            "/api/meal-logs/quick-add",
            json={"food_id": food["id"], "date": "2026-05-14", "meal_type": "dinner", "servings": 1, "note": "加班"},
        )
        self.assertEqual(first_add.status_code, 201, first_add.text)
        self.assertEqual(len(first_add.json()["food_entries"]), 1)

        second_add = self.client.post(
            "/api/meal-logs/quick-add",
            json={"food_id": food["id"], "date": "2026-05-14", "meal_type": "dinner", "servings": 0.5, "note": "又加半份"},
        )
        self.assertEqual(second_add.status_code, 201, second_add.text)
        self.assertEqual(second_add.json()["id"], first_add.json()["id"])
        self.assertEqual(len(second_add.json()["food_entries"]), 2)

    def test_meal_logs_can_load_ready_made_food_type_values(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-ready-made",
                family_id=self.family.id,
                name="即食鸡胸",
                type="readyMade",
                category="成品",
                flavor_tags=[],
                suitable_meal_types=["lunch"],
                source_name="便利店",
                purchase_source="便利店",
                scene="加班",
                notes="",
                routine_note="",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            meal_log = MealLog(
                id="meal-ready-made",
                family_id=self.family.id,
                date=date(2026, 5, 14),
                meal_type=MealType.LUNCH,
                participant_user_ids=[],
                notes="",
                mood="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([food, meal_log])
            db.flush()
            db.add(
                MealLogFood(
                    id="meal-food-ready-made",
                    meal_log_id=meal_log.id,
                    food_id=food.id,
                    servings=1,
                    note="",
                )
            )
            db.commit()

        response = self.client.get("/api/meal-logs")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()[0]["food_entries"][0]["food_name"], "即食鸡胸")

    def test_food_list_normalizes_legacy_enum_name_values(self) -> None:
        with self.SessionLocal() as db:
            db.add_all(
                [
                    Food(
                        id="food-legacy-self-made",
                        family_id=self.family.id,
                        name="旧家常菜",
                        type="SELF_MADE",
                        category="家常菜",
                        flavor_tags=[],
                        suitable_meal_types=["dinner"],
                        source_name="家庭厨房",
                        purchase_source="家庭厨房",
                        scene="晚餐",
                        notes="",
                        routine_note="",
                        favorite=False,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    Food(
                        id="food-legacy-takeout",
                        family_id=self.family.id,
                        name="旧外卖",
                        type="TAKEOUT",
                        category="外卖",
                        flavor_tags=[],
                        suitable_meal_types=["lunch"],
                        source_name="餐厅",
                        purchase_source="餐厅",
                        scene="午餐",
                        notes="",
                        routine_note="",
                        favorite=False,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.commit()

        response = self.client.get("/api/foods")
        self.assertEqual(response.status_code, 200, response.text)
        foods_by_id = {item["id"]: item for item in response.json()}
        self.assertEqual(foods_by_id["food-legacy-self-made"]["type"], "selfMade")
        self.assertEqual(foods_by_id["food-legacy-takeout"]["type"], "takeout")

    def test_food_recommendations_infer_next_meal_and_return_actions(self) -> None:
        dinner_recipe = self.create_recipe(auto_create_food=True, title="可做晚餐")
        with self.SessionLocal() as db:
            dinner_food = db.scalar(select(Food).where(Food.recipe_id == dinner_recipe["id"]))
            self.assertIsNotNone(dinner_food)
            dinner_food.suitable_meal_types = ["dinner"]
            db.add_all(
                [
                    InventoryItem(
                        id="inventory-rec-tomato",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("3"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 25),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    InventoryItem(
                        id="inventory-rec-egg",
                        family_id=self.family.id,
                        ingredient_id=self.egg.id,
                        quantity=Decimal("4"),
                        consumed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date(2026, 5, 25),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                    Food(
                        id="food-lunch-only",
                        family_id=self.family.id,
                        name="午餐便当",
                        type=FoodType.TAKEOUT.value,
                        category="外卖",
                        flavor_tags=[],
                        suitable_meal_types=["lunch"],
                        source_name="便当店",
                        purchase_source="便当店",
                        scene="工作日",
                        notes="",
                        routine_note="午餐备用",
                        favorite=False,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    ),
                ]
            )
            db.commit()

        response = self.client.get("/api/foods/recommendations?now=2026-05-25T15:30:00&limit=6")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["target_meal_type"], "dinner")
        self.assertEqual(payload["target_date"], "2026-05-25")
        self.assertEqual(payload["items"][0]["food"]["name"], "可做晚餐")
        self.assertEqual(payload["items"][0]["primary_action"], "cook_recipe")
        self.assertIn("适合晚餐", payload["items"][0]["reasons"])
        self.assertEqual(payload["items"][0]["recipe_availability"]["availability"], "ready")

    def test_food_recommendations_weight_expiry_recent_history_and_repurchase(self) -> None:
        with self.SessionLocal() as db:
            expiring = Food(
                id="food-expiring-yogurt",
                family_id=self.family.id,
                name="今日到期酸奶",
                type=FoodType.READY_MADE.value,
                category="成品",
                flavor_tags=[],
                suitable_meal_types=["dinner"],
                source_name="超市",
                purchase_source="超市",
                scene="晚餐",
                notes="",
                routine_note="饭后吃",
                expiry_date=date(2026, 5, 25),
                stock_quantity=Decimal("2"),
                stock_unit="盒",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            recent = Food(
                id="food-recent-noodle",
                family_id=self.family.id,
                name="昨天刚吃面",
                type=FoodType.INSTANT.value,
                category="速食",
                flavor_tags=[],
                suitable_meal_types=["dinner"],
                source_name="便利店",
                purchase_source="便利店",
                scene="晚餐",
                notes="",
                routine_note="快手",
                expiry_date=date(2026, 6, 30),
                stock_quantity=Decimal("2"),
                stock_unit="包",
                rating=5,
                repurchase=True,
                favorite=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            rejected = Food(
                id="food-rejected-takeout",
                family_id=self.family.id,
                name="不想复购外卖",
                type=FoodType.TAKEOUT.value,
                category="外卖",
                flavor_tags=[],
                suitable_meal_types=["dinner"],
                source_name="外卖店",
                purchase_source="外卖店",
                scene="晚餐",
                notes="",
                routine_note="太咸",
                rating=2,
                repurchase=False,
                favorite=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            meal_log = MealLog(
                id="meal-recent-noodle",
                family_id=self.family.id,
                date=date(2026, 5, 24),
                meal_type=MealType.DINNER,
                participant_user_ids=[],
                notes="",
                mood="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([expiring, recent, rejected, meal_log])
            db.flush()
            db.add(MealLogFood(id="meal-food-recent-noodle", meal_log_id=meal_log.id, food_id=recent.id, servings=1, note=""))
            db.commit()

        response = self.client.get("/api/foods/recommendations?now=2026-05-25T18:00:00&limit=6")
        self.assertEqual(response.status_code, 200, response.text)
        items = response.json()["items"]
        names = [item["food"]["name"] for item in items]
        self.assertEqual(names[0], "今日到期酸奶")
        self.assertIn("今天到期", items[0]["reasons"])
        scores_by_name = {item["food"]["name"]: item["score"] for item in items}
        self.assertLess(scores_by_name["不想复购外卖"], scores_by_name["昨天刚吃面"])

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
