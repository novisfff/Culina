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

        def test_presence_dispose_draft_fails_early_with_presence_state_required(self) -> None:
            from app.services.ingredient_inventory_state import PresenceStateRequiredError

            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-oil-dispose",
                    family_id=self.family.id,
                    name="食用油",
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
                # Historical placeholder row must not make dispose drafts succeed.
                db.add(
                    InventoryItem(
                        id="inventory-oil-placeholder",
                        family_id=self.family.id,
                        ingredient_id=ingredient.id,
                        quantity=Decimal("1"),
                        consumed_quantity=Decimal("0"),
                        unit="瓶",
                        status=InventoryStatus.FRESH,
                        purchase_date=date.today(),
                        expiry_date=None,
                        storage_location="常温",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.flush()
                with self.assertRaises(PresenceStateRequiredError) as raised:
                    normalize_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        payload={
                            "operations": [
                                {
                                    "action": "dispose",
                                    "ingredientId": ingredient.id,
                                    "inventoryItemId": "inventory-oil-placeholder",
                                    "reason": "用完了",
                                }
                            ]
                        },
                    )
                self.assertEqual(raised.exception.code, "presence_state_required")

        def test_presence_consume_draft_fails_early_with_state_update_guidance(self) -> None:
            from app.services.ingredient_inventory_state import PresenceStateRequiredError

            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-oil-consume",
                    family_id=self.family.id,
                    name="食用油",
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

                with self.assertRaises(PresenceStateRequiredError) as raised:
                    normalize_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        payload={
                            "operations": [
                                {
                                    "action": "consume",
                                    "ingredientId": ingredient.id,
                                    "quantity": 1,
                                    "unit": "瓶",
                                }
                            ]
                        },
                    )

            self.assertEqual(raised.exception.code, "presence_state_required")
            self.assertIn("少量", str(raised.exception))
            self.assertIn("没有了", str(raised.exception))

        def test_agent_context_and_meal_plan_counts_exclude_presence_placeholders(self) -> None:
            from app.ai.kitchen.context import load_agent_context
            from app.ai.tools.catalog.meal_plan import _today_recommendation_context
            from app.core.enums import InventoryAvailabilityLevel
            from app.models.domain import IngredientInventoryState
            from app.services.recipe_recommendations import recipe_expiring_inventory_bonus

            with self.SessionLocal() as db:
                salt = Ingredient(
                    id="ingredient-salt-context",
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
                db.add(salt)
                db.flush()
                today = today_for_family(self.family.id)
                db.add(
                    InventoryItem(
                        id="inventory-salt-placeholder",
                        family_id=self.family.id,
                        ingredient_id=salt.id,
                        quantity=Decimal("1"),
                        consumed_quantity=Decimal("0"),
                        unit="g",
                        status=InventoryStatus.FRESH,
                        purchase_date=today,
                        expiry_date=today + timedelta(days=2),
                        storage_location="常温",
                        notes="",
                        low_stock_threshold=Decimal("0"),
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.add(
                    IngredientInventoryState(
                        id="state-salt-context",
                        family_id=self.family.id,
                        ingredient_id=salt.id,
                        availability_level=InventoryAvailabilityLevel.SUFFICIENT,
                        inventory_status=InventoryStatus.FRESH,
                        purchase_date=today,
                        expiry_date=today + timedelta(days=2),
                        storage_location="常温",
                        notes="",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.flush()

                context = load_agent_context(
                    db,
                    family_id=self.family.id,
                    mode=None,
                    subject={},
                    include_inventory=True,
                    include_meal_logs=False,
                )
                self.assertTrue(all(item.id != "inventory-salt-placeholder" for item in context.inventory_items))
                self.assertTrue(any(state.ingredient_id == salt.id for state in context.presence_states))

                summary = _today_recommendation_context(
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-meal-context",
                        run_id="run-meal-context",
                    )
                )
                # tomato fixture (1) + usable salt state (1); placeholder must not double-count.
                self.assertEqual(summary["inventoryCount"], 2)
                # tomato fixture expiring + salt state expiring; placeholder ignored.
                self.assertEqual(summary["expiringCount"], 2)

                recipe = Recipe(
                    id="recipe-salt-bonus",
                    family_id=self.family.id,
                    title="盐焗测试",
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
                    RecipeIngredient(
                        id="recipe-ingredient-salt-bonus",
                        recipe_id=recipe.id,
                        ingredient_id=salt.id,
                        ingredient_name="盐",
                        quantity=Decimal("1"),
                        unit="g",
                        note="",
                        sort_order=0,
                    )
                )
                db.flush()
                recipe = db.scalar(
                    select(Recipe)
                    .where(Recipe.id == recipe.id)
                    .options(selectinload(Recipe.ingredient_items))
                )
                assert recipe is not None
                placeholder = db.get(InventoryItem, "inventory-salt-placeholder")
                assert placeholder is not None
                # Even if a caller passes residual placeholders, bonus must ignore them.
                self.assertEqual(recipe_expiring_inventory_bonus(recipe, [placeholder], today), 0)
                state = db.get(IngredientInventoryState, "state-salt-context")
                assert state is not None
                self.assertGreater(
                    recipe_expiring_inventory_bonus(
                        recipe,
                        [],
                        today,
                        presence_states_by_ingredient={salt.id: state},
                    ),
                    0,
                )

        def test_presence_inventory_batch_helpers_reject_not_track_quantity(self) -> None:
            from app.services.ingredient_inventory_state import PresenceStateRequiredError, upsert_inventory_state
            from app.core.enums import InventoryAvailabilityLevel, InventoryConfirmationSource
            from app.models.domain import IngredientInventoryState
            from app.services.ai_operations.inventory import execute_inventory_operation_draft

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

                with self.assertRaises(PresenceStateRequiredError):
                    create_inventory_batch(
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

                with self.assertRaises(PresenceStateRequiredError):
                    consume_ingredient_inventory(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        ingredient=ingredient,
                        quantity=None,
                        unit=None,
                        today=date.today(),
                    )

                state = upsert_inventory_state(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    ingredient=ingredient,
                    expected_ingredient_row_version=ingredient.row_version,
                    state_id=None,
                    expected_state_row_version=None,
                    availability_level=InventoryAvailabilityLevel.PRESENT_UNKNOWN,
                    inventory_status=InventoryStatus.FRESH,
                    purchase_date=date.today(),
                    expiry_date=None,
                    storage_location="常温",
                    notes="",
                    confirmation_source=InventoryConfirmationSource.MANUAL_ENTRY,
                )
                self.assertEqual(state.availability_level, InventoryAvailabilityLevel.PRESENT_UNKNOWN)

                payload = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "restock",
                                "ingredientId": ingredient.id,
                                "status": "opened",
                                "storageLocation": "常温",
                                "availabilityLevel": "low",
                            }
                        ]
                    },
                )
                result, entity_ids = execute_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload=payload,
                )
                self.assertEqual(entity_ids, [state.id])
                self.assertEqual(result["operations"][0]["state_id"], state.id)
                refreshed = db.get(IngredientInventoryState, state.id)
                assert refreshed is not None
                self.assertEqual(refreshed.availability_level, InventoryAvailabilityLevel.LOW)
                self.assertEqual(refreshed.inventory_status, InventoryStatus.OPENED)

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
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
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
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
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
                depleted = Ingredient(
                    id="ingredient-depleted-garlic",
                    family_id=self.family.id,
                    name="大蒜",
                    category="蔬菜",
                    default_unit="头",
                    unit_conversions=[],
                    quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
                    default_storage="常温",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    default_low_stock_threshold=Decimal("2"),
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(depleted)
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
                self.assertEqual(expiring["card"]["type"], "inventory_summary")
                self.assertEqual(expiring["card"]["data"]["queryFocus"], "expiring")
                self.assertEqual(expiring["card"]["data"]["expiringCount"], expiring["count"])
                self.assertEqual(low_stock["queryFocus"], "low_stock")
                self.assertEqual(low_stock["items"][0]["suggestedAction"], "restock")
                self.assertEqual(low_stock["card"]["type"], "inventory_summary")
                self.assertEqual(low_stock["card"]["data"]["queryFocus"], "low_stock")
                self.assertTrue(
                    any(
                        record["ingredientId"] == depleted.id and record["quantity"] == "0"
                        for record in low_stock["items"]
                    )
                )
                low_stock_ids = [record["id"] for record in low_stock["items"]]
                self.assertEqual(len(low_stock_ids), len(set(low_stock_ids)))

                item.expiry_date = today_for_family(self.family.id) - timedelta(days=1)
                db.flush()
                expired = executor.call("inventory.read_expired_items", {"limit": 20})
                expiring_with_expired = executor.call("inventory.read_expiring_items", {"days": 7})
                self.assertEqual(expired["queryFocus"], "expired")
                self.assertEqual(expired["items"][0]["suggestedAction"], "dispose")
                self.assertEqual(expiring_with_expired["items"], [])

        def test_expiring_inventory_query_applies_limit_to_payload_and_card(self) -> None:
            with self.SessionLocal() as db:
                ingredient = self._add_egg_ingredient(db)
                today = today_for_family(self.family.id)
                for index in range(4):
                    create_inventory_batch(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        ingredient=ingredient,
                        quantity=Decimal("1"),
                        unit="个",
                        status=InventoryStatus.FRESH,
                        purchase_date=today,
                        expiry_date=today + timedelta(days=index + 1),
                        storage_location="冷藏",
                    )
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-expiring-limit",
                        run_id="run-expiring-limit",
                    ),
                )

                output = executor.call("inventory.read_expiring_items", {"days": 7, "limit": 3})

            self.assertEqual(output["count"], 3)
            self.assertEqual(len(output["items"]), 3)
            self.assertEqual(len(output["card"]["data"]["items"]), 3)

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
                self.assertNotIn("suggestedAction", expiring_food)

                expired_food = next(item for item in expired["items"] if item["foodId"] == "food-ai-stock-expired")
                self.assertEqual(expired_food["sourceType"], "food")
                self.assertEqual(expired_food["displayStatus"], "expired")
                self.assertNotIn("suggestedAction", expired_food)

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

        def test_inventory_summary_counts_low_stock_beyond_card_item_limit(self) -> None:
            with self.SessionLocal() as db:
                today = today_for_family(self.family.id)
                for index in range(7):
                    ingredient = Ingredient(
                        id=f"ingredient-low-count-{index}",
                        family_id=self.family.id,
                        name=f"低库存食材{index}",
                        category="测试",
                        default_unit="份",
                        unit_conversions=[],
                        default_storage="常温",
                        default_expiry_mode=IngredientExpiryMode.NONE,
                        notes="",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                    db.add_all(
                        [
                            ingredient,
                            InventoryItem(
                                id=f"inventory-low-count-{index}",
                                family_id=self.family.id,
                                ingredient_id=ingredient.id,
                                quantity=Decimal("1"),
                                consumed_quantity=Decimal("0"),
                                disposed_quantity=Decimal("0"),
                                unit="份",
                                entered_quantity=Decimal("1"),
                                entered_unit="份",
                                status=InventoryStatus.FRESH,
                                purchase_date=today,
                                expiry_date=None,
                                storage_location="常温",
                                notes="",
                                low_stock_threshold=Decimal("2"),
                                created_by=self.user.id,
                                updated_by=self.user.id,
                            ),
                        ]
                    )
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-low-stock-count",
                        run_id="run-low-stock-count",
                    ),
                )

                summary = executor.call("inventory.read_summary", {"days": 7})

            self.assertEqual(summary["lowStockCount"], 7)
            self.assertEqual(summary["card"]["data"]["lowStockCount"], 7)
            self.assertLessEqual(len(summary["items"]), 6)

        def test_presence_low_state_appears_in_low_stock_query_and_summary(self) -> None:
            from app.core.enums import InventoryAvailabilityLevel
            from app.models.domain import IngredientInventoryState

            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-presence-low",
                    family_id=self.family.id,
                    name="生抽",
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
                state = IngredientInventoryState(
                    id="state-presence-low",
                    family_id=self.family.id,
                    ingredient_id=ingredient.id,
                    availability_level=InventoryAvailabilityLevel.LOW,
                    inventory_status=InventoryStatus.OPENED,
                    purchase_date=today_for_family(self.family.id),
                    expiry_date=None,
                    storage_location="常温",
                    notes="快用完了",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([ingredient, state])
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-presence-low",
                        run_id="run-presence-low",
                    ),
                )

                low_stock = executor.call("inventory.read_low_stock_items", {"limit": 20})
                summary = executor.call("inventory.read_summary", {"days": 7})

            low_item = next(
                item for item in low_stock["items"]
                if item["id"] == "ingredient-state:state-presence-low"
            )
            self.assertEqual(low_item["quantity"], "偏低")
            self.assertEqual(low_item["displayStatus"], "low_stock")
            self.assertEqual(low_item["suggestedAction"], "restock")
            self.assertEqual(summary["lowStockCount"], 1)
            self.assertEqual(summary["card"]["data"]["lowStockCount"], 1)
            self.assertTrue(
                any(
                    item["id"] == "ingredient-state:state-presence-low"
                    for item in summary["items"]
                )
            )

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

        def test_inventory_operation_draft_captures_concurrency_boundaries(self) -> None:
            with self.SessionLocal() as db:
                consume_draft = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 1,
                                "unit": "个",
                            }
                        ]
                    },
                )
                dispose_draft = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-tomato",
                                "inventoryItemId": "inventory-tomato",
                                "quantity": 1,
                                "unit": "个",
                                "reason": "包装破损",
                            }
                        ]
                    },
                )

            consume = consume_draft["operations"][0]
            self.assertEqual(consume["quantityTrackingMode"], "track_quantity")
            self.assertEqual(consume["expectedIngredientRowVersion"], 1)
            self.assertIsNone(consume["stateId"])
            self.assertIsNone(consume["expectedStateRowVersion"])
            self.assertIsNone(consume["expectedInventoryItemRowVersion"])
            self.assertEqual(consume["batchOptions"][0]["id"], "inventory-tomato")
            self.assertEqual(consume["batchOptions"][0]["rowVersion"], 1)

            dispose = dispose_draft["operations"][0]
            self.assertEqual(dispose["expectedIngredientRowVersion"], 1)
            self.assertEqual(dispose["expectedInventoryItemRowVersion"], 1)
            self.assertEqual(dispose["batchOptions"][0]["rowVersion"], 1)

        def test_inventory_approval_protects_versions_and_only_allows_listed_consume_batch(self) -> None:
            with self.SessionLocal() as db:
                original = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 1,
                                "unit": "个",
                            }
                        ]
                    },
                )

            selected = json.loads(json.dumps(original))
            selected["operations"][0]["inventoryItemId"] = "inventory-tomato"
            draft_operation_registry.validate_approval_value("inventory_operation", original, selected)

            with self.SessionLocal() as db:
                explicitly_scoped = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "inventoryItemId": "inventory-tomato",
                                "quantity": 1,
                                "unit": "个",
                            }
                        ]
                    },
                )
            cleared_scope = json.loads(json.dumps(explicitly_scoped))
            cleared_scope["operations"][0]["inventoryItemId"] = None
            with self.assertRaisesRegex(ValueError, "批次"):
                draft_operation_registry.validate_approval_value(
                    "inventory_operation",
                    explicitly_scoped,
                    cleared_scope,
                )

            outside_scope = json.loads(json.dumps(original))
            outside_scope["operations"][0]["inventoryItemId"] = "inventory-outside-preview"
            with self.assertRaisesRegex(ValueError, "批次"):
                draft_operation_registry.validate_approval_value(
                    "inventory_operation",
                    original,
                    outside_scope,
                )

            tampered_version = json.loads(json.dumps(original))
            tampered_version["operations"][0]["expectedIngredientRowVersion"] += 1
            with self.assertRaisesRegex(ValueError, "并发校验"):
                draft_operation_registry.validate_approval_value(
                    "inventory_operation",
                    original,
                    tampered_version,
                )

            tampered_batch_version = json.loads(json.dumps(original))
            tampered_batch_version["operations"][0]["batchOptions"][0]["rowVersion"] += 1
            with self.assertRaisesRegex(ValueError, "并发校验"):
                draft_operation_registry.validate_approval_value(
                    "inventory_operation",
                    original,
                    tampered_batch_version,
                )

        def test_presence_inventory_approval_rejects_state_changed_after_draft(self) -> None:
            from app.ai.errors import AIConflictError
            from app.core.enums import InventoryAvailabilityLevel
            from app.models.domain import IngredientInventoryState
            from app.services.ai_operations.inventory import execute_inventory_operation_draft

            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-presence-approval",
                    family_id=self.family.id,
                    name="香醋",
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
                state = IngredientInventoryState(
                    id="state-presence-approval",
                    family_id=self.family.id,
                    ingredient_id=ingredient.id,
                    availability_level=InventoryAvailabilityLevel.LOW,
                    inventory_status=InventoryStatus.FRESH,
                    storage_location="常温",
                    notes="还剩一点",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([ingredient, state])
                db.commit()
                draft = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "restock",
                                "ingredientId": ingredient.id,
                                "storageLocation": "常温",
                            }
                        ]
                    },
                )
                operation = draft["operations"][0]
                self.assertEqual(operation["stateId"], state.id)
                self.assertEqual(operation["expectedStateRowVersion"], 1)

            with self.SessionLocal() as db:
                state = db.get(IngredientInventoryState, "state-presence-approval")
                assert state is not None
                state.notes = "家人刚刚确认只剩最后一点"
                db.commit()

            with self.SessionLocal() as db:
                with self.assertRaises(AIConflictError):
                    execute_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        payload=draft,
                    )
                db.rollback()

            with self.SessionLocal() as db:
                state = db.get(IngredientInventoryState, "state-presence-approval")
                assert state is not None
                self.assertEqual(state.availability_level, InventoryAvailabilityLevel.LOW)
                self.assertEqual(state.notes, "家人刚刚确认只剩最后一点")

        def test_dispose_inventory_approval_rejects_batch_changed_after_draft(self) -> None:
            from app.ai.errors import AIConflictError
            from app.services.ai_operations.inventory import execute_inventory_operation_draft

            with self.SessionLocal() as db:
                draft = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-tomato",
                                "inventoryItemId": "inventory-tomato",
                                "quantity": 1,
                                "unit": "个",
                                "reason": "包装破损",
                            }
                        ]
                    },
                )

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.notes = "家人刚更新了这一批次"
                db.commit()

            with self.SessionLocal() as db:
                with self.assertRaises(AIConflictError):
                    execute_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        payload=draft,
                    )
                db.rollback()

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.disposed_quantity, Decimal("0"))
                self.assertEqual(item.notes, "家人刚更新了这一批次")

        def test_aggregate_consume_approval_rejects_inventory_scope_changed_after_draft(self) -> None:
            from app.ai.errors import AIConflictError
            from app.services.ai_operations.inventory import execute_inventory_operation_draft

            with self.SessionLocal() as db:
                draft = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 1,
                                "unit": "个",
                            }
                        ]
                    },
                )

            with self.SessionLocal() as db:
                ingredient = db.get(Ingredient, "ingredient-tomato")
                assert ingredient is not None
                create_inventory_batch(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    ingredient=ingredient,
                    quantity=Decimal("1"),
                    unit="个",
                    status=InventoryStatus.FRESH,
                    purchase_date=today_for_family(self.family.id),
                    expiry_date=None,
                    storage_location="冷藏",
                )
                db.commit()

            with self.SessionLocal() as db:
                with self.assertRaises(AIConflictError):
                    execute_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        payload=draft,
                    )
                db.rollback()

            with self.SessionLocal() as db:
                original = db.get(InventoryItem, "inventory-tomato")
                assert original is not None
                self.assertEqual(original.consumed_quantity, Decimal("0"))

        def test_inventory_approval_phase_normalization_preserves_proposal_versions(self) -> None:
            from app.ai.errors import AIConflictError
            from app.services.ai_operations.drafts import normalize_ai_draft_payload
            from app.services.ai_operations.inventory import execute_inventory_operation_draft

            with self.SessionLocal() as db:
                proposal = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 1,
                                "unit": "个",
                            }
                        ]
                    },
                )

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.notes = "审批前由家人更新"
                db.commit()

            with self.SessionLocal() as db:
                submitted = normalize_ai_draft_payload(
                    db,
                    draft_type="inventory_operation",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-inventory-approval-phase",
                    payload=proposal,
                    phase="approval",
                )
                self.assertEqual(submitted["operations"][0]["batchOptions"][0]["rowVersion"], 1)
                with self.assertRaises(AIConflictError):
                    execute_inventory_operation_draft(
                        db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        payload=submitted,
                    )
                db.rollback()

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
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
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
                                    "queryFocus": "expiring",
                                    "availableCount": 1,
                                    "expiringCount": 1,
                                    "expiredCount": 0,
                                    "lowStockCount": 0,
                                    "foodStockCount": 0,
                                    "items": [
                                        {
                                            "id": "inventory-tomato",
                                            "sourceType": "ingredient",
                                            "inventoryItemId": "inventory-tomato",
                                            "ingredientId": "ingredient-tomato",
                                            "foodId": None,
                                            "name": "番茄",
                                            "quantity": "3",
                                            "unit": "个",
                                            "quantityTrackingMode": "track_quantity",
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

        def test_presence_restock_approval_refreshes_state_backed_inventory_card(self) -> None:
            from app.core.enums import InventoryAvailabilityLevel
            from app.models.domain import IngredientInventoryState

            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-card-presence-low",
                    family_id=self.family.id,
                    name="蚝油",
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
                state = IngredientInventoryState(
                    id="state-card-presence-low",
                    family_id=self.family.id,
                    ingredient_id=ingredient.id,
                    availability_level=InventoryAvailabilityLevel.LOW,
                    inventory_status=InventoryStatus.OPENED,
                    purchase_date=today_for_family(self.family.id),
                    expiry_date=None,
                    storage_location="常温",
                    notes="快用完了",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([ingredient, state])
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-presence-card",
                        run_id="run-presence-card",
                    ),
                )
                low_stock = executor.call("inventory.read_low_stock_items", {"limit": 20})
                card = low_stock["card"]
                card_item = next(
                    item for item in card["data"]["items"]
                    if item["id"] == "ingredient-state:state-card-presence-low"
                )
                self.assertEqual(card_item["quantity"], "偏低")

                conversation = AIConversation(
                    id="conversation-presence-card",
                    family_id=self.family.id,
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
                    mode=AiMode.INVENTORY_QA,
                    prompt="低库存",
                    response="低库存提醒",
                    context={},
                    title="低库存",
                    summary="",
                    status="active",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-presence-card",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="低库存提醒",
                    content_type="parts",
                    parts=[
                        {
                            "id": "part-presence-card",
                            "type": "result_card",
                            "card": card,
                        }
                    ],
                    status="completed",
                    message_metadata={},
                    created_by=self.user.id,
                )
                db.add_all([conversation, message])
                db.commit()
                card_id = card["id"]

            response = self.client.post(
                "/api/ai/messages/message-presence-card/inventory-operation-draft",
                json={
                    "part_id": "part-presence-card",
                    "card_id": card_id,
                    "item_id": "ingredient-state:state-card-presence-low",
                    "action": "restock",
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            approval = next(
                part for part in response.json()["parts"]
                if part["type"] == "approval_request"
            )["approval"]

            decision = self.client.post(
                f"/api/ai/conversations/conversation-presence-card/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": approval["draft_version"],
                    "values": approval["initial_values"],
                },
            )
            self.assertEqual(decision.status_code, 200, decision.text)
            self.assertEqual(decision.json()["operation"]["status"], "succeeded")

            with self.SessionLocal() as db:
                state = db.get(IngredientInventoryState, "state-card-presence-low")
                self.assertIsNotNone(state)
                assert state is not None
                self.assertEqual(state.availability_level, InventoryAvailabilityLevel.PRESENT_UNKNOWN)
                stored_message = db.get(AIMessage, "message-presence-card")
                self.assertIsNotNone(stored_message)
                assert stored_message is not None
                refreshed = stored_message.parts[0]["card"]["data"]["items"][0]
                self.assertEqual(refreshed["id"], "ingredient-state:state-card-presence-low")
                self.assertEqual(refreshed["quantity"], "已有")
                self.assertEqual(refreshed["displayStatus"], "available")
                self.assertEqual(refreshed["lastOperation"]["action"], "restock")

        def test_depleted_ingredient_card_quick_action_creates_restock_draft_without_batch(self) -> None:
            with self.SessionLocal() as db:
                depleted = Ingredient(
                    id="ingredient-depleted-onion",
                    family_id=self.family.id,
                    name="洋葱",
                    category="蔬菜",
                    default_unit="个",
                    unit_conversions=[],
                    quantity_tracking_mode=IngredientQuantityTrackingMode.TRACK_QUANTITY,
                    default_storage="常温",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    default_low_stock_threshold=Decimal("2"),
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                conversation = AIConversation(
                    id="conversation-depleted-inventory-quick",
                    family_id=self.family.id,
                    owner_user_id=self.user.id,
                    visibility=AIConversationVisibility.PRIVATE,
                    mode=AiMode.INVENTORY_QA,
                    prompt="低库存",
                    response="低库存提醒",
                    context={},
                    title="低库存",
                    summary="",
                    status="active",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-depleted-inventory-quick",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="低库存提醒",
                    content_type="parts",
                    parts=[
                        {
                            "id": "part-depleted-inventory-card",
                            "type": "result_card",
                            "card": {
                                "id": "card-depleted-inventory",
                                "type": "inventory_summary",
                                "title": "低库存提醒",
                                "data": {
                                    "queryFocus": "low_stock",
                                    "availableCount": 0,
                                    "expiringCount": 0,
                                    "expiredCount": 0,
                                    "lowStockCount": 1,
                                    "foodStockCount": 0,
                                    "items": [
                                        {
                                            "id": f"ingredient:{depleted.id}",
                                            "sourceType": "ingredient",
                                            "inventoryItemId": None,
                                            "ingredientId": depleted.id,
                                            "foodId": None,
                                            "name": depleted.name,
                                            "image": None,
                                            "quantity": "0",
                                            "unit": depleted.default_unit,
                                            "quantityTrackingMode": "track_quantity",
                                            "status": "out_of_stock",
                                            "displayStatus": "low_stock",
                                            "expiryDate": None,
                                            "daysUntilExpiry": None,
                                            "lowStockThreshold": "2",
                                            "purchaseDate": "",
                                            "storageLocation": depleted.default_storage,
                                            "suggestedAction": "restock",
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
                db.add_all([depleted, conversation, message])
                db.commit()

            response = self.client.post(
                "/api/ai/messages/message-depleted-inventory-quick/inventory-operation-draft",
                json={
                    "part_id": "part-depleted-inventory-card",
                    "card_id": "card-depleted-inventory",
                    "item_id": "ingredient:ingredient-depleted-onion",
                    "action": "restock",
                },
            )

            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            approval = next(part for part in data["parts"] if part["type"] == "approval_request")["approval"]
            operation = approval["initial_values"]["draft"]["operations"][0]
            self.assertEqual(operation["ingredientId"], "ingredient-depleted-onion")
            self.assertIsNone(operation["inventoryItemId"])

        def test_ai_inventory_write_increments_row_version(self) -> None:
            with self.SessionLocal() as db:
                item = db.scalar(
                    select(InventoryItem)
                    .where(InventoryItem.id == "inventory-tomato")
                    .options(selectinload(InventoryItem.ingredient))
                )
                assert item is not None
                self.assertEqual(item.row_version, 1)
                result = dispose_inventory_quantity(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    item=item,
                    quantity=Decimal("1"),
                    unit="个",
                    reason="AI 测试销毁",
                )
                self.assertEqual(result["remaining_quantity"], 2.0)
                db.flush()
                db.commit()

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.disposed_quantity, Decimal("1.00"))
                self.assertEqual(item.row_version, 2)
                ingredient = db.get(Ingredient, "ingredient-tomato")
                assert ingredient is not None
                self.assertEqual(ingredient.row_version, 2)

            with self.SessionLocal() as db:
                from app.services.ai_operations.inventory import execute_inventory_operation_draft

                payload = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "consume",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 1,
                                "unit": "个",
                            }
                        ]
                    },
                )
                result, entity_ids = execute_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload=payload,
                )
                self.assertEqual(entity_ids, ["inventory-tomato"])
                self.assertEqual(result["operations"][0]["quantity"], 1.0)
                db.commit()

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.consumed_quantity, Decimal("1.00"))
                self.assertEqual(item.row_version, 3)
                ingredient = db.get(Ingredient, "ingredient-tomato")
                assert ingredient is not None
                self.assertEqual(ingredient.row_version, 3)

        def test_expired_snoozed_batch_remains_expired_in_ai_inventory_reads(self) -> None:
            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                today = today_for_family(self.family.id)
                item.expiry_date = today - timedelta(days=2)
                item.expiry_alert_snoozed_until = today + timedelta(days=5)
                db.commit()

                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-expired-snoozed",
                        run_id="run-expired-snoozed",
                    ),
                )
                expired = executor.call("inventory.read_expired_items", {"limit": 20})
                available = executor.call("inventory.read_available_items", {"limit": 20})
                expiring = executor.call("inventory.read_expiring_items", {"days": 7})

                expired_ids = {
                    record.get("inventoryItemId") or record.get("id")
                    for record in expired["items"]
                }
                expiring_ids = {
                    record.get("inventoryItemId") or record.get("id")
                    for record in expiring["items"]
                }
                self.assertIn("inventory-tomato", expired_ids)
                # Snooze does not move expired stock into the expiring window.
                self.assertNotIn("inventory-tomato", expiring_ids)
                tomato_record = next(
                    record
                    for record in expired["items"]
                    if (record.get("inventoryItemId") or record.get("id")) == "inventory-tomato"
                )
                self.assertEqual(tomato_record["displayStatus"], "expired")
                self.assertLess(tomato_record["daysUntilExpiry"], 0)

                # If the same row also appears in a broader remaining-stock listing,
                # AI still classifies it as expired; snooze never rewrites display status.
                available_tomato = [
                    record
                    for record in available["items"]
                    if (record.get("inventoryItemId") or record.get("id")) == "inventory-tomato"
                ]
                for record in available_tomato:
                    self.assertEqual(record["displayStatus"], "expired")
                    self.assertLess(record["daysUntilExpiry"], 0)

        def test_expired_snoozed_quantity_excluded_from_ai_low_stock_available_total(self) -> None:
            with self.SessionLocal() as db:
                today = today_for_family(self.family.id)
                tomato = db.get(InventoryItem, "inventory-tomato")
                assert tomato is not None
                tomato.quantity = Decimal("10")
                tomato.consumed_quantity = Decimal("0")
                tomato.disposed_quantity = Decimal("0")
                tomato.expiry_date = today - timedelta(days=1)
                tomato.expiry_alert_snoozed_until = today + timedelta(days=4)
                tomato.low_stock_threshold = Decimal("0")
                ingredient = db.get(Ingredient, "ingredient-tomato")
                assert ingredient is not None
                ingredient.default_low_stock_threshold = Decimal("2")
                create_inventory_batch(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    ingredient=ingredient,
                    quantity=Decimal("1"),
                    unit="个",
                    status=InventoryStatus.FRESH,
                    purchase_date=today,
                    expiry_date=today + timedelta(days=5),
                    storage_location="冷藏",
                    low_stock_threshold=Decimal("0"),
                )
                db.commit()

                from app.services.inventory_usage import (
                    inventory_remaining_in_default,
                    load_available_inventory_by_ingredient,
                )

                ingredient = db.get(Ingredient, "ingredient-tomato")
                assert ingredient is not None
                available = load_available_inventory_by_ingredient(
                    db,
                    family_id=self.family.id,
                    ingredient_ids=[ingredient.id],
                    today=today,
                ).get(ingredient.id, [])
                available_total = sum(
                    (inventory_remaining_in_default(item, ingredient) for item in available),
                    Decimal("0"),
                )
                # Expired snoozed 10 is excluded; only fresh 1 remains available.
                self.assertEqual(available_total, Decimal("1"))
                self.assertTrue(all(item.id != "inventory-tomato" for item in available))

        def test_ai_inventory_stale_data_error_maps_to_ai_conflict(self) -> None:
            from unittest.mock import patch

            from app.ai.errors import AIConflictError
            from app.services.ai_operations.inventory import execute_inventory_operation_draft
            from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
            from sqlalchemy.orm.exc import StaleDataError

            with self.SessionLocal() as db:
                def flush_raising_stale(*args, **kwargs):
                    raise StaleDataError(
                        "UPDATE statement on table 'inventory_items' expected to update 1 row(s); 0 were matched."
                    )

                payload = normalize_inventory_operation_draft(
                    db,
                    family_id=self.family.id,
                    payload={
                        "operations": [
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-tomato",
                                "inventoryItemId": "inventory-tomato",
                                "quantity": 1,
                                "unit": "个",
                                "reason": "冲突测试",
                            }
                        ]
                    },
                )
                with patch.object(type(db), "flush", flush_raising_stale):
                    with self.assertRaises(AIConflictError) as raised:
                        execute_inventory_operation_draft(
                            db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            payload=payload,
                        )
                self.assertEqual(str(raised.exception), STALE_INVENTORY_DETAIL)

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.disposed_quantity, Decimal("0"))
                self.assertEqual(item.row_version, 1)

        def test_recipe_cook_draft_captures_inventory_boundaries_and_rejects_stale_batch(self) -> None:
            from app.ai.errors import AIConflictError
            from app.ai.tools.draft_validation import normalize_recipe_cook_draft
            from app.services.ai_operations.recipe_cook import execute_recipe_cook_draft

            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-cook-versioned-preview",
                    family_id=self.family.id,
                    title="番茄快炒版本测试",
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
                        id="recipe-cook-versioned-preview-ingredient",
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
                draft = normalize_recipe_cook_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "schemaVersion": "recipe_cook_operation.v2",
                        "recipeId": recipe.id,
                        "servings": 1,
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                    },
                )

            boundary = draft["inventoryBoundaries"][0]
            self.assertEqual(boundary["ingredientId"], "ingredient-tomato")
            self.assertEqual(boundary["quantityTrackingMode"], "track_quantity")
            self.assertEqual(boundary["expectedIngredientRowVersion"], 1)
            self.assertEqual(boundary["batches"], [{"inventoryItemId": "inventory-tomato", "expectedRowVersion": 1}])
            self.assertNotIn("createMealLog", draft)

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.notes = "家人刚更新了番茄批次"
                db.commit()

            with self.SessionLocal() as db:
                with self.assertRaises(AIConflictError):
                        execute_recipe_cook_draft(
                            db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            payload=draft,
                            operation_idempotency_key="test:recipe.cook:v1",
                        )
                db.rollback()

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.consumed_quantity, Decimal("0"))
                self.assertIsNone(
                    db.scalar(select(RecipeCookLog).where(RecipeCookLog.recipe_id == "recipe-cook-versioned-preview"))
                )

        def test_recipe_cook_draft_captures_and_checks_presence_state_boundary(self) -> None:
            from app.ai.errors import AIConflictError
            from app.ai.tools.draft_validation import normalize_recipe_cook_draft
            from app.core.enums import InventoryAvailabilityLevel
            from app.models.domain import IngredientInventoryState
            from app.services.ai_operations.recipe_cook import execute_recipe_cook_draft

            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-recipe-presence",
                    family_id=self.family.id,
                    name="香醋",
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
                state = IngredientInventoryState(
                    id="state-recipe-presence",
                    family_id=self.family.id,
                    ingredient_id=ingredient.id,
                    availability_level=InventoryAvailabilityLevel.SUFFICIENT,
                    inventory_status=InventoryStatus.FRESH,
                    storage_location="常温",
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                recipe = Recipe(
                    id="recipe-cook-presence-boundary",
                    family_id=self.family.id,
                    title="凉拌香醋菜",
                    servings=1,
                    prep_minutes=5,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["凉菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([ingredient, state, recipe])
                db.flush()
                db.add(
                    RecipeIngredient(
                        id="recipe-cook-presence-boundary-ingredient",
                        recipe_id=recipe.id,
                        ingredient_id=ingredient.id,
                        ingredient_name=ingredient.name,
                        quantity=1,
                        unit="瓶",
                        note="少量",
                        sort_order=0,
                    )
                )
                db.commit()
                draft = normalize_recipe_cook_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "schemaVersion": "recipe_cook_operation.v2",
                        "recipeId": recipe.id,
                        "servings": 1,
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                    },
                )

            boundary = draft["inventoryBoundaries"][0]
            self.assertEqual(boundary["quantityTrackingMode"], "not_track_quantity")
            self.assertEqual(boundary["stateId"], "state-recipe-presence")
            self.assertEqual(boundary["expectedStateRowVersion"], 1)
            self.assertEqual(boundary["batches"], [])
            self.assertNotIn("createMealLog", draft)

            with self.SessionLocal() as db:
                state = db.get(IngredientInventoryState, "state-recipe-presence")
                assert state is not None
                state.notes = "家人刚确认过"
                db.commit()

            with self.SessionLocal() as db:
                with self.assertRaises(AIConflictError):
                        execute_recipe_cook_draft(
                            db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            payload=draft,
                            operation_idempotency_key="test:recipe.cook:v1",
                        )
                db.rollback()

        def test_recipe_cook_approval_protects_target_servings_plan_and_inventory_preview(self) -> None:
            from app.ai.tools.draft_validation import normalize_recipe_cook_draft

            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-cook-protected-approval",
                    family_id=self.family.id,
                    title="番茄快炒审批测试",
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
                        id="recipe-cook-protected-approval-ingredient",
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
                original = normalize_recipe_cook_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "schemaVersion": "recipe_cook_operation.v2",
                        "recipeId": recipe.id,
                        "servings": 1,
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                    },
                )

            editable = json.loads(json.dumps(original))
            editable["date"] = (date.today() + timedelta(days=1)).isoformat()
            editable["mealType"] = "lunch"
            editable["notes"] = "少油"
            draft_operation_registry.validate_approval_value("recipe_cook", original, editable)

            for key, value in (
                ("recipeId", "recipe-other"),
                ("baseUpdatedAt", "2020-01-01T00:00:00Z"),
                ("servings", 2),
                ("planItemId", "plan-other"),
            ):
                tampered = json.loads(json.dumps(original))
                tampered[key] = value
                with self.assertRaisesRegex(ValueError, "不能在确认阶段修改"):
                    draft_operation_registry.validate_approval_value("recipe_cook", original, tampered)

            tampered_boundary = json.loads(json.dumps(original))
            tampered_boundary["inventoryBoundaries"][0]["expectedIngredientRowVersion"] += 1
            with self.assertRaisesRegex(ValueError, "不能在确认阶段修改"):
                draft_operation_registry.validate_approval_value("recipe_cook", original, tampered_boundary)

            tampered_preview = json.loads(json.dumps(original))
            tampered_preview["previewItems"][0]["batches"][0]["quantity"] = 0.1
            with self.assertRaisesRegex(ValueError, "不能在确认阶段修改"):
                draft_operation_registry.validate_approval_value("recipe_cook", original, tampered_preview)

        def test_recipe_cook_approval_phase_normalization_preserves_proposal_versions(self) -> None:
            from app.ai.errors import AIConflictError
            from app.ai.tools.draft_validation import normalize_recipe_cook_draft
            from app.services.ai_operations.drafts import normalize_ai_draft_payload
            from app.services.ai_operations.recipe_cook import execute_recipe_cook_draft

            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-cook-approval-phase",
                    family_id=self.family.id,
                    title="番茄快炒审批阶段测试",
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
                        id="recipe-cook-approval-phase-ingredient",
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
                proposal = normalize_recipe_cook_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "schemaVersion": "recipe_cook_operation.v2",
                        "recipeId": recipe.id,
                        "servings": 1,
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                    },
                )

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.notes = "审批前由家人更新"
                db.commit()

            with self.SessionLocal() as db:
                submitted = normalize_ai_draft_payload(
                    db,
                    draft_type="recipe_cook",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-recipe-cook-approval-phase",
                    payload=proposal,
                    phase="approval",
                )
                self.assertEqual(
                    submitted["inventoryBoundaries"][0]["batches"][0]["expectedRowVersion"],
                    1,
                )
                self.assertNotIn("createMealLog", submitted)
                with self.assertRaises(AIConflictError):
                        execute_recipe_cook_draft(
                            db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            payload=submitted,
                            operation_idempotency_key="test:recipe.cook:v1",
                        )
                db.rollback()

        def test_ai_recipe_cook_stale_data_error_maps_to_ai_conflict(self) -> None:
            from unittest.mock import patch

            from app.ai.errors import AIConflictError
            from app.ai.tools.draft_validation import normalize_recipe_cook_draft
            from app.services.ai_operations.recipe_cook import execute_recipe_cook_draft
            from app.services.inventory_expiry_actions import STALE_INVENTORY_DETAIL
            from sqlalchemy.orm.exc import StaleDataError

            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-ai-stale-cook",
                    family_id=self.family.id,
                    title="番茄炒蛋",
                    servings=2,
                    prep_minutes=10,
                    difficulty="easy",
                    tips="",
                    scene_tags=[],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(recipe)
                db.flush()
                db.add_all(
                    [
                        RecipeIngredient(
                            id="recipe-ingredient-ai-stale-tomato",
                            recipe_id=recipe.id,
                            ingredient_id="ingredient-tomato",
                            ingredient_name="番茄",
                            quantity=Decimal("1"),
                            unit="个",
                            note="",
                            sort_order=0,
                        ),
                    ]
                )
                db.commit()
                payload = normalize_recipe_cook_draft(
                    db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    payload={
                        "schemaVersion": "recipe_cook_operation.v2",
                        "recipeId": recipe.id,
                        "servings": 2,
                    },
                )

            with self.SessionLocal() as db:
                def flush_raising_stale(*args, **kwargs):
                    raise StaleDataError(
                        "UPDATE statement on table 'inventory_items' expected to update 1 row(s); 0 were matched."
                    )

                with patch.object(type(db), "flush", flush_raising_stale):
                    with self.assertRaises(AIConflictError) as raised:
                        execute_recipe_cook_draft(
                            db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            payload=payload,
                            operation_idempotency_key="test:recipe.cook:v1",
                        )
                self.assertEqual(str(raised.exception), STALE_INVENTORY_DETAIL)

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                self.assertEqual(item.consumed_quantity, Decimal("0"))
                self.assertEqual(item.row_version, 1)
