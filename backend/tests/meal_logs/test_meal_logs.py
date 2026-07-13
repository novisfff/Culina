from __future__ import annotations

import unittest
from datetime import date
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.enums import FoodType, MealType, MembershipStatus, UserRole
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Food, Membership, User
from app.services.meal_log_references import (
    MealLogReferenceError,
    ValidatedMealLogReferences,
    lock_and_validate_meal_log_references,
)


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
                json={"participant_user_ids": [self.member.id]},
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


if __name__ == "__main__":
    unittest.main()
