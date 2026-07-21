from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from app.ai.tools import ToolContext, ToolExecutor, build_workspace_tool_registry
from sqlalchemy import func, select

from app.models.domain import Food, Ingredient, InventoryItem, InventoryOperation, ShoppingListItem
from app.core.enums import FoodType, IngredientExpiryMode
from app.services.ai_operations.drafts import normalize_ai_draft_payload
from app.services.ai_operations.executor import execute_ai_operation_draft
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.inventory_intake import (
    execute_inventory_intake_draft,
    validate_inventory_intake_approval_value,
)
from app.services.ai_operations.registry_types import DraftExecuteContext

from ._support import AIAgentInfraTestCase


class AIInventoryIntakeTestCase(AIAgentInfraTestCase):
    def _executor(self, db):
        return ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=db,
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                run_id="run-inventory-intake",
            ),
        )

    def _shopping_item(self, db, *, item_id: str, ingredient_id: str = "ingredient-tomato", title: str = "番茄", quantity: str = "3") -> ShoppingListItem:
        ingredient = db.get(Ingredient, ingredient_id)
        assert ingredient is not None
        item = ShoppingListItem(
            id=item_id,
            family_id=self.family.id,
            ingredient_id=ingredient.id,
            title=title,
            quantity=Decimal(quantity),
            unit="个",
            reason="补货",
            done=False,
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add(item)
        db.flush()
        return item

    def _ready_food(self, db, *, food_id: str = "food-ready-beef", name: str = "卤牛肉") -> Food:
        food = Food(
            id=food_id,
            family_id=self.family.id,
            name=name,
            type=FoodType.READY_MADE,
            category="熟食",
            stock_quantity=Decimal("1"),
            stock_unit="份",
            storage_location="冷藏",
            flavor_tags=[],
            scene="",
            notes="",
        )
        db.add(food)
        db.flush()
        return food

    def _base_draft(
        self,
        *,
        items: list[dict],
        ignored_items: list[dict] | None = None,
        intake_date: str | None = None,
        source_type: str = "receipt_image",
        intake_date_source: str = "receipt",
        source_reference: dict | None = None,
    ) -> dict:
        return {
            "draftType": "inventory_intake",
            "schemaVersion": "inventory_intake.v1",
            "sourceType": source_type,
            "sourceReference": source_reference if source_reference is not None else {"mediaId": "media_xxx"},
            "intakeDate": intake_date or date.today().isoformat(),
            "intakeDateSource": intake_date_source,
            "items": items,
            "ignoredItems": ignored_items or [],
        }

    def test_registry_exposes_only_inventory_intake_draft(self) -> None:
        self.assertTrue(draft_operation_registry.supports("inventory_intake"))
        self.assertFalse(draft_operation_registry.supports("shopping_intake"))
        definition = build_workspace_tool_registry().get("inventory.create_intake_draft")
        self.assertEqual(definition.draft_types, ["inventory_intake"])
        self.assertEqual(definition.side_effect, "draft")
        self.assertTrue(definition.requires_confirmation)

    def test_old_shopping_intake_draft_is_not_registered(self) -> None:
        self.assertFalse(draft_operation_registry.supports("shopping_intake"))
        registry = build_workspace_tool_registry()
        tool_names = {tool.name for tool in registry.list()}
        self.assertNotIn("shopping.create_intake_draft", tool_names)
        self.assertIn("inventory.create_intake_draft", tool_names)

    def test_normalizer_stamps_shopping_target_and_versions(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-tomato")

            result = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            }
                        ]
                    )
                },
            )

            draft = result["draft"]
            normalized = draft["items"][0]
            self.assertEqual(draft["draftType"], "inventory_intake")
            self.assertEqual(draft["schemaVersion"], "inventory_intake.v1")
            self.assertTrue(draft["clientRequestId"].startswith("ai-inventory-intake-"))
            self.assertEqual(normalized["shoppingItemId"], item.id)
            self.assertEqual(normalized["expectedShoppingItemRowVersion"], item.row_version)
            self.assertEqual(normalized["title"], item.title)
            self.assertEqual(normalized["plannedQuantity"], "3")
            self.assertEqual(normalized["plannedUnit"], "个")
            self.assertEqual(normalized["targetId"], ingredient.id)
            self.assertEqual(normalized["expectedIngredientRowVersion"], ingredient.row_version)
            self.assertEqual(normalized["actualQuantity"], "2")
            self.assertEqual(normalized["actualUnit"], "个")
            self.assertIsInstance(normalized["before"], dict)
            self.assertIsInstance(normalized["impact"], dict)

    def test_normalizer_stamps_direct_food_target_and_versions(self) -> None:
        with self.SessionLocal() as db:
            food = self._ready_food(db)

            result = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        source_type="gift",
                        intake_date_source="user_explicit",
                        items=[
                            {
                                "lineId": "line-food",
                                "sourceLineId": "gift-1",
                                "sourceText": "卤牛肉 1份",
                                "sourceKind": "direct",
                                "action": "stock_only",
                                "targetKind": "food",
                                "targetId": food.id,
                                "enteredQuantity": "1",
                                "enteredUnit": "份",
                                "storageLocation": "冷藏",
                                "notes": "朋友送来",
                            }
                        ],
                    )
                },
            )

            draft = result["draft"]
            normalized = draft["items"][0]
            self.assertEqual(normalized["sourceKind"], "direct")
            self.assertEqual(normalized["action"], "stock_only")
            self.assertEqual(normalized["targetKind"], "food")
            self.assertEqual(normalized["targetId"], food.id)
            self.assertEqual(normalized["expectedFoodRowVersion"], food.row_version)
            self.assertIsNone(normalized["shoppingItemId"])
            self.assertEqual(normalized["actualQuantity"], "1")
            self.assertEqual(normalized["actualUnit"], "份")
            self.assertIsInstance(normalized["before"], dict)

    def test_normalizer_keeps_ignored_items_read_only(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-ignored")

            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ],
                        ignored_items=[
                            {
                                "sourceLineId": "receipt-4",
                                "sourceText": "垃圾袋 1个",
                                "displayName": "垃圾袋",
                                "reasonCode": "non_inventory_item",
                                "reason": "非食品库存对象，本次不会入库",
                            }
                        ],
                    )
                },
            )["draft"]

            self.assertEqual(len(draft["ignoredItems"]), 1)
            ignored = draft["ignoredItems"][0]
            self.assertEqual(ignored["sourceLineId"], "receipt-4")
            self.assertEqual(ignored["displayName"], "垃圾袋")
            self.assertEqual(ignored["reasonCode"], "non_inventory_item")

            submitted = {
                **draft,
                "ignoredItems": [
                    {
                        **ignored,
                        "reason": "尝试修改只读忽略项",
                        "displayName": "被改名",
                    }
                ],
            }
            with self.assertRaisesRegex(ValueError, "忽略|只读|不能修改"):
                validate_inventory_intake_approval_value(draft, submitted)

    def test_normalizer_rejects_ambiguous_or_unresolved_rows(self) -> None:
        with self.SessionLocal() as db:
            item = self._shopping_item(db, item_id="shopping-ai-intake-ambiguous")
            # Blocker markers are rejected before approval; schema also forbids matchLevel.
            with self.assertRaisesRegex(ValueError, "歧义|未解决|目标|候选|unknown fields|matchLevel"):
                self._executor(db).call(
                    "inventory.create_intake_draft",
                    {
                        "draft": self._base_draft(
                            items=[
                                {
                                    "lineId": "line-1",
                                    "sourceLineId": "receipt-1",
                                    "sourceText": "番茄",
                                    "sourceKind": "shopping_item",
                                    "action": "stock_and_fulfill",
                                    "shoppingItemId": item.id,
                                    "targetKind": "exact_ingredient",
                                    "matchLevel": "ambiguous",
                                }
                            ]
                        )
                    },
                )

            with self.assertRaisesRegex(ValueError, "目标|未解决|不能为空"):
                self._executor(db).call(
                    "inventory.create_intake_draft",
                    {
                        "draft": self._base_draft(
                            items=[
                                {
                                    "lineId": "line-2",
                                    "sourceLineId": "receipt-2",
                                    "sourceText": "未知食材",
                                    "sourceKind": "direct",
                                    "action": "stock_only",
                                    "targetKind": "exact_ingredient",
                                }
                            ]
                        )
                    },
                )

            from app.services.ai_operations.inventory_intake import normalize_inventory_intake_draft
            from app.services.ai_operations.registry_types import DraftNormalizeContext

            with self.assertRaisesRegex(ValueError, "歧义|未解决|候选"):
                normalize_inventory_intake_draft(
                    DraftNormalizeContext(
                        db=db,
                        draft_type="inventory_intake",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-inventory-intake",
                        payload=self._base_draft(
                            items=[
                                {
                                    "lineId": "line-3",
                                    "sourceLineId": "receipt-3",
                                    "sourceText": "番茄",
                                    "sourceKind": "shopping_item",
                                    "action": "stock_and_fulfill",
                                    "shoppingItemId": item.id,
                                    "targetKind": "exact_ingredient",
                                    "targetId": "ingredient-tomato",
                                    "matchLevel": "ambiguous",
                                    "matchReason": "多个候选",
                                }
                            ]
                        ),
                    )
                )

    def test_inventory_intake_draft_rejects_more_than_thirty_original_lines(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-thirty")
            items = [
                {
                    "lineId": f"line-{index}",
                    "sourceLineId": f"source-{index}",
                    "sourceText": f"番茄 {index}",
                    "sourceKind": "shopping_item" if index == 0 else "direct",
                    "action": "stock_and_fulfill" if index == 0 else "skip",
                    "shoppingItemId": item.id if index == 0 else None,
                    "targetKind": "exact_ingredient" if index == 0 else "none",
                    "targetId": ingredient.id if index == 0 else None,
                    "enteredQuantity": "1" if index == 0 else None,
                    "enteredUnit": "个" if index == 0 else None,
                    "inventoryStatus": "fresh" if index == 0 else None,
                    "storageLocation": "冷藏" if index == 0 else None,
                }
                for index in range(20)
            ]
            ignored = [
                {
                    "sourceLineId": f"ignored-{index}",
                    "sourceText": f"垃圾袋 {index}",
                    "displayName": f"垃圾袋{index}",
                    "reasonCode": "non_inventory_item",
                    "reason": "非食品",
                }
                for index in range(11)
            ]
            with self.assertRaisesRegex(ValueError, "30"):
                self._executor(db).call(
                    "inventory.create_intake_draft",
                    {"draft": self._base_draft(items=items, ignored_items=ignored)},
                )

    def test_approval_allows_action_quantity_date_storage_expiry_status_and_notes(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-editable")
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                                "notes": "",
                            }
                        ]
                    )
                },
            )["draft"]

            # Editable stock fields remain mutable on approval.
            stock_submitted = {
                **draft,
                "intakeDate": draft["intakeDate"],
                "items": [
                    {
                        **draft["items"][0],
                        "enteredQuantity": "1",
                        "enteredUnit": "个",
                        "inventoryStatus": "opened",
                        "storageLocation": "冷冻",
                        "expiryDate": (date.today()).isoformat(),
                        "notes": "用户修改备注",
                        "action": "stock_and_fulfill",
                    }
                ],
            }
            validate_inventory_intake_approval_value(draft, stock_submitted)
            stock_payload = normalize_ai_draft_payload(
                db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                payload=stock_submitted,
                phase="approval",
            )
            stock_row = stock_payload["items"][0]
            self.assertEqual(stock_row["enteredQuantity"], "1")
            self.assertEqual(stock_row["actualQuantity"], "1")
            self.assertEqual(stock_row["inventoryStatus"], "opened")
            self.assertEqual(stock_row["storageLocation"], "冷冻")
            self.assertEqual(stock_row["notes"], "用户修改备注")
            self.assertEqual(stock_row["action"], "stock_and_fulfill")
            self.assertEqual(stock_row["targetKind"], draft["items"][0]["targetKind"])
            self.assertEqual(stock_row["targetId"], draft["items"][0]["targetId"])
            self.assertEqual(stock_row["expectedShoppingItemRowVersion"], draft["items"][0]["expectedShoppingItemRowVersion"])
            self.assertEqual(stock_row["expectedIngredientRowVersion"], draft["items"][0]["expectedIngredientRowVersion"])
            self.assertEqual(stock_row["before"], draft["items"][0]["before"])

            # Action may change to fulfill_without_stock while target identity stays immutable.
            fulfill_submitted = {
                **draft,
                "intakeDate": draft["intakeDate"],
                "items": [
                    {
                        **draft["items"][0],
                        "action": "fulfill_without_stock",
                        "notes": "改成仅完成采购",
                    }
                ],
            }
            validate_inventory_intake_approval_value(draft, fulfill_submitted)
            fulfill_payload = normalize_ai_draft_payload(
                db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                payload=fulfill_submitted,
                phase="approval",
            )
            fulfill_row = fulfill_payload["items"][0]
            self.assertEqual(fulfill_row["action"], "fulfill_without_stock")
            self.assertEqual(fulfill_row["targetKind"], draft["items"][0]["targetKind"])
            self.assertEqual(fulfill_row["targetId"], draft["items"][0]["targetId"])
            self.assertEqual(fulfill_row["notes"], "改成仅完成采购")
            self.assertIsNone(fulfill_row.get("actualQuantity"))
            self.assertIsNone(fulfill_row.get("storageLocation"))
            self.assertTrue(fulfill_row["impact"]["fulfillsShopping"])
            self.assertFalse(fulfill_row["impact"]["stocksInventory"])

            # Action may also change to skip.
            skip_submitted = {
                **draft,
                "items": [
                    {
                        **draft["items"][0],
                        "action": "skip",
                        "notes": "本次跳过",
                    }
                ],
            }
            validate_inventory_intake_approval_value(draft, skip_submitted)
            skip_payload = normalize_ai_draft_payload(
                db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                payload=skip_submitted,
                phase="approval",
            )
            skip_row = skip_payload["items"][0]
            self.assertEqual(skip_row["action"], "skip")
            self.assertEqual(skip_row["targetKind"], draft["items"][0]["targetKind"])
            self.assertTrue(skip_row["impact"]["skips"])

    def test_approval_rejects_source_identity_target_version_and_before_changes(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-immutable")
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ]
                    )
                },
            )["draft"]

            for field, value in {
                "clientRequestId": "ai-inventory-intake-forged",
                "sourceType": "manual_text",
                "intakeDateSource": "user_explicit",
                "sourceReference": {"mediaId": "other"},
            }.items():
                submitted = {**draft, field: value}
                with self.assertRaisesRegex(ValueError, "不能修改|只读|确认阶段"):
                    validate_inventory_intake_approval_value(draft, submitted)

            for field, value in {
                "lineId": "line-forged",
                "sourceLineId": "forged",
                "sourceText": "改写来源",
                "sourceKind": "direct",
                "shoppingItemId": "shopping-other",
                "expectedShoppingItemRowVersion": 999,
                "targetKind": "food",
                "targetId": "food-other",
                "expectedIngredientRowVersion": 999,
                "plannedQuantity": "9",
                "plannedUnit": "箱",
                "before": {"forged": True},
            }.items():
                submitted = {
                    **draft,
                    "items": [{**draft["items"][0], field: value}],
                }
                with self.assertRaisesRegex(ValueError, "不能修改|确认阶段|目标|版本|来源"):
                    validate_inventory_intake_approval_value(draft, submitted)

    def test_approval_rejects_added_or_removed_rows(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-rows")
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ]
                    )
                },
            )["draft"]

            with self.assertRaisesRegex(ValueError, "添加|删除|行"):
                validate_inventory_intake_approval_value(
                    draft,
                    {
                        **draft,
                        "items": [
                            draft["items"][0],
                            {
                                **draft["items"][0],
                                "lineId": "line-2",
                                "sourceLineId": "receipt-2",
                            },
                        ],
                    },
                )

            with self.assertRaisesRegex(ValueError, "添加|删除|行"):
                validate_inventory_intake_approval_value(draft, {**draft, "items": []})

    def test_executor_filters_skip_and_calls_service_once(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-skip-filter", quantity="2")
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            },
                            {
                                "lineId": "line-2",
                                "sourceLineId": "receipt-2",
                                "sourceText": "暂不处理",
                                "sourceKind": "direct",
                                "action": "skip",
                                "targetKind": "none",
                            },
                        ]
                    )
                },
            )["draft"]

            inventory_count_before = db.scalar(select(func.count()).select_from(InventoryItem))
            with patch(
                "app.services.ai_operations.inventory_intake.apply_inventory_intake",
                wraps=__import__(
                    "app.services.inventory_intake", fromlist=["apply_inventory_intake"]
                ).apply_inventory_intake,
            ) as mocked:
                business_entity, entity_ids = execute_ai_operation_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    draft_type="inventory_intake",
                    payload=draft,
                    assert_updated_at_matches=lambda **_kwargs: None,
                    operation_idempotency_key="ai-approval-inventory-intake-execute",
                    conversation_id="conversation-inventory-intake",
                )
                self.assertEqual(mocked.call_count, 1)
                request = mocked.call_args.kwargs["request"]
                self.assertEqual(len(request.items), 1)
                self.assertEqual(request.items[0].line_id, "line-1")
                self.assertEqual(request.items[0].source_kind, "shopping_item")

            db.flush()
            self.assertTrue(item.done)
            self.assertEqual(
                db.scalar(select(func.count()).select_from(InventoryItem)),
                inventory_count_before + 1,
            )
            self.assertIsNotNone(db.get(InventoryOperation, business_entity["operation_id"]))
            self.assertIn(item.id, entity_ids)

    def test_executor_rejects_all_skip(self) -> None:
        with self.SessionLocal() as db:
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "跳过",
                                "sourceKind": "direct",
                                "action": "skip",
                                "targetKind": "none",
                            }
                        ]
                    )
                },
            )["draft"]
            with self.assertRaisesRegex(ValueError, "skip|跳过|至少|可执行"):
                execute_inventory_intake_draft(
                    DraftExecuteContext(
                        db=db,
                        draft_type="inventory_intake",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        payload=draft,
                        assert_updated_at_matches=lambda **_kwargs: None,
                        operation_idempotency_key="ai-approval-inventory-intake-all-skip",
                        conversation_id="conversation-inventory-intake",
                    )
                )

    def test_approval_stock_to_fulfill_without_stock_executes(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-fulfill-action", quantity="2")
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ]
                    )
                },
            )["draft"]

            submitted = {
                **draft,
                "items": [
                    {
                        **draft["items"][0],
                        "action": "fulfill_without_stock",
                        "notes": "只完成采购不入库",
                    }
                ],
            }
            validate_inventory_intake_approval_value(draft, submitted)
            approval_payload = normalize_ai_draft_payload(
                db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                payload=submitted,
                phase="approval",
            )
            self.assertEqual(approval_payload["items"][0]["action"], "fulfill_without_stock")
            # Display immutables may keep original target identity.
            self.assertEqual(approval_payload["items"][0]["targetKind"], "exact_ingredient")
            self.assertEqual(approval_payload["items"][0]["targetId"], ingredient.id)

            inventory_count_before = db.scalar(select(func.count()).select_from(InventoryItem))
            with patch(
                "app.services.ai_operations.inventory_intake.apply_inventory_intake",
                wraps=__import__(
                    "app.services.inventory_intake", fromlist=["apply_inventory_intake"]
                ).apply_inventory_intake,
            ) as mocked:
                business_entity, entity_ids = execute_ai_operation_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    draft_type="inventory_intake",
                    payload=approval_payload,
                    assert_updated_at_matches=lambda **_kwargs: None,
                    operation_idempotency_key="ai-approval-inventory-intake-fulfill-only",
                    conversation_id="conversation-inventory-intake",
                )
                self.assertEqual(mocked.call_count, 1)
                request = mocked.call_args.kwargs["request"]
                self.assertEqual(len(request.items), 1)
                service_item = request.items[0]
                self.assertEqual(service_item.action, "fulfill_without_stock")
                self.assertEqual(service_item.target_kind, "none")
                self.assertIsNone(service_item.target_id)
                self.assertIsNone(service_item.actual_quantity)
                self.assertIsNone(service_item.storage_location)
                self.assertIsNone(service_item.expiry_date)
                self.assertIsNone(service_item.inventory_status)

            db.flush()
            self.assertTrue(item.done)
            self.assertEqual(
                db.scalar(select(func.count()).select_from(InventoryItem)),
                inventory_count_before,
            )
            self.assertIsNotNone(db.get(InventoryOperation, business_entity["operation_id"]))
            self.assertIn(item.id, entity_ids)

    def test_approval_stock_to_skip_is_filtered_from_service(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-skip-action", quantity="2")
            food = self._ready_food(db, food_id="food-ready-skip-action")
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            },
                            {
                                "lineId": "line-2",
                                "sourceLineId": "receipt-2",
                                "sourceText": "卤牛肉 1份",
                                "sourceKind": "direct",
                                "action": "stock_only",
                                "targetKind": "food",
                                "targetId": food.id,
                                "enteredQuantity": "1",
                                "enteredUnit": "份",
                                "storageLocation": "冷藏",
                            },
                        ]
                    )
                },
            )["draft"]

            submitted = {
                **draft,
                "items": [
                    {
                        **draft["items"][0],
                        "action": "skip",
                        "notes": "这行跳过",
                    },
                    draft["items"][1],
                ],
            }
            validate_inventory_intake_approval_value(draft, submitted)
            approval_payload = normalize_ai_draft_payload(
                db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                payload=submitted,
                phase="approval",
            )
            self.assertEqual(approval_payload["items"][0]["action"], "skip")
            self.assertEqual(approval_payload["summary"]["skipCount"], 1)
            self.assertEqual(approval_payload["summary"]["executableCount"], 1)

            with patch(
                "app.services.ai_operations.inventory_intake.apply_inventory_intake",
                wraps=__import__(
                    "app.services.inventory_intake", fromlist=["apply_inventory_intake"]
                ).apply_inventory_intake,
            ) as mocked:
                execute_ai_operation_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    draft_type="inventory_intake",
                    payload=approval_payload,
                    assert_updated_at_matches=lambda **_kwargs: None,
                    operation_idempotency_key="ai-approval-inventory-intake-skip-filter",
                    conversation_id="conversation-inventory-intake",
                )
                request = mocked.call_args.kwargs["request"]
                self.assertEqual(len(request.items), 1)
                self.assertEqual(request.items[0].line_id, "line-2")
                self.assertEqual(request.items[0].action, "stock_only")

            db.flush()
            self.assertFalse(item.done)

    def test_approval_recomputes_default_expiry_when_intake_date_changes(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            ingredient.default_expiry_mode = IngredientExpiryMode.DAYS
            ingredient.default_expiry_days = 7
            db.flush()

            item = self._shopping_item(db, item_id="shopping-ai-intake-expiry-shift", quantity="2")
            original_intake = date.today() - timedelta(days=3)
            draft = self._executor(db).call(
                "inventory.create_intake_draft",
                {
                    "draft": self._base_draft(
                        intake_date=original_intake.isoformat(),
                        items=[
                            {
                                "lineId": "line-1",
                                "sourceLineId": "receipt-1",
                                "sourceText": "番茄 2个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": item.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ],
                    )
                },
            )["draft"]
            self.assertEqual(draft["intakeDate"], original_intake.isoformat())
            self.assertEqual(
                draft["items"][0]["expiryDate"],
                (original_intake + timedelta(days=7)).isoformat(),
            )
            self.assertEqual(draft["intakeDateSource"], "receipt")

            new_intake = date.today()
            submitted = {
                **draft,
                "intakeDate": new_intake.isoformat(),
                "items": [
                    {
                        **draft["items"][0],
                        # omit explicit expiry so default can recompute against new intakeDate
                        "expiryDate": None,
                    }
                ],
            }
            validate_inventory_intake_approval_value(draft, submitted)
            approval_payload = normalize_ai_draft_payload(
                db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                payload=submitted,
                phase="approval",
            )
            self.assertEqual(approval_payload["intakeDate"], new_intake.isoformat())
            self.assertEqual(approval_payload["intakeDateSource"], "receipt")
            self.assertEqual(
                approval_payload["items"][0]["expiryDate"],
                (new_intake + timedelta(days=7)).isoformat(),
            )

            # Explicit expiry is preserved and validated against the new intake date.
            explicit_expiry = new_intake + timedelta(days=2)
            explicit_submitted = {
                **draft,
                "intakeDate": new_intake.isoformat(),
                "items": [
                    {
                        **draft["items"][0],
                        "expiryDate": explicit_expiry.isoformat(),
                    }
                ],
            }
            explicit_payload = normalize_ai_draft_payload(
                db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-inventory-intake",
                payload=explicit_submitted,
                phase="approval",
            )
            self.assertEqual(explicit_payload["items"][0]["expiryDate"], explicit_expiry.isoformat())

            with self.assertRaisesRegex(ValueError, "保质期不能早于入库日期"):
                normalize_ai_draft_payload(
                    db,
                    draft_type="inventory_intake",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-inventory-intake",
                    payload={
                        **draft,
                        "intakeDate": new_intake.isoformat(),
                        "items": [
                            {
                                **draft["items"][0],
                                "expiryDate": (new_intake - timedelta(days=1)).isoformat(),
                            }
                        ],
                    },
                    phase="approval",
                )

    def test_inventory_intake_approval_uses_new_type_schema_and_widget(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            item = self._shopping_item(db, item_id="shopping-ai-intake-approval-meta", quantity="2")
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="inventory_intake",
                suffix="inventory-intake-full",
                payload=self._base_draft(
                    items=[
                        {
                            "lineId": "line-1",
                            "sourceLineId": "receipt-1",
                            "sourceText": "番茄 2个",
                            "sourceKind": "shopping_item",
                            "action": "stock_and_fulfill",
                            "shoppingItemId": item.id,
                            "targetKind": "exact_ingredient",
                            "targetId": ingredient.id,
                            "enteredQuantity": "2",
                            "enteredUnit": "个",
                            "inventoryStatus": "fresh",
                            "storageLocation": "冷藏",
                        }
                    ]
                ),
            )

            self.assertEqual(approval.approval_type, "inventory_intake.apply")
            self.assertEqual(approval.field_schema[0]["widget"], "inventory_intake_editor")
            config = draft_operation_registry.approval_config_for_payload("inventory_intake", draft.payload)
            self.assertEqual(config["title"], "确认入库")
            self.assertEqual(config["approve_label"], "确认入库")
            self.assertEqual(config["reject_label"], "暂不处理")
            self.assertEqual(config["business_entity_type"], "InventoryOperation")

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
