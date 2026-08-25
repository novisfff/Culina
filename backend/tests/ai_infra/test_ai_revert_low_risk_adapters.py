from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

from fastapi.encoders import jsonable_encoder
from sqlalchemy import event, select, update

from ._support import AIAgentInfraTestCase

from app.core.enums import (
    FamilyModelSearchProfileStatus,
    FoodType,
    InventoryOperationChangeType,
    InventoryOperationEntityType,
    InventoryOperationStatus,
    InventoryOperationType,
    MealType,
    UserRole,
)
from app.models.domain import (
    ActivityLog,
    AIOperation,
    AIMessage,
    AITaskDraft,
    Food,
    FoodPlanItem,
    Ingredient,
    InventoryOperation,
    InventoryOperationLine,
    MealLog,
    MealLogFood,
    SearchDocument,
    SearchIndexJob,
    ShoppingListItem,
)
from app.models.family_model_settings import (
    FamilySearchProfile,
    FamilySearchProfileDocument,
)
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
from app.services.search.jobs import (
    process_search_index_job,
    retry_failed_search_index_job,
)
from app.services.search.vector_store import VectorStoreUnavailableError


NOW = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)


class _InMemoryVectorStore:
    def __init__(self) -> None:
        self.points: dict[str, tuple[list[float], dict[str, object]]] = {}
        self.fail_delete_count = 0

    def upsert_point(
        self,
        *,
        point_id: str,
        vector: list[float],
        payload: dict[str, object],
    ) -> None:
        self.points[point_id] = (list(vector), dict(payload))

    def delete_point(self, *, point_id: str) -> None:
        if self.fail_delete_count:
            self.fail_delete_count -= 1
            raise VectorStoreUnavailableError("qdrant unavailable")
        self.points.pop(point_id, None)


class _ProfileVectorStoreRegistry:
    def __init__(self) -> None:
        self.stores: dict[str, _InMemoryVectorStore] = {}

    def store(self, collection: str) -> _InMemoryVectorStore:
        return self.stores.setdefault(collection, _InMemoryVectorStore())

    def build(self, _settings, *, qdrant_collection: str):
        return self.store(qdrant_collection)


