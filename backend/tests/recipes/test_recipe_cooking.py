from dataclasses import replace
from datetime import datetime, timezone
from unittest.mock import patch

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from ._support import *

from app.core.enums import ActivityHighlightKind, FoodType, MembershipStatus, UserRole
from app.models.domain import ActivityLog, Food, FoodPlanItem, Membership, Recipe, User
from app.schemas.recipes import CookRecipeResponse
from app.services.recipe_cook_completion import (
    CompletionConflict,
    RecipeCookCompletionCommand,
    claim_completion,
    complete_recipe_cook,
    encode_completion_result,
    ensure_completion_food_after_claim,
    hash_completion_command,
    load_completion_replay_if_present,
)


def _make_completion_command(**overrides) -> RecipeCookCompletionCommand:
    base = dict(
        completion_request_id="req-completion-1",
        family_id="family-test",
        actor_user_id="user-test",
        recipe_id="recipe-1",
        cook_date=date(2026, 5, 14),
        meal_type=MealType.DINNER,
        servings=Decimal("2"),
        participant_user_ids=("user-a",),
        notes="",
        food_plan_item_id=None,
        food_plan_item_base_updated_at=None,
        result_note="",
        adjustments="",
        rating=None,
        allow_partial_inventory_deduction=False,
        inventory_expectation=None,
    )
    base.update(overrides)
    return RecipeCookCompletionCommand(**base)


