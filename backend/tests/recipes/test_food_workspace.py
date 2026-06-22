from ._support import *


class RecipeFoodWorkspaceTestCase(RecipeApiTestCase):
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

        def test_food_plan_supports_non_recipe_food_and_quick_add_completion(self) -> None:
            food_response = self.client.post(
                "/api/foods",
                json={
                    "name": "周五常点披萨",
                    "type": "takeout",
                    "category": "外卖",
                    "flavor_tags": ["省心"],
                    "suitable_meal_types": ["dinner"],
                    "source_name": "楼下披萨",
                    "purchase_source": "外卖平台",
                    "scene": "周五晚餐",
                    "notes": "双拼",
                    "routine_note": "忙的时候点",
                    "price": 68,
                    "rating": 4,
                    "repurchase": True,
                    "expiry_date": None,
                    "stock_quantity": None,
                    "stock_unit": "",
                    "favorite": False,
                    "media_ids": [],
                },
            )
            self.assertEqual(food_response.status_code, 201, food_response.text)
            food = food_response.json()

            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food["id"], "plan_date": "2026-05-15", "meal_type": "dinner", "note": "周五省心"},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan = plan_response.json()
            self.assertEqual(plan["food_id"], food["id"])
            self.assertEqual(plan["food_name"], "周五常点披萨")
            self.assertIsNone(plan["recipe_id"])

            update_response = self.client.patch(f"/api/food-plan/{plan['id']}", json={"meal_type": "lunch"})
            self.assertEqual(update_response.status_code, 200, update_response.text)
            self.assertEqual(update_response.json()["meal_type"], "lunch")

            quick_add = self.client.post(
                "/api/meal-logs/quick-add",
                json={
                    "food_id": food["id"],
                    "date": "2026-05-15",
                    "meal_type": "lunch",
                    "servings": 1,
                    "note": "完成计划",
                    "food_plan_item_id": plan["id"],
                },
            )
            self.assertEqual(quick_add.status_code, 201, quick_add.text)
            plan_items = self.client.get("/api/food-plan?date_from=2026-05-15&date_to=2026-05-15").json()
            self.assertEqual(plan_items[0]["status"], "cooked")
            self.assertEqual(plan_items[0]["meal_log_id"], quick_add.json()["id"])
            self.assertIsNotNone(plan_items[0]["completed_at"])

        def test_meal_logs_can_load_current_ready_made_food_types(self) -> None:
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
