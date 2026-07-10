from typing import Any

from ._support import *

from app.ai.tools.base import ToolDefinition
from app.ai.tools.registry import ToolRegistry
from app.models.domain import AIRunLLMExchange, AIRunTraceSpan
from app.services.ai_operations.artifacts import (
    approval_result_count_label,
    approval_result_default_action,
    approval_result_operation_label,
    approval_result_workspace_label,
    fallback_type_label,
)
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import (
    DraftExecuteContext,
    DraftNormalizeContext,
    DraftOperationRegistry,
    DraftOperationSpec,
    DraftPostExecuteContext,
)


class AIRegistryAndMetricsTestCase(AIAgentInfraTestCase):
        def test_tool_registry_requires_draft_and_card_contract_metadata(self) -> None:
            def handler(_context, _payload: dict[str, Any]) -> dict[str, Any]:
                return {}

            with self.assertRaisesRegex(ValueError, "must declare draft_types"):
                ToolRegistry().register(
                    ToolDefinition(
                        name="test.create_draft",
                        display_name="测试草稿",
                        description="测试缺失 draft type。",
                        input_schema={"type": "object"},
                        output_schema={"type": "object"},
                        permission="family:draft",
                        side_effect="draft",
                        handler=handler,
                    )
                )

            with self.assertRaisesRegex(ValueError, "output_types must cover card schema types: test_card"):
                ToolRegistry().register(
                    ToolDefinition(
                        name="test.card",
                        display_name="测试卡片",
                        description="测试缺失 output type。",
                        input_schema={"type": "object"},
                        output_schema={
                            "type": "object",
                            "properties": {
                                "card": {
                                    "type": "object",
                                    "properties": {
                                        "type": {"type": "string", "enum": ["test_card"]},
                                    },
                                }
                            },
                        },
                        permission="family:read",
                        side_effect="read",
                        handler=handler,
                    )
                )

            with self.assertRaisesRegex(ValueError, "must not declare draft_types"):
                ToolRegistry().register(
                    ToolDefinition(
                        name="test.read",
                        display_name="测试读取",
                        description="测试错误 draft type。",
                        input_schema={"type": "object"},
                        output_schema={"type": "object"},
                        permission="family:read",
                        side_effect="read",
                        handler=handler,
                        draft_types=["recipe"],
                    )
                )

        def test_draft_operation_registry_rejects_duplicate_draft_types(self) -> None:
            def normalize(context: DraftNormalizeContext) -> dict[str, Any]:
                return context.payload

            def execute(context: DraftExecuteContext) -> tuple[dict[str, Any], list[str]]:
                return context.payload, []

            spec = DraftOperationSpec(
                draft_type="duplicate_draft",
                normalize=normalize,
                execute=execute,
                after_success=None,
                approval_config=lambda _payload: {"approval_type": "duplicate.apply"},
                preview_summary=lambda _payload: "重复草稿",
            )

            with self.assertRaisesRegex(
                ValueError,
                "Duplicate draft operation types registered: duplicate_draft",
            ):
                DraftOperationRegistry([spec, spec])

        def test_skill_registry_rejects_duplicate_keys(self) -> None:
            registry = SkillRegistry()
            first = CatalogSkill(
                SkillManifest(
                    key="duplicate_skill",
                    name="重复 Skill",
                    description="first",
                )
            )
            second = CatalogSkill(
                SkillManifest(
                    key="duplicate_skill",
                    name="重复 Skill",
                    description="second",
                )
            )

            registry.register(first)

            with self.assertRaisesRegex(ValueError, "Duplicate skill key registered: duplicate_skill"):
                registry.register(second)

        def test_draft_operation_registry_covers_supported_approval_draft_types(self) -> None:
            expected = {
                "recipe",
                "recipe_cook",
                "shopping_list",
                "meal_plan",
                "meal_log",
                "food_profile",
                "ingredient_profile",
                "inventory_operation",
                "composite_operation",
            }
            self.assertEqual(set(draft_operation_registry.keys()), expected)
            self.assertTrue(draft_operation_registry.supports("recipe"))
            self.assertFalse(draft_operation_registry.supports("unknown_draft"))
            self.assertEqual(
                draft_operation_registry.approval_config_for_payload("meal_plan", {"operations": [{"action": "create"}]})["approval_type"],
                "meal_plan.apply",
            )

        def test_draft_operation_registry_centralizes_result_metadata(self) -> None:
            self.assertEqual(draft_operation_registry.workspace_label("meal_plan"), "菜单计划")
            self.assertEqual(draft_operation_registry.count_label("meal_plan", 2), "2 条计划")
            self.assertEqual(draft_operation_registry.fallback_label("meal_plan"), "菜单计划")
            self.assertEqual(draft_operation_registry.default_action("inventory_operation"), "inventory_operation")
            self.assertEqual(
                draft_operation_registry.result_default_action(
                    "inventory_operation",
                    approval_type="inventory.operation",
                    draft_payload={},
                ),
                "inventory_operation",
            )
            self.assertEqual(
                draft_operation_registry.result_default_action(
                    "food_profile",
                    approval_type="food_profile.create",
                    draft_payload={},
                ),
                "create",
            )
            self.assertEqual(draft_operation_registry.operation_label("inventory_operation", "restock"), "补货")
            self.assertIn("直接修改下面的草稿", draft_operation_registry.recovery_hint("meal_plan"))
            self.assertIn("根据当前业务值", draft_operation_registry.recovery_hint("recipe"))
            self.assertIsNone(
                draft_operation_registry.load_current_value(
                    MagicMock(),
                    family_id=self.family.id,
                    draft_type="unknown_draft",
                    target_id="target-1",
                )
            )

            self.assertEqual(approval_result_workspace_label("meal_plan"), "菜单计划")
            self.assertEqual(approval_result_count_label("meal_plan", 1), "1 条计划")
            self.assertEqual(fallback_type_label("meal_plan"), "菜单计划")
            self.assertEqual(
                approval_result_default_action(
                    approval_type="inventory.operation",
                    draft_payload={},
                    draft_type="inventory_operation",
                ),
                "inventory_operation",
            )
            self.assertEqual(approval_result_operation_label("restock"), "补货")
            self.assertEqual(approval_result_workspace_label("unknown_draft"), "对应页面")
            self.assertEqual(approval_result_count_label("unknown_draft", 3), "3 个实体")
            self.assertEqual(fallback_type_label("unknown_draft"), "unknown_draft")

        def test_draft_operation_registry_extracts_business_entity_records_for_artifacts(self) -> None:
            self.assertEqual(
                draft_operation_registry.business_entity_records(
                    "recipe",
                    {
                        "id": "recipe-1",
                        "title": "番茄炒蛋",
                        "steps": [{"summary": "炒蛋"}, {"summary": "炒番茄"}],
                    },
                    entity_type="Recipe",
                ),
                [
                    {
                        "id": "recipe-1",
                        "title": "番茄炒蛋",
                        "steps": [{"summary": "炒蛋"}, {"summary": "炒番茄"}],
                    }
                ],
            )
            self.assertEqual(
                draft_operation_registry.business_entity_records(
                    "recipe_cook",
                    {"cook_log": {"id": "cook-log-1", "title": "番茄炒蛋"}},
                    entity_type="RecipeCookLog",
                ),
                [{"id": "cook-log-1", "title": "番茄炒蛋"}],
            )
            self.assertEqual(
                draft_operation_registry.business_entity_records(
                    "inventory_operation",
                    {
                        "operations": [
                            {
                                "operationId": "op-1",
                                "operation": "restock",
                                "inventory_item": {"id": "inventory-1", "name": "番茄"},
                            }
                        ]
                    },
                    entity_type="InventoryItem",
                ),
                [{"id": "inventory-1", "name": "番茄", "_operation": "restock", "_operationId": "op-1"}],
            )

        def test_draft_operation_registry_runs_inventory_success_hook(self) -> None:
            db = MagicMock()
            result = {"operations": []}
            with patch("app.services.ai_operations.draft_specs.inventory.refresh_inventory_result_card") as refresh:
                draft_operation_registry.after_success(
                    DraftPostExecuteContext(
                        db=db,
                        draft_type="inventory_operation",
                        family_id=self.family.id,
                        user_id=self.user.id,
                        message_id="message-inventory",
                        business_entity=result,
                    )
                )

            refresh.assert_called_once_with(
                db,
                family_id=self.family.id,
                message_id="message-inventory",
                result=result,
                user_id=self.user.id,
            )

        def test_draft_operation_registry_validates_approval_value_shape(self) -> None:
            operation_payload = {
                "operations": [
                    {
                        "action": "update",
                        "targetId": "target-1",
                        "baseUpdatedAt": "2026-06-30T00:00:00+00:00",
                    }
                ]
            }
            draft_operation_registry.validate_approval_value("meal_plan", operation_payload, operation_payload)
            with self.assertRaisesRegex(ValueError, "确认阶段不能修改操作类型、目标或版本基线"):
                draft_operation_registry.validate_approval_value(
                    "meal_plan",
                    operation_payload,
                    {
                        "operations": [
                            {
                                "action": "delete",
                                "targetId": "target-1",
                                "baseUpdatedAt": "2026-06-30T00:00:00+00:00",
                            }
                        ]
                    },
                )

            inventory_payload = {
                "operations": [
                    {
                        "action": "consume",
                        "ingredientId": "ingredient-tomato",
                        "quantity": 1,
                        "unit": "个",
                    }
                ]
            }
            draft_operation_registry.validate_approval_value("inventory_operation", inventory_payload, inventory_payload)
            with self.assertRaisesRegex(ValueError, "处理方式不能"):
                draft_operation_registry.validate_approval_value(
                    "inventory_operation",
                    inventory_payload,
                    {
                        "operations": [
                            {
                                "action": "dispose",
                                "ingredientId": "ingredient-tomato",
                                "quantity": 1,
                                "unit": "个",
                            }
                        ]
                    },
                )

            ingredient_update = {
                "action": "update",
                "targetId": "ingredient-tomato",
                "baseUpdatedAt": "2026-06-30T00:00:00+00:00",
                "payload": {"name": "番茄"},
            }
            with self.assertRaisesRegex(ValueError, "确认阶段不能修改操作类型、目标或版本基线"):
                draft_operation_registry.validate_approval_value(
                    "ingredient_profile",
                    ingredient_update,
                    {**ingredient_update, "targetId": "ingredient-other"},
                )

        def test_ai_registry_endpoint_exposes_skill_and_tool_contracts(self) -> None:
            response = self.client.get("/api/ai/registry")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            skills = {item["key"]: item for item in data["skills"]}
            tools = {item["name"]: item for item in data["tools"]}
            profiles = {item["key"]: item for item in data["profiles"]}

            self.assertEqual(len(skills), 9)
            self.assertEqual(set(profiles), {"main_workspace", "recipe_cook_page"})
            self.assertTrue(profiles["main_workspace"]["default"])
            self.assertFalse(profiles["recipe_cook_page"]["default"])
            self.assertEqual(profiles["main_workspace"]["capability_policy"]["skillInjection"], "dynamic")
            self.assertEqual(profiles["main_workspace"]["capability_policy"]["catalogScope"], "all")
            self.assertEqual(
                profiles["main_workspace"]["capability_policy"]["allowedSkillKeys"],
                [
                    "food_profile",
                    "ingredient_profile",
                    "inventory_analysis",
                    "meal_log",
                    "meal_plan",
                    "recipe_cook",
                    "recipe_draft",
                    "shopping_list",
                ],
            )
            self.assertNotIn(
                "cooking_assistant",
                profiles["main_workspace"]["capability_policy"]["allowedSkillKeys"],
            )
            self.assertIn("skill.inject", profiles["main_workspace"]["capability_policy"]["baseTools"])
            main_route_hints = {
                route_hint
                for group in profiles["main_workspace"]["route_hints"]
                for route_hint in group["quickTasks"]
            }
            self.assertTrue(
                {
                    "meal_plan",
                    "meal_planning",
                    "today_recommendation",
                    "recipe",
                    "recipe_draft",
                    "recipe_cook",
                    "cook_recipe",
                    "shopping",
                    "shopping_list",
                    "inventory",
                    "inventory_analysis",
                    "inventory_summary",
                    "inventory_operation",
                    "food",
                    "food_profile",
                    "ingredient",
                    "ingredient_profile",
                    "meal_log",
                    "meal_record",
                }.issubset(main_route_hints)
            )
            self.assertEqual(profiles["recipe_cook_page"]["initial_skill_keys"], ["cooking_assistant"])
            self.assertEqual(profiles["recipe_cook_page"]["response_style"], "short_spoken")
            self.assertEqual(profiles["recipe_cook_page"]["allowed_surface"], "recipe_cook_page")
            self.assertEqual(profiles["recipe_cook_page"]["matcher"]["quickTasks"], ["cooking_assistant"])
            self.assertEqual(profiles["recipe_cook_page"]["matcher"]["subjectSources"], ["recipe_cook_page"])
            self.assertEqual(profiles["recipe_cook_page"]["matcher"]["surfaces"], ["recipe_cook_page"])
            self.assertEqual(profiles["recipe_cook_page"]["capability_policy"]["skillInjection"], "fixed")
            self.assertEqual(profiles["recipe_cook_page"]["capability_policy"]["catalogScope"], "initial_only")
            self.assertEqual(profiles["recipe_cook_page"]["capability_policy"]["draftContract"], "hidden")
            self.assertEqual(profiles["recipe_cook_page"]["capability_policy"]["artifactContext"], "without_drafts")
            self.assertEqual(profiles["recipe_cook_page"]["capability_policy"]["allowedSkillKeys"], ["cooking_assistant"])
            self.assertNotIn("skill.inject", profiles["recipe_cook_page"]["capability_policy"]["baseTools"])
            self.assertEqual(profiles["recipe_cook_page"]["budget_config"]["maxBusinessSkillsPerRun"], 0)
            self.assertEqual(profiles["recipe_cook_page"]["route_hints"], [])
            self.assertNotIn("today_recommendation", skills)
            self.assertIn("today_recommendation", skills["meal_plan"]["output_types"])
            self.assertNotIn("clarification_request", skills["meal_plan"]["output_types"])
            self.assertIn("cooking_assistant", skills)
            self.assertEqual(skills["cooking_assistant"]["approval_policy"], "none")
            self.assertIn("ui.propose_actions", skills["cooking_assistant"]["tools"])
            self.assertIn("ui_actions", skills["cooking_assistant"]["output_types"])
            self.assertIn("ingredient_profile", skills)
            self.assertIn("meal_log", skills)
            self.assertIn("recipe_cook", skills)
            self.assertEqual(skills["cooking_assistant"]["tool_budget"], {"max_tool_calls": 8, "max_same_read_calls": 2})
            self.assertEqual(skills["food_profile"]["tool_budget"], {"max_tool_calls": 10, "max_same_read_calls": 2})
            self.assertEqual(skills["ingredient_profile"]["tool_budget"], {"max_tool_calls": 18, "max_same_read_calls": 2})
            self.assertIn("today_recommendation", skills["meal_plan"]["route_hints"])
            self.assertIn("meal_plan", skills["meal_plan"]["route_hints"])
            self.assertIn("meal_planning", skills["meal_plan"]["route_hints"])
            self.assertEqual(skills["inventory_analysis"]["tool_budget"], {"max_tool_calls": 24, "max_same_read_calls": 2})
            self.assertIn("inventory_summary", skills["inventory_analysis"]["route_hints"])
            self.assertIn("inventory_operation", skills["inventory_analysis"]["route_hints"])
            self.assertEqual(
                skills["inventory_analysis"]["completion_policy"]["terminalTools"],
                {
                    "inventory.read_summary": "库存概览卡可作为库存查询的终态输出。",
                    "inventory.read_expiring_items": "临期库存卡可作为临期查询的终态输出。",
                    "inventory.read_expired_items": "过期库存卡可作为过期查询的终态输出。",
                    "inventory.read_low_stock_items": "低库存卡可作为补货查询的终态输出。",
                    "inventory.read_available_items": "可用库存卡可作为库存查询的终态输出。",
                    "inventory.preview_intake_candidates": "冰箱照片或小票解析出的可审阅入库候选卡可作为当前轮终态输出，卡片本身不写库存。",
                },
            )
            self.assertEqual(
                skills["inventory_analysis"]["completion_policy"]["followupRequiredTools"],
                {
                    "ingredient.search": "食材检索后必须说明候选库存处理对象、请求用户选择，或继续读取食材/库存并生成库存处理草稿。",
                    "ingredient.read_by_id": "读取食材档案后必须说明当前库存处理依据、请求补充信息，或生成库存处理草稿。",
                    "ingredient.resolve_candidates": "批量解析后必须把 exact 候选交给入库候选预览，把 missing 逐项进入食材档案 handoff，并对 ambiguous 请求用户选择。",
                    "workspace.read_artifact": "读取历史 artifact 后必须说明可复用内容、请求补充信息，或继续生成/调整库存处理草稿。",
                },
            )
            self.assertEqual(skills["meal_log"]["tool_budget"], {"max_tool_calls": 10, "max_same_read_calls": 2})
            self.assertEqual(skills["meal_plan"]["tool_budget"], {"max_tool_calls": 28, "max_same_read_calls": 2})
            self.assertEqual(
                skills["meal_plan"]["draft_contract"],
                {
                    "meal_plan": {
                        "schemaVersion": "meal_plan.v1",
                        "approvalConfigKey": "meal_plan",
                        "commitHandlerKey": "meal_plan",
                    }
                },
            )
            self.assertEqual(
                skills["meal_plan"]["completion_policy"]["terminalTools"],
                {
                    "meal_plan.recommend_today": "即时餐食推荐卡可作为今日推荐模式的终态输出。",
                    "meal_plan.propose_from_inventory": "当 Food 和 Recipe 库都没有合适真实候选时，库存餐食想法卡可作为当前轮终态输出。",
                },
            )
            self.assertIn(
                "meal_plan.read_existing",
                skills["meal_plan"]["completion_policy"]["followupRequiredTools"],
            )
            self.assertIn(
                "workspace.read_artifact",
                skills["meal_plan"]["completion_policy"]["followupRequiredTools"],
            )
            self.assertEqual(skills["recipe_draft"]["tool_budget"], {"max_tool_calls": 28, "max_same_read_calls": 2})
            self.assertEqual(skills["recipe_draft"]["draft_contract"]["recipe"]["commitHandlerKey"], "recipe")
            self.assertEqual(skills["recipe_cook"]["tool_budget"], {"max_tool_calls": 12, "max_same_read_calls": 2})
            self.assertIn("recipe_cook", skills["recipe_cook"]["route_hints"])
            self.assertIn("cook_recipe", skills["recipe_cook"]["route_hints"])
            self.assertEqual(skills["recipe_cook"]["draft_contract"]["recipe_cook"]["schemaVersion"], "recipe_cook_operation.v1")
            self.assertEqual(skills["shopping_list"]["tool_budget"], {"max_tool_calls": 24, "max_same_read_calls": 2})
            self.assertEqual(skills["shopping_list"]["draft_contract"]["shopping_list"]["approvalConfigKey"], "shopping_list")
            self.assertIn(
                "shopping.read_pending",
                skills["shopping_list"]["completion_policy"]["followupRequiredTools"],
            )
            self.assertEqual(
                skills["recipe_draft"]["completion_policy"]["followupRequiredTools"]["script.lint_recipe_draft"],
                "菜谱草稿 lint 后必须继续修正草稿、请求补充信息，或调用 recipe.create_draft。",
            )
            self.assertIn("ingredient.search", skills["recipe_draft"]["completion_policy"]["followupRequiredTools"])
            self.assertEqual(
                skills["recipe_cook"]["completion_policy"]["followupRequiredTools"]["recipe.preview_cook"],
                "预览后必须继续说明缺料、请求补充信息，或在库存充足时生成 recipe_cook 草稿。",
            )
            self.assertIn("recipe.read_by_id", skills["recipe_cook"]["completion_policy"]["followupRequiredTools"])
            self.assertFalse(skills["recipe_cook"]["completion_policy"]["requiresTerminalOutput"])
            self.assertTrue(skills["recipe_cook"]["completion_policy"]["terminalTextAllowed"])
            self.assertEqual(skills["meal_log"]["runner"], "toolcall")
            self.assertEqual(skills["meal_log"]["context_policy"], ["foods", "meal_logs"])
            self.assertIn("meal_log.create_draft", skills["meal_log"]["tools"])
            self.assertIn("meal_log.read_by_id", skills["meal_log"]["tools"])
            self.assertIn("ingredient.search", skills["inventory_analysis"]["tools"])
            self.assertIn("ingredient.read_by_id", skills["inventory_analysis"]["tools"])
            self.assertIn("inventory.create_unit_conversion_operation_draft", skills["inventory_analysis"]["tools"])
            self.assertIn("recipe.preview_cook", skills["recipe_cook"]["tools"])
            self.assertIn("recipe.create_cook_draft", skills["recipe_cook"]["tools"])
            self.assertEqual(
                skills["meal_plan"]["scripts"],
                ["script.expand_meal_slots", "script.validate_meal_plan", "script.render_plan_preview"],
            )
            self.assertEqual(skills["shopping_list"]["scripts"], [])
            self.assertEqual(skills["recipe_draft"]["scripts"], ["script.lint_recipe_draft"])
            self.assertIn("ingredient.search", skills["recipe_draft"]["tools"])
            self.assertEqual(tools["ingredient.search"]["display_name"], "食材资料")
            self.assertEqual(tools["ingredient.search"]["side_effect"], "read")
            self.assertTrue(tools["ingredient.search"]["requires_followup"])
            self.assertFalse(tools["ingredient.search"]["terminal_output"])
            self.assertTrue(tools["ingredient.search"]["followup_hint"])
            self.assertEqual(tools["ingredient.search"]["output_types"], [])
            self.assertEqual(tools["ingredient.search"]["draft_types"], [])
            summary_tool = tools["inventory.read_summary"]
            self.assertTrue(summary_tool["terminal_output"])
            self.assertFalse(summary_tool["requires_followup"])
            self.assertTrue(summary_tool["followup_hint"])
            recommend_today = tools["meal_plan.recommend_today"]
            self.assertTrue(recommend_today["terminal_output"])
            self.assertFalse(recommend_today["requires_followup"])
            self.assertEqual(recommend_today["output_types"], ["today_recommendation"])

            for tool_name in (
                "workspace.read_artifact",
                "ingredient.search",
                "ingredient.read_by_id",
                "food.search",
                "food.read_by_id",
                "recipe.search",
                "recipe.read_by_id",
                "recipe.preview_cook",
                "shopping.read_pending",
                "shopping.read_by_id",
                "meal_log.read_recent",
                "meal_log.read_by_id",
                "meal_plan.read_existing",
                "meal_plan.read_by_id",
            ):
                with self.subTest(tool_name=tool_name):
                    tool_payload = tools[tool_name]
                    self.assertTrue(tool_payload["requires_followup"])
                    self.assertFalse(tool_payload["terminal_output"])
                    self.assertTrue(tool_payload["followup_hint"])

            for tool_name in (
                "inventory.read_expiring_items",
                "inventory.read_expired_items",
                "inventory.read_low_stock_items",
                "inventory.read_available_items",
            ):
                with self.subTest(tool_name=tool_name):
                    tool_payload = tools[tool_name]
                    self.assertFalse(tool_payload["requires_followup"])
                    self.assertTrue(tool_payload["terminal_output"])
                    self.assertEqual(tool_payload["output_types"], ["inventory_summary"])
                    self.assertTrue(tool_payload["followup_hint"])
            self.assertEqual(tools["skill.inject"]["side_effect"], "control")
            self.assertFalse(tools["skill.inject"]["requires_followup"])
            skill_inject_skills_schema = tools["skill.inject"]["input_schema"]["properties"]["skills"]
            self.assertIn("skill.yaml:key", skill_inject_skills_schema["description"])
            self.assertNotIn("enum", skill_inject_skills_schema["items"])
            self.assertEqual(tools["ui.propose_actions"]["side_effect"], "control")
            self.assertEqual(tools["ui.propose_actions"]["permission"], "family:read")
            self.assertFalse(tools["ui.propose_actions"]["terminal_output"])
            self.assertEqual(tools["ui.propose_actions"]["output_types"], ["ui_actions"])
            self.assertEqual(tools["human.request_input"]["side_effect"], "control")
            self.assertEqual(tools["meal_log.create_draft"]["display_name"], "餐食记录确认表单")
            self.assertEqual(tools["meal_log.create_draft"]["permission"], "family:draft")
            self.assertEqual(tools["meal_log.create_draft"]["side_effect"], "draft")
            self.assertEqual(tools["meal_log.create_draft"]["draft_types"], ["meal_log"])
            self.assertEqual(tools["meal_log.read_by_id"]["display_name"], "餐食记录详情")
            self.assertEqual(tools["meal_log.read_by_id"]["side_effect"], "read")
            self.assertEqual(tools["inventory.create_unit_conversion_operation_draft"]["side_effect"], "draft")
            self.assertEqual(
                tools["inventory.create_unit_conversion_operation_draft"]["draft_types"],
                ["inventory_operation"],
            )
            self.assertNotIn("intent." + "request_clarification", tools)
            self.assertEqual(tools["inventory.read_summary"]["output_types"], ["inventory_summary"])
            self.assertEqual(tools["meal_plan.recommend_today"]["output_types"], ["today_recommendation"])
            self.assertEqual(tools["recipe.create_cook_draft"]["display_name"], "做菜确认表单")
            self.assertEqual(tools["recipe.create_cook_draft"]["side_effect"], "draft")
            self.assertEqual(tools["recipe.create_cook_draft"]["draft_types"], ["recipe_cook"])
            self.assertNotIn("shopping_list.create_draft", tools)
            self.assertEqual(
                tools["meal_log.create_draft"]["input_schema"]["properties"]["draft"]["properties"]["draftType"]["enum"],
                ["meal_log"],
            )
            self.assertEqual(
                tools["recipe.create_cook_draft"]["input_schema"]["properties"]["draft"]["properties"]["draftType"]["enum"],
                ["recipe_cook"],
            )
            self.assertEqual(
                tools["inventory.create_operation_draft"]["input_schema"]["properties"]["draft"]["required"],
                ["draftType", "schemaVersion", "operations"],
            )

        def test_ai_quality_metrics_endpoint_aggregates_family_scoped_run_diagnostics(self) -> None:
            with self.SessionLocal() as db:
                db.add_all(
                    [
                        AIAgentRun(
                            id="agent-run-quality-plan",
                            family_id=self.family.id,
                            agent_key="workspace",
                            feature_key="ai_workspace",
                            intent="meal_plan",
                            input_summary="安排晚餐",
                            context_summary={
                                "routing": {"skills": ["meal_plan", "shopping_list"]},
                                "runMetrics": {
                                    "skillExecutionCount": 2,
                                    "completedSkillExecutionCount": 2,
                                    "toolCallCount": 4,
                                    "draftCount": 2,
                                    "approvalRequestCount": 2,
                                    "clarificationCount": 1,
                                    "approvalApprovedCount": 1,
                                },
                                "clarificationStats": {
                                    "reasons": {"missing_date": 1},
                                    "bySkill": {"meal_plan": 1},
                                },
                                "approvalStats": {
                                    "byDraftType": {
                                        "meal_plan": {"approved": 1},
                                        "shopping_list": {"pending": 1},
                                    }
                                },
                                "skillExecutions": [
                                    {"skill": "meal_plan", "status": "completed"},
                                    {"skill": "shopping_list", "status": "failed", "diagnostic": "missing ingredient ids"},
                                ],
                            },
                            status="completed",
                            model="fake-model",
                            duration_ms=1200,
                            created_at=utcnow() - timedelta(minutes=2),
                            created_by=self.user.id,
                        ),
                        AIAgentRun(
                            id="agent-run-quality-recipe",
                            family_id=self.family.id,
                            agent_key="workspace",
                            feature_key="ai_workspace",
                            intent="recipe_draft",
                            input_summary="生成菜谱",
                            context_summary={
                                "routing": {"skills": ["recipe_draft"]},
                                "runMetrics": {
                                    "skillExecutionCount": 1,
                                    "completedSkillExecutionCount": 0,
                                    "toolCallCount": 1,
                                    "draftCount": 0,
                                    "approvalRejectedCount": 1,
                                },
                                "approvalStats": {"byDraftType": {"recipe": {"rejected": 1}}},
                                "skillExecutions": [
                                    {"skill": "recipe_draft", "status": "failed", "diagnostic": "invalid recipe steps"},
                                ],
                            },
                            status="failed",
                            model="fake-model",
                            error_code="skill_failed",
                            duration_ms=800,
                            created_at=utcnow() - timedelta(minutes=1),
                            created_by=self.user.id,
                        ),
                        AIAgentRun(
                            id="agent-run-quality-other-family",
                            family_id=self.other_family.id,
                            agent_key="workspace",
                            feature_key="ai_workspace",
                            intent="shopping_list",
                            input_summary="其他家庭",
                            context_summary={
                                "routing": {"skills": ["shopping_list"]},
                                "runMetrics": {"toolCallCount": 99},
                            },
                            status="completed",
                            model="fake-model",
                            duration_ms=999,
                            created_at=utcnow(),
                        ),
                    ]
                )
                db.add_all(
                    [
                        AIRunTraceSpan(
                            id="ai-span-quality-tool",
                            family_id=self.family.id,
                            run_id="agent-run-quality-plan",
                            trace_id="ai-trace-quality-plan",
                            span_id="ai-span-quality-tool",
                            span_type="tool_call",
                            name="inventory.read_available_items",
                            status="failed",
                            duration_ms=120,
                            input_summary={},
                            output_summary={},
                            error_code="tool_input_validation_failed",
                            payload={},
                            started_at=utcnow() - timedelta(minutes=2),
                        ),
                        AIRunTraceSpan(
                            id="ai-span-quality-script",
                            family_id=self.family.id,
                            run_id="agent-run-quality-recipe",
                            trace_id="ai-trace-quality-recipe",
                            span_id="ai-span-quality-script",
                            span_type="script_call",
                            name="script.validate_meal_plan",
                            status="completed",
                            duration_ms=40,
                            input_summary={},
                            output_summary={},
                            payload={},
                            started_at=utcnow() - timedelta(minutes=1),
                        ),
                        AIRunTraceSpan(
                            id="ai-span-quality-other-family",
                            family_id=self.other_family.id,
                            run_id="agent-run-quality-other-family",
                            trace_id="ai-trace-quality-other",
                            span_id="ai-span-quality-other-family",
                            span_type="tool_call",
                            name="shopping_list.read",
                            status="failed",
                            duration_ms=999,
                            input_summary={},
                            output_summary={},
                            error_code="other_family_error",
                            payload={},
                            started_at=utcnow(),
                        ),
                        AIRunLLMExchange(
                            id="ai-exchange-quality-plan",
                            family_id=self.family.id,
                            run_id="agent-run-quality-plan",
                            trace_id="ai-trace-quality-plan",
                            provider_round=1,
                            attempt_index=1,
                            mode="stream",
                            model="fake-model",
                            request_messages=[],
                            request_tools=[],
                            request_options={},
                            request_digest="request-digest-plan",
                            request_bytes=20,
                            response_message={},
                            response_tool_calls=[],
                            stream_chunks=[],
                            response_digest="response-digest-plan",
                            response_bytes=30,
                            status="completed",
                            duration_ms=500,
                            started_at=utcnow() - timedelta(minutes=2),
                        ),
                        AIRunLLMExchange(
                            id="ai-exchange-quality-recipe",
                            family_id=self.family.id,
                            run_id="agent-run-quality-recipe",
                            trace_id="ai-trace-quality-recipe",
                            provider_round=1,
                            attempt_index=1,
                            mode="stream",
                            model="fake-model",
                            request_messages=[],
                            request_tools=[],
                            request_options={},
                            request_digest="request-digest-recipe",
                            request_bytes=22,
                            response_message={},
                            response_tool_calls=[],
                            stream_chunks=[],
                            response_digest="response-digest-recipe",
                            response_bytes=32,
                            status="failed",
                            error_code="provider_stream_failed",
                            duration_ms=700,
                            started_at=utcnow() - timedelta(minutes=1),
                        ),
                    ]
                )
                db.commit()

            response = self.client.get("/api/ai/quality-metrics?limit=10")
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()

            self.assertEqual(data["family_id"], self.family.id)
            self.assertEqual(data["window"], {"limit": 10, "days": None})
            self.assertEqual(data["run_count"], 2)
            self.assertEqual(data["status_counts"], {"failed": 1, "completed": 1})
            self.assertEqual(data["intent_counts"], {"recipe_draft": 1, "meal_plan": 1})
            self.assertEqual(data["routing_skill_counts"], {"recipe_draft": 1, "meal_plan": 1, "shopping_list": 1})
            self.assertEqual(data["clarification_reasons"], {"missing_date": 1})
            self.assertEqual(data["clarification_by_skill"], {"meal_plan": 1})
            self.assertEqual(data["approval_by_draft_type"]["meal_plan"], {"approved": 1})
            self.assertEqual(data["approval_by_draft_type"]["recipe"], {"rejected": 1})
            self.assertEqual(data["skill_diagnostics"]["recipe_draft:invalid recipe steps"], 1)
            self.assertEqual(data["skill_status_counts"]["shopping_list:failed"], 1)
            self.assertEqual(data["totals"]["toolCallCount"], 5)
            self.assertEqual(data["totals"]["totalDurationMs"], 2000)
            self.assertEqual(data["totals"]["averageDurationMs"], 1000)
            self.assertEqual(data["trace_metrics"]["traceSpanCount"], 2)
            self.assertEqual(data["trace_metrics"]["llmExchangeCount"], 2)
            self.assertEqual(data["trace_metrics"]["failedSpanCount"], 1)
            self.assertEqual(data["trace_metrics"]["failedExchangeCount"], 1)
            self.assertEqual(data["trace_metrics"]["averageProviderDurationMs"], 600)
            self.assertEqual(data["trace_metrics"]["averageToolDurationMs"], 120)
            self.assertEqual(data["trace_metrics"]["averageScriptDurationMs"], 40)
            self.assertEqual(data["trace_metrics"]["averageProviderRounds"], 1)
            self.assertEqual(data["trace_metrics"]["errorCodes"]["skill_failed"], 1)
            self.assertEqual(data["trace_metrics"]["errorCodes"]["tool_input_validation_failed"], 1)
            self.assertEqual(data["trace_metrics"]["errorCodes"]["provider_stream_failed"], 1)
            self.assertNotIn("other_family_error", data["trace_metrics"]["errorCodes"])
            self.assertEqual([item["id"] for item in data["recent_runs"]], ["agent-run-quality-recipe", "agent-run-quality-plan"])
            self.assertEqual(data["recent_runs"][0]["error_code"], "skill_failed")
            self.assertNotIn("agent-run-quality-other-family", [item["id"] for item in data["recent_runs"]])

        def test_ai_quality_metrics_endpoint_respects_limit(self) -> None:
            with self.SessionLocal() as db:
                for index in range(3):
                    db.add(
                        AIAgentRun(
                            id=f"agent-run-quality-limit-{index}",
                            family_id=self.family.id,
                            agent_key="workspace",
                            feature_key="ai_workspace",
                            intent="inventory_analysis",
                            input_summary="库存诊断",
                            context_summary={"runMetrics": {"toolCallCount": index + 1}},
                            status="completed",
                            model="fake-model",
                            duration_ms=100,
                            created_at=utcnow() - timedelta(minutes=3 - index),
                        )
                    )
                db.commit()

            response = self.client.get("/api/ai/quality-metrics?limit=2")
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()

            self.assertEqual(data["run_count"], 2)
            self.assertEqual(data["totals"]["toolCallCount"], 5)
            self.assertEqual(
                [item["id"] for item in data["recent_runs"]],
                ["agent-run-quality-limit-2", "agent-run-quality-limit-1"],
            )

        def test_approval_config_matrix_maps_supported_actions_to_real_approval_types(self) -> None:
            cases = [
                ("ingredient_profile", {"action": "create"}, "ingredient.create", "创建食材"),
                ("ingredient_profile", {"action": "update"}, "ingredient.update", "更新食材"),
                ("food_profile", {"action": "update"}, "food.update", "更新食物"),
                (
                    "food_profile",
                    {"action": "set_favorite", "payload": {"favorite": True}},
                    "food.favorite",
                    "确认更新收藏",
                ),
                ("meal_log", {"action": "update_details"}, "meal_log.update", "更新记录"),
                ("meal_log", {"action": "rate_food"}, "meal_log.rate_food", "更新评分"),
                ("recipe", {"action": "update"}, "recipe.update", "更新菜谱"),
                ("recipe", {"action": "delete"}, "recipe.delete", "删除菜谱"),
                (
                    "recipe",
                    {"action": "set_favorite", "payload": {"favorite": False}},
                    "recipe.favorite",
                    "确认更新收藏",
                ),
                ("meal_plan", {"operations": [{"action": "create"}]}, "meal_plan.apply", "添加计划"),
                ("meal_plan", {"operations": [{"action": "set_status"}]}, "meal_plan.apply", "修改计划"),
                (
                    "meal_plan",
                    {"operations": [{"action": "create"}, {"action": "delete"}]},
                    "meal_plan.apply",
                    "应用计划变更",
                ),
                ("shopping_list", {"operations": [{"action": "create"}]}, "shopping_list.apply", "添加清单"),
                ("shopping_list", {"operations": [{"action": "set_done"}]}, "shopping_list.apply", "修改清单"),
                (
                    "shopping_list",
                    {"operations": [{"action": "update"}, {"action": "delete"}]},
                    "shopping_list.apply",
                    "应用清单变更",
                ),
            ]

            for draft_type, payload, approval_type, approve_label in cases:
                with self.subTest(draft_type=draft_type, payload=payload):
                    config = draft_operation_registry.approval_config_for_payload(draft_type, payload)
                    self.assertEqual(config["approval_type"], approval_type)
                    self.assertEqual(config["approve_label"], approve_label)
