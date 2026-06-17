from ._support import *


class AIInventoryOperationsTestCase(AIAgentInfraTestCase):
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

        def test_inventory_unit_mismatch_skill_requests_clarification_before_draft(self) -> None:
            tool_calls: list[str] = []

            class UnitMismatchProvider(BaseChatProvider):
                model_name = "unit-mismatch-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("tool-calling skill should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools: list,
                    tool_handler,
                    response_schema: dict | None = None,
                    max_rounds: int = 8,
                    visible_text_handler=None,
                ) -> ChatProviderResult:
                    del system, user, tools, response_schema, max_rounds, visible_text_handler
                    search = tool_handler("ingredient.search", {"query": "鸡蛋", "exact": True, "limit": 5})
                    tool_calls.append("ingredient.search")
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
                        "intent.request_clarification",
                        {
                            "question": "鸡蛋当前主单位是 个，尚未设置 盒。请确认这次 1 盒等于多少 个；确认后只按本次换算继续入库，不会自动保存为副单位。",
                            "questionType": "unit_conversion",
                            "missingFields": ["单位换算"],
                            "candidates": [],
                            "allowFreeText": True,
                            "unitMismatch": {
                                "ingredientId": ingredient["id"],
                                "ingredientName": ingredient["name"],
                                "defaultUnit": ingredient["defaultUnit"],
                                "unsupportedUnit": "盒",
                                "supportedUnits": ingredient["supportedUnits"],
                                "originalDraft": original_draft,
                            },
                        },
                    )
                    tool_calls.append("intent.request_clarification")
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "需要先确认鸡蛋这次的单位换算。",
                                "status": "completed",
                                "requires_clarification": True,
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            skill = build_workspace_skill_registry().get("inventory_analysis")
            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-unit-mismatch",
                        run_id="run-unit-mismatch",
                        conversation=[],
                        current_message="把今天买的鸡蛋 2 盒录入库存，放冷藏",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(
                                db=db,
                                family_id=self.family.id,
                                user_id=self.user.id,
                                conversation_id="conversation-unit-mismatch",
                                run_id="run-unit-mismatch",
                            ),
                        ),
                        provider=UnitMismatchProvider(),
                    )
                )

            self.assertEqual(result.status, "completed")
            self.assertTrue(result.requires_clarification)
            self.assertIn("需要先确认", result.text)
            self.assertEqual(result.cards[0]["type"], "clarification_request")
            self.assertEqual(result.cards[0]["title"], "还需要你确认一下")
            self.assertEqual(result.cards[0]["data"]["questionType"], "unit_conversion")
            self.assertEqual(result.cards[0]["data"]["unitMismatch"]["ingredientId"], "ingredient-egg")
            pending = result.state_patch["pendingClarification"]
            self.assertEqual(pending["sourceSkill"], "inventory_analysis")
            self.assertEqual(pending["questionType"], "unit_conversion")
            self.assertEqual(pending["payload"]["unitMismatch"]["unsupportedUnit"], "盒")
            self.assertEqual(tool_calls, ["ingredient.search", "intent.request_clarification"])

        def test_workspace_unit_mismatch_reply_creates_inventory_approval_without_saving_unit(self) -> None:
            class UnitMismatchProvider(BaseChatProvider):
                model_name = "unit-mismatch-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    if "工作台的 Planner" in system:
                        payload = json.loads(user)
                        if payload.get("pendingClarification"):
                            assert payload["pendingClarification"]["questionType"] == "unit_conversion"
                        return ChatProviderResult(text='{"skills":["inventory_analysis"]}', status="completed", model=self.model_name)
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools: list,
                    tool_handler,
                    response_schema: dict | None = None,
                    max_rounds: int = 8,
                    visible_text_handler=None,
                ) -> ChatProviderResult:
                    del system, tools, response_schema, max_rounds, visible_text_handler
                    payload = json.loads(user)
                    pending = payload.get("pendingClarification")
                    if isinstance(pending, dict):
                        tool_handler(
                            "inventory.create_unit_conversion_operation_draft",
                            {
                                "pendingClarification": pending,
                                "ratioToDefault": 10,
                                "sourceMessage": payload.get("currentMessage"),
                            },
                        )
                        return ChatProviderResult(
                            text=json.dumps(
                                {
                                    "text": "已按 1 盒 = 10 个整理为本次入库确认项，不会自动保存副单位。",
                                    "status": "completed",
                                },
                                ensure_ascii=False,
                            ),
                            status="completed",
                            model=self.model_name,
                            structured_mode="tool_call",
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
                        "intent.request_clarification",
                        {
                            "question": "鸡蛋当前主单位是 个，尚未设置 盒。请确认这次 1 盒等于多少 个；确认后只按本次换算继续入库，不会自动保存为副单位。",
                            "questionType": "unit_conversion",
                            "missingFields": ["单位换算"],
                            "candidates": [],
                            "allowFreeText": True,
                            "unitMismatch": {
                                "ingredientId": ingredient["id"],
                                "ingredientName": ingredient["name"],
                                "defaultUnit": ingredient["defaultUnit"],
                                "unsupportedUnit": "盒",
                                "supportedUnits": ingredient["supportedUnits"],
                                "originalDraft": original_draft,
                            },
                        },
                    )
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "需要先确认鸡蛋这次的单位换算。",
                                "status": "completed",
                                "requires_clarification": True,
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                service = AIApplicationService(db, provider=UnitMismatchProvider())
                first = service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="把今天买的鸡蛋 2 盒录入库存，放冷藏",
                )
                self.assertEqual(first["run"]["status"], "completed")
                self.assertEqual(first["included"]["result_cards"][0]["type"], "clarification_request")
                conversation = db.get(AIConversation, first["conversation_id"])
                assert conversation is not None
                pending = conversation.context["taskState"]["pendingClarification"]
                self.assertEqual(pending["sourceSkill"], "inventory_analysis")
                self.assertEqual(pending["questionType"], "unit_conversion")
                self.assertEqual(pending["payload"]["unitMismatch"]["unsupportedUnit"], "盒")

                second = service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=first["conversation_id"],
                    message="这次每盒按十枚算",
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
                self.assertNotIn("pendingClarification", task_state)
                self.assertEqual(
                    task_state["lastClarificationResolution"]["payload"]["unit"],
                    "盒",
                )

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
                assert inventory_item is not None
                self.assertEqual(inventory_item.quantity, Decimal("20.00"))
                self.assertEqual(inventory_item.unit, "个")
                self.assertEqual(inventory_item.entered_quantity, Decimal("20.00"))
                self.assertEqual(inventory_item.entered_unit, "个")

        def test_workspace_unit_mismatch_explicit_save_creates_ingredient_update_approval(self) -> None:
            class SaveUnitConversionProvider(BaseChatProvider):
                model_name = "save-unit-conversion-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    if "工作台的 Planner" in system:
                        return ChatProviderResult(text='{"skills":["ingredient_profile"]}', status="completed", model=self.model_name)
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools: list,
                    tool_handler,
                    response_schema: dict | None = None,
                    max_rounds: int = 8,
                    visible_text_handler=None,
                ) -> ChatProviderResult:
                    del system, user, tools, response_schema, max_rounds, visible_text_handler
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
                        text=json.dumps(
                            {
                                "text": "已整理保存副单位的食材档案更新确认项。",
                                "status": "completed",
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                conversation = AIConversation(
                    id="conversation-unit-mismatch-save",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="保存副单位",
                    response="",
                    context={
                        "taskState": {
                            "lastClarificationResolution": {
                                "type": "unit_conversion",
                                "payload": {
                                    "type": "unit_conversion_candidate",
                                    "ingredientId": "ingredient-egg",
                                    "ingredientName": "鸡蛋",
                                    "defaultUnit": "个",
                                    "unit": "盒",
                                    "ratioToDefault": 10.0,
                                    "sourceMessage": "1盒10个",
                                },
                            }
                        }
                    },
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

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    if "工作台的 Planner" in system:
                        payload = json.loads(user)
                        assert payload["pendingClarification"]["questionType"] == "unit_conversion"
                        return ChatProviderResult(text='{"skills":["inventory_analysis"]}', status="completed", model=self.model_name)
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools: list,
                    tool_handler,
                    response_schema: dict | None = None,
                    max_rounds: int = 8,
                    visible_text_handler=None,
                ) -> ChatProviderResult:
                    del system, tools, response_schema, max_rounds, visible_text_handler
                    payload = json.loads(user)
                    unit_mismatch = payload["pendingClarification"]["payload"]["unitMismatch"]
                    tool_handler(
                        "intent.request_clarification",
                        {
                            "question": payload["pendingClarification"]["question"],
                            "questionType": "unit_conversion",
                            "missingFields": ["单位换算"],
                            "candidates": [],
                            "allowFreeText": True,
                            "unitMismatch": unit_mismatch,
                        },
                    )
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "我还需要知道这次 1 盒鸡蛋等于多少个。",
                                "status": "completed",
                                "requires_clarification": True,
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            with self.SessionLocal() as db:
                self._add_egg_ingredient(db)
                conversation = AIConversation(
                    id="conversation-unit-mismatch-reask",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="把鸡蛋 2 盒入库",
                    response="",
                    context={
                        "taskState": {
                            "pendingClarification": {
                                "clarificationId": "ai-clarification-test",
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
                                                    "storageLocation": "冷藏",
                                                }
                                            ],
                                        },
                                    },
                                },
                                "createdAt": utcnow().isoformat(),
                            }
                        }
                    },
                    title="单位换算",
                    status="active",
                    created_by=self.user.id,
                )
                db.add(conversation)
                db.commit()
                service = AIApplicationService(db, provider=ReaskUnitConversionProvider())
                result = service.chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=conversation.id,
                    message="差不多吧",
                )
                refreshed = db.get(AIConversation, conversation.id)
                assert refreshed is not None

            self.assertEqual(result["run"]["status"], "completed")
            self.assertEqual(result["included"]["result_cards"][0]["type"], "clarification_request")
            self.assertEqual(result["included"]["drafts"], [])
            self.assertEqual(refreshed.context["taskState"]["pendingClarification"]["payload"]["unitMismatch"]["unsupportedUnit"], "盒")

        def test_workspace_pending_clarification_can_route_to_new_topic(self) -> None:
            class TopicChangeProvider(BaseChatProvider):
                model_name = "topic-change-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    if "工作台的 Planner" in system:
                        payload = json.loads(user)
                        assert payload["pendingClarification"]["questionType"] == "unit_conversion"
                        return ChatProviderResult(text='{"skills":["meal_plan"]}', status="completed", model=self.model_name)
                    return ChatProviderResult(text="已处理。", status="completed", model=self.model_name)

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools: list,
                    tool_handler,
                    response_schema: dict | None = None,
                    max_rounds: int = 8,
                    visible_text_handler=None,
                ) -> ChatProviderResult:
                    del system, user, tools, tool_handler, response_schema, max_rounds, visible_text_handler
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "今晚可以优先安排一道清淡快手菜。",
                                "status": "completed",
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            pending = {
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
                    context={"taskState": {"pendingClarification": pending}},
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
            self.assertEqual(refreshed.context["taskState"]["pendingClarification"]["clarificationId"], "ai-clarification-topic-change")

        def test_workspace_runner_records_clarification_reason_metrics(self) -> None:
            class ClarificationProvider(BaseChatProvider):
                model_name = "clarification-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    if "工作台的 Planner" in system:
                        return ChatProviderResult(text='{"skills":["meal_plan"]}', status="completed", model=self.model_name)
                    raise AssertionError("unexpected generate call")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools: list,
                    tool_handler,
                    response_schema: dict | None = None,
                    max_rounds: int = 8,
                    visible_text_handler=None,
                ) -> ChatProviderResult:
                    del system, user, tools, response_schema, max_rounds, visible_text_handler
                    tool_handler(
                        "intent.request_clarification",
                        {
                            "question": "你要改哪一条晚餐计划？",
                            "questionType": "meal_plan_disambiguation",
                            "missingFields": ["目标计划"],
                            "candidates": [{"id": "plan-1", "label": "2026-06-15 晚餐 · 番茄炒蛋"}],
                            "allowFreeText": True,
                        },
                    )
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "我需要先确认你要改哪一条计划。",
                                "status": "completed",
                                "requires_clarification": True,
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
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
            validate_inventory_operation_shape(original, original)
            with self.assertRaisesRegex(ValueError, "处理方式不能"):
                validate_inventory_operation_shape(
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
