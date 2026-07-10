from sqlalchemy import func

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


class RecipeShortageShoppingProvider(BaseChatProvider):
    model_name = "recipe-shortage-shopping"

    def __init__(self, *, recipe_id: str) -> None:
        self.recipe_id = recipe_id
        self.calls = 0
        self.read_ingredient_ids: list[str] = []

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
            tool_handler("skill.inject", {"skills": ["recipe_cook"], "reason": "预览菜谱缺料"})
            available = {tool.name for tool in (tools() if callable(tools) else tools)}
            assert "recipe.preview_cook" in available
            result = tool_handler(
                "recipe.preview_cook",
                {"recipeId": self.recipe_id, "servings": 2},
            )
            assert result.get("card", {}).get("type") == "recipe_shortage", result
            return ChatProviderResult(
                text="这道菜有缺料，可以先加入购物清单。",
                status="completed",
                model=self.model_name,
            )

        if self.calls == 2:
            artifact = next(
                item
                for item in reversed(payload.get("artifacts") or [])
                if item.get("type") == "recipe_shortage"
            )
            continuation = artifact["payload"]["continuation"]
            tool_handler("skill.inject", {"skills": ["shopping_list"], "reason": "生成缺料购物建议"})
            available = {tool.name for tool in (tools() if callable(tools) else tools)}
            assert "shopping.create_draft" in available
            pending = tool_handler("shopping.read_pending", {"limit": 50})
            pending_ids = {
                item.get("ingredientId")
                for item in pending.get("items") or []
                if isinstance(item, dict)
            }
            items = []
            for shortage in continuation["state"]["shortages"]:
                ingredient_id = shortage["ingredientId"]
                ingredient = tool_handler("ingredient.read_by_id", {"id": ingredient_id})["item"]
                self.read_ingredient_ids.append(ingredient["id"])
                if ingredient_id in pending_ids:
                    continue
                item = {
                    "ingredientId": ingredient["id"],
                    "title": ingredient["name"],
                    "reason": "菜谱缺料",
                    "sourceMeals": [],
                    "alreadyPending": False,
                }
                if shortage["shortageType"] == "presence":
                    item.update(
                        {
                            "quantityMode": "not_track_quantity",
                            "displayLabel": "需要补充",
                        }
                    )
                else:
                    item.update(
                        {
                            "quantity": float(shortage["quantity"]),
                            "unit": shortage["unit"],
                        }
                    )
                items.append(item)
            tool_handler(
                "shopping.create_draft",
                {
                    "draft": {
                        "draftType": "shopping_list",
                        "schemaVersion": "shopping_list.v1",
                        "items": items,
                    }
                },
            )
            return ChatProviderResult(
                text="已整理缺料购物清单，确认后才会加入待采购。",
                status="waiting_approval",
                model=self.model_name,
            )

        return ChatProviderResult(
            text="购物清单已确认，本次不会自动重试做菜。",
            status="completed",
            model=self.model_name,
        )


