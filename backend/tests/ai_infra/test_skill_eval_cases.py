from ._support import *


class EvalToolCallProvider(BaseChatProvider):
    model_name = "eval-tool-call-model"

    def __init__(self, scenario: str) -> None:
        self.scenario = scenario

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        raise AssertionError("eval cases should use generate_with_tools")

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
        if self.scenario == "food_profile_low_risk_defaults":
            tool_handler("food.search", {"query": "盒装牛奶", "exact": True, "limit": 5})
            tool_handler(
                "food_profile.create_draft",
                {
                    "draft": {
                        "draftType": "food_profile",
                        "schemaVersion": "food_profile.v1",
                        "name": "盒装牛奶",
                        "type": "readyMade",
                        "category": "饮品",
                        "suitable_meal_types": ["breakfast"],
                        "scene_tags": ["早餐"],
                        "routine_note": "适合早餐直接饮用，确认前可以修改分类和适用餐别。",
                    }
                },
            )
            return self._result("我整理了盒装牛奶的食物资料草稿，请确认后再保存。", operation="create")

        if self.scenario == "recipe_delete_disambiguation":
            recipes = tool_handler("recipe.search", {"query": "番茄", "limit": 10})
            tool_handler(
                "intent.request_clarification",
                {
                    "question": "找到多个番茄相关菜谱，请选择要删除哪一个。",
                    "questionType": "entity_disambiguation",
                    "missingFields": ["菜谱"],
                    "candidates": [
                        {
                            "id": item["id"],
                            "label": item["title"],
                            "entityType": "recipe",
                            "updatedAt": item.get("updatedAt"),
                        }
                        for item in recipes.get("items", [])
                    ],
                    "allowFreeText": False,
                },
            )
            return self._result("我需要先确认要删除哪一个番茄菜谱。", requires_clarification=True)

        if self.scenario == "recommendation_no_draft":
            tool_handler("inventory.read_available_items", {"limit": 20})
            tool_handler("meal_log.read_recent", {"limit": 8})
            tool_handler("food.search", {"query": "番茄", "limit": 10})
            return self._result("今晚可以吃番茄小炒，比较省事。")

        if self.scenario == "expired_inventory_dispose":
            expired = tool_handler("inventory.read_expired_items", {"limit": 20})
            item = expired["items"][0]
            tool_handler(
                "inventory.create_operation_draft",
                {
                    "draft": {
                        "draftType": "inventory_operation",
                        "schemaVersion": "inventory_operation.v1",
                        "operations": [
                            {
                                "action": "dispose",
                                "ingredientId": item["ingredientId"],
                                "inventoryItemId": item["id"],
                                "quantity": float(item["quantity"]),
                                "unit": item["unit"],
                                "reason": "已过期",
                            }
                        ],
                    }
                },
            )
            return self._result("我整理了过期库存销毁草稿，请确认后再处理。", operation="dispose")

        raise AssertionError(f"unknown eval scenario: {self.scenario}")

    def _result(self, text: str, *, requires_clarification: bool = False, operation: str | None = None) -> ChatProviderResult:
        return ChatProviderResult(
            text=json.dumps(
                {
                    "text": text,
                    "cards": [],
                    "events": [],
                    "context_summary": {},
                    "state_patch": {},
                    "requires_clarification": requires_clarification,
                    "status": "completed",
                    "error": None,
                    "operation": operation,
                },
                ensure_ascii=False,
            ),
            status="completed",
            model=self.model_name,
            structured_mode="tool_call",
        )


class AISkillEvalCasesTestCase(AIAgentInfraTestCase):
    def _run_skill(self, db: Session, skill_key: str, message: str, scenario: str) -> SkillResult:
        return build_workspace_skill_registry().get(skill_key).run(
            SkillContext(
                db=db,
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id=f"conversation-eval-{scenario}",
                run_id=f"run-eval-{scenario}",
                conversation=[],
                current_message=message,
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=db,
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id=f"conversation-eval-{scenario}",
                        run_id=f"run-eval-{scenario}",
                    ),
                ),
                provider=EvalToolCallProvider(scenario),
            )
        )

    def test_eval_allows_low_risk_food_profile_defaults_without_clarification(self) -> None:
        with self.SessionLocal() as db:
            result = self._run_skill(
                db,
                "food_profile",
                "盒装牛奶，类型即食，适合早餐，帮我建资料",
                "food_profile_low_risk_defaults",
            )

        self.assertFalse(result.requires_clarification)
        self.assertEqual(result.drafts[0]["draft_type"], "food_profile")
        payload = result.drafts[0]["payload"]
        self.assertEqual(payload["name"], "盒装牛奶")
        self.assertEqual(payload["type"], "readyMade")
        self.assertEqual(payload["category"], "饮品")
        self.assertEqual(payload["suitable_meal_types"], ["breakfast"])

    def test_eval_clarifies_destructive_recipe_target_when_candidates_are_ambiguous(self) -> None:
        with self.SessionLocal() as db:
            db.add(
                Recipe(
                    id="recipe-eval-tomato-duplicate",
                    family_id=self.family.id,
                    title="番茄汤",
                    servings=2,
                    prep_minutes=15,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
            )
            db.add(
                Recipe(
                    id="recipe-eval-tomato-second",
                    family_id=self.family.id,
                    title="番茄拌面",
                    servings=2,
                    prep_minutes=12,
                    difficulty=Difficulty.EASY,
                    tips="",
                    scene_tags=[],
                    created_by=self.user.id,
                    updated_by=self.user.id,
                )
            )
            db.flush()
            result = self._run_skill(db, "recipe_draft", "把那个番茄菜谱删了", "recipe_delete_disambiguation")

        self.assertTrue(result.requires_clarification)
        self.assertEqual(result.drafts, [])
        self.assertEqual(result.cards[0]["type"], "clarification_request")
        self.assertGreaterEqual(len(result.cards[0]["data"]["candidates"]), 2)

    def test_eval_recommendation_uses_real_food_card_without_creating_draft(self) -> None:
        with self.SessionLocal() as db:
            result = self._run_skill(db, "meal_plan", "今晚吃什么，别太麻烦", "recommendation_no_draft")

        self.assertEqual(result.drafts, [])
        self.assertEqual(result.cards[0]["type"], "today_recommendation")
        recommendation = result.cards[0]["data"]["recommendations"][0]
        self.assertEqual(recommendation["foodId"], "food-tomato")
        self.assertEqual(recommendation["name"], "番茄小炒")

    def test_eval_dispose_expired_inventory_requires_approval_draft(self) -> None:
        with self.SessionLocal() as db:
            item = db.get(InventoryItem, "inventory-tomato")
            assert item is not None
            item.expiry_date = today_for_family(self.family.id) - timedelta(days=1)
            db.flush()
            result = self._run_skill(db, "inventory_analysis", "过期的都扔掉", "expired_inventory_dispose")

        self.assertEqual(result.cards, [])
        self.assertEqual(result.drafts[0]["draft_type"], "inventory_operation")
        operation = result.drafts[0]["payload"]["operations"][0]
        self.assertEqual(operation["action"], "dispose")
        self.assertEqual(operation["inventoryItemId"], "inventory-tomato")
        self.assertEqual(operation["reason"], "已过期")
