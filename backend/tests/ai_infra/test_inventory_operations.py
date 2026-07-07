from ._support import *
from app.services.inventory_operations import consume_ingredient_inventory, create_inventory_batch


class AIInventoryOperationsTestCase(AIAgentInfraTestCase):
        def test_ingredient_tools_expose_quantity_tracking_mode(self) -> None:
            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-salt",
                    family_id=self.family.id,
                    name="盐",
                    category="调料",
                    default_unit="g",
                    unit_conversions=[],
                    quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                    default_storage="常温",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(ingredient)
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-seasoning-tools",
                        run_id="run-seasoning-tools",
                    ),
                )
                search = executor.call("ingredient.search", {"query": "盐", "exact": True})
                detail = executor.call("ingredient.read_by_id", {"id": ingredient.id})

            self.assertEqual(search["items"][0]["quantityTrackingMode"], "not_track_quantity")
            self.assertEqual(detail["item"]["quantityTrackingMode"], "not_track_quantity")

        def test_inventory_draft_allows_presence_restock_without_quantity(self) -> None:
            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-vinegar",
                    family_id=self.family.id,
                    name="醋",
                    category="调料",
                    default_unit="瓶",
                    unit_conversions=[],
                    quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                    default_storage="常温",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(ingredient)
                db.flush()
                normalized = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "draftType": "inventory_operation",
                        "schemaVersion": "inventory_operation.v1",
                        "operations": [
                            {
                                "action": "restock",
                                "ingredientId": ingredient.id,
                                "storageLocation": "常温",
                            }
                        ],
                    },
                )

            operation = normalized["operations"][0]
            self.assertEqual(operation["ingredientName"], "醋")
            self.assertEqual(operation["quantity"], None)
            self.assertEqual(operation["unit"], "瓶")
            self.assertEqual(operation["lowStockThreshold"], None)

        def test_presence_inventory_operations_skip_quantity_deduction_and_dispose_whole_batch(self) -> None:
            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-soy-sauce",
                    family_id=self.family.id,
                    name="酱油",
                    category="调料",
                    default_unit="瓶",
                    unit_conversions=[],
                    quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                    default_storage="常温",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(ingredient)
                db.flush()

                item = create_inventory_batch(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    ingredient=ingredient,
                    quantity=None,
                    unit=None,
                    status=InventoryStatus.FRESH,
                    purchase_date=date.today(),
                    expiry_date=None,
                    storage_location="常温",
                )
                self.assertEqual(item.quantity, Decimal("1"))
                self.assertEqual(item.consumed_quantity, Decimal("0"))

                consume_result = consume_ingredient_inventory(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    ingredient=ingredient,
                    quantity=None,
                    unit=None,
                    today=date.today(),
                )
                self.assertEqual(consume_result["affected_item_ids"], [])
                self.assertEqual(item.consumed_quantity, Decimal("0"))

                with self.assertRaisesRegex(ValueError, "只能整批移除"):
                    dispose_inventory_quantity(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        item=item,
                        quantity=Decimal("0.5"),
                        unit="瓶",
                        reason="测试",
                    )

                dispose_result = dispose_inventory_quantity(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    item=item,
                    quantity=None,
                    unit=None,
                    reason="用完",
                )
                self.assertEqual(dispose_result["remaining_quantity"], 0.0)
                self.assertEqual(item.disposed_quantity, Decimal("1"))

        def test_ingredient_tools_expose_supported_units_for_inventory_flow(self) -> None:
            with self.SessionLocal() as db:
                ingredient = self._add_egg_ingredient(db)
                ingredient.unit_conversions = [{"unit": "打", "ratio_to_default": 12}]
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-ingredient-units",
                        run_id="run-ingredient-units",
                    ),
                )
                search = executor.call("ingredient.search", {"query": "鸡蛋", "exact": True})
                detail = executor.call("ingredient.read_by_id", {"id": ingredient.id})

            self.assertEqual(search["items"][0]["supportedUnits"], ["个", "打"])
            self.assertEqual(search["items"][0]["unitConversions"], [{"unit": "打", "ratio_to_default": 12.0}])
            self.assertEqual(detail["item"]["supportedUnits"], ["个", "打"])
            self.assertEqual(detail["item"]["unitConversions"], [{"unit": "打", "ratio_to_default": 12.0}])

        def test_workspace_unit_mismatch_reply_creates_inventory_approval_without_saving_unit(self) -> None:
            class UnitMismatchProvider(BaseChatProvider):
                model_name = "unit-mismatch-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

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
                    del system, message_handler, max_rounds
                    payload = json.loads(user)
                    tool_handler("skill.inject", {"skills": ["inventory_analysis"], "reason": "需要处理库存单位换算"})
                    tools()
                    human_input_result = next(
                        (
                            item
                            for item in reversed(payload.get("currentRunArtifacts") or [])
                            if isinstance(item, dict) and item.get("type") == "human.input_result"
                        ),
                        None,
                    )
                    if isinstance(human_input_result, dict):
                        request = human_input_result["payload"]["request"]
                        tool_handler(
                            "inventory.create_unit_conversion_operation_draft",
                            {
                                "draft": {
                                    "unitMismatch": request["resumeHint"]["unitMismatch"],
                                    "ratioToDefault": 10,
                                    "sourceMessage": payload.get("currentMessage"),
                                },
                                "unitMismatch": request["resumeHint"]["unitMismatch"],
                                "ratioToDefault": 10,
                                "sourceMessage": payload.get("currentMessage"),
                            },
                        )
                        return ChatProviderResult(
                            text="已按 1 盒 = 10 个整理为本次入库确认项，不会自动保存副单位。",
                            status="completed",
                            model=self.model_name,
                        )

                    search = tool_handler("ingredient.search", {"query": "鸡蛋", "exact": True, "limit": 5})
                    ingredient = search["items"][0]
                    original_draft = {
                        "draftType": "inventory_operation",
                        "schemaVersion": "inventory_operation.v1",
                        "operations": [
                            {
                                "action": "restock",
                                "ingredientId": ingredient["id"],
                                "quantity": 2,
                                "unit": "盒",
                                "storageLocation": "冷藏",
                            }
                        ],
                    }
                    tool_handler(
                        "human.request_input",
                        {
                            "question": "鸡蛋当前主单位是 个，尚未设置 盒。请确认这次 1 盒等于多少 个；确认后只按本次换算继续入库，不会自动保存为副单位。",
                            "inputMode": "text",
                            "options": [],
                            "required": True,
                            "reason": "需要确认本次单位换算比例",
                            "sourceSkills": ["inventory_analysis"],
                            "resumeHint": {
                                "questionType": "unit_conversion",
                                "missingFields": ["单位换算"],
                                "unitMismatch": {
                                    "ingredientId": ingredient["id"],
                                    "ingredientName": ingredient["name"],
                                    "defaultUnit": ingredient["defaultUnit"],
                                    "unsupportedUnit": "盒",
                                    "supportedUnits": ingredient["supportedUnits"],
                                    "originalDraft": original_draft,
                                },
                            },
                        },
                    )
                    return ChatProviderResult(
                        text="需要先确认鸡蛋这次的单位换算。",
                        status="completed",
                        model=self.model_name,
                    )

            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                service = AIApplicationService(db, provider=UnitMismatchProvider())
                first = service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="把今天买的鸡蛋 2 盒录入库存，放冷藏",
                )
                self.assertEqual(first["run"]["status"], "waiting_input")
                self.assertEqual(first["included"]["result_cards"], [])
                request_part = next(part for part in first["message"]["parts"] if part["type"] == "human_input_request")
                request_id = request_part["request"]["id"]
                self.assertEqual(request_part["request"]["resumeHint"]["questionType"], "unit_conversion")
                self.assertEqual(request_part["request"]["resumeHint"]["unitMismatch"]["unsupportedUnit"], "盒")
                conversation = db.get(AIConversation, first["conversation_id"])
                assert conversation is not None

                second = service.respond_human_input(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=first["conversation_id"],
                    request_id=request_id,
                    selected_option_ids=[],
                    text="这次每盒按十枚算",
                )
                self.assertEqual(second["run"]["status"], "waiting_approval")
                approval = second["included"]["approvals"][0]
                self.assertEqual(approval["approval_type"], "inventory.operation")
                draft = approval["initial_values"]["draft"]
                self.assertEqual(draft["operations"][0]["quantity"], 20.0)
                self.assertEqual(draft["operations"][0]["unit"], "个")
                self.assertEqual(draft["operations"][0]["sourceQuantity"], 2.0)
                self.assertEqual(draft["operations"][0]["sourceUnit"], "盒")
                self.assertEqual(draft["operations"][0]["conversionRatioToDefault"], 10.0)
                self.assertIn("来自 2 盒", draft["operations"][0]["conversionNote"])
                task_state = db.get(AIConversation, first["conversation_id"]).context.get("taskState", {})
                self.assertNotIn("pendingHumanInput", task_state)
                self.assertEqual(task_state["lastHumanInputResult"]["text"], "这次每盒按十枚算")

                decision = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=first["conversation_id"],
                    approval_id=approval["id"],
                    decision="approved",
                    draft_version=approval["draft_version"],
                    values=approval["initial_values"],
                )

                self.assertEqual(decision["operation"]["status"], "succeeded")
                ingredient = db.get(Ingredient, "ingredient-egg")
                assert ingredient is not None
                self.assertEqual(ingredient.unit_conversions, [])
                inventory_item = db.scalar(select(InventoryItem).where(InventoryItem.ingredient_id == ingredient.id).order_by(InventoryItem.created_at.desc()))
                self.assertIsNotNone(inventory_item)
                assert inventory_item is not None
                self.assertEqual(inventory_item.quantity, Decimal("20.00"))
                self.assertEqual(inventory_item.unit, "个")
                self.assertEqual(inventory_item.entered_quantity, Decimal("20.00"))
                self.assertEqual(inventory_item.entered_unit, "个")

        def test_workspace_unit_mismatch_explicit_save_creates_ingredient_update_approval(self) -> None:
            class SaveUnitConversionProvider(BaseChatProvider):
                model_name = "save-unit-conversion-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

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
                    del system, user, message_handler, max_rounds
                    tool_handler("skill.inject", {"skills": ["ingredient_profile"], "reason": "需要保存食材副单位"})
                    tools()
                    detail = tool_handler("ingredient.read_by_id", {"id": "ingredient-egg"})["item"]
                    updated_at = detail["updated_at"].isoformat() if hasattr(detail.get("updated_at"), "isoformat") else detail.get("updated_at")
                    tool_handler(
                        "ingredient_profile.create_draft",
                        {
                            "draft": {
                                "draftType": "ingredient_profile",
                                "schemaVersion": "ingredient_profile_operation.v1",
                                "action": "update",
                                "targetId": detail["id"],
                                "baseUpdatedAt": updated_at,
                                "payload": {
                                    "name": detail["name"],
                                    "category": detail["category"],
                                    "default_unit": detail["default_unit"],
                                    "unit_conversions": [{"unit": "盒", "ratio_to_default": 10}],
                                    "default_storage": detail["default_storage"],
                                    "default_expiry_mode": detail["default_expiry_mode"],
                                    "default_expiry_days": detail["default_expiry_days"],
                                    "default_low_stock_threshold": detail["default_low_stock_threshold"],
                                    "notes": detail.get("notes") or "",
                                    "media_ids": [],
                                },
                            }
                        },
                    )
                    return ChatProviderResult(
                        text="已整理保存副单位的食材档案更新确认项。",
                        status="completed",
                        model=self.model_name,
                    )

            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                conversation = AIConversation(
                    id="conversation-unit-mismatch-save",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="保存副单位",
                    response="",
                    context={},
                    title="保存副单位",
                    status="active",
                    created_by=self.user.id,
                )
                db.add(conversation)
                db.commit()
                service = AIApplicationService(db, provider=SaveUnitConversionProvider())
                result = service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message="保存副单位",
                )
                self.assertEqual(result["run"]["status"], "waiting_approval")
                approval = result["included"]["approvals"][0]
                self.assertEqual(approval["approval_type"], "ingredient.update")
                draft = approval["initial_values"]["draft"]
                self.assertEqual(draft["draftType"], "ingredient_profile")
                self.assertIn({"unit": "盒", "ratio_to_default": 10.0}, draft["payload"]["unit_conversions"])

                decision = service._apply_approval_decision(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    approval_id=approval["id"],
                    decision="approved",
                    draft_version=approval["draft_version"],
                    values=approval["initial_values"],
                )
                ingredient = db.get(Ingredient, "ingredient-egg")
                assert ingredient is not None

            self.assertEqual(decision["operation"]["status"], "succeeded")
            self.assertIn({"unit": "盒", "ratio_to_default": 10.0}, ingredient.unit_conversions)

        def test_workspace_unit_mismatch_unparseable_reply_keeps_clarifying(self) -> None:
            class ReaskUnitConversionProvider(BaseChatProvider):
                model_name = "unit-reask-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

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
                    del system, message_handler, max_rounds
                    payload = json.loads(user)
                    tool_handler("skill.inject", {"skills": ["inventory_analysis"], "reason": "需要确认库存单位换算"})
                    tools()
                    human_input_result = next(
                        (
                            item
                            for item in reversed(payload.get("currentRunArtifacts") or [])
                            if isinstance(item, dict) and item.get("type") == "human.input_result"
                        ),
                        None,
                    )
                    if isinstance(human_input_result, dict):
                        request = human_input_result["payload"]["request"]
                        unit_mismatch = request["resumeHint"]["unitMismatch"]
                        question = request["question"]
                    else:
                        search = tool_handler("ingredient.search", {"query": "鸡蛋", "exact": True, "limit": 5})
                        ingredient = search["items"][0]
                        original_draft = {
                            "draftType": "inventory_operation",
                            "schemaVersion": "inventory_operation.v1",
                            "operations": [
                                {
                                    "action": "restock",
                                    "ingredientId": ingredient["id"],
                                    "quantity": 2,
                                    "unit": "盒",
                                    "storageLocation": "冷藏",
                                }
                            ],
                        }
                        unit_mismatch = {
                            "ingredientId": ingredient["id"],
                            "ingredientName": ingredient["name"],
                            "defaultUnit": ingredient["defaultUnit"],
                            "unsupportedUnit": "盒",
                            "supportedUnits": ingredient["supportedUnits"],
                            "originalDraft": original_draft,
                        }
                        question = "鸡蛋当前主单位是 个，尚未设置 盒。请确认这次 1 盒等于多少 个；确认后只按本次换算继续入库，不会自动保存为副单位。"
                    tool_handler(
                        "human.request_input",
                        {
                            "question": question,
                            "inputMode": "text",
                            "options": [],
                            "required": True,
                            "reason": "需要确认本次单位换算比例",
                            "sourceSkills": ["inventory_analysis"],
                            "resumeHint": {
                                "questionType": "unit_conversion",
                                "missingFields": ["单位换算"],
                                "unitMismatch": unit_mismatch,
                            },
                        },
                    )
                    return ChatProviderResult(
                        text="我还需要知道这次 1 盒鸡蛋等于多少个。",
                        status="completed",
                        model=self.model_name,
                    )

            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                service = AIApplicationService(db, provider=ReaskUnitConversionProvider())
                first = service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="把鸡蛋 2 盒入库",
                )
                first_request = next(part for part in first["message"]["parts"] if part["type"] == "human_input_request")
                result = service.respond_human_input(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=first["conversation_id"],
                    request_id=first_request["request"]["id"],
                    selected_option_ids=[],
                    text="差不多吧",
                )

            self.assertEqual(result["run"]["status"], "waiting_input")
            self.assertEqual(result["included"]["result_cards"], [])
            self.assertEqual(result["included"]["drafts"], [])
            active_request = next(
                part
                for part in result["message"]["parts"]
                if part["type"] == "human_input_request" and part.get("status") != "completed"
            )
            self.assertEqual(active_request["request"]["resumeHint"]["unitMismatch"]["unsupportedUnit"], "盒")

        def test_workspace_ignores_old_unit_prompt_state_for_new_topic(self) -> None:
            class TopicChangeProvider(BaseChatProvider):
                model_name = "topic-change-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

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
                    del system, tools, tool_handler, message_handler, max_rounds
                    payload = json.loads(user)
                    assert "pending" + "Clarification" not in payload
                    return ChatProviderResult(
                        text="今晚可以优先安排一道清淡快手菜。",
                        status="completed",
                        model=self.model_name,
                    )

            old_prompt_key = "pending" + "Clarification"
            old_prompt = {
                "clarificationId": "ai-clarification-topic-change",
                "sourceSkill": "inventory_analysis",
                "questionType": "unit_conversion",
                "question": "鸡蛋当前主单位是 个，尚未设置 盒。请确认这次 1 盒等于多少 个；确认后只按本次换算继续入库，不会自动保存为副单位。",
                "payload": {
                    "missingFields": ["单位换算"],
                    "candidates": [],
                    "allowFreeText": True,
                    "unitMismatch": {
                        "type": "inventory_unit_mismatch",
                        "ingredientId": "ingredient-egg",
                        "ingredientName": "鸡蛋",
                        "defaultUnit": "个",
                        "unsupportedUnit": "盒",
                        "supportedUnits": ["个"],
                        "originalDraft": {
                            "draftType": "inventory_operation",
                            "schemaVersion": "inventory_operation.v1",
                            "operations": [
                                {
                                    "action": "restock",
                                    "ingredientId": "ingredient-egg",
                                    "quantity": 2,
                                    "unit": "盒",
                                }
                            ],
                        },
                    },
                },
                "createdAt": utcnow().isoformat(),
            }
            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                conversation = AIConversation(
                    id="conversation-unit-mismatch-topic-change",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="把鸡蛋 2 盒入库",
                    response="",
                    context={"taskState": {old_prompt_key: old_prompt}},
                    title="单位换算",
                    status="active",
                    created_by=self.user.id,
                )
                db.add(conversation)
                db.commit()
                service = AIApplicationService(db, provider=TopicChangeProvider())
                result = service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message="先不管了，今晚吃什么？",
                )
                refreshed = db.get(AIConversation, conversation.id)
                assert refreshed is not None

            self.assertEqual(result["run"]["status"], "completed")
            self.assertEqual(result["included"]["drafts"], [])
            self.assertEqual(refreshed.context["taskState"][old_prompt_key]["clarificationId"], "ai-clarification-topic-change")

        def test_workspace_runner_records_clarification_reason_metrics(self) -> None:
            class ClarificationProvider(BaseChatProvider):
                model_name = "clarification-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("unexpected generate call")

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
                    del system, user, message_handler, max_rounds
                    tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要确认要修改的餐食计划"})
                    tools()
                    tool_handler(
                        "human.request_input",
                        {
                            "question": "你要改哪一条晚餐计划？",
                            "inputMode": "choice_or_text",
                            "options": [{"id": "plan-1", "label": "2026-06-15 晚餐 · 番茄炒蛋"}],
                            "allowMultiple": False,
                            "required": True,
                            "reason": "需要确认目标计划",
                            "sourceSkills": ["meal_plan"],
                            "resumeHint": {"questionType": "meal_plan_disambiguation", "missingFields": ["目标计划"]},
                        },
                    )
                    return ChatProviderResult(
                        text="我需要先确认你要改哪一条计划。",
                        status="completed",
                        model=self.model_name,
                    )

            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=ClarificationProvider())
                result = service.chat(family_id=self.family.id, user_id=self.user.id, message="把晚餐改一下")
                run = db.get(AIAgentRun, result["run"]["id"])
                assert run is not None
                clarification = run.context_summary["clarificationStats"]
                metrics = run.context_summary["runMetrics"]
                self.assertEqual(clarification["count"], 1)
                self.assertEqual(clarification["reasons"]["meal_plan_disambiguation"], 1)
                self.assertEqual(clarification["bySkill"]["meal_plan"], 1)
                self.assertEqual(clarification["lastQuestionTypes"], ["meal_plan_disambiguation"])
                self.assertEqual(metrics["clarificationCount"], 1)

        def test_inventory_query_tools_expose_only_contextual_suggested_actions(self) -> None:
            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.low_stock_threshold = Decimal("4")
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )

                summary = executor.call("inventory.read_summary", {})
                available = executor.call("inventory.read_available_items", {"limit": 20})
                expiring = executor.call("inventory.read_expiring_items", {"days": 7})
                low_stock = executor.call("inventory.read_low_stock_items", {"limit": 20})

                self.assertEqual(summary["queryFocus"], "overview")
                self.assertNotIn("suggestedAction", summary["items"][0])
                self.assertEqual(available["queryFocus"], "available")
                self.assertNotIn("suggestedAction", available["items"][0])
                self.assertEqual(expiring["queryFocus"], "expiring")
                self.assertEqual(expiring["items"][0]["suggestedAction"], "consume")
                self.assertEqual(low_stock["queryFocus"], "low_stock")
                self.assertEqual(low_stock["items"][0]["suggestedAction"], "restock")
                low_stock_ids = [record["id"] for record in low_stock["items"]]
                self.assertEqual(len(low_stock_ids), len(set(low_stock_ids)))

                item.expiry_date = today_for_family(self.family.id) - timedelta(days=1)
                db.flush()
                expired = executor.call("inventory.read_expired_items", {"limit": 20})
                expiring_with_expired = executor.call("inventory.read_expiring_items", {"days": 7})
                self.assertEqual(expired["queryFocus"], "expired")
                self.assertEqual(expired["items"][0]["suggestedAction"], "dispose")
                self.assertEqual(expiring_with_expired["items"], [])

        def test_inventory_summary_includes_ready_food_stock(self) -> None:
            with self.SessionLocal() as db:
                db.add(
                    Food(
                        id="food-ai-stock-yogurt",
                        family_id=self.family.id,
                        name="蓝莓酸奶",
                        type="readyMade",
                        category="饮品",
                        flavor_tags=[],
                        scene_tags=[],
                        suitable_meal_types=["breakfast"],
                        source_name="盒马",
                        purchase_source="盒马",
                        scene="",
                        notes="",
                        routine_note="",
                        stock_quantity=Decimal("2"),
                        stock_unit="盒",
                        expiry_date=today_for_family(self.family.id),
                        favorite=False,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.commit()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-food-stock-summary",
                        run_id="run-food-stock-summary",
                    ),
                )

                summary = executor.call("inventory.read_summary", {"days": 7})

                food_items = [
                    item
                    for item in summary["items"]
                    if item.get("sourceType") == "food" and item.get("foodId") == "food-ai-stock-yogurt"
                ]
                self.assertEqual(len(food_items), 1)
                self.assertEqual(food_items[0]["name"], "蓝莓酸奶")
                self.assertEqual(food_items[0]["quantity"], "2盒")
                self.assertNotIn("suggestedAction", food_items[0])
                self.assertEqual(summary["card"]["data"]["foodStockCount"], 1)

        def test_inventory_contextual_read_tools_include_ready_food_stock(self) -> None:
            today = today_for_family(self.family.id)
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        Food(
                            id="food-ai-stock-available",
                            family_id=self.family.id,
                            name="即食鸡胸肉",
                            type="packaged",
                            category="即食",
                            flavor_tags=[],
                            scene_tags=[],
                            suitable_meal_types=["lunch"],
                            source_name="便利店",
                            purchase_source="便利店",
                            scene="",
                            notes="",
                            routine_note="",
                            stock_quantity=Decimal("3"),
                            stock_unit="包",
                            expiry_date=today + timedelta(days=5),
                            favorite=False,
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        Food(
                            id="food-ai-stock-expiring",
                            family_id=self.family.id,
                            name="三明治",
                            type="readyMade",
                            category="熟食",
                            flavor_tags=[],
                            scene_tags=[],
                            suitable_meal_types=["breakfast"],
                            source_name="面包店",
                            purchase_source="面包店",
                            scene="",
                            notes="",
                            routine_note="",
                            stock_quantity=Decimal("1"),
                            stock_unit="份",
                            expiry_date=today + timedelta(days=1),
                            favorite=False,
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        Food(
                            id="food-ai-stock-expired",
                            family_id=self.family.id,
                            name="过期饭团",
                            type="instant",
                            category="速食",
                            flavor_tags=[],
                            scene_tags=[],
                            suitable_meal_types=["breakfast"],
                            source_name="便利店",
                            purchase_source="便利店",
                            scene="",
                            notes="",
                            routine_note="",
                            stock_quantity=Decimal("2"),
                            stock_unit="个",
                            expiry_date=today - timedelta(days=1),
                            favorite=False,
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                    ]
                )
                db.commit()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-contextual-food-stock",
                        run_id="run-contextual-food-stock",
                    ),
                )

                available = executor.call("inventory.read_available_items", {"limit": 20})
                expiring = executor.call("inventory.read_expiring_items", {"days": 3})
                expired = executor.call("inventory.read_expired_items", {"limit": 20})
                low_stock = executor.call("inventory.read_low_stock_items", {"limit": 20})

                available_food = next(item for item in available["items"] if item["foodId"] == "food-ai-stock-available")
                self.assertEqual(available_food["sourceType"], "food")
                self.assertIsNone(available_food["ingredientId"])
                self.assertEqual(available_food["quantity"], "3包")

                expiring_food = next(item for item in expiring["items"] if item["foodId"] == "food-ai-stock-expiring")
                self.assertEqual(expiring_food["sourceType"], "food")
                self.assertEqual(expiring_food["displayStatus"], "expiring")
                self.assertEqual(expiring_food["suggestedAction"], "consume")

                expired_food = next(item for item in expired["items"] if item["foodId"] == "food-ai-stock-expired")
                self.assertEqual(expired_food["sourceType"], "food")
                self.assertEqual(expired_food["displayStatus"], "expired")
                self.assertEqual(expired_food["suggestedAction"], "dispose")

                self.assertFalse(any(item["sourceType"] == "food" for item in low_stock["items"]))

        def test_inventory_summary_preserves_low_stock_count_and_priority_for_ingredients(self) -> None:
            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.low_stock_threshold = Decimal("4")
                item.expiry_date = None
                db.add(
                    Food(
                        id="food-ai-stock-milk",
                        family_id=self.family.id,
                        name="鲜牛奶",
                        type="readyMade",
                        category="饮品",
                        flavor_tags=[],
                        scene_tags=[],
                        suitable_meal_types=["breakfast"],
                        source_name="超市",
                        purchase_source="盒马",
                        scene="",
                        notes="",
                        routine_note="",
                        stock_quantity=Decimal("2"),
                        stock_unit="盒",
                        expiry_date=today_for_family(self.family.id) + timedelta(days=2),
                        favorite=False,
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-low-stock-summary",
                        run_id="run-low-stock-summary",
                    ),
                )

                summary = executor.call("inventory.read_summary", {"days": 7})

                self.assertEqual(summary["lowStockCount"], 1)
                self.assertEqual(summary["card"]["data"]["lowStockCount"], 1)
                self.assertEqual(summary["items"][0]["sourceType"], "ingredient")
                self.assertEqual(summary["items"][0]["inventoryItemId"], "inventory-tomato")

        def test_inventory_operation_draft_normalizes_real_entities_and_rejects_cross_family_items(self) -> None:
            with self.SessionLocal() as db:
                draft = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "draftType": "inventory_operation",
                        "schemaVersion": "inventory_operation.v1",
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 1,
                                "unit": "个",
                            },
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-tomato",
                                "inventoryItemId": "inventory-tomato",
                                "quantity": 0.5,
                                "unit": "个",
                                "reason": "包装破损",
                            },
                        ],
                    },
                )
                self.assertEqual(draft["draftType"], "inventory_operation")
                self.assertEqual(draft["operations"][0]["ingredientName"], "番茄")
                self.assertEqual(draft["operations"][1]["remainingQuantity"], 2)
                self.assertEqual(draft["operations"][0]["image"]["id"], "media-ingredient-tomato")

                with self.assertRaisesRegex(ValueError, "最多只能销毁"):
                    normalize_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        payload={
                            "operations": [
                                {
                                    "action": "consume",
                                    "ingredientId": "ingredient-tomato",
                                    "quantity": 2,
                                    "unit": "个",
                                },
                                {
                                    "action": "dispose",
                                    "ingredientId": "ingredient-tomato",
                                    "inventoryItemId": "inventory-tomato",
                                    "quantity": 2,
                                    "unit": "个",
                                    "reason": "变质",
                                },
                            ]
                        },
                    )

                with self.assertRaisesRegex(ValueError, "不属于当前家庭"):
                    normalize_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        payload={
                            "operations": [
                                {
                                    "action": "dispose",
                                    "ingredientId": "ingredient-secret",
                                    "inventoryItemId": "inventory-secret",
                                    "quantity": 1,
                                    "unit": "块",
                                    "reason": "测试",
                                }
                            ]
                        },
                    )

        def test_inventory_approval_cannot_change_operation_type(self) -> None:
            original = {
                "operations": [
                    {
                        "action": "consume",
                        "ingredientId": "ingredient-tomato",
                        "quantity": 1,
                        "unit": "个",
                    }
                ]
            }
            draft_operation_registry.validate_approval_value("inventory_operation", original, original)
            with self.assertRaisesRegex(ValueError, "处理方式不能"):
                draft_operation_registry.validate_approval_value(
                    "inventory_operation",
                    original,
                    {
                        "operations": [
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-tomato",
                                "inventoryItemId": "inventory-tomato",
                                "quantity": 1,
                                "unit": "个",
                                "reason": "变质",
                            }
                        ]
                    },
                )

        def test_inventory_disposal_tracks_partial_disposal_separately_from_consumption(self) -> None:
            with self.SessionLocal() as db:
                item = db.scalar(
                    select(InventoryItem)
                    .where(InventoryItem.id == "inventory-tomato")
                    .options(selectinload(InventoryItem.ingredient))
                )
                assert item is not None
                result = dispose_inventory_quantity(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    item=item,
                    quantity=Decimal("1.25"),
                    unit="个",
                    reason="包装破损",
                )
                self.assertEqual(item.consumed_quantity, Decimal("0"))
                self.assertEqual(item.disposed_quantity, Decimal("1.25"))
                self.assertEqual(remaining_quantity(item), Decimal("1.75"))
                self.assertEqual(result["remaining_quantity"], 1.75)

        def test_inventory_card_quick_action_creates_approval_and_updates_card_after_confirmation(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-inventory-quick",
                    family_id=self.family.id,
                    mode=AiMode.INVENTORY_QA,
                    prompt="库存处理",
                    response="库存概览",
                    context={},
                    title="库存处理",
                    summary="",
                    status="active",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-inventory-quick",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="库存概览",
                    content_type="parts",
                    parts=[
                        {
                            "id": "part-inventory-card",
                            "type": "result_card",
                            "card": {
                                "id": "card-inventory",
                                "type": "inventory_summary",
                                "title": "库存概览",
                                "data": {
                                    "availableCount": 1,
                                    "expiringCount": 1,
                                    "lowStockCount": 0,
                                    "items": [
                                        {
                                            "id": "inventory-tomato",
                                            "ingredientId": "ingredient-tomato",
                                            "name": "番茄",
                                            "quantity": "3",
                                            "unit": "个",
                                            "status": "fresh",
                                            "displayStatus": "expiring",
                                        }
                                    ],
                                },
                            },
                        }
                    ],
                    status="completed",
                    message_metadata={},
                    created_by=self.user.id,
                )
                db.add_all([conversation, message])
                db.commit()

            response = self.client.post(
                "/api/ai/messages/message-inventory-quick/inventory-operation-draft",
                json={
                    "part_id": "part-inventory-card",
                    "card_id": "card-inventory",
                    "item_id": "inventory-tomato",
                    "action": "dispose",
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval_part = next(part for part in data["parts"] if part["type"] == "approval_request")
            approval = approval_part["approval"]
            self.assertEqual(approval["approval_type"], "inventory.operation")

            decision = self.client.post(
                f"/api/ai/conversations/conversation-inventory-quick/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": approval["draft_version"],
                    "values": approval["initial_values"],
                },
            )
            self.assertEqual(decision.status_code, 200, decision.text)
            self.assertEqual(decision.json()["operation"]["status"], "succeeded")
            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.disposed_quantity, Decimal("3.00"))
                stored_message = db.get(AIMessage, "message-inventory-quick")
                assert stored_message is not None
                card_item = stored_message.parts[0]["card"]["data"]["items"][0]
                self.assertEqual(card_item["quantity"], "0")
                self.assertEqual(card_item["lastOperation"]["action"], "dispose")
