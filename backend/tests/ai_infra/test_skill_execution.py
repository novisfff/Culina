from ._support import *


class RecipeCookFlowProvider(BaseChatProvider):
    model_name = "recipe-cook-flow-model"

    def __init__(
        self,
        *,
        query: str,
        servings: float = 2,
        plan_date: str | None = None,
        meal_type: str | None = None,
        require_plan: bool = False,
        create_meal_log: bool = False,
    ) -> None:
        self.query = query
        self.servings = servings
        self.plan_date = plan_date
        self.meal_type = meal_type
        self.require_plan = require_plan
        self.create_meal_log = create_meal_log

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        raise AssertionError("recipe_cook should use generate_with_tools")

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

        recipes = tool_handler("recipe.search", {"query": self.query, "limit": 10})
        recipe_items = recipes.get("items") or []
        if len(recipe_items) != 1:
            tool_handler(
                "intent.request_clarification",
                {
                    "question": "没有找到唯一可做的菜谱，请先选择一个已有菜谱。",
                    "questionType": "entity_disambiguation",
                    "missingFields": ["菜谱"],
                    "candidates": [
                        {
                            "id": item["id"],
                            "label": item["title"],
                            "summary": f"默认 {item.get('servings')} 份",
                            "entityType": "recipe",
                            "updatedAt": item.get("updatedAt"),
                        }
                        for item in recipe_items
                    ],
                    "allowFreeText": True,
                },
            )
            return self._result(
                {
                    "text": "我需要先确认要做哪一个已有菜谱；如果还没有这个菜谱，请先创建菜谱。",
                    "cards": [],
                    "events": [],
                    "context_summary": {},
                    "state_patch": {},
                    "requires_clarification": True,
                    "status": "completed",
                    "error": None,
                }
            )

        recipe = recipe_items[0]
        plan_item = None
        if self.require_plan:
            plan_payload = {"recipeId": recipe["id"], "limit": 20}
            if self.plan_date:
                plan_payload["planDate"] = self.plan_date
            if self.meal_type:
                plan_payload["mealType"] = self.meal_type
            plans = tool_handler("meal_plan.read_existing", plan_payload)
            plan_items = [item for item in plans.get("items") or [] if item.get("recipeId") == recipe["id"]]
            if len(plan_items) != 1:
                tool_handler(
                    "intent.request_clarification",
                    {
                        "question": "这个菜谱匹配到多个计划项，请选择要做掉哪一条。",
                        "questionType": "meal_plan_disambiguation",
                        "missingFields": ["关联计划项"],
                        "candidates": [
                            {
                                "id": item["id"],
                                "label": f"{item.get('date')} {item.get('mealType')} · {item.get('title')}",
                                "summary": f"状态：{item.get('status')}",
                                "entityType": "meal_plan",
                                "updatedAt": item.get("updatedAt"),
                            }
                            for item in plan_items
                        ],
                        "allowFreeText": True,
                    },
                )
                return self._result(
                    {
                        "text": "我需要先确认要关联哪一条餐食计划。",
                        "cards": [],
                        "events": [],
                        "context_summary": {},
                        "state_patch": {},
                        "requires_clarification": True,
                        "status": "completed",
                        "error": None,
                    }
                )
            plan_item = plan_items[0]

        preview_payload = {"recipeId": recipe["id"], "servings": self.servings}
        if plan_item is not None:
            preview_payload["planItemId"] = plan_item["id"]
        preview = tool_handler("recipe.preview_cook", preview_payload)

        draft = {
            "draftType": "recipe_cook",
            "schemaVersion": "recipe_cook_operation.v1",
            "recipeId": recipe["id"],
            "title": recipe["title"],
            "baseUpdatedAt": recipe.get("updatedAt"),
            "servings": self.servings,
            "date": self.plan_date or date.today().isoformat(),
            "mealType": self.meal_type or "dinner",
            "participantUserIds": [],
            "notes": "",
            "createMealLog": self.create_meal_log,
            "planItemId": plan_item["id"] if plan_item is not None else None,
            "planItemBaseUpdatedAt": plan_item.get("updatedAt") if plan_item is not None else None,
            "resultNote": "",
            "adjustments": "",
            "rating": None,
            "previewItems": preview["preview"]["preview_items"],
            "shortages": preview["preview"]["shortages"],
        }
        tool_handler("recipe.create_cook_draft", {"draft": draft})
        return self._result(
            {
                "text": "我整理好了做菜确认草稿，请确认后再扣减库存。",
                "cards": [],
                "events": [{"type": "draft", "message": "已生成做菜确认草稿"}],
                "context_summary": {"draftType": "recipe_cook"},
                "state_patch": {},
                "requires_clarification": False,
                "status": "completed",
                "error": None,
                "operation": "cook",
            }
        )

    def _result(self, payload: dict) -> ChatProviderResult:
        return ChatProviderResult(
            text=json.dumps(payload, ensure_ascii=False),
            status="completed",
            model=self.model_name,
            structured_mode="tool_call",
        )


