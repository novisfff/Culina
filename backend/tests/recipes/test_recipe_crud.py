from datetime import date
from decimal import Decimal
from unittest.mock import patch

from app.core.enums import MealType
from app.models.domain import Food, FoodPlanItem, MealLog, MealLogFood, Recipe, RecipeCookLog
from ._support import *


class RecipeRecipeCrudTestCase(RecipeApiTestCase):
        def _linked_food_id(self, recipe_id: str) -> str:
            foods = self.client.get("/api/foods").json()
            linked = next(item for item in foods if item["recipe_id"] == recipe_id)
            return linked["id"]

        def _attach_history_reference(self, *, recipe_id: str, food_id: str, reference_kind: str) -> None:
            with self.SessionLocal() as db:
                if reference_kind == "cook_log":
                    db.add(
                        RecipeCookLog(
                            id=f"cook-log-{recipe_id}",
                            family_id=self.family.id,
                            recipe_id=recipe_id,
                            cook_date=date.today(),
                            meal_type=MealType.DINNER,
                            servings=Decimal("2"),
                            result_note="",
                            adjustments="",
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        )
                    )
                elif reference_kind == "meal_log_food":
                    meal_log = MealLog(
                        id=f"meal-log-{recipe_id}",
                        family_id=self.family.id,
                        date=date.today(),
                        meal_type=MealType.DINNER,
                        participant_user_ids=[self.user.id],
                        notes="history",
                        mood="",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                    db.add(meal_log)
                    db.flush()
                    db.add(
                        MealLogFood(
                            id=f"meal-food-{recipe_id}",
                            meal_log_id=meal_log.id,
                            food_id=food_id,
                            servings=Decimal("1"),
                            note="",
                        )
                    )
                elif reference_kind == "food_plan_item":
                    db.add(
                        FoodPlanItem(
                            id=f"food-plan-{recipe_id}",
                            family_id=self.family.id,
                            user_id=self.user.id,
                            food_id=food_id,
                            plan_date=date.today(),
                            meal_type=MealType.DINNER,
                            note="planned",
                            status="planned",
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        )
                    )
                else:
                    raise AssertionError(f"unknown reference_kind={reference_kind}")
                db.commit()

        def test_recipe_delete_preserves_history_reference(self) -> None:
            for reference_kind in ("cook_log", "meal_log_food", "food_plan_item"):
                with self.subTest(reference_kind=reference_kind):
                    recipe = self.create_recipe(auto_create_food=True, title=f"历史菜谱-{reference_kind}")
                    recipe_id = recipe["id"]
                    food_id = self._linked_food_id(recipe_id)
                    self._attach_history_reference(
                        recipe_id=recipe_id,
                        food_id=food_id,
                        reference_kind=reference_kind,
                    )

                    response = self.client.delete(f"/api/recipes/{recipe_id}")
                    self.assertEqual(response.status_code, 409, response.text)
                    detail = response.json()["detail"]
                    self.assertEqual(detail["code"], "recipe_has_history")

                    with self.SessionLocal() as db:
                        self.assertIsNotNone(db.get(Recipe, recipe_id))
                        self.assertIsNotNone(db.get(Food, food_id))

        def test_blocked_delete_does_not_delete_media_or_search(self) -> None:
            recipe = self.create_recipe(auto_create_food=True, title="阻塞删除菜谱")
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)
            self._attach_history_reference(
                recipe_id=recipe_id,
                food_id=food_id,
                reference_kind="meal_log_food",
            )

            with (
                patch("app.services.recipe_deletion.replace_media_assets") as delete_media,
                patch("app.services.recipe_deletion.delete_search_document") as delete_search,
            ):
                response = self.client.delete(f"/api/recipes/{recipe_id}")
                self.assertEqual(response.status_code, 409, response.text)
                delete_media.assert_not_called()
                delete_search.assert_not_called()

        def test_recipe_delete_without_history_still_works(self) -> None:
            recipe = self.create_recipe(auto_create_food=True, title="可删除菜谱")
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)

            response = self.client.delete(f"/api/recipes/{recipe_id}")
            self.assertEqual(response.status_code, 204, response.text)

            with self.SessionLocal() as db:
                self.assertIsNone(db.get(Recipe, recipe_id))
                self.assertIsNone(db.get(Food, food_id))

        def test_recipe_create_rejects_unresolved_ingredient_references(self) -> None:
            response = self.client.post(
                "/api/recipes",
                json={
                    "title": "番茄鸡蛋面",
                    "servings": 2,
                    "prep_minutes": 20,
                    "difficulty": "easy",
                    "ingredient_items": [
                        {"ingredient_id": self.tomato.id, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                        {"ingredient_id": None, "ingredient_name": "面条", "quantity": 200, "unit": "克", "note": "提前备好"},
                    ],
                    "steps": [{"text": "番茄炒出汁后加水煮面。"}],
                    "tips": "",
                    "scene_tags": [],
                    "media_ids": [],
                },
            )

            self.assertEqual(response.status_code, 422, response.text)
            detail = response.json()["detail"]
            self.assertEqual(detail["code"], "recipe_unresolved_ingredients")
            self.assertEqual(detail["items"][0]["ingredient_name"], "面条")
            self.assertEqual(detail["items"][0]["reason"], "missing_ingredient_id")

        def test_recipe_create_rejects_ingredient_from_outside_family(self) -> None:
            response = self.client.post(
                "/api/recipes",
                json={
                    "title": "番茄牛排",
                    "servings": 2,
                    "prep_minutes": 20,
                    "difficulty": "easy",
                    "ingredient_items": [
                        {"ingredient_id": self.tomato.id, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                        {"ingredient_id": "ingredient-secret", "ingredient_name": "牛排", "quantity": 1, "unit": "块", "note": ""},
                    ],
                    "steps": [{"text": "番茄和牛排分别处理后装盘。"}],
                    "tips": "",
                    "scene_tags": [],
                    "media_ids": [],
                },
            )

            self.assertEqual(response.status_code, 422, response.text)
            detail = response.json()["detail"]
            self.assertEqual(detail["code"], "recipe_unresolved_ingredients")
            self.assertEqual(detail["items"][0]["ingredient_id"], "ingredient-secret")
            self.assertEqual(detail["items"][0]["reason"], "ingredient_not_found")

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
                    "steps": [{"text": "先炒蛋"}, {"text": "番茄出汁后合炒"}],
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
                    "steps": [{"text": "先炒蛋"}, {"text": "再炒番茄"}],
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
                    "steps": [{"text": "先炒蛋"}, {"text": "再炒番茄"}],
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
                    "expected_row_version": self_made["row_version"],
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
                    "steps": [{"text": "先炒蛋"}, {"text": "再炒番茄"}],
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
