from datetime import date
from decimal import Decimal

from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from sqlalchemy import func, select

from app.models.domain import Ingredient, InventoryItem, InventoryOperation, ShoppingListItem
from app.services.ai_operations.drafts import normalize_ai_draft_payload
from app.services.ai_operations.executor import execute_ai_operation_draft
from app.services.ai_operations.registry import draft_operation_registry

from ._support import AIAgentInfraTestCase


class AIShoppingIntakeTestCase(AIAgentInfraTestCase):
    def _executor(self, db):
        return ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=db,
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-shopping-intake",
                run_id="run-shopping-intake",
            ),
        )

    def test_registry_and_tool_expose_atomic_shopping_intake_draft(self) -> None:
        self.assertTrue(draft_operation_registry.supports("shopping_intake"))

        definition = build_workspace_tool_registry().get("shopping.create_intake_draft")

        self.assertEqual(definition.side_effect, "draft")
        self.assertTrue(definition.requires_confirmation)
        self.assertEqual(definition.draft_types, ["shopping_intake"])
        self.assertEqual(
            definition.input_schema["properties"]["draft"]["properties"]["draftType"]["enum"],
            ["shopping_intake"],
        )

    def test_intake_draft_stamps_real_exact_ingredient_boundaries(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = ShoppingListItem(
                id="shopping-ai-intake-tomato",
                family_id=self.family.id,
                ingredient_id=ingredient.id,
                title=ingredient.name,
                quantity=Decimal("3"),
                unit="个",
                reason="补货",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()

            result = self._executor(db).call(
                "shopping.create_intake_draft",
                {
                    "draft": {
                        "draftType": "shopping_intake",
                        "schemaVersion": "shopping_intake.v1",
                        "purchaseDate": date.today().isoformat(),
                        "items": [
                            {
                                "shoppingItemId": item.id,
                                "matchLevel": "confirmed",
                                "matchReason": "用户明确选择该待买项",
                                "action": "stock_and_fulfill",
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            }
                        ],
                        "unmatchedCandidates": [],
                    }
                },
            )

            draft = result["draft"]
            normalized = draft["items"][0]
            self.assertEqual(draft["draftType"], "shopping_intake")
            self.assertEqual(draft["schemaVersion"], "shopping_intake.v1")
            self.assertTrue(draft["clientRequestId"].startswith("ai-shopping-intake-"))
            self.assertEqual(normalized["shoppingItemId"], item.id)
            self.assertEqual(normalized["expectedShoppingItemRowVersion"], item.row_version)
            self.assertEqual(normalized["plannedQuantity"], "3")
            self.assertEqual(normalized["plannedUnit"], "个")
            self.assertEqual(normalized["targetId"], ingredient.id)
            self.assertEqual(normalized["expectedIngredientRowVersion"], ingredient.row_version)
            self.assertEqual(normalized["actualQuantity"], "2")
            self.assertEqual(normalized["actualUnit"], "个")

    def test_new_shopping_list_tool_rejects_done_true_in_favor_of_intake(self) -> None:
        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-ai-intake-route",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("1"),
                unit="个",
                reason="",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()

            with self.assertRaisesRegex(ValueError, "shopping.create_intake_draft"):
                self._executor(db).call(
                    "shopping.create_draft",
                    {
                        "draft": {
                            "draftType": "shopping_list",
                            "schemaVersion": "shopping_list_operation.v1",
                            "operations": [
                                {
                                    "action": "set_done",
                                    "targetId": item.id,
                                    "baseUpdatedAt": item.updated_at.isoformat(),
                                    "payload": {"done": True},
                                }
                            ],
                        }
                    },
                )

    def test_exact_intake_executor_partially_fulfills_and_stocks_in_one_operation(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = ShoppingListItem(
                id="shopping-ai-intake-execute",
                family_id=self.family.id,
                ingredient_id=ingredient.id,
                title=ingredient.name,
                quantity=Decimal("3"),
                unit="个",
                reason="补货",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            draft = self._executor(db).call(
                "shopping.create_intake_draft",
                {
                    "draft": {
                        "draftType": "shopping_intake",
                        "schemaVersion": "shopping_intake.v1",
                        "purchaseDate": date.today().isoformat(),
                        "items": [
                            {
                                "shoppingItemId": item.id,
                                "matchLevel": "confirmed",
                                "matchReason": "用户明确选择",
                                "action": "stock_and_fulfill",
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ],
                        "unmatchedCandidates": [
                            {
                                "label": "临时买的苏打水",
                                "recommendationType": "food_profile",
                                "recommendation": "建议先创建包装食品资料，再单独登记库存",
                            }
                        ],
                    }
                },
            )["draft"]
            inventory_count_before = db.scalar(select(func.count()).select_from(InventoryItem))

            business_entity, entity_ids = execute_ai_operation_draft(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                draft_type="shopping_intake",
                payload=draft,
                assert_updated_at_matches=lambda **_kwargs: None,
                operation_idempotency_key="ai-approval-shopping-intake-execute",
                conversation_id="conversation-shopping-intake",
            )

            db.flush()
            self.assertFalse(item.done)
            self.assertEqual(item.quantity, Decimal("1"))
            self.assertEqual(
                db.scalar(select(func.count()).select_from(InventoryItem)),
                inventory_count_before + 1,
            )
            self.assertIsNotNone(db.get(InventoryOperation, business_entity["operation_id"]))
            self.assertIn(item.id, entity_ids)
            self.assertEqual(
                business_entity["unmatchedCandidates"][0]["recommendationType"],
                "food_profile",
            )

    def test_missing_actual_quantity_is_draftable_but_blocks_approval(self) -> None:
        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-ai-intake-missing-quantity",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("2"),
                unit="个",
                reason="",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            draft = self._executor(db).call(
                "shopping.create_intake_draft",
                {
                    "draft": {
                        "draftType": "shopping_intake",
                        "schemaVersion": "shopping_intake.v1",
                        "purchaseDate": date.today().isoformat(),
                        "items": [
                            {
                                "shoppingItemId": item.id,
                                "matchLevel": "suggested",
                                "matchReason": "唯一合理候选",
                                "action": "stock_and_fulfill",
                                "targetKind": "exact_ingredient",
                                "targetId": "ingredient-tomato",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ],
                        "unmatchedCandidates": [],
                    }
                },
            )["draft"]

            self.assertIsNone(draft["items"][0]["actualQuantity"])
            with self.assertRaisesRegex(ValueError, "实际购买数量不能为空"):
                normalize_ai_draft_payload(
                    db,
                    draft_type="shopping_intake",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-shopping-intake",
                    payload=draft,
                    phase="approval",
                )

    def test_preview_candidates_separates_confirmed_suggested_ambiguous_and_unmatched(self) -> None:
        with self.SessionLocal() as db:
            rows = [
                ShoppingListItem(
                    id="shopping-preview-tomato",
                    family_id=self.family.id,
                    ingredient_id="ingredient-tomato",
                    title="番茄",
                    quantity=Decimal("2"),
                    unit="个",
                    reason="",
                    done=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                ),
                ShoppingListItem(
                    id="shopping-preview-milk-a",
                    family_id=self.family.id,
                    title="牛奶",
                    quantity=Decimal("1"),
                    unit="盒",
                    reason="",
                    done=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                ),
                ShoppingListItem(
                    id="shopping-preview-milk-b",
                    family_id=self.family.id,
                    title="牛奶",
                    quantity=Decimal("2"),
                    unit="瓶",
                    reason="",
                    done=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                ),
            ]
            db.add_all(rows)
            db.flush()

            result = self._executor(db).call(
                "shopping.preview_intake_candidates",
                {
                    "lines": [
                        {
                            "clientKey": "explicit",
                            "label": "番茄",
                            "shoppingItemId": "shopping-preview-tomato",
                            "enteredQuantity": "2",
                            "enteredUnit": "个",
                        },
                        {"clientKey": "suggested", "label": "新鲜番茄采购"},
                        {"clientKey": "ambiguous", "label": "牛奶"},
                        {
                            "clientKey": "unmatched",
                            "label": "盒装苏打水",
                            "targetHint": "food",
                            "enteredQuantity": "1",
                            "enteredUnit": "箱",
                        },
                    ]
                },
            )

            self.assertEqual([item["clientKey"] for item in result["confirmedMatches"]], ["explicit"])
            self.assertEqual([item["clientKey"] for item in result["suggestedMatches"]], ["suggested"])
            self.assertEqual(len(result["ambiguousMatches"][0]["shoppingCandidates"]), 2)
            self.assertEqual(result["unmatchedCandidates"][0]["recommendationType"], "food_profile")
            self.assertIn("创建", result["unmatchedCandidates"][0]["recommendation"])

    def test_approval_normalization_preserves_proposal_version_boundaries(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = ShoppingListItem(
                id="shopping-ai-intake-stale-boundary",
                family_id=self.family.id,
                ingredient_id=ingredient.id,
                title=ingredient.name,
                quantity=Decimal("2"),
                unit="个",
                reason="",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            draft = self._executor(db).call(
                "shopping.create_intake_draft",
                {
                    "draft": {
                        "draftType": "shopping_intake",
                        "schemaVersion": "shopping_intake.v1",
                        "purchaseDate": date.today().isoformat(),
                        "items": [
                            {
                                "shoppingItemId": item.id,
                                "matchLevel": "confirmed",
                                "matchReason": "明确选择",
                                "action": "stock_and_fulfill",
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ],
                        "unmatchedCandidates": [],
                    }
                },
            )["draft"]
            proposal_shopping_version = draft["items"][0]["expectedShoppingItemRowVersion"]
            proposal_ingredient_version = draft["items"][0]["expectedIngredientRowVersion"]
            item.reason = "其他成员修改了购物项"
            ingredient.notes = "其他成员修改了档案"
            db.flush()
            self.assertGreater(item.row_version, proposal_shopping_version)
            self.assertGreater(ingredient.row_version, proposal_ingredient_version)

            approval_payload = normalize_ai_draft_payload(
                db,
                draft_type="shopping_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-shopping-intake",
                payload=draft,
                phase="approval",
            )

            self.assertEqual(
                approval_payload["items"][0]["expectedShoppingItemRowVersion"],
                proposal_shopping_version,
            )
            self.assertEqual(
                approval_payload["items"][0]["expectedIngredientRowVersion"],
                proposal_ingredient_version,
            )

    def test_full_approval_commits_shopping_and_inventory_with_one_approval(self) -> None:
        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-ai-intake-full-approval",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("2"),
                unit="个",
                reason="",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="shopping_intake",
                suffix="shopping-intake-full",
                payload={
                    "draftType": "shopping_intake",
                    "schemaVersion": "shopping_intake.v1",
                    "purchaseDate": date.today().isoformat(),
                    "items": [
                        {
                            "shoppingItemId": item.id,
                            "matchLevel": "confirmed",
                            "matchReason": "用户明确选择",
                            "action": "stock_and_fulfill",
                            "targetKind": "exact_ingredient",
                            "targetId": "ingredient-tomato",
                            "enteredQuantity": "2",
                            "enteredUnit": "个",
                            "inventoryStatus": "fresh",
                            "storageLocation": "冷藏",
                        }
                    ],
                    "unmatchedCandidates": [],
                },
            )

            self.assertEqual(approval.approval_type, "shopping_intake.apply")
            self.assertEqual(approval.field_schema[0]["widget"], "shopping_intake_editor")
            result = self._approve_ai_approval_for_test(
                service,
                draft=draft,
                approval=approval,
            )

            db.flush()
            self.assertEqual(result["operation"]["status"], "succeeded")
            self.assertTrue(item.done)
            self.assertEqual(
                db.scalar(
                    select(func.count())
                    .select_from(InventoryOperation)
                    .where(InventoryOperation.operation_type == "shopping_intake")
                ),
                1,
            )
