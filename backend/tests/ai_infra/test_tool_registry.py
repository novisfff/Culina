from ._support import *


class AIToolRegistryTestCase(AIAgentInfraTestCase):
        def test_today_recommendation_accepts_model_items_at_card_root(self) -> None:
            class RootItemsRecommendationProvider(BaseChatProvider):
                model_name = "root-items-recommendation-model"

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
                    tool_handler("inventory.read_available_items", {"limit": 50})
                    tool_handler("inventory.read_expiring_items", {"days": 7})
                    tool_handler("meal_log.read_recent", {"limit": 8})
                    tool_handler("food.search", {"limit": 24})
                    tool_handler("recipe.search", {"limit": 24})
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "明晚建议吃番茄小炒。",
                                "cards": [
                                    {
                                        "type": "today_recommendation",
                                        "title": "今日吃什么",
                                        "data": {
                                            "targetDate": (date.today() + timedelta(days=1)).isoformat(),
                                            "mealType": "dinner",
                                            "contextSummary": {
                                                "inventoryCount": 1,
                                                "expiringCount": 1,
                                                "recentMealCount": 0,
                                                "recipeCount": 0,
                                            },
                                            "recommendations": [],
                                        },
                                        "items": [
                                            {
                                                "foodId": "food-tomato",
                                                "reason": "优先消耗临期番茄。",
                                            }
                                        ],
                                    }
                                ],
                                "status": "completed",
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            skill = build_workspace_skill_registry().get("meal_plan")
            with self.SessionLocal() as db:
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="明晚吃什么",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=RootItemsRecommendationProvider(),
                    )
                )

            card = result.cards[0]
            self.assertNotIn("items", card)
            self.assertEqual(len(card["data"]["recommendations"]), 1)
            self.assertEqual(card["data"]["recommendations"][0]["foodId"], "food-tomato")
            self.assertEqual(card["data"]["recommendations"][0]["name"], "番茄小炒")
            self.assertEqual(card["data"]["recommendations"][0]["image"]["id"], "media-food-tomato")
            self.assertEqual(card["data"]["targetDate"], (date.today() + timedelta(days=1)).isoformat())
            self.assertEqual(card["data"]["mealType"], "dinner")

        def test_today_recommendation_does_not_infer_date_or_meal_type_from_message(self) -> None:
            class MissingDateMealProvider(BaseChatProvider):
                model_name = "missing-date-meal-recommendation-model"

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
                    del system, user, tools, tool_handler, response_schema, max_rounds, visible_text_handler
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "明晚建议吃番茄小炒。",
                                "cards": [
                                    {
                                        "type": "today_recommendation",
                                        "title": "今日吃什么",
                                        "data": {"recommendations": []},
                                        "items": [{"foodId": "food-tomato", "reason": "优先消耗临期番茄。"}],
                                    }
                                ],
                                "status": "completed",
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            skill = build_workspace_skill_registry().get("meal_plan")
            with self.SessionLocal() as db:
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-no-date-meal",
                        run_id="run-no-date-meal",
                        conversation=[],
                        current_message="明晚吃什么",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-no-date-meal", run_id="run-no-date-meal"),
                        ),
                        provider=MissingDateMealProvider(),
                    )
                )

            card = result.cards[0]
            self.assertIsNone(card["data"]["targetDate"])
            self.assertIsNone(card["data"]["mealType"])

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

                with self.assertRaisesRegex(ValueError, "当前家庭"):
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
            self.assertEqual(expiring.output_schema["required"], ["count", "items"])
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
            self.assertEqual(messages, ["调用「可用库存」", "生成「餐食计划确认表单」"])
            self.assertNotIn("inventory.read_available_items", "\n".join(messages))

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
