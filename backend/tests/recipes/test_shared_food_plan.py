from __future__ import annotations

from sqlalchemy import func, select

from app.ai.errors import AIConflictError
from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.meal_plan import meal_plan_create_draft, meal_plan_read_by_id, meal_plan_read_existing
from app.ai.tools.catalog.recipe import recipe_preview_cook
from app.ai.tools.draft_validation import normalize_meal_log_draft, normalize_recipe_cook_draft
from app.core.deps import get_current_auth
from app.core.enums import FoodType, MembershipStatus, UserRole
from app.main import app
from app.models.domain import ActivityLog, Family, Food, FoodPlanItem, MealLog, Membership, User
from app.services.ai_operations.meal_plans import execute_meal_plan_draft
from tests._transaction_failure import fail_next_commit
from tests.recipes._support import RecipeApiTestCase


class SharedFoodPlanTestCase(RecipeApiTestCase):
    def create_plan(self, *, food_id: str = "shared-food") -> dict:
        if food_id == "shared-food":
            with self.SessionLocal() as db:
                food = Food(id=food_id, family_id=self.family.id, name="牛奶", type=FoodType.INSTANT)
                db.add(food)
                db.commit()
        response = self.client.post(
            "/api/food-plan",
            json={"food_id": food_id, "plan_date": "2099-05-20", "meal_type": "dinner", "note": "全家安排"},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def switch_member(self, *, other_family: bool = False) -> str:
        with self.SessionLocal() as db:
            family_id = "family-other" if other_family else self.family.id
            if other_family:
                db.add(Family(id=family_id, name="其他家庭"))
            user = User(id="shared-member", username="shared-member", display_name="家庭成员")
            membership = Membership(
                id="shared-membership", family_id=family_id, user_id=user.id,
                role=UserRole.MEMBER, status=MembershipStatus.ACTIVE,
            )
            db.add_all([user, membership])
            db.commit()

        def override_auth():
            with self.SessionLocal() as db:
                return db.get(User, "shared-member"), db.get(Membership, "shared-membership")

        app.dependency_overrides[get_current_auth] = override_auth
        return "shared-member"

    def test_family_member_can_list_update_and_delete_shared_plan(self) -> None:
        plan = self.create_plan()
        actor_id = self.switch_member()
        listing = self.client.get("/api/food-plan?date_from=2099-05-20&date_to=2099-05-20")
        self.assertEqual([item["id"] for item in listing.json()], [plan["id"]])
        self.assertEqual(self.client.get(f"/api/food-plan/{plan['id']}").status_code, 200)

        updated = self.client.patch(f"/api/food-plan/{plan['id']}", json={"note": "成员调整", "status": "skipped"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["created_by"], self.user.id)
        self.assertEqual(updated.json()["updated_by"], actor_id)
        self.assertEqual(updated.json()["user_id"], self.user.id)

        deleted = self.client.delete(f"/api/food-plan/{plan['id']}")
        self.assertEqual(deleted.status_code, 204, deleted.text)
        with self.SessionLocal() as db:
            self.assertIsNone(db.get(FoodPlanItem, plan["id"]))
            logs = list(db.scalars(select(ActivityLog).where(ActivityLog.entity_id == plan["id"])))
            self.assertEqual([log.actor_id for log in logs if log.actor_id == actor_id], [actor_id, actor_id])

    def test_family_member_completion_replays_one_shared_meal(self) -> None:
        plan = self.create_plan()
        actor_id = self.switch_member()
        payload = {"food_plan_item_base_updated_at": plan["updated_at"]}
        first = self.client.post(f"/api/food-plan/{plan['id']}/complete", json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["participant_user_ids"], [actor_id])
        replay = self.client.post(f"/api/food-plan/{plan['id']}/complete", json=payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(first.json()["id"], replay.json()["id"])
        with self.SessionLocal() as db:
            item = db.get(FoodPlanItem, plan["id"])
            self.assertEqual(item.status, "cooked")
            self.assertEqual(item.updated_by, actor_id)
            self.assertEqual(item.meal_log_id, first.json()["id"])
            self.assertEqual(db.scalar(select(func.count(MealLog.id))), 1)

    def test_other_family_cannot_read_change_delete_or_complete_plan(self) -> None:
        plan = self.create_plan()
        self.switch_member(other_family=True)
        listing = self.client.get("/api/food-plan?date_from=2099-05-20&date_to=2099-05-20")
        self.assertEqual(listing.json(), [])
        for response in (
            self.client.get(f"/api/food-plan/{plan['id']}"),
            self.client.patch(f"/api/food-plan/{plan['id']}", json={"note": "越权"}),
            self.client.delete(f"/api/food-plan/{plan['id']}"),
            self.client.post(f"/api/food-plan/{plan['id']}/complete", json={"food_plan_item_base_updated_at": plan["updated_at"]}),
        ):
            self.assertEqual(response.status_code, 404, response.text)
        with self.SessionLocal() as db:
            self.assertEqual(db.get(FoodPlanItem, plan["id"]).note, "全家安排")
            self.assertEqual(db.scalar(select(func.count(MealLog.id))), 0)

    def test_deleting_creator_keeps_family_plan(self) -> None:
        plan = self.create_plan()
        self.switch_member()
        with self.SessionLocal() as db:
            db.delete(db.get(User, self.user.id))
            db.commit()
        response = self.client.get(f"/api/food-plan/{plan['id']}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["user_id"])
        self.assertEqual(response.json()["created_by"], self.user.id)

    def test_family_member_recipe_cook_completes_creators_plan(self) -> None:
        recipe = self.create_recipe(auto_create_food=True)
        with self.SessionLocal() as db:
            food_id = db.scalar(select(Food.id).where(Food.recipe_id == recipe["id"]))
        plan = self.create_plan(food_id=food_id)
        actor_id = self.switch_member()
        with self.SessionLocal() as db:
            preview = recipe_preview_cook(
                ToolContext(db=db, family_id=self.family.id, user_id=actor_id, conversation_id="test", run_id="test"),
                {"recipeId": recipe["id"], "planItemId": plan["id"]},
            )
            self.assertEqual(preview["planItem"]["id"], plan["id"])
            self.assertIsNone(preview["planItemWarning"])
            draft = normalize_recipe_cook_draft(db, family_id=self.family.id, user_id=actor_id, payload={
                "recipeId": recipe["id"], "servings": 2, "date": plan["plan_date"],
                "mealType": "dinner", "planItemId": plan["id"],
            })
            self.assertEqual(draft["planItemId"], plan["id"])
        response = self.client.post(f"/api/recipes/{recipe['id']}/cook", json={
            "completion_request_id": "shared-cook", "date": plan["plan_date"], "meal_type": "dinner",
            "servings": 2, "participant_user_ids": [actor_id], "allow_partial_inventory_deduction": True,
            "food_plan_item_id": plan["id"], "food_plan_item_base_updated_at": plan["updated_at"],
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNotNone(response.json()["meal_log_id"])
        with self.SessionLocal() as db:
            item = db.get(FoodPlanItem, plan["id"])
            self.assertEqual(item.status, "cooked")
            self.assertEqual(item.updated_by, actor_id)

    def test_family_member_can_record_meal_with_creators_plan(self) -> None:
        plan = self.create_plan()
        actor_id = self.switch_member()
        with self.SessionLocal() as db:
            draft = normalize_meal_log_draft(db, family_id=self.family.id, user_id=actor_id, payload={
                "date": plan["plan_date"], "mealType": "dinner", "planItemId": plan["id"],
                "foods": [{"foodId": plan["food_id"], "servings": 1}],
            })
            self.assertEqual(draft["planItemId"], plan["id"])
        response = self.client.post("/api/meal-logs/record", json={
            "client_request_id": "shared-record", "date": plan["plan_date"], "meal_type": "dinner",
            "target": {"kind": "new"}, "entries": [{"food_id": plan["food_id"], "servings": 1}],
            "plan_item_completions": [{
                "food_plan_item_id": plan["id"], "food_plan_item_base_updated_at": plan["updated_at"],
            }],
        })
        self.assertEqual(response.status_code, 200, response.text)
        with self.SessionLocal() as db:
            item = db.get(FoodPlanItem, plan["id"])
            self.assertEqual(item.meal_log_id, response.json()["meal_log"]["id"])
            self.assertEqual(item.updated_by, actor_id)

    def test_ai_member_can_read_propose_and_apply_shared_plan_change(self) -> None:
        plan = self.create_plan()
        actor_id = self.switch_member()
        with self.SessionLocal() as db:
            context = ToolContext(db=db, family_id=self.family.id, user_id=actor_id, conversation_id="test", run_id="test")
            self.assertEqual(meal_plan_read_by_id(context, {"id": plan["id"]})["item"]["id"], plan["id"])
            self.assertEqual(meal_plan_read_existing(context, {"ids": [plan["id"]]})["count"], 1)
            draft = meal_plan_create_draft(context, {"draft": {"operations": [{
                "action": "set_status", "targetId": plan["id"], "baseUpdatedAt": plan["updated_at"],
                "payload": {"status": "skipped"},
            }]}})["draft"]
            self.assertEqual(db.get(FoodPlanItem, plan["id"]).status, "planned")
            execute_meal_plan_draft(
                db, family_id=self.family.id, user_id=actor_id, payload=draft,
                assert_updated_at_matches=lambda *_args: None,
            )
            db.commit()
            item = db.get(FoodPlanItem, plan["id"])
            self.assertEqual(item.status, "skipped")
            self.assertEqual(item.updated_by, actor_id)
            with self.assertRaises(AIConflictError):
                execute_meal_plan_draft(
                    db, family_id=self.family.id, user_id=actor_id, payload=draft,
                    assert_updated_at_matches=lambda *_args: None,
                )

    def test_ai_tools_and_execution_reject_other_family_plan(self) -> None:
        plan = self.create_plan()
        actor_id = self.switch_member(other_family=True)
        draft = {"operations": [{
            "action": "set_status", "targetId": plan["id"], "baseUpdatedAt": plan["updated_at"],
            "payload": {"status": "skipped"},
        }]}
        with self.SessionLocal() as db:
            context = ToolContext(db=db, family_id="family-other", user_id=actor_id, conversation_id="test", run_id="test")
            self.assertEqual(meal_plan_read_existing(context, {"ids": [plan["id"]]})["count"], 0)
            with self.assertRaisesRegex(ValueError, "当前家庭"):
                meal_plan_read_by_id(context, {"id": plan["id"]})
            with self.assertRaisesRegex(ValueError, "当前家庭"):
                meal_plan_create_draft(context, {"draft": draft})
            with self.assertRaises(AIConflictError):
                execute_meal_plan_draft(
                    db, family_id="family-other", user_id=actor_id, payload=draft,
                    assert_updated_at_matches=lambda *_args: None,
                )

    def test_member_completion_rejects_stale_version_and_rolls_back_failed_commit(self) -> None:
        plan = self.create_plan()
        self.switch_member()
        updated = self.client.patch(f"/api/food-plan/{plan['id']}", json={"note": "新安排"})
        self.assertEqual(updated.status_code, 200, updated.text)
        stale = self.client.post(f"/api/food-plan/{plan['id']}/complete", json={"food_plan_item_base_updated_at": plan["updated_at"]})
        self.assertEqual(stale.status_code, 409, stale.text)
        self.assertEqual(stale.json()["detail"]["code"], "food_plan_item_stale")
        with fail_next_commit("shared completion failed"):
            with self.assertRaisesRegex(RuntimeError, "shared completion failed"):
                self.client.post(f"/api/food-plan/{plan['id']}/complete", json={"food_plan_item_base_updated_at": updated.json()["updated_at"]})
        with self.SessionLocal() as db:
            item = db.get(FoodPlanItem, plan["id"])
            self.assertEqual(item.status, "planned")
            self.assertIsNone(item.meal_log_id)
            self.assertEqual(db.scalar(select(func.count(MealLog.id))), 0)
