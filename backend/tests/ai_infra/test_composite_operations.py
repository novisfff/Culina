from ._support import *


class AICompositeOperationsTestCase(AIAgentInfraTestCase):
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
                        "stepId": "restock",
                        "domain": "inventory",
                        "dependsOn": ["create-ingredient"],
                        "operation": {"action": "restock", "ingredientRef": "$create-ingredient.entityId"},
                    },
                ],
            }

            normalized = validate_composite_operation_plan(payload)

            self.assertEqual(normalized["schemaVersion"], "composite_operation.v1")
            self.assertEqual([step["stepId"] for step in normalized["steps"]], ["create-ingredient", "restock"])
            self.assertEqual(normalized["steps"][1]["dependsOn"], ["create-ingredient"])

        def test_composite_operation_protocol_validator_rejects_invalid_dependencies(self) -> None:
            with self.assertRaisesRegex(ValueError, "依赖了不存在的步骤"):
                validate_composite_operation_plan(
                    {
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "restock",
                                "domain": "inventory",
                                "dependsOn": ["missing"],
                                "operation": {"action": "restock"},
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
                            "stepId": "restock",
                            "domain": "inventory",
                            "dependsOn": ["create-ingredient"],
                            "operation": {"action": "restock"},
                        },
                        {
                            "stepId": "create-ingredient",
                            "domain": "ingredient",
                            "operation": {"action": "create"},
                        },
                    ],
                }
            )

            self.assertEqual([step["stepId"] for step in ordered], ["create-ingredient", "restock"])

        def test_composite_operation_resolves_declared_dependency_references(self) -> None:
            step = {
                "stepId": "restock",
                "domain": "inventory",
                "dependsOn": ["create-ingredient"],
                "operation": {
                    "action": "restock",
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
                        "stepId": "restock",
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
                            "stepId": "restock",
                            "domain": "inventory",
                            "dependsOn": ["create-ingredient"],
                            "operation": {
                                "action": "restock",
                                "ingredientId": "$create-ingredient.entityId",
                                "quantity": 500,
                                "unit": "克",
                                "storageLocation": "冷冻",
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
            self.assertEqual([step["stepId"] for step in preview["steps"]], ["create-ingredient", "restock"])
            self.assertEqual(preview["steps"][0]["title"], "新增食材档案 · 鸡胸肉")
            self.assertEqual(preview["steps"][0]["impact"]["creates"], 1)
            restock = preview["steps"][1]
            self.assertEqual(restock["domainLabel"], "库存")
            self.assertEqual(restock["actionLabel"], "入库")
            self.assertEqual(restock["dependsOn"], ["create-ingredient"])
            self.assertEqual(restock["dependencyRefs"], [{"stepId": "create-ingredient", "path": "entityId", "ref": "$create-ingredient.entityId"}])
            self.assertTrue(restock["impact"]["usesDependencyResult"])
            self.assertEqual(restock["impact"]["operationCount"], 1)

        def test_composite_operation_step_preview_rejects_undeclared_dependency_reference(self) -> None:
            with self.assertRaisesRegex(ValueError, "只能引用自己的依赖步骤"):
                build_composite_operation_step_previews(
                    {
                        "draftType": "composite_operation",
                        "schemaVersion": "composite_operation.v1",
                        "steps": [
                            {
                                "stepId": "restock",
                                "domain": "inventory",
                                "operation": {
                                    "action": "restock",
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
                    mode=AiMode.RECOMMENDATION,
                    prompt="新增鸡胸肉并入库",
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
                            "stepId": "restock",
                            "domain": "inventory",
                            "dependsOn": ["create-ingredient"],
                            "operation": {
                                "action": "restock",
                                "ingredientId": "$create-ingredient.entityId",
                                "quantity": 500,
                                "unit": "克",
                                "purchaseDate": date.today().isoformat(),
                                "expiryDate": (date.today() + timedelta(days=30)).isoformat(),
                                "storageLocation": "冷冻",
                                "status": "frozen",
                                "notes": "AI 复合操作入库",
                                "lowStockThreshold": 100,
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
                inventory_ids = decision["business_entity"]["stepResults"]["restock"]["entityIds"]
                ingredient = db.get(Ingredient, ingredient_id)
                inventory_item = db.get(InventoryItem, inventory_ids[0])
                self.assertIsNotNone(ingredient)
                self.assertIsNotNone(inventory_item)
                self.assertEqual(ingredient.name, "鸡胸肉")
                self.assertEqual(inventory_item.ingredient_id, ingredient_id)
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
                result = execute_composite_operation_plan(
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
                                    "purchaseDate": date.today().isoformat(),
                                    "expiryDate": (date.today() + timedelta(days=30)).isoformat(),
                                    "storageLocation": "冷冻",
                                    "status": "frozen",
                                    "notes": "AI 复合操作入库",
                                    "lowStockThreshold": 100,
                                },
                            },
                        ],
                    },
                )

                ingredient_id = result["stepResults"]["create-ingredient"]["entityId"]
                inventory_ids = result["stepResults"]["restock"]["entityIds"]
                ingredient = db.get(Ingredient, ingredient_id)
                inventory_item = db.get(InventoryItem, inventory_ids[0])

                self.assertIsNotNone(ingredient)
                self.assertIsNotNone(inventory_item)
                self.assertEqual(ingredient.name, "鸡胸肉")
                self.assertEqual(inventory_item.ingredient_id, ingredient_id)
                self.assertEqual(result["steps"][1]["payload"]["operations"][0]["ingredient_id"], ingredient_id)

        def test_composite_executor_rolls_back_completed_steps_when_later_step_fails(self) -> None:
            with self.SessionLocal() as db:
                with self.assertRaisesRegex(ValueError, "库存操作数量必须大于 0|库存操作草稿"):
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
                                    "stepId": "restock",
                                    "domain": "inventory",
                                    "dependsOn": ["create-ingredient"],
                                    "operation": {
                                        "action": "restock",
                                        "ingredientId": "$create-ingredient.entityId",
                                        "quantity": 0,
                                        "unit": "克",
                                        "purchaseDate": date.today().isoformat(),
                                        "storageLocation": "冷藏",
                                        "status": "fresh",
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
