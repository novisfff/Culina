from ._support import *


class RecipeRecipeCookingTestCase(RecipeApiTestCase):
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
