from ._support import *


class ShoppingStockContinuationProvider(BaseChatProvider):
    model_name = "shopping-stock-continuation"

    def __init__(self, *, item_id: str, base_updated_at: str) -> None:
        self.item_id = item_id
        self.base_updated_at = base_updated_at
        self.calls = 0
        self.ready_continuation: dict | None = None
        self.current_artifacts: list[dict] = []

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("workspace orchestrator should use generate_with_tools")

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del system, max_rounds
        payload = json.loads(user)
        self.calls += 1
        if self.calls == 1:
            tool_handler(
                "skill.inject",
                {"skills": ["shopping_list"], "reason": "确认已购项目"},
            )
            available = {tool.name for tool in (tools() if callable(tools) else tools)}
            assert "shopping.create_draft" in available
            draft_result = tool_handler(
                "shopping.create_draft",
                {
                    "draft": {
                        "draftType": "shopping_list",
                        "schemaVersion": "shopping_list_operation.v1",
                        "operations": [
                            {
                                "action": "set_done",
                                "targetId": self.item_id,
                                "baseUpdatedAt": self.base_updated_at,
                                "payload": {"done": True, "reason": "已采购"},
                            }
                        ],
                    }
                },
            )
            assert "draft" in draft_result, draft_result
            return ChatProviderResult(
                text="先确认把番茄标记为已采购。",
                status="waiting_approval",
                model=self.model_name,
            )

        artifacts = payload.get("currentRunArtifacts") or []
        self.current_artifacts = artifacts
        self.ready_continuation = next(
            (
                artifact
                for artifact in reversed(artifacts)
                if isinstance(artifact, dict)
                and artifact.get("type") == "workflow.continuation"
                and artifact.get("status") == "ready"
            ),
            None,
        )
        if self.ready_continuation is None:
            return ChatProviderResult(
                text="未收到入库续接。",
                status="completed",
                model=self.model_name,
            )
        available = {tool.name for tool in (tools() if callable(tools) else tools)}
        assert "inventory.create_operation_draft" in available
        state = self.ready_continuation["payload"]["state"]
        ingredient = tool_handler(
            "ingredient.read_by_id",
            {"id": state["ingredientId"]},
        )["item"]
        tool_handler(
            "inventory.create_operation_draft",
            {
                "draft": {
                    "draftType": "inventory_operation",
                    "schemaVersion": "inventory_operation.v1",
                    "source": {"shoppingItemId": state["shoppingItemId"]},
                    "operations": [
                        {
                            "action": "restock",
                            "ingredientId": ingredient["id"],
                            "ingredientName": ingredient["name"],
                            "quantity": float(state["quantity"]),
                            "unit": state["unit"],
                            "purchaseDate": date.today().isoformat(),
                            "storageLocation": ingredient["default_storage"],
                            "status": "fresh",
                            "reason": "购物完成后入库",
                        }
                    ],
                }
            },
        )
        return ChatProviderResult(
            text="购物项已完成，库存入库仍需单独确认。",
            status="waiting_approval",
            model=self.model_name,
        )


