from __future__ import annotations

from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.models.domain import ActivityLog, Food, MealLogFood
from app.services.food_plan_locking import lock_plan_item_after_food

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
            json={"expected_row_version": 1, "quantity": 3, "unit": "盒", "expiry_date": "2026-07-20", "purchase_source": "山姆", "storage_location": "冷冻", "note": "周末补货"},
        )
        self.assertEqual(restock.status_code, 200, restock.text)
        self.assertEqual(restock.json()["stock_quantity"], 5)
        self.assertEqual(restock.json()["stock_unit"], "盒")
        self.assertEqual(restock.json()["expiry_date"], "2026-07-20")
        self.assertEqual(restock.json()["purchase_source"], "山姆")
        self.assertEqual(restock.json()["storage_location"], "冷冻")

        consume = self.client.post(
            "/api/foods/food-stock-yogurt/stock/consume",
            json={"expected_row_version": 2, "quantity": 1, "unit": "盒", "note": "早餐吃掉"},
        )
        self.assertEqual(consume.status_code, 200, consume.text)
        self.assertEqual(consume.json()["stock_quantity"], 4)
        self.assertEqual(consume.json()["storage_location"], "冷冻")

        dispose = self.client.post(
            "/api/foods/food-stock-yogurt/stock/dispose",
            json={"expected_row_version": 3, "quantity": 2, "unit": "盒", "reason": "包装破损"},
        )
        self.assertEqual(dispose.status_code, 200, dispose.text)
        self.assertEqual(dispose.json()["stock_quantity"], 2)
        self.assertEqual(dispose.json()["storage_location"], "冷冻")

        with self.SessionLocal() as db:
            food = db.get(Food, "food-stock-yogurt")
            assert food is not None
            # create starts at 1; restock/consume/dispose each advance once
            self.assertEqual(food.row_version, 4)

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
            json={"expected_row_version": 1, "quantity": 1, "unit": "份"},
        )
        self.assertEqual(takeout_response.status_code, 400)
        self.assertEqual(takeout_response.json()["detail"], "只有成品、速食和包装食品支持食物库存操作")

        overconsume = self.client.post(
            "/api/foods/food-stock-low/stock/consume",
            json={"expected_row_version": 1, "quantity": 2, "unit": "盒"},
        )
        self.assertEqual(overconsume.status_code, 400)
        self.assertEqual(overconsume.json()["detail"], "当前最多只能处理 1盒")

    def test_food_stock_operations_reject_more_than_one_decimal(self) -> None:
        with self.SessionLocal() as db:
            db.add(self._ready_food(id="food-stock-decimal", stock_quantity=Decimal("2")))
            db.commit()

        restock = self.client.post(
            "/api/foods/food-stock-decimal/stock/restock",
            json={"expected_row_version": 1, "quantity": 1.25, "unit": "盒"},
        )
        self.assertEqual(restock.status_code, 400)
        self.assertEqual(restock.json()["detail"], "库存数量最多保留 1 位小数")

        consume = self.client.post(
            "/api/foods/food-stock-decimal/stock/consume",
            json={"expected_row_version": 1, "quantity": 1.25, "unit": "盒"},
        )
        self.assertEqual(consume.status_code, 400)
        self.assertEqual(consume.json()["detail"], "库存数量最多保留 1 位小数")

    def test_food_stock_overconsume_uses_one_decimal_safe_max(self) -> None:
        with self.SessionLocal() as db:
            db.add(self._ready_food(id="food-stock-hidden-decimal", stock_quantity=Decimal("140.95")))
            db.commit()

        response = self.client.post(
            "/api/foods/food-stock-hidden-decimal/stock/consume",
            json={"expected_row_version": 1, "quantity": 141, "unit": "盒"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "当前最多只能处理 140.9盒")

    def test_record_meal_does_not_mutate_food_stock(self) -> None:
        food = self._ready_food(id="food-stock-quick", stock_quantity=Decimal("2"))
        with self.SessionLocal() as db:
            db.add(food)
            db.commit()

        response = self.client.post(
            "/api/meal-logs/record",
            json={
                "client_request_id": "stock-record-1",
                "date": "2026-07-07",
                "meal_type": "breakfast",
                "target": {"kind": "new"},
                "new_foods": [],
                "entries": [{"food_id": "food-stock-quick", "servings": 1}],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        with self.SessionLocal() as db:
            refreshed = db.get(Food, "food-stock-quick")
            assert refreshed is not None
            self.assertEqual(refreshed.stock_quantity, Decimal("2.00"))
            self.assertEqual(refreshed.row_version, 1)

        consume = self.client.post(
            "/api/foods/food-stock-quick/stock/consume",
            json={"expected_row_version": 1, "quantity": 1, "unit": "盒"},
        )
        self.assertEqual(consume.status_code, 200, consume.text)
        self.assertEqual(consume.json()["stock_quantity"], 1)

    def test_food_stock_consume_rejects_stale_food_version_atomically(self) -> None:
        food = self._ready_food(id="food-stock-quick-stale", stock_quantity=Decimal("2"))
        with self.SessionLocal() as db:
            db.add(food)
            db.commit()
            food.stock_quantity = Decimal("3")
            db.commit()
            self.assertEqual(food.row_version, 2)

        # Record path never mutates stock even with a concurrent stock change.
        record = self.client.post(
            "/api/meal-logs/record",
            json={
                "client_request_id": "stock-stale-record-1",
                "date": "2026-07-07",
                "meal_type": "breakfast",
                "target": {"kind": "new"},
                "new_foods": [],
                "entries": [{"food_id": food.id, "servings": 1}],
            },
        )
        self.assertEqual(record.status_code, 200, record.text)

        response = self.client.post(
            f"/api/foods/{food.id}/stock/consume",
            json={"expected_row_version": 1, "quantity": 1, "unit": "盒"},
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "stale_version")
        with self.SessionLocal() as db:
            refreshed = db.get(Food, food.id)
            assert refreshed is not None
            self.assertEqual(refreshed.stock_quantity, Decimal("3.00"))
            meal_entries = list(db.scalars(select(MealLogFood).where(MealLogFood.food_id == food.id)))
            self.assertEqual(len(meal_entries), 1)

    def test_plan_complete_does_not_mutate_stock_and_replay_is_conflict(self) -> None:
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

        first_response = self.client.post(
            f"/api/food-plan/{plan['id']}/complete",
            json={"food_plan_item_base_updated_at": plan["updated_at"]},
        )
        self.assertEqual(first_response.status_code, 200, first_response.text)

        # Plan complete is inventory-free; stock is an independent command.
        with self.SessionLocal() as db:
            refreshed = db.get(Food, food.id)
            assert refreshed is not None
            self.assertEqual(refreshed.stock_quantity, Decimal("3.00"))
            meal_entries = list(db.scalars(select(MealLogFood).where(MealLogFood.food_id == food.id)))
            self.assertEqual(len(meal_entries), 1)

        consume = self.client.post(
            f"/api/foods/{food.id}/stock/consume",
            json={"expected_row_version": 1, "quantity": 1, "unit": "盒"},
        )
        self.assertEqual(consume.status_code, 200, consume.text)
        self.assertEqual(consume.json()["stock_quantity"], 2)

        second_response = self.client.post(
            f"/api/food-plan/{plan['id']}/complete",
            json={"food_plan_item_base_updated_at": plan["updated_at"]},
        )
        # Idempotent complete returns stored meal; stock remains from the independent consume.
        self.assertEqual(second_response.status_code, 200, second_response.text)
        self.assertEqual(second_response.json()["id"], first_response.json()["id"])

        with self.SessionLocal() as db:
            refreshed = db.get(Food, food.id)
            assert refreshed is not None
            self.assertEqual(refreshed.stock_quantity, Decimal("2.00"))

    def test_lock_plan_item_after_food_is_callable(self) -> None:
        self.assertTrue(callable(lock_plan_item_after_food))


    def test_food_stock_intake_uses_earliest_expiry_while_restock_overwrites(self) -> None:
        from app.services.food_stock import apply_food_stock_intake, apply_food_stock_restock, merge_food_intake_expiry

        self.assertEqual(
            merge_food_intake_expiry(
                current_quantity=Decimal("2"),
                current_expiry=date(2026, 7, 10),
                incoming_expiry=date(2026, 7, 20),
            ),
            date(2026, 7, 10),
        )

        with self.SessionLocal() as db:
            food = self._ready_food(
                id="food-stock-intake",
                stock_quantity=Decimal("2"),
                stock_unit="盒",
                expiry_date=date(2026, 7, 10),
                storage_location="冷藏",
            )
            db.add(food)
            db.commit()

            apply_food_stock_intake(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                food=food,
                quantity=Decimal("1"),
                unit="盒",
                expiry_date=date(2026, 7, 20),
                storage_location="冷冻",
            )
            db.commit()
            db.refresh(food)
            self.assertEqual(food.stock_quantity, Decimal("3.00"))
            self.assertEqual(food.expiry_date, date(2026, 7, 10))
            self.assertEqual(food.storage_location, "冷冻")

            apply_food_stock_restock(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                food=food,
                quantity=Decimal("1"),
                unit="盒",
                expiry_date=date(2026, 8, 1),
                purchase_source=None,
                storage_location="冷藏",
            )
            db.commit()
            db.refresh(food)
            self.assertEqual(food.expiry_date, date(2026, 8, 1))
            self.assertEqual(food.storage_location, "冷藏")
