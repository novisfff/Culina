from __future__ import annotations

from copy import deepcopy
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from fastapi.encoders import jsonable_encoder
from sqlalchemy import func, select

from ._support import AIAgentInfraTestCase

from app.core.enums import ActivityAction, Difficulty, MealType, MediaSource, UserRole
from app.models.domain import (
    ActivityLog,
    AIOperation,
    Food,
    FoodPlanItem,
    InventoryDeductionSuggestion,
    InventoryItem,
    MealLog,
    MealLogFood,
    MealLogRecordOperation,
    MediaAsset,
    Recipe,
    RecipeCookLog,
)
from app.repos.meal_log_record_operations import MealRecordIdempotencyError
from app.services.ai_operations.common import assert_updated_at_matches
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import DraftExecuteContext
from app.services.ai_operations.result_projection import (
    build_operation_result_card,
    operation_result_artifacts,
    project_ai_operation_result,
    upsert_message_operation_result,
)
from app.services.ai_revert.coordinator import AIRevertCoordinator
from app.services.ai_revert.errors import AIRevertError
from app.services.ai_revert.registry import build_ai_revert_adapter_registry


NOW = datetime(2026, 8, 24, 8, 0, tzinfo=UTC)


class AISimpleMealOperationTest(AIAgentInfraTestCase):
    def _payload(self) -> dict:
        return {
            "draftType": "meal_log",
            "schemaVersion": "meal_log.v1",
            "date": date(2026, 8, 24).isoformat(),
            "mealType": "lunch",
            "participantUserIds": [self.user.id],
            "foods": [
                {
                    "foodId": "food-tomato",
                    "name": "番茄小炒",
                    "foodType": "selfMade",
                    "servings": 1.5,
                    "note": "少糖",
                    "rating": 4.5,
                    "deductStock": False,
                }
            ],
            "notes": "和家人一起吃",
            "mood": "开心",
            "mediaIds": [],
            "planItemId": None,
            "planItemBaseUpdatedAt": None,
        }

    def _execute(self, db, *, payload: dict, key: str = "draft-simple-meal"):
        return draft_operation_registry.execute(
            DraftExecuteContext(
                db=db,
                draft_type="meal_log",
                family_id=self.family.id,
                user_id=self.user.id,
                payload=payload,
                assert_updated_at_matches=assert_updated_at_matches,
                operation_idempotency_key=key,
                conversation_id="conversation-simple-meal",
                committed_at=NOW,
                revertible_until=NOW + timedelta(hours=1),
            )
        )

    def _persist_ai_operation(self, db, *, payload: dict, receipt, suffix: str) -> AIOperation:
        _service, draft, _approval = self._create_ai_approval_for_test(
            db,
            draft_type="meal_log",
            payload=payload,
            suffix=f"simple-meal-{suffix}",
        )
        draft.status = "executed"
        operation = AIOperation(
            id=f"operation-simple-meal-{suffix}",
            family_id=self.family.id,
            draft_id=draft.id,
            actor_user_id=self.user.id,
            operation_type="meal_log.simple_create",
            status="succeeded",
            execution_mode="policy_auto",
            authorization_source="member_preference",
            authorization_snapshot_json={},
            committed_payload_json=payload,
            result_json={
                "business_entity": jsonable_encoder(receipt.business_entity),
                "entity_ids": list(receipt.entity_ids),
                "cache_scopes": list(receipt.cache_scopes),
            },
            business_entity_type="meal_log",
            business_entity_ids=list(receipt.entity_ids),
            idempotency_key=f"ai-operation-simple-meal:{suffix}",
            completed_at=NOW,
            revert_adapter_key=receipt.revert_adapter_key,
            revert_context_json=receipt.revert_context,
            revertible_until=NOW + timedelta(hours=1),
        )
        db.add(operation)
        db.flush()
        projection = project_ai_operation_result(
            draft=draft,
            operation=operation,
            entities=({"id": receipt.entity_ids[0], "label": "餐食记录", "operation": "create"},),
            cache_scopes=receipt.cache_scopes,
            server_now=NOW,
        )
        card = build_operation_result_card(projection, title="记录餐食", workspace_label="餐食记录")
        upsert_message_operation_result(
            db,
            message_id=draft.message_id,
            projection=projection,
            card=card,
            artifacts=operation_result_artifacts(projection, card=card),
        )
        db.flush()
        return operation

    def _revert(self, db, operation: AIOperation, *, suffix: str, now: datetime = NOW + timedelta(hours=1)):
        return AIRevertCoordinator.revert(
            db,
            family_id=self.family.id,
            actor_user_id=self.user.id,
            actor_role=UserRole.OWNER,
            operation_id=operation.id,
            client_request_id=f"revert-simple-meal-{suffix}",
            now=now,
        )

    def test_handler_records_domain_ledger_and_coordinator_reverts_at_exact_deadline(self) -> None:
        with self.SessionLocal() as db:
            before_counts = {
                model: int(db.scalar(select(func.count()).select_from(model)) or 0)
                for model in (Food, InventoryItem, FoodPlanItem, RecipeCookLog)
            }
            payload = self._payload()
            receipt = self._execute(db, payload=payload)

            self.assertEqual(receipt.revert_adapter_key, "meal_log.simple_create.v1")
            self.assertEqual(set(receipt.revert_context or {}), {"schema_version", "meal_log_record_operation_id"})
            ledger = db.get(MealLogRecordOperation, receipt.revert_context["meal_log_record_operation_id"])
            self.assertIsNotNone(ledger)
            assert ledger is not None
            self.assertEqual(ledger.client_request_id, "ai:draft-simple-meal")
            applied_at = ledger.applied_at.replace(tzinfo=UTC) if ledger.applied_at.tzinfo is None else ledger.applied_at
            deadline = ledger.revertible_until.replace(tzinfo=UTC) if ledger.revertible_until.tzinfo is None else ledger.revertible_until
            self.assertEqual(applied_at, NOW)
            self.assertEqual(deadline, NOW + timedelta(hours=1))
            meal = db.get(MealLog, receipt.entity_ids[0])
            assert meal is not None
            entry = db.scalar(select(MealLogFood).where(MealLogFood.meal_log_id == meal.id))
            assert entry is not None
            self.assertEqual(meal.participant_user_ids, [self.user.id])
            self.assertEqual(meal.notes, "和家人一起吃")
            self.assertEqual(meal.mood, "开心")
            self.assertEqual(entry.servings, Decimal("1.50"))
            self.assertEqual(entry.note, "少糖")
            self.assertEqual(entry.rating, Decimal("4.5"))
            self.assertEqual(
                {
                    model: int(db.scalar(select(func.count()).select_from(model)) or 0)
                    for model in before_counts
                },
                before_counts,
            )

            operation = self._persist_ai_operation(db, payload=payload, receipt=receipt, suffix="happy")
            response = self._revert(db, operation, suffix="happy")
            self.assertEqual(response.projection.result_status, "reverted")
            self.assertIsNone(db.get(MealLog, meal.id))
            self.assertEqual(db.get(MealLogRecordOperation, ledger.id).status.value, "reverted")
            self.assertEqual(
                int(
                    db.scalar(
                        select(func.count()).select_from(ActivityLog).where(
                            ActivityLog.action == ActivityAction.REVERT
                        )
                    )
                    or 0
                ),
                2,
            )

    def test_same_draft_replays_one_ledger_and_changed_payload_conflicts(self) -> None:
        with self.SessionLocal() as db:
            payload = self._payload()
            first = self._execute(db, payload=payload, key="replay-key")
            second = self._execute(db, payload=deepcopy(payload), key="replay-key")
            self.assertEqual(second.entity_ids, first.entity_ids)
            self.assertEqual(second.revert_context, first.revert_context)
            self.assertEqual(int(db.scalar(select(func.count()).select_from(MealLog)) or 0), 1)

    def test_replay_keeps_first_deadline_and_rating_uses_database_precision(self) -> None:
        with self.SessionLocal() as db:
            payload = self._payload()
            payload["foods"][0]["rating"] = 4.234
            first = self._execute(db, payload=payload, key="canonical-rating")
            ledger = db.get(MealLogRecordOperation, first.revert_context["meal_log_record_operation_id"])
            assert ledger is not None
            first_deadline = ledger.revertible_until

            replay_payload = deepcopy(payload)
            replay_payload["foods"][0]["rating"] = 4.2
            replay = draft_operation_registry.execute(
                DraftExecuteContext(
                    db=db,
                    draft_type="meal_log",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload=replay_payload,
                    assert_updated_at_matches=assert_updated_at_matches,
                    operation_idempotency_key="canonical-rating",
                    committed_at=NOW,
                    revertible_until=NOW + timedelta(hours=2),
                )
            )
            self.assertEqual(replay.entity_ids, first.entity_ids)
            self.assertEqual(ledger.revertible_until, first_deadline)
            entry = db.scalar(select(MealLogFood).where(MealLogFood.meal_log_id == first.entity_ids[0]))
            assert entry is not None
            self.assertEqual(entry.rating, Decimal("4.2"))

    def test_explicit_deadline_cannot_precede_commit_time(self) -> None:
        with self.SessionLocal() as db, self.assertRaisesRegex(
            ValueError, "revertible_until 不能早于 applied_at"
        ):
            draft_operation_registry.execute(
                DraftExecuteContext(
                    db=db,
                    draft_type="meal_log",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload=self._payload(),
                    assert_updated_at_matches=assert_updated_at_matches,
                    operation_idempotency_key="invalid-deadline",
                    committed_at=NOW,
                    revertible_until=NOW - timedelta(microseconds=1),
                )
            )
            self.assertEqual(int(db.scalar(select(func.count()).select_from(MealLogRecordOperation)) or 0), 1)

            changed = deepcopy(payload)
            changed["notes"] = "不同内容"
            with self.assertRaises(MealRecordIdempotencyError) as raised:
                self._execute(db, payload=changed, key="replay-key")
            self.assertEqual(raised.exception.code, "idempotency_key_reused")
            self.assertEqual(int(db.scalar(select(func.count()).select_from(MealLog)) or 0), 1)

    def test_complex_create_keeps_original_handler_without_revert_adapter(self) -> None:
        with self.SessionLocal() as db:
            payload = self._payload()
            payload["participantUserIds"] = []
            receipt = self._execute(db, payload=payload, key="complex-shape")
            self.assertIsNone(receipt.revert_adapter_key)
            self.assertIsNone(receipt.revert_context)
            self.assertEqual(int(db.scalar(select(func.count()).select_from(MealLogRecordOperation)) or 0), 0)

        with self.SessionLocal() as db:
            mismatched = self._payload()
            mismatched["foods"][0]["name"] = "不是数据库里的名字"
            receipt = self._execute(db, payload=mismatched, key="mismatched-food-shape")
            self.assertIsNone(receipt.revert_adapter_key)
            self.assertEqual(int(db.scalar(select(func.count()).select_from(MealLogRecordOperation)) or 0), 0)

    def test_modified_parent_maps_to_target_changed_without_partial_revert(self) -> None:
        with self.SessionLocal() as db:
            payload = self._payload()
            receipt = self._execute(db, payload=payload, key="changed-parent")
            operation = self._persist_ai_operation(db, payload=payload, receipt=receipt, suffix="changed-parent")
            meal = db.get(MealLog, receipt.entity_ids[0])
            assert meal is not None
            meal.notes = "后来修改"
            meal.row_version += 1
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="changed-parent", now=NOW + timedelta(minutes=5))
            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertEqual(db.get(MealLog, meal.id).notes, "后来修改")
            self.assertEqual(
                db.get(MealLogRecordOperation, receipt.revert_context["meal_log_record_operation_id"]).status.value,
                "applied",
            )

    def test_modified_entry_maps_to_target_changed_without_partial_revert(self) -> None:
        with self.SessionLocal() as db:
            payload = self._payload()
            receipt = self._execute(db, payload=payload, key="changed-entry")
            operation = self._persist_ai_operation(db, payload=payload, receipt=receipt, suffix="changed-entry")
            entry = db.scalar(select(MealLogFood).where(MealLogFood.meal_log_id == receipt.entity_ids[0]))
            assert entry is not None
            entry.note = "后来修改"
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="changed-entry", now=NOW + timedelta(minutes=5))
            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertIsNotNone(db.get(MealLogFood, entry.id))
            self.assertEqual(db.get(MealLogFood, entry.id).note, "后来修改")
            self.assertEqual(db.get(MealLogRecordOperation, receipt.revert_context["meal_log_record_operation_id"]).status.value, "applied")

    def test_downstream_media_maps_to_dependency_exists_without_unbinding(self) -> None:
        with self.SessionLocal() as db:
            payload = self._payload()
            receipt = self._execute(db, payload=payload, key="media-dependency")
            operation = self._persist_ai_operation(db, payload=payload, receipt=receipt, suffix="media-dependency")
            media = MediaAsset(
                id="media-simple-meal-dependent",
                family_id=self.family.id,
                name="后来添加的照片",
                url="/media/simple-meal-dependent.png",
                file_path="family-ai/simple-meal-dependent.png",
                source=MediaSource.UPLOAD,
                alt="后来添加的照片",
                entity_type="meal_log",
                entity_id=receipt.entity_ids[0],
                created_by=self.user.id,
            )
            db.add(media)
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="media-dependency", now=NOW + timedelta(minutes=5))
            self.assertEqual(raised.exception.code, "revert_dependency_exists")
            self.assertIsNotNone(db.get(MealLog, receipt.entity_ids[0]))
            self.assertEqual(db.get(MediaAsset, media.id).entity_id, receipt.entity_ids[0])

    def test_plan_inventory_and_cook_dependencies_fail_closed(self) -> None:
        dependency_builders = {
            "plan": lambda db, meal_id: db.add(
                FoodPlanItem(
                    id="plan-simple-meal-dependent",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id="food-tomato",
                    plan_date=date(2026, 8, 24),
                    meal_type=MealType.LUNCH,
                    note="",
                    status="cooked",
                    completed_at=NOW,
                    meal_log_id=meal_id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
            ),
            "inventory": lambda db, meal_id: db.add(
                InventoryDeductionSuggestion(
                    id="suggestion-simple-meal-dependent",
                    meal_log_id=meal_id,
                    ingredient_name="番茄",
                    suggested_amount=Decimal("1"),
                    unit="个",
                    based_on_food_name="番茄小炒",
                )
            ),
            "cook": self._add_cook_dependency,
        }
        for label, build_dependency in dependency_builders.items():
            with self.subTest(label=label), self.SessionLocal() as db:
                payload = self._payload()
                receipt = self._execute(db, payload=payload, key=f"{label}-dependency")
                operation = self._persist_ai_operation(
                    db,
                    payload=payload,
                    receipt=receipt,
                    suffix=f"{label}-dependency",
                )
                build_dependency(db, receipt.entity_ids[0])
                db.flush()

                with self.assertRaises(AIRevertError) as raised:
                    self._revert(
                        db,
                        operation,
                        suffix=f"{label}-dependency",
                        now=NOW + timedelta(minutes=5),
                    )
                self.assertEqual(raised.exception.code, "revert_dependency_exists")
                self.assertIsNotNone(db.get(MealLog, receipt.entity_ids[0]))
                db.rollback()

    def _add_cook_dependency(self, db, meal_id: str) -> None:
        recipe = Recipe(
            id="recipe-simple-meal-dependent",
            family_id=self.family.id,
            title="后来关联的菜谱",
            servings=2,
            prep_minutes=10,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=[],
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add(recipe)
        db.flush()
        db.add(
            RecipeCookLog(
                id="cook-simple-meal-dependent",
                family_id=self.family.id,
                recipe_id=recipe.id,
                meal_log_id=meal_id,
                cook_date=date(2026, 8, 24),
                meal_type=MealType.LUNCH,
                servings=Decimal("1"),
                result_note="",
                adjustments="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
        )

    def test_cross_family_ledger_reference_fails_closed(self) -> None:
        with self.SessionLocal() as db:
            payload = self._payload()
            receipt = self._execute(db, payload=payload, key="cross-family-ledger")
            operation = self._persist_ai_operation(db, payload=payload, receipt=receipt, suffix="cross-family-ledger")
            ledger = db.get(MealLogRecordOperation, receipt.revert_context["meal_log_record_operation_id"])
            assert ledger is not None
            ledger.family_id = self.other_family.id
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="cross-family-ledger", now=NOW + timedelta(minutes=5))
            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertIsNotNone(db.get(MealLog, receipt.entity_ids[0]))

    def test_production_registry_adds_only_simple_meal_adapter(self) -> None:
        self.assertEqual(
            build_ai_revert_adapter_registry().keys,
            frozenset(
                {
                    "food.favorite.v1",
                    "meal_log.rating.v1",
                    "shopping_list.safe_write.v1",
                    "meal_plan.simple_create.v1",
                    "meal_log.simple_create.v1",
                }
            ),
        )
