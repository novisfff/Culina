from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import patch

from sqlalchemy import func, select

from ._support import *

from app.ai.draft_contracts import (
    AI_DRAFT_CONTRACTS_HEADER,
    ClientContractUpgradeRequired,
    DraftContractCapabilities,
    RECIPE_COOK_V1,
    RECIPE_COOK_V2,
    accepted_recipe_cook_versions,
    generated_recipe_cook_version,
    parse_draft_contract_capabilities,
    recipe_cook_contracts_probe,
    select_recipe_cook_generation_version,
)
from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.recipe import recipe_create_cook_draft
from app.ai.errors import AIConflictError
from app.ai.tools.draft_validation import normalize_recipe_cook_draft
from app.core.enums import Difficulty, FoodType, MealType
from app.models.domain import (
    AIOperation,
    Food,
    FoodPlanItem,
    InventoryItem,
    MealLog,
    Recipe,
    RecipeCookLog,
    RecipeIngredient,
)
from app.services.ai_operations.common import assert_updated_at_matches
from app.services.ai_operations.executor import (
    derive_child_operation_idempotency_key,
    execute_ai_operation_draft,
)
from app.services.ai_operations.recipe_cook import execute_recipe_cook_draft
from app.services.ai_operations.drafts import normalize_ai_draft_payload


