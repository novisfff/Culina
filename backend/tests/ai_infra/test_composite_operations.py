from ._support import *

from app.core.enums import ActivityHighlightKind
from app.services.activity import ActivityHighlight
from app.services.ai_operations.highlights import classify_approval_highlight
from app.services.ai_operations.registry import draft_operation_registry


def test_composite_mapping_aggregates_same_kind_and_ignores_empty_steps() -> None:
    result = classify_approval_highlight(
        draft_operation_registry,
        draft_type="composite_operation",
        submitted_payload={
            "steps": [
                {
                    "stepId": "ingredient-1",
                    "domain": "ingredient",
                    "operation": {"action": "create", "name": "番茄"},
                },
                {
                    "stepId": "plan-1",
                    "domain": "meal_plan",
                    "operation": {"operations": [{"action": "create"}]},
                },
                {
                    "stepId": "plan-2",
                    "domain": "meal_plan",
                    "operation": {"operations": [{"action": "create"}]},
                },
                {
                    "stepId": "plan-3",
                    "domain": "meal_plan",
                    "operation": {"operations": [{"action": "update"}]},
                },
            ]
        },
        business_entity={
            "steps": [
                {
                    "stepId": "ingredient-1",
                    "domain": "ingredient",
                    "payload": {"id": "ingredient-1", "name": "番茄"},
                },
                {
                    "stepId": "plan-1",
                    "domain": "meal_plan",
                    "payload": {
                        "operations": [{"action": "create", "item": {"id": "plan-1"}}]
                    },
                },
                {
                    "stepId": "plan-2",
                    "domain": "meal_plan",
                    "payload": {
                        "operations": [{"action": "create", "item": {"id": "plan-2"}}]
                    },
                },
                {
                    "stepId": "plan-3",
                    "domain": "meal_plan",
                    "payload": {
                        "operations": [{"action": "update", "item": {"id": "plan-3"}}]
                    },
                },
            ]
        },
    )
    assert result == ActivityHighlight(
        kind=ActivityHighlightKind.MEAL_PLAN,
        summary="完成 3 组菜单安排",
    )


