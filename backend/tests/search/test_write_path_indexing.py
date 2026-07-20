from __future__ import annotations

from sqlalchemy import select

from app.models.domain import Food, SearchDocument, SearchIndexJob
from app.services.search.jobs import _index_vector_if_enabled, process_search_index_job
from tests.recipes._support import RecipeApiTestCase


class SearchWritePathIndexingTestCase(RecipeApiTestCase):
    def _process_index_job(self, entity_type: str, entity_id: str) -> None:
        with self.SessionLocal() as db:
            job = db.scalar(
                select(SearchIndexJob)
                .where(
                    SearchIndexJob.family_id == self.family.id,
                    SearchIndexJob.entity_type == entity_type,
                    SearchIndexJob.entity_id == entity_id,
                )
                .order_by(SearchIndexJob.created_at.desc(), SearchIndexJob.id.desc())
            )
            self.assertIsNotNone(job)
            assert job is not None
            job_id = job.id
        process_search_index_job(job_id, session_factory=self.SessionLocal)

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
        self._process_index_job("ingredient", ingredient["id"])
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
            json={
                **ingredient,
                "name": "紫皮洋葱头",
                "notes": "适合快手炒菜",
                "media_ids": [],
                "expected_row_version": ingredient["row_version"],
            },
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        self._process_index_job("ingredient", ingredient["id"])
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
            self.assertEqual(document.vector_status, "disabled")

    def test_search_index_vector_step_treats_null_attempt_count_as_zero(self) -> None:
        response = self.client.post(
            "/api/ingredients",
            json={
                "name": "梅干菜",
                "category": "干货",
                "default_unit": "克",
                "unit_conversions": [],
                "quantity_tracking_mode": "track_quantity",
                "default_storage": "阴凉",
                "default_expiry_mode": "none",
                "notes": "适合扣肉",
                "media_ids": [],
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        ingredient = response.json()
        self._process_index_job("ingredient", ingredient["id"])
        with self.SessionLocal() as db:
            document = db.scalar(
                select(SearchDocument).where(
                    SearchDocument.entity_type == "ingredient",
                    SearchDocument.entity_id == ingredient["id"],
                )
            )
            self.assertIsNotNone(document)
            assert document is not None
            document.vector_status = "pending"
            document.vector_attempt_count = None  # type: ignore[assignment]
            vector_status = _index_vector_if_enabled(document)
            self.assertEqual(vector_status, "skipped")
            self.assertEqual(document.vector_attempt_count, 0)

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
        self._process_index_job("food", food["id"])
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
            json={
                **food,
                "expected_row_version": food["row_version"],
                "name": "冷冻牛肉饭 Pro",
                "media_ids": [],
            },
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        self._process_index_job("food", food["id"])
        with self.SessionLocal() as db:
            document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "food", SearchDocument.entity_id == food["id"]))
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document.title_text, "冷冻牛肉饭 Pro")
            self.assertNotEqual(document.content_hash, old_hash)
            self.assertEqual(document.vector_status, "disabled")

    def test_food_favorite_change_does_not_enqueue_search_index_job(self) -> None:
        response = self.client.post(
            "/api/foods",
            json={
                "name": "收藏切换测试食物",
                "type": "instant",
                "category": "速食",
                "flavor_tags": [],
                "suitable_meal_types": ["dinner"],
                "source_name": "",
                "purchase_source": "",
                "scene": "",
                "notes": "",
                "routine_note": "",
                "price": None,
                "rating": None,
                "repurchase": False,
                "expiry_date": None,
                "stock_quantity": None,
                "stock_unit": "份",
                "favorite": False,
                "media_ids": [],
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        food = response.json()
        with self.SessionLocal() as db:
            initial_job_count = len(
                list(
                    db.scalars(
                        select(SearchIndexJob).where(
                            SearchIndexJob.family_id == self.family.id,
                            SearchIndexJob.entity_type == "food",
                            SearchIndexJob.entity_id == food["id"],
                        )
                    )
                )
            )

        favorite_response = self.client.patch(
            f"/api/foods/{food['id']}/favorite",
            json={"favorite": True, "expected_row_version": food["row_version"]},
        )
        self.assertEqual(favorite_response.status_code, 200, favorite_response.text)
        self.assertTrue(favorite_response.json()["favorite"])
        with self.SessionLocal() as db:
            job_count = len(
                list(
                    db.scalars(
                        select(SearchIndexJob).where(
                            SearchIndexJob.family_id == self.family.id,
                            SearchIndexJob.entity_type == "food",
                            SearchIndexJob.entity_id == food["id"],
                        )
                    )
                )
            )
        self.assertEqual(job_count, initial_job_count)

    def test_food_plan_create_update_and_delete_syncs_search_document(self) -> None:
        food_response = self.client.post(
            "/api/foods",
            json={
                "name": "周日晚餐面",
                "type": "instant",
                "category": "主食",
                "flavor_tags": [],
                "suitable_meal_types": ["dinner"],
                "source_name": "",
                "purchase_source": "",
                "scene": "",
                "notes": "",
                "routine_note": "",
                "price": None,
                "rating": None,
                "repurchase": False,
                "expiry_date": None,
                "stock_quantity": None,
                "stock_unit": "份",
                "favorite": False,
                "media_ids": [],
            },
        )
        self.assertEqual(food_response.status_code, 201, food_response.text)
        food = food_response.json()
        plan_response = self.client.post(
            "/api/food-plan",
            json={
                "food_id": food["id"],
                "plan_date": "2026-06-29",
                "meal_type": "dinner",
                "note": "周日晚餐安排",
            },
        )
        self.assertEqual(plan_response.status_code, 201, plan_response.text)
        plan = plan_response.json()
        self._process_index_job("meal_plan", plan["id"])
        with self.SessionLocal() as db:
            document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "meal_plan", SearchDocument.entity_id == plan["id"]))
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document.metadata_json["user_id"], self.user.id)
            self.assertIn("周日晚餐安排", document.semantic_text)
            old_hash = document.content_hash

        update_response = self.client.patch(f"/api/food-plan/{plan['id']}", json={"note": "改成周一晚餐", "status": "planned"})
        self.assertEqual(update_response.status_code, 200, update_response.text)
        self._process_index_job("meal_plan", plan["id"])
        with self.SessionLocal() as db:
            document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "meal_plan", SearchDocument.entity_id == plan["id"]))
            self.assertIsNotNone(document)
            assert document is not None
            self.assertIn("改成周一晚餐", document.semantic_text)
            self.assertNotEqual(document.content_hash, old_hash)

        delete_response = self.client.delete(f"/api/food-plan/{plan['id']}")
        self.assertEqual(delete_response.status_code, 204, delete_response.text)
        with self.SessionLocal() as db:
            document = db.scalar(select(SearchDocument).where(SearchDocument.entity_type == "meal_plan", SearchDocument.entity_id == plan["id"]))
            self.assertIsNone(document)

    def test_recipe_create_update_and_delete_syncs_recipe_and_food_documents(self) -> None:
        recipe = self.create_recipe(title="番茄炒蛋")
        recipe_id = recipe["id"]
        with self.SessionLocal() as db:
            food = db.scalar(select(Food).where(Food.recipe_id == recipe_id))
            self.assertIsNotNone(food)
            assert food is not None
            food_id = food.id
        self._process_index_job("recipe", recipe_id)
        self._process_index_job("food", food_id)
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
        self._process_index_job("recipe", recipe_id)
        with self.SessionLocal() as db:
            food = db.scalar(select(Food).where(Food.recipe_id == recipe_id))
            self.assertIsNotNone(food)
            assert food is not None
            food_id = food.id
        self._process_index_job("food", food_id)
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