class AIDraftContractsTestCase(AIAgentInfraTestCase):
    def test_b1_accepts_v1_and_v2_but_generates_v1(self) -> None:
        self.assertEqual(
            accepted_recipe_cook_versions(),
            {"recipe_cook_operation.v1", "recipe_cook_operation.v2"},
        )
        self.assertEqual(generated_recipe_cook_version(), "recipe_cook_operation.v1")

    def test_capability_parser_accepts_known_tokens_only(self) -> None:
        capabilities = parse_draft_contract_capabilities(
            " recipe_cook_operation.v2,unknown.v9,recipe_cook_operation.v1 "
        )
        self.assertEqual(
            capabilities.recipe_cook_versions,
            frozenset({"recipe_cook_operation.v1", "recipe_cook_operation.v2"}),
        )
        self.assertEqual(parse_draft_contract_capabilities(None).values, frozenset())
        self.assertEqual(parse_draft_contract_capabilities("").values, frozenset())

    def test_select_recipe_cook_generation_version_b1_allows_v1_without_header(self) -> None:
        empty = DraftContractCapabilities(values=frozenset())
        self.assertEqual(
            select_recipe_cook_generation_version(empty, generated_version=RECIPE_COOK_V1),
            RECIPE_COOK_V1,
        )

    def test_select_recipe_cook_generation_version_rejects_future_v2_without_capability(self) -> None:
        empty = DraftContractCapabilities(values=frozenset())
        with self.assertRaises(ClientContractUpgradeRequired) as raised:
            select_recipe_cook_generation_version(empty, generated_version=RECIPE_COOK_V2)
        self.assertEqual(raised.exception.code, "client_contract_upgrade_required")

        capable = DraftContractCapabilities(values=frozenset({RECIPE_COOK_V2}))
        self.assertEqual(
            select_recipe_cook_generation_version(capable, generated_version=RECIPE_COOK_V2),
            RECIPE_COOK_V2,
        )

    def test_recipe_create_cook_draft_gates_before_normalize(self) -> None:
        with self.SessionLocal() as db:
            self._seed_cook_recipe(db, recipe_id="recipe-gate-capability")
            db.commit()
            context = ToolContext(
                db=db,
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-gate",
                run_id="run-gate",
                generation_contracts=frozenset(),
            )
            with patch(
                "app.ai.tools.catalog.recipe.select_recipe_cook_generation_version",
                side_effect=ClientContractUpgradeRequired(),
            ):
                with self.assertRaises(ClientContractUpgradeRequired):
                    recipe_create_cook_draft(
                        context,
                        {
                            "draft": {
                                "recipeId": "recipe-gate-capability",
                                "servings": 1,
                                "date": date.today().isoformat(),
                                "mealType": "dinner",
                            }
                        },
                    )

    def test_recipe_cook_contracts_probe_is_non_secret(self) -> None:
        probe = recipe_cook_contracts_probe()
        self.assertEqual(
            probe["accepted_versions"],
            ["recipe_cook_operation.v1", "recipe_cook_operation.v2"],
        )
        self.assertEqual(probe["generated_version"], "recipe_cook_operation.v1")
        self.assertEqual(probe["projection_version"], 1)

    def test_ai_status_and_registry_expose_recipe_cook_contracts(self) -> None:
        status = self.client.get("/api/ai/status")
        self.assertEqual(status.status_code, 200, status.text)
        self.assertEqual(
            status.json()["recipe_cook_contracts"]["generated_version"],
            "recipe_cook_operation.v1",
        )
        registry = self.client.get("/api/ai/registry")
        self.assertEqual(registry.status_code, 200, registry.text)
        self.assertIn("recipe_cook_operation.v2", registry.json()["recipe_cook_contracts"]["accepted_versions"])

    def test_chat_propagates_generation_contracts_into_tool_context(self) -> None:
        captured: list[frozenset[str]] = []
        original_init = ToolContext.__init__

        def spy_init(self, *args, **kwargs):
            captured.append(frozenset(kwargs.get("generation_contracts") or ()))
            return original_init(self, *args, **kwargs)

        with patch.object(ToolContext, "__init__", spy_init):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "库存怎么样"},
                headers={
                    AI_DRAFT_CONTRACTS_HEADER: "recipe_cook_operation.v1,recipe_cook_operation.v2",
                },
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers.get("Cache-Control"), "private, no-store")
        self.assertEqual(response.headers.get("Vary"), AI_DRAFT_CONTRACTS_HEADER)
        self.assertTrue(captured)
        self.assertIn(
            frozenset({"recipe_cook_operation.v1", "recipe_cook_operation.v2"}),
            captured,
        )

    def test_generation_entrypoint_service_methods_forward_current_request_capability(self) -> None:
        contracts = frozenset({"recipe_cook_operation.v1", "recipe_cook_operation.v2"})
        with self.SessionLocal() as db:
            service = AIApplicationService(db, provider=FakeChatProvider())
            with patch(
                "app.ai.workflows.runner.WorkspaceGraphRunner.invoke_user_message",
                return_value={"ok": True},
            ) as invoke:
                service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="hello",
                    generation_contracts=contracts,
                )
                self.assertEqual(invoke.call_args.kwargs["generation_contracts"], contracts)

            with patch(
                "app.ai.workflows.runner.WorkspaceGraphRunner.stream_user_message",
                return_value=iter([]),
            ) as stream:
                list(
                    service.stream_chat(
                        family_id=self.family.id,
                        user_id=self.user.id,
                        message="hello",
                        generation_contracts=contracts,
                    )
                )
                self.assertEqual(stream.call_args.kwargs["generation_contracts"], contracts)

            with patch(
                "app.ai.workflows.runner.WorkspaceGraphRunner.resume_human_input",
                return_value={"ok": True},
            ) as resume_hi, patch.object(service, "_require_conversation"):
                service.respond_human_input(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-capability",
                    request_id="request-1",
                    selected_option_ids=["a"],
                    text=None,
                    generation_contracts=contracts,
                )
                self.assertEqual(resume_hi.call_args.kwargs["generation_contracts"], contracts)

            with patch(
                "app.ai.workflows.runner.WorkspaceGraphRunner.stream_resume_human_input",
                return_value=iter([]),
            ) as stream_hi, patch.object(service, "_require_conversation"):
                list(
                    service.stream_human_input_response(
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-capability",
                        request_id="request-1",
                        selected_option_ids=["a"],
                        text=None,
                        generation_contracts=contracts,
                    )
                )
                self.assertEqual(stream_hi.call_args.kwargs["generation_contracts"], contracts)

            with patch(
                "app.ai.workflows.runner.WorkspaceGraphRunner.apply_approval_decision_fast",
                return_value={"ok": True},
            ) as decide, patch.object(service, "_require_conversation"):
                service.decide_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-capability",
                    approval_id="approval-1",
                    decision="approved",
                    draft_version=1,
                    values={},
                    generation_contracts=contracts,
                )
                self.assertEqual(decide.call_args.kwargs["generation_contracts"], contracts)

            with patch(
                "app.ai.workflows.runner.WorkspaceGraphRunner.stream_resume_approval",
                return_value=iter([]),
            ) as stream_approval, patch.object(service, "_require_conversation"):
                list(
                    service.stream_approval_decision(
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-capability",
                        approval_id="approval-1",
                        decision="approved",
                        draft_version=1,
                        values={},
                        generation_contracts=contracts,
                    )
                )
                self.assertEqual(stream_approval.call_args.kwargs["generation_contracts"], contracts)

    def test_resume_command_overrides_checkpoint_generation_contracts(self) -> None:
        from app.ai.workflows.runner import WorkspaceGraphRunner

        command = WorkspaceGraphRunner._resume_command(
            resume_payload={"requestId": "request-1"},
            generation_contracts=frozenset({"recipe_cook_operation.v2"}),
        )
        self.assertEqual(command.update, {"generation_contracts": ["recipe_cook_operation.v2"]})
        self.assertEqual(command.resume, {"requestId": "request-1"})

    def _seed_cook_recipe(self, db, *, recipe_id: str = "recipe-contract-cook", quantity: int = 1) -> Recipe:
        recipe = Recipe(
            id=recipe_id,
            family_id=self.family.id,
            title="合同番茄快炒",
            servings=2,
            prep_minutes=10,
            difficulty=Difficulty.EASY,
            tips="",
            scene_tags=["家常菜"],
            created_by=self.user.id,
            updated_by=self.user.id,
        )
        db.add(recipe)
        db.flush()
        db.add(
            RecipeIngredient(
                id=f"{recipe_id}-ingredient",
                recipe_id=recipe.id,
                ingredient_id="ingredient-tomato",
                ingredient_name="番茄",
                quantity=quantity,
                unit="个",
                note="切块",
                sort_order=0,
            )
        )
        db.flush()
        return recipe

    def _count_side_effects(self, db) -> int:
        cook_logs = db.scalar(select(func.count()).select_from(RecipeCookLog)) or 0
        meal_logs = db.scalar(select(func.count()).select_from(MealLog)) or 0
        return int(cook_logs) + int(meal_logs)

    def test_v1_true_executes_shared_completion(self) -> None:
        with self.SessionLocal() as db:
            recipe = self._seed_cook_recipe(db, recipe_id="recipe-v1-true")
            db.commit()

        with self.SessionLocal() as db:
            draft = normalize_recipe_cook_draft(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                payload={
                    "schemaVersion": "recipe_cook_operation.v1",
                    "recipeId": "recipe-v1-true",
                    "servings": 1,
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "createMealLog": True,
                },
            )
            result, ids = execute_recipe_cook_draft(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                payload=draft,
                operation_idempotency_key="approval-1:recipe.cook:v1",
            )
            db.commit()
            self.assertTrue(result["meal_log_id"])
            self.assertIn(result["cook_log_id"], ids)
            cook_log = db.get(RecipeCookLog, result["cook_log_id"])
            self.assertIsNotNone(cook_log)
            self.assertEqual(cook_log.completion_request_id, "approval-1:recipe.cook:v1")
            inventory = db.get(InventoryItem, "inventory-tomato")
            # Recipe default servings=2 with cook servings=1 scales requested quantity.
            self.assertGreater(inventory.consumed_quantity, Decimal("0"))
            self.assertEqual(result["consumed_items"][0]["requested_quantity"], 0.5)

    def test_v1_false_is_recoverable_and_has_no_side_effect(self) -> None:
        with self.SessionLocal() as db:
            self._seed_cook_recipe(db, recipe_id="recipe-v1-false")
            db.commit()
            before = self._count_side_effects(db)

        with self.SessionLocal() as db:
            draft = normalize_recipe_cook_draft(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                payload={
                    "schemaVersion": "recipe_cook_operation.v1",
                    "recipeId": "recipe-v1-false",
                    "servings": 1,
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "createMealLog": False,
                },
            )
            with self.assertRaises(AIConflictError) as raised:
                execute_recipe_cook_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload=draft,
                    operation_idempotency_key="approval-2:recipe.cook:v1",
                )
            self.assertIn("做菜完成规则已更新", str(raised.exception))
            db.rollback()
            self.assertEqual(self._count_side_effects(db), before)
            inventory = db.get(InventoryItem, "inventory-tomato")
            self.assertEqual(inventory.consumed_quantity, Decimal("0"))

    def test_v2_rejects_create_meal_log_field(self) -> None:
        with self.SessionLocal() as db:
            self._seed_cook_recipe(db, recipe_id="recipe-v2-reject")
            db.commit()

        with self.SessionLocal() as db:
            with self.assertRaises(ValueError):
                normalize_recipe_cook_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "schemaVersion": "recipe_cook_operation.v2",
                        "recipeId": "recipe-v2-reject",
                        "servings": 1,
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                        "createMealLog": True,
                    },
                )

    def test_v2_normalizes_and_executes_without_create_meal_log(self) -> None:
        with self.SessionLocal() as db:
            self._seed_cook_recipe(db, recipe_id="recipe-v2-exec")
            db.commit()

        with self.SessionLocal() as db:
            draft = normalize_recipe_cook_draft(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                payload={
                    "schemaVersion": "recipe_cook_operation.v2",
                    "recipeId": "recipe-v2-exec",
                    "servings": 1,
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                },
            )
            self.assertEqual(draft["schemaVersion"], "recipe_cook_operation.v2")
            self.assertNotIn("createMealLog", draft)
            result, ids = execute_recipe_cook_draft(
                db,
                family_id=self.family.id,
                user_id=self.user.id,
                payload=draft,
                operation_idempotency_key="approval-v2:recipe.cook:v1",
            )
            db.commit()
            self.assertTrue(result["meal_log_id"])
            self.assertIn(result["cook_log_id"], ids)

    def test_recipe_cook_retry_reuses_failed_operation_completion_key(self) -> None:
        with self.SessionLocal() as db:
            recipe = self._seed_cook_recipe(db, recipe_id="recipe-retry-direct")
            food = Food(
                id="food-retry-direct",
                family_id=self.family.id,
                name=recipe.title,
                type=FoodType.SELF_MADE,
                category="家常菜",
                flavor_tags=[],
                scene_tags=["家常菜"],
                suitable_meal_types=["dinner"],
                source_name="自家菜谱",
                purchase_source="",
                scene="晚餐",
                notes="",
                routine_note="",
                recipe_id=recipe.id,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(food)
            db.flush()
            plan_item = FoodPlanItem(
                id="plan-retry-direct",
                family_id=self.family.id,
                user_id=self.user.id,
                food_id=food.id,
                plan_date=date.today(),
                meal_type=MealType.DINNER,
                note="重试计划",
                status="planned",
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(plan_item)
            db.commit()

            draft_payload = {
                "draftType": "recipe_cook",
                "schemaVersion": "recipe_cook_operation.v1",
                "recipeId": recipe.id,
                "servings": 1,
                "date": date.today().isoformat(),
                "mealType": "dinner",
                "createMealLog": True,
                "planItemId": plan_item.id,
            }
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="recipe_cook",
                payload=draft_payload,
                suffix="retry-direct",
            )

            with patch(
                "app.services.ai_operations.approval_decisions.classify_approval_highlight",
                side_effect=RuntimeError("post-execute artifact failure"),
            ):
                first = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            self.assertEqual(first["operation"]["status"], "failed")
            self.assertEqual(first["draft"]["status"], "pending_retry")
            failed_operation = db.get(AIOperation, first["operation"]["id"])
            self.assertIsNotNone(failed_operation)
            failed_key = failed_operation.idempotency_key
            # Business write succeeded before post-execute failure.
            self.assertEqual(db.scalar(select(func.count()).select_from(RecipeCookLog)), 1)
            cook_log = db.scalar(select(RecipeCookLog))
            self.assertEqual(cook_log.completion_request_id, failed_key)

            retry_approval = db.get(type(approval), first["approval"]["id"])
            assert retry_approval is not None
            db.refresh(draft)
            retry = self._approve_ai_approval_for_test(service, draft=draft, approval=retry_approval)
            self.assertEqual(retry["operation"]["id"], failed_operation.id)
            self.assertEqual(retry["operation"]["status"], "succeeded")
            self.assertEqual(retry["business_entity"]["meal_log_id"], cook_log.meal_log_id)
            self.assertEqual(retry["business_entity"]["cook_log_id"], cook_log.id)
            self.assertEqual(db.scalar(select(func.count()).select_from(RecipeCookLog)), 1)
            self.assertEqual(db.scalar(select(func.count()).select_from(MealLog)), 1)

    def test_composite_recipe_cook_retry_reuses_child_completion_key(self) -> None:
        with self.SessionLocal() as db:
            recipe = self._seed_cook_recipe(db, recipe_id="recipe-retry-composite")
            db.commit()

            proposal = normalize_ai_draft_payload(
                db,
                draft_type="composite_operation",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-composite-retry-cook",
                payload={
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "cook-step",
                            "domain": "recipe_cook",
                            "operation": {
                                "operationId": "cook-step-1",
                                "schemaVersion": "recipe_cook_operation.v1",
                                "recipeId": recipe.id,
                                "servings": 1,
                                "date": date.today().isoformat(),
                                "mealType": "dinner",
                                "createMealLog": True,
                            },
                        }
                    ],
                },
            )
            self.assertEqual(proposal["steps"][0]["operation"]["operationId"], "cook-step-1")

            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="composite_operation",
                payload=proposal,
                suffix="retry-composite-cook",
            )

            with patch(
                "app.services.ai_operations.approval_decisions.classify_approval_highlight",
                side_effect=RuntimeError("post-execute artifact failure"),
            ):
                first = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            failed_operation = db.get(AIOperation, first["operation"]["id"])
            self.assertIsNotNone(failed_operation)
            parent_key = failed_operation.idempotency_key
            child_key = derive_child_operation_idempotency_key(parent_key, "cook-step-1")
            cook_log = db.scalar(select(RecipeCookLog))
            self.assertIsNotNone(cook_log)
            self.assertEqual(cook_log.completion_request_id, child_key)

            retry_approval = db.get(type(approval), first["approval"]["id"])
            assert retry_approval is not None
            db.refresh(draft)
            retry = self._approve_ai_approval_for_test(service, draft=draft, approval=retry_approval)
            self.assertEqual(retry["operation"]["id"], failed_operation.id)
            self.assertEqual(db.scalar(select(func.count()).select_from(RecipeCookLog)), 1)
            self.assertEqual(
                derive_child_operation_idempotency_key(retry["operation"]["id"] and parent_key, "cook-step-1"),
                child_key,
            )

    def test_composite_recipe_cook_requires_operation_id(self) -> None:
        with self.SessionLocal() as db:
            recipe = self._seed_cook_recipe(db, recipe_id="recipe-composite-missing-op")
            draft = normalize_ai_draft_payload(
                db,
                draft_type="composite_operation",
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-composite-missing-op",
                payload={
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "cook-step",
                            "domain": "recipe_cook",
                            "operation": {
                                "schemaVersion": "recipe_cook_operation.v1",
                                "recipeId": recipe.id,
                                "servings": 1,
                                "date": date.today().isoformat(),
                                "mealType": "dinner",
                                "createMealLog": True,
                            },
                        }
                    ],
                },
            )
            with self.assertRaises(ValueError):
                execute_ai_operation_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    draft_type="composite_operation",
                    payload=draft,
                    assert_updated_at_matches=assert_updated_at_matches,
                    operation_idempotency_key="parent:composite:v1",
                )


if __name__ == "__main__":
    unittest.main()