class AIProductClosedLoopsTestCase(AIAgentInfraTestCase):
    def _inventory_intake_executor(self, db):
        return ToolExecutor(
            build_workspace_tool_registry(),
            ToolContext(
                db=db,
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-intake-preview",
                run_id="run-intake-preview",
            ),
        )

    def test_inventory_intake_preview_rejects_unknown_ingredient_id(self) -> None:
        with self.SessionLocal() as db:
            executor = self._inventory_intake_executor(db)

            with self.assertRaisesRegex(ValueError, "ingredient_not_found"):
                executor.call(
                    "inventory.preview_intake_candidates",
                    {
                        "items": [
                            {
                                "ingredientId": "ingredient-made-up",
                                "quantity": "1",
                                "unit": "盒",
                            }
                        ],
                        "unresolvedLabels": [],
                    },
                )

    def test_inventory_intake_preview_returns_review_card_without_writing_inventory(self) -> None:
        with self.SessionLocal() as db:
            executor = self._inventory_intake_executor(db)
            before_count = db.scalar(select(func.count()).select_from(InventoryItem))

            result = executor.call(
                "inventory.preview_intake_candidates",
                {
                    "items": [
                        {
                            "ingredientId": "ingredient-tomato",
                            "quantity": "2",
                            "unit": "个",
                            "confidence": 0.93,
                            "sourceLabel": "小票上的番茄",
                        },
                        {
                            "ingredientId": "ingredient-tomato",
                            "quantity": "5",
                            "unit": "个",
                        },
                    ],
                    "unresolvedLabels": ["紫苏", "紫苏"],
                },
            )

            self.assertEqual(result["card"]["type"], "inventory_intake_candidates")
            self.assertEqual(result["card"]["data"]["items"][0]["ingredientId"], "ingredient-tomato")
            self.assertEqual(result["card"]["data"]["items"][0]["quantity"], "2")
            self.assertEqual(result["card"]["data"]["unresolvedLabels"], ["紫苏"])
            self.assertEqual(db.scalar(select(func.count()).select_from(InventoryItem)), before_count)
            from app.ai.workflows.result_cards import validate_result_cards

            self.assertEqual(validate_result_cards([result["card"]])[0]["type"], "inventory_intake_candidates")
            invalid_card = {
                **result["card"],
                "data": {
                    **result["card"]["data"],
                    "items": [
                        {
                            **result["card"]["data"]["items"][0],
                            "unvalidatedLabel": "模型自造名称",
                        }
                    ],
                },
            }
            with self.assertRaisesRegex(Exception, "extra_forbidden|Extra inputs"):
                validate_result_cards([invalid_card])

    def test_inventory_intake_missing_ingredient_state_preserves_resolved_candidates(self) -> None:
        from app.ai.skills.state_schemas import validate_continuation_state

        state = validate_continuation_state(
            "inventory_missing_ingredient.v1",
            {
                "currentLabel": "紫苏",
                "pendingLabels": ["香菜"],
                "resolvedItems": [
                    {
                        "ingredientId": "ingredient-tomato",
                        "quantity": "2",
                        "unit": "个",
                    }
                ],
            },
        )

        self.assertEqual(state["currentLabel"], "紫苏")
        self.assertEqual(state["resolvedItems"][0]["ingredientId"], "ingredient-tomato")

    def test_inventory_backed_meal_idea_card_uses_only_real_ingredient_ids(self) -> None:
        with self.SessionLocal() as db:
            executor = self._inventory_intake_executor(db)

            result = executor.call(
                "meal_plan.propose_from_inventory",
                {
                    "title": "番茄清汤",
                    "ingredientIds": ["ingredient-tomato", "ingredient-tomato"],
                    "reason": "现有番茄库存可以先做一道清爽汤品",
                    "preparationSummary": "番茄切块后煮出汤汁。",
                },
            )

            card = result["card"]
            self.assertEqual(card["type"], "meal_idea_proposal")
            self.assertEqual(card["data"]["ingredientIds"], ["ingredient-tomato"])
            self.assertNotIn("foodId", card["data"])
            self.assertNotIn("recipeId", card["data"])
            self.assertTrue(card["data"]["ingredients"][0]["available"])
            from app.ai.workflows.result_cards import validate_result_cards

            self.assertEqual(validate_result_cards([card])[0]["type"], "meal_idea_proposal")
            with self.assertRaisesRegex(Exception, "extra_forbidden|Extra inputs"):
                validate_result_cards(
                    [
                        {
                            **card,
                            "data": {**card["data"], "recipeId": "recipe-made-up"},
                        }
                    ]
                )

    def test_inventory_backed_meal_idea_rejects_unknown_ingredient_id(self) -> None:
        with self.SessionLocal() as db:
            executor = self._inventory_intake_executor(db)

            with self.assertRaisesRegex(ValueError, "ingredient_not_found"):
                executor.call(
                    "meal_plan.propose_from_inventory",
                    {
                        "title": "不存在的菜",
                        "ingredientIds": ["ingredient-secret"],
                        "reason": "不应跨家庭读取",
                    },
                )

    def test_product_loop_subjects_reject_tampered_shapes(self) -> None:
        from app.schemas.ai import AISubjectIn

        valid = AISubjectIn.model_validate(
            {
                "source": "meal_idea_proposal",
                "ingredient_ids": ["ingredient-tomato"],
                "extra": {
                    "mealIdea": {
                        "schemaVersion": "meal_idea_subject.v1",
                        "title": "番茄清汤",
                        "ingredientIds": ["ingredient-tomato"],
                        "reason": "使用当前库存",
                        "preparationSummary": "煮汤",
                    }
                },
            }
        )
        self.assertEqual(valid.extra["mealIdea"]["ingredientIds"], ["ingredient-tomato"])

        with self.assertRaisesRegex(Exception, "ingredient_ids must match"):
            AISubjectIn.model_validate(
                {
                    "source": "meal_idea_proposal",
                    "ingredient_ids": ["ingredient-secret"],
                    "extra": {
                        "mealIdea": {
                            "schemaVersion": "meal_idea_subject.v1",
                            "title": "番茄清汤",
                            "ingredientIds": ["ingredient-tomato"],
                            "reason": "使用当前库存",
                        }
                    },
                }
            )

    @staticmethod
    def _meal_log_stock_payload(food: Food, *, quantity: str = "1", unit: str = "份") -> dict:
        return {
            "draftType": "meal_log",
            "schemaVersion": "meal_log.v1",
            "date": date.today().isoformat(),
            "mealType": "dinner",
            "participantUserIds": [],
            "foods": [
                {
                    "foodId": food.id,
                    "name": food.name,
                    "servings": 1,
                    "note": "",
                    "deductStock": True,
                    "stockQuantity": quantity,
                    "stockUnit": unit,
                }
            ],
            "notes": "AI 餐食记录",
            "mood": "",
            "mediaIds": [],
        }

    def test_approved_meal_log_can_consume_ready_food_stock(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-meal-stock-ready",
                family_id=self.family.id,
                name="即食鸡胸",
                type=FoodType.READY_MADE,
                category="即食",
                flavor_tags=[],
                scene_tags=["晚餐"],
                suitable_meal_types=["dinner"],
                scene="晚餐",
                notes="",
                routine_note="",
                stock_quantity=Decimal("3"),
                stock_unit="份",
                storage_location="冷藏",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(food)
            db.flush()
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="meal_log",
                payload=self._meal_log_stock_payload(food),
                suffix="meal-stock-success",
            )
            self.assertEqual(
                draft.payload["foods"][0],
                {
                    "foodId": food.id,
                    "name": food.name,
                    "foodType": "readyMade",
                    "servings": 1.0,
                    "note": "",
                    "rating": None,
                    "deductStock": True,
                    "stockQuantity": "1",
                    "stockUnit": "份",
                    "stockCurrentQuantity": "3",
                    "stockAfterQuantity": "2",
                },
            )

            result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            self.assertEqual(result["operation"]["status"], "succeeded")
            db.refresh(food)
            self.assertEqual(food.stock_quantity, Decimal("2"))
            self.assertEqual(db.scalar(select(func.count()).select_from(MealLog)), 1)

    def test_ready_food_in_meal_log_does_not_consume_stock_by_default(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-meal-stock-default-off",
                family_id=self.family.id,
                name="常温牛奶",
                type=FoodType.PACKAGED,
                category="乳品",
                flavor_tags=[],
                scene_tags=["早餐"],
                suitable_meal_types=["breakfast"],
                scene="早餐",
                notes="",
                routine_note="",
                stock_quantity=Decimal("6"),
                stock_unit="盒",
                storage_location="常温",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(food)
            db.flush()
            payload = self._meal_log_stock_payload(food, unit="盒")
            payload["foods"][0].pop("deductStock")
            payload["foods"][0].pop("stockQuantity")
            payload["foods"][0].pop("stockUnit")
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="meal_log",
                payload=payload,
                suffix="meal-stock-default-off",
            )

            result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            self.assertEqual(result["operation"]["status"], "succeeded")
            db.refresh(food)
            self.assertEqual(food.stock_quantity, Decimal("6"))
            self.assertFalse(draft.payload["foods"][0]["deductStock"])

    def test_meal_log_rejects_ready_food_stock_unit_mismatch(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-meal-stock-unit",
                family_id=self.family.id,
                name="速食燕麦杯",
                type=FoodType.INSTANT,
                category="早餐",
                flavor_tags=[],
                scene_tags=["早餐"],
                suitable_meal_types=["breakfast"],
                scene="早餐",
                notes="",
                routine_note="",
                stock_quantity=Decimal("2"),
                stock_unit="杯",
                storage_location="常温",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(food)
            db.flush()

            with self.assertRaisesRegex(ValueError, "当前库存单位是 杯"):
                self._create_ai_approval_for_test(
                    db,
                    draft_type="meal_log",
                    payload=self._meal_log_stock_payload(food, unit="份"),
                    suffix="meal-stock-unit",
                )

    def test_meal_log_rejects_stock_deduction_for_recipe_food(self) -> None:
        with self.SessionLocal() as db:
            food = db.get(Food, "food-tomato")
            assert food is not None

            with self.assertRaisesRegex(ValueError, "只有成品、速食或包装食品"):
                self._create_ai_approval_for_test(
                    db,
                    draft_type="meal_log",
                    payload=self._meal_log_stock_payload(food),
                    suffix="meal-stock-recipe-food",
                )

    def test_meal_log_and_ready_food_deduction_roll_back_together(self) -> None:
        with self.SessionLocal() as db:
            food = Food(
                id="food-meal-stock-race",
                family_id=self.family.id,
                name="盒装酸奶",
                type=FoodType.READY_MADE,
                category="乳品",
                flavor_tags=[],
                scene_tags=["早餐"],
                suitable_meal_types=["breakfast"],
                scene="早餐",
                notes="",
                routine_note="",
                stock_quantity=Decimal("3"),
                stock_unit="盒",
                storage_location="冷藏",
                favorite=False,
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add(food)
            db.flush()
            service, draft, approval = self._create_ai_approval_for_test(
                db,
                draft_type="meal_log",
                payload=self._meal_log_stock_payload(food, unit="盒"),
                suffix="meal-stock-rollback",
            )
            food.stock_quantity = Decimal("0")
            db.flush()

            result = self._approve_ai_approval_for_test(service, draft=draft, approval=approval)

            self.assertEqual(result["operation"]["status"], "failed")
            self.assertEqual(db.scalar(select(func.count()).select_from(MealLog)), 0)
            db.refresh(food)
            self.assertEqual(food.stock_quantity, Decimal("0"))
            self.assertEqual(result["draft"]["status"], "pending_retry")

    def test_recipe_shortage_card_preserves_quantitative_and_presence_ids(self) -> None:
        from app.ai.tools.catalog.recipe import recipe_preview_cook
        from app.ai.workflows.compact_context import compact_artifacts

        with self.SessionLocal() as db:
            herb = Ingredient(
                id="ingredient-presence-herb",
                family_id=self.family.id,
                name="香菜",
                category="调味",
                default_unit="份",
                unit_conversions=[],
                quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
            )
            recipe = Recipe(
                id="recipe-shortage-shopping",
                family_id=self.family.id,
                title="番茄香菜汤",
                servings=2,
                prep_minutes=15,
                difficulty=Difficulty.EASY,
                tips="",
                scene_tags=["家常菜"],
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([herb, recipe])
            db.flush()
            db.add_all(
                [
                    RecipeIngredient(
                        id="recipe-shortage-tomato",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=Decimal("5"),
                        unit="个",
                        note="",
                        sort_order=0,
                    ),
                    RecipeIngredient(
                        id="recipe-shortage-herb",
                        recipe_id=recipe.id,
                        ingredient_id=herb.id,
                        ingredient_name=herb.name,
                        quantity=Decimal("1"),
                        unit="份",
                        note="少许",
                        sort_order=1,
                    ),
                ]
            )
            db.flush()
            result = recipe_preview_cook(
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    run_id="run-recipe-shortage",
                ),
                {"recipeId": recipe.id, "servings": 2},
            )

        card = result["card"]
        self.assertEqual(card["type"], "recipe_shortage")
        continuation = card["data"]["continuation"]
        self.assertEqual(continuation["stateSchema"], "recipe_shortage_to_shopping.v1")
        self.assertEqual(continuation["nextSkillKey"], "shopping_list")
        self.assertEqual(continuation["state"]["recipeId"], recipe.id)
        shortages = continuation["state"]["shortages"]
        self.assertEqual(
            {row["ingredientId"] for row in shortages},
            {"ingredient-tomato", herb.id},
        )
        tomato = next(row for row in shortages if row["ingredientId"] == "ingredient-tomato")
        self.assertEqual(tomato["shortageType"], "quantity")
        self.assertEqual(tomato["quantity"], "2")
        self.assertEqual(tomato["unit"], "个")
        presence = next(row for row in shortages if row["ingredientId"] == herb.id)
        self.assertEqual(presence["shortageType"], "presence")
        self.assertNotIn("quantity", presence)
        self.assertNotIn("unit", presence)

        compacted = compact_artifacts(
            [
                {
                    "id": card["id"],
                    "type": card["type"],
                    "kind": "result_card",
                    "status": "proposed",
                    "payload": card["data"],
                }
            ]
        )[0]
        compact_continuation = compacted["payload"]["continuation"]
        self.assertEqual(compact_continuation["stateSchema"], "recipe_shortage_to_shopping.v1")
        self.assertEqual(compact_continuation["state"], continuation["state"])

    def test_recipe_shortage_normal_turn_creates_shopping_only_after_approval(self) -> None:
        with self.SessionLocal() as db:
            herb = Ingredient(
                id="ingredient-e2e-presence-herb",
                family_id=self.family.id,
                name="香菜",
                category="调味",
                default_unit="份",
                unit_conversions=[],
                quantity_tracking_mode=IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
                default_storage="冷藏",
                default_expiry_mode=IngredientExpiryMode.NONE,
                notes="",
            )
            recipe = Recipe(
                id="recipe-e2e-shortage-shopping",
                family_id=self.family.id,
                title="番茄香菜汤",
                servings=2,
                prep_minutes=15,
                difficulty=Difficulty.EASY,
                tips="",
                scene_tags=["家常菜"],
                created_by=self.user.id,
                updated_by=self.user.id,
            )
            db.add_all([herb, recipe])
            db.flush()
            db.add_all(
                [
                    RecipeIngredient(
                        id="recipe-e2e-shortage-tomato",
                        recipe_id=recipe.id,
                        ingredient_id="ingredient-tomato",
                        ingredient_name="番茄",
                        quantity=Decimal("5"),
                        unit="个",
                        note="",
                        sort_order=0,
                    ),
                    RecipeIngredient(
                        id="recipe-e2e-shortage-herb",
                        recipe_id=recipe.id,
                        ingredient_id=herb.id,
                        ingredient_name=herb.name,
                        quantity=Decimal("1"),
                        unit="份",
                        note="少许",
                        sort_order=1,
                    ),
                ]
            )
            db.commit()
            provider = RecipeShortageShoppingProvider(recipe_id=recipe.id)

        with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
            preview_response = self.client.post(
                "/api/ai/chat",
                json={"message": "预览番茄香菜汤够不够做"},
            )
            self.assertEqual(preview_response.status_code, 200, preview_response.text)
            preview_data = preview_response.json()
            self.assertEqual(
                [card["type"] for card in preview_data["included"]["result_cards"]],
                ["recipe_shortage"],
            )
            shopping_response = self.client.post(
                "/api/ai/chat",
                json={
                    "message": "把缺少的食材加入购物清单",
                    "conversation_id": preview_data["conversation_id"],
                },
            )
            self.assertEqual(shopping_response.status_code, 200, shopping_response.text)
            shopping_data = shopping_response.json()
            approval = shopping_data["included"]["approvals"][0]

            with self.SessionLocal() as db:
                self.assertEqual(db.scalar(select(func.count()).select_from(ShoppingListItem)), 0)
                self.assertEqual(db.scalar(select(func.count()).select_from(RecipeCookLog)), 0)
                inventory = db.get(InventoryItem, "inventory-tomato")
                assert inventory is not None
                self.assertEqual(inventory.consumed_quantity, Decimal("0"))

            with self.client.stream(
                "POST",
                f"/api/ai/conversations/{shopping_data['conversation_id']}/approvals/{approval['id']}/decision/stream",
                json={
                    "decision": "approved",
                    "draft_version": approval["draft_version"],
                    "values": approval["initial_values"],
                },
            ) as stream_response:
                self.assertEqual(stream_response.status_code, 200)
                "".join(stream_response.iter_text())

        self.assertEqual(provider.calls, 3)
        self.assertEqual(
            set(provider.read_ingredient_ids),
            {"ingredient-tomato", herb.id},
        )
        with self.SessionLocal() as db:
            shopping_items = list(db.scalars(select(ShoppingListItem).order_by(ShoppingListItem.title)))
            self.assertEqual(len(shopping_items), 2)
            presence = next(item for item in shopping_items if item.ingredient_id == herb.id)
            self.assertEqual(
                presence.quantity_mode,
                IngredientQuantityTrackingMode.NOT_TRACK_QUANTITY,
            )
            self.assertEqual(presence.display_label, "需要补充")
            self.assertEqual(db.scalar(select(func.count()).select_from(RecipeCookLog)), 0)
            inventory = db.get(InventoryItem, "inventory-tomato")
            assert inventory is not None
            self.assertEqual(inventory.consumed_quantity, Decimal("0"))

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
