from ._support import *


class RecipeFoodQueriesTestCase(RecipeApiTestCase):
        def test_food_and_ingredient_lists_support_search_and_pagination(self) -> None:
            with self.SessionLocal() as db:
                other_family = Family(id="family-other", name="其他家庭", motto="", location="")
                db.add_all(
                    [
                        other_family,
                        Ingredient(
                            id="ingredient-potato",
                            family_id=self.family.id,
                            name="土豆",
                            category="蔬菜",
                            default_unit="个",
                            unit_conversions=[],
                            default_storage="阴凉",
                            default_expiry_mode=IngredientExpiryMode.NONE,
                            notes="",
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        Ingredient(
                            id="ingredient-other-family",
                            family_id=other_family.id,
                            name="家庭外番茄",
                            category="蔬菜",
                            default_unit="个",
                            unit_conversions=[],
                            default_storage="冷藏",
                            default_expiry_mode=IngredientExpiryMode.NONE,
                            notes="",
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        Food(
                            id="food-tomato-rice",
                            family_id=self.family.id,
                            name="番茄烩饭",
                            type=FoodType.READY_MADE.value,
                            category="主食",
                            flavor_tags=[],
                            suitable_meal_types=["lunch"],
                            source_name="",
                            purchase_source="",
                            scene="午餐",
                            notes="",
                            routine_note="",
                            favorite=False,
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        Food(
                            id="food-potato-beef",
                            family_id=self.family.id,
                            name="土豆牛肉",
                            type=FoodType.READY_MADE.value,
                            category="家常菜",
                            flavor_tags=[],
                            suitable_meal_types=["dinner"],
                            source_name="",
                            purchase_source="",
                            scene="晚餐",
                            notes="",
                            routine_note="",
                            favorite=False,
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        Food(
                            id="food-other-family",
                            family_id=other_family.id,
                            name="家庭外番茄饭",
                            type=FoodType.READY_MADE.value,
                            category="主食",
                            flavor_tags=[],
                            suitable_meal_types=["lunch"],
                            source_name="",
                            purchase_source="",
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

            first_ingredient_page = self.client.get("/api/ingredients?limit=1&offset=0")
            second_ingredient_page = self.client.get("/api/ingredients?limit=1&offset=1")
            self.assertEqual(first_ingredient_page.status_code, 200, first_ingredient_page.text)
            self.assertEqual(second_ingredient_page.status_code, 200, second_ingredient_page.text)
            ingredient_page_ids = {
                first_ingredient_page.json()[0]["id"],
                second_ingredient_page.json()[0]["id"],
            }
            self.assertEqual(len(ingredient_page_ids), 2)
            self.assertNotIn("ingredient-other-family", ingredient_page_ids)

            ingredient_search = self.client.get("/api/ingredients?q=%E5%9C%9F%E8%B1%86&limit=6&offset=0")
            self.assertEqual(ingredient_search.status_code, 200, ingredient_search.text)
            self.assertEqual([item["id"] for item in ingredient_search.json()], ["ingredient-potato"])

            first_food_page = self.client.get("/api/foods?limit=1&offset=0")
            second_food_page = self.client.get("/api/foods?limit=1&offset=1")
            self.assertEqual(first_food_page.status_code, 200, first_food_page.text)
            self.assertEqual(second_food_page.status_code, 200, second_food_page.text)
            food_page_ids = {
                first_food_page.json()[0]["id"],
                second_food_page.json()[0]["id"],
            }
            self.assertEqual(len(food_page_ids), 2)
            self.assertNotIn("food-other-family", food_page_ids)

            food_search = self.client.get("/api/foods?q=%E7%95%AA%E8%8C%84&limit=6&offset=0")
            self.assertEqual(food_search.status_code, 200, food_search.text)
            self.assertEqual([item["id"] for item in food_search.json()], ["food-tomato-rice"])

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