class AISkillExecutionTestCase(AIAgentInfraTestCase):
        def _create_recipe_cook_target(
            self,
            db: Session,
            *,
            suffix: str,
            title: str = "番茄快炒",
            plan_count: int = 0,
            plan_date: date | None = None,
            meal_type: MealType = MealType.DINNER,
        ) -> tuple[Recipe, list[FoodPlanItem]]:
            recipe = Recipe(
                id=f"recipe-cook-skill-{suffix}",
                family_id=self.family.id,
                title=title,
                servings=2,
                prep_minutes=12,
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
                    id=f"recipe-cook-skill-ingredient-{suffix}",
                    recipe_id=recipe.id,
                    ingredient_id="ingredient-tomato",
                    ingredient_name="番茄",
                    quantity=2,
                    unit="个",
                    note="切块",
                    sort_order=0,
                )
            )
            food = Food(
                id=f"food-cook-skill-{suffix}",
                family_id=self.family.id,
                name=title,
                type=FoodType.SELF_MADE,
                category="家常菜",
                flavor_tags=[],
                scene_tags=["家常菜"],
                suitable_meal_types=[meal_type.value],
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
            target_date = plan_date or date.today()
            plan_items: list[FoodPlanItem] = []
            for index in range(plan_count):
                item = FoodPlanItem(
                    id=f"plan-cook-skill-{suffix}-{index + 1}",
                    family_id=self.family.id,
                    user_id=self.user.id,
                    food_id=food.id,
                    plan_date=target_date,
                    meal_type=meal_type,
                    note=f"计划 {index + 1}",
                    status="planned",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(item)
                plan_items.append(item)
            db.flush()
            return recipe, plan_items

        def _run_recipe_cook_skill(
            self,
            db: Session,
            *,
            provider: BaseChatProvider,
            message: str,
        ) -> tuple[SkillResult, ToolExecutor]:
            tool_executor = ToolExecutor(
                build_workspace_tool_registry(),
                ToolContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                ),
            )
            result = SkillExecutor(build_workspace_skill_registry()).run_step(
                "recipe_cook",
                SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-test",
                    run_id="run-test",
                    conversation=[],
                    current_message=message,
                    tool_executor=tool_executor,
                    provider=provider,
                ),
            )
            return result, tool_executor

        def test_recipe_cook_skill_filters_plan_by_recipe_before_draft(self) -> None:
            target_date = date.today() + timedelta(days=1)
            with self.SessionLocal() as db:
                recipe, plan_items = self._create_recipe_cook_target(
                    db,
                    suffix="filtered",
                    plan_count=1,
                    plan_date=target_date,
                )
                other_recipe, _ = self._create_recipe_cook_target(
                    db,
                    suffix="other",
                    title="牛奶早餐",
                    plan_count=0,
                    plan_date=target_date,
                    meal_type=MealType.DINNER,
                )
                other_food = db.scalar(select(Food).where(Food.recipe_id == other_recipe.id))
                assert other_food is not None
                db.add(
                    FoodPlanItem(
                        id="plan-cook-skill-other-same-slot",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        food_id=other_food.id,
                        plan_date=target_date,
                        meal_type=MealType.DINNER,
                        note="同餐别但不是当前菜谱",
                        status="planned",
                        created_by=self.user.id,
                        updated_by=self.user.id,
                    )
                )
                db.flush()

                result, tool_executor = self._run_recipe_cook_skill(
                    db,
                    provider=RecipeCookFlowProvider(
                        query=recipe.title,
                        plan_date=target_date.isoformat(),
                        meal_type="dinner",
                        require_plan=True,
                        create_meal_log=True,
                    ),
                    message="把明天晚餐这条番茄快炒计划做掉并记录餐食",
                )
                records = tool_executor.records()

            tool_names = [record["name"] for record in records]
            self.assertEqual(result.status, "completed")
            self.assertEqual(result.drafts[0]["draft_type"], "recipe_cook")
            self.assertEqual(result.drafts[0]["payload"]["recipeId"], recipe.id)
            self.assertEqual(result.drafts[0]["payload"]["planItemId"], plan_items[0].id)
            self.assertTrue(result.drafts[0]["payload"]["createMealLog"])
            self.assertLess(tool_names.index("recipe.search"), tool_names.index("meal_plan.read_existing"))
            self.assertLess(tool_names.index("meal_plan.read_existing"), tool_names.index("recipe.preview_cook"))
            self.assertLess(tool_names.index("recipe.preview_cook"), tool_names.index("recipe.create_cook_draft"))
            plan_read = next(record for record in records if record["name"] == "meal_plan.read_existing")
            self.assertEqual(
                plan_read["input"],
                {"recipeId": recipe.id, "limit": 20, "planDate": target_date.isoformat(), "mealType": "dinner"},
            )
            create_record = next(record for record in records if record["name"] == "recipe.create_cook_draft")
            self.assertEqual(create_record["output_summary"]["itemCount"], 1)

        def test_recipe_cook_skill_defaults_to_no_meal_log_without_explicit_request(self) -> None:
            with self.SessionLocal() as db:
                recipe, _ = self._create_recipe_cook_target(db, suffix="no-meal-log", plan_count=0)
                result, tool_executor = self._run_recipe_cook_skill(
                    db,
                    provider=RecipeCookFlowProvider(query=recipe.title, require_plan=False, create_meal_log=False),
                    message="做一份番茄快炒，扣减库存",
                )
                tool_names = [record["name"] for record in tool_executor.records()]

            self.assertEqual(result.status, "completed")
            self.assertFalse(result.drafts[0]["payload"]["createMealLog"])
            self.assertIsNone(result.drafts[0]["payload"]["planItemId"])
            self.assertNotIn("meal_plan.read_existing", tool_names)

        def test_recipe_cook_skill_clarifies_when_multiple_matching_plan_items(self) -> None:
            target_date = date.today() + timedelta(days=1)
            with self.SessionLocal() as db:
                recipe, plan_items = self._create_recipe_cook_target(
                    db,
                    suffix="multiple",
                    plan_count=2,
                    plan_date=target_date,
                )
                result, tool_executor = self._run_recipe_cook_skill(
                    db,
                    provider=RecipeCookFlowProvider(
                        query=recipe.title,
                        plan_date=target_date.isoformat(),
                        meal_type="dinner",
                        require_plan=True,
                        create_meal_log=True,
                    ),
                    message="把明天晚餐的番茄快炒计划做掉",
                )
                records = tool_executor.records()

            tool_names = [record["name"] for record in records]
            self.assertTrue(result.requires_clarification)
            self.assertEqual(result.drafts, [])
            self.assertIn("meal_plan.read_existing", tool_names)
            self.assertIn("intent.request_clarification", tool_names)
            self.assertNotIn("recipe.preview_cook", tool_names)
            candidates = result.cards[0]["data"]["candidates"]
            self.assertEqual({candidate["id"] for candidate in candidates}, {item.id for item in plan_items})

        def test_recipe_preview_cook_returns_warning_for_mismatched_plan_item(self) -> None:
            target_date = date.today() + timedelta(days=1)
            with self.SessionLocal() as db:
                recipe, _ = self._create_recipe_cook_target(
                    db,
                    suffix="preview-warning",
                    plan_count=0,
                    plan_date=target_date,
                )
                other_recipe, _ = self._create_recipe_cook_target(
                    db,
                    suffix="preview-warning-other",
                    title="牛奶早餐",
                    plan_count=0,
                    plan_date=target_date,
                    meal_type=MealType.DINNER,
                )
                other_food = db.scalar(select(Food).where(Food.recipe_id == other_recipe.id))
                assert other_food is not None
                db.add(
                    FoodPlanItem(
                        id="plan-cook-skill-preview-warning-other",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        food_id=other_food.id,
                        plan_date=target_date,
                        meal_type=MealType.DINNER,
                        note="不是当前菜谱",
                        status="planned",
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
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                output = executor.call(
                    "recipe.preview_cook",
                    {
                        "recipeId": recipe.id,
                        "servings": 2,
                        "planItemId": "plan-cook-skill-preview-warning-other",
                    },
                )

            self.assertEqual(output["recipe"]["id"], recipe.id)
            self.assertIsNone(output["planItem"])
            self.assertEqual(output["planItemWarning"]["code"], "plan_item_recipe_mismatch")

        def test_recipe_cook_skill_does_not_create_temporary_recipe_when_missing(self) -> None:
            with self.SessionLocal() as db:
                result, tool_executor = self._run_recipe_cook_skill(
                    db,
                    provider=RecipeCookFlowProvider(query="不存在的菜谱", require_plan=False, create_meal_log=False),
                    message="做一份不存在的菜谱",
                )
                tool_names = [record["name"] for record in tool_executor.records()]

            self.assertTrue(result.requires_clarification)
            self.assertEqual(result.drafts, [])
            self.assertIn("先创建菜谱", result.text)
            self.assertIn("recipe.search", tool_names)
            self.assertIn("intent.request_clarification", tool_names)
            self.assertNotIn("recipe.create_cook_draft", tool_names)

        def test_skill_executor_scopes_tools_to_skill_manifest(self) -> None:
            class UndeclaredToolSkill(BaseSkill):
                def run(self, context: SkillContext) -> SkillResult:
                    context.tool_executor.call("inventory.read_available_items", {"limit": 10})
                    return SkillResult(text="should not reach")

            manifest = SkillManifest(
                key="limited_skill",
                name="受限 Skill",
                description="测试工具边界。",
                examples=[],
                context_policy=[],
                tools=["inventory.read_summary"],
                output_types=[],
                draft_types=[],
                approval_policy="none",
                intent="limited",
                agent_key="limited_agent",
            )
            registry = SkillRegistry()
            registry.register(UndeclaredToolSkill(manifest))
            with self.SessionLocal() as db:
                result = SkillExecutor(registry).run(
                    PlannerResult(skills=["limited_skill"]),
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="测试",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(
                                db=db,
                                family_id=self.family.id,
                                user_id=self.user.id,
                                conversation_id="conversation-test",
                                run_id="run-test",
                            ),
                        ),
                        provider=FakeChatProvider(),
                    ),
                )

            self.assertEqual(result.status, "failed")
            self.assertIn("受限 Skill执行失败", result.text)
            self.assertIn("未声明工具", result.context_summary["skillExecutions"][0]["diagnostic"])

        def test_skill_executor_rejects_forbidden_tool_calls_even_when_allowed(self) -> None:
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
                    allowed_tools={"inventory.read_available_items"},
                    forbidden_tools={"inventory.read_available_items"},
                    allowed_side_effects={"read"},
                )
                with self.assertRaisesRegex(PermissionError, "禁止调用工具"):
                    executor.call("inventory.read_available_items", {"limit": 10})

        def test_skill_executor_rejects_undeclared_draft_results(self) -> None:
            class BadDraftSkill(BaseSkill):
                def run(self, context: SkillContext) -> SkillResult:
                    return SkillResult(text="bad", drafts=[{"draft_type": "meal_plan", "payload": {}}])

            manifest = SkillManifest(
                key="bad_draft_skill",
                name="坏草稿 Skill",
                description="测试草稿契约。",
                approval_policy="none",
                intent="bad_draft",
                agent_key="bad_draft_agent",
            )
            registry = SkillRegistry()
            registry.register(BadDraftSkill(manifest))
            with self.SessionLocal() as db:
                result = SkillExecutor(registry).run(
                    PlannerResult(skills=["bad_draft_skill"]),
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="测试",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(
                                db=db,
                                family_id=self.family.id,
                                user_id=self.user.id,
                                conversation_id="conversation-test",
                                run_id="run-test",
                            ),
                        ),
                        provider=FakeChatProvider(),
                    ),
                )
            self.assertEqual(result.status, "failed")
            self.assertIn("returned drafts without draft approval policy", result.context_summary["skillExecutions"][0]["diagnostic"])

        def test_skill_executor_rejects_undeclared_card_type(self) -> None:
            class BadCardSkill(BaseSkill):
                def run(self, context: SkillContext) -> SkillResult:
                    return SkillResult(text="bad", cards=[{"type": "shopping_list_draft", "data": {}}])

            manifest = SkillManifest(
                key="bad_card_skill",
                name="坏卡片 Skill",
                description="测试卡片契约。",
                output_types=["inventory_summary"],
                approval_policy="none",
                intent="bad_card",
                agent_key="bad_card_agent",
            )
            registry = SkillRegistry()
            registry.register(BadCardSkill(manifest))
            with self.SessionLocal() as db:
                result = SkillExecutor(registry).run(
                    PlannerResult(skills=["bad_card_skill"]),
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="测试",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=FakeChatProvider(),
                    ),
                )

            self.assertEqual(result.status, "failed")
            self.assertIn("returned undeclared card type", result.context_summary["skillExecutions"][0]["diagnostic"])

        def test_skill_executor_rejects_invalid_result_status(self) -> None:
            class BadStatusSkill(BaseSkill):
                def run(self, context: SkillContext) -> SkillResult:
                    return SkillResult(text="bad", status="waiting")

            manifest = SkillManifest(
                key="bad_status_skill",
                name="坏状态 Skill",
                description="测试状态契约。",
                approval_policy="none",
                intent="bad_status",
                agent_key="bad_status_agent",
            )
            registry = SkillRegistry()
            registry.register(BadStatusSkill(manifest))
            with self.SessionLocal() as db:
                result = SkillExecutor(registry).run(
                    PlannerResult(skills=["bad_status_skill"]),
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="测试",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=FakeChatProvider(),
                    ),
                )

            self.assertEqual(result.status, "failed")
            self.assertIn("returned invalid status", result.context_summary["skillExecutions"][0]["diagnostic"])

        def test_tool_calling_inventory_skill_reads_declared_tools_and_model_response(self) -> None:
            skill = build_workspace_skill_registry().get("inventory_analysis")
            self.assertIsInstance(skill, ToolCallingSkill)
            with self.SessionLocal() as db:
                tool_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="库存怎么样",
                        tool_executor=tool_executor,
                        provider=FakeChatProvider(),
                    )
                )
                tool_names = [item["name"] for item in tool_executor.records()]

            self.assertEqual(result.status, "completed")
            self.assertIn("当前可用库存", result.text)
            self.assertEqual(result.cards[0]["type"], "inventory_summary")
            self.assertEqual(result.cards[0]["data"]["queryFocus"], "overview")
            self.assertNotIn("suggestedAction", result.cards[0]["data"]["items"][0])
            self.assertEqual(result.context_summary["inventoryItemCount"], 1)
            self.assertIn("inventory.read_summary", tool_names)
            self.assertIn("inventory.read_expiring_items", tool_names)

        def test_inventory_card_is_built_from_available_items_when_summary_tool_is_not_called(self) -> None:
            class AvailableOnlyProvider(BaseChatProvider):
                model_name = "available-only-model"

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
                    tool_handler("inventory.read_available_items", {"limit": 20})
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "这里是可用库存。",
                                "cards": [{"type": "inventory_summary", "title": "可用库存", "data": {}}],
                                "status": "completed",
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            skill = build_workspace_skill_registry().get("inventory_analysis")
            with self.SessionLocal() as db:
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="我有什么食材可以用",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=AvailableOnlyProvider(),
                    )
                )

            data = result.cards[0]["data"]
            self.assertEqual(data["availableCount"], 1)
            self.assertEqual(data["queryFocus"], "available")
            self.assertEqual(data["items"][0]["name"], "番茄")
            self.assertEqual(data["items"][0]["image"]["id"], "media-ingredient-tomato")
            self.assertNotIn("suggestedAction", data["items"][0])

        def test_inventory_card_is_added_when_model_omits_cards(self) -> None:
            class NoCardInventoryProvider(BaseChatProvider):
                model_name = "no-card-inventory-model"

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
                    tool_handler("inventory.read_low_stock_items", {"limit": 20})
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "这里是需要补货的库存。",
                                "cards": [],
                                "status": "completed",
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            with self.SessionLocal() as db:
                item = db.get(InventoryItem, "inventory-tomato")
                assert item is not None
                item.low_stock_threshold = Decimal("4")
                db.flush()
                result = build_workspace_skill_registry().get("inventory_analysis").run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="哪些库存需要补货",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=NoCardInventoryProvider(),
                    )
                )

            self.assertEqual(result.cards[0]["type"], "inventory_summary")
            self.assertEqual(result.cards[0]["data"]["queryFocus"], "low_stock")
            self.assertEqual(result.cards[0]["data"]["items"][0]["suggestedAction"], "restock")

        def test_tool_calling_skill_builds_clarification_card_from_tool_output(self) -> None:
            class ClarificationProvider(BaseChatProvider):
                model_name = "clarification-model"

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
                    tool_handler(
                        "intent.request_clarification",
                        {
                            "question": "你要修改哪一条晚餐计划？",
                            "questionType": "meal_plan_disambiguation",
                            "missingFields": ["目标计划"],
                            "candidates": [
                                {
                                    "id": "plan-1",
                                    "label": "2026-06-15 晚餐 · 番茄炒蛋",
                                    "summary": "创建人：妈妈",
                                    "updatedAt": "2026-06-15T09:00:00Z",
                                }
                            ],
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
                        current_message="把晚餐改一下",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=ClarificationProvider(),
                    )
                )

            self.assertTrue(result.requires_clarification)
            self.assertEqual(result.cards[0]["type"], "clarification_request")
            self.assertEqual(result.cards[0]["data"]["questionType"], "meal_plan_disambiguation")
            self.assertEqual(result.cards[0]["data"]["candidates"][0]["label"], "2026-06-15 晚餐 · 番茄炒蛋")

        def test_tool_calling_skill_fills_clarification_candidates_from_read_outputs(self) -> None:
            class MissingCandidatesProvider(BaseChatProvider):
                model_name = "clarification-model"

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
                    tool_handler("shopping.read_pending", {"query": "三文鱼", "limit": 50})
                    tool_handler(
                        "intent.request_clarification",
                        {
                            "question": "购物清单里有多个待买的三文鱼。你想处理哪一个？",
                            "questionType": "entity_disambiguation",
                            "missingFields": ["目标购物项"],
                            "allowFreeText": True,
                        },
                    )
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "我需要先确认是哪一项。",
                                "status": "completed",
                                "requires_clarification": True,
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            skill = build_workspace_skill_registry().get("shopping_list")
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        ShoppingListItem(
                            id="shopping-salmon-1",
                            family_id=self.family.id,
                            title="三文鱼",
                            quantity=Decimal("1"),
                            unit="块",
                            reason="晚餐",
                            done=False,
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                        ShoppingListItem(
                            id="shopping-salmon-2",
                            family_id=self.family.id,
                            title="三文鱼",
                            quantity=Decimal("2"),
                            unit="片",
                            reason="早餐",
                            done=False,
                            created_by=self.user.id,
                            updated_by=self.user.id,
                        ),
                    ]
                )
                db.flush()
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="删除购物清单里的三文鱼",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=MissingCandidatesProvider(),
                    )
                )

            self.assertTrue(result.requires_clarification)
            candidates = result.cards[0]["data"]["candidates"]
            candidates_by_id = {candidate["id"]: candidate for candidate in candidates}
            self.assertEqual(set(candidates_by_id), {"shopping-salmon-1", "shopping-salmon-2"})
            self.assertEqual(candidates_by_id["shopping-salmon-1"]["label"], "三文鱼")
            self.assertEqual(candidates_by_id["shopping-salmon-1"]["summary"], "1.0块 · 晚餐")
            pending_candidates = result.state_patch["pendingClarification"]["payload"]["candidates"]
            self.assertEqual({candidate["id"] for candidate in pending_candidates}, {"shopping-salmon-1", "shopping-salmon-2"})

        def test_tool_calling_skill_recovers_draft_when_final_json_stream_fails(self) -> None:
            class DraftThenFallbackProvider(BaseChatProvider):
                model_name = "draft-fallback-model"

                def __init__(self, meal_log_id: str, entry_id: str, base_updated_at: str) -> None:
                    self.meal_log_id = meal_log_id
                    self.entry_id = entry_id
                    self.base_updated_at = base_updated_at

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
                    tool_handler(
                        "meal_log.create_draft",
                        {
                            "draft": {
                                "draftType": "meal_log",
                                "schemaVersion": "meal_log_operation.v1",
                                "action": "rate_food",
                                "targetId": self.meal_log_id,
                                "baseUpdatedAt": self.base_updated_at,
                                "payload": {
                                    "foodEntryRatings": [{"id": self.entry_id, "rating": 4.5}],
                                },
                            },
                        },
                    )
                    return ChatProviderResult(
                        text=None,
                        status="fallback",
                        model=self.model_name,
                        error="Connection error.",
                        structured_mode="tool_call",
                        tool_calls=[{"id": "call-1", "name": "meal_log.create_draft", "args": {}}],
                    )

            skill = build_workspace_skill_registry().get("meal_log")
            with self.SessionLocal() as db:
                food = db.scalar(select(Food).where(Food.id == "food-tomato"))
                assert food is not None
                meal_log = MealLog(
                    id="meal-log-fallback-rate-target",
                    family_id=self.family.id,
                    date=date.today(),
                    meal_type=MealType.DINNER,
                    participant_user_ids=[self.user.id],
                    notes="",
                    mood="",
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
                db.add(meal_log)
                db.flush()
                entry = MealLogFood(
                    id="meal-log-fallback-rate-entry",
                    meal_log_id=meal_log.id,
                    food_id=food.id,
                    servings=Decimal("1"),
                    note="",
                    rating=None,
                )
                db.add(entry)
                db.flush()
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="给刚才那顿番茄炒蛋打 4.5 分",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                        ),
                        provider=DraftThenFallbackProvider(meal_log.id, entry.id, meal_log.updated_at.isoformat()),
                    )
                )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.operation, "rate_food")
            self.assertEqual(result.context_summary["draftType"], "meal_log")
            self.assertEqual(result.text, "我整理了餐食记录评分草稿，请确认后再写入。")
            self.assertEqual(result.drafts[0]["draft_type"], "meal_log")
            self.assertEqual(result.drafts[0]["payload"]["payload"]["foodEntryRatings"], [{"id": "meal-log-fallback-rate-entry", "rating": 4.5}])

        def test_skill_executor_marks_clarification_progress_as_waiting(self) -> None:
            class ClarificationProvider(BaseChatProvider):
                model_name = "clarification-model"

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
                    tool_handler(
                        "intent.request_clarification",
                        {
                            "question": "你要修改哪一条晚餐计划？",
                            "questionType": "meal_plan_disambiguation",
                            "missingFields": ["目标计划"],
                            "candidates": [],
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

            progress_events: list[dict] = []

            def capture_progress(update: dict) -> None:
                progress_events.append(update["data"])

            with self.SessionLocal() as db:
                result = SkillExecutor(build_workspace_skill_registry()).run_step(
                    "meal_plan",
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="把晚餐改一下",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(
                                db=db,
                                family_id=self.family.id,
                                user_id=self.user.id,
                                conversation_id="conversation-test",
                                run_id="run-test",
                                stream_writer=capture_progress,
                            ),
                        ),
                        provider=ClarificationProvider(),
                        stream_writer=capture_progress,
                    ),
                )

            self.assertTrue(result.requires_clarification)
            progress_event_summaries = [
                {
                    "internal_code": event.get("internal_code"),
                    "user_message": event.get("user_message"),
                    "status": event.get("status"),
                }
                for event in progress_events
                if isinstance(event, dict) and event.get("internal_code")
            ]
            self.assertIn(
                {"internal_code": "intent.request_clarification", "user_message": "等待用户补充信息", "status": "waiting"},
                progress_event_summaries,
            )
            self.assertEqual(progress_event_summaries[-1]["internal_code"], "meal_plan.waiting_clarification")
            self.assertEqual(progress_event_summaries[-1]["user_message"], "餐食计划等待补充信息")
            self.assertEqual(progress_event_summaries[-1]["status"], "waiting")

        def test_tool_calling_skill_rejects_undeclared_card_type(self) -> None:
            class PreviewCardProvider(BaseChatProvider):
                model_name = "preview-card-model"

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
                ) -> ChatProviderResult:
                    del system, user, tools, response_schema, max_rounds
                    item = {
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "使用当前库存。",
                        "usedInventory": ["番茄"],
                        "missingIngredients": ["鸡蛋"],
                    }
                    draft = {
                        "draftType": "meal_plan",
                        "schemaVersion": "meal_plan.v1",
                        "items": [item],
                        "source": {"days": 1, "mealTypes": ["dinner"]},
                    }
                    tool_handler("meal_plan.create_draft", {"draft": draft})
                    return ChatProviderResult(
                        text=json.dumps(
                            {
                                "text": "我生成了 1 条餐食计划草稿。",
                                "cards": [
                                    {
                                        "id": "meal-plan-preview",
                                        "type": "meal_plan_preview",
                                        "title": "餐食计划预览",
                                        "data": {"draft": draft, "items": [item]},
                                    }
                                ],
                                "events": [],
                                "context_summary": {},
                                "state_patch": {},
                                "requires_clarification": False,
                                "status": "completed",
                                "error": None,
                            },
                            ensure_ascii=False,
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            skill = build_workspace_skill_registry().get("meal_plan")
            with self.SessionLocal() as db:
                tool_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                with self.assertRaisesRegex(ValueError, "undeclared card type"):
                    skill.run(
                        SkillContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-test",
                            run_id="run-test",
                            conversation=[],
                            current_message="安排一天晚餐",
                            tool_executor=tool_executor,
                            provider=PreviewCardProvider(),
                        )
                    )

        def test_tool_calling_skill_streams_visible_text_around_tool_calls(self) -> None:
            class InterleavedProvider(BaseChatProvider):
                model_name = "interleaved-model"

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
                    del system, user, tools, response_schema, max_rounds
                    if visible_text_handler is not None:
                        visible_text_handler("<visible_text>我先")
                        visible_text_handler("看一下临期食材。</visible_text>")
                    tool_handler("inventory.read_expiring_items", {"days": 7})
                    item = {
                        "date": date.today().isoformat(),
                        "mealType": "dinner",
                        "title": "番茄小炒",
                        "foodId": "food-tomato",
                        "recipeId": None,
                        "reason": "使用当前库存。",
                        "usedInventory": ["番茄"],
                        "missingIngredients": [],
                    }
                    draft = {
                        "draftType": "meal_plan",
                        "schemaVersion": "meal_plan.v1",
                        "items": [item],
                        "source": {"days": 1, "mealTypes": ["dinner"]},
                    }
                    tool_handler("meal_plan.create_draft", {"draft": draft})
                    if visible_text_handler is not None:
                        visible_text_handler("<visible_text>我生成了 1 条餐食计划草稿。</visible_text>")
                    payload = {
                        "text": "我先看一下临期食材。我生成了 1 条餐食计划草稿。",
                        "cards": [],
                        "events": [{"type": "draft", "message": "已生成餐食计划草稿"}],
                        "context_summary": {"draftType": "meal_plan"},
                        "state_patch": {},
                        "requires_clarification": False,
                        "status": "completed",
                        "error": None,
                        "operation": "create",
                    }
                    return ChatProviderResult(
                        text=f"<visible_text>我生成了 1 条餐食计划草稿。</visible_text><structured_result>{json.dumps(payload, ensure_ascii=False)}</structured_result>",
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                        tool_calls=[
                            {"name": "inventory.read_expiring_items", "args": {"days": 7}},
                            {"name": "meal_plan.create_draft", "args": {}},
                        ],
                    )

            skill = build_workspace_skill_registry().get("meal_plan")
            stream_events: list[dict] = []
            with self.SessionLocal() as db:
                tool_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                    ),
                )
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="安排一天晚餐",
                        tool_executor=tool_executor,
                        provider=InterleavedProvider(),
                        stream_writer=lambda item: stream_events.append(item),
                    )
                )
                tool_names = [item["name"] for item in tool_executor.records()]

            deltas = [event["data"]["delta"] for event in stream_events if event.get("event") == "message_delta"]
            self.assertEqual(deltas, ["我先看一下临期食材。\n", "我生成了 1 条餐食计划草稿。\n"])
            self.assertEqual(result.text, "我先看一下临期食材。\n我生成了 1 条餐食计划草稿。")
            self.assertNotIn("structured_result", result.text)
            self.assertEqual(result.drafts[0]["draft_type"], "meal_plan")
            self.assertIn("inventory.read_expiring_items", tool_names)
            self.assertIn("meal_plan.create_draft", tool_names)

        def test_tool_calling_skill_uses_larger_round_budget_for_tool_rich_skills(self) -> None:
            observed: dict[str, int] = {}

            class BudgetProvider(BaseChatProvider):
                model_name = "budget-model"

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
                    del system, user, tools, tool_handler, response_schema, visible_text_handler
                    observed["max_rounds"] = max_rounds
                    payload = {
                        "text": "我先确认计划范围。",
                        "cards": [],
                        "events": [],
                        "context_summary": {},
                        "state_patch": {},
                        "requires_clarification": True,
                        "status": "completed",
                        "error": None,
                        "operation": "clarify",
                    }
                    return ChatProviderResult(
                        text=f"<visible_text>{payload['text']}</visible_text><structured_result>{json.dumps(payload, ensure_ascii=False)}</structured_result>",
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
                        current_message="把明天晚餐安排成番茄小炒",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(
                                db=db,
                                family_id=self.family.id,
                                user_id=self.user.id,
                                conversation_id="conversation-test",
                                run_id="run-test",
                            ),
                        ),
                        provider=BudgetProvider(),
                    )
                )

            self.assertEqual(result.status, "completed")
            self.assertGreater(observed["max_rounds"], 8)

        def test_tool_calling_skill_fails_invalid_model_json(self) -> None:
            skill = build_workspace_skill_registry().get("inventory_analysis")
            with self.SessionLocal() as db:
                result = skill.run(
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="库存怎么样",
                        tool_executor=ToolExecutor(
                            build_workspace_tool_registry(),
                            ToolContext(
                                db=db,
                                family_id=self.family.id,
                                user_id=self.user.id,
                                conversation_id="conversation-test",
                                run_id="run-test",
                            ),
                        ),
                        provider=SequenceChatProvider(["不是 JSON"]),
                    )
                )

            self.assertEqual(result.status, "failed")
            self.assertIn("没有返回有效结果", result.text)

        def test_tool_calling_meal_plan_repairs_empty_items(self) -> None:
            empty_decision = json.dumps(
                {
                    "operation": "create",
                    "sourceArtifactId": None,
                    "days": 1,
                    "mealTypes": ["dinner"],
                    "constraints": [],
                    "clarification": None,
                    "items": [],
                },
                ensure_ascii=False,
            )
            repaired_decision = json.dumps(
                {
                    "operation": "create",
                    "sourceArtifactId": None,
                    "days": 1,
                    "mealTypes": ["dinner"],
                    "constraints": ["light"],
                    "clarification": None,
                    "items": [
                        {
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "title": "番茄小炒",
                            "foodId": "food-tomato",
                            "recipeId": None,
                            "reason": "修复后补充计划项",
                            "usedInventory": ["番茄"],
                            "missingIngredients": ["鸡蛋"],
                        }
                    ],
                },
                ensure_ascii=False,
            )
            provider = SequenceChatProvider([empty_decision, repaired_decision])
            with self.SessionLocal() as db:
                tool_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                )
                result = SkillExecutor(build_workspace_skill_registry()).run_step(
                    "meal_plan",
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="安排一天晚餐",
                        tool_executor=tool_executor,
                        provider=provider,
                    ),
                )
                tool_names = [item["name"] for item in tool_executor.records()]

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.cards, [])
            self.assertEqual(result.context_summary["scriptValidation"], {"valid": True, "errors": [], "warnings": []})
            self.assertEqual(result.drafts[0]["draft_type"], "meal_plan")
            self.assertIn("番茄小炒", str(result.drafts[0]["payload"]))
            self.assertIn("script.validate_meal_plan", tool_names)
            self.assertIn("meal_plan.create_draft", tool_names)
            self.assertLess(
                tool_names.index("script.validate_meal_plan"),
                tool_names.index("meal_plan.create_draft"),
            )
            self.assertEqual(provider.responses, [])

        def test_tool_calling_shopping_list_invalid_source_does_not_create_draft(self) -> None:
            provider = SequenceChatProvider(
                [
                    json.dumps(
                        {
                            "operation": "derive",
                            "sourceArtifactId": "missing-meal-plan",
                            "clarification": None,
                            "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "用于晚餐", "sourceMeals": ["番茄鸡蛋面"]}],
                        },
                        ensure_ascii=False,
                    )
                ]
            )
            with self.SessionLocal() as db:
                tool_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                )
                result = SkillExecutor(build_workspace_skill_registry()).run_step(
                    "shopping_list",
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_message="基于这个计划生成采购清单",
                        tool_executor=tool_executor,
                        provider=provider,
                    ),
                )
                tool_names = [item["name"] for item in tool_executor.records()]

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "invalid meal_plan source artifact")
            self.assertNotIn("shopping.create_draft", tool_names)

        def test_tool_calling_shopping_list_accepts_current_run_meal_plan_artifact(self) -> None:
            provider = SequenceChatProvider(
                [
                    json.dumps(
                        {
                            "operation": "derive",
                            "sourceArtifactId": "in_run:meal_plan:meal_plan:1",
                            "clarification": None,
                            "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "用于晚餐", "sourceMeals": ["番茄鸡蛋面"]}],
                        },
                        ensure_ascii=False,
                    )
                ]
            )
            with self.SessionLocal() as db:
                tool_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                )
                result = SkillExecutor(build_workspace_skill_registry()).run_step(
                    "shopping_list",
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        conversation=[],
                        current_run_artifacts=[
                            {
                                "id": "in_run:meal_plan:meal_plan:1",
                                "type": "meal_plan",
                                "kind": "draft",
                                "status": "proposed",
                                "payload": {"items": [{"title": "番茄鸡蛋面"}]},
                                "sourceSkill": "meal_plan",
                            }
                        ],
                        current_message="基于这个计划生成采购清单",
                        tool_executor=tool_executor,
                        provider=provider,
                    ),
                )
                tool_names = [item["name"] for item in tool_executor.records()]

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.drafts[0]["draft_type"], "shopping_list")
            self.assertEqual(result.drafts[0]["payload"]["sourceDraftId"], "in_run:meal_plan:meal_plan:1")
            self.assertIn("shopping.create_draft", tool_names)

        def test_tool_calling_shopping_list_empty_repair_still_empty_skips_draft(self) -> None:
            empty_decision = json.dumps(
                {
                    "operation": "derive",
                    "sourceArtifactId": "artifact-meal-plan",
                    "clarification": None,
                    "items": [],
                },
                ensure_ascii=False,
            )
            provider = SequenceChatProvider([empty_decision, empty_decision])
            conversation = [
                {
                    "id": "message-with-plan",
                    "role": "assistant",
                    "content": "餐食计划草稿",
                    "artifacts": [
                        {
                            "id": "artifact-meal-plan",
                            "type": "meal_plan",
                            "version": 1,
                            "status": "confirmed",
                            "payload": {"items": [{"title": "番茄鸡蛋面", "missingIngredients": ["鸡蛋"]}]},
                        }
                    ],
                }
            ]
            with self.SessionLocal() as db:
                tool_executor = ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(db=db, family_id=self.family.id, user_id=self.user.id, conversation_id="conversation-test", run_id="run-test"),
                )
                result = SkillExecutor(build_workspace_skill_registry()).run_step(
                    "shopping_list",
                    SkillContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation=conversation,
                        conversation_id="conversation-test",
                        run_id="run-test",
                        current_message="生成购物清单",
                        tool_executor=tool_executor,
                        provider=provider,
                    ),
                )
                tool_names = [item["name"] for item in tool_executor.records()]

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.drafts, [])
            self.assertIn("当前没有需要加入购物清单", result.text)
            self.assertNotIn("shopping.create_draft", tool_names)
            self.assertEqual(provider.responses, [])