class AIRevertLowRiskAdaptersTest(AIAgentInfraTestCase):
    def test_production_registry_contains_reviewed_low_risk_adapters(self) -> None:
        self.assertEqual(
            build_ai_revert_adapter_registry().keys,
            frozenset(
                {
                    "food.favorite.v1",
                    "inventory.operation_ref.v1",
                    "meal_log.rating.v1",
                    "shopping_list.safe_write.v1",
                    "meal_plan.simple_create.v1",
                    "meal_log.simple_create.v1",
                }
            ),
        )

    def _execute_receipt(
        self,
        db,
        *,
        draft_type: str,
        payload: dict,
        suffix: str,
        user_id: str | None = None,
    ):
        return draft_operation_registry.execute(
            DraftExecuteContext(
                db=db,
                draft_type=draft_type,
                family_id=self.family.id,
                user_id=user_id or self.user.id,
                payload=payload,
                assert_updated_at_matches=assert_updated_at_matches,
                operation_idempotency_key=f"task-11:{suffix}",
                conversation_id=f"conversation-task-11-{suffix}",
                committed_at=NOW,
                revertible_until=NOW + timedelta(hours=1),
            )
        )

    def _persist_receipt_operation(
        self,
        db,
        *,
        draft_type: str,
        payload: dict,
        receipt,
        suffix: str,
        actor_user_id: str | None = None,
    ) -> AIOperation:
        _service, draft, _approval = self._create_ai_approval_for_test(
            db,
            draft_type=draft_type,
            payload=payload,
            suffix=f"task-11-{suffix}",
        )
        draft.status = "executed"
        operation = AIOperation(
            id=f"operation-task-11-{suffix}",
            family_id=self.family.id,
            draft_id=draft.id,
            actor_user_id=actor_user_id or self.user.id,
            operation_type=f"{draft_type}.task_11",
            status="completed",
            execution_mode="policy_auto",
            authorization_source="member_preference",
            authorization_snapshot_json={},
            committed_payload_json=payload,
            result_json={
                "business_entity": jsonable_encoder(receipt.business_entity),
                "entity_ids": list(receipt.entity_ids),
                "cache_scopes": list(receipt.cache_scopes),
            },
            business_entity_type=draft_type,
            business_entity_ids=list(receipt.entity_ids),
            idempotency_key=f"task-11-operation:{suffix}",
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
            entities=tuple(
                {"id": entity_id, "label": entity_id, "operation": "update"}
                for entity_id in receipt.entity_ids
            ),
            cache_scopes=receipt.cache_scopes,
            server_now=NOW,
        )
        card = build_operation_result_card(
            projection,
            title="Task 11 operation",
            workspace_label="Task 11",
        )
        upsert_message_operation_result(
            db,
            message_id=draft.message_id,
            projection=projection,
            card=card,
            artifacts=operation_result_artifacts(projection, card=card),
        )
        db.flush()
        return operation

    def _revert(self, db, operation: AIOperation, *, suffix: str, actor_user_id: str | None = None):
        return AIRevertCoordinator.revert(
            db,
            family_id=self.family.id,
            actor_user_id=actor_user_id or self.user.id,
            actor_role=UserRole.OWNER,
            operation_id=operation.id,
            client_request_id=f"revert-task-11-{suffix}",
            now=NOW + timedelta(minutes=1),
        )

    def _seed_rating_target(self, db) -> tuple[MealLog, tuple[MealLogFood, MealLogFood]]:
        second_food = Food(
            id="food-task-11-rating-second",
            family_id=self.family.id,
            name="Task 11 清汤",
            type=FoodType.SELF_MADE,
            category="家常菜",
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        meal_log = MealLog(
            id="meal-task-11-rating",
            family_id=self.family.id,
            date=date(2026, 8, 24),
            meal_type=MealType.DINNER,
            participant_user_ids=[self.user.id],
            notes="",
            mood="",
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        entries = (
            MealLogFood(
                id="meal-food-task-11-b",
                meal_log_id=meal_log.id,
                food_id=second_food.id,
                servings=Decimal("1"),
                rating=Decimal("2.5"),
            ),
            MealLogFood(
                id="meal-food-task-11-a",
                meal_log_id=meal_log.id,
                food_id="food-tomato",
                servings=Decimal("1"),
                rating=None,
            ),
        )
        db.add_all((second_food, meal_log, *entries))
        db.flush()
        return meal_log, entries

    def _simple_plan_payload(self, *, reason: str) -> dict:
        return {
            "draftType": "meal_plan",
            "schemaVersion": "meal_plan.v1",
            "source": {},
            "items": [
                {
                    "date": "2026-08-28",
                    "mealType": "dinner",
                    "title": "番茄小炒",
                    "foodId": "food-tomato",
                    "recipeId": None,
                    "reason": reason,
                    "usedInventory": [],
                    "missingIngredients": [],
                    "missingIngredientItems": [],
                    "source": {},
                }
            ],
        }

    def _seed_plan_vector_state(
        self,
        db,
        *,
        plan_id: str,
        suffix: str,
        registry: _ProfileVectorStoreRegistry,
    ) -> tuple[str, str, str, str]:
        profile_id = f"profile-task-11-{suffix}"
        other_profile_id = f"profile-task-11-{suffix}-other"
        collection = f"culina_fsp_task_11_{suffix}"
        other_collection = f"culina_fsp_task_11_{suffix}_other"
        document_id = f"search-doc-task-11-{suffix}"
        other_document_id = f"search-doc-task-11-{suffix}-other"
        profile_document_id = f"profile-doc-task-11-{suffix}"
        other_profile_document_id = f"profile-doc-task-11-{suffix}-other"
        db.add_all(
            (
                FamilySearchProfile(
                    id=profile_id,
                    family_id=self.family.id,
                    provider_profile_id=f"provider-{suffix}",
                    provider_profile_version_id=f"provider-version-{suffix}",
                    adapter_kind="openai_compatible_http",
                    embedding_model="embedding-test",
                    dimensions=2,
                    distance="Cosine",
                    document_builder_version="test",
                    index_identity_checksum=f"identity-{suffix}",
                    qdrant_collection=collection,
                    status=FamilyModelSearchProfileStatus.ACTIVE,
                ),
                FamilySearchProfile(
                    id=other_profile_id,
                    family_id=self.other_family.id,
                    provider_profile_id=f"provider-{suffix}-other",
                    provider_profile_version_id=f"provider-version-{suffix}-other",
                    adapter_kind="openai_compatible_http",
                    embedding_model="embedding-test",
                    dimensions=2,
                    distance="Cosine",
                    document_builder_version="test",
                    index_identity_checksum=f"identity-{suffix}-other",
                    qdrant_collection=other_collection,
                    status=FamilyModelSearchProfileStatus.ACTIVE,
                ),
                SearchDocument(
                    id=document_id,
                    family_id=self.family.id,
                    entity_type="meal_plan",
                    entity_id=plan_id,
                    content_hash="a" * 64,
                    document_builder_version="test",
                ),
                SearchDocument(
                    id=other_document_id,
                    family_id=self.other_family.id,
                    entity_type="meal_plan",
                    entity_id=plan_id,
                    content_hash="b" * 64,
                    document_builder_version="test",
                ),
                FamilySearchProfileDocument(
                    id=profile_document_id,
                    family_id=self.family.id,
                    search_profile_id=profile_id,
                    search_document_id=document_id,
                    content_hash="a" * 64,
                    status="indexed",
                ),
                FamilySearchProfileDocument(
                    id=other_profile_document_id,
                    family_id=self.other_family.id,
                    search_profile_id=other_profile_id,
                    search_document_id=other_document_id,
                    content_hash="b" * 64,
                    status="indexed",
                ),
            )
        )
        point_id = f"meal_plan:{plan_id}"
        registry.store(collection).upsert_point(
            point_id=point_id,
            vector=[0.1, 0.2],
            payload={
                "family_id": self.family.id,
                "search_profile_id": profile_id,
                "entity_type": "meal_plan",
                "entity_id": plan_id,
            },
        )
        registry.store(other_collection).upsert_point(
            point_id=point_id,
            vector=[0.3, 0.4],
            payload={
                "family_id": self.other_family.id,
                "search_profile_id": other_profile_id,
                "entity_type": "meal_plan",
                "entity_id": plan_id,
            },
        )
        db.flush()
        return profile_document_id, other_profile_document_id, collection, other_collection

    def _exercise_permission_fixture(
        self,
        *,
        fixture_name: str,
        suffix: str,
        member_id: str,
        revert_actor_id: str,
    ) -> None:
        with self.SessionLocal() as db:
            if fixture_name == "rating":
                meal_log, entries = self._seed_rating_target(db)
                meal_log.created_by = member_id
                meal_log.updated_by = member_id
                meal_log.participant_user_ids = [member_id]
                db.flush()
                draft_type = "meal_log"
                payload = {
                    "draftType": "meal_log",
                    "schemaVersion": "meal_log_operation.v1",
                    "action": "rate_food",
                    "targetId": meal_log.id,
                    "baseUpdatedAt": meal_log.updated_at.isoformat(),
                    "before": {},
                    "payload": {
                        "foodEntryRatings": [{"id": entries[0].id, "rating": 4.0}]
                    },
                }
                target_id = entries[0].id
            elif fixture_name == "shopping_add":
                draft_type = "shopping_list"
                payload = {
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list.v1",
                    "sourceDraftId": None,
                    "items": [
                        {
                            "title": "番茄",
                            "quantity": 2,
                            "unit": "个",
                            "ingredient_id": "ingredient-tomato",
                            "food_id": None,
                            "quantity_mode": "track_quantity",
                            "display_label": None,
                            "reason": "permission matrix",
                        }
                    ],
                }
                target_id = ""
            elif fixture_name in {"shopping_update", "shopping_restore"}:
                item = ShoppingListItem(
                    id=f"shopping-task-11-permission-{suffix}",
                    family_id=self.family.id,
                    ingredient_id="ingredient-tomato",
                    title="番茄",
                    quantity=Decimal("1"),
                    unit="个",
                    reason="before" if fixture_name == "shopping_update" else "",
                    done=fixture_name == "shopping_restore",
                    created_by=member_id,
                    updated_by=member_id,
                )
                db.add(item)
                db.flush()
                draft_type = "shopping_list"
                operation = {
                    "operationId": f"permission-{suffix}",
                    "action": "update" if fixture_name == "shopping_update" else "set_done",
                    "targetId": item.id,
                    "baseUpdatedAt": item.updated_at.isoformat(),
                    "before": {},
                    "payload": (
                        {
                            "title": item.title,
                            "quantity": 3,
                            "unit": "斤",
                            "ingredient_id": item.ingredient_id,
                            "food_id": None,
                            "quantity_mode": "track_quantity",
                            "display_label": None,
                            "reason": "after",
                        }
                        if fixture_name == "shopping_update"
                        else {"done": False, "reason": ""}
                    ),
                }
                payload = {
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list_operation.v1",
                    "sourceDraftId": None,
                    "operations": [operation],
                }
                target_id = item.id
            else:
                assert fixture_name == "simple_plan"
                draft_type = "meal_plan"
                payload = {
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "source": {},
                    "items": [
                        {
                            "date": "2026-09-01",
                            "mealType": "dinner",
                            "title": "番茄小炒",
                            "foodId": "food-tomato",
                            "recipeId": None,
                            "reason": "permission matrix",
                            "usedInventory": [],
                            "missingIngredients": [],
                            "missingIngredientItems": [],
                            "source": {},
                        }
                    ],
                }
                target_id = ""

            receipt = self._execute_receipt(
                db,
                draft_type=draft_type,
                payload=payload,
                suffix=suffix,
                user_id=member_id,
            )
            if not target_id:
                target_id = receipt.entity_ids[0]
            operation = self._persist_receipt_operation(
                db,
                draft_type=draft_type,
                payload=payload,
                receipt=receipt,
                suffix=suffix,
                actor_user_id=member_id,
            )
            response = self._revert(
                db,
                operation,
                suffix=suffix,
                actor_user_id=revert_actor_id,
            )
            self.assertEqual(response.projection.result_status, "reverted")

            if fixture_name == "rating":
                restored = db.get(MealLogFood, target_id)
                assert restored is not None
                self.assertEqual(restored.rating, Decimal("2.5"))
            elif fixture_name in {"shopping_add", "simple_plan"}:
                model = ShoppingListItem if fixture_name == "shopping_add" else FoodPlanItem
                self.assertIsNone(db.get(model, target_id))
            elif fixture_name == "shopping_update":
                restored = db.get(ShoppingListItem, target_id)
                assert restored is not None
                self.assertEqual(restored.quantity, Decimal("1"))
                self.assertEqual(restored.unit, "个")
                self.assertEqual(restored.reason, "before")
            else:
                restored = db.get(ShoppingListItem, target_id)
                assert restored is not None
                self.assertTrue(restored.done)

    def test_favorite_handler_receipt_reverts_through_coordinator(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            before_version = food.row_version
            payload = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": food.id,
                "baseUpdatedAt": food.updated_at.isoformat(),
                "before": {"favorite": False},
                "payload": {"favorite": True},
            }

            receipt = self._execute_receipt(db, draft_type="food_profile", payload=payload, suffix="favorite")

            self.assertEqual(receipt.revert_adapter_key, "food.favorite.v1")
            self.assertEqual(
                receipt.revert_context,
                {
                    "schema_version": 1,
                    "food_id": food.id,
                    "before_favorite": False,
                    "after_favorite": True,
                    "after_row_version": before_version + 1,
                },
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="food_profile",
                payload=payload,
                receipt=receipt,
                suffix="favorite",
            )
            response = self._revert(db, operation, suffix="favorite")
            db.flush()

            restored = db.get(Food, food.id)
            assert restored is not None
            self.assertEqual(response.projection.result_status, "reverted")
            self.assertFalse(restored.favorite)
            self.assertEqual(restored.row_version, before_version + 2)

    def test_rating_handler_receipt_reverts_none_and_value_as_one_collection_change(self) -> None:
        with self.SessionLocal() as db:
            meal_log, entries = self._seed_rating_target(db)
            before_version = meal_log.row_version
            payload = {
                "draftType": "meal_log",
                "schemaVersion": "meal_log_operation.v1",
                "action": "rate_food",
                "targetId": meal_log.id,
                "baseUpdatedAt": meal_log.updated_at.isoformat(),
                "before": {},
                "payload": {
                    "foodEntryRatings": [
                        {"id": entries[0].id, "rating": 4.5},
                        {"id": entries[1].id, "rating": 3.0},
                    ]
                },
            }

            receipt = self._execute_receipt(db, draft_type="meal_log", payload=payload, suffix="rating")

            self.assertEqual(receipt.revert_adapter_key, "meal_log.rating.v1")
            self.assertEqual(
                receipt.revert_context,
                {
                    "schema_version": 1,
                    "meal_log_id": meal_log.id,
                    "after_meal_log_row_version": before_version + 1,
                    "entries": [
                        {
                            "meal_log_food_id": entries[1].id,
                            "before_rating": None,
                            "after_rating": 3.0,
                        },
                        {
                            "meal_log_food_id": entries[0].id,
                            "before_rating": 2.5,
                            "after_rating": 4.5,
                        },
                    ],
                },
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_log",
                payload=payload,
                receipt=receipt,
                suffix="rating",
            )
            response = self._revert(db, operation, suffix="rating")
            db.flush()

            restored = db.get(MealLog, meal_log.id)
            restored_entries = {
                entry.id: entry
                for entry in db.scalars(select(MealLogFood).where(MealLogFood.meal_log_id == meal_log.id))
            }
            assert restored is not None
            self.assertEqual(response.projection.result_status, "reverted")
            self.assertIsNone(restored_entries[entries[1].id].rating)
            self.assertEqual(restored_entries[entries[0].id].rating, Decimal("2.5"))
            self.assertEqual(restored.row_version, before_version + 2)

    def test_rating_decimal_commit_reopens_and_reverts_without_false_conflict(self) -> None:
        with self.SessionLocal() as db:
            meal_log, entries = self._seed_rating_target(db)
            before_version = meal_log.row_version
            payload = {
                "draftType": "meal_log",
                "schemaVersion": "meal_log_operation.v1",
                "action": "rate_food",
                "targetId": meal_log.id,
                "baseUpdatedAt": meal_log.updated_at.isoformat(),
                "before": {},
                "payload": {
                    "foodEntryRatings": [{"id": entries[0].id, "rating": 4.234}]
                },
            }
            receipt = self._execute_receipt(
                db,
                draft_type="meal_log",
                payload=payload,
                suffix="rating-decimal-commit",
            )
            self.assertEqual(receipt.revert_context["entries"][0]["after_rating"], 4.2)
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_log",
                payload=payload,
                receipt=receipt,
                suffix="rating-decimal-commit",
            )
            operation_id = operation.id
            meal_log_id = meal_log.id
            entry_id = entries[0].id
            db.commit()

        with self.SessionLocal() as db:
            operation = db.get(AIOperation, operation_id)
            assert operation is not None
            response = self._revert(db, operation, suffix="rating-decimal-commit")
            self.assertEqual(response.projection.result_status, "reverted")
            db.commit()

        with self.SessionLocal() as db:
            restored = db.get(MealLogFood, entry_id)
            parent = db.get(MealLog, meal_log_id)
            assert restored is not None and parent is not None
            self.assertEqual(restored.rating, Decimal("2.5"))
            self.assertEqual(parent.row_version, before_version + 2)
            self.assertEqual(
                len(
                    list(
                        db.scalars(
                            select(ActivityLog).where(
                                ActivityLog.entity_type == "MealLog",
                                ActivityLog.entity_id == meal_log_id,
                            )
                        )
                    )
                ),
                2,
            )

    def test_shopping_add_handler_receipt_reverts_created_rows(self) -> None:
        with self.SessionLocal() as db:
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list.v1",
                "sourceDraftId": None,
                "items": [
                    {
                        "title": "番茄",
                        "quantity": 2,
                        "unit": "个",
                        "ingredient_id": "ingredient-tomato",
                        "food_id": None,
                        "quantity_mode": "track_quantity",
                        "display_label": None,
                        "reason": "Task 11",
                    }
                ],
            }

            receipt = self._execute_receipt(db, draft_type="shopping_list", payload=payload, suffix="shopping-add")

            self.assertEqual(receipt.revert_adapter_key, "shopping_list.safe_write.v1")
            self.assertEqual(
                receipt.revert_context,
                {
                    "schema_version": 1,
                    "mode": "add",
                    "items": [
                        {
                            "shopping_item_id": receipt.entity_ids[0],
                            "before": None,
                            "after": {
                                "quantity": 2.0,
                                "unit": "个",
                                "notes": "Task 11",
                                "done": False,
                            },
                            "after_row_version": 1,
                        }
                    ],
                },
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-add",
            )
            response = self._revert(db, operation, suffix="shopping-add")
            db.flush()

            self.assertEqual(response.projection.result_status, "reverted")
            self.assertIsNone(db.get(ShoppingListItem, receipt.entity_ids[0]))

    def test_shopping_update_handler_receipt_restores_only_safe_fields(self) -> None:
        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-task-11-update",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("1"),
                unit="个",
                reason="before",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list_operation.v1",
                "sourceDraftId": None,
                "operations": [
                    {
                        "operationId": "shopping-update",
                        "action": "update",
                        "targetId": item.id,
                        "baseUpdatedAt": item.updated_at.isoformat(),
                        "before": {},
                        "payload": {
                            "title": item.title,
                            "quantity": 3,
                            "unit": "斤",
                            "ingredient_id": item.ingredient_id,
                            "food_id": None,
                            "quantity_mode": "track_quantity",
                            "display_label": None,
                            "reason": "after",
                        },
                    }
                ],
            }

            receipt = self._execute_receipt(db, draft_type="shopping_list", payload=payload, suffix="shopping-update")

            self.assertEqual(receipt.revert_adapter_key, "shopping_list.safe_write.v1")
            self.assertEqual(
                receipt.revert_context,
                {
                    "schema_version": 1,
                    "mode": "update",
                    "items": [
                        {
                            "shopping_item_id": item.id,
                            "before": {"quantity": 1.0, "unit": "个", "notes": "before"},
                            "after": {"quantity": 3.0, "unit": "斤", "notes": "after"},
                            "after_row_version": 2,
                        }
                    ],
                },
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-update",
            )
            response = self._revert(db, operation, suffix="shopping-update")
            db.flush()

            restored = db.get(ShoppingListItem, item.id)
            assert restored is not None
            self.assertEqual(response.projection.result_status, "reverted")
            self.assertEqual(restored.quantity, Decimal("1"))
            self.assertEqual(restored.unit, "个")
            self.assertEqual(restored.reason, "before")

    def test_shopping_update_decimal_commit_reopens_and_reverts_exactly(self) -> None:
        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-task-11-update-decimal",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("1.11"),
                unit="个",
                reason="before",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list_operation.v1",
                "sourceDraftId": None,
                "operations": [
                    {
                        "operationId": "shopping-update-decimal",
                        "action": "update",
                        "targetId": item.id,
                        "baseUpdatedAt": item.updated_at.isoformat(),
                        "before": {},
                        "payload": {
                            "title": item.title,
                            "quantity": 1.234,
                            "unit": "斤",
                            "ingredient_id": item.ingredient_id,
                            "food_id": None,
                            "quantity_mode": "track_quantity",
                            "display_label": None,
                            "reason": "after",
                        },
                    }
                ],
            }
            receipt = self._execute_receipt(
                db,
                draft_type="shopping_list",
                payload=payload,
                suffix="shopping-update-decimal",
            )
            self.assertEqual(receipt.revert_context["items"][0]["after"]["quantity"], 1.23)
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-update-decimal",
            )
            operation_id = operation.id
            item_id = item.id
            db.commit()

        with self.SessionLocal() as db:
            operation = db.get(AIOperation, operation_id)
            assert operation is not None
            response = self._revert(db, operation, suffix="shopping-update-decimal")
            self.assertEqual(response.projection.result_status, "reverted")
            db.commit()

        with self.SessionLocal() as db:
            restored = db.get(ShoppingListItem, item_id)
            assert restored is not None
            self.assertEqual(restored.quantity, Decimal("1.11"))
            self.assertEqual(restored.unit, "个")
            self.assertEqual(restored.reason, "before")
            self.assertEqual(restored.row_version, 3)
            self.assertEqual(
                len(
                    list(
                        db.scalars(
                            select(ActivityLog).where(
                                ActivityLog.entity_type == "ShoppingListItem",
                                ActivityLog.entity_id == item_id,
                            )
                        )
                    )
                ),
                2,
            )

    def test_shopping_add_decimal_commit_reopens_and_reverts_created_row(self) -> None:
        with self.SessionLocal() as db:
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list.v1",
                "sourceDraftId": None,
                "items": [
                    {
                        "title": "番茄",
                        "quantity": 1.234,
                        "unit": "个",
                        "ingredient_id": "ingredient-tomato",
                        "food_id": None,
                        "quantity_mode": "track_quantity",
                        "display_label": None,
                        "reason": "decimal add",
                    }
                ],
            }
            receipt = self._execute_receipt(
                db,
                draft_type="shopping_list",
                payload=payload,
                suffix="shopping-add-decimal",
            )
            self.assertEqual(receipt.revert_context["items"][0]["after"]["quantity"], 1.23)
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-add-decimal",
            )
            operation_id = operation.id
            item_id = receipt.entity_ids[0]
            db.commit()

        with self.SessionLocal() as db:
            persisted = db.get(ShoppingListItem, item_id)
            operation = db.get(AIOperation, operation_id)
            assert persisted is not None and operation is not None
            self.assertEqual(persisted.quantity, Decimal("1.23"))
            response = self._revert(db, operation, suffix="shopping-add-decimal")
            self.assertEqual(response.projection.result_status, "reverted")
            db.commit()

        with self.SessionLocal() as db:
            self.assertIsNone(db.get(ShoppingListItem, item_id))
            self.assertEqual(
                len(
                    list(
                        db.scalars(
                            select(ActivityLog).where(
                                ActivityLog.entity_type == "ShoppingListItem",
                                ActivityLog.entity_id == item_id,
                            )
                        )
                    )
                ),
                2,
            )

    def test_shopping_restore_handler_receipt_marks_items_done_again(self) -> None:
        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-task-11-restore",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("1"),
                unit="个",
                reason="",
                done=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list_operation.v1",
                "sourceDraftId": None,
                "operations": [
                    {
                        "operationId": "shopping-restore",
                        "action": "set_done",
                        "targetId": item.id,
                        "baseUpdatedAt": item.updated_at.isoformat(),
                        "before": {},
                        "payload": {"done": False, "reason": ""},
                    }
                ],
            }

            receipt = self._execute_receipt(db, draft_type="shopping_list", payload=payload, suffix="shopping-restore")

            self.assertEqual(receipt.revert_adapter_key, "shopping_list.safe_write.v1")
            self.assertEqual(
                receipt.revert_context,
                {
                    "schema_version": 1,
                    "mode": "restore",
                    "items": [
                        {
                            "shopping_item_id": item.id,
                            "before": {"done": True},
                            "after": {"done": False},
                            "after_row_version": 2,
                        }
                    ],
                },
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-restore",
            )
            response = self._revert(db, operation, suffix="shopping-restore")
            db.flush()

            restored = db.get(ShoppingListItem, item.id)
            assert restored is not None
            self.assertEqual(response.projection.result_status, "reverted")
            self.assertTrue(restored.done)

    def test_simple_plan_handler_receipt_reverts_created_rows(self) -> None:
        with self.SessionLocal() as db:
            payload = {
                "draftType": "meal_plan",
                "schemaVersion": "meal_plan.v1",
                "source": {},
                "items": [
                    {
                        "date": "2026-08-25",
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "Task 11",
                        "usedInventory": [],
                        "missingIngredients": [],
                        "missingIngredientItems": [],
                        "source": {},
                    }
                ],
            }

            receipt = self._execute_receipt(db, draft_type="meal_plan", payload=payload, suffix="simple-plan")

            self.assertEqual(receipt.revert_adapter_key, "meal_plan.simple_create.v1")
            self.assertEqual(receipt.revert_context["schema_version"], 1)
            self.assertEqual(
                receipt.revert_context["items"],
                [
                    {
                        "food_plan_item_id": receipt.entity_ids[0],
                        "after_row_version": 1,
                    }
                ],
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_plan",
                payload=payload,
                receipt=receipt,
                suffix="simple-plan",
            )
            response = self._revert(db, operation, suffix="simple-plan")
            db.flush()

            self.assertEqual(response.projection.result_status, "reverted")
            self.assertIsNone(db.get(FoodPlanItem, receipt.entity_ids[0]))

    def test_non_allowlisted_manual_shapes_do_not_receive_revert_context(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            favorite = self._execute_receipt(
                db,
                draft_type="food_profile",
                suffix="manual-favorite",
                payload={
                    "draftType": "food_profile",
                    "schemaVersion": "food_profile_operation.v1",
                    "action": "set_favorite",
                    "targetId": food.id,
                    "baseUpdatedAt": food.updated_at.isoformat(),
                    "before": {"favorite": False},
                    "payload": {"favorite": True},
                    "displayText": "must not enter private context",
                },
            )
            self.assertIsNone(favorite.revert_adapter_key)
            self.assertIsNone(favorite.revert_context)

        with self.SessionLocal() as db:
            meal_log, entries = self._seed_rating_target(db)
            rating = self._execute_receipt(
                db,
                draft_type="meal_log",
                suffix="manual-rating",
                payload={
                    "draftType": "meal_log",
                    "schemaVersion": "meal_log_operation.v1",
                    "action": "rate_food",
                    "targetId": meal_log.id,
                    "baseUpdatedAt": meal_log.updated_at.isoformat(),
                    "before": {},
                    "payload": {"foodEntryRatings": [{"id": entries[0].id, "rating": 4.0}]},
                    "displayText": "not allowlisted",
                },
            )
            self.assertIsNone(rating.revert_adapter_key)
            self.assertIsNone(rating.revert_context)

        with self.SessionLocal() as db:
            plan = self._execute_receipt(
                db,
                draft_type="meal_plan",
                suffix="manual-plan",
                payload={
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "items": [
                        {
                            "date": "2026-08-27",
                            "mealType": "dinner",
                            "title": "番茄小炒",
                            "foodId": "food-tomato",
                            "reason": "manual shape",
                        }
                    ],
                },
            )
            self.assertIsNone(plan.revert_adapter_key)
            self.assertIsNone(plan.revert_context)

    def test_policy_ineligible_shapes_do_not_receive_revert_context(self) -> None:
        with self.SessionLocal() as db:
            shopping_item = {
                "title": "番茄",
                "quantity": 1,
                "unit": "个",
                "ingredient_id": "ingredient-tomato",
                "food_id": None,
                "quantity_mode": "track_quantity",
                "display_label": None,
                "reason": "duplicate target",
            }
            shopping = self._execute_receipt(
                db,
                draft_type="shopping_list",
                suffix="shopping-duplicate-target",
                payload={
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list.v1",
                    "sourceDraftId": None,
                    "items": [shopping_item, {**shopping_item, "quantity": 2}],
                },
            )
            self.assertIsNone(shopping.revert_adapter_key)
            self.assertIsNone(shopping.revert_context)

        with self.SessionLocal() as db:
            plan_item = {
                "date": "2026-08-27",
                "mealType": "dinner",
                "title": "番茄小炒",
                "foodId": "food-tomato",
                "recipeId": None,
                "reason": "duplicate target",
                "usedInventory": [],
                "missingIngredients": [],
                "missingIngredientItems": [],
                "source": {},
            }
            plan = self._execute_receipt(
                db,
                draft_type="meal_plan",
                suffix="plan-duplicate-target",
                payload={
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "source": {},
                    "items": [plan_item, {**plan_item, "reason": "same key"}],
                },
            )
            self.assertIsNone(plan.revert_adapter_key)
            self.assertIsNone(plan.revert_context)

    def test_canonical_mismatches_and_completed_update_are_not_revertible(self) -> None:
        with self.SessionLocal() as db:
            plan = self._execute_receipt(
                db,
                draft_type="meal_plan",
                suffix="plan-title-mismatch",
                payload={
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "source": {},
                    "items": [
                        {
                            "date": "2026-08-27",
                            "mealType": "dinner",
                            "title": "不是实际食物名",
                            "foodId": "food-tomato",
                            "recipeId": "not-the-linked-recipe",
                            "reason": "canonical mismatch",
                            "usedInventory": [],
                            "missingIngredients": [],
                            "missingIngredientItems": [],
                            "source": {},
                        }
                    ],
                },
            )
            self.assertIsNone(plan.revert_adapter_key)
            self.assertIsNone(plan.revert_context)

        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-task-11-completed-update",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("1"),
                unit="个",
                reason="before",
                done=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            shopping = self._execute_receipt(
                db,
                draft_type="shopping_list",
                suffix="shopping-completed-update",
                payload={
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list_operation.v1",
                    "sourceDraftId": None,
                    "operations": [
                        {
                            "operationId": "shopping-completed-update",
                            "action": "update",
                            "targetId": item.id,
                            "baseUpdatedAt": item.updated_at.isoformat(),
                            "before": {},
                            "payload": {
                                "title": item.title,
                                "quantity": 2,
                                "unit": "个",
                                "ingredient_id": item.ingredient_id,
                                "food_id": None,
                                "quantity_mode": "track_quantity",
                                "display_label": None,
                                "reason": "after",
                            },
                        }
                    ],
                },
            )
            self.assertIsNone(shopping.revert_adapter_key)
            self.assertIsNone(shopping.revert_context)

    def test_no_change_and_partial_change_writes_do_not_receive_adapters(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            favorite = self._execute_receipt(
                db,
                draft_type="food_profile",
                suffix="favorite-no-change",
                payload={
                    "draftType": "food_profile",
                    "schemaVersion": "food_profile_operation.v1",
                    "action": "set_favorite",
                    "targetId": food.id,
                    "baseUpdatedAt": food.updated_at.isoformat(),
                    "before": {"favorite": False},
                    "payload": {"favorite": False},
                },
            )
            self.assertIsNone(favorite.revert_adapter_key)
            self.assertIsNone(favorite.revert_context)

        with self.SessionLocal() as db:
            meal_log, entries = self._seed_rating_target(db)
            rating = self._execute_receipt(
                db,
                draft_type="meal_log",
                suffix="rating-partial-change",
                payload={
                    "draftType": "meal_log",
                    "schemaVersion": "meal_log_operation.v1",
                    "action": "rate_food",
                    "targetId": meal_log.id,
                    "baseUpdatedAt": meal_log.updated_at.isoformat(),
                    "before": {},
                    "payload": {
                        "foodEntryRatings": [
                            {"id": entries[0].id, "rating": 2.5},
                            {"id": entries[1].id, "rating": 4.0},
                        ]
                    },
                },
            )
            self.assertIsNone(rating.revert_adapter_key)
            self.assertIsNone(rating.revert_context)

        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-task-11-no-change",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("1"),
                unit="个",
                reason="same",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            shopping = self._execute_receipt(
                db,
                draft_type="shopping_list",
                suffix="shopping-no-change",
                payload={
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list_operation.v1",
                    "sourceDraftId": None,
                    "operations": [
                        {
                            "operationId": "shopping-no-change",
                            "action": "update",
                            "targetId": item.id,
                            "baseUpdatedAt": item.updated_at.isoformat(),
                            "before": {},
                            "payload": {
                                "title": item.title,
                                "quantity": 1,
                                "unit": item.unit,
                                "ingredient_id": item.ingredient_id,
                                "food_id": None,
                                "quantity_mode": "track_quantity",
                                "display_label": None,
                                "reason": item.reason,
                            },
                        }
                    ],
                },
            )
            self.assertIsNone(shopping.revert_adapter_key)
            self.assertIsNone(shopping.revert_context)

    def test_shopping_relink_update_remains_unsupported(self) -> None:
        with self.SessionLocal() as db:
            egg = Ingredient(
                id="ingredient-task-11-egg",
                family_id=self.family.id,
                name="鸡蛋",
                category="蛋类",
                default_unit="个",
                unit_conversions=[],
                default_storage="冷藏",
                notes="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            item = ShoppingListItem(
                id="shopping-task-11-relink",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("1"),
                unit="个",
                reason="before",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all((egg, item))
            db.flush()
            receipt = self._execute_receipt(
                db,
                draft_type="shopping_list",
                suffix="shopping-relink",
                payload={
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list_operation.v1",
                    "sourceDraftId": None,
                    "operations": [
                        {
                            "operationId": "shopping-relink",
                            "action": "update",
                            "targetId": item.id,
                            "baseUpdatedAt": item.updated_at.isoformat(),
                            "before": {},
                            "payload": {
                                "title": egg.name,
                                "quantity": 2,
                                "unit": "个",
                                "ingredient_id": egg.id,
                                "food_id": None,
                                "quantity_mode": "track_quantity",
                                "display_label": None,
                                "reason": "after",
                            },
                        }
                    ],
                },
            )
            self.assertIsNone(receipt.revert_adapter_key)
            self.assertIsNone(receipt.revert_context)

    def test_shopping_restore_handler_locks_reversed_batch_in_one_sorted_query(self) -> None:
        with self.SessionLocal() as db:
            items = [
                ShoppingListItem(
                    id=item_id,
                    family_id=self.family.id,
                    ingredient_id="ingredient-tomato",
                    title="番茄",
                    quantity=Decimal("1"),
                    unit="个",
                    reason="",
                    done=True,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                for item_id in ("shopping-task-11-z", "shopping-task-11-a")
            ]
            db.add_all(items)
            db.flush()
            statements: list[tuple[str, object]] = []

            def capture(_conn, _cursor, statement, parameters, _context, _many) -> None:
                if "shopping_list_items" in statement and "ORDER BY shopping_list_items.id ASC" in statement:
                    statements.append((statement, parameters))

            event.listen(self.engine, "before_cursor_execute", capture)
            try:
                receipt = self._execute_receipt(
                    db,
                    draft_type="shopping_list",
                    suffix="shopping-sorted-lock",
                    payload={
                        "draftType": "shopping_list",
                        "schemaVersion": "shopping_list_operation.v1",
                        "sourceDraftId": None,
                        "operations": [
                            {
                                "operationId": f"restore-{item.id}",
                                "action": "set_done",
                                "targetId": item.id,
                                "baseUpdatedAt": item.updated_at.isoformat(),
                                "before": {},
                                "payload": {"done": False, "reason": ""},
                            }
                            for item in items
                        ],
                    },
                )
            finally:
                event.remove(self.engine, "before_cursor_execute", capture)

            self.assertEqual(receipt.entity_ids, tuple(sorted(item.id for item in items)))
            batch_locks = [entry for entry in statements if entry[0].count("?") >= 3]
            self.assertEqual(len(batch_locks), 1)
            self.assertEqual(
                tuple(batch_locks[0][1]),
                (self.family.id, *tuple(sorted(item.id for item in items))),
            )

    def test_simple_plan_revert_job_processes_deletion_cleanup_to_success(self) -> None:
        registry = _ProfileVectorStoreRegistry()
        with self.SessionLocal() as db:
            payload = self._simple_plan_payload(reason="search cleanup")
            receipt = self._execute_receipt(db, draft_type="meal_plan", payload=payload, suffix="plan-search")
            plan_id = receipt.entity_ids[0]
            for job in db.scalars(
                select(SearchIndexJob).where(
                    SearchIndexJob.family_id == self.family.id,
                    SearchIndexJob.entity_type == "meal_plan",
                    SearchIndexJob.entity_id == plan_id,
                )
            ):
                job.status = "completed"
            (
                profile_document_id,
                other_profile_document_id,
                collection,
                other_collection,
            ) = self._seed_plan_vector_state(
                db,
                plan_id=plan_id,
                suffix="plan-success",
                registry=registry,
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_plan",
                payload=payload,
                receipt=receipt,
                suffix="plan-search",
            )

            self._revert(db, operation, suffix="plan-search")
            db.commit()

            self.assertIsNotNone(
                db.scalar(
                    select(SearchDocument).where(
                        SearchDocument.family_id == self.family.id,
                        SearchDocument.entity_type == "meal_plan",
                        SearchDocument.entity_id == plan_id,
                    )
                )
            )
            self.assertIsNotNone(db.get(FamilySearchProfileDocument, profile_document_id))
            queued = list(
                db.scalars(
                    select(SearchIndexJob).where(
                        SearchIndexJob.family_id == self.family.id,
                        SearchIndexJob.entity_type == "meal_plan",
                        SearchIndexJob.entity_id == plan_id,
                        SearchIndexJob.status == "queued",
                    )
                )
            )
            self.assertEqual(len(queued), 1)
            cleanup_job_id = queued[0].id
            self.assertEqual(queued[0].vector_status, "delete_pending")

        point_id = f"meal_plan:{plan_id}"
        self.assertIn(point_id, registry.store(collection).points)
        self.assertIn(point_id, registry.store(other_collection).points)
        with patch("app.services.search.jobs.build_vector_store", side_effect=registry.build):
            process_search_index_job(cleanup_job_id, session_factory=self.SessionLocal)
            process_search_index_job(cleanup_job_id, session_factory=self.SessionLocal)

        with self.SessionLocal() as db:
            cleanup_job = db.get(SearchIndexJob, cleanup_job_id)
            assert cleanup_job is not None
            self.assertEqual(cleanup_job.status, "succeeded")
            self.assertEqual(cleanup_job.vector_status, "skipped")
            self.assertEqual(cleanup_job.attempt_count, 0)
            self.assertIsNone(cleanup_job.error)
            self.assertIsNone(cleanup_job.error_code)
            self.assertIsNone(db.get(FamilySearchProfileDocument, profile_document_id))
            self.assertIsNotNone(
                db.get(FamilySearchProfileDocument, other_profile_document_id)
            )
            self.assertIsNone(
                db.scalar(
                    select(SearchDocument).where(
                        SearchDocument.family_id == self.family.id,
                        SearchDocument.entity_type == "meal_plan",
                        SearchDocument.entity_id == plan_id,
                    )
                )
            )
        self.assertNotIn(point_id, registry.store(collection).points)
        self.assertIn(point_id, registry.store(other_collection).points)

    def test_simple_plan_vector_delete_failure_retries_without_losing_cleanup_identity(self) -> None:
        registry = _ProfileVectorStoreRegistry()
        with self.SessionLocal() as db:
            payload = self._simple_plan_payload(reason="search cleanup retry")
            receipt = self._execute_receipt(
                db,
                draft_type="meal_plan",
                payload=payload,
                suffix="plan-search-retry",
            )
            plan_id = receipt.entity_ids[0]
            for job in db.scalars(
                select(SearchIndexJob).where(
                    SearchIndexJob.family_id == self.family.id,
                    SearchIndexJob.entity_type == "meal_plan",
                    SearchIndexJob.entity_id == plan_id,
                )
            ):
                job.status = "completed"
            profile_document_id, _, collection, _ = self._seed_plan_vector_state(
                db,
                plan_id=plan_id,
                suffix="plan-retry",
                registry=registry,
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_plan",
                payload=payload,
                receipt=receipt,
                suffix="plan-search-retry",
            )
            self._revert(db, operation, suffix="plan-search-retry")
            db.commit()
            cleanup_job = db.scalar(
                select(SearchIndexJob).where(
                    SearchIndexJob.family_id == self.family.id,
                    SearchIndexJob.entity_type == "meal_plan",
                    SearchIndexJob.entity_id == plan_id,
                    SearchIndexJob.status == "queued",
                )
            )
            assert cleanup_job is not None
            cleanup_job_id = cleanup_job.id

        point_id = f"meal_plan:{plan_id}"
        registry.store(collection).fail_delete_count = 1
        with patch("app.services.search.jobs.build_vector_store", side_effect=registry.build):
            process_search_index_job(cleanup_job_id, session_factory=self.SessionLocal)

        with self.SessionLocal() as db:
            failed_job = db.get(SearchIndexJob, cleanup_job_id)
            assert failed_job is not None
            self.assertEqual(failed_job.status, "failed")
            self.assertEqual(failed_job.vector_status, "delete_pending")
            self.assertEqual(failed_job.error_code, "search_vector_unavailable")
            self.assertEqual(failed_job.attempt_count, 0)
            self.assertIsNotNone(db.get(FamilySearchProfileDocument, profile_document_id))
            self.assertIsNotNone(
                db.scalar(
                    select(SearchDocument).where(
                        SearchDocument.family_id == self.family.id,
                        SearchDocument.entity_type == "meal_plan",
                        SearchDocument.entity_id == plan_id,
                    )
                )
            )
            retried = retry_failed_search_index_job(
                db,
                family_id=self.family.id,
                job_id=cleanup_job_id,
            )
            assert retried is not None
            self.assertEqual(retried.vector_status, "delete_pending")
            db.commit()
        self.assertIn(point_id, registry.store(collection).points)

        with patch("app.services.search.jobs.build_vector_store", side_effect=registry.build):
            process_search_index_job(cleanup_job_id, session_factory=self.SessionLocal)

        with self.SessionLocal() as db:
            succeeded_job = db.get(SearchIndexJob, cleanup_job_id)
            assert succeeded_job is not None
            self.assertEqual(succeeded_job.status, "succeeded")
            self.assertEqual(succeeded_job.vector_status, "skipped")
            self.assertIsNone(db.get(FamilySearchProfileDocument, profile_document_id))
        self.assertNotIn(point_id, registry.store(collection).points)

    def test_favorite_current_value_mismatch_blocks_without_compensation(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            payload = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": food.id,
                "baseUpdatedAt": food.updated_at.isoformat(),
                "before": {"favorite": False},
                "payload": {"favorite": True},
            }
            receipt = self._execute_receipt(db, draft_type="food_profile", payload=payload, suffix="favorite-current")
            operation = self._persist_receipt_operation(
                db,
                draft_type="food_profile",
                payload=payload,
                receipt=receipt,
                suffix="favorite-current",
            )
            db.execute(update(Food).where(Food.id == food.id).values(favorite=False))
            db.expire_all()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="favorite-current")

            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertFalse(db.get(Food, food.id).favorite)

    def test_private_revert_context_never_enters_public_results(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            payload = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": food.id,
                "baseUpdatedAt": food.updated_at.isoformat(),
                "before": {"favorite": False},
                "payload": {"favorite": True},
            }
            receipt = self._execute_receipt(
                db,
                draft_type="food_profile",
                payload=payload,
                suffix="private-context",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="food_profile",
                payload=payload,
                receipt=receipt,
                suffix="private-context",
            )
            draft = db.get(AITaskDraft, operation.draft_id)
            assert draft is not None and draft.message_id is not None
            message = db.get(AIMessage, draft.message_id)
            assert message is not None

            public_dump = json.dumps(
                jsonable_encoder(
                    {
                        "result": operation.result_json,
                        "parts": message.parts,
                        "artifacts": message.message_metadata.get("artifacts", []),
                    }
                ),
                ensure_ascii=False,
                sort_keys=True,
            )
            self.assertNotIn("before_favorite", public_dump)
            self.assertNotIn("after_favorite", public_dump)
            self.assertNotIn("after_row_version", public_dump)
            self.assertNotIn("revert_context", public_dump)

    def test_missing_favorite_shopping_and_plan_targets_fail_closed(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            payload = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": food.id,
                "baseUpdatedAt": food.updated_at.isoformat(),
                "before": {"favorite": False},
                "payload": {"favorite": True},
            }
            receipt = self._execute_receipt(
                db,
                draft_type="food_profile",
                payload=payload,
                suffix="favorite-missing",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="food_profile",
                payload=payload,
                receipt=receipt,
                suffix="favorite-missing",
            )
            db.delete(food)
            db.flush()
            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="favorite-missing")
            self.assertEqual(raised.exception.code, "revert_target_changed")

        with self.SessionLocal() as db:
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list.v1",
                "sourceDraftId": None,
                "items": [
                    {
                        "title": "番茄",
                        "quantity": 1,
                        "unit": "个",
                        "ingredient_id": "ingredient-tomato",
                        "food_id": None,
                        "quantity_mode": "track_quantity",
                        "display_label": None,
                        "reason": "missing target",
                    }
                ],
            }
            receipt = self._execute_receipt(
                db,
                draft_type="shopping_list",
                payload=payload,
                suffix="shopping-missing",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-missing",
            )
            item = db.get(ShoppingListItem, receipt.entity_ids[0])
            assert item is not None
            db.delete(item)
            db.flush()
            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="shopping-missing")
            self.assertEqual(raised.exception.code, "revert_target_changed")

        with self.SessionLocal() as db:
            payload = {
                "draftType": "meal_plan",
                "schemaVersion": "meal_plan.v1",
                "source": {},
                "items": [
                    {
                        "date": "2026-08-31",
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "missing target",
                        "usedInventory": [],
                        "missingIngredients": [],
                        "missingIngredientItems": [],
                        "source": {},
                    }
                ],
            }
            receipt = self._execute_receipt(
                db,
                draft_type="meal_plan",
                payload=payload,
                suffix="plan-missing",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_plan",
                payload=payload,
                receipt=receipt,
                suffix="plan-missing",
            )
            item = db.get(FoodPlanItem, receipt.entity_ids[0])
            assert item is not None
            db.delete(item)
            db.flush()
            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="plan-missing")
            self.assertEqual(raised.exception.code, "revert_target_changed")

    def test_each_adapter_rejects_cross_family_context_targets(self) -> None:
        with self.SessionLocal() as db:
            local_food = db.get(Food, "food-tomato")
            assert local_food is not None
            foreign_food = Food(
                id="food-task-11-foreign-favorite",
                family_id=self.other_family.id,
                name="其他家庭收藏",
                type=FoodType.SELF_MADE,
                category="测试",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(foreign_food)
            db.flush()
            payload = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": local_food.id,
                "baseUpdatedAt": local_food.updated_at.isoformat(),
                "before": {"favorite": False},
                "payload": {"favorite": True},
            }
            receipt = self._execute_receipt(
                db,
                draft_type="food_profile",
                payload=payload,
                suffix="favorite-family",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="food_profile",
                payload=payload,
                receipt=receipt,
                suffix="favorite-family",
            )
            operation.revert_context_json = {
                **operation.revert_context_json,
                "food_id": foreign_food.id,
            }
            db.flush()
            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="favorite-family")
            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertFalse(foreign_food.favorite)

        with self.SessionLocal() as db:
            meal_log, entries = self._seed_rating_target(db)
            foreign_meal_log = MealLog(
                id="meal-task-11-foreign-rating",
                family_id=self.other_family.id,
                date=date(2026, 8, 24),
                meal_type=MealType.DINNER,
                participant_user_ids=[],
                notes="",
                mood="",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(foreign_meal_log)
            db.flush()
            payload = {
                "draftType": "meal_log",
                "schemaVersion": "meal_log_operation.v1",
                "action": "rate_food",
                "targetId": meal_log.id,
                "baseUpdatedAt": meal_log.updated_at.isoformat(),
                "before": {},
                "payload": {"foodEntryRatings": [{"id": entries[0].id, "rating": 4.0}]},
            }
            receipt = self._execute_receipt(
                db,
                draft_type="meal_log",
                payload=payload,
                suffix="rating-family",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_log",
                payload=payload,
                receipt=receipt,
                suffix="rating-family",
            )
            operation.revert_context_json = {
                **operation.revert_context_json,
                "meal_log_id": foreign_meal_log.id,
            }
            db.flush()
            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="rating-family")
            self.assertEqual(raised.exception.code, "revert_target_changed")

        with self.SessionLocal() as db:
            foreign_shopping = ShoppingListItem(
                id="shopping-task-11-foreign",
                family_id=self.other_family.id,
                ingredient_id="ingredient-secret",
                title="其他家庭牛排",
                quantity=Decimal("1"),
                unit="块",
                reason="",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(foreign_shopping)
            db.flush()
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list.v1",
                "sourceDraftId": None,
                "items": [
                    {
                        "title": "番茄",
                        "quantity": 1,
                        "unit": "个",
                        "ingredient_id": "ingredient-tomato",
                        "food_id": None,
                        "quantity_mode": "track_quantity",
                        "display_label": None,
                        "reason": "family isolation",
                    }
                ],
            }
            receipt = self._execute_receipt(
                db,
                draft_type="shopping_list",
                payload=payload,
                suffix="shopping-family",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-family",
            )
            operation.revert_context_json = {
                **operation.revert_context_json,
                "items": [
                    {
                        **operation.revert_context_json["items"][0],
                        "shopping_item_id": foreign_shopping.id,
                    }
                ],
            }
            db.flush()
            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="shopping-family")
            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertIsNotNone(db.get(ShoppingListItem, foreign_shopping.id))

        with self.SessionLocal() as db:
            foreign_food = Food(
                id="food-task-11-foreign-plan",
                family_id=self.other_family.id,
                name="其他家庭计划",
                type=FoodType.SELF_MADE,
                category="测试",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            foreign_plan = FoodPlanItem(
                id="food-plan-task-11-foreign",
                family_id=self.other_family.id,
                user_id=self.user.id,
                food_id=foreign_food.id,
                plan_date=date(2026, 8, 31),
                meal_type=MealType.DINNER,
                note="",
                status="planned",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all((foreign_food, foreign_plan))
            db.flush()
            payload = {
                "draftType": "meal_plan",
                "schemaVersion": "meal_plan.v1",
                "source": {},
                "items": [
                    {
                        "date": "2026-08-31",
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "family isolation",
                        "usedInventory": [],
                        "missingIngredients": [],
                        "missingIngredientItems": [],
                        "source": {},
                    }
                ],
            }
            receipt = self._execute_receipt(
                db,
                draft_type="meal_plan",
                payload=payload,
                suffix="plan-family",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_plan",
                payload=payload,
                receipt=receipt,
                suffix="plan-family",
            )
            operation.revert_context_json = {
                **operation.revert_context_json,
                "items": [
                    {
                        **operation.revert_context_json["items"][0],
                        "food_plan_item_id": foreign_plan.id,
                    }
                ],
            }
            db.flush()
            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="plan-family")
            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertIsNotNone(db.get(FoodPlanItem, foreign_plan.id))

    def test_rating_missing_entry_blocks_all_rating_restores(self) -> None:
        with self.SessionLocal() as db:
            meal_log, entries = self._seed_rating_target(db)
            payload = {
                "draftType": "meal_log",
                "schemaVersion": "meal_log_operation.v1",
                "action": "rate_food",
                "targetId": meal_log.id,
                "baseUpdatedAt": meal_log.updated_at.isoformat(),
                "before": {},
                "payload": {
                    "foodEntryRatings": [
                        {"id": entries[0].id, "rating": 4.5},
                        {"id": entries[1].id, "rating": 3.0},
                    ]
                },
            }
            receipt = self._execute_receipt(db, draft_type="meal_log", payload=payload, suffix="rating-missing")
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_log",
                payload=payload,
                receipt=receipt,
                suffix="rating-missing",
            )
            db.delete(entries[0])
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="rating-missing")

            self.assertEqual(raised.exception.code, "revert_target_changed")
            surviving = db.get(MealLogFood, entries[1].id)
            assert surviving is not None
            self.assertEqual(surviving.rating, Decimal("3.0"))

    def test_rating_current_value_mismatch_blocks_all_rating_restores(self) -> None:
        with self.SessionLocal() as db:
            meal_log, entries = self._seed_rating_target(db)
            payload = {
                "draftType": "meal_log",
                "schemaVersion": "meal_log_operation.v1",
                "action": "rate_food",
                "targetId": meal_log.id,
                "baseUpdatedAt": meal_log.updated_at.isoformat(),
                "before": {},
                "payload": {
                    "foodEntryRatings": [
                        {"id": entries[0].id, "rating": 4.5},
                        {"id": entries[1].id, "rating": 3.0},
                    ]
                },
            }
            receipt = self._execute_receipt(
                db,
                draft_type="meal_log",
                payload=payload,
                suffix="rating-current",
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_log",
                payload=payload,
                receipt=receipt,
                suffix="rating-current",
            )
            db.execute(
                update(MealLogFood)
                .where(MealLogFood.id == entries[0].id)
                .values(rating=Decimal("1.5"))
            )
            db.expire_all()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="rating-current")

            self.assertEqual(raised.exception.code, "revert_target_changed")
            ratings = {
                entry.id: entry.rating
                for entry in db.scalars(
                    select(MealLogFood).where(MealLogFood.meal_log_id == meal_log.id)
                )
            }
            self.assertEqual(ratings[entries[0].id], Decimal("1.5"))
            self.assertEqual(ratings[entries[1].id], Decimal("3.0"))

    def test_shopping_add_batch_conflict_deletes_nothing(self) -> None:
        with self.SessionLocal() as db:
            extra_ingredients = [
                Ingredient(
                    id=ingredient_id,
                    family_id=self.family.id,
                    name=name,
                    category="测试",
                    default_unit="个",
                    unit_conversions=[],
                    default_storage="冷藏",
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                for ingredient_id, name in (
                    ("ingredient-task-11-batch-egg", "鸡蛋"),
                    ("ingredient-task-11-batch-onion", "洋葱"),
                )
            ]
            db.add_all(extra_ingredients)
            db.flush()
            targets = [
                ("ingredient-tomato", "番茄"),
                (extra_ingredients[0].id, extra_ingredients[0].name),
                (extra_ingredients[1].id, extra_ingredients[1].name),
            ]
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list.v1",
                "sourceDraftId": None,
                "items": [
                    {
                        "title": title,
                        "quantity": index,
                        "unit": "个",
                        "ingredient_id": ingredient_id,
                        "food_id": None,
                        "quantity_mode": "track_quantity",
                        "display_label": None,
                        "reason": f"batch-{index}",
                    }
                    for index, (ingredient_id, title) in enumerate(targets, start=1)
                ],
            }
            receipt = self._execute_receipt(db, draft_type="shopping_list", payload=payload, suffix="shopping-batch")
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-batch",
            )
            changed = db.get(ShoppingListItem, receipt.entity_ids[1])
            assert changed is not None
            changed.reason = "family changed it"
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="shopping-batch")

            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertEqual(
                set(db.scalars(select(ShoppingListItem.id).where(ShoppingListItem.id.in_(receipt.entity_ids)))),
                set(receipt.entity_ids),
            )

    def test_shopping_add_used_by_intake_is_dependency(self) -> None:
        with self.SessionLocal() as db:
            payload = {
                "draftType": "shopping_list",
                "schemaVersion": "shopping_list.v1",
                "sourceDraftId": None,
                "items": [
                    {
                        "title": "番茄",
                        "quantity": 1,
                        "unit": "个",
                        "ingredient_id": "ingredient-tomato",
                        "food_id": None,
                        "quantity_mode": "track_quantity",
                        "display_label": None,
                        "reason": "intake dependency",
                    }
                ],
            }
            receipt = self._execute_receipt(db, draft_type="shopping_list", payload=payload, suffix="shopping-intake")
            operation = self._persist_receipt_operation(
                db,
                draft_type="shopping_list",
                payload=payload,
                receipt=receipt,
                suffix="shopping-intake",
            )
            intake = InventoryOperation(
                id="inventory-operation-task-11",
                family_id=self.family.id,
                operation_type=InventoryOperationType.SHOPPING_INTAKE,
                status=InventoryOperationStatus.APPLIED,
                client_request_id="intake-task-11",
                request_hash="a" * 64,
                actor_id=self.user.id,
                applied_at=NOW,
                revertible_until=NOW + timedelta(hours=1),
                summary_json={},
            )
            line = InventoryOperationLine(
                id="inventory-line-task-11",
                operation_id=intake.id,
                sequence=0,
                entity_type=InventoryOperationEntityType.SHOPPING_LIST_ITEM,
                entity_id=receipt.entity_ids[0],
                change_type=InventoryOperationChangeType.UPDATE,
                before_snapshot={},
                after_snapshot={},
                before_row_version=1,
                after_row_version=2,
            )
            db.add_all((intake, line))
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="shopping-intake")

            self.assertEqual(raised.exception.code, "revert_dependency_exists")
            self.assertIsNotNone(db.get(ShoppingListItem, receipt.entity_ids[0]))

    def test_simple_plan_batch_conflict_deletes_nothing(self) -> None:
        with self.SessionLocal() as db:
            payload = {
                "draftType": "meal_plan",
                "schemaVersion": "meal_plan.v1",
                "source": {},
                "items": [
                    {
                        "date": f"2026-08-{day}",
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": f"batch-{day}",
                        "usedInventory": [],
                        "missingIngredients": [],
                        "missingIngredientItems": [],
                        "source": {},
                    }
                    for day in (29, 30)
                ],
            }
            receipt = self._execute_receipt(db, draft_type="meal_plan", payload=payload, suffix="plan-batch")
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_plan",
                payload=payload,
                receipt=receipt,
                suffix="plan-batch",
            )
            db.add_all(
                [
                    SearchDocument(
                        id=f"search-doc-task-11-rollback-{index}",
                        family_id=self.family.id,
                        entity_type="meal_plan",
                        entity_id=item_id,
                        content_hash=str(index) * 64,
                        document_builder_version="test",
                    )
                    for index, item_id in enumerate(receipt.entity_ids, start=1)
                ]
            )
            db.flush()
            job_ids_before = set(
                db.scalars(
                    select(SearchIndexJob.id).where(
                        SearchIndexJob.family_id == self.family.id,
                        SearchIndexJob.entity_type == "meal_plan",
                        SearchIndexJob.entity_id.in_(receipt.entity_ids),
                    )
                )
            )
            changed = db.get(FoodPlanItem, receipt.entity_ids[1])
            assert changed is not None
            changed.note = "family changed it"
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="plan-batch")

            self.assertEqual(raised.exception.code, "revert_target_changed")
            self.assertEqual(
                set(db.scalars(select(FoodPlanItem.id).where(FoodPlanItem.id.in_(receipt.entity_ids)))),
                set(receipt.entity_ids),
            )
            self.assertEqual(
                set(
                    db.scalars(
                        select(SearchDocument.entity_id).where(
                            SearchDocument.family_id == self.family.id,
                            SearchDocument.entity_type == "meal_plan",
                            SearchDocument.entity_id.in_(receipt.entity_ids),
                        )
                    )
                ),
                set(receipt.entity_ids),
            )
            self.assertEqual(
                set(
                    db.scalars(
                        select(SearchIndexJob.id).where(
                            SearchIndexJob.family_id == self.family.id,
                            SearchIndexJob.entity_type == "meal_plan",
                            SearchIndexJob.entity_id.in_(receipt.entity_ids),
                        )
                    )
                ),
                job_ids_before,
            )

    def test_completed_simple_plan_is_dependency(self) -> None:
        with self.SessionLocal() as db:
            payload = {
                "draftType": "meal_plan",
                "schemaVersion": "meal_plan.v1",
                "source": {},
                "items": [
                    {
                        "date": "2026-08-31",
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "completed dependency",
                        "usedInventory": [],
                        "missingIngredients": [],
                        "missingIngredientItems": [],
                        "source": {},
                    }
                ],
            }
            receipt = self._execute_receipt(db, draft_type="meal_plan", payload=payload, suffix="plan-completed")
            operation = self._persist_receipt_operation(
                db,
                draft_type="meal_plan",
                payload=payload,
                receipt=receipt,
                suffix="plan-completed",
            )
            item = db.get(FoodPlanItem, receipt.entity_ids[0])
            assert item is not None
            item.status = "cooked"
            db.flush()

            with self.assertRaises(AIRevertError) as raised:
                self._revert(db, operation, suffix="plan-completed")

            self.assertEqual(raised.exception.code, "revert_dependency_exists")
            self.assertIsNotNone(db.get(FoodPlanItem, item.id))

    def test_original_member_and_owner_can_revert_real_favorite_operations(self) -> None:
        member, membership = self.create_family_member(user_id="user-task-11-member")
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None
            payload = {
                "draftType": "food_profile",
                "schemaVersion": "food_profile_operation.v1",
                "action": "set_favorite",
                "targetId": food.id,
                "baseUpdatedAt": food.updated_at.isoformat(),
                "before": {"favorite": False},
                "payload": {"favorite": True},
            }
            receipt = self._execute_receipt(
                db,
                draft_type="food_profile",
                payload=payload,
                suffix="member-actor",
                user_id=member.id,
            )
            operation = self._persist_receipt_operation(
                db,
                draft_type="food_profile",
                payload=payload,
                receipt=receipt,
                suffix="member-actor",
                actor_user_id=member.id,
            )
            response = self._revert(db, operation, suffix="member-actor", actor_user_id=member.id)
            self.assertEqual(response.projection.result_status, "reverted")
            self.assertFalse(db.get(Food, food.id).favorite)

            food = db.get(Food, "food-tomato")
            assert food is not None
            second_payload = {
                **payload,
                "baseUpdatedAt": food.updated_at.isoformat(),
            }
            second_receipt = self._execute_receipt(
                db,
                draft_type="food_profile",
                payload=second_payload,
                suffix="owner-for-member",
                user_id=member.id,
            )
            second_operation = self._persist_receipt_operation(
                db,
                draft_type="food_profile",
                payload=second_payload,
                receipt=second_receipt,
                suffix="owner-for-member",
                actor_user_id=member.id,
            )
            owner_response = self._revert(db, second_operation, suffix="owner-for-member")
            self.assertEqual(owner_response.projection.result_status, "reverted")
            self.assertFalse(db.get(Food, food.id).favorite)
            self.assertEqual(membership.role, UserRole.MEMBER)

    def test_original_member_and_owner_permission_matrix_for_remaining_adapters(self) -> None:
        member, membership = self.create_family_member(
            user_id="user-task-11-permission-matrix"
        )
        for fixture_name in (
            "rating",
            "shopping_add",
            "shopping_update",
            "shopping_restore",
            "simple_plan",
        ):
            with self.subTest(fixture=fixture_name, actor="original_member"):
                self._exercise_permission_fixture(
                    fixture_name=fixture_name,
                    suffix=f"permission-member-{fixture_name}",
                    member_id=member.id,
                    revert_actor_id=member.id,
                )
            with self.subTest(fixture=fixture_name, actor="current_owner"):
                self._exercise_permission_fixture(
                    fixture_name=fixture_name,
                    suffix=f"permission-owner-{fixture_name}",
                    member_id=member.id,
                    revert_actor_id=self.user.id,
                )
        self.assertEqual(membership.role, UserRole.MEMBER)


if __name__ == "__main__":
    import unittest

    unittest.main()
