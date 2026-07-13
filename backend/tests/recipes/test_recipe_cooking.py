from dataclasses import replace
from datetime import datetime, timezone

from ._support import *

from app.core.enums import ActivityHighlightKind
from app.models.domain import ActivityLog
from app.schemas.recipes import CookRecipeResponse
from app.services.recipe_cook_completion import (
    CompletionConflict,
    RecipeCookCompletionCommand,
    claim_completion,
    encode_completion_result,
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

        def test_cook_recipe_without_meal_log_uses_plain_completion_summary(self) -> None:
            recipe = self.create_recipe(auto_create_food=False)
            recipe_id = recipe["id"]
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        InventoryItem(
                            id="inventory-tomato-no-meal",
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
                            id="inventory-egg-no-meal",
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
                    "create_meal_log": False,
                },
            )
            self.assertEqual(cook_response.status_code, 200, cook_response.text)
            payload = cook_response.json()
            self.assertIsNone(payload["meal_log_id"])
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
                self.assertEqual(meal_rows[0].highlight_summary, "完成 番茄炒蛋")

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

