from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.models.domain import ActivityLog, Food, MealLogFood
from app.api.meal_logs import _select_food_for_quick_add

from ._support import RecipeApiTestCase


class RecipeFoodStockOperationsTestCase(RecipeApiTestCase):
    def _ready_food(self, **overrides) -> Food:
        values = {
            "id": "food-stock-yogurt",
            "family_id": self.family.id,
            "name": "蓝莓酸奶",
            "type": "readyMade",
            "category": "饮品",
            "flavor_tags": [],
            "scene_tags": [],
            "suitable_meal_types": ["breakfast"],
            "source_name": "超市",
            "purchase_source": "盒马",
            "scene": "",
            "notes": "",
            "routine_note": "",
            "stock_quantity": Decimal("2"),
            "stock_unit": "盒",
            "storage_location": "冷藏",
            "expiry_date": date(2026, 7, 10),
            "favorite": False,
            "created_by": self.user.id,
            "updated_by": self.user.id,
        }
        values.update(overrides)
        return Food(**values)

    def test_food_stock_restock_consume_and_dispose(self) -> None:
        with self.SessionLocal() as db:
            db.add(self._ready_food())
            db.commit()

        restock = self.client.post(
            "/api/foods/food-stock-yogurt/stock/restock",
            json={"quantity": 3, "unit": "盒", "expiry_date": "2026-07-20", "purchase_source": "山姆", "storage_location": "冷冻", "note": "周末补货"},
        )
        self.assertEqual(restock.status_code, 200, restock.text)
        self.assertEqual(restock.json()["stock_quantity"], 5)
        self.assertEqual(restock.json()["stock_unit"], "盒")
        self.assertEqual(restock.json()["expiry_date"], "2026-07-20")
        self.assertEqual(restock.json()["purchase_source"], "山姆")
        self.assertEqual(restock.json()["storage_location"], "冷冻")

        consume = self.client.post(
            "/api/foods/food-stock-yogurt/stock/consume",
            json={"quantity": 1, "unit": "盒", "note": "早餐吃掉"},
        )
        self.assertEqual(consume.status_code, 200, consume.text)
        self.assertEqual(consume.json()["stock_quantity"], 4)
        self.assertEqual(consume.json()["storage_location"], "冷冻")

        dispose = self.client.post(
            "/api/foods/food-stock-yogurt/stock/dispose",
            json={"quantity": 2, "unit": "盒", "reason": "包装破损"},
        )
        self.assertEqual(dispose.status_code, 200, dispose.text)
        self.assertEqual(dispose.json()["stock_quantity"], 2)
        self.assertEqual(dispose.json()["storage_location"], "冷冻")

        with self.SessionLocal() as db:
            logs = list(
                db.scalars(
                    select(ActivityLog).where(
                        ActivityLog.entity_type == "Food",
                        ActivityLog.entity_id == "food-stock-yogurt",
                    )
                )
            )
        self.assertEqual([log.action for log in logs], ["update", "update", "update"])

    def test_food_stock_rejects_outside_food_and_overconsume(self) -> None:
        with self.SessionLocal() as db:
            db.add_all(
                [
                    self._ready_food(
                        id="food-stock-takeout",
                        name="牛肉饭",
                        type="takeout",
                        stock_quantity=Decimal("2"),
                        stock_unit="份",
                    ),
                    self._ready_food(id="food-stock-low", stock_quantity=Decimal("1")),
                ]
            )
            db.commit()

        takeout_response = self.client.post(
            "/api/foods/food-stock-takeout/stock/consume",
            json={"quantity": 1, "unit": "份"},
        )
        self.assertEqual(takeout_response.status_code, 400)
        self.assertEqual(takeout_response.json()["detail"], "只有成品、速食和包装食品支持食物库存操作")

        overconsume = self.client.post(
            "/api/foods/food-stock-low/stock/consume",
            json={"quantity": 2, "unit": "盒"},
        )
        self.assertEqual(overconsume.status_code, 400)
        self.assertEqual(overconsume.json()["detail"], "当前最多只能处理 1盒")

    def test_quick_add_ready_food_can_deduct_stock_in_same_request(self) -> None:
        food = self._ready_food(id="food-stock-quick", stock_quantity=Decimal("2"))
        with self.SessionLocal() as db:
            db.add(food)
            db.commit()

        response = self.client.post(
            "/api/meal-logs/quick-add",
            json={
                "food_id": "food-stock-quick",
                "date": "2026-07-07",
                "meal_type": "breakfast",
                "servings": 1,
                "note": "",
                "deduct_food_stock": True,
                "stock_quantity": 1,
            },
        )

        self.assertEqual(response.status_code, 201, response.text)
        with self.SessionLocal() as db:
            refreshed = db.get(Food, "food-stock-quick")
            assert refreshed is not None
            self.assertEqual(refreshed.stock_quantity, Decimal("1.00"))

    def test_quick_add_plan_replay_does_not_double_deduct_stock(self) -> None:
        food = self._ready_food(id="food-stock-replay", stock_quantity=Decimal("3"))
        with self.SessionLocal() as db:
            db.add(food)
            db.commit()

        plan_response = self.client.post(
            "/api/food-plan",
            json={"food_id": food.id, "plan_date": "2026-07-07", "meal_type": "breakfast", "note": "库存回放"},
        )
        self.assertEqual(plan_response.status_code, 201, plan_response.text)
        plan = plan_response.json()

        payload = {
            "food_id": food.id,
            "date": "2026-07-07",
            "meal_type": "breakfast",
            "servings": 1,
            "note": "完成计划",
            "food_plan_item_id": plan["id"],
            "deduct_food_stock": True,
            "stock_quantity": 1,
        }

        first_response = self.client.post("/api/meal-logs/quick-add", json=payload)
        self.assertEqual(first_response.status_code, 201, first_response.text)

        second_response = self.client.post("/api/meal-logs/quick-add", json=payload)
        self.assertEqual(second_response.status_code, 201, second_response.text)
        self.assertEqual(second_response.json()["id"], first_response.json()["id"])

        with self.SessionLocal() as db:
            refreshed = db.get(Food, food.id)
            assert refreshed is not None
            self.assertEqual(refreshed.stock_quantity, Decimal("2.00"))
            meal_entries = list(db.scalars(select(MealLogFood).where(MealLogFood.food_id == food.id)))
            self.assertEqual(len(meal_entries), 1)

        with self.SessionLocal() as db:
            entries = list(
                db.scalars(
                    select(ActivityLog).where(
                        ActivityLog.entity_type == "Food",
                        ActivityLog.entity_id == food.id,
                    )
                )
            )
        self.assertEqual(len(entries), 1)

    def test_quick_add_food_stock_query_uses_row_lock(self) -> None:
        statement = _select_food_for_quick_add(food_id="food-stock-lock", family_id="family-test", deduct_food_stock=True)
        self.assertIsNotNone(statement._for_update_arg)

        unlocked_statement = _select_food_for_quick_add(
            food_id="food-stock-lock",
            family_id="family-test",
            deduct_food_stock=False,
        )
        self.assertIsNone(unlocked_statement._for_update_arg)
