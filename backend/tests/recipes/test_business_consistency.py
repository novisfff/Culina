from datetime import date
from decimal import Decimal

from app.ai.tools.draft_validation import normalize_meal_plan_draft
from app.models.domain import Food, FoodPlanItem, MealLog, MealLogFood, Recipe, RecipeCookLog
from app.services.ai_operations.meal_plans import execute_meal_plan_draft
from app.services.recipe_recommendations import recipe_recommendation_usage_maps

from ._support import RecipeApiTestCase


class BusinessConsistencyTestCase(RecipeApiTestCase):
    def create_stock_food(self, **overrides) -> dict:
        payload = {
            "name": "早餐牛奶",
            "type": "packaged",
            "category": "乳制品",
            "stock_quantity": 2,
            "stock_unit": "盒",
            "expiry_date": "2026-11-10",
            "suitable_meal_types": ["breakfast"],
            "favorite": True,
            "media_ids": [],
        }
        payload.update(overrides)
        response = self.client.post("/api/foods", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def create_plan(self, food_id: str) -> dict:
        response = self.client.post(
            "/api/food-plan",
            json={"food_id": food_id, "plan_date": "2026-11-09", "meal_type": "breakfast"},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_restock_preserves_old_stock_expiry_but_resets_it_when_empty(self) -> None:
        cases = [
            (2, "2026-11-10", "2026-11-20", "2026-11-10"),
            (2, "2026-11-20", "2026-11-10", "2026-11-10"),
            (2, "2026-11-10", None, "2026-11-10"),
            (2, None, "2026-11-20", "2026-11-20"),
            (0, "2026-11-10", "2026-11-20", "2026-11-20"),
            (0, "2026-11-10", None, None),
        ]
        for quantity, old_expiry, incoming_expiry, expected_expiry in cases:
            with self.subTest(quantity=quantity, old=old_expiry, incoming=incoming_expiry):
                food = self.create_stock_food(stock_quantity=quantity, expiry_date=old_expiry)
                response = self.client.post(
                    f"/api/foods/{food['id']}/stock/restock",
                    json={
                        "quantity": 3,
                        "unit": "盒",
                        "expiry_date": incoming_expiry,
                        "expected_row_version": food["row_version"],
                    },
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["stock_quantity"], quantity + 3)
                self.assertEqual(response.json()["expiry_date"], expected_expiry)

    def test_empty_ready_food_is_not_recommended_even_when_favorite_and_expiring(self) -> None:
        for food_type in ("readyMade", "instant", "packaged"):
            with self.subTest(food_type=food_type):
                food = self.create_stock_food(
                    type=food_type, stock_quantity=0, expiry_date="2026-11-09", source_name="超市"
                )
                response = self.client.get(
                    "/api/foods/recommendations",
                    params={"now": "2026-11-09T07:00:00+08:00", "limit": 30},
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertNotIn(food["id"], [item["food"]["id"] for item in response.json()["items"]])

    def test_status_patch_cannot_complete_a_plan_without_recording_a_meal(self) -> None:
        food = self.create_stock_food()
        plan = self.create_plan(food["id"])
        response = self.client.patch(
            f"/api/food-plan/{plan['id']}", json={"status": "cooked", "note": "不应落库"}
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "food_plan_completion_required")
        current = self.client.get(f"/api/food-plan/{plan['id']}").json()
        self.assertEqual(current["status"], "planned")
        self.assertEqual(current["note"], "")
        self.assertIsNone(current["meal_log_id"])
        self.assertEqual(self.client.get("/api/meal-logs").json(), [])

    def test_ai_draft_cannot_set_an_unrecorded_plan_to_cooked(self) -> None:
        food = self.create_stock_food()
        plan = self.create_plan(food["id"])
        payload = {
            "draftType": "meal_plan",
            "schemaVersion": "meal_plan_operation.v1",
            "operations": [{
                "operationId": "complete-without-record",
                "action": "set_status",
                "targetId": plan["id"],
                "baseUpdatedAt": plan["updated_at"],
                "payload": {"status": "cooked"},
            }],
        }
        with self.SessionLocal() as db:
            with self.assertRaisesRegex(ValueError, "记录"):
                normalize_meal_plan_draft(
                    db, family_id=self.family.id, user_id=self.user.id, payload=payload
                )
            with self.assertRaisesRegex(ValueError, "记录"):
                execute_meal_plan_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload=payload,
                    assert_updated_at_matches=lambda *_: None,
                )
            db.rollback()
        self.assertEqual(self.client.get(f"/api/food-plan/{plan['id']}").json()["status"], "planned")

    def test_legacy_unrecorded_cooked_plan_can_be_completed_once(self) -> None:
        food = self.create_stock_food()
        plan = self.create_plan(food["id"])
        with self.SessionLocal() as db:
            item = db.get(FoodPlanItem, plan["id"])
            item.status = "cooked"
            db.commit()
        current = self.client.get(f"/api/food-plan/{plan['id']}").json()
        payload = {"food_plan_item_base_updated_at": current["updated_at"]}
        first = self.client.post(f"/api/food-plan/{plan['id']}/complete", json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        replay = self.client.post(f"/api/food-plan/{plan['id']}/complete", json=payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(first.json()["id"], replay.json()["id"])
        self.assertEqual(len(self.client.get("/api/meal-logs").json()), 1)

    def test_record_meal_recovers_legacy_plan_and_replays_without_another_record(self) -> None:
        food = self.create_stock_food()
        plan = self.create_plan(food["id"])
        with self.SessionLocal() as db:
            item = db.get(FoodPlanItem, plan["id"])
            item.status = "cooked"
            db.commit()
        current = self.client.get(f"/api/food-plan/{plan['id']}").json()
        payload = {
            "client_request_id": "recover-legacy-plan",
            "date": plan["plan_date"],
            "meal_type": plan["meal_type"],
            "target": {"kind": "new"},
            "entries": [{"food_id": food["id"], "servings": 1}],
            "plan_item_completions": [{
                "food_plan_item_id": plan["id"],
                "food_plan_item_base_updated_at": current["updated_at"],
            }],
        }
        first = self.client.post("/api/meal-logs/record", json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        replay = self.client.post("/api/meal-logs/record", json=payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        meal_id = first.json()["meal_log"]["id"]
        self.assertEqual(replay.json()["meal_log"]["id"], meal_id)
        self.assertEqual(self.client.get(f"/api/food-plan/{plan['id']}").json()["meal_log_id"], meal_id)
        self.assertEqual(len(self.client.get("/api/meal-logs").json()), 1)


def test_recommendation_usage_counts_linked_cook_and_meal_once() -> None:
    meal_date = date(2026, 11, 8)
    recipe = Recipe(id="recipe-1", cook_logs=[
        RecipeCookLog(id="cook-1", meal_log_id="meal-1", cook_date=meal_date),
    ])
    food = Food(id="food-1", recipe_id=recipe.id)
    meal = MealLog(id="meal-1", date=meal_date, food_entries=[
        MealLogFood(food_id=food.id, servings=Decimal("1")),
    ])
    counts, last_used = recipe_recommendation_usage_maps(
        recipes=[recipe], meal_logs=[meal], foods=[food], today=date(2026, 11, 9)
    )
    assert counts == {"recipe-1": 1}
    assert last_used == {"recipe-1": meal_date}


def test_recommendation_usage_keeps_distinct_meals_and_unlinked_cooks_on_same_day() -> None:
    meal_date = date(2026, 11, 8)
    recipe = Recipe(id="recipe-1", cook_logs=[
        RecipeCookLog(id="cook-1", meal_log_id="meal-1", cook_date=meal_date),
        RecipeCookLog(id="cook-2", meal_log_id=None, cook_date=meal_date),
        RecipeCookLog(id="cook-3", meal_log_id="meal-not-loaded", cook_date=meal_date),
    ])
    food = Food(id="food-1", recipe_id=recipe.id)
    meals = [MealLog(id=meal_id, date=meal_date, food_entries=[
        MealLogFood(food_id=food.id, servings=Decimal("1")),
    ]) for meal_id in ("meal-1", "meal-2")]
    counts, _ = recipe_recommendation_usage_maps(
        recipes=[recipe], meal_logs=meals, foods=[food], today=date(2026, 11, 9)
    )
    assert counts == {"recipe-1": 4}