class RecipeRecipeCookingTestCase(RecipeApiTestCase):
        def assert_highlight_kinds(
            self,
            expected: list[ActivityHighlightKind],
        ) -> None:
            with self.SessionLocal() as db:
                rows = list(
                    db.scalars(
                        select(ActivityLog)
                        .where(
                            ActivityLog.family_id == self.family.id,
                            ActivityLog.highlight_kind.is_not(None),
                        )
                        .order_by(ActivityLog.created_at, ActivityLog.id)
                    )
                )
            self.assertEqual([row.highlight_kind for row in rows], expected)

        def test_completion_hash_is_stable_for_participant_set_and_decimal_spelling(self) -> None:
            first = _make_completion_command(
                servings=Decimal("2.00"),
                participant_user_ids=("user-b", "user-a", "user-a"),
            )
            second = _make_completion_command(
                servings=Decimal("2"),
                participant_user_ids=("user-a", "user-b"),
            )
            self.assertEqual(hash_completion_command(first), hash_completion_command(second))

        def test_completion_hash_changes_for_business_inputs(self) -> None:
            base = _make_completion_command(notes="少盐")
            self.assertNotEqual(
                hash_completion_command(base),
                hash_completion_command(replace(base, notes="正常盐")),
            )

        def test_completion_hash_excludes_request_id(self) -> None:
            first = _make_completion_command(completion_request_id="req-a")
            second = _make_completion_command(completion_request_id="req-b")
            self.assertEqual(hash_completion_command(first), hash_completion_command(second))

        def test_encode_completion_result_envelope_omits_replayed(self) -> None:
            response = CookRecipeResponse(
                recipe_id="recipe-1",
                consumed_items=[],
                shortages=[],
                meal_log_id="meal-1",
                cook_log_id="cook-1",
                replayed=True,
            )
            envelope = encode_completion_result(response)
            self.assertEqual(envelope["version"], 1)
            self.assertNotIn("replayed", envelope["response"])
            self.assertEqual(envelope["response"]["recipe_id"], "recipe-1")
            self.assertEqual(envelope["response"]["cook_log_id"], "cook-1")

        def test_unknown_result_envelope_never_reexecutes(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            request_hash = "a" * 64
            with self.SessionLocal() as db:
                completed = RecipeCookLog(
                    id="cook-completion-unsupported-version",
                    family_id=self.family.id,
                    recipe_id=recipe["id"],
                    cook_date=date(2026, 5, 14),
                    meal_type=MealType.DINNER,
                    servings=Decimal("2"),
                    result_note="",
                    adjustments="",
                    rating=None,
                    completion_request_id="req-unsupported-version",
                    completion_request_hash=request_hash,
                    completion_result_json={"version": 99, "response": {}},
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(completed)
                db.commit()

                with self.assertRaises(CompletionConflict) as raised:
                    load_completion_replay_if_present(
                        db,
                        family_id=self.family.id,
                        completion_request_id="req-unsupported-version",
                        request_hash=request_hash,
                    )
                self.assertEqual(raised.exception.code, "completion_result_version_unsupported")

        def test_missing_result_envelope_never_reexecutes(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            request_hash = "b" * 64
            with self.SessionLocal() as db:
                pending = RecipeCookLog(
                    id="cook-completion-missing-result",
                    family_id=self.family.id,
                    recipe_id=recipe["id"],
                    cook_date=date(2026, 5, 14),
                    meal_type=MealType.DINNER,
                    servings=Decimal("2"),
                    result_note="",
                    adjustments="",
                    rating=None,
                    completion_request_id="req-missing-result",
                    completion_request_hash=request_hash,
                    completion_result_json=None,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(pending)
                db.commit()

                with self.assertRaises(CompletionConflict) as raised:
                    load_completion_replay_if_present(
                        db,
                        family_id=self.family.id,
                        completion_request_id="req-missing-result",
                        request_hash=request_hash,
                    )
                self.assertEqual(raised.exception.code, "completion_result_version_unsupported")

        def test_same_id_same_hash_returns_replayed_true(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            response = CookRecipeResponse(
                recipe_id=recipe["id"],
                consumed_items=[],
                shortages=[],
                meal_log_id="meal-replay-1",
                cook_log_id="cook-replay-1",
            )
            request_hash = "c" * 64
            with self.SessionLocal() as db:
                completed = RecipeCookLog(
                    id="cook-completion-replay-ok",
                    family_id=self.family.id,
                    recipe_id=recipe["id"],
                    cook_date=date(2026, 5, 14),
                    meal_type=MealType.DINNER,
                    servings=Decimal("2"),
                    result_note="",
                    adjustments="",
                    rating=None,
                    completion_request_id="req-replay-ok",
                    completion_request_hash=request_hash,
                    completion_result_json=encode_completion_result(response),
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(completed)
                db.commit()

                replayed = load_completion_replay_if_present(
                    db,
                    family_id=self.family.id,
                    completion_request_id="req-replay-ok",
                    request_hash=request_hash,
                )
            self.assertIsNotNone(replayed)
            assert replayed is not None
            self.assertIs(replayed.replayed, True)
            self.assertEqual(replayed.recipe_id, recipe["id"])
            self.assertEqual(replayed.cook_log_id, "cook-replay-1")
            self.assertEqual(replayed.meal_log_id, "meal-replay-1")

        def test_same_id_different_hash_raises_idempotency_key_reused(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            with self.SessionLocal() as db:
                completed = RecipeCookLog(
                    id="cook-completion-hash-mismatch",
                    family_id=self.family.id,
                    recipe_id=recipe["id"],
                    cook_date=date(2026, 5, 14),
                    meal_type=MealType.DINNER,
                    servings=Decimal("2"),
                    result_note="",
                    adjustments="",
                    rating=None,
                    completion_request_id="req-hash-mismatch",
                    completion_request_hash="d" * 64,
                    completion_result_json=encode_completion_result(
                        CookRecipeResponse(recipe_id=recipe["id"])
                    ),
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(completed)
                db.commit()

                with self.assertRaises(CompletionConflict) as raised:
                    load_completion_replay_if_present(
                        db,
                        family_id=self.family.id,
                        completion_request_id="req-hash-mismatch",
                        request_hash="e" * 64,
                    )
                self.assertEqual(raised.exception.code, "idempotency_key_reused")

        def test_claim_completion_inserts_pending_log(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            command = _make_completion_command(
                family_id=self.family.id,
                actor_user_id=self.user.id,
                recipe_id=recipe["id"],
                completion_request_id="req-claim-1",
                food_plan_item_base_updated_at=datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc),
                result_note="完成",
                adjustments="少油",
                rating=4,
            )
            request_hash = hash_completion_command(command)
            with self.SessionLocal() as db:
                cook_log = claim_completion(db, command=command, request_hash=request_hash)
                db.commit()
                self.assertEqual(cook_log.completion_request_id, "req-claim-1")
                self.assertEqual(cook_log.completion_request_hash, request_hash)
                self.assertIsNone(cook_log.meal_log_id)
                self.assertIsNone(cook_log.completion_result_json)
                self.assertEqual(cook_log.result_note, "完成")
                self.assertEqual(cook_log.rating, 4)
                self.assertEqual(cook_log.created_by, self.user.id)

            # Claim exists but result is not written yet → unsupported, never re-executes.
            with self.SessionLocal() as db:
                with self.assertRaises(CompletionConflict) as raised:
                    load_completion_replay_if_present(
                        db,
                        family_id=self.family.id,
                        completion_request_id="req-claim-1",
                        request_hash=request_hash,
                    )
                self.assertEqual(raised.exception.code, "completion_result_version_unsupported")

        def test_recipe_cook_log_completion_fields_are_nullable_for_history(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            with self.SessionLocal() as db:
                historical = RecipeCookLog(
                    id="cook-historical-completion-nulls",
                    family_id=self.family.id,
                    recipe_id=recipe["id"],
                    cook_date=date(2026, 5, 14),
                    meal_type=MealType.DINNER,
                    servings=Decimal("2"),
                    result_note="历史记录",
                    adjustments="",
                    rating=None,
                    completion_request_id=None,
                    completion_request_hash=None,
                    completion_result_json=None,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(historical)
                db.flush()
                self.assertIsNone(historical.completion_request_id)
                self.assertIsNone(historical.completion_request_hash)
                self.assertIsNone(historical.completion_result_json)
                db.commit()

        def test_cook_response_defaults_replayed_false(self) -> None:
            response = CookRecipeResponse(
                recipe_id="recipe-1",
                consumed_items=[],
                shortages=[],
                meal_log_id="meal-1",
                cook_log_id="cook-1",
            )
            self.assertIs(response.replayed, False)

        def _seed_full_inventory(self, *, tomato_id: str, egg_id: str, tomato_qty: str = "2", egg_qty: str = "3") -> None:
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        InventoryItem(
                            id=tomato_id,
                            family_id=self.family.id,
                            ingredient_id=self.tomato.id,
                            quantity=Decimal(tomato_qty),
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
                            id=egg_id,
                            family_id=self.family.id,
                            ingredient_id=self.egg.id,
                            quantity=Decimal(egg_qty),
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

        def _completion_command_for_recipe(self, recipe_id: str, **overrides) -> RecipeCookCompletionCommand:
            base = dict(
                completion_request_id="req-service-completion-1",
                family_id=self.family.id,
                actor_user_id=self.user.id,
                recipe_id=recipe_id,
                cook_date=date(2026, 5, 14),
                meal_type=MealType.DINNER,
                servings=Decimal("2"),
                participant_user_ids=(self.user.id,),
                notes="service cook",
                food_plan_item_id=None,
                food_plan_item_base_updated_at=None,
                result_note="完成",
                adjustments="少油",
                rating=4,
                allow_partial_inventory_deduction=False,
                inventory_expectation=None,
            )
            base.update(overrides)
            return RecipeCookCompletionCommand(**base)

        def test_complete_recipe_cook_creates_all_business_results(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            self._seed_full_inventory(
                tomato_id="inventory-tomato-service",
                egg_id="inventory-egg-service",
            )
            command = self._completion_command_for_recipe(recipe["id"])

            with self.SessionLocal() as db:
                result = complete_recipe_cook(db, command)
                db.commit()

                self.assertIs(result.replayed, False)
                self.assertIsNotNone(result.meal_log_id)
                self.assertIsNotNone(result.cook_log_id)
                cook_log = db.get(RecipeCookLog, result.cook_log_id)
                assert cook_log is not None
                self.assertEqual(cook_log.meal_log_id, result.meal_log_id)
                self.assertEqual(cook_log.result_note, "完成")
                self.assertEqual(cook_log.rating, 4)
                self.assertIsNotNone(cook_log.completion_result_json)

                meal = db.get(MealLog, result.meal_log_id)
                assert meal is not None
                self.assertEqual(meal.mood, "")
                self.assertEqual(meal.notes, "service cook")
                self.assertEqual(meal.participant_user_ids, [self.user.id])
                self.assertEqual(len(meal.food_entries), 1)
                self.assertEqual(meal.food_entries[0].note, "")
                self.assertEqual(meal.food_entries[0].servings, command.servings)
                self.assertIsNone(meal.food_entries[0].rating)

                tomato = db.get(InventoryItem, "inventory-tomato-service")
                egg = db.get(InventoryItem, "inventory-egg-service")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.consumed_quantity, Decimal("2.00"))
                self.assertEqual(egg.consumed_quantity, Decimal("3.00"))

                activity_count = db.scalar(
                    select(func.count()).select_from(ActivityLog).where(
                        ActivityLog.family_id == self.family.id,
                        ActivityLog.highlight_kind == ActivityHighlightKind.MEAL,
                    )
                )
                self.assertEqual(activity_count, 1)

        def test_blocked_shortage_claims_nothing_and_writes_nothing(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            command = self._completion_command_for_recipe(
                recipe["id"],
                completion_request_id="req-service-shortage",
            )

            with self.SessionLocal() as db:
                result = complete_recipe_cook(db, command)
                db.commit()

                self.assertIsNone(result.meal_log_id)
                self.assertIsNone(result.cook_log_id)
                self.assertTrue(result.shortages)
                self.assertEqual(
                    db.scalar(select(func.count()).select_from(RecipeCookLog)),
                    0,
                )
                self.assertEqual(
                    db.scalar(select(func.count()).select_from(MealLog)),
                    0,
                )
                self.assertEqual(
                    db.scalar(
                        select(func.count()).select_from(ActivityLog).where(
                            ActivityLog.family_id == self.family.id,
                            ActivityLog.highlight_kind == ActivityHighlightKind.MEAL,
                        )
                    ),
                    0,
                )

        def test_plan_completion_updates_same_meal_id(self) -> None:
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            plan_response = self.client.post(
                "/api/recipe-plan",
                json={"recipe_id": recipe_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan_payload = plan_response.json()
            plan_id = plan_payload["id"]
            base_updated_at = datetime.fromisoformat(plan_payload["updated_at"].replace("Z", "+00:00"))
            self._seed_full_inventory(
                tomato_id="inventory-tomato-plan-service",
                egg_id="inventory-egg-plan-service",
            )
            command = self._completion_command_for_recipe(
                recipe_id,
                completion_request_id="req-service-plan",
                food_plan_item_id=plan_id,
                food_plan_item_base_updated_at=base_updated_at,
            )

            with self.SessionLocal() as db:
                result = complete_recipe_cook(db, command)
                db.commit()

                plan = db.get(FoodPlanItem, plan_id)
                assert plan is not None
                self.assertEqual(plan.status, "cooked")
                self.assertEqual(plan.meal_log_id, result.meal_log_id)
                self.assertIsNotNone(plan.completed_at)

        def test_complete_recipe_cook_forced_failure_rolls_back_everything(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rollback",
                egg_id="inventory-egg-rollback",
            )
            command = self._completion_command_for_recipe(
                recipe["id"],
                completion_request_id="req-service-rollback",
            )

            with self.SessionLocal() as db:
                with patch(
                    "app.services.recipe_cook_completion.record_completion_activity",
                    side_effect=RuntimeError("forced completion failure"),
                ):
                    with self.assertRaises(RuntimeError):
                        complete_recipe_cook(db, command)
                db.rollback()

                tomato = db.get(InventoryItem, "inventory-tomato-rollback")
                egg = db.get(InventoryItem, "inventory-egg-rollback")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.consumed_quantity, Decimal("0"))
                self.assertEqual(egg.consumed_quantity, Decimal("0"))
                self.assertEqual(db.scalar(select(func.count()).select_from(RecipeCookLog)), 0)
                self.assertEqual(db.scalar(select(func.count()).select_from(MealLog)), 0)
                self.assertEqual(
                    db.scalar(
                        select(func.count()).select_from(ActivityLog).where(
                            ActivityLog.family_id == self.family.id,
                            ActivityLog.highlight_kind == ActivityHighlightKind.MEAL,
                        )
                    ),
                    0,
                )

        def test_claim_integrity_error_recovers_to_replay(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            self._seed_full_inventory(
                tomato_id="inventory-tomato-claim-race",
                egg_id="inventory-egg-claim-race",
            )
            command = self._completion_command_for_recipe(
                recipe["id"],
                completion_request_id="req-claim-race",
            )
            request_hash = hash_completion_command(command)
            winner_response = CookRecipeResponse(
                recipe_id=recipe["id"],
                consumed_items=[],
                shortages=[],
                meal_log_id="meal-claim-race-winner",
                cook_log_id="cook-claim-race-winner",
            )
            with self.SessionLocal() as db:
                db.add(
                    RecipeCookLog(
                        id="cook-claim-race-winner",
                        family_id=self.family.id,
                        recipe_id=recipe["id"],
                        cook_date=command.cook_date,
                        meal_type=command.meal_type,
                        servings=command.servings,
                        result_note=command.result_note,
                        adjustments=command.adjustments,
                        rating=command.rating,
                        completion_request_id=command.completion_request_id,
                        completion_request_hash=request_hash,
                        completion_result_json=encode_completion_result(winner_response),
                        meal_log_id="meal-claim-race-winner",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.commit()

            load_calls = {"n": 0}
            real_load = load_completion_replay_if_present

            def load_skipping_early_hits(*args, **kwargs):
                load_calls["n"] += 1
                # First two lookups simulate the race window before the winner is visible.
                if load_calls["n"] <= 2:
                    return None
                return real_load(*args, **kwargs)

            with self.SessionLocal() as db:
                with (
                    patch(
                        "app.services.recipe_cook_completion.load_completion_replay_if_present",
                        side_effect=load_skipping_early_hits,
                    ),
                    patch(
                        "app.services.recipe_cook_completion.claim_completion",
                        side_effect=IntegrityError("INSERT", {}, Exception("unique")),
                    ),
                ):
                    result = complete_recipe_cook(db, command)

            self.assertIs(result.replayed, True)
            self.assertEqual(result.cook_log_id, "cook-claim-race-winner")
            self.assertEqual(result.meal_log_id, "meal-claim-race-winner")
            with self.SessionLocal() as db:
                tomato = db.get(InventoryItem, "inventory-tomato-claim-race")
                egg = db.get(InventoryItem, "inventory-egg-claim-race")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.consumed_quantity, Decimal("0"))
                self.assertEqual(egg.consumed_quantity, Decimal("0"))
                self.assertEqual(
                    db.scalar(select(func.count()).select_from(RecipeCookLog)),
                    1,
                )

        def test_ensure_completion_food_does_not_rebind_unlocked_orphan(self) -> None:
            recipe = self.create_recipe(auto_create_food=False, title="番茄炒蛋-orphan")
            with self.SessionLocal() as db:
                orphan = Food(
                    id="food-orphan-unlocked",
                    family_id=self.family.id,
                    name=recipe["title"],
                    type=FoodType.SELF_MADE.value,
                    category="家常菜",
                    flavor_tags=[],
                    scene_tags=[],
                    suitable_meal_types=[],
                    source_name="",
                    purchase_source="",
                    scene="",
                    notes="",
                    routine_note="",
                    favorite=False,
                    recipe_id=None,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(orphan)
                db.commit()

            self._seed_full_inventory(
                tomato_id="inventory-tomato-orphan",
                egg_id="inventory-egg-orphan",
            )
            command = self._completion_command_for_recipe(
                recipe["id"],
                completion_request_id="req-orphan-food",
            )
            with self.SessionLocal() as db:
                result = complete_recipe_cook(db, command)
                db.commit()
                meal = db.get(MealLog, result.meal_log_id)
                assert meal is not None
                food_id = meal.food_entries[0].food_id
                self.assertNotEqual(food_id, "food-orphan-unlocked")
                orphan = db.get(Food, "food-orphan-unlocked")
                assert orphan is not None
                self.assertIsNone(orphan.recipe_id)
                linked = db.get(Food, food_id)
                assert linked is not None
                self.assertEqual(linked.recipe_id, recipe["id"])

            # Helper unit: create-only when locked set has no linked food.
            with self.SessionLocal() as db:
                recipe_row = db.scalar(select(Recipe).where(Recipe.id == recipe["id"]))
                assert recipe_row is not None
                # Detach linked food so ensure path runs again against orphan.
                for food in list(db.scalars(select(Food).where(Food.recipe_id == recipe["id"]))):
                    food.recipe_id = None
                db.flush()
                created = ensure_completion_food_after_claim(
                    db,
                    recipe=recipe_row,
                    command=command,
                    locked_foods={},
                )
                orphan = db.get(Food, "food-orphan-unlocked")
                assert orphan is not None
                self.assertIsNone(orphan.recipe_id)
                self.assertNotEqual(created.id, "food-orphan-unlocked")
                self.assertEqual(created.recipe_id, recipe["id"])
                db.rollback()

        def test_replay_after_participant_membership_deactivated(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            self._seed_full_inventory(
                tomato_id="inventory-tomato-participant-replay",
                egg_id="inventory-egg-participant-replay",
                tomato_qty="4",
                egg_qty="6",
            )
            with self.SessionLocal() as db:
                guest = User(
                    id="user-guest-replay",
                    username="guest-replay",
                    display_name="Guest",
                    avatar_seed="",
                    is_active=True,
                )
                membership = Membership(
                    id="membership-guest-replay",
                    family_id=self.family.id,
                    user_id=guest.id,
                    role=UserRole.MEMBER,
                    status=MembershipStatus.ACTIVE,
                )
                db.add_all([guest, membership])
                db.commit()

            command = self._completion_command_for_recipe(
                recipe["id"],
                completion_request_id="req-participant-replay",
                participant_user_ids=(self.user.id, "user-guest-replay"),
            )
            with self.SessionLocal() as db:
                first = complete_recipe_cook(db, command)
                db.commit()
                self.assertIs(first.replayed, False)
                membership = db.get(Membership, "membership-guest-replay")
                assert membership is not None
                membership.status = MembershipStatus.INVITED
                db.commit()

            with self.SessionLocal() as db:
                second = complete_recipe_cook(db, command)
            self.assertIs(second.replayed, True)
            self.assertEqual(second.cook_log_id, first.cook_log_id)
            self.assertEqual(second.meal_log_id, first.meal_log_id)

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

                # Plan create is meal_plan; cook with inventory + plan completion + meal log is exactly one meal.
                rows = list(
                    db.scalars(
                        select(ActivityLog)
                        .where(
                            ActivityLog.family_id == self.family.id,
                            ActivityLog.highlight_kind.is_not(None),
                        )
                        .order_by(ActivityLog.created_at, ActivityLog.id)
                    )
                )
                self.assertEqual(
                    [row.highlight_kind for row in rows],
                    [ActivityHighlightKind.MEAL_PLAN, ActivityHighlightKind.MEAL],
                )
                meal_rows = [row for row in rows if row.highlight_kind is ActivityHighlightKind.MEAL]
                self.assertEqual(len(meal_rows), 1)
                self.assertEqual(meal_rows[0].highlight_summary, "完成 番茄炒蛋 并记录用餐")

        def test_cook_recipe_create_meal_log_false_still_records_meal(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-no-meal",
                egg_id="inventory-egg-no-meal",
            )

            cook_response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json={
                    "servings": 2,
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "create_meal_log": False,
                },
            )
            self.assertEqual(cook_response.status_code, 200, cook_response.text)
            payload = cook_response.json()
            self.assertIsNotNone(payload["meal_log_id"])
            self.assertIsNotNone(payload["cook_log_id"])

            with self.SessionLocal() as db:
                meal_rows = list(
                    db.scalars(
                        select(ActivityLog)
                        .where(
                            ActivityLog.family_id == self.family.id,
                            ActivityLog.highlight_kind == ActivityHighlightKind.MEAL,
                        )
                        .order_by(ActivityLog.created_at, ActivityLog.id)
                    )
                )
                self.assertEqual(len(meal_rows), 1)
                self.assertEqual(meal_rows[0].highlight_summary, "完成 番茄炒蛋 并记录用餐")

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

        def test_cook_preview_partial_deduction_returns_batches_and_shortages(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            today = date.today()
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        InventoryItem(
                            id="inventory-tomato-partial-preview",
                            family_id=self.family.id,
                            ingredient_id=self.tomato.id,
                            quantity=Decimal("1"),
                            consumed_quantity=Decimal("0"),
                            unit="个",
                            status=InventoryStatus.FRESH,
                            purchase_date=today,
                            storage_location="冷藏",
                            notes="",
                            low_stock_threshold=Decimal("0"),
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        InventoryItem(
                            id="inventory-egg-partial-preview",
                            family_id=self.family.id,
                            ingredient_id=self.egg.id,
                            quantity=Decimal("1"),
                            consumed_quantity=Decimal("0"),
                            unit="个",
                            status=InventoryStatus.FRESH,
                            purchase_date=today,
                            storage_location="冷藏",
                            notes="",
                            low_stock_threshold=Decimal("0"),
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                    ]
                )
                db.commit()

            response = self.client.post(
                f"/api/recipes/{recipe['id']}/cook-preview",
                json={"servings": 2, "create_meal_log": True, "allow_partial_inventory_deduction": True},
            )
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertEqual({item["ingredient_name"] for item in payload["shortages"]}, {"番茄", "鸡蛋"})
            tomato_preview = next(item for item in payload["preview_items"] if item["ingredient_id"] == self.tomato.id)
            egg_preview = next(item for item in payload["preview_items"] if item["ingredient_id"] == self.egg.id)
            self.assertEqual(tomato_preview["deduction_note"], "库存不足，已扣减现有库存，缺少部分仅记录提醒")
            self.assertEqual(tomato_preview["batches"][0]["quantity"], 1.0)
            self.assertEqual(egg_preview["batches"][0]["quantity"], 1.0)

            with self.SessionLocal() as db:
                tomato_item = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-tomato-partial-preview"))
                egg_item = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-egg-partial-preview"))
                self.assertEqual(tomato_item.consumed_quantity, Decimal("0.00"))
                self.assertEqual(egg_item.consumed_quantity, Decimal("0.00"))

        def test_cook_recipe_partial_deduction_completes_and_deducts_available_inventory(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            today = date.today()
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        InventoryItem(
                            id="inventory-tomato-partial-cook",
                            family_id=self.family.id,
                            ingredient_id=self.tomato.id,
                            quantity=Decimal("1"),
                            consumed_quantity=Decimal("0"),
                            unit="个",
                            status=InventoryStatus.FRESH,
                            purchase_date=today,
                            storage_location="冷藏",
                            notes="",
                            low_stock_threshold=Decimal("0"),
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        InventoryItem(
                            id="inventory-egg-partial-cook",
                            family_id=self.family.id,
                            ingredient_id=self.egg.id,
                            quantity=Decimal("1"),
                            consumed_quantity=Decimal("0"),
                            unit="个",
                            status=InventoryStatus.FRESH,
                            purchase_date=today,
                            storage_location="冷藏",
                            notes="",
                            low_stock_threshold=Decimal("0"),
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                    ]
                )
                db.commit()

            response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json={
                    "servings": 2,
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "create_meal_log": True,
                    "allow_partial_inventory_deduction": True,
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertIsNotNone(payload["meal_log_id"])
            self.assertIsNotNone(payload["cook_log_id"])
            self.assertEqual({item["ingredient_name"] for item in payload["shortages"]}, {"番茄", "鸡蛋"})
            self.assertEqual(len(payload["consumed_items"]), 2)
            tomato_consumed = next(item for item in payload["consumed_items"] if item["ingredient_id"] == self.tomato.id)
            egg_consumed = next(item for item in payload["consumed_items"] if item["ingredient_id"] == self.egg.id)
            self.assertEqual(tomato_consumed["affected_item_ids"], ["inventory-tomato-partial-cook"])
            self.assertEqual(egg_consumed["affected_item_ids"], ["inventory-egg-partial-cook"])

            with self.SessionLocal() as db:
                tomato_item = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-tomato-partial-cook"))
                egg_item = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-egg-partial-cook"))
                cook_log = db.scalar(select(RecipeCookLog).where(RecipeCookLog.id == payload["cook_log_id"]))
                meal_log = db.scalar(select(MealLog).where(MealLog.id == payload["meal_log_id"]))
                self.assertEqual(tomato_item.consumed_quantity, Decimal("1.00"))
                self.assertEqual(egg_item.consumed_quantity, Decimal("1.00"))
                self.assertIsNotNone(cook_log)
                self.assertIsNotNone(meal_log)

        def test_not_tracked_ingredient_only_requires_presence_and_is_not_deducted(self) -> None:
            recipe = self.create_recipe(
                auto_create_food=False,
                ingredient_items=[
                    {
                        "ingredient_id": self.tomato.id,
                        "ingredient_name": "番茄",
                        "quantity": 2,
                        "unit": "个",
                        "note": "",
                    },
                    {
                        "ingredient_id": self.salt.id,
                        "ingredient_name": "盐",
                        "quantity": 5,
                        "unit": "g",
                        "note": "调味",
                    },
                ],
            )
            today = date.today()
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        InventoryItem(
                            id="inventory-tomato-for-salt",
                            family_id=self.family.id,
                            ingredient_id=self.tomato.id,
                            quantity=Decimal("2"),
                            consumed_quantity=Decimal("0"),
                            disposed_quantity=Decimal("0"),
                            unit="个",
                            status=InventoryStatus.FRESH,
                            purchase_date=today,
                            storage_location="冷藏",
                            notes="",
                            low_stock_threshold=Decimal("0"),
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        IngredientInventoryState(
                            id="inventory-state-salt-presence",
                            family_id=self.family.id,
                            ingredient_id=self.salt.id,
                            availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
                            inventory_status=InventoryStatus.FRESH,
                            purchase_date=today,
                            storage_location="常温",
                            notes="",
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                    ]
                )
                db.commit()

            preview_response = self.client.post(
                f"/api/recipes/{recipe['id']}/cook-preview",
                json={"servings": 2, "create_meal_log": False},
            )
            self.assertEqual(preview_response.status_code, 200, preview_response.text)
            preview = preview_response.json()
            self.assertEqual(preview["shortages"], [])
            salt_preview = next(item for item in preview["preview_items"] if item["ingredient_id"] == self.salt.id)
            self.assertEqual(salt_preview["quantity_tracking_mode"], "not_track_quantity")
            self.assertEqual(salt_preview["batches"], [])
            self.assertEqual(salt_preview["deduction_note"], "仅确认有库存，未扣减数量")

            cook_response = self.client.post(
                f"/api/recipes/{recipe['id']}/cook",
                json={"servings": 2, "create_meal_log": False},
            )
            self.assertEqual(cook_response.status_code, 200, cook_response.text)
            payload = cook_response.json()
            self.assertEqual(payload["shortages"], [])
            salt_consumed = next(item for item in payload["consumed_items"] if item["ingredient_id"] == self.salt.id)
            self.assertEqual(salt_consumed["quantity_tracking_mode"], "not_track_quantity")
            self.assertEqual(salt_consumed["affected_item_ids"], [])
            with self.SessionLocal() as db:
                salt_state = db.scalar(
                    select(IngredientInventoryState).where(IngredientInventoryState.id == "inventory-state-salt-presence")
                )
                tomato_item = db.scalar(select(InventoryItem).where(InventoryItem.id == "inventory-tomato-for-salt"))
                assert salt_state is not None and tomato_item is not None
                self.assertEqual(salt_state.availability_level, InventoryAvailabilityLevel.PRESENT_UNKNOWN)
                self.assertEqual(tomato_item.consumed_quantity, Decimal("2.00"))

        def test_not_tracked_ingredient_without_presence_is_presence_shortage(self) -> None:
            recipe = self.create_recipe(
                auto_create_food=False,
                ingredient_items=[
                    {
                        "ingredient_id": self.salt.id,
                        "ingredient_name": "盐",
                        "quantity": 5,
                        "unit": "g",
                        "note": "调味",
                    }
                ],
            )

            response = self.client.post(
                f"/api/recipes/{recipe['id']}/cook-preview",
                json={"servings": 2, "create_meal_log": False},
            )
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertEqual(payload["preview_items"], [])
            self.assertEqual(payload["shortages"][0]["ingredient_name"], "盐")
            self.assertEqual(payload["shortages"][0]["shortage_type"], "presence")

        def test_not_tracked_ingredient_expired_state_is_presence_shortage(self) -> None:
            recipe = self.create_recipe(
                auto_create_food=False,
                ingredient_items=[
                    {
                        "ingredient_id": self.salt.id,
                        "ingredient_name": "盐",
                        "quantity": 5,
                        "unit": "g",
                        "note": "调味",
                    }
                ],
            )
            today = date.today()
            with self.SessionLocal() as db:
                db.add(
                    IngredientInventoryState(
                        id="inventory-state-salt-expired",
                        family_id=self.family.id,
                        ingredient_id=self.salt.id,
                        availability_level=InventoryAvailabilityLevel.SUFFICIENT,
                        inventory_status=InventoryStatus.FRESH,
                        purchase_date=today - timedelta(days=30),
                        expiry_date=today - timedelta(days=1),
                        storage_location="常温",
                        notes="",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.commit()

            response = self.client.post(
                f"/api/recipes/{recipe['id']}/cook-preview",
                json={"servings": 2, "create_meal_log": False},
            )
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertEqual(payload["preview_items"], [])
            self.assertEqual(payload["shortages"][0]["shortage_type"], "presence")

        def test_cook_recipe_increments_inventory_row_version(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        InventoryItem(
                            id="inventory-tomato-version",
                            family_id=self.family.id,
                            ingredient_id=self.tomato.id,
                            quantity=Decimal("2"),
                            consumed_quantity=Decimal("0"),
                            disposed_quantity=Decimal("0"),
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
                            id="inventory-egg-version",
                            family_id=self.family.id,
                            ingredient_id=self.egg.id,
                            quantity=Decimal("3"),
                            consumed_quantity=Decimal("0"),
                            disposed_quantity=Decimal("0"),
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
                tomato = db.get(InventoryItem, "inventory-tomato-version")
                egg = db.get(InventoryItem, "inventory-egg-version")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.row_version, 1)
                self.assertEqual(egg.row_version, 1)

            cook_response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json={
                    "servings": 2,
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "create_meal_log": False,
                },
            )
            self.assertEqual(cook_response.status_code, 200, cook_response.text)
            self.assertEqual(cook_response.json()["shortages"], [])

            with self.SessionLocal() as db:
                tomato = db.get(InventoryItem, "inventory-tomato-version")
                egg = db.get(InventoryItem, "inventory-egg-version")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.consumed_quantity, Decimal("2.00"))
                self.assertEqual(egg.consumed_quantity, Decimal("3.00"))
                self.assertEqual(tomato.row_version, 2)
                self.assertEqual(egg.row_version, 2)
                tomato_ingredient = db.get(Ingredient, self.tomato.id)
                egg_ingredient = db.get(Ingredient, self.egg.id)
                assert tomato_ingredient is not None and egg_ingredient is not None
                self.assertEqual(tomato_ingredient.row_version, 2)
                self.assertEqual(egg_ingredient.row_version, 2)

        def test_expired_snoozed_inventory_excluded_from_recipe_readiness_and_cook(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            today = date.today()
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        InventoryItem(
                            id="inventory-tomato-expired-snoozed",
                            family_id=self.family.id,
                            ingredient_id=self.tomato.id,
                            quantity=Decimal("5"),
                            consumed_quantity=Decimal("0"),
                            disposed_quantity=Decimal("0"),
                            unit="个",
                            status=InventoryStatus.FRESH,
                            purchase_date=today - timedelta(days=5),
                            expiry_date=today - timedelta(days=1),
                            expiry_alert_snoozed_until=today + timedelta(days=3),
                            storage_location="冷藏",
                            notes="",
                            low_stock_threshold=Decimal("0"),
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        InventoryItem(
                            id="inventory-egg-fresh-for-snooze",
                            family_id=self.family.id,
                            ingredient_id=self.egg.id,
                            quantity=Decimal("3"),
                            consumed_quantity=Decimal("0"),
                            disposed_quantity=Decimal("0"),
                            unit="个",
                            status=InventoryStatus.FRESH,
                            purchase_date=today,
                            expiry_date=today + timedelta(days=5),
                            storage_location="冷藏",
                            notes="",
                            low_stock_threshold=Decimal("0"),
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                    ]
                )
                db.commit()

            availability = self.client.get(f"/api/recipes/{recipe_id}/availability")
            self.assertEqual(availability.status_code, 200, availability.text)
            availability_payload = availability.json()
            self.assertNotEqual(availability_payload["availability"], "ready")
            self.assertTrue(
                any(item["ingredient_name"] == "番茄" for item in availability_payload["shortages"])
            )

            preview = self.client.post(
                f"/api/recipes/{recipe_id}/cook-preview",
                json={"servings": 2, "create_meal_log": False},
            )
            self.assertEqual(preview.status_code, 200, preview.text)
            preview_payload = preview.json()
            self.assertTrue(any(item["ingredient_name"] == "番茄" for item in preview_payload["shortages"]))
            tomato_batches = [
                batch
                for item in preview_payload.get("preview_items") or []
                if item["ingredient_id"] == self.tomato.id
                for batch in item.get("batches") or []
            ]
            self.assertEqual(tomato_batches, [])

            cook = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json={"servings": 2, "create_meal_log": False},
            )
            self.assertEqual(cook.status_code, 200, cook.text)
            cook_payload = cook.json()
            self.assertEqual(cook_payload["consumed_items"], [])
            self.assertTrue(any(item["ingredient_name"] == "番茄" for item in cook_payload["shortages"]))

            with self.SessionLocal() as db:
                tomato = db.get(InventoryItem, "inventory-tomato-expired-snoozed")
                egg = db.get(InventoryItem, "inventory-egg-fresh-for-snooze")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.consumed_quantity, Decimal("0"))
                self.assertEqual(egg.consumed_quantity, Decimal("0"))
                self.assertEqual(tomato.row_version, 1)
                self.assertEqual(egg.row_version, 1)
                self.assertEqual(tomato.expiry_alert_snoozed_until, today + timedelta(days=3))

        def test_cook_recipe_stale_data_error_maps_to_409(self) -> None:
            from unittest.mock import patch

            from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
            from sqlalchemy.orm import Session
            from sqlalchemy.orm.exc import StaleDataError

            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            with self.SessionLocal() as db:
                db.add(
                    InventoryItem(
                        id="inventory-tomato-stale-cook",
                        family_id=self.family.id,
                        ingredient_id=self.tomato.id,
                        quantity=Decimal("2"),
                        consumed_quantity=Decimal("0"),
                        disposed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date.today(),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                # Recipe needs egg too; provide egg inventory.
                db.add(
                    InventoryItem(
                        id="inventory-egg-stale-cook",
                        family_id=self.family.id,
                        ingredient_id=self.egg.id,
                        quantity=Decimal("3"),
                        consumed_quantity=Decimal("0"),
                        disposed_quantity=Decimal("0"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=date.today(),
                        storage_location="冷藏",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.commit()

            original_commit = Session.commit

            def commit_raising_stale(self, *args, **kwargs):
                raise StaleDataError(
                    "UPDATE statement on table 'inventory_items' expected to update 1 row(s); 0 were matched."
                )

            with patch.object(Session, "commit", commit_raising_stale):
                response = self.client.post(
                    f"/api/recipes/{recipe_id}/cook",
                    json={"servings": 2, "create_meal_log": False},
                )
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"], STALE_INVENTORY_DETAIL)

            with self.SessionLocal() as db:
                tomato = db.get(InventoryItem, "inventory-tomato-stale-cook")
                egg = db.get(InventoryItem, "inventory-egg-stale-cook")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.consumed_quantity, Decimal("0"))
                self.assertEqual(egg.consumed_quantity, Decimal("0"))
                self.assertEqual(tomato.row_version, 1)
                self.assertEqual(egg.row_version, 1)

        def _rest_cook_payload(self, **overrides) -> dict:
            payload = {
                "servings": 2,
                "date": "2026-05-14",
                "meal_type": "dinner",
                "participant_user_ids": [self.user.id],
                "notes": "rest cook",
            }
            payload.update(overrides)
            return payload

        def test_successful_rest_cook_always_records_meal_for_create_meal_log_flags(self) -> None:
            for index, flag_payload in enumerate(({}, {"create_meal_log": True}, {"create_meal_log": False})):
                with self.subTest(flag_payload=flag_payload):
                    recipe = self.create_recipe(auto_create_food=False, title=f"番茄炒蛋-{index}")
                    recipe_id = recipe["id"]
                    self._seed_full_inventory(
                        tomato_id=f"inventory-tomato-rest-flag-{index}",
                        egg_id=f"inventory-egg-rest-flag-{index}",
                    )
                    response = self.client.post(
                        f"/api/recipes/{recipe_id}/cook",
                        json=self._rest_cook_payload(
                            **flag_payload,
                            completion_request_id=f"request-flag-{index}",
                        ),
                    )
                    self.assertEqual(response.status_code, 200, response.text)
                    body = response.json()
                    self.assertTrue(body["meal_log_id"])
                    self.assertTrue(body["cook_log_id"])
                    self.assertIs(body["replayed"], False)

        def test_response_loss_retry_returns_same_ids_and_replayed_true(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-replay",
                egg_id="inventory-egg-rest-replay",
            )
            payload = self._rest_cook_payload(completion_request_id="stable-request-1")
            first = self.client.post(f"/api/recipes/{recipe_id}/cook", json=payload)
            self.assertEqual(first.status_code, 200, first.text)
            first_body = first.json()
            second = self.client.post(f"/api/recipes/{recipe_id}/cook", json=payload)
            self.assertEqual(second.status_code, 200, second.text)
            second_body = second.json()
            self.assertEqual(second_body["meal_log_id"], first_body["meal_log_id"])
            self.assertEqual(second_body["cook_log_id"], first_body["cook_log_id"])
            self.assertIs(second_body["replayed"], True)

        def test_legacy_missing_completion_request_id_still_succeeds(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-legacy-id",
                egg_id="inventory-egg-rest-legacy-id",
            )
            response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(),
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["meal_log_id"])
            self.assertTrue(body["cook_log_id"])
            with self.SessionLocal() as db:
                cook_log = db.get(RecipeCookLog, body["cook_log_id"])
                assert cook_log is not None
                self.assertIsNotNone(cook_log.completion_request_id)
                self.assertTrue(str(cook_log.completion_request_id).startswith("legacy-cook"))

        def test_rest_cook_prefers_food_plan_item_id_over_recipe_plan_item_alias(self) -> None:
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            preferred = self.client.post(
                "/api/recipe-plan",
                json={"recipe_id": recipe_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": "preferred"},
            )
            self.assertEqual(preferred.status_code, 201, preferred.text)
            ignored = self.client.post(
                "/api/recipe-plan",
                json={"recipe_id": recipe_id, "plan_date": "2026-05-15", "meal_type": "dinner", "note": "ignored"},
            )
            self.assertEqual(ignored.status_code, 201, ignored.text)
            preferred_id = preferred.json()["id"]
            ignored_id = ignored.json()["id"]
            base_updated_at = preferred.json()["updated_at"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-alias",
                egg_id="inventory-egg-rest-alias",
            )
            response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-alias",
                    food_plan_item_id=preferred_id,
                    recipe_plan_item_id=ignored_id,
                    food_plan_item_base_updated_at=base_updated_at,
                ),
            )
            self.assertEqual(response.status_code, 200, response.text)
            meal_log_id = response.json()["meal_log_id"]
            with self.SessionLocal() as db:
                preferred_item = db.get(FoodPlanItem, preferred_id)
                ignored_item = db.get(FoodPlanItem, ignored_id)
                assert preferred_item is not None and ignored_item is not None
                self.assertEqual(preferred_item.status, "cooked")
                self.assertEqual(preferred_item.meal_log_id, meal_log_id)
                self.assertEqual(ignored_item.status, "planned")
                self.assertIsNone(ignored_item.meal_log_id)

        def test_rest_cook_recipe_plan_item_alias_still_works(self) -> None:
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            plan_response = self.client.post(
                "/api/recipe-plan",
                json={"recipe_id": recipe_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan_id = plan_response.json()["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-alias-only",
                egg_id="inventory-egg-rest-alias-only",
            )
            response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-alias-only",
                    recipe_plan_item_id=plan_id,
                ),
            )
            self.assertEqual(response.status_code, 200, response.text)
            with self.SessionLocal() as db:
                plan_item = db.get(FoodPlanItem, plan_id)
                assert plan_item is not None
                self.assertEqual(plan_item.status, "cooked")
                self.assertEqual(plan_item.meal_log_id, response.json()["meal_log_id"])

        def test_rest_cook_plan_base_timestamp_stale_maps_to_409(self) -> None:
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            plan_response = self.client.post(
                "/api/recipe-plan",
                json={"recipe_id": recipe_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan_id = plan_response.json()["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-stale-plan",
                egg_id="inventory-egg-rest-stale-plan",
            )
            response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-stale-plan",
                    food_plan_item_id=plan_id,
                    food_plan_item_base_updated_at="2020-01-01T00:00:00+00:00",
                ),
            )
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"], "food_plan_item_stale")

        def test_rest_cook_already_completed_plan_maps_to_409(self) -> None:
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            plan_response = self.client.post(
                "/api/recipe-plan",
                json={"recipe_id": recipe_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan_payload = plan_response.json()
            plan_id = plan_payload["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-completed-plan",
                egg_id="inventory-egg-rest-completed-plan",
                tomato_qty="4",
                egg_qty="6",
            )
            first = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-completed-plan-1",
                    food_plan_item_id=plan_id,
                    food_plan_item_base_updated_at=plan_payload["updated_at"],
                ),
            )
            self.assertEqual(first.status_code, 200, first.text)
            with self.SessionLocal() as db:
                plan_item = db.get(FoodPlanItem, plan_id)
                assert plan_item is not None
                base_updated_at = plan_item.updated_at.isoformat()
            second = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-completed-plan-2",
                    food_plan_item_id=plan_id,
                    food_plan_item_base_updated_at=base_updated_at,
                ),
            )
            self.assertEqual(second.status_code, 409, second.text)
            self.assertEqual(second.json()["detail"]["code"], "food_plan_item_already_completed")

        def test_rest_cook_recipe_plan_mismatch_maps_to_404(self) -> None:
            recipe_a = self.create_recipe(auto_create_food=True, title="菜谱A")
            recipe_b = self.create_recipe(auto_create_food=True, title="菜谱B")
            plan_response = self.client.post(
                "/api/recipe-plan",
                json={"recipe_id": recipe_a["id"], "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan_id = plan_response.json()["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-mismatch",
                egg_id="inventory-egg-rest-mismatch",
            )
            response = self.client.post(
                f"/api/recipes/{recipe_b['id']}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-mismatch",
                    food_plan_item_id=plan_id,
                    food_plan_item_base_updated_at=plan_response.json()["updated_at"],
                ),
            )
            self.assertEqual(response.status_code, 404, response.text)
            self.assertEqual(response.json()["detail"], "Food plan item not found")

        def test_rest_cook_unknown_result_envelope_maps_to_409(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-envelope",
                egg_id="inventory-egg-rest-envelope",
            )
            first = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(completion_request_id="req-rest-envelope"),
            )
            self.assertEqual(first.status_code, 200, first.text)
            cook_log_id = first.json()["cook_log_id"]
            with self.SessionLocal() as db:
                cook_log = db.get(RecipeCookLog, cook_log_id)
                assert cook_log is not None
                cook_log.completion_result_json = {"version": 99, "response": {"recipe_id": recipe_id}}
                db.commit()
            second = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(completion_request_id="req-rest-envelope"),
            )
            self.assertEqual(second.status_code, 409, second.text)
            self.assertEqual(second.json()["detail"]["code"], "completion_result_version_unsupported")

        def test_rest_cook_same_id_different_payload_maps_to_409(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-hash",
                egg_id="inventory-egg-rest-hash",
                tomato_qty="4",
                egg_qty="6",
            )
            first = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-hash",
                    notes="first",
                ),
            )
            self.assertEqual(first.status_code, 200, first.text)
            second = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-hash",
                    notes="second",
                ),
            )
            self.assertEqual(second.status_code, 409, second.text)
            self.assertEqual(second.json()["detail"]["code"], "idempotency_key_reused")

        def test_rest_cook_shortage_returns_neither_id(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            response = self.client.post(
                f"/api/recipes/{recipe['id']}/cook",
                json=self._rest_cook_payload(completion_request_id="req-rest-shortage"),
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["consumed_items"], [])
            self.assertTrue(body["shortages"])
            self.assertIsNone(body["meal_log_id"])
            self.assertIsNone(body["cook_log_id"])
            self.assertIs(body["replayed"], False)

