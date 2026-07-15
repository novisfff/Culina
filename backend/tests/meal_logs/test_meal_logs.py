from __future__ import annotations

import unittest
from datetime import date
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import FoodType, MealType, MediaSource, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Food, FoodPlanItem, MediaAsset, Membership, User
from app.services.food_plan_locking import (
    FoodPlanWriteIntent,
    discover_food_plan_write_intents,
    lock_food_plan_write_intents,
    lock_plan_item_after_food,
)
from app.services.meal_log_references import (
    MealLogReferenceError,
    ValidatedMealLogReferences,
    lock_and_validate_meal_log_references,
)
from app.services.meal_log_versions import lock_meal_log_write_targets


class MealLogReferencesTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
            future=True,
        )
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(
            bind=self.engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
            class_=Session,
        )

        with self.SessionLocal() as db:
            self.family = Family(id="family-meal", name="餐食家庭", motto="", location="")
            self.other_family = Family(id="family-other", name="其他家庭", motto="", location="")
            self.user = User(id="user-owner", username="owner", display_name="Owner", avatar_seed="", is_active=True)
            self.member = User(id="user-member", username="member", display_name="Member", avatar_seed="", is_active=True)
            self.inactive_user = User(
                id="user-inactive",
                username="inactive",
                display_name="Inactive",
                avatar_seed="",
                is_active=False,
            )
            self.other_user = User(
                id="user-other",
                username="other",
                display_name="Other",
                avatar_seed="",
                is_active=True,
            )
            self.membership = Membership(
                id="membership-owner",
                family_id=self.family.id,
                user_id=self.user.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            )
            self.member_membership = Membership(
                id="membership-member",
                family_id=self.family.id,
                user_id=self.member.id,
                role=UserRole.MEMBER,
                status=MembershipStatus.ACTIVE,
            )
            self.inactive_membership = Membership(
                id="membership-inactive-user",
                family_id=self.family.id,
                user_id=self.inactive_user.id,
                role=UserRole.MEMBER,
                status=MembershipStatus.ACTIVE,
            )
            self.invited_membership = Membership(
                id="membership-invited",
                family_id=self.family.id,
                user_id="user-invited-missing",
                role=UserRole.MEMBER,
                status=MembershipStatus.INVITED,
            )
            self.other_membership = Membership(
                id="membership-other",
                family_id=self.other_family.id,
                user_id=self.other_user.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            )
            self.food = Food(
                id="food-1",
                family_id=self.family.id,
                name="番茄炒蛋",
                type=FoodType.SELF_MADE,
                category="家常",
                flavor_tags=[],
                scene_tags=[],
                suitable_meal_types=["dinner"],
                source_name="",
                purchase_source="",
                scene="",
                notes="",
                routine_note="",
                stock_quantity=None,
                stock_unit="",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            self.other_food = Food(
                id="food-other-family",
                family_id=self.other_family.id,
                name="外家庭食物",
                type=FoodType.READY_MADE,
                category="外购",
                flavor_tags=[],
                scene_tags=[],
                suitable_meal_types=["lunch"],
                source_name="",
                purchase_source="",
                scene="",
                notes="",
                routine_note="",
                stock_quantity=None,
                stock_unit="",
                favorite=False,
                created_by=self.other_user.id,
                updated_by=self.other_user.id,
            )
            db.add_all(
                [
                    self.family,
                    self.other_family,
                    self.user,
                    self.member,
                    self.inactive_user,
                    self.other_user,
                    self.membership,
                    self.member_membership,
                    self.inactive_membership,
                    self.invited_membership,
                    self.other_membership,
                    self.food,
                    self.other_food,
                ]
            )
            db.commit()

        def override_db():
            db = self.SessionLocal()
            try:
                yield db
            finally:
                db.close()

        def override_auth():
            with self.SessionLocal() as db:
                user = db.get(User, self.user.id)
                membership = db.get(Membership, self.membership.id)
                assert user is not None and membership is not None
                return user, membership

        app.dependency_overrides[get_db] = override_db
        app.dependency_overrides[get_current_auth] = override_auth
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def participant_for_kind(self, kind: str) -> str:
        if kind == "unknown":
            return "user-missing"
        if kind == "inactive_membership":
            with self.SessionLocal() as db:
                membership = db.get(Membership, self.member_membership.id)
                assert membership is not None
                membership.status = MembershipStatus.INVITED
                db.commit()
            return self.member.id
        if kind == "inactive_user":
            return self.inactive_user.id
        if kind == "other_family":
            return self.other_user.id
        raise AssertionError(f"unknown participant kind: {kind}")

    def test_meal_log_references_reject_invalid_food_sets(self) -> None:
        cases = [
            ([], "meal_log_food_required"),
            (["food-1", "food-1"], "duplicate_meal_log_food"),
            (["food-other-family"], "meal_log_food_not_found"),
        ]
        for food_ids, expected_code in cases:
            with self.subTest(food_ids=food_ids):
                with self.SessionLocal() as db:
                    with self.assertRaises(MealLogReferenceError) as raised:
                        lock_and_validate_meal_log_references(
                            db,
                            family_id=self.family.id,
                            actor_user_id=self.user.id,
                            food_ids=food_ids,
                            participant_user_ids=[],
                        )
                    self.assertEqual(raised.exception.code, expected_code)

    def test_meal_log_references_reject_inactive_or_cross_family_participants(self) -> None:
        for kind in ["unknown", "inactive_membership", "inactive_user", "other_family"]:
            with self.subTest(participant_kind=kind):
                with self.SessionLocal() as db:
                    if kind == "inactive_membership":
                        membership = db.get(Membership, self.member_membership.id)
                        assert membership is not None
                        membership.status = MembershipStatus.INVITED
                        db.flush()
                        participant_id = self.member.id
                    else:
                        participant_id = self.participant_for_kind(kind)
                    with self.assertRaises(MealLogReferenceError) as raised:
                        lock_and_validate_meal_log_references(
                            db,
                            family_id=self.family.id,
                            actor_user_id=self.user.id,
                            food_ids=[self.food.id],
                            participant_user_ids=[participant_id],
                        )
                    self.assertEqual(raised.exception.code, "meal_log_participant_not_found")

    def test_meal_log_references_default_actor_and_accept_active_participants(self) -> None:
        with self.SessionLocal() as db:
            references = lock_and_validate_meal_log_references(
                db,
                family_id=self.family.id,
                actor_user_id=self.user.id,
                food_ids=[self.food.id],
                participant_user_ids=[],
            )
            self.assertEqual(references.participant_user_ids, (self.user.id,))
            self.assertEqual(set(references.foods_by_id), {self.food.id})

            references = lock_and_validate_meal_log_references(
                db,
                family_id=self.family.id,
                actor_user_id=self.user.id,
                food_ids=[self.food.id],
                participant_user_ids=[self.member.id, self.user.id, self.user.id],
            )
            self.assertEqual(references.participant_user_ids, tuple(sorted([self.member.id, self.user.id])))

    def test_prelocked_foods_branch_skips_inventory_lock(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, self.food.id)
            assert food is not None
            with patch(
                "app.services.meal_log_references.lock_inventory_targets",
                side_effect=AssertionError("should not re-lock prelocked foods"),
            ):
                references = lock_and_validate_meal_log_references(
                    db,
                    family_id=self.family.id,
                    actor_user_id=self.user.id,
                    food_ids=[self.food.id],
                    participant_user_ids=[self.user.id],
                    prelocked_foods={self.food.id: food},
                )
            self.assertIs(references.foods_by_id[self.food.id], food)

    def test_rest_create_update_and_quick_add_call_shared_helper(self) -> None:
        calls: list[dict] = []

        def tracking_lock(*args, **kwargs):
            calls.append(kwargs)
            food = kwargs.get("prelocked_foods") or {}
            if food:
                foods_by_id = dict(food)
            else:
                with self.SessionLocal() as db:
                    locked = {
                        food_id: db.get(Food, food_id)
                        for food_id in kwargs["food_ids"]
                    }
                foods_by_id = {food_id: food for food_id, food in locked.items() if food is not None}
            participants = tuple(
                sorted({str(value).strip() for value in kwargs["participant_user_ids"] if str(value).strip()})
                or (kwargs["actor_user_id"],)
            )
            return ValidatedMealLogReferences(foods_by_id=foods_by_id, participant_user_ids=participants)

        with patch(
            "app.api.meal_logs.lock_and_validate_meal_log_references",
            side_effect=tracking_lock,
        ):
            create_response = self.client.post(
                "/api/meal-logs",
                json={
                    "date": "2026-05-16",
                    "meal_type": "dinner",
                    "food_entries": [{"food_id": self.food.id, "servings": 1, "note": ""}],
                    "participant_user_ids": [self.user.id],
                    "notes": "",
                    "mood": "",
                    "media_ids": [],
                },
            )
            self.assertEqual(create_response.status_code, 201, create_response.text)
            meal_id = create_response.json()["id"]

            update_response = self.client.patch(
                f"/api/meal-logs/{meal_id}",
                json={
                    "expected_row_version": create_response.json()["row_version"],
                    "participant_user_ids": [self.member.id],
                },
            )
            self.assertEqual(update_response.status_code, 200, update_response.text)

            quick_add = self.client.post(
                "/api/meal-logs/quick-add",
                json={
                    "food_id": self.food.id,
                    "date": "2026-05-17",
                    "meal_type": "lunch",
                    "servings": 1,
                    "note": "quick",
                },
            )
            self.assertEqual(quick_add.status_code, 201, quick_add.text)

        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0]["food_ids"], [self.food.id])
        self.assertEqual(calls[1]["participant_user_ids"], [self.member.id])
        self.assertEqual(calls[2]["food_ids"], [self.food.id])

    def test_create_rejects_empty_and_cross_family_foods(self) -> None:
        empty = self.client.post(
            "/api/meal-logs",
            json={
                "date": "2026-05-16",
                "meal_type": "dinner",
                "food_entries": [],
                "participant_user_ids": [self.user.id],
                "notes": "",
                "mood": "",
                "media_ids": [],
            },
        )
        self.assertEqual(empty.status_code, 422, empty.text)
        self.assertEqual(empty.json()["detail"]["code"], "meal_log_food_required")

        cross = self.client.post(
            "/api/meal-logs",
            json={
                "date": "2026-05-16",
                "meal_type": "dinner",
                "food_entries": [{"food_id": self.other_food.id, "servings": 1, "note": ""}],
                "participant_user_ids": [self.user.id],
                "notes": "",
                "mood": "",
                "media_ids": [],
            },
        )
        self.assertEqual(cross.status_code, 404, cross.text)
        self.assertEqual(cross.json()["detail"]["code"], "meal_log_food_not_found")

    def test_ai_meal_log_executor_calls_shared_helper(self) -> None:
        from app.services.ai_operations.meal_logs import execute_meal_log_draft

        calls: list[dict] = []

        def tracking_lock(db, **kwargs):
            calls.append(kwargs)
            food = db.get(Food, self.food.id)
            assert food is not None
            return ValidatedMealLogReferences(
                foods_by_id={self.food.id: food},
                participant_user_ids=(self.user.id,),
            )

        with self.SessionLocal() as db:
            with patch(
                "app.services.ai_operations.meal_logs.lock_and_validate_meal_log_references",
                side_effect=tracking_lock,
            ):
                result, entity_ids = execute_meal_log_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "date": date.today().isoformat(),
                        "mealType": MealType.DINNER.value,
                        "foods": [{"foodId": self.food.id, "name": self.food.name, "servings": 1}],
                        "participantUserIds": [self.user.id],
                        "notes": "AI",
                        "mood": "",
                        "mediaIds": [],
                    },
                    assert_updated_at_matches=lambda **_kwargs: None,
                )
            db.commit()

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["food_ids"], [self.food.id])
        self.assertEqual(result["notes"], "AI")
        self.assertEqual(len(entity_ids), 1)

    def _create_plan_item(
        self,
        *,
        food_id: str,
        plan_date: date = date(2026, 5, 18),
        status: str = "planned",
        meal_log_id: str | None = None,
    ) -> FoodPlanItem:
        with self.SessionLocal() as db:
            item = FoodPlanItem(
                id=f"food-plan-{food_id}-{status}",
                family_id=self.family.id,
                user_id=self.user.id,
                food_id=food_id,
                plan_date=plan_date,
                meal_type=MealType.DINNER,
                note="plan",
                status=status,
                meal_log_id=meal_log_id,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.commit()
            db.refresh(item)
            return item

    def test_plan_origin_quick_add_completes_one_plan_and_meal_atomically(self) -> None:
        planned = self._create_plan_item(food_id=self.food.id)
        response = self.client.post(
            "/api/meal-logs/quick-add",
            json={
                "food_id": planned.food_id,
                "date": planned.plan_date.isoformat(),
                "meal_type": planned.meal_type.value,
                "servings": 1.5,
                "food_plan_item_id": planned.id,
                "food_plan_item_base_updated_at": planned.updated_at.isoformat(),
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        meal_id = response.json()["id"]
        with self.SessionLocal() as db:
            refreshed = db.get(FoodPlanItem, planned.id)
            assert refreshed is not None
            self.assertEqual(refreshed.status, "cooked")
            self.assertEqual(refreshed.meal_log_id, meal_id)

    def test_completed_plan_returns_existing_meal_id_without_second_meal(self) -> None:
        first = self.client.post(
            "/api/meal-logs",
            json={
                "date": "2026-05-18",
                "meal_type": "dinner",
                "food_entries": [{"food_id": self.food.id, "servings": 1, "note": ""}],
                "participant_user_ids": [self.user.id],
                "notes": "",
                "mood": "",
                "media_ids": [],
            },
        )
        self.assertEqual(first.status_code, 201, first.text)
        meal_id = first.json()["id"]
        cooked = self._create_plan_item(
            food_id=self.food.id,
            status="cooked",
            meal_log_id=meal_id,
        )
        response = self.client.post(
            "/api/meal-logs/quick-add",
            json={
                "food_id": cooked.food_id,
                "date": cooked.plan_date.isoformat(),
                "meal_type": cooked.meal_type.value,
                "servings": 1,
                "food_plan_item_id": cooked.id,
                "food_plan_item_base_updated_at": cooked.updated_at.isoformat(),
            },
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(
            response.json()["detail"],
            {
                "code": "food_plan_item_already_completed",
                "message": "该菜单项已经记录完成",
                "meal_log_id": meal_id,
            },
        )
        second_list = self.client.get("/api/meal-logs")
        self.assertEqual(second_list.status_code, 200, second_list.text)
        self.assertEqual(len(second_list.json()), 1)

    def test_food_plan_lock_order_locks_foods_before_plan_items(self) -> None:
        food_a = self.food
        with self.SessionLocal() as db:
            food_b = Food(
                id="food-2",
                family_id=self.family.id,
                name="青椒肉丝",
                type=FoodType.SELF_MADE,
                category="家常",
                flavor_tags=[],
                scene_tags=[],
                suitable_meal_types=["dinner"],
                source_name="",
                purchase_source="",
                scene="",
                notes="",
                routine_note="",
                stock_quantity=None,
                stock_unit="",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(food_b)
            db.commit()
        item = self._create_plan_item(food_id=food_a.id)

        lock_calls: list[list[str]] = []

        from app.services import food_plan_locking as locking

        original_inventory_lock = locking.lock_inventory_targets

        def tracking_inventory_lock(*args, **kwargs):
            lock_calls.append(list(kwargs.get("food_ids") or []))
            return original_inventory_lock(*args, **kwargs)

        with self.SessionLocal() as db:
            with patch.object(locking, "lock_inventory_targets", side_effect=tracking_inventory_lock):
                intents = discover_food_plan_write_intents(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    intents=[
                        FoodPlanWriteIntent(
                            action="update",
                            item_id=item.id,
                            target_food_id=food_b.id,
                            base_updated_at=None,
                        ),
                        FoodPlanWriteIntent(
                            action="create",
                            item_id=None,
                            target_food_id=food_a.id,
                            base_updated_at=None,
                        ),
                        FoodPlanWriteIntent(
                            action="delete",
                            item_id=item.id,
                            target_food_id=None,
                            base_updated_at=None,
                        ),
                    ],
                )
                # Discover should not lock foods.
                self.assertEqual(lock_calls, [])
                locked = lock_food_plan_write_intents(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    intents=intents,
                )
            self.assertEqual(lock_calls, [sorted([food_a.id, food_b.id])])
            self.assertEqual(set(locked.foods_by_id), {food_a.id, food_b.id})
            self.assertEqual(set(locked.items_by_id), {item.id})

            # lock_plan_item_after_food assumes Food already locked and only locks plan.
            with patch.object(locking, "lock_inventory_targets", side_effect=AssertionError("food already locked")):
                plan_item = lock_plan_item_after_food(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    item_id=item.id,
                    expected_food_id=food_a.id,
                    require_planned=True,
                )
            self.assertEqual(plan_item.id, item.id)

    def test_ai_meal_plan_batch_locks_foods_once_before_plan_items(self) -> None:
        from app.services.ai_operations.meal_plans import execute_meal_plan_draft

        item = self._create_plan_item(food_id=self.food.id)
        food_lock_calls: list[list[str]] = []
        from app.services import food_plan_locking as locking

        original = locking.lock_inventory_targets

        def tracking_lock(*args, **kwargs):
            food_lock_calls.append(list(kwargs.get("food_ids") or []))
            return original(*args, **kwargs)

        with self.SessionLocal() as db:
            with patch.object(locking, "lock_inventory_targets", side_effect=tracking_lock):
                result, entity_ids = execute_meal_plan_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "operations": [
                            {
                                "operationId": "op-create",
                                "action": "create",
                                "payload": {
                                    "foodId": self.food.id,
                                    "date": "2026-05-19",
                                    "mealType": "lunch",
                                    "reason": "batch",
                                },
                            },
                            {
                                "operationId": "op-update",
                                "action": "update",
                                "targetId": item.id,
                                "baseUpdatedAt": item.updated_at.isoformat(),
                                "payload": {
                                    "foodId": self.food.id,
                                    "date": "2026-05-20",
                                    "mealType": "dinner",
                                    "reason": "rebind",
                                },
                            },
                            {
                                "operationId": "op-status",
                                "action": "set_status",
                                "targetId": item.id,
                                "baseUpdatedAt": item.updated_at.isoformat(),
                                "payload": {"status": "skipped"},
                            },
                        ]
                    },
                    assert_updated_at_matches=lambda **_kwargs: None,
                )
            db.commit()

        self.assertEqual(len(food_lock_calls), 1)
        self.assertEqual(food_lock_calls[0], [self.food.id])
        self.assertEqual(len(result["operations"]), 3)
        self.assertTrue(entity_ids)

    def test_rating_only_update_allows_departed_historical_participant(self) -> None:
        create_response = self.client.post(
            "/api/meal-logs",
            json={
                "date": "2026-05-16",
                "meal_type": "dinner",
                "food_entries": [{"food_id": self.food.id, "servings": 1, "note": ""}],
                "participant_user_ids": [self.user.id, self.member.id],
                "notes": "",
                "mood": "",
                "media_ids": [],
            },
        )
        self.assertEqual(create_response.status_code, 201, create_response.text)
        body = create_response.json()
        meal_id = body["id"]
        entry_id = body["food_entries"][0]["id"]

        with self.SessionLocal() as db:
            membership = db.get(Membership, self.member_membership.id)
            assert membership is not None
            # INVITED stands in for a non-active / departed membership.
            membership.status = MembershipStatus.INVITED
            db.commit()

        rating_response = self.client.patch(
            f"/api/meal-logs/{meal_id}",
            json={
                "expected_row_version": body["row_version"],
                "food_entry_ratings": [{"id": entry_id, "rating": 4.5}],
            },
        )
        self.assertEqual(rating_response.status_code, 200, rating_response.text)
        self.assertEqual(float(rating_response.json()["food_entries"][0]["rating"]), 4.5)

        # Explicit participant updates still revalidate membership.
        participant_response = self.client.patch(
            f"/api/meal-logs/{meal_id}",
            json={
                "expected_row_version": rating_response.json()["row_version"],
                "participant_user_ids": [self.user.id, self.member.id],
            },
        )
        self.assertEqual(participant_response.status_code, 404, participant_response.text)

    def test_ai_rate_food_allows_departed_historical_participant(self) -> None:
        from app.models.domain import MealLog, MealLogFood
        from app.services.ai_operations.meal_logs import execute_meal_log_draft

        with self.SessionLocal() as db:
            meal = MealLog(
                id="meal-rate-left",
                family_id=self.family.id,
                date=date(2026, 5, 16),
                meal_type=MealType.DINNER,
                participant_user_ids=[self.user.id, self.member.id],
                notes="",
                mood="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            entry = MealLogFood(
                id="meal-food-rate-left",
                meal_log_id=meal.id,
                food_id=self.food.id,
                servings=1,
                note="",
                rating=None,
            )
            db.add_all([meal, entry])
            membership = db.get(Membership, self.member_membership.id)
            assert membership is not None
            membership.status = MembershipStatus.INVITED
            db.commit()

            result, entity_ids = execute_meal_log_draft(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                payload={
                    "action": "rate_food",
                    "targetId": meal.id,
                    "baseUpdatedAt": meal.updated_at.isoformat(),
                    "payload": {
                        "foodEntryRatings": [{"id": entry.id, "rating": 5}],
                    },
                },
                assert_updated_at_matches=lambda **_kwargs: None,
            )
            db.commit()
            self.assertIn(meal.id, entity_ids)
            self.assertEqual(float(result["food_entries"][0]["rating"]), 5.0)

    def test_ai_meal_log_plan_completion_uses_lock_plan_item_after_food(self) -> None:
        from app.services.ai_operations.meal_logs import execute_meal_log_draft

        planned = self._create_plan_item(food_id=self.food.id)
        with self.SessionLocal() as db:
            with patch(
                "app.services.ai_operations.meal_logs.lock_plan_item_after_food",
                wraps=lock_plan_item_after_food,
            ) as mocked_lock:
                result, _entity_ids = execute_meal_log_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "date": date.today().isoformat(),
                        "mealType": MealType.DINNER.value,
                        "foods": [{"foodId": self.food.id, "name": self.food.name, "servings": 1}],
                        "participantUserIds": [self.user.id],
                        "planItemId": planned.id,
                        "planItemBaseUpdatedAt": planned.updated_at.isoformat(),
                    },
                    assert_updated_at_matches=lambda **_kwargs: None,
                )
                self.assertTrue(mocked_lock.called)
                self.assertTrue(result["id"])
                refreshed = db.get(FoodPlanItem, planned.id)
                assert refreshed is not None
                self.assertEqual(refreshed.status, "cooked")
                self.assertEqual(refreshed.meal_log_id, result["id"])

            # Second completion of already-cooked plan must conflict.
            with self.assertRaises(Exception) as raised:
                execute_meal_log_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "date": date.today().isoformat(),
                        "mealType": MealType.DINNER.value,
                        "foods": [{"foodId": self.food.id, "name": self.food.name, "servings": 1}],
                        "participantUserIds": [self.user.id],
                        "planItemId": planned.id,
                        "planItemBaseUpdatedAt": refreshed.updated_at.isoformat(),
                    },
                    assert_updated_at_matches=lambda **_kwargs: None,
                )
            message = str(raised.exception)
            self.assertTrue(
                "已经记录完成" in message or "已被其他修改更新" in message or "不可完成" in message,
                msg=message,
            )

    def _create_seeded_meal(self) -> dict:
        response = self.client.post(
            "/api/meal-logs",
            json={
                "date": "2026-05-16",
                "meal_type": "dinner",
                "food_entries": [{"food_id": self.food.id, "servings": 1, "note": ""}],
                "participant_user_ids": [self.user.id],
                "notes": "",
                "mood": "",
                "media_ids": [],
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_rating_only_update_bumps_parent_version_once(self) -> None:
        seeded = self._create_seeded_meal()
        response = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={
                "expected_row_version": 1,
                "food_entry_ratings": [{"id": seeded["food_entries"][0]["id"], "rating": 4.5}],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["row_version"], 2)

    def test_stale_detail_update_returns_current_meal_and_hint(self) -> None:
        seeded = self._create_seeded_meal()
        entry_id = seeded["food_entries"][0]["id"]
        first = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={
                "expected_row_version": 1,
                "food_entry_ratings": [{"id": entry_id, "rating": 4.5}],
            },
        )
        self.assertEqual(first.status_code, 200, first.text)
        with self.SessionLocal() as db:
            photo = MediaAsset(
                id="meal-photo-current",
                family_id=self.family.id,
                name="current.png",
                url="/media/family-meal/current.png",
                file_path="family-meal/current.png",
                source=MediaSource.UPLOAD,
                alt="current meal photo",
                entity_type="meal_log",
                entity_id=seeded["id"],
                created_by=self.user.id,
            )
            db.add(photo)
            db.commit()

        response = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={"expected_row_version": 1, "notes": "过期草稿"},
        )
        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "meal_log_stale")
        self.assertEqual(detail["current"]["row_version"], 2)
        self.assertEqual(float(detail["current"]["food_entries"][0]["rating"]), 4.5)
        self.assertEqual(detail["current"]["photos"][0]["id"], "meal-photo-current")
        self.assertEqual(detail["recovery_hint"], "refresh_and_review")

    def test_detail_field_updates_bump_parent_version_once(self) -> None:
        seeded = self._create_seeded_meal()
        version = seeded["row_version"]

        participants = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={"expected_row_version": version, "participant_user_ids": [self.user.id, self.member.id]},
        )
        self.assertEqual(participants.status_code, 200, participants.text)
        self.assertEqual(participants.json()["row_version"], version + 1)
        version = participants.json()["row_version"]

        notes = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={"expected_row_version": version, "notes": "今天很好吃"},
        )
        self.assertEqual(notes.status_code, 200, notes.text)
        self.assertEqual(notes.json()["row_version"], version + 1)
        version = notes.json()["row_version"]

        mood = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={"expected_row_version": version, "mood": "开心"},
        )
        self.assertEqual(mood.status_code, 200, mood.text)
        self.assertEqual(mood.json()["row_version"], version + 1)

    def test_media_only_update_bumps_parent_version_once(self) -> None:
        seeded = self._create_seeded_meal()
        with self.SessionLocal() as db:
            photo = MediaAsset(
                id="meal-photo-media-only",
                family_id=self.family.id,
                name="media-only.png",
                url="/media/family-meal/media-only.png",
                file_path="family-meal/media-only.png",
                source=MediaSource.UPLOAD,
                alt="media only",
                created_by=self.user.id,
            )
            db.add(photo)
            db.commit()

        response = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={"expected_row_version": 1, "media_ids": ["meal-photo-media-only"]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["row_version"], 2)
        self.assertEqual(response.json()["photos"][0]["id"], "meal-photo-media-only")

    def test_same_user_repeated_rating_updates_bump_once_each(self) -> None:
        seeded = self._create_seeded_meal()
        entry_id = seeded["food_entries"][0]["id"]
        first = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={
                "expected_row_version": 1,
                "food_entry_ratings": [{"id": entry_id, "rating": 4.0}],
            },
        )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["row_version"], 2)

        second = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={
                "expected_row_version": 2,
                "food_entry_ratings": [{"id": entry_id, "rating": 4.5}],
            },
        )
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["row_version"], 3)
        self.assertEqual(float(second.json()["food_entries"][0]["rating"]), 4.5)

    def test_update_without_expected_row_version_returns_422(self) -> None:
        seeded = self._create_seeded_meal()
        response = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={"notes": "缺少版本"},
        )
        self.assertEqual(response.status_code, 422, response.text)

    def test_stale_data_error_returns_complete_current_payload(self) -> None:
        from sqlalchemy.orm.exc import StaleDataError

        seeded = self._create_seeded_meal()
        entry_id = seeded["food_entries"][0]["id"]
        first = self.client.patch(
            f"/api/meal-logs/{seeded['id']}",
            json={
                "expected_row_version": 1,
                "food_entry_ratings": [{"id": entry_id, "rating": 4.5}],
            },
        )
        self.assertEqual(first.status_code, 200, first.text)
        with self.SessionLocal() as db:
            photo = MediaAsset(
                id="meal-photo-stale-data",
                family_id=self.family.id,
                name="stale.png",
                url="/media/family-meal/stale.png",
                file_path="family-meal/stale.png",
                source=MediaSource.UPLOAD,
                alt="stale photo",
                entity_type="meal_log",
                entity_id=seeded["id"],
                created_by=self.user.id,
            )
            db.add(photo)
            db.commit()

        with patch(
            "app.api.meal_logs.commit_session",
            side_effect=StaleDataError("UPDATE meal_logs"),
        ):
            response = self.client.patch(
                f"/api/meal-logs/{seeded['id']}",
                json={"expected_row_version": 2, "notes": "flush 冲突"},
            )
        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "meal_log_stale")
        self.assertEqual(detail["current"]["row_version"], 2)
        self.assertEqual(float(detail["current"]["food_entries"][0]["rating"]), 4.5)
        self.assertEqual(detail["current"]["photos"][0]["id"], "meal-photo-stale-data")
        self.assertEqual(detail["current"]["food_entries"][0]["food_name"], self.food.name)
        self.assertIn("deduction_suggestions", detail["current"])
        self.assertEqual(detail["recovery_hint"], "refresh_and_review")

    def test_lock_meal_log_write_targets_locks_foods_before_meal_log(self) -> None:
        seeded = self._create_seeded_meal()
        lock_calls: list[str] = []

        from app.services import meal_log_versions as versions

        original_inventory_lock = versions.lock_inventory_targets
        original_scalar = Session.scalar

        def tracking_inventory_lock(*args, **kwargs):
            lock_calls.append("food")
            return original_inventory_lock(*args, **kwargs)

        def tracking_scalar(self, statement, *args, **kwargs):
            compiled = str(statement)
            if "FOR UPDATE" in compiled.upper() and "meal_logs" in compiled.lower():
                lock_calls.append("meal_log")
            return original_scalar(self, statement, *args, **kwargs)

        with self.SessionLocal() as db:
            with patch.object(versions, "lock_inventory_targets", side_effect=tracking_inventory_lock):
                with patch.object(Session, "scalar", tracking_scalar):
                    locked = lock_meal_log_write_targets(
                        db,
                        family_id=self.family.id,
                        meal_log_id=seeded["id"],
                    )
            self.assertEqual(locked.meal_log.id, seeded["id"])
            self.assertEqual(set(locked.discovered_food_ids), {self.food.id})
            self.assertEqual(set(locked.foods_by_id), {self.food.id})
            self.assertEqual(lock_calls, ["food", "meal_log"])


    def test_complete_food_plan_item_lock_order_foods_before_meal_log_before_plan(self) -> None:
        from unittest.mock import patch
        from app.services.food_plan_completion import CompleteFoodPlanItemCommand, complete_food_plan_item
        from app.services.inventory_operation_locking import lock_inventory_targets as real_inventory_lock

        target = self._create_seeded_meal()
        plan = self._create_plan_item(food_id=self.food.id, plan_date=date.fromisoformat(target["date"]))
        lock_calls: list[str] = []
        original_scalar = Session.scalar

        def tracking_inventory_lock(*args, **kwargs):
            lock_calls.append("food")
            return real_inventory_lock(*args, **kwargs)

        def tracking_scalar(self, statement, *args, **kwargs):
            compiled = str(statement)
            upper = compiled.upper()
            if "FOR UPDATE" in upper and "meal_logs" in compiled.lower():
                lock_calls.append("meal_log")
            if "FOR UPDATE" in upper and "food_plan_items" in compiled.lower():
                lock_calls.append("plan")
            return original_scalar(self, statement, *args, **kwargs)

        with self.SessionLocal() as db:
            item = db.get(FoodPlanItem, plan.id)
            assert item is not None
            with (
                patch(
                    "app.services.food_plan_completion.lock_inventory_targets",
                    side_effect=tracking_inventory_lock,
                ),
                # Foods already held; MealLog path must not take a second Food FOR UPDATE pass.
                patch(
                    "app.services.meal_log_versions.lock_inventory_targets",
                    side_effect=AssertionError("must not re-lock Foods under plan target append"),
                ),
                patch.object(Session, "scalar", tracking_scalar),
            ):
                complete_food_plan_item(
                    db,
                    CompleteFoodPlanItemCommand(
                        family_id=self.family.id,
                        actor_user_id=self.user.id,
                        item_id=plan.id,
                        food_plan_item_base_updated_at=item.updated_at,
                        target_meal_log_id=target["id"],
                        expected_meal_log_row_version=target["row_version"],
                    ),
                )
                db.commit()
        self.assertEqual(lock_calls.count("food"), 1)
        self.assertIn("meal_log", lock_calls)
        self.assertIn("plan", lock_calls)
        self.assertLess(lock_calls.index("food"), lock_calls.index("meal_log"))
        self.assertLess(lock_calls.index("meal_log"), lock_calls.index("plan"))

    def test_lock_meal_log_write_targets_prelocked_foods_skips_inventory_lock(self) -> None:
        seeded = self._create_seeded_meal()
        with self.SessionLocal() as db:
            food = db.get(Food, self.food.id)
            assert food is not None
            with patch(
                "app.services.meal_log_versions.lock_inventory_targets",
                side_effect=AssertionError("should not re-lock prelocked foods"),
            ):
                locked = lock_meal_log_write_targets(
                    db,
                    family_id=self.family.id,
                    meal_log_id=seeded["id"],
                    additional_food_ids=[self.food.id],
                    prelocked_foods={self.food.id: food},
                )
            self.assertEqual(locked.meal_log.id, seeded["id"])
            self.assertEqual(set(locked.discovered_food_ids), {self.food.id})
            self.assertIs(locked.foods_by_id[self.food.id], food)


if __name__ == "__main__":
    unittest.main()