class ShoppingFoodStockContinuationProvider(BaseChatProvider):
    model_name = "shopping-food-stock-continuation"

    def __init__(self, *, item_id: str, base_updated_at: str) -> None:
        self.item_id = item_id
        self.base_updated_at = base_updated_at
        self.calls = 0
        self.ready_continuation: dict | None = None
        self.read_food_id: str | None = None

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("workspace orchestrator should use generate_with_tools")

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del system, max_rounds
        payload = json.loads(user)
        self.calls += 1
        if self.calls == 1:
            tool_handler(
                "skill.inject",
                {"skills": ["shopping_list"], "reason": "确认已购食物"},
            )
            available = {tool.name for tool in (tools() if callable(tools) else tools)}
            assert "shopping.create_draft" in available
            draft_result = tool_handler(
                "shopping.create_draft",
                {
                    "draft": {
                        "draftType": "shopping_list",
                        "schemaVersion": "shopping_list_operation.v1",
                        "operations": [
                            {
                                "action": "set_done",
                                "targetId": self.item_id,
                                "baseUpdatedAt": self.base_updated_at,
                                "payload": {"done": True, "reason": "已采购"},
                            }
                        ],
                    }
                },
            )
            assert "draft" in draft_result, draft_result
            return ChatProviderResult(
                text="先确认把牛奶标记为已采购。",
                status="waiting_approval",
                model=self.model_name,
            )

        artifacts = payload.get("currentRunArtifacts") or []
        self.ready_continuation = next(
            (
                artifact
                for artifact in reversed(artifacts)
                if isinstance(artifact, dict)
                and artifact.get("type") == "workflow.continuation"
                and artifact.get("status") == "ready"
            ),
            None,
        )
        assert self.ready_continuation is not None, artifacts
        available = {tool.name for tool in (tools() if callable(tools) else tools)}
        assert "food_profile.create_draft" in available
        state = self.ready_continuation["payload"]["state"]
        self.read_food_id = state["foodId"]
        food = tool_handler("food.read_by_id", {"id": self.read_food_id})["item"]
        next_quantity = Decimal(str(food["stock_quantity"] or 0)) + Decimal(state["quantity"])
        base_updated_at = food["updated_at"]
        if hasattr(base_updated_at, "isoformat"):
            base_updated_at = base_updated_at.isoformat()
        tool_handler(
            "food_profile.create_draft",
            {
                "draft": {
                    "draftType": "food_profile",
                    "schemaVersion": "food_profile_operation.v1",
                    "action": "update",
                    "targetId": food["id"],
                    "baseUpdatedAt": base_updated_at,
                    "payload": {
                        "name": food["name"],
                        "type": food["type"],
                        "category": food["category"],
                        "flavor_tags": food["flavor_tags"],
                        "scene_tags": food["scene_tags"],
                        "suitable_meal_types": food["suitable_meal_types"],
                        "source_name": food["source_name"],
                        "purchase_source": food["purchase_source"],
                        "scene": food["scene"],
                        "notes": food["notes"],
                        "routine_note": food["routine_note"],
                        "price": food["price"],
                        "rating": food["rating"],
                        "repurchase": food["repurchase"],
                        "expiry_date": food["expiry_date"],
                        "stock_quantity": float(next_quantity),
                        "stock_unit": state["unit"],
                        "storage_location": food["storage_location"],
                        "favorite": food["favorite"],
                        "recipe_id": food["recipe_id"],
                        "media_ids": [],
                    },
                }
            },
        )
        return ChatProviderResult(
            text="购物项已完成，食物库存更新仍需单独确认。",
            status="waiting_approval",
            model=self.model_name,
        )


