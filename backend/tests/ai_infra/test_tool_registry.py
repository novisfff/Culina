from ._support import *

from app.ai.errors import AIExecutionCancelled
from app.ai.tools.base import ToolDefinition
from app.ai.tools.registry import ToolRegistry
from app.services.search.documents import build_food_search_document, build_ingredient_search_document, build_recipe_search_document
from app.services.search.indexing import upsert_search_document


class AIToolRegistryTestCase(AIAgentInfraTestCase):
        def test_batch_resolution_keeps_semantic_matches_as_candidates(self) -> None:
            with self.SessionLocal() as db:
                egg = self._add_egg_ingredient(db)
                tofu = Ingredient(
                    id="ingredient-resolution-tofu",
                    family_id=self.family.id,
                    name="北豆腐",
                    category="豆制品",
                    default_unit="块",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(tofu)
                db.flush()

                def fake_hybrid_search(_db, *, query, **_kwargs):
                    ids = [egg.id] if query == "蛋类候选" else [egg.id, tofu.id]
                    return SimpleNamespace(
                        items=[
                            SimpleNamespace(
                                entity_type="ingredient",
                                entity_id=entity_id,
                                match_reason=["语义召回"],
                            )
                            for entity_id in ids
                        ]
                    )

                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-resolution-semantic",
                        run_id="run-resolution-semantic",
                    ),
                )
                with patch(
                    "app.ai.tools.catalog.resolution.hybrid_search",
                    side_effect=fake_hybrid_search,
                ):
                    output = executor.call(
                        "ingredient.resolve_candidates",
                        {
                            "items": [
                                {"clientKey": "one", "name": "蛋类候选"},
                                {"clientKey": "many", "name": "早餐候选"},
                            ]
                        },
                    )

            self.assertEqual(output["results"][0]["status"], "candidate")
            self.assertEqual(output["results"][0]["candidates"][0]["matchType"], "semantic")
            self.assertEqual(output["results"][1]["status"], "ambiguous")

        def test_batch_candidate_resolution_is_read_only_bounded_and_family_scoped(self) -> None:
            with self.SessionLocal() as db:
                ready_food = Food(
                    id="food-resolution-yogurt",
                    family_id=self.family.id,
                    name="原味酸奶",
                    type=FoodType.READY_MADE,
                    category="乳制品",
                    flavor_tags=[],
                    scene_tags=[],
                    suitable_meal_types=["breakfast"],
                    source_name="",
                    purchase_source="",
                    scene="",
                    notes="",
                    routine_note="",
                    stock_quantity=Decimal("2"),
                    stock_unit="盒",
                    storage_location="冷藏",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_ready_food = Food(
                    id="food-resolution-secret",
                    family_id=self.other_family.id,
                    name="其他家庭酸奶",
                    type=FoodType.READY_MADE,
                    category="乳制品",
                    flavor_tags=[],
                    scene_tags=[],
                    suitable_meal_types=["breakfast"],
                    source_name="",
                    purchase_source="",
                    scene="",
                    notes="",
                    routine_note="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([ready_food, other_ready_food])
                db.flush()
                registry = build_workspace_tool_registry()
                executor = ToolExecutor(
                    registry,
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-resolution",
                        run_id="run-resolution",
                    ),
                )

                ingredient_result = executor.call(
                    "ingredient.resolve_candidates",
                    {
                        "items": [
                            {"clientKey": "tomato", "name": "番茄"},
                            {"clientKey": "secret", "name": "其他家庭牛排"},
                            {"clientKey": "missing", "name": "不存在食材"},
                        ]
                    },
                )
                purchasable_result = executor.call(
                    "purchasable.resolve_candidates",
                    {
                        "items": [
                            {"clientKey": "yogurt", "name": "原味酸奶"},
                            {"clientKey": "tomato", "name": "番茄"},
                            {"clientKey": "secret", "name": "其他家庭酸奶"},
                        ]
                    },
                )

                self.assertEqual(registry.get("ingredient.resolve_candidates").side_effect, "read")
                self.assertEqual(registry.get("ingredient.resolve_candidates").draft_types, [])
                self.assertEqual(registry.get("purchasable.resolve_candidates").side_effect, "read")
                self.assertEqual(ingredient_result["results"][0]["status"], "exact")
                self.assertEqual(ingredient_result["results"][0]["candidates"][0]["id"], "ingredient-tomato")
                self.assertEqual(ingredient_result["results"][1]["status"], "missing")
                self.assertEqual(ingredient_result["results"][2]["status"], "missing")
                self.assertEqual(purchasable_result["results"][0]["status"], "exact")
                self.assertEqual(purchasable_result["results"][0]["candidates"][0]["id"], ready_food.id)
                self.assertEqual(purchasable_result["results"][1]["status"], "exact")
                self.assertEqual(purchasable_result["results"][1]["candidates"][0]["id"], "ingredient-tomato")
                self.assertEqual(purchasable_result["results"][2]["status"], "missing")
                self.assertTrue(
                    all(
                        item["status"] in {"exact", "candidate", "ambiguous", "missing"}
                        for item in [*ingredient_result["results"], *purchasable_result["results"]]
                    )
                )
                returned_ids = {
                    candidate["id"]
                    for result in [*ingredient_result["results"], *purchasable_result["results"]]
                    for candidate in result["candidates"]
                }
                self.assertNotIn("ingredient-secret", returned_ids)
                self.assertNotIn(other_ready_food.id, returned_ids)

                with self.assertRaisesRegex(ValueError, "at most 30 items"):
                    executor.call(
                        "ingredient.resolve_candidates",
                        {
                            "items": [
                                {"clientKey": f"item-{index}", "name": f"食材 {index}"}
                                for index in range(31)
                            ]
                        },
                    )

        def test_catalog_search_tools_use_hybrid_search_documents_for_query(self) -> None:
            with self.SessionLocal() as db:
                ingredient = Ingredient(
                    id="ingredient-hybrid-note",
                    family_id=self.family.id,
                    name="白萝卜",
                    category="蔬菜",
                    default_unit="根",
                    unit_conversions=[],
                    default_storage="冷藏",
                    default_expiry_mode=IngredientExpiryMode.NONE,
                    notes="适合清润汤水",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                food = Food(
                    id="food-hybrid-routine",
                    family_id=self.family.id,
                    name="原味酸奶",
                    type=FoodType.READY_MADE,
                    category="乳制品",
                    flavor_tags=[],
                    scene_tags=[],
                    suitable_meal_types=["snack"],
                    source_name="",
                    purchase_source="",
                    scene="",
                    notes="",
                    routine_note="运动后加餐",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                recipe = Recipe(
                    id="recipe-hybrid-ingredient",
                    family_id=self.family.id,
                    title="家常蒸蛋",
                    servings=2,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["早餐"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                recipe.ingredient_items = [
                    RecipeIngredient(
                        id="recipe-ingredient-hybrid",
                        recipe_id=recipe.id,
                        ingredient_id=None,
                        ingredient_name="紫苏叶",
                        quantity=Decimal("1"),
                        unit="把",
                        note="切碎",
                        sort_order=0,
                    )
                ]
                db.add_all([ingredient, food, recipe])
                db.flush()
                upsert_search_document(db, build_ingredient_search_document(ingredient))
                upsert_search_document(db, build_food_search_document(food))
                upsert_search_document(db, build_recipe_search_document(recipe))
                db.flush()
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-hybrid-tool-search",
                        run_id="run-hybrid-tool-search",
                    ),
                )

                ingredient_result = executor.call("ingredient.search", {"query": "清润汤水", "limit": 5})
                food_result = executor.call("food.search", {"query": "运动后", "limit": 5})
                recipe_result = executor.call("recipe.search", {"query": "紫苏叶", "limit": 5})

            self.assertEqual([item["id"] for item in ingredient_result["items"]], [ingredient.id])
            self.assertIn("score", ingredient_result["items"][0])
            self.assertIn("matchReason", ingredient_result["items"][0])
            self.assertIn("degraded", ingredient_result)
            self.assertEqual([item["id"] for item in food_result["items"]], [food.id])
            self.assertEqual([item["id"] for item in recipe_result["items"]], [recipe.id])

        def test_phase_a_tool_executor_records_real_tool_calls(self) -> None:
            with self.SessionLocal() as db:
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
                output = executor.call("inventory.read_expiring_items", {"days": 7})
                records = executor.records()

            self.assertEqual(output["count"], 1)
            self.assertEqual(records[0]["name"], "inventory.read_expiring_items")
            self.assertEqual(records[0]["permission"], "family:read")
            self.assertEqual(records[0]["side_effect"], "read")
            self.assertEqual(records[0]["status"], "completed")
            self.assertEqual(records[0]["output_summary"]["count"], 1)

        def test_human_request_input_tool_normalizes_request_and_waiting_progress(self) -> None:
            progress_events: list[dict] = []
            with self.SessionLocal() as db:
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        stream_writer=progress_events.append,
                    ),
                )
                output = executor.call(
                    "human.request_input",
                    {
                        "question": "请选择要扣减的番茄批次",
                        "inputMode": "choice_or_text",
                        "options": [{"id": "inventory-1", "label": "番茄 2 个", "description": "明天到期"}],
                        "allowMultiple": False,
                        "required": True,
                        "reason": "需要确认库存批次",
                        "sourceSkills": ["inventory_analysis"],
                        "resumeHint": {"expectedField": "inventoryItemId"},
                    },
                )

            self.assertEqual(output["question"], "请选择要扣减的番茄批次")
            self.assertEqual(output["inputMode"], "choice_or_text")
            self.assertEqual(output["options"][0]["id"], "inventory-1")
            self.assertEqual(output["sourceSkills"], ["inventory_analysis"])
            self.assertEqual(output["resumeHint"]["expectedField"], "inventoryItemId")
            self.assertEqual(progress_events[0]["data"]["internal_code"], "human.request_input")
            self.assertEqual(progress_events[0]["data"]["status"], "waiting")

        def test_workspace_read_artifact_returns_only_current_conversation_artifacts(self) -> None:
            with self.SessionLocal() as db:
                _service, draft, approval = self._create_ai_approval_for_test(
                    db,
                    draft_type="shopping_list",
                    payload={
                        "draftType": "shopping_list",
                        "schemaVersion": "shopping_list.v1",
                        "items": [
                            {
                                "ingredientId": "ingredient-tomato",
                                "title": "番茄",
                                "quantity": 2,
                                "unit": "个",
                                "reason": "搭配晚餐",
                            }
                        ],
                    },
                    suffix="read-artifact",
                )
                db.commit()

                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id=approval.conversation_id,
                        run_id="run-read-artifact",
                    ),
                )

                draft_output = executor.call("workspace.read_artifact", {"id": draft.id, "kind": "draft"})
                approval_output = executor.call("workspace.read_artifact", {"id": approval.id, "kind": "approval"})

                self.assertEqual(draft_output["artifact"]["kind"], "draft")
                self.assertEqual(draft_output["artifact"]["payload"]["items"][0]["title"], "番茄")
                self.assertEqual(approval_output["artifact"]["kind"], "approval")
                self.assertEqual(approval_output["artifact"]["initialValues"]["draft"]["items"][0]["unit"], "个")

                wrong_conversation_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-other",
                        run_id="run-read-artifact-other-conversation",
                    ),
                )
                with self.assertRaises(ValueError):
                    wrong_conversation_executor.call("workspace.read_artifact", {"id": draft.id, "kind": "draft"})

                wrong_family_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.other_family.id,
                        user_id=self.user.id,
                        conversation_id=approval.conversation_id,
                        run_id="run-read-artifact-other-family",
                    ),
                )
                with self.assertRaises(ValueError):
                    wrong_family_executor.call("workspace.read_artifact", {"id": approval.id, "kind": "approval"})
                with self.assertRaises(ValueError):
                    executor.call("workspace.read_artifact", {"id": "missing-artifact", "kind": "draft"})

        def test_tool_executor_enforces_skill_allowlist_and_side_effect_policy(self) -> None:
            with self.SessionLocal() as db:
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                ).scoped(
                    allowed_tools={"inventory.read_summary", "shopping.create_draft"},
                    allowed_side_effects={"read"},
                )
                output = executor.call("inventory.read_summary", {})
                self.assertEqual(output["availableCount"], 1)
                with self.assertRaises(PermissionError):
                    executor.call("inventory.read_available_items", {"limit": 10})
                with self.assertRaises(PermissionError):
                    executor.call("shopping.create_draft", {"draft": {"items": [{"title": "鸡蛋"}]}})

        def test_tool_executor_preserves_control_interrupts_from_handlers(self) -> None:
            registry = ToolRegistry()

            def cancel_handler(_context, _payload):
                raise AIExecutionCancelled("AI run was cancelled")

            registry.register(
                ToolDefinition(
                    name="runtime.cancel",
                    display_name="取消运行",
                    description="测试控制中断直通。",
                    input_schema={"type": "object", "properties": {}, "additionalProperties": False},
                    output_schema={"type": "object", "properties": {}, "additionalProperties": False},
                    permission="family:read",
                    side_effect="control",
                    handler=cancel_handler,
                )
            )
            with self.SessionLocal() as db:
                executor = ToolExecutor(
                    registry,
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                with self.assertRaises(AIExecutionCancelled):
                    executor.call("runtime.cancel", {})
                self.assertEqual(executor.records(), [])

        def test_tool_executor_validates_input_schema(self) -> None:
            with self.SessionLocal() as db:
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
                with self.assertRaises(ValueError):
                    executor.call("inventory.read_expiring_items", {"days": "七天"})
                with self.assertRaises(ValueError):
                    executor.call("meal_plan.create_draft", {})
                empty_draft_cases = [
                    ("meal_plan.create_draft", {"draftType": "meal_plan", "schemaVersion": "meal_plan.v1"}),
                    ("shopping.create_draft", {"draftType": "shopping_list", "schemaVersion": "shopping_list.v1"}),
                    ("meal_log.create_draft", {"draftType": "meal_log", "schemaVersion": "meal_log.v1"}),
                    ("recipe.create_draft", {}),
                ]
                for tool_name, draft in empty_draft_cases:
                    with self.subTest(tool_name=tool_name):
                        with self.assertRaisesRegex(ValueError, "does not match any allowed shape"):
                            executor.call(tool_name, {"draft": draft})
                missing_target_cases = [
                    (
                        "ingredient_profile.create_draft",
                        {
                            "draft": {
                                "draftType": "ingredient_profile",
                                "schemaVersion": "ingredient_profile_operation.v1",
                                "action": "update",
                                "payload": {
                                    "name": "鸡蛋",
                                    "category": "蛋类",
                                    "default_unit": "个",
                                    "default_storage": "冷藏",
                                    "default_expiry_mode": "none",
                                },
                            }
                        },
                    ),
                    (
                        "food_profile.create_draft",
                        {
                            "draft": {
                                "draftType": "food_profile",
                                "schemaVersion": "food_profile_operation.v1",
                                "action": "update",
                                "payload": {"name": "牛奶", "type": "readyMade", "category": "饮品"},
                            }
                        },
                    ),
                ]
                for tool_name, payload in missing_target_cases:
                    with self.subTest(tool_name=tool_name):
                        with self.assertRaisesRegex(ValueError, "does not match any allowed shape"):
                            executor.call(tool_name, payload)
                with self.assertRaisesRegex(ValueError, "does not match any allowed shape"):
                    executor.call(
                        "food_profile.create_draft",
                        {"draft": {"draftType": "food_profile", "schemaVersion": "food_profile.v1"}},
                    )
                with self.assertRaisesRegex(ValueError, "does not match any allowed shape"):
                    executor.call(
                        "food_profile.create_draft",
                        {
                            "draft": {
                                "draftType": "food_profile",
                                "schemaVersion": "food_profile_operation.v1",
                                "action": "create",
                                "payload": {},
                            }
                        },
                    )

        def test_draft_tools_reject_or_normalize_catalog_bound_fields(self) -> None:
            with self.SessionLocal() as db:
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
                with self.assertRaisesRegex(ValueError, "foodId"):
                    executor.call(
                        "meal_plan.create_draft",
                        {
                            "draft": {
                                "draftType": "meal_plan",
                                "schemaVersion": "meal_plan.v1",
                                "items": [{"date": date.today().isoformat(), "mealType": "dinner", "title": "库外菜名"}],
                            }
                        },
                    )

                meal_plan = executor.call(
                    "meal_plan.create_draft",
                    {
                        "draft": {
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan.v1",
                            "items": [
                                {
                                    "date": date.today().isoformat(),
                                    "mealType": "dinner",
                                    "title": "库外菜名",
                                    "foodId": "food-tomato",
                                    "recipeId": None,
                                    "missingIngredientItems": [
                                        {
                                            "ingredientId": "ingredient-tomato",
                                            "name": "错误名称",
                                            "quantity": 2.5,
                                            "unit": "个",
                                        }
                                    ],
                                }
                            ],
                        }
                    },
                )
                self.assertEqual(meal_plan["draft"]["items"][0]["title"], "番茄小炒")
                self.assertEqual(meal_plan["draft"]["items"][0]["missingIngredients"], ["番茄"])
                self.assertEqual(
                    meal_plan["draft"]["items"][0]["missingIngredientItems"],
                    [{"ingredientId": "ingredient-tomato", "name": "番茄", "quantity": 2.5, "unit": "个"}],
                )

                with self.assertRaisesRegex(ValueError, "foodId"):
                    executor.call(
                        "meal_log.create_draft",
                        {
                            "draft": {
                                "draftType": "meal_log",
                                "schemaVersion": "meal_log.v1",
                                "date": date.today().isoformat(),
                                "mealType": "dinner",
                                "foods": [{"foodId": None, "name": "库外菜名", "servings": 1, "note": ""}],
                                "notes": "",
                            }
                        },
                    )

                meal_log = executor.call(
                    "meal_log.create_draft",
                    {
                        "draft": {
                            "draftType": "meal_log",
                            "schemaVersion": "meal_log.v1",
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "foods": [{"foodId": "food-tomato", "name": "库外菜名", "servings": 1, "note": ""}],
                            "notes": "",
                        }
                    },
                )
                self.assertEqual(meal_log["draft"]["foods"][0]["name"], "番茄小炒")

                recipe_steps = [
                    {
                        "title": "备菜",
                        "text": "洗净番茄后切块，准备好调味料。",
                        "icon": "bowl",
                        "summary": "处理番茄",
                        "estimated_minutes": 5,
                        "tip": "",
                        "key_points": ["切块"],
                    },
                    {
                        "title": "下锅",
                        "text": "锅中加少量油，放入番茄翻炒出汁。",
                        "icon": "pan",
                        "summary": "炒出汤汁",
                        "estimated_minutes": 6,
                        "tip": "",
                        "key_points": ["中火"],
                    },
                    {
                        "title": "调味",
                        "text": "加入盐调味后收汁装盘。",
                        "icon": "plate",
                        "summary": "完成装盘",
                        "estimated_minutes": 4,
                        "tip": "",
                        "key_points": ["尝味"],
                    },
                ]
                recipe = executor.call(
                    "recipe.create_draft",
                    {
                        "draft": {
                            "draftType": "recipe",
                            "schemaVersion": "recipe.v1",
                            "title": "番茄菜",
                            "servings": 2,
                            "prep_minutes": 15,
                            "difficulty": "easy",
                            "ingredient_items": [
                                {"ingredient_id": "ingredient-tomato", "ingredient_name": "随便写", "quantity": 1, "unit": "个", "note": ""}
                            ],
                            "steps": recipe_steps,
                            "tips": "",
                            "scene_tags": [],
                        }
                    },
                )
                self.assertEqual(recipe["draft"]["ingredient_items"][0]["ingredient_name"], "番茄")
                with self.assertRaisesRegex(ValueError, "recipe.create_draft input.draft does not match any allowed shape"):
                    executor.call("recipe.create_draft", {"draft": {}})

                with self.assertRaisesRegex(ValueError, "未解析的食材"):
                    executor.call(
                        "recipe.create_draft",
                        {
                            "draft": {
                                "title": "跨家庭菜",
                                "servings": 2,
                                "prep_minutes": 15,
                                "difficulty": "easy",
                                "ingredient_items": [
                                    {"ingredient_id": "ingredient-secret", "ingredient_name": "其他家庭牛排", "quantity": 1, "unit": "块", "note": ""}
                                ],
                                "steps": recipe_steps,
                                "tips": "",
                                "scene_tags": [],
                            }
                        },
                    )
                with self.assertRaisesRegex(ValueError, "ingredient_id must be string"):
                    executor.call(
                        "recipe.create_draft",
                        {
                            "draft": {
                                "title": "库外食材菜",
                                "servings": 2,
                                "prep_minutes": 15,
                                "difficulty": "easy",
                                "ingredient_items": [
                                    {"ingredient_id": None, "ingredient_name": "面条", "quantity": 200, "unit": "克", "note": ""}
                                ],
                                "steps": recipe_steps,
                                "tips": "",
                                "scene_tags": [],
                            }
                        },
                    )

                with self.assertRaisesRegex(ValueError, "来源草稿"):
                    executor.call(
                        "shopping.create_draft",
                        {
                            "draft": {
                                "draftType": "shopping_list",
                                "schemaVersion": "shopping_list.v1",
                                "sourceDraftId": "missing-draft",
                                "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "测试"}],
                            }
                        },
                    )

                with self.assertRaisesRegex(ValueError, "购物清单项目必须引用真实食材"):
                    executor.call(
                        "shopping.create_draft",
                        {
                            "draft": {
                                "draftType": "shopping_list",
                                "schemaVersion": "shopping_list.v1",
                                "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "测试"}],
                            }
                        },
                    )

                with self.assertRaisesRegex(ValueError, "购物清单项目必须引用真实食材"):
                    executor.call(
                        "shopping.create_draft",
                        {
                            "draft": {
                                "draftType": "shopping_list",
                                "schemaVersion": "shopping_list_operation.v1",
                                "operations": [
                                    {
                                        "operationId": "op-create-freeform",
                                        "action": "create",
                                        "payload": {"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "测试"},
                                    }
                                ],
                            }
                        },
                    )

                salt = Ingredient(
                    id="ingredient-shopping-salt",
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
                seasoning_draft = executor.call(
                    "shopping.create_draft",
                    {
                        "draft": {
                            "draftType": "shopping_list",
                            "schemaVersion": "shopping_list.v1",
                            "items": [
                                {
                                    "ingredientId": salt.id,
                                    "title": "盐",
                                    "quantityMode": "not_track_quantity",
                                    "reason": "需要补充",
                                }
                            ],
                        }
                    },
                )
                seasoning_item = seasoning_draft["draft"]["items"][0]
                self.assertEqual(seasoning_item["ingredient_id"], salt.id)
                self.assertEqual(seasoning_item["quantity_mode"], "not_track_quantity")
                self.assertEqual(seasoning_item["display_label"], "需要补充")
                self.assertEqual(seasoning_item["quantity"], 1)

        def test_operation_draft_tools_reject_cross_family_targets(self) -> None:
            with self.SessionLocal() as db:
                other_food = Food(
                    id="food-other-operation-target",
                    family_id=self.other_family.id,
                    name="其他家庭食物",
                    type=FoodType.READY_MADE,
                    category="测试",
                    flavor_tags=[],
                    scene_tags=[],
                    suitable_meal_types=[],
                    source_name="",
                    purchase_source="",
                    scene="",
                    notes="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_recipe = Recipe(
                    id="recipe-other-operation-target",
                    family_id=self.other_family.id,
                    title="其他家庭菜谱",
                    servings=2,
                    prep_minutes=15,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_plan = FoodPlanItem(
                    id="plan-other-operation-target",
                    family_id=self.other_family.id,
                    user_id=self.user.id,
                    food_id=other_food.id,
                    plan_date=date.today(),
                    meal_type=MealType.DINNER,
                    note="",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_shopping = ShoppingListItem(
                    id="shopping-other-operation-target",
                    family_id=self.other_family.id,
                    title="其他家庭采购项",
                    quantity=Decimal("1"),
                    unit="份",
                    reason="",
                    done=False,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_log = MealLog(
                    id="meal-log-other-operation-target",
                    family_id=self.other_family.id,
                    date=date.today(),
                    meal_type=MealType.DINNER,
                    participant_user_ids=[self.user.id],
                    notes="",
                    mood="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([other_food, other_recipe, other_plan, other_shopping, other_log])
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
                cases = [
                    (
                        "ingredient_profile.create_draft",
                        {
                            "draft": {
                                "draftType": "ingredient_profile",
                                "schemaVersion": "ingredient_profile_operation.v1",
                                "action": "update",
                                "targetId": "ingredient-secret",
                                "baseUpdatedAt": utcnow().isoformat(),
                                "payload": {
                                    "name": "其他家庭牛排",
                                    "category": "肉类",
                                    "default_unit": "块",
                                    "default_storage": "冷冻",
                                    "default_expiry_mode": "none",
                                },
                            }
                        },
                        "当前家庭",
                    ),
                    (
                        "food_profile.create_draft",
                        {
                            "draft": {
                                "draftType": "food_profile",
                                "schemaVersion": "food_profile_operation.v1",
                                "action": "update",
                                "targetId": other_food.id,
                                "baseUpdatedAt": other_food.updated_at.isoformat(),
                                "payload": {"name": "其他家庭食物", "type": "readyMade", "category": "测试"},
                            }
                        },
                        "当前家庭",
                    ),
                    (
                        "recipe.create_draft",
                        {
                            "draft": {
                                "draftType": "recipe",
                                "schemaVersion": "recipe_operation.v1",
                                "action": "delete",
                                "targetId": other_recipe.id,
                                "baseUpdatedAt": other_recipe.updated_at.isoformat(),
                                "payload": {"reason": "测试"},
                            }
                        },
                        "当前家庭",
                    ),
                    (
                        "meal_plan.create_draft",
                        {
                            "draft": {
                                "draftType": "meal_plan",
                                "schemaVersion": "meal_plan_operation.v1",
                                "operations": [
                                    {
                                        "action": "set_status",
                                        "targetId": other_plan.id,
                                        "baseUpdatedAt": other_plan.updated_at.isoformat(),
                                        "payload": {"status": "skipped"},
                                    }
                                ],
                            }
                        },
                        "当前用户",
                    ),
                    (
                        "shopping.create_draft",
                        {
                            "draft": {
                                "draftType": "shopping_list",
                                "schemaVersion": "shopping_list_operation.v1",
                                "operations": [
                                    {
                                        "action": "set_done",
                                        "targetId": other_shopping.id,
                                        "baseUpdatedAt": other_shopping.updated_at.isoformat(),
                                        "payload": {"done": True},
                                    }
                                ],
                            }
                        },
                        "当前家庭",
                    ),
                    (
                        "meal_log.create_draft",
                        {
                            "draft": {
                                "draftType": "meal_log",
                                "schemaVersion": "meal_log_operation.v1",
                                "action": "update_details",
                                "targetId": other_log.id,
                                "baseUpdatedAt": other_log.updated_at.isoformat(),
                                "payload": {"notes": "不应允许"},
                            }
                        },
                        "当前家庭",
                    ),
                ]
                for tool_name, payload, message in cases:
                    with self.subTest(tool_name=tool_name):
                        with self.assertRaisesRegex(ValueError, message):
                            executor.call(tool_name, payload)

        def test_workspace_tool_registry_uses_real_schemas_for_key_tools(self) -> None:
            registry = build_workspace_tool_registry()
            for tool in registry.list():
                self.assertTrue(tool.display_name)
                self.assertNotIn(".", tool.display_name)
            expiring = registry.get("inventory.read_expiring_items")
            self.assertEqual(expiring.display_name, "临期食材")
            self.assertIn("days", expiring.input_schema["properties"])
            self.assertEqual(expiring.output_schema["required"], ["queryFocus", "count", "items", "card"])
            self.assertEqual(expiring.output_schema["properties"]["queryFocus"]["enum"], ["expiring"])
            self.assertIn("ingredientId", expiring.output_schema["properties"]["items"]["items"]["properties"])
            self.assertFalse(expiring.requires_followup)
            self.assertTrue(expiring.terminal_output)
            self.assertEqual(expiring.output_types, ["inventory_summary"])
            self.assertTrue(expiring.followup_hint)
            summary = registry.get("inventory.read_summary")
            self.assertTrue(summary.terminal_output)
            self.assertFalse(summary.requires_followup)
            self.assertTrue(summary.followup_hint)
            recommend_today = registry.get("meal_plan.recommend_today")
            self.assertTrue(recommend_today.terminal_output)
            self.assertFalse(recommend_today.requires_followup)
            self.assertEqual(recommend_today.output_types, ["today_recommendation"])
            self.assertTrue(recommend_today.followup_hint)
            food_search = registry.get("food.search")
            self.assertIn("recipeId", food_search.output_schema["properties"]["items"]["items"]["properties"])
            self.assertTrue(food_search.requires_followup)
            self.assertFalse(food_search.terminal_output)
            self.assertTrue(food_search.followup_hint)
            food_read = registry.get("food.read_by_id")
            self.assertTrue(food_read.requires_followup)
            ingredient_search = registry.get("ingredient.search")
            self.assertIn("supportedUnits", ingredient_search.output_schema["properties"]["items"]["items"]["properties"])
            self.assertTrue(ingredient_search.requires_followup)
            self.assertFalse(ingredient_search.terminal_output)
            self.assertTrue(ingredient_search.followup_hint)
            ingredient_read = registry.get("ingredient.read_by_id")
            self.assertTrue(ingredient_read.requires_followup)
            shopping_pending = registry.get("shopping.read_pending")
            self.assertIn("done", shopping_pending.output_schema["properties"]["items"]["items"]["properties"])
            self.assertTrue(shopping_pending.requires_followup)
            self.assertTrue(registry.get("shopping.read_by_id").requires_followup)
            meal_plan_existing = registry.get("meal_plan.read_existing")
            self.assertIn("recipeId", meal_plan_existing.output_schema["properties"]["items"]["items"]["properties"])
            self.assertTrue(meal_plan_existing.requires_followup)
            self.assertTrue(registry.get("meal_plan.read_by_id").requires_followup)
            recipe_search = registry.get("recipe.search")
            recipe_item_schema = recipe_search.output_schema["properties"]["items"]["items"]
            self.assertEqual(recipe_search.output_schema["required"], ["count", "hasMore", "items"])
            self.assertIn("foodIds", recipe_item_schema["properties"])
            self.assertIn("ingredients", recipe_item_schema["properties"])
            self.assertTrue(recipe_search.requires_followup)
            self.assertTrue(registry.get("recipe.read_by_id").requires_followup)
            self.assertTrue(registry.get("recipe.preview_cook").requires_followup)
            meal_log_recent = registry.get("meal_log.read_recent")
            self.assertIn("mealType", meal_log_recent.output_schema["properties"]["items"]["items"]["properties"])
            self.assertTrue(meal_log_recent.requires_followup)
            self.assertTrue(registry.get("meal_log.read_by_id").requires_followup)
            self.assertTrue(registry.get("workspace.read_artifact").requires_followup)
            meal_plan_draft = registry.get("meal_plan.create_draft")
            self.assertEqual(meal_plan_draft.display_name, "餐食计划确认表单")
            self.assertEqual(meal_plan_draft.side_effect, "draft")
            self.assertEqual(meal_plan_draft.permission, "family:draft")
            self.assertEqual(meal_plan_draft.input_schema["required"], ["draft"])
            self.assertEqual(meal_plan_draft.input_schema["properties"]["draft"]["properties"]["draftType"]["enum"], ["meal_plan"])
            self.assertIn("operations", meal_plan_draft.input_schema["properties"]["draft"]["properties"])
            self.assertIn("items", meal_plan_draft.input_schema["properties"]["draft"]["properties"])
            self.assertIn("anyOf", meal_plan_draft.input_schema["properties"]["draft"])
            self.assertTrue(meal_plan_draft.requires_confirmation)
            shopping_draft = registry.get("shopping.create_draft")
            self.assertIn("不要提交只有 draftType/schemaVersion", shopping_draft.input_schema["properties"]["draft"]["description"])
            meal_log_draft = registry.get("meal_log.create_draft")
            self.assertEqual(meal_log_draft.input_schema["properties"]["draft"]["properties"]["foods"]["minItems"], 1)
            self.assertIn("anyOf", meal_log_draft.input_schema["properties"]["draft"])
            ingredient_profile_draft = registry.get("ingredient_profile.create_draft")
            self.assertIn("更新时还必须提供 targetId", ingredient_profile_draft.input_schema["properties"]["draft"]["description"])
            food_profile_draft = registry.get("food_profile.create_draft")
            self.assertIn("必须提供 name、type、category", food_profile_draft.description)
            food_profile_schema = food_profile_draft.input_schema["properties"]["draft"]
            self.assertIn("必须填写 name、type、category", food_profile_schema["description"])
            self.assertIn("anyOf", food_profile_schema)
            self.assertIn("即食/现成/盒装", food_profile_schema["properties"]["type"]["description"])
            self.assertIn("action=create", food_profile_schema["properties"]["payload"]["description"])
            recipe_draft = registry.get("recipe.create_draft")
            recipe_schema = recipe_draft.input_schema["properties"]["draft"]
            self.assertIn("不要提交空对象", recipe_schema["description"])
            self.assertIn("anyOf", recipe_schema)
            create_recipe_schema = recipe_schema["anyOf"][0]
            self.assertEqual(
                create_recipe_schema["required"],
                ["title", "servings", "prep_minutes", "difficulty", "ingredient_items", "steps"],
            )

        def test_tool_executor_progress_uses_display_names(self) -> None:
            events: list[dict] = []

            def stream_writer(event: dict) -> None:
                events.append(event)

            with self.SessionLocal() as db:
                executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        stream_writer=stream_writer,
                    ),
                )
                executor.call("inventory.read_available_items", {"limit": 10})
                executor.call(
                    "meal_plan.create_draft",
                    {
                        "draft": {
                            "draftType": "meal_plan",
                            "schemaVersion": "meal_plan.v1",
                            "items": [{"date": date.today().isoformat(), "mealType": "dinner", "title": "番茄小炒", "foodId": "food-tomato"}],
                        }
                    },
                )

            messages = [event["data"]["user_message"] for event in events]
            statuses = [event["data"]["status"] for event in events]
            self.assertEqual(messages, ["调用「可用库存」", "调用「可用库存」", "生成「餐食计划确认表单」", "生成「餐食计划确认表单」"])
            self.assertEqual(statuses, ["running", "completed", "running", "completed"])
            self.assertNotIn("inventory.read_available_items", "\n".join(messages))

        def test_meal_log_read_by_id_matches_tool_schema(self) -> None:
            with self.SessionLocal() as db:
                meal_log = MealLog(
                    id="meal-log-tool-read-target",
                    family_id=self.family.id,
                    date=date.today(),
                    meal_type=MealType.DINNER,
                    participant_user_ids=[self.user.id],
                    notes="少油",
                    mood="满意",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(meal_log)
                db.flush()
                db.add(
                    MealLogFood(
                        id="meal-log-tool-read-entry",
                        meal_log_id=meal_log.id,
                        food_id="food-tomato",
                        servings=Decimal("1.5"),
                        note="半份给孩子",
                        rating=Decimal("4.5"),
                    )
                )
                db.commit()
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
                output = executor.call("meal_log.read_by_id", {"id": meal_log.id})

            item = output["item"]
            self.assertEqual(item["id"], "meal-log-tool-read-target")
            self.assertEqual(item["mealType"], "dinner")
            self.assertEqual(item["foodEntries"][0]["foodId"], "food-tomato")
            self.assertEqual(item["foodEntries"][0]["foodName"], "番茄小炒")
            self.assertEqual(item["foods"], item["foodEntries"])
            self.assertEqual(item["participantUserIds"], [self.user.id])
            self.assertEqual(item["notes"], "少油")
            self.assertIsNotNone(item["updatedAt"])

        def test_meal_plan_read_existing_uses_related_food_name(self) -> None:
            with self.SessionLocal() as db:
                db.add(
                    FoodPlanItem(
                        id="food-plan-existing",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        food_id="food-tomato",
                        plan_date=date.today() + timedelta(days=1),
                        meal_type=MealType.DINNER,
                        note="少油",
                        status="planned",
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
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                output = executor.call("meal_plan.read_existing", {"limit": 20})

            self.assertEqual(output["count"], 1)
            self.assertEqual(output["items"][0]["title"], "番茄小炒")
            self.assertEqual(output["items"][0]["note"], "少油")
            self.assertEqual(output["items"][0]["status"], "planned")
            self.assertIsNotNone(output["items"][0]["updatedAt"])
            self.assertFalse(output["hasMore"])

        def test_meal_plan_read_by_id_matches_tool_schema(self) -> None:
            with self.SessionLocal() as db:
                db.add(
                    FoodPlanItem(
                        id="food-plan-read-target",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        food_id="food-tomato",
                        plan_date=date.today() + timedelta(days=1),
                        meal_type=MealType.DINNER,
                        note="少油",
                        status="planned",
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
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                output = executor.call("meal_plan.read_by_id", {"id": "food-plan-read-target"})

            item = output["item"]
            self.assertEqual(item["id"], "food-plan-read-target")
            self.assertEqual(item["date"], (date.today() + timedelta(days=1)).isoformat())
            self.assertEqual(item["mealType"], "dinner")
            self.assertEqual(item["title"], "番茄小炒")
            self.assertEqual(item["foodId"], "food-tomato")
            self.assertEqual(item["note"], "少油")
            self.assertEqual(item["status"], "planned")
            self.assertIsNotNone(item["updatedAt"])

        def test_shopping_read_by_id_matches_tool_schema(self) -> None:
            with self.SessionLocal() as db:
                db.add(
                    ShoppingListItem(
                        id="shopping-read-target",
                        family_id=self.family.id,
                        title="牛奶",
                        quantity=Decimal("2"),
                        unit="盒",
                        reason="早餐",
                        done=False,
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
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                output = executor.call("shopping.read_by_id", {"id": "shopping-read-target"})

            item = output["item"]
            self.assertEqual(item["id"], "shopping-read-target")
            self.assertEqual(item["title"], "牛奶")
            self.assertEqual(item["quantity"], 2.0)
            self.assertEqual(item["unit"], "盒")
            self.assertEqual(item["reason"], "早餐")
            self.assertFalse(item["done"])
            self.assertIsNotNone(item["updatedAt"])

        def test_meal_plan_read_existing_filters_by_recipe_and_date(self) -> None:
            with self.SessionLocal() as db:
                recipe = Recipe(
                    id="recipe-plan-filter-target",
                    family_id=self.family.id,
                    title="番茄快炒",
                    servings=2,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["家常菜"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_recipe = Recipe(
                    id="recipe-plan-filter-other",
                    family_id=self.family.id,
                    title="牛奶早餐",
                    servings=1,
                    prep_minutes=2,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=["早餐"],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                target_food = Food(
                    id="food-plan-filter-target",
                    family_id=self.family.id,
                    name="番茄快炒",
                    type=FoodType.SELF_MADE,
                    category="家常菜",
                    recipe_id=recipe.id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                other_food = Food(
                    id="food-plan-filter-other",
                    family_id=self.family.id,
                    name="盒装牛奶",
                    type=FoodType.SELF_MADE,
                    category="早餐",
                    recipe_id=other_recipe.id,
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add_all([recipe, other_recipe, target_food, other_food])
                db.flush()
                target_date = date.today() + timedelta(days=1)
                db.add_all(
                    [
                        FoodPlanItem(
                            id="plan-filter-target",
                            family_id=self.family.id,
                            user_id=self.user.id,
                            food_id=target_food.id,
                            plan_date=target_date,
                            meal_type=MealType.DINNER,
                            note="正确计划",
                            status="planned",
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        FoodPlanItem(
                            id="plan-filter-other",
                            family_id=self.family.id,
                            user_id=self.user.id,
                            food_id=other_food.id,
                            plan_date=target_date,
                            meal_type=MealType.DINNER,
                            note="错误计划",
                            status="planned",
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
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                output = executor.call(
                    "meal_plan.read_existing",
                    {"recipeId": recipe.id, "planDate": target_date.isoformat(), "mealType": "dinner", "limit": 20},
                )

            self.assertEqual(output["count"], 1)
            self.assertEqual(output["items"][0]["id"], "plan-filter-target")
            self.assertEqual(output["items"][0]["recipeId"], recipe.id)

        def test_recipe_search_returns_has_more_and_updated_at(self) -> None:
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        Recipe(
                            id="recipe-search-extra",
                            family_id=self.family.id,
                            title="第二道番茄菜",
                            servings=2,
                            prep_minutes=8,
                            difficulty=Difficulty.EASY,
                            tips="",
                            scene_tags=["家常菜"],
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        Recipe(
                            id="recipe-search-extra-2",
                            family_id=self.family.id,
                            title="第三道番茄菜",
                            servings=2,
                            prep_minutes=10,
                            difficulty=Difficulty.EASY,
                            tips="",
                            scene_tags=["家常菜"],
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
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                output = executor.call("recipe.search", {"limit": 1})

            self.assertEqual(output["count"], 1)
            self.assertTrue(output["hasMore"])
            self.assertIsNotNone(output["items"][0]["updatedAt"])
