from dataclasses import replace
from datetime import datetime, timezone
from unittest.mock import patch

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from ._support import *

from app.core.enums import ActivityHighlightKind, FoodType, MembershipStatus, UserRole
from app.models.domain import (
    ActivityLog,
    Food,
    FoodPlanItem,
    MealLog,
    MealLogRecordOperation,
    Membership,
    Recipe,
    User,
)
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

        def test_completion_hash_normalizes_plan_base_updated_at_timezone(self) -> None:
            from datetime import timedelta

            from app.services.recipe_cook_completion import canonicalize_completion_command

            utc = datetime(2026, 5, 14, 12, 0, tzinfo=timezone.utc)
            offset = utc.astimezone(timezone(timedelta(hours=8)))
            naive = datetime(2026, 5, 14, 12, 0)
            first = _make_completion_command(food_plan_item_base_updated_at=utc)
            second = _make_completion_command(food_plan_item_base_updated_at=offset)
            third = _make_completion_command(food_plan_item_base_updated_at=naive)
            self.assertEqual(hash_completion_command(first), hash_completion_command(second))
            self.assertEqual(hash_completion_command(first), hash_completion_command(third))
            canonical = canonicalize_completion_command(first)["food_plan_item_base_updated_at"]
            self.assertTrue(str(canonical).endswith("Z"))

        def test_claim_integrity_error_under_outer_savepoint_preserves_outer_txn(self) -> None:
            """IntegrityError on claim must not full-rollback an outer begin_nested txn."""
            recipe = self.create_recipe(auto_create_food=False, title="番茄炒蛋-nested-claim")
            self._seed_full_inventory(
                tomato_id="inventory-tomato-nested-claim",
                egg_id="inventory-egg-nested-claim",
            )
            command = self._completion_command_for_recipe(
                recipe["id"],
                completion_request_id="req-nested-claim",
            )
            request_hash = hash_completion_command(command)
            winner_response = CookRecipeResponse(
                recipe_id=recipe["id"],
                consumed_items=[],
                shortages=[],
                meal_log_id="meal-nested-winner",
                cook_log_id="cook-nested-winner",
                replayed=False,
            )
            with self.SessionLocal() as db:
                db.add(
                    RecipeCookLog(
                        id="cook-nested-winner",
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
                        meal_log_id="meal-nested-winner",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                # Stage an outer mutation that must survive claim IntegrityError recovery.
                outer_recipe = db.get(Recipe, recipe["id"])
                assert outer_recipe is not None
                outer_recipe.tips = "outer-marker-tips"
                db.flush()
                load_calls = {"n": 0}
                real_load = load_completion_replay_if_present

                def load_skipping_early_hits(*args, **kwargs):
                    load_calls["n"] += 1
                    if load_calls["n"] <= 2:
                        return None
                    return real_load(*args, **kwargs)

                with db.begin_nested():
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
                # Outer mutation still visible — full session rollback did not fire.
                refreshed = db.get(Recipe, recipe["id"])
                assert refreshed is not None
                self.assertEqual(refreshed.tips, "outer-marker-tips")
                db.rollback()

        def test_lock_recipe_for_completion_rejects_stale_base_updated_at(self) -> None:
            from app.services.recipe_cook_completion import lock_recipe_for_completion

            recipe = self.create_recipe(auto_create_food=False, title="番茄炒蛋-stale-base")
            with self.SessionLocal() as db:
                orm = db.get(Recipe, recipe["id"])
                assert orm is not None
                command = _make_completion_command(
                    family_id=self.family.id,
                    actor_user_id=self.user.id,
                    recipe_id=recipe["id"],
                    participant_user_ids=(self.user.id,),
                    recipe_base_updated_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
                )
                with self.assertRaises(CompletionConflict) as raised:
                    lock_recipe_for_completion(db, command)
                self.assertEqual(raised.exception.code, "recipe_stale")
                # Matching base passes.
                command_ok = replace(command, recipe_base_updated_at=orm.updated_at)
                locked = lock_recipe_for_completion(db, command_ok)
                self.assertEqual(locked.id, recipe["id"])

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
            food_id = self._linked_food_id(recipe_id)
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
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
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan_payload = plan_response.json()
            plan_id = plan_payload["id"]
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
                    "completion_request_id": "req-rest-cook-plan",
                    "food_plan_item_id": plan_id,
                    "food_plan_item_base_updated_at": plan_payload["updated_at"],
                },
            )
            self.assertEqual(cook_response.status_code, 200, cook_response.text)
            payload = cook_response.json()
            self.assertEqual(payload["shortages"], [])
            self.assertEqual(len(payload["consumed_items"]), 2)
            self.assertIsNotNone(payload["meal_log_id"])
            self.assertIsNotNone(payload["cook_log_id"])
            plan_items = self.client.get("/api/food-plan?date_from=2026-05-14&date_to=2026-05-14").json()
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

        def test_cook_recipe_always_records_meal(self) -> None:
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
                    "completion_request_id": "req-rest-always-meal",
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
                json={"servings": 2},
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
                json={"servings": 2, "completion_request_id": "req-rest-shortage-no-inv"},
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
                json={"servings": 2, "allow_partial_inventory_deduction": True},
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
                    "allow_partial_inventory_deduction": True,
                    "completion_request_id": "req-rest-partial-cook",
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
                        "note": ""},
                    {
                        "ingredient_id": self.salt.id,
                        "ingredient_name": "盐",
                        "quantity": 5,
                        "unit": "g",
                        "note": "调味"},
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
                json={"servings": 2},
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
                json={"servings": 2, "completion_request_id": "req-rest-not-tracked"},
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
                        "note": "调味"}
                ],
            )

            response = self.client.post(
                f"/api/recipes/{recipe['id']}/cook-preview",
                json={"servings": 2},
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
                        "note": "调味"}
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
                json={"servings": 2},
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
                    "completion_request_id": "req-rest-row-version",
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
                json={"servings": 2},
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
                json={"servings": 2, "completion_request_id": "req-rest-expired-snoozed"},
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
                    json={"servings": 2, "completion_request_id": "req-rest-stale-data"},
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

        def _linked_food_id(self, recipe_id: str) -> str:
            foods = self.client.get("/api/foods").json()
            linked = next(item for item in foods if item.get("recipe_id") == recipe_id)
            return linked["id"]

        def _rest_cook_payload(self, **overrides) -> dict:
            payload = {
                "servings": 2,
                "date": "2026-05-14",
                "meal_type": "dinner",
                "participant_user_ids": [self.user.id],
                "notes": "rest cook",
                "completion_request_id": "request-default",
            }
            payload.update(overrides)
            return payload

        def test_successful_rest_cook_always_records_meal(self) -> None:
            for index, flag_payload in enumerate(({}, {}, {})):
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

        def test_final_cook_request_requires_completion_id(self) -> None:
            from pydantic import ValidationError
            from app.schemas.recipes import CookRecipeRequest

            with self.assertRaises(ValidationError):
                CookRecipeRequest(servings=2)

        def test_final_plan_cook_requires_base_updated_at(self) -> None:
            from pydantic import ValidationError
            from app.schemas.recipes import CookRecipeRequest

            with self.assertRaises(ValidationError):
                CookRecipeRequest(
                    servings=2,
                    completion_request_id="request-1",
                    food_plan_item_id="plan-1",
                )

        def test_final_request_rejects_removed_aliases_as_ignored_or_invalid(self) -> None:
            from app.schemas.recipes import CookRecipeRequest

            # Removed fields are no longer model fields; model_validate drops unknown keys by default.
            parsed = CookRecipeRequest.model_validate({
                "servings": 2,
                "completion_request_id": "request-1",
                "create_meal_log": False,
                "recipe_plan_item_id": "plan-1",
            })
            self.assertEqual(parsed.completion_request_id, "request-1")
            self.assertIsNone(parsed.food_plan_item_id)
            self.assertFalse(hasattr(parsed, "create_meal_log"))
            self.assertFalse(hasattr(parsed, "recipe_plan_item_id"))

        def test_rest_cook_food_plan_item_completes_plan(self) -> None:
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": "preferred"},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan_id = plan_response.json()["id"]
            base_updated_at = plan_response.json()["updated_at"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-rest-plan",
                egg_id="inventory-egg-rest-plan",
            )
            response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(
                    completion_request_id="req-rest-plan",
                    food_plan_item_id=plan_id,
                    food_plan_item_base_updated_at=base_updated_at,
                ),
            )
            self.assertEqual(response.status_code, 200, response.text)
            meal_log_id = response.json()["meal_log_id"]
            with self.SessionLocal() as db:
                plan_item = db.get(FoodPlanItem, plan_id)
                assert plan_item is not None
                self.assertEqual(plan_item.status, "cooked")
                self.assertEqual(plan_item.meal_log_id, meal_log_id)

        def test_rest_cook_plan_base_timestamp_stale_maps_to_409(self) -> None:
            recipe = self.create_recipe(auto_create_food=True)
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
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
            food_id = self._linked_food_id(recipe_id)
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
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
            food_id = self._linked_food_id(recipe_a["id"])
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
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

        def test_rest_cook_ignores_removed_fields_and_replays(self) -> None:
            """Removed aliases are ignored; completion_request_id replay still works."""
            recipe = self.create_recipe(auto_create_food=False, title="矩阵菜")
            recipe_id = recipe["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-matrix",
                egg_id="inventory-egg-matrix",
            )
            payload = self._rest_cook_payload(
                create_meal_log=False,
                recipe_plan_item_id="ignored-plan",
                completion_request_id="matrix-request-1",
                future_client_field="forward-compatible",
                client_trace_id="trace-1",
            )
            from app.schemas.recipes import CookRecipeRequest

            parsed = CookRecipeRequest.model_validate(payload)
            self.assertEqual(parsed.completion_request_id, "matrix-request-1")
            self.assertFalse(hasattr(parsed, "create_meal_log"))
            self.assertFalse(hasattr(parsed, "recipe_plan_item_id"))

            first = self.client.post(f"/api/recipes/{recipe_id}/cook", json=payload)
            self.assertEqual(first.status_code, 200, first.text)
            first_body = first.json()
            self.assertTrue(first_body["meal_log_id"])
            self.assertTrue(first_body["cook_log_id"])
            self.assertIs(first_body["replayed"], False)

            second = self.client.post(f"/api/recipes/{recipe_id}/cook", json=payload)
            self.assertEqual(second.status_code, 200, second.text)
            second_body = second.json()
            self.assertEqual(second_body["meal_log_id"], first_body["meal_log_id"])
            self.assertEqual(second_body["cook_log_id"], first_body["cook_log_id"])
            self.assertIs(second_body["replayed"], True)

        def test_completion_hash_includes_target_meal_log_fields(self) -> None:
            base = _make_completion_command()
            with_target = replace(
                base,
                target_meal_log_id="meal-target-1",
                expected_meal_log_row_version=2,
            )
            self.assertNotEqual(hash_completion_command(base), hash_completion_command(with_target))
            self.assertEqual(
                hash_completion_command(with_target),
                hash_completion_command(
                    replace(
                        base,
                        target_meal_log_id="meal-target-1",
                        expected_meal_log_row_version=2,
                    )
                ),
            )
            from app.services.recipe_cook_completion import canonicalize_completion_command

            canonical = canonicalize_completion_command(with_target)
            self.assertEqual(canonical["target_meal_log_id"], "meal-target-1")
            self.assertEqual(canonical["expected_meal_log_row_version"], 2)

        def test_recipe_cook_appends_to_explicit_target_and_replay_does_not_append_twice(self) -> None:
            recipe = self.create_recipe(auto_create_food=True, title="目标餐追加")
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)
            target_response = self.client.post(
                "/api/meal-logs",
                json={
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "food_entries": [{"food_id": food_id, "servings": 1, "note": "先有的菜"}],
                    "participant_user_ids": [self.user.id],
                    "notes": "已有晚餐",
                    "mood": "",
                },
            )
            self.assertEqual(target_response.status_code, 201, target_response.text)
            target = target_response.json()
            self.assertEqual(target["row_version"], 1)
            self._seed_full_inventory(
                tomato_id="inventory-tomato-target-append",
                egg_id="inventory-egg-target-append",
                tomato_qty="4",
                egg_qty="6",
            )
            payload = self._rest_cook_payload(
                completion_request_id="cook-target-1",
                target_meal_log_id=target["id"],
                expected_meal_log_row_version=1,
            )
            first = self.client.post(f"/api/recipes/{recipe_id}/cook", json=payload)
            second = self.client.post(f"/api/recipes/{recipe_id}/cook", json=payload)
            self.assertEqual(first.status_code, 200, first.text)
            self.assertEqual(second.status_code, 200, second.text)
            self.assertIs(second.json()["replayed"], True)
            self.assertEqual(first.json()["meal_log_id"], target["id"])
            self.assertEqual(second.json()["meal_log_id"], target["id"])
            with self.SessionLocal() as db:
                meal = db.get(MealLog, target["id"])
                assert meal is not None
                self.assertEqual(len(meal.food_entries), 2)
                self.assertEqual(meal.row_version, 2)
                self.assertEqual(
                    db.scalar(select(func.count()).select_from(MealLogRecordOperation)),
                    0,
                )

        def test_cook_stale_target_version_fails_before_inventory_mutation(self) -> None:
            from app.services.meal_log_versions import MealLogConflictError

            recipe = self.create_recipe(auto_create_food=True, title="目标版本过期")
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)
            target_response = self.client.post(
                "/api/meal-logs",
                json={
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "food_entries": [{"food_id": food_id, "servings": 1, "note": "先有的菜"}],
                    "participant_user_ids": [self.user.id],
                    "notes": "已有晚餐",
                    "mood": "",
                },
            )
            self.assertEqual(target_response.status_code, 201, target_response.text)
            target = target_response.json()
            self._seed_full_inventory(
                tomato_id="inventory-tomato-stale-target",
                egg_id="inventory-egg-stale-target",
                tomato_qty="4",
                egg_qty="6",
            )
            command = self._completion_command_for_recipe(
                recipe_id,
                completion_request_id="cook-stale-target-version",
                target_meal_log_id=target["id"],
                expected_meal_log_row_version=999,
            )
            with self.SessionLocal() as db:
                with patch(
                    "app.services.recipe_cook_completion.apply_locked_inventory_plan",
                    side_effect=AssertionError("inventory must not mutate on stale MealLog version"),
                ):
                    with self.assertRaises(MealLogConflictError) as raised:
                        complete_recipe_cook(db, command)
                self.assertEqual(raised.exception.code, "meal_log_stale")
                tomato = db.get(InventoryItem, "inventory-tomato-stale-target")
                egg = db.get(InventoryItem, "inventory-egg-stale-target")
                assert tomato is not None and egg is not None
                self.assertEqual(tomato.consumed_quantity, Decimal("0"))
                self.assertEqual(egg.consumed_quantity, Decimal("0"))
                meal = db.get(MealLog, target["id"])
                assert meal is not None
                self.assertEqual(meal.row_version, 1)
                self.assertEqual(len(meal.food_entries), 1)
                db.rollback()

        def test_cook_target_path_unions_entry_foods_and_skips_second_food_lock(self) -> None:
            recipe = self.create_recipe(auto_create_food=True, title="目标锁顺序")
            recipe_id = recipe["id"]
            food_id = self._linked_food_id(recipe_id)
            other_food_response = self.client.post(
                "/api/foods",
                json={
                    "name": "米饭-目标锁",
                    "type": "readyMade",
                    "category": "主食",
                    "flavor_tags": [],
                    "scene_tags": [],
                    "suitable_meal_types": ["dinner"],
                },
            )
            self.assertEqual(other_food_response.status_code, 201, other_food_response.text)
            other_food_id = other_food_response.json()["id"]
            target_response = self.client.post(
                "/api/meal-logs",
                json={
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "food_entries": [{"food_id": other_food_id, "servings": 1, "note": "已有米饭"}],
                    "participant_user_ids": [self.user.id],
                    "notes": "已有晚餐",
                    "mood": "",
                },
            )
            self.assertEqual(target_response.status_code, 201, target_response.text)
            target = target_response.json()
            self._seed_full_inventory(
                tomato_id="inventory-tomato-lock-order",
                egg_id="inventory-egg-lock-order",
                tomato_qty="4",
                egg_qty="6",
            )
            command = self._completion_command_for_recipe(
                recipe_id,
                completion_request_id="cook-target-lock-order",
                target_meal_log_id=target["id"],
                expected_meal_log_row_version=target["row_version"],
            )
            inventory_lock_calls: list[dict] = []
            from app.services.inventory_operation_locking import (
                lock_inventory_targets as real_inventory_lock,
            )

            def tracking_inventory_lock(*args, **kwargs):
                inventory_lock_calls.append(
                    {
                        "food_ids": sorted(kwargs.get("food_ids") or []),
                        "inventory_item_ids": sorted(kwargs.get("inventory_item_ids") or []),
                    }
                )
                return real_inventory_lock(*args, **kwargs)

            with self.SessionLocal() as db:
                with (
                    patch(
                        "app.services.recipe_cook_completion.lock_inventory_targets",
                        side_effect=tracking_inventory_lock,
                    ),
                    patch(
                        "app.services.meal_log_versions.lock_inventory_targets",
                        side_effect=AssertionError("must not re-lock Foods after inventory items"),
                    ),
                ):
                    result = complete_recipe_cook(db, command)
                    db.commit()
            self.assertEqual(result.meal_log_id, target["id"])
            self.assertEqual(len(inventory_lock_calls), 1)
            self.assertIn(other_food_id, inventory_lock_calls[0]["food_ids"])
            self.assertIn(food_id, inventory_lock_calls[0]["food_ids"])
            self.assertTrue(inventory_lock_calls[0]["inventory_item_ids"])

        def test_recipe_cook_without_target_still_creates_new_meal_log(self) -> None:
            recipe = self.create_recipe(auto_create_food=False, title="无目标新建")
            recipe_id = recipe["id"]
            self._seed_full_inventory(
                tomato_id="inventory-tomato-no-target",
                egg_id="inventory-egg-no-target",
            )
            response = self.client.post(
                f"/api/recipes/{recipe_id}/cook",
                json=self._rest_cook_payload(completion_request_id="cook-no-target"),
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["meal_log_id"])
            with self.SessionLocal() as db:
                meal = db.get(MealLog, body["meal_log_id"])
                assert meal is not None
                self.assertEqual(len(meal.food_entries), 1)
                self.assertEqual(meal.row_version, 1)
                self.assertEqual(
                    db.scalar(select(func.count()).select_from(MealLogRecordOperation)),
                    0,
                )

        def test_complete_food_plan_item_creates_new_meal_and_replays_without_second_write(self) -> None:
            food_response = self.client.post(
                "/api/foods",
                json={
                    "name": "凉拌黄瓜",
                    "type": "readyMade",
                    "category": "凉菜",
                    "flavor_tags": [],
                    "scene_tags": [],
                    "suitable_meal_types": ["dinner"],
                },
            )
            self.assertEqual(food_response.status_code, 201, food_response.text)
            food_id = food_response.json()["id"]
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan = plan_response.json()
            first = self.client.post(
                f"/api/food-plan/{plan['id']}/complete",
                json={"food_plan_item_base_updated_at": plan["updated_at"]},
            )
            self.assertEqual(first.status_code, 200, first.text)
            meal_id = first.json()["id"]
            second = self.client.post(
                f"/api/food-plan/{plan['id']}/complete",
                json={"food_plan_item_base_updated_at": plan["updated_at"]},
            )
            self.assertEqual(second.status_code, 200, second.text)
            self.assertEqual(second.json()["id"], meal_id)
            with self.SessionLocal() as db:
                self.assertEqual(db.scalar(select(func.count()).select_from(MealLog)), 1)
                plan_item = db.get(FoodPlanItem, plan["id"])
                assert plan_item is not None
                self.assertEqual(plan_item.status, "cooked")
                self.assertEqual(plan_item.meal_log_id, meal_id)
                self.assertEqual(
                    db.scalar(select(func.count()).select_from(MealLogRecordOperation)),
                    0,
                )

        def test_complete_food_plan_item_appends_to_explicit_target(self) -> None:
            food_response = self.client.post(
                "/api/foods",
                json={
                    "name": "拍黄瓜",
                    "type": "readyMade",
                    "category": "凉菜",
                    "flavor_tags": [],
                    "scene_tags": [],
                    "suitable_meal_types": ["dinner"],
                },
            )
            self.assertEqual(food_response.status_code, 201, food_response.text)
            food_id = food_response.json()["id"]
            target_response = self.client.post(
                "/api/meal-logs",
                json={
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "food_entries": [{"food_id": food_id, "servings": 1, "note": "先记"}],
                    "participant_user_ids": [self.user.id],
                    "notes": "",
                    "mood": "",
                },
            )
            self.assertEqual(target_response.status_code, 201, target_response.text)
            target = target_response.json()
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan = plan_response.json()
            response = self.client.post(
                f"/api/food-plan/{plan['id']}/complete",
                json={
                    "food_plan_item_base_updated_at": plan["updated_at"],
                    "target_meal_log_id": target["id"],
                    "expected_meal_log_row_version": target["row_version"],
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["id"], target["id"])
            self.assertEqual(response.json()["row_version"], target["row_version"] + 1)
            with self.SessionLocal() as db:
                meal = db.get(MealLog, target["id"])
                assert meal is not None
                self.assertEqual(len(meal.food_entries), 2)

        def test_complete_food_plan_item_different_target_after_completion_is_409(self) -> None:
            food_response = self.client.post(
                "/api/foods",
                json={
                    "name": "凉拌木耳",
                    "type": "readyMade",
                    "category": "凉菜",
                    "flavor_tags": [],
                    "scene_tags": [],
                    "suitable_meal_types": ["dinner"],
                },
            )
            self.assertEqual(food_response.status_code, 201, food_response.text)
            food_id = food_response.json()["id"]
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan = plan_response.json()
            first = self.client.post(
                f"/api/food-plan/{plan['id']}/complete",
                json={"food_plan_item_base_updated_at": plan["updated_at"]},
            )
            self.assertEqual(first.status_code, 200, first.text)
            other = self.client.post(
                "/api/meal-logs",
                json={
                    "date": "2026-05-14",
                    "meal_type": "dinner",
                    "food_entries": [{"food_id": food_id, "servings": 1, "note": "另一顿"}],
                    "participant_user_ids": [self.user.id],
                    "notes": "",
                    "mood": "",
                },
            )
            self.assertEqual(other.status_code, 201, other.text)
            second = self.client.post(
                f"/api/food-plan/{plan['id']}/complete",
                json={
                    "food_plan_item_base_updated_at": plan["updated_at"],
                    "target_meal_log_id": other.json()["id"],
                    "expected_meal_log_row_version": other.json()["row_version"],
                },
            )
            self.assertEqual(second.status_code, 409, second.text)
            self.assertEqual(second.json()["detail"]["code"], "food_plan_item_already_completed")

        def test_complete_food_plan_item_date_mismatch_is_409(self) -> None:
            food_response = self.client.post(
                "/api/foods",
                json={
                    "name": "酸辣土豆丝",
                    "type": "readyMade",
                    "category": "热菜",
                    "flavor_tags": [],
                    "scene_tags": [],
                    "suitable_meal_types": ["dinner"],
                },
            )
            self.assertEqual(food_response.status_code, 201, food_response.text)
            food_id = food_response.json()["id"]
            target_response = self.client.post(
                "/api/meal-logs",
                json={
                    "date": "2026-05-15",
                    "meal_type": "dinner",
                    "food_entries": [{"food_id": food_id, "servings": 1, "note": ""}],
                    "participant_user_ids": [self.user.id],
                    "notes": "",
                    "mood": "",
                },
            )
            self.assertEqual(target_response.status_code, 201, target_response.text)
            target = target_response.json()
            plan_response = self.client.post(
                "/api/food-plan",
                json={"food_id": food_id, "plan_date": "2026-05-14", "meal_type": "dinner", "note": ""},
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            plan = plan_response.json()
            response = self.client.post(
                f"/api/food-plan/{plan['id']}/complete",
                json={
                    "food_plan_item_base_updated_at": plan["updated_at"],
                    "target_meal_log_id": target["id"],
                    "expected_meal_log_row_version": target["row_version"],
                },
            )
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"], "meal_log_date_mismatch")