class AICompositeOperationsTestCase(AIAgentInfraTestCase):
        def test_composite_proposal_captures_nested_inventory_concurrency_boundaries(self) -> None:
            from app.services.ai_operations.drafts import normalize_ai_draft_payload

            with self.SessionLocal() as db:
                proposal = normalize_ai_draft_payload(
                    db,
                    draft_type="composite_operation",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-composite-inventory-boundary",
                    payload={
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "consume-tomato",
                                "domain": "inventory",
                                "operation": {
                                    "operations": [
                                        {
                                            "action": "consume",
                                            "ingredientId": "ingredient-tomato",
                                            "quantity": 1,
                                            "unit": "个",
                                        }
                                    ]
                                },
                            }
                        ],
                    },
                )

            operation = proposal["steps"][0]["operation"]["operations"][0]
            self.assertEqual(operation["expectedIngredientRowVersion"], 1)
            self.assertEqual(operation["batchOptions"][0]["id"], "inventory-tomato")
            self.assertEqual(operation["batchOptions"][0]["rowVersion"], 1)

        def test_composite_approval_rejects_inventory_changed_after_proposal(self) -> None:
            from app.ai.errors import AIConflictError
            from app.services.ai_operations.common import assert_updated_at_matches
            from app.services.ai_operations.drafts import normalize_ai_draft_payload
            from app.services.ai_operations.executor import execute_ai_operation_draft

            with self.SessionLocal() as db:
                proposal = normalize_ai_draft_payload(
                    db,
                    draft_type="composite_operation",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-composite-stale-inventory",
                    payload={
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "consume-tomato",
                                "domain": "inventory",
                                "operation": {
                                    "operations": [
                                        {
                                            "action": "consume",
                                            "ingredientId": "ingredient-tomato",
                                            "quantity": 1,
                                            "unit": "个",
                                        }
                                    ]
                                },
                            }
                        ],
                    },
                )

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.notes = "家人在复合草稿确认前更新了批次"
                db.commit()

            with self.SessionLocal() as db:
                submitted = normalize_ai_draft_payload(
                    db,
                    draft_type="composite_operation",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-composite-stale-inventory",
                    payload=proposal,
                    phase="approval",
                )
                with self.assertRaises(AIConflictError):
                    execute_ai_operation_draft(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        draft_type="composite_operation",
                        payload=submitted,
                        assert_updated_at_matches=assert_updated_at_matches,
                        operation_idempotency_key="test:composite.apply:v1",
                    )
                db.rollback()

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.consumed_quantity, Decimal("0"))

        def test_composite_inventory_keeps_proposal_boundary_when_only_notes_reference_a_dependency(self) -> None:
            """A non-target dependency reference must not turn a known inventory target into a fresh approval-time read."""
            from app.ai.errors import AIConflictError
            from app.services.ai_operations.common import assert_updated_at_matches
            from app.services.ai_operations.drafts import normalize_ai_draft_payload
            from app.services.ai_operations.executor import execute_ai_operation_draft

            with self.SessionLocal() as db:
                proposal = normalize_ai_draft_payload(
                    db,
                    draft_type="composite_operation",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-composite-dependency-note-boundary",
                    payload={
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "create-context-ingredient",
                                "domain": "ingredient",
                                "operation": {
                                    "action": "create",
                                    "payload": {
                                        "name": "复合备注食材",
                                        "category": "测试",
                                        "default_unit": "个",
                                        "unit_conversions": [],
                                        "default_storage": "冷藏",
                                        "default_expiry_mode": "none",
                                        "default_expiry_days": None,
                                        "default_low_stock_threshold": None,
                                        "notes": "",
                                        "media_ids": [],
                                    },
                                },
                            },
                            {
                                "stepId": "consume-existing-tomato",
                                "domain": "inventory",
                                "dependsOn": ["create-context-ingredient"],
                                "operation": {
                                    "operations": [
                                        {
                                            "action": "consume",
                                            "ingredientId": "ingredient-tomato",
                                            "quantity": 1,
                                            "unit": "个",
                                            "notes": "$create-context-ingredient.entityId",
                                        }
                                    ]
                                },
                            },
                        ],
                    },
                )

            boundary = proposal["steps"][1]["operation"]["operations"][0]
            self.assertEqual(boundary["expectedIngredientRowVersion"], 1)
            self.assertEqual(boundary["batchOptions"][0]["rowVersion"], 1)

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.notes = "家人在确认前修改了库存批次"
                db.commit()

            with self.SessionLocal() as db:
                submitted = normalize_ai_draft_payload(
                    db,
                    draft_type="composite_operation",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-composite-dependency-note-boundary",
                    payload=proposal,
                    phase="approval",
                )
                try:
                    with self.assertRaises(AIConflictError):
                        execute_ai_operation_draft(
                            db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            draft_type="composite_operation",
                            payload=submitted,
                            assert_updated_at_matches=assert_updated_at_matches,
                            operation_idempotency_key="test:composite.apply:v1",
                        )
                finally:
                    db.rollback()

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.consumed_quantity, Decimal("0"))

        def test_composite_proposal_normalizes_nested_recipe_cook_inventory_snapshot(self) -> None:
            from app.services.ai_operations.drafts import normalize_ai_draft_payload

            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-composite-cook-boundary",
                    family_id=self.family.id,
                    title="复合番茄快炒",
                    servings=1,
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
                        id="recipe-composite-cook-boundary-ingredient",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=1,
                        unit="个",
                        note="切块",
                        sort_order=0,
                    )
                )
                db.commit()

                proposal = normalize_ai_draft_payload(
                    db,
                    draft_type="composite_operation",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-composite-recipe-cook-boundary",
                    payload={
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "cook-recipe",
                                "domain": "recipe_cook",
                                "operation": {
                                    "schemaVersion": "recipe_cook_operation.v2",
                                    "recipeId": recipe.id,
                                    "servings": 1,
                                    "date": date.today().isoformat(),
                                    "mealType": "dinner",
                                },
                            }
                        ],
                    },
                )

            operation = proposal["steps"][0]["operation"]
            self.assertEqual(operation["inventoryBoundaries"][0]["ingredientId"], "ingredient-tomato")
            self.assertEqual(
                operation["inventoryBoundaries"][0]["batches"],
                [{"inventoryItemId": "inventory-tomato", "expectedRowVersion": 1}],
            )

        def test_composite_operation_protocol_validator_accepts_acyclic_steps(self) -> None:
            payload = {
                "draftType": "composite_operation",
                "schemaVersion": "composite_operation.v1",
                "steps": [
                    {
                        "stepId": "create-ingredient",
                        "domain": "ingredient",
                        "operation": {"action": "create", "payload": {"name": "鸡胸肉"}},
                    },
                    {
                        "stepId": "consume",
                        "domain": "inventory",
                        "dependsOn": ["create-ingredient"],
                        "operation": {"action": "consume", "ingredientRef": "$create-ingredient.entityId"},
                    },
                ],
            }

            normalized = validate_composite_operation_plan(payload)

            self.assertEqual(normalized["schemaVersion"], "composite_operation.v1")
            self.assertEqual([step["stepId"] for step in normalized["steps"]], ["create-ingredient", "consume"])
            self.assertEqual(normalized["steps"][1]["dependsOn"], ["create-ingredient"])

        def test_composite_operation_protocol_validator_rejects_invalid_dependencies(self) -> None:
            with self.assertRaisesRegex(ValueError, "依赖了不存在的步骤"):
                validate_composite_operation_plan(
                    {
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "consume",
                                "domain": "inventory",
                                "dependsOn": ["missing"],
                                "operation": {"action": "consume"},
                            }
                        ],
                    }
                )

            with self.assertRaisesRegex(ValueError, "不能有环"):
                validate_composite_operation_plan(
                    {
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {"stepId": "a", "domain": "ingredient", "dependsOn": ["b"], "operation": {}},
                            {"stepId": "b", "domain": "inventory", "dependsOn": ["a"], "operation": {}},
                        ],
                    }
                )

        def test_composite_operation_execution_order_respects_dependencies(self) -> None:
            ordered = composite_execution_order(
                {
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "consume",
                            "domain": "inventory",
                            "dependsOn": ["create-ingredient"],
                            "operation": {"action": "consume"},
                        },
                        {
                            "stepId": "create-ingredient",
                            "domain": "ingredient",
                            "operation": {"action": "create"},
                        },
                    ],
                }
            )

            self.assertEqual([step["stepId"] for step in ordered], ["create-ingredient", "consume"])

        def test_composite_operation_resolves_declared_dependency_references(self) -> None:
            step = {
                "stepId": "consume",
                "domain": "inventory",
                "dependsOn": ["create-ingredient"],
                "operation": {
                    "action": "consume",
                    "ingredientId": "$create-ingredient.entityId",
                    "summary": "$create-ingredient.payload.name",
                },
            }
            resolved = resolve_composite_step_operation(
                step,
                step_results={
                    "create-ingredient": {
                        "entityId": "ingredient-chicken",
                        "payload": {"name": "鸡胸肉"},
                    }
                },
            )

            self.assertEqual(resolved["ingredientId"], "ingredient-chicken")
            self.assertEqual(resolved["summary"], "鸡胸肉")

        def test_composite_operation_rejects_undeclared_dependency_reference(self) -> None:
            with self.assertRaisesRegex(ValueError, "只能引用自己的依赖步骤"):
                resolve_composite_step_operation(
                    {
                        "stepId": "consume",
                        "domain": "inventory",
                        "dependsOn": [],
                        "operation": {"ingredientId": "$create-ingredient.entityId"},
                    },
                    step_results={"create-ingredient": {"entityId": "ingredient-chicken"}},
                )

        def test_composite_operation_step_preview_describes_order_dependencies_and_impact(self) -> None:
            preview = build_composite_operation_step_previews(
                {
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "consume",
                            "domain": "inventory",
                            "dependsOn": ["create-ingredient"],
                            "operation": {
                                "action": "consume",
                                "ingredientId": "$create-ingredient.entityId",
                                "quantity": 500,
                                "unit": "克",
                            },
                        },
                        {
                            "stepId": "create-ingredient",
                            "domain": "ingredient",
                            "operation": {
                                "action": "create",
                                "payload": {
                                    "name": "鸡胸肉",
                                    "category": "肉类",
                                    "default_unit": "克",
                                },
                            },
                        },
                    ],
                }
            )

            self.assertEqual(preview["schemaVersion"], "composite_operation.v1")
            self.assertEqual(preview["stepCount"], 2)
            self.assertEqual([step["stepId"] for step in preview["steps"]], ["create-ingredient", "consume"])
            self.assertEqual(preview["steps"][0]["title"], "新增食材档案 · 鸡胸肉")
            self.assertEqual(preview["steps"][0]["impact"]["creates"], 1)
            consume = preview["steps"][1]
            self.assertEqual(consume["domainLabel"], "库存")
            self.assertEqual(consume["actionLabel"], "消耗")
            self.assertEqual(consume["dependsOn"], ["create-ingredient"])
            self.assertEqual(consume["dependencyRefs"], [{"stepId": "create-ingredient", "path": "entityId", "ref": "$create-ingredient.entityId"}])
            self.assertTrue(consume["impact"]["usesDependencyResult"])
            self.assertEqual(consume["impact"]["operationCount"], 1)

        def test_composite_operation_step_preview_rejects_undeclared_dependency_reference(self) -> None:
            with self.assertRaisesRegex(ValueError, "只能引用自己的依赖步骤"):
                build_composite_operation_step_previews(
                    {
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "consume",
                                "domain": "inventory",
                                "operation": {
                                    "action": "consume",
                                    "ingredientId": "$create-ingredient.entityId",
                                    "quantity": 500,
                                    "unit": "克",
                                },
                            },
                            {
                                "stepId": "create-ingredient",
                                "domain": "ingredient",
                                "operation": {"action": "create", "payload": {"name": "鸡胸肉"}},
                            },
                        ],
                    }
                )

        def test_composite_operation_is_registered_as_approval_contract_but_not_skill_generated(self) -> None:
            skill_registry = build_workspace_skill_registry()
            self.assertIn("composite_operation", draft_operation_registry.keys())
            config = draft_operation_registry.approval_config_for_payload(
                "composite_operation",
                {
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "create-ingredient",
                            "domain": "ingredient",
                            "operation": {"action": "create", "payload": {"name": "鸡胸肉"}},
                        }
                    ],
                },
            )
            self.assertEqual(config["approval_type"], "composite_operation.apply")
            self.assertFalse(
                any("composite_operation" in manifest.draft_types for manifest in skill_registry.list_manifests())
            )

        def test_composite_operation_approval_creates_ingredient_then_inventory_in_one_confirmation(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-composite-approval",
                    family_id=self.family.id,
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
                    mode=AiMode.RECOMMENDATION,
                    prompt="新增鸡胸肉并消耗番茄",
                    response="",
                    context={"workspace": True},
                    title="复合操作",
                    status="active",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-composite-approval",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="请确认复合操作。",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add_all([conversation, message])
                db.flush()
                payload = {
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "create-ingredient",
                            "domain": "ingredient",
                            "operation": {
                                "action": "create",
                                "payload": {
                                    "name": "鸡胸肉",
                                    "category": "肉类",
                                    "default_unit": "克",
                                    "unit_conversions": [],
                                    "default_storage": "冷冻",
                                    "default_expiry_mode": "days",
                                    "default_expiry_days": 90,
                                    "default_low_stock_threshold": 100,
                                    "notes": "适合备餐",
                                    "media_ids": [],
                                },
                            },
                        },
                        {
                            "stepId": "consume-stock",
                            "domain": "inventory",
                            "dependsOn": [],
                            "operation": {
                                "operations": [
                                    {
                                        "action": "dispose",
                                        "ingredientId": "ingredient-tomato",
                                        "inventoryItemId": "inventory-tomato",
                                        "quantity": 1,
                                        "unit": "个",
                                        "reason": "AI 复合操作销毁",
                                    }
                                ]
                            },
                        },
                    ],
                }
                service = AIApplicationService(db, provider=FakeChatProvider())
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "composite_operation",
                        "schema_version": "composite_operation.v1",
                        "payload": payload,
                    },
                )
                self.assertEqual(approval.approval_type, "composite_operation.apply")
                self.assertIn("stepPreviews", draft.payload)

                decision = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values={"draft": draft.payload},
                )

                self.assertEqual(decision["operation"]["status"], "succeeded")
                self.assertEqual(decision["draft"]["status"], "confirmed")
                self.assertEqual(decision["business_entity"]["schemaVersion"], "composite_operation.v1")
                ingredient_id = decision["business_entity"]["stepResults"]["create-ingredient"]["entityId"]
                inventory_ids = decision["business_entity"]["stepResults"]["consume-stock"]["entityIds"]
                ingredient = db.get(Ingredient, ingredient_id)
                inventory_item = db.get(InventoryItem, inventory_ids[0])
                self.assertIsNotNone(ingredient)
                self.assertIsNotNone(inventory_item)
                self.assertEqual(ingredient.name, "鸡胸肉")
                self.assertEqual(inventory_item.id, "inventory-tomato")
                refreshed = db.get(AIMessage, message.id)
                self.assertTrue(
                    any(
                        part.get("type") == "result_card"
                        and part.get("card", {}).get("type") == "operation_result"
                        for part in (refreshed.parts or [])
                    )
                )

        def test_composite_operation_approval_can_chain_food_creation_into_meal_plan(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-composite-food-plan",
                    family_id=self.family.id,
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
                    mode=AiMode.RECOMMENDATION,
                    prompt="创建食物并安排晚餐",
                    response="",
                    context={"workspace": True},
                    title="复合食物计划",
                    status="active",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-composite-food-plan",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="请确认复合操作。",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add_all([conversation, message])
                db.flush()
                payload = {
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "create-food",
                            "domain": "food",
                            "operation": {
                                "action": "create",
                                "payload": {
                                    "name": "青椒炒肉",
                                    "type": "selfMade",
                                    "category": "家常菜",
                                    "flavor_tags": ["咸鲜"],
                                    "scene_tags": ["晚餐"],
                                    "suitable_meal_types": ["dinner"],
                                    "source_name": "AI 整理",
                                    "purchase_source": "",
                                    "scene": "晚餐",
                                    "notes": "适合工作日晚餐",
                                    "routine_note": "",
                                    "media_ids": [],
                                },
                            },
                        },
                        {
                            "stepId": "plan-dinner",
                            "domain": "meal_plan",
                            "dependsOn": ["create-food"],
                            "operation": {
                                "schemaVersion": "meal_plan_operation.v1",
                                "operations": [
                                    {
                                        "action": "create",
                                        "payload": {
                                            "date": date.today().isoformat(),
                                            "mealType": "dinner",
                                            "foodId": "$create-food.entityId",
                                            "recipeId": None,
                                            "reason": "复合操作安排晚餐",
                                        },
                                    }
                                ],
                            },
                        },
                    ],
                }
                service = AIApplicationService(db, provider=FakeChatProvider())
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "composite_operation",
                        "schema_version": "composite_operation.v1",
                        "payload": payload,
                    },
                )

                decision = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval.id,
                    decision="approved",
                    draft_version=draft.version,
                    values={"draft": draft.payload},
                )

                food_id = decision["business_entity"]["stepResults"]["create-food"]["entityId"]
                plan_ids = decision["business_entity"]["stepResults"]["plan-dinner"]["entityIds"]
                food = db.get(Food, food_id)
                plan_item = db.get(FoodPlanItem, plan_ids[0])
                self.assertIsNotNone(food)
                self.assertIsNotNone(plan_item)
                self.assertEqual(food.name, "青椒炒肉")
                self.assertEqual(plan_item.food_id, food_id)
                self.assertEqual(decision["business_entity"]["stepResults"]["plan-dinner"]["payload"]["operations"][0]["item"]["food_id"], food_id)

        def test_composite_executor_creates_ingredient_then_restock_inventory(self) -> None:
            with self.SessionLocal() as db:
                with self.assertRaisesRegex(ValueError, "入库请使用 inventory_intake"):
                    execute_composite_operation_plan(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        payload={
                            "draftType": "composite_operation",
                            "schemaVersion": "composite_operation.v1",
                            "steps": [
                                {
                                    "stepId": "create-ingredient",
                                    "domain": "ingredient",
                                    "operation": {
                                        "action": "create",
                                        "payload": {
                                            "name": "鸡胸肉",
                                            "category": "肉类",
                                            "default_unit": "克",
                                            "unit_conversions": [],
                                            "default_storage": "冷冻",
                                            "default_expiry_mode": "days",
                                            "default_expiry_days": 90,
                                            "default_low_stock_threshold": 100,
                                            "notes": "适合备餐",
                                            "media_ids": [],
                                        },
                                    },
                                },
                                {
                                    "stepId": "restock",
                                    "domain": "inventory",
                                    "dependsOn": ["create-ingredient"],
                                    "operation": {
                                        "action": "restock",
                                        "ingredientId": "$create-ingredient.entityId",
                                        "quantity": 500,
                                        "unit": "克",
                                    },
                                },
                            ],
                        },
                    )

        def test_composite_executor_rolls_back_completed_steps_when_later_step_fails(self) -> None:
            with self.SessionLocal() as db:
                with self.assertRaisesRegex(ValueError, "库存操作数量必须大于 0|库存操作草稿"):
                    with db.begin_nested():
                        execute_composite_operation_plan(
                            db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            payload={
                                "draftType": "composite_operation",
                                "schemaVersion": "composite_operation.v1",
                                "steps": [
                                    {
                                        "stepId": "create-ingredient",
                                        "domain": "ingredient",
                                        "operation": {
                                            "action": "create",
                                            "payload": {
                                                "name": "失败回滚食材",
                                                "category": "测试",
                                                "default_unit": "克",
                                                "unit_conversions": [],
                                                "default_storage": "冷藏",
                                                "default_expiry_mode": "none",
                                                "default_expiry_days": None,
                                                "default_low_stock_threshold": None,
                                                "notes": "",
                                                "media_ids": [],
                                            },
                                        },
                                    },
                                    {
                                        "stepId": "consume-stock",
                                        "domain": "inventory",
                                        "dependsOn": ["create-ingredient"],
                                        "operation": {
                                            "action": "consume",
                                            "ingredientId": "$create-ingredient.entityId",
                                            "quantity": 0,
                                            "unit": "克",
                                        },
                                    },
                                ],
                            },
                        )

                rolled_back = db.scalar(
                    select(Ingredient).where(
                        Ingredient.family_id == self.family.id,
                        Ingredient.name == "失败回滚食材",
                    )
                )
                self.assertIsNone(rolled_back)

        def test_composite_mid_step_fault_rolls_back_business_and_highlight(self) -> None:
            ingredient_name = "高亮原子性复合故障鸡胸肉"
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-composite-highlight-fault",
                    family_id=self.family.id,
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
                    mode=AiMode.RECOMMENDATION,
                    prompt="新增鸡胸肉并入库",
                    response="",
                    context={"workspace": True},
                    title="复合操作高亮故障",
                    status="active",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-composite-highlight-fault",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="请确认复合操作。",
                    parts=[],
                    created_by=self.user.id,
                )
                db.add_all([conversation, message])
                db.flush()
                payload = {
                    "draftType": "composite_operation",
                    "schemaVersion": "composite_operation.v1",
                    "steps": [
                        {
                            "stepId": "create-ingredient",
                            "domain": "ingredient",
                            "operation": {
                                "action": "create",
                                "payload": {
                                    "name": ingredient_name,
                                    "category": "肉类",
                                    "default_unit": "克",
                                    "unit_conversions": [],
                                    "default_storage": "冷冻",
                                    "default_expiry_mode": "days",
                                    "default_expiry_days": 90,
                                    "default_low_stock_threshold": 100,
                                    "notes": "适合备餐",
                                    "media_ids": [],
                                },
                            },
                        },
                        {
                            "stepId": "consume-stock",
                            "domain": "inventory",
                            "dependsOn": ["create-ingredient"],
                            "operation": {
                                "action": "consume",
                                "ingredientId": "$create-ingredient.entityId",
                                "quantity": 500,
                                "unit": "克",
                            },
                        },
                    ],
                }
                service = AIApplicationService(db, provider=FakeChatProvider())
                draft, approval = service._create_draft_approval(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message_id=message.id,
                    run_id=None,
                    draft_payload={
                        "draft_type": "composite_operation",
                        "schema_version": "composite_operation.v1",
                        "payload": payload,
                    },
                )
                with patch(
                    "app.services.ai_operations.composite._execute_inventory_step",
                    side_effect=RuntimeError("composite mid-step fault"),
                ):
                    decision = service._apply_approval_decision(
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id=conversation.id,
                        approval_id=approval.id,
                        decision="approved",
                        draft_version=draft.version,
                        values={"draft": draft.payload},
                    )
                self.assertEqual(decision["operation"]["status"], "failed")
                self.assertEqual(decision["draft"]["status"], "pending_retry")
                db.commit()

            with self.SessionLocal() as db:
                ingredient = db.scalar(
                    select(Ingredient).where(
                        Ingredient.family_id == self.family.id,
                        Ingredient.name == ingredient_name,
                    )
                )
                self.assertIsNone(ingredient)
                highlight_count = db.scalar(
                    select(func.count(ActivityLog.id)).where(
                        ActivityLog.family_id == self.family.id,
                        ActivityLog.highlight_kind.is_not(None),
                    )
                )
                self.assertEqual(highlight_count, 0)
