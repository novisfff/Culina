from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any

from ._support import AIAgentInfraTestCase

from app.core.enums import Difficulty, FoodType
from app.core.utils import utcnow
from app.models.domain import Food, Recipe
from app.services.ai_auto_execution.policy_types import DraftExecutionReceipt
from app.services.ai_operations.common import assert_updated_at_matches
from app.services.ai_operations.drafts import normalize_ai_draft_payload
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import DraftExecuteContext, DraftOperationRegistry

@dataclass(frozen=True, slots=True)
class RegisteredDraftExecutionFixture:
    draft_type: str
    payload: dict[str, Any]
    expected_cache_scopes: tuple[str, ...]
    expected_revert_adapter_key: str | None = None


class AIDraftExecutionReceiptTestCase(AIAgentInfraTestCase):
    def _normalize(self, db, *, draft_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        return normalize_ai_draft_payload(
            db,
            draft_type=draft_type,
            family_id=self.family.id,
            user_id=self.user.id,
            conversation_id="conversation-receipt-contract",
            payload=payload,
        )

    def _registered_fixtures(self, db) -> list[RegisteredDraftExecutionFixture]:
        recipe = Recipe(
            id="recipe-receipt-cook",
            family_id=self.family.id,
            title="契约测试清汤",
            servings=2,
            prep_minutes=5,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=[],
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        recipe_food = Food(
            id="food-receipt-cook",
            family_id=self.family.id,
            name=recipe.title,
            type=FoodType.SELF_MADE,
            category="家常菜",
            recipe_id=recipe.id,
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add_all((recipe, recipe_food))
        db.flush()

        ingredient_create = {
            "draftType": "ingredient_profile",
            "schemaVersion": "ingredient_profile.v1",
            "action": "create",
            "payload": {
                "name": "契约测试黄瓜",
                "category": "蔬菜",
                "default_unit": "根",
                "unit_conversions": [],
                "default_storage": "冷藏",
                "default_expiry_mode": "none",
                "default_expiry_days": None,
                "default_low_stock_threshold": None,
                "notes": "",
                "media_ids": [],
            },
        }
        fixtures = [
            RegisteredDraftExecutionFixture(
                "composite_operation",
                {
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "create-ingredient",
                            "domain": "ingredient",
                            "operation": ingredient_create,
                        }
                    ],
                },
                ("inventory", "ai_conversation"),
            ),
            RegisteredDraftExecutionFixture(
                "food_profile",
                {
                    "draftType": "food_profile",
                    "schemaVersion": "food_profile.v1",
                    "action": "create",
                    "payload": {
                        "name": "契约测试酸奶",
                        "type": "readyMade",
                        "category": "乳品",
                        "flavor_tags": [],
                        "scene_tags": [],
                        "suitable_meal_types": ["breakfast"],
                        "source_name": "",
                        "purchase_source": "",
                        "scene": "早餐",
                        "notes": "",
                        "routine_note": "",
                        "favorite": False,
                        "recipe_id": None,
                        "media_ids": [],
                    },
                },
                ("food", "ai_conversation"),
            ),
            RegisteredDraftExecutionFixture(
                "ingredient_profile",
                ingredient_create,
                ("inventory", "ai_conversation"),
            ),
            RegisteredDraftExecutionFixture(
                "inventory_intake",
                {
                    "draftType": "inventory_intake",
                    "schemaVersion": "inventory_intake.v1",
                    "sourceType": "receipt_image",
                    "sourceReference": {"mediaId": "receipt-contract-media"},
                    "intakeDate": date.today().isoformat(),
                    "intakeDateSource": "receipt",
                    "items": [
                        {
                            "lineId": "receipt-intake-line",
                            "sourceLineId": "receipt-intake-source",
                            "sourceText": "番茄 1 个",
                            "sourceKind": "direct",
                            "action": "stock_only",
                            "targetKind": "exact_ingredient",
                            "targetId": "ingredient-tomato",
                            "enteredQuantity": "1",
                            "enteredUnit": "个",
                            "inventoryStatus": "fresh",
                            "storageLocation": "冷藏",
                        }
                    ],
                    "ignoredItems": [],
                },
                ("inventory", "ai_conversation"),
                expected_revert_adapter_key="inventory.operation_ref.v1",
            ),
            RegisteredDraftExecutionFixture(
                "inventory_operation",
                {
                    "draftType": "inventory_operation",
                    "schemaVersion": "inventory_operation.v1",
                    "operations": [
                        {
                            "action": "consume",
                            "ingredientId": "ingredient-tomato",
                            "inventoryItemId": "inventory-tomato",
                            "quantity": 0.25,
                            "unit": "个",
                        }
                    ],
                },
                ("inventory", "ai_conversation"),
                expected_revert_adapter_key="inventory.operation_ref.v1",
            ),
            RegisteredDraftExecutionFixture(
                "meal_log",
                {
                    "draftType": "meal_log",
                    "schemaVersion": "meal_log.v1",
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "foods": [
                        {
                            "foodId": "food-tomato",
                            "name": "番茄小炒",
                            "servings": 1,
                            "note": "",
                        }
                    ],
                    "participantUserIds": [self.user.id],
                    "notes": "",
                    "mood": "",
                    "mediaIds": [],
                },
                ("meal_log", "ai_conversation"),
            ),
            RegisteredDraftExecutionFixture(
                "meal_plan",
                {
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "items": [
                        {
                            "date": (date.today() + timedelta(days=1)).isoformat(),
                            "mealType": "dinner",
                            "title": "番茄小炒",
                            "foodId": "food-tomato",
                            "reason": "契约测试",
                        }
                    ],
                },
                ("meal_plan", "ai_conversation"),
                expected_revert_adapter_key="meal_plan.simple_create.v1",
            ),
            RegisteredDraftExecutionFixture(
                "recipe",
                {
                    "draftType": "recipe",
                    "schemaVersion": "recipe.v1",
                    "title": "契约测试凉菜",
                    "servings": 2,
                    "prep_minutes": 5,
                    "difficulty": "easy",
                    "ingredient_items": [
                        {
                            "ingredient_id": "ingredient-tomato",
                            "ingredient_name": "番茄",
                            "quantity": 1,
                            "unit": "个",
                            "note": "",
                        }
                    ],
                    "steps": [
                        {
                            "title": "装盘",
                            "text": "装盘即可。",
                            "icon": "bowl",
                            "summary": "装盘",
                            "estimated_minutes": 1,
                            "tip": "",
                            "key_points": [],
                        }
                    ],
                    "tips": "",
                    "scene_tags": [],
                    "media_ids": [],
                },
                ("food", "ai_conversation"),
            ),
            RegisteredDraftExecutionFixture(
                "recipe_cook",
                {
                    "draftType": "recipe_cook",
                    "schemaVersion": "recipe_cook_operation.v2",
                    "recipeId": recipe.id,
                    "title": recipe.title,
                    "baseUpdatedAt": recipe.updated_at.isoformat(),
                    "before": {},
                    "servings": 1,
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "participantUserIds": [self.user.id],
                    "notes": "",
                    "resultNote": "",
                    "adjustments": "",
                    "previewItems": [],
                    "shortages": [],
                    "inventoryBoundaries": [],
                },
                ("meal_log", "ai_conversation"),
            ),
            RegisteredDraftExecutionFixture(
                "shopping_list",
                {
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list.v1",
                    "items": [
                        {
                            "ingredientId": "ingredient-tomato",
                            "title": "番茄",
                            "quantity": 1,
                            "unit": "个",
                            "reason": "契约测试",
                        }
                    ],
                },
                ("shopping_list", "ai_conversation"),
                expected_revert_adapter_key="shopping_list.safe_write.v1",
            ),
        ]
        return fixtures

    def test_every_registered_executor_returns_typed_receipt(self) -> None:
        with self.SessionLocal() as db:
            fixtures = self._registered_fixtures(db)
            db.commit()
        self.assertEqual(
            {fixture.draft_type for fixture in fixtures},
            set(draft_operation_registry.keys()),
        )
        for index, fixture in enumerate(fixtures):
            with self.subTest(draft_type=fixture.draft_type), self.SessionLocal() as db:
                payload = self._normalize(
                    db,
                    draft_type=fixture.draft_type,
                    payload=fixture.payload,
                )
                receipt = draft_operation_registry.execute(
                    DraftExecuteContext(
                        db=db,
                        draft_type=fixture.draft_type,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        payload=payload,
                        assert_updated_at_matches=assert_updated_at_matches,
                        operation_idempotency_key=f"receipt-contract:{index}",
                        conversation_id="conversation-receipt-contract",
                    )
                )
                self.assertIsInstance(receipt, DraftExecutionReceipt)
                self.assertIsInstance(receipt.entity_ids, tuple)
                self.assertEqual(receipt.cache_scopes, fixture.expected_cache_scopes)
                self.assertEqual(
                    receipt.revert_adapter_key,
                    fixture.expected_revert_adapter_key,
                )
                if fixture.expected_revert_adapter_key is None:
                    self.assertIsNone(receipt.revert_context)
                else:
                    self.assertIsInstance(receipt.revert_context, dict)
                    self.assertEqual(receipt.revert_context.get("schema_version"), 1)
                db.rollback()

    def test_registry_rejects_a_stale_tuple_executor(self) -> None:
        stale_spec = replace(
            draft_operation_registry.get("meal_plan"),
            execute=lambda _context: ({"items": []}, []),
        )
        registry = DraftOperationRegistry([stale_spec])
        with self.SessionLocal() as db, self.assertRaisesRegex(TypeError, "DraftExecutionReceipt"):
            registry.execute(
                DraftExecuteContext(
                    db=db,
                    draft_type="meal_plan",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={},
                    assert_updated_at_matches=assert_updated_at_matches,
                    operation_idempotency_key="receipt-contract:stale",
                )
            )

    def test_execute_context_carries_commit_timing_boundaries(self) -> None:
        committed_at = utcnow()
        revertible_until = committed_at + timedelta(minutes=5)
        with self.SessionLocal() as db:
            context = DraftExecuteContext(
                db=db,
                draft_type="meal_plan",
                family_id=self.family.id,
                user_id=self.user.id,
                payload={},
                assert_updated_at_matches=assert_updated_at_matches,
                operation_idempotency_key="receipt-contract:timing",
                committed_at=committed_at,
                revertible_until=revertible_until,
            )
        self.assertEqual(context.committed_at, committed_at)
        self.assertEqual(context.revertible_until, revertible_until)
