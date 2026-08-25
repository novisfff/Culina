from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import select

from app.ai.tools.draft_validation import normalize_inventory_operation_draft
from app.core.enums import (
    IngredientExpiryMode,
    IngredientQuantityTrackingMode,
    InventoryOperationEntityType,
    InventoryOperationType,
    UserRole,
)
from app.models.domain import Ingredient, InventoryItem, InventoryOperation
from app.services.ai_operations.common import assert_updated_at_matches
from app.services.ai_operations.inventory_intake import normalize_inventory_intake_draft
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftNormalizeContext,
)
from app.services.ai_revert.registry import build_ai_revert_adapter_registry
from app.services.ai_revert.adapters.inventory_operation_ref import InventoryOperationRefAdapter
from app.services.ai_revert.errors import AIRevertDependencyExists, AIRevertTargetChanged
from app.services.ai_revert.types import AIRevertContext
from app.services.inventory_operations import consume_ingredient_inventory
from app.services.clock import today_for_family

from ._support import AIAgentInfraTestCase


COMMITTED_AT = datetime(2026, 8, 24, 9, 0, tzinfo=UTC)


class AIInventoryOperationRevertTest(AIAgentInfraTestCase):
    def _execute(self, db, *, draft_type: str, payload: dict, suffix: str):
        return draft_operation_registry.execute(
            DraftExecuteContext(
                db=db,
                draft_type=draft_type,
                family_id=self.family.id,
                user_id=self.user.id,
                payload=payload,
                assert_updated_at_matches=assert_updated_at_matches,
                operation_idempotency_key=f"task-13:{suffix}",
                conversation_id=f"conversation-task-13-{suffix}",
                committed_at=COMMITTED_AT,
                revertible_until=COMMITTED_AT + timedelta(hours=1),
            )
        )

    def _normalize_direct_intake(self, db, *, source_type: str, suffix: str) -> dict:
        return normalize_inventory_intake_draft(
            DraftNormalizeContext(
                db=db,
                draft_type="inventory_intake",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id=f"conversation-task-13-{suffix}",
                payload={
                    "draftType": "inventory_intake",
                    "schemaVersion": "inventory_intake.v1",
                    "sourceType": source_type,
                    "sourceReference": {"kind": "test", "id": suffix},
                    "intakeDate": date(2026, 8, 24).isoformat(),
                    "intakeDateSource": "user_explicit",
                    "clientRequestId": f"task-13-intake:{suffix}",
                    "ignoredItems": [],
                    "items": [
                        {
                            "lineId": f"line-{suffix}",
                            "sourceLineId": f"source-{suffix}",
                            "sourceText": "番茄 2 个",
                            "sourceKind": "direct",
                            "action": "stock_only",
                            "targetKind": "exact_ingredient",
                            "targetId": "ingredient-tomato",
                            "enteredQuantity": "2",
                            "enteredUnit": "个",
                            "inventoryStatus": "fresh",
                            "storageLocation": "冷藏",
                            "notes": "",
                        }
                    ],
                },
            )
        )

    def _normalize_quantity(self, db, *, action: str) -> dict:
        item = db.get(InventoryItem, "inventory-tomato")
        assert item is not None
        raw = {
            "action": action,
            "ingredientId": "ingredient-tomato",
            "quantity": 1,
            "unit": "个",
        }
        if action == "dispose":
            raw.update({"inventoryItemId": item.id, "reason": "变质"})
        return normalize_inventory_operation_draft(
            db,
            family_id=self.family.id,
            payload={"operations": [raw]},
        )

    def _assert_one_hour_ledger(self, db, *, receipt, expected_type: InventoryOperationType) -> InventoryOperation:
        self.assertEqual(receipt.revert_adapter_key, "inventory.operation_ref.v1")
        self.assertEqual(set(receipt.revert_context or {}), {"schema_version", "inventory_operation_id"})
        operation_id = str((receipt.revert_context or {})["inventory_operation_id"])
        operation = db.scalar(
            select(InventoryOperation).where(InventoryOperation.id == operation_id)
        )
        assert operation is not None
        self.assertEqual(operation.operation_type, expected_type)
        self.assertEqual(operation.actor_id, self.user.id)
        self.assertEqual(operation.applied_at.replace(tzinfo=UTC), COMMITTED_AT)
        self.assertEqual(
            operation.revertible_until.replace(tzinfo=UTC),
            COMMITTED_AT + timedelta(hours=1),
        )
        self.assertTrue(operation.lines)
        self.assertEqual(
            [line.sequence for line in operation.lines],
            list(range(1, len(operation.lines) + 1)),
        )
        return operation

    def test_confirmed_ai_direct_intake_uses_one_hour_snapshot_ledger(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_direct_intake(db, source_type="gift", suffix="intake")
            receipt = self._execute(db, draft_type="inventory_intake", payload=payload, suffix="intake")
            self._assert_one_hour_ledger(
                db,
                receipt=receipt,
                expected_type=InventoryOperationType.SHOPPING_INTAKE,
            )

    def test_confirmed_ai_reconciliation_intake_uses_reconciliation_ledger(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_direct_intake(
                db,
                source_type="reconciliation",
                suffix="reconciliation",
            )
            receipt = self._execute(
                db,
                draft_type="inventory_intake",
                payload=payload,
                suffix="reconciliation",
            )
            ledger = self._assert_one_hour_ledger(
                db,
                receipt=receipt,
                expected_type=InventoryOperationType.RECONCILIATION,
            )
            self.assertEqual(ledger.summary_json["title"], "完成了一次库存盘点")

    def test_confirmed_ai_presence_only_intake_snapshots_presence_state(self) -> None:
        with self.SessionLocal() as db:
            ingredient = Ingredient(
                id="ingredient-task-13-salt",
                family_id=self.family.id,
                name="盐",
                category="调味",
                default_unit="袋",
                unit_conversions=[],
                default_storage="常温",
                default_expiry_mode=IngredientExpiryMode.NONE,
                quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                notes="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(ingredient)
            db.flush()
            payload = normalize_inventory_intake_draft(
                DraftNormalizeContext(
                    db=db,
                    draft_type="inventory_intake",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-task-13-presence",
                    payload={
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "initial_inventory",
                        "sourceReference": {"kind": "test", "id": "presence"},
                        "intakeDate": "2026-08-24",
                        "intakeDateSource": "user_explicit",
                        "clientRequestId": "task-13-intake:presence",
                        "ignoredItems": [],
                        "items": [
                            {
                                "lineId": "line-presence",
                                "sourceLineId": "source-presence",
                                "sourceText": "盐还有",
                                "sourceKind": "direct",
                                "action": "stock_only",
                                "targetKind": "presence_ingredient",
                                "targetId": ingredient.id,
                                "resultingAvailabilityLevel": "sufficient",
                                "inventoryStatus": "fresh",
                                "storageLocation": "常温",
                            }
                        ],
                    },
                )
            )
            receipt = self._execute(db, draft_type="inventory_intake", payload=payload, suffix="presence")
            ledger = self._assert_one_hour_ledger(
                db,
                receipt=receipt,
                expected_type=InventoryOperationType.SHOPPING_INTAKE,
            )
            state_lines = [
                line
                for line in ledger.lines
                if line.entity_type == InventoryOperationEntityType.NON_TRACKED_INGREDIENT_STATE
            ]
            self.assertEqual(len(state_lines), 1)
            self.assertIsNone(state_lines[0].before_snapshot)
            self.assertEqual(state_lines[0].after_snapshot["availability_level"], "sufficient")

    def test_confirmed_ai_consume_uses_one_hour_snapshot_ledger(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_quantity(db, action="consume")
            receipt = self._execute(db, draft_type="inventory_operation", payload=payload, suffix="consume")
            operation = self._assert_one_hour_ledger(
                db,
                receipt=receipt,
                expected_type=InventoryOperationType.CONSUME,
            )
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            self.assertEqual(item.consumed_quantity, Decimal("1"))
            self.assertEqual(
                {line.entity_id for line in operation.lines},
                {"ingredient-tomato", "inventory-tomato"},
            )

    def test_confirmed_ai_consume_same_key_replays_before_stale_boundary_validation(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_quantity(db, action="consume")
            first = self._execute(db, draft_type="inventory_operation", payload=payload, suffix="consume-replay")
            replay = self._execute(db, draft_type="inventory_operation", payload=payload, suffix="consume-replay")
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            self.assertEqual(item.consumed_quantity, Decimal("1"))
            self.assertEqual(first.revert_context, replay.revert_context)
            self.assertEqual(first.business_entity, replay.business_entity)

    def test_confirmed_ai_dispose_uses_one_hour_snapshot_ledger(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_quantity(db, action="dispose")
            receipt = self._execute(db, draft_type="inventory_operation", payload=payload, suffix="dispose")
            self._assert_one_hour_ledger(
                db,
                receipt=receipt,
                expected_type=InventoryOperationType.DISPOSE,
            )
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            self.assertEqual(item.disposed_quantity, Decimal("1"))

    def test_production_registry_registers_inventory_operation_reference_adapter(self) -> None:
        self.assertIn("inventory.operation_ref.v1", build_ai_revert_adapter_registry().keys)

    def test_shopping_linked_intake_remains_manual_without_inventory_only_adapter(self) -> None:
        with self.SessionLocal() as db:
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            from app.models.domain import ShoppingListItem

            shopping = ShoppingListItem(
                id="shopping-task-13",
                family_id=self.family.id,
                ingredient_id=ingredient.id,
                title="番茄",
                quantity=Decimal("2"),
                unit="个",
                reason="补货",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(shopping)
            db.flush()
            payload = normalize_inventory_intake_draft(
                DraftNormalizeContext(
                    db=db,
                    draft_type="inventory_intake",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-task-13-shopping",
                    payload={
                        "draftType": "inventory_intake",
                        "schemaVersion": "inventory_intake.v1",
                        "sourceType": "receipt_text",
                        "sourceReference": {"kind": "test", "id": "shopping"},
                        "intakeDate": "2026-08-24",
                        "intakeDateSource": "receipt",
                        "clientRequestId": "task-13-intake:shopping",
                        "ignoredItems": [],
                        "items": [
                            {
                                "lineId": "line-shopping",
                                "sourceLineId": "source-shopping",
                                "sourceText": "番茄 2 个",
                                "sourceKind": "shopping_item",
                                "action": "stock_and_fulfill",
                                "shoppingItemId": shopping.id,
                                "targetKind": "exact_ingredient",
                                "targetId": ingredient.id,
                                "enteredQuantity": "2",
                                "enteredUnit": "个",
                                "inventoryStatus": "fresh",
                                "storageLocation": "冷藏",
                            }
                        ],
                    },
                )
            )
            receipt = self._execute(db, draft_type="inventory_intake", payload=payload, suffix="shopping")
            self.assertIsNone(receipt.revert_adapter_key)
            self.assertIsNone(receipt.revert_context)

    def _adapter_context(self, db, *, receipt, actor_user_id: str, actor_role: UserRole, now: datetime, family_id: str | None = None):
        operation = SimpleNamespace(
            revert_context_json=receipt.revert_context,
            business_entity_ids=list(receipt.entity_ids),
        )
        return AIRevertContext(
            db=db,
            operation=operation,
            family_id=family_id or self.family.id,
            actor_user_id=actor_user_id,
            actor_role=actor_role,
            now=now,
        )

    def test_reference_adapter_allows_original_actor_at_exact_one_hour_boundary(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_quantity(db, action="consume")
            receipt = self._execute(db, draft_type="inventory_operation", payload=payload, suffix="boundary")
            result = InventoryOperationRefAdapter().revert(
                self._adapter_context(
                    db,
                    receipt=receipt,
                    actor_user_id=self.user.id,
                    actor_role=UserRole.OWNER,
                    now=COMMITTED_AT + timedelta(hours=1),
                )
            )
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            self.assertEqual(item.consumed_quantity, Decimal("0"))
            self.assertEqual(result.cache_scopes, ("inventory", "ai_conversation"))
            self.assertEqual(result.entities[0]["id"], item.id)

    def test_reference_adapter_allows_current_owner_for_original_member(self) -> None:
        member, _membership = self.create_family_member(user_id="user-task-13-member")
        with self.SessionLocal() as db:
            payload = self._normalize_quantity(db, action="dispose")
            receipt = draft_operation_registry.execute(
                DraftExecuteContext(
                    db=db,
                    draft_type="inventory_operation",
                    family_id=self.family.id,
                    user_id=member.id,
                    payload=payload,
                    assert_updated_at_matches=assert_updated_at_matches,
                    operation_idempotency_key="task-13:member-dispose",
                    conversation_id="conversation-task-13-member-dispose",
                    committed_at=COMMITTED_AT,
                    revertible_until=COMMITTED_AT + timedelta(hours=1),
                )
            )
            InventoryOperationRefAdapter().revert(
                self._adapter_context(
                    db,
                    receipt=receipt,
                    actor_user_id=self.user.id,
                    actor_role=UserRole.OWNER,
                    now=COMMITTED_AT + timedelta(minutes=30),
                )
            )
            ledger_id = str((receipt.revert_context or {})["inventory_operation_id"])
            ledger = db.get(InventoryOperation, ledger_id)
            assert ledger is not None
            self.assertEqual(ledger.actor_id, member.id)

    def test_reference_adapter_translates_stale_and_cross_family_to_target_changed(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_quantity(db, action="dispose")
            receipt = self._execute(db, draft_type="inventory_operation", payload=payload, suffix="stale")
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            item.notes = "之后修改"
            db.flush()
            with self.assertRaises(AIRevertTargetChanged):
                InventoryOperationRefAdapter().revert(
                    self._adapter_context(
                        db,
                        receipt=receipt,
                        actor_user_id=self.user.id,
                        actor_role=UserRole.OWNER,
                        now=COMMITTED_AT + timedelta(minutes=10),
                    )
                )
            with self.assertRaises(AIRevertTargetChanged):
                InventoryOperationRefAdapter().revert(
                    self._adapter_context(
                        db,
                        receipt=receipt,
                        actor_user_id=self.user.id,
                        actor_role=UserRole.OWNER,
                        now=COMMITTED_AT + timedelta(minutes=10),
                        family_id=self.other_family.id,
                    )
                )

    def test_reference_adapter_translates_later_consumption_to_dependency(self) -> None:
        with self.SessionLocal() as db:
            payload = self._normalize_quantity(db, action="consume")
            receipt = self._execute(db, draft_type="inventory_operation", payload=payload, suffix="dependency")
            ingredient = db.get(Ingredient, "ingredient-tomato")
            assert ingredient is not None
            consume_ingredient_inventory(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                ingredient=ingredient,
                quantity=Decimal("1"),
                unit="个",
                today=today_for_family(self.family.id),
            )
            db.flush()
            with self.assertRaises(AIRevertDependencyExists):
                InventoryOperationRefAdapter().revert(
                    self._adapter_context(
                        db,
                        receipt=receipt,
                        actor_user_id=self.user.id,
                        actor_role=UserRole.OWNER,
                        now=COMMITTED_AT + timedelta(minutes=10),
                    )
                )
