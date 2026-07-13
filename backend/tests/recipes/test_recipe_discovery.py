from app.services.clock import today_for_family
from ._support import *


class RecipeRecipeDiscoveryTestCase(RecipeApiTestCase):
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
                    "steps": [{"text": "搅拌"}, {"text": "小火煎"}],
                    "tips": "早餐快手",
                    "scene_tags": ["早餐"],
                    "media_ids": [],
                    "auto_create_food": False,
                },
            )
            self.assertEqual(pancake_response.status_code, 201, pancake_response.text)
            with self.SessionLocal() as db:
                db.add(
                    Ingredient(
                        id="ingredient-banana",
                        family_id=self.family.id,
                        name="香蕉",
                        category="水果",
                        default_unit="根",
                        unit_conversions=[],
                        default_storage="常温",
                        default_expiry_mode=IngredientExpiryMode.NONE,
                        notes="",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.commit()
            banana_pancake_response = self.client.post(
                "/api/recipes",
                json={
                    "title": "香蕉松饼",
                    "servings": 2,
                    "prep_minutes": 10,
                    "difficulty": "medium",
                    "ingredient_items": [
                        {
                            "ingredient_id": "ingredient-banana",
                            "ingredient_name": "香蕉",
                            "quantity": 1,
                            "unit": "根",
                            "note": "压成泥",
                        }
                    ],
                    "steps": [{"text": "混合香蕉和蛋液"}, {"text": "小火煎"}],
                    "tips": "早餐甜口",
                    "scene_tags": ["早餐"],
                    "media_ids": [],
                    "auto_create_food": False,
                },
            )
            self.assertEqual(banana_pancake_response.status_code, 201, banana_pancake_response.text)

            search_response = self.client.get("/api/recipes?q=松饼&scene=早餐&difficulty=medium")
            self.assertEqual(search_response.status_code, 200, search_response.text)
            self.assertEqual({item["title"] for item in search_response.json()}, {"鸡蛋松饼", "香蕉松饼"})
            second_search_page = self.client.get("/api/recipes?q=松饼&scene=早餐&difficulty=medium&limit=1&offset=1")
            self.assertEqual(second_search_page.status_code, 200, second_search_page.text)
            self.assertEqual(len(second_search_page.json()), 1)
            self.assertIn(second_search_page.json()[0]["title"], {"鸡蛋松饼", "香蕉松饼"})

            time_sorted = self.client.get("/api/recipes?sort=time").json()
            self.assertEqual([item["title"] for item in time_sorted], ["鸡蛋松饼", "香蕉松饼", tomato_recipe["title"]])
            paged = self.client.get("/api/recipes?sort=time&limit=1&offset=1").json()
            self.assertEqual([item["title"] for item in paged], ["香蕉松饼"])

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
                json={
                    "servings": 2,
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "completion_request_id": "discovery-cook-request-1",
                },
            )
            self.assertEqual(cook_response.status_code, 200, cook_response.text)
            stats = self.client.get("/api/recipes/stats?date_from=2026-05-01&date_to=2026-05-31")
            self.assertEqual(stats.status_code, 200, stats.text)
            self.assertEqual(stats.json()["total_cooks"], 1)
            self.assertEqual(stats.json()["recently_cooked"][0]["recipe_id"], recipe_id)
            self.assertEqual(stats.json()["frequent"][0]["count"], 1)

        def test_recipe_discovery_recommendation_ranking_uses_household_context(self) -> None:
            today = today_for_family(self.family.id)
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
