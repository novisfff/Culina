from __future__ import annotations

from sqlalchemy import select

from app.models.domain import Food, SearchDocument
from tests.recipes._support import RecipeApiTestCase


class SearchWritePathIndexingTestCase(RecipeApiTestCase):
    def test_ingredient_create_and_update_refresh_search_document(self) -> None:
        response = self.client.post(
            "/api/ingredients",
            json={
                "name": "紫皮洋葱",
                "category": "蔬菜",
                "default_unit": "个",
                "unit_conversions": [],
                "quantity_tracking_mode": "track_quantity",
                "default_storage": "阴凉",
                "default_expiry_mode": "days",
                "default_expiry_days": 10,
                "default_low_stock_threshold": 1,
                "notes": "适合炒菜和凉拌",
                "media_ids": [],
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        ingredient = response.json()
        with self.SessionLocal() as db:
            document = db.scalar(
                select(SearchDocument).where(
                    SearchDocument.entity_type == "ingredient",
                    SearchDocument.entity_id == ingredient["id"],
                )
            )
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document.family_id, self.family.id)
            self.assertEqual(document.title_text, "紫皮洋葱")
            self.assertIn("适合炒菜和凉拌", document.semantic_text)
            old_hash = document.content_hash

        update_response = self.client.patch(
            f"/api/ingredients/{ingredient['id']}",
            json={**ingredient, "name": "紫皮洋葱头", "notes": "适合快手炒菜", "media_ids": []},
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        with self.SessionLocal() as db:
            document = db.scalar(
                select(SearchDocument).where(
                    SearchDocument.entity_type == "ingredient",
                    SearchDocument.entity_id == ingredient["id"],
                )
            )
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document.title_text, "紫皮洋葱头")
            self.assertIn("适合快手炒菜", document.semantic_text)
            self.assertNotEqual(document.content_hash, old_hash)
            self.assertEqual(document.vector_status, "pending")

    def test_food_create_and_update_refresh_search_document(self) -> None:
        response = self.client.post(
            "/api/foods",
            json={
                "name": "冷冻牛肉饭",
                "type": "instant",
                "category": "速食",
                "flavor_tags": ["省心"],
                "suitable_meal_types": ["dinner"],
                "source_name": "便利店",
                "purchase_source": "楼下便利店",
                "scene": "加班晚餐",
                "notes": "微波炉 4 分钟",
                "routine_note": "家里没菜时备用",
                "price": 18.9,
                "rating": 4,
                "repurchase": True,
                "expiry_date": None,
                "stock_quantity": 2,
                "stock_unit": "盒",
                "favorite": False,
                "media_ids": [],
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        food = response.json()
        with self.SessionLocal() as db:
            document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "food", SearchDocument.entity_id == food["id"]))
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document.family_id, self.family.id)
            self.assertIn("冷冻牛肉饭", document.title_text)
            self.assertIn("加班晚餐", document.semantic_text)
            old_hash = document.content_hash

        update_response = self.client.patch(
            f"/api/foods/{food['id']}",
            json={**food, "name": "冷冻牛肉饭 Pro", "media_ids": []},
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        with self.SessionLocal() as db:
            document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "food", SearchDocument.entity_id == food["id"]))
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document.title_text, "冷冻牛肉饭 Pro")
            self.assertNotEqual(document.content_hash, old_hash)
            self.assertEqual(document.vector_status, "pending")

    def test_recipe_create_update_and_delete_syncs_recipe_and_food_documents(self) -> None:
        recipe = self.create_recipe(title="番茄炒蛋")
        recipe_id = recipe["id"]
        with self.SessionLocal() as db:
            food = db.scalar(select(Food).where(Food.recipe_id == recipe_id))
            self.assertIsNotNone(food)
            assert food is not None
            recipe_document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "recipe", SearchDocument.entity_id == recipe_id))
            food_document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "food", SearchDocument.entity_id == food.id))
            self.assertIsNotNone(recipe_document)
            self.assertIsNotNone(food_document)
            assert recipe_document is not None
            self.assertIn("菜谱：番茄炒蛋", recipe_document.semantic_text)

        update_response = self.client.patch(
            f"/api/recipes/{recipe_id}",
            json={
                "title": "少油番茄炒蛋",
                "servings": 2,
                "prep_minutes": 18,
                "difficulty": "easy",
                "ingredient_items": recipe["ingredient_items"],
                "steps": [{"text": "先炒蛋"}, {"text": "番茄出汁后合炒"}],
                "tips": "少油少盐",
                "scene_tags": ["孩子也能吃"],
                "media_ids": [],
            },
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        with self.SessionLocal() as db:
            food = db.scalar(select(Food).where(Food.recipe_id == recipe_id))
            self.assertIsNotNone(food)
            assert food is not None
            recipe_document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "recipe", SearchDocument.entity_id == recipe_id))
            food_document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "food", SearchDocument.entity_id == food.id))
            self.assertIsNotNone(recipe_document)
            self.assertIsNotNone(food_document)
            assert recipe_document is not None and food_document is not None
            self.assertEqual(recipe_document.title_text, "少油番茄炒蛋")
            self.assertEqual(food_document.title_text, "少油番茄炒蛋")
            food_id = food.id

        delete_response = self.client.delete(f"/api/recipes/{recipe_id}")
        self.assertEqual(delete_response.status_code, 204, delete_response.text)
        with self.SessionLocal() as db:
            recipe_document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "recipe", SearchDocument.entity_id == recipe_id))
            food_document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "food", SearchDocument.entity_id == food_id))
            self.assertIsNone(recipe_document)
            self.assertIsNone(food_document)