class AIProductClosedLoopsTestCase(AIAgentInfraTestCase):
    def test_completed_ingredient_item_builds_stock_continuation_from_committed_row(self) -> None:
        from app.ai.workflows.orchestrator.product_continuations import (
            build_shopping_to_stock_continuation,
        )

        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-stock-ingredient",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("2"),
                unit="盒",
                reason="补充库存",
                done=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()

            continuation = build_shopping_to_stock_continuation(
                db,
                family_id=self.family.id,
                shopping_item_id=item.id,
            )

        self.assertEqual(continuation["reasonCode"], "shopping_completed_ingredient")
        self.assertEqual(continuation["resumeSkillKey"], "inventory_analysis")
        self.assertEqual(continuation["requiredDraftType"], "inventory_operation")
        self.assertEqual(continuation["stateSchema"], "shopping_to_stock.v1")
        self.assertEqual(
            continuation["state"],
            {
                "shoppingItemId": item.id,
                "targetType": "ingredient",
                "ingredientId": "ingredient-tomato",
                "foodId": None,
                "quantity": "2",
                "unit": "盒",
                "stockAction": "restock",
            },
        )

    def test_completed_ready_food_item_builds_food_stock_continuation(self) -> None:
        from app.ai.workflows.orchestrator.product_continuations import (
            build_shopping_to_stock_continuation,
        )

        with self.SessionLocal() as db:
            food = Food(
                id="food-ready-milk",
                family_id=self.family.id,
                name="盒装牛奶",
                type=FoodType.READY_MADE,
                category="饮品",
                flavor_tags=[],
                scene="早餐",
                notes="",
                stock_unit="盒",
            )
            item = ShoppingListItem(
                id="shopping-stock-food",
                family_id=self.family.id,
                food_id=food.id,
                title=food.name,
                quantity=Decimal("3"),
                unit="盒",
                reason="早餐",
                done=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([food, item])
            db.flush()

            continuation = build_shopping_to_stock_continuation(
                db,
                family_id=self.family.id,
                shopping_item_id=item.id,
            )

        self.assertEqual(continuation["reasonCode"], "shopping_completed_food")
        self.assertEqual(continuation["resumeSkillKey"], "food_profile")
        self.assertEqual(continuation["requiredDraftType"], "food_profile")
        self.assertEqual(continuation["state"]["foodId"], food.id)
        self.assertIsNone(continuation["state"]["ingredientId"])

    def test_shopping_to_stock_builder_rejects_uncompleted_or_cross_family_rows(self) -> None:
        from app.ai.workflows.orchestrator.product_continuations import (
            ContinuationBuildError,
            build_shopping_to_stock_continuation,
        )

        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-not-done",
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

            with self.assertRaisesRegex(ContinuationBuildError, "shopping_item_not_completed"):
                build_shopping_to_stock_continuation(
                    db,
                    family_id=self.family.id,
                    shopping_item_id=item.id,
                )
            with self.assertRaisesRegex(ContinuationBuildError, "shopping_item_not_completed"):
                build_shopping_to_stock_continuation(
                    db,
                    family_id=self.other_family.id,
                    shopping_item_id=item.id,
                )

    def test_product_continuation_uses_only_one_successful_set_done_operation(self) -> None:
        from app.ai.workflows.orchestrator.product_continuations import (
            build_shopping_to_stock_continuation_from_decision,
        )

        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-approved-done",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("2"),
                unit="盒",
                reason="",
                done=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            approved = {
                "approval": {"id": "approval-shopping-stock", "decision": "approved"},
                "draft": {
                    "draft_type": "shopping_list",
                    "payload": {
                        "operations": [
                            {
                                "action": "set_done",
                                "targetId": item.id,
                                "payload": {"done": True},
                            }
                        ]
                    },
                },
                "operation": {
                    "status": "succeeded",
                    "business_entity_ids": [item.id],
                },
            }

            continuation = build_shopping_to_stock_continuation_from_decision(
                db,
                family_id=self.family.id,
                decision_result=approved,
            )

            self.assertEqual(continuation["state"]["shoppingItemId"], item.id)
            for operation in [
                {"action": "set_done", "targetId": item.id, "payload": {"done": False}},
                {"action": "update", "targetId": item.id, "payload": {}},
                {"action": "delete", "targetId": item.id},
            ]:
                decision = {
                    **approved,
                    "draft": {
                        "draft_type": "shopping_list",
                        "payload": {"operations": [operation]},
                    },
                }
                self.assertIsNone(
                    build_shopping_to_stock_continuation_from_decision(
                        db,
                        family_id=self.family.id,
                        decision_result=decision,
                    )
                )

            rejected = {
                **approved,
                "approval": {"id": "approval-shopping-stock", "decision": "rejected"},
            }
            failed = {
                **approved,
                "operation": {"status": "failed", "business_entity_ids": [item.id]},
            }
            multiple = {
                **approved,
                "draft": {
                    "draft_type": "shopping_list",
                    "payload": {
                        "operations": [
                            {
                                "action": "set_done",
                                "targetId": item.id,
                                "payload": {"done": True},
                            },
                            {
                                "action": "set_done",
                                "targetId": "shopping-other-done",
                                "payload": {"done": True},
                            },
                        ]
                    },
                },
                "operation": {
                    "status": "succeeded",
                    "business_entity_ids": [item.id, "shopping-other-done"],
                },
            }
            for decision in [rejected, failed, multiple]:
                self.assertIsNone(
                    build_shopping_to_stock_continuation_from_decision(
                        db,
                        family_id=self.family.id,
                        decision_result=decision,
                    )
                )

    def test_invalid_completed_target_does_not_fail_committed_approval_resume(self) -> None:
        from app.ai.workflows.orchestrator.product_continuations import (
            build_shopping_to_stock_continuation_from_decision,
        )

        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-completed-without-target",
                family_id=self.family.id,
                title="旧购物项",
                quantity=Decimal("1"),
                unit="份",
                reason="",
                done=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            decision = {
                "approval": {"id": "approval-invalid-stock", "decision": "approved"},
                "draft": {
                    "draft_type": "shopping_list",
                    "payload": {
                        "operations": [
                            {
                                "action": "set_done",
                                "targetId": item.id,
                                "payload": {"done": True},
                            }
                        ]
                    },
                },
                "operation": {
                    "status": "succeeded",
                    "business_entity_ids": [item.id],
                },
            }

            self.assertIsNone(
                build_shopping_to_stock_continuation_from_decision(
                    db,
                    family_id=self.family.id,
                    decision_result=decision,
                )
            )

    def test_approval_handler_normalizes_committed_shopping_continuation(self) -> None:
        from app.ai.workflows.orchestrator.profiles import (
            MAIN_WORKSPACE_PROFILE,
            OrchestratorBudgetConfig,
        )

        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-handler-done",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("2"),
                unit="盒",
                reason="",
                done=True,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.flush()
            runner = WorkspaceGraphRunner(
                AIApplicationService(db, provider=FakeChatProvider())
            )
            state = {
                "run_id": "run-shopping-stock",
                "family_id": self.family.id,
                "orchestrator_profile": {
                    "capabilityPolicy": MAIN_WORKSPACE_PROFILE.capability_policy.to_state(),
                    "budgetConfig": OrchestratorBudgetConfig().to_state(),
                },
                "injected_skill_keys": ["shopping_list"],
                "injection_history": [],
            }
            decision = {
                "approval": {"id": "approval-handler-stock", "decision": "approved"},
                "draft": {
                    "draft_type": "shopping_list",
                    "payload": {
                        "operations": [
                            {
                                "action": "set_done",
                                "targetId": item.id,
                                "payload": {"done": True},
                            }
                        ]
                    },
                },
                "operation": {
                    "status": "succeeded",
                    "business_entity_ids": [item.id],
                },
            }

            artifact = runner.approval_resume_handler._consume_resume_artifact(
                state=state,
                serialized=decision,
            )

        self.assertEqual(artifact["type"], "workflow.continuation")
        self.assertEqual(artifact["status"], "ready")
        self.assertEqual(artifact["payload"]["resumeSkillKey"], "inventory_analysis")
        self.assertEqual(artifact["payload"]["businessEntityIds"], [item.id])

    def test_completed_shopping_item_resumes_separate_stock_approval(self) -> None:
        with self.SessionLocal() as db:
            item = ShoppingListItem(
                id="shopping-e2e-stock",
                family_id=self.family.id,
                ingredient_id="ingredient-tomato",
                title="番茄",
                quantity=Decimal("2"),
                unit="个",
                reason="晚餐",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(item)
            db.commit()
            provider = ShoppingStockContinuationProvider(
                item_id=item.id,
                base_updated_at=item.updated_at.isoformat(),
            )

        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "番茄买到了，标记完成后准备入库"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            first_approval = data["included"]["approvals"][0]
            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{first_approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": first_approval["draft_version"],
                    "values": first_approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                "".join(stream_response.iter_text())

        self.assertEqual(provider.calls, 2)
        self.assertIsNotNone(provider.ready_continuation, provider.current_artifacts)
        assert provider.ready_continuation is not None
        self.assertEqual(
            provider.ready_continuation["payload"]["state"]["shoppingItemId"],
            item.id,
        )
        with self.SessionLocal() as db:
            db_item = db.get(ShoppingListItem, item.id)
            assert db_item is not None
            self.assertTrue(db_item.done)
            inventory = db.get(InventoryItem, "inventory-tomato")
            assert inventory is not None
            self.assertEqual(inventory.quantity, Decimal("3"))
            drafts = list(
                db.scalars(
                    select(AITaskDraft).where(
                        AITaskDraft.source_run_id == data["run"]["id"],
                        AITaskDraft.draft_type == "inventory_operation",
                    )
                )
            )
            self.assertEqual(len(drafts), 1)
            approvals = list(
                db.scalars(
                    select(AIApprovalRequest).where(
                        AIApprovalRequest.conversation_id == data["conversation_id"],
                        AIApprovalRequest.status == "pending",
                    )
                )
            )
            self.assertEqual(len(approvals), 1)
            self.assertEqual(approvals[0].approval_type, "inventory.operation")

    def test_completed_food_item_resumes_separate_food_stock_approval(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-shopping-e2e-milk",
                family_id=self.family.id,
                name="盒装牛奶",
                type=FoodType.READY_MADE,
                category="饮品",
                flavor_tags=[],
                scene_tags=["早餐"],
                suitable_meal_types=["breakfast"],
                scene="早餐",
                notes="",
                routine_note="",
                stock_quantity=Decimal("1"),
                stock_unit="盒",
                storage_location="冷藏",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            item = ShoppingListItem(
                id="shopping-e2e-food-stock",
                family_id=self.family.id,
                food_id=food.id,
                title=food.name,
                quantity=Decimal("3"),
                unit="盒",
                reason="早餐",
                done=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([food, item])
            db.commit()
            provider = ShoppingFoodStockContinuationProvider(
                item_id=item.id,
                base_updated_at=item.updated_at.isoformat(),
            )

        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "牛奶买到了，标记完成后准备入库"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            first_approval = data["included"]["approvals"][0]
            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{data['conversation_id']}/approvals/{first_approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": first_approval["draft_version"],
                    "values": first_approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                "".join(stream_response.iter_text())

        self.assertEqual(provider.calls, 2)
        self.assertIsNotNone(provider.ready_continuation)
        assert provider.ready_continuation is not None
        self.assertEqual(provider.read_food_id, food.id)
        self.assertEqual(
            provider.ready_continuation["payload"]["state"]["shoppingItemId"],
            item.id,
        )
        with self.SessionLocal() as db:
            db_item = db.get(ShoppingListItem, item.id)
            assert db_item is not None
            self.assertTrue(db_item.done)
            db_food = db.get(Food, food.id)
            assert db_food is not None
            self.assertEqual(db_food.stock_quantity, Decimal("1"))
            drafts = list(
                db.scalars(
                    select(AITaskDraft).where(
                        AITaskDraft.source_run_id == data["run"]["id"],
                        AITaskDraft.draft_type == "food_profile",
                    )
                )
            )
            self.assertEqual(len(drafts), 1)
            self.assertEqual(drafts[0].payload["payload"]["stock_quantity"], 4.0)
            approvals = list(
                db.scalars(
                    select(AIApprovalRequest).where(
                        AIApprovalRequest.conversation_id == data["conversation_id"],
                        AIApprovalRequest.status == "pending",
                    )
                )
            )
            self.assertEqual(len(approvals), 1)
            self.assertEqual(approvals[0].approval_type, "food.update")
