from ._support import *


class AIRegistryAndMetricsTestCase(AIAgentInfraTestCase):
        def test_ai_registry_endpoint_exposes_skill_and_tool_contracts(self) -> None:
            response = self.client.get("/api/ai/registry")
            self.assertEqual(response.status_code, 200)
            data = response.json()
            skills = {item["key"]: item for item in data["skills"]}
            tools = {item["name"]: item for item in data["tools"]}

            self.assertEqual(len(skills), 8)
            self.assertNotIn("today_recommendation", skills)
            self.assertIn("today_recommendation", skills["meal_plan"]["output_types"])
            self.assertIn("clarification_request", skills["meal_plan"]["output_types"])
            self.assertIn("ingredient_profile", skills)
            self.assertIn("meal_log", skills)
            self.assertIn("recipe_cook", skills)
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
                ["script.validate_meal_plan", "script.render_plan_preview"],
            )
            self.assertEqual(
                skills["shopping_list"]["scripts"],
                ["script.merge_ingredients", "script.normalize_ingredient"],
            )
            self.assertIn("ingredient.search", skills["recipe_draft"]["tools"])
            self.assertEqual(tools["ingredient.search"]["display_name"], "食材资料")
            self.assertEqual(tools["ingredient.search"]["side_effect"], "read")
            self.assertEqual(tools["meal_log.create_draft"]["display_name"], "餐食记录确认表单")
            self.assertEqual(tools["meal_log.create_draft"]["permission"], "family:draft")
            self.assertEqual(tools["meal_log.create_draft"]["side_effect"], "draft")
            self.assertEqual(tools["meal_log.read_by_id"]["display_name"], "餐食记录详情")
            self.assertEqual(tools["meal_log.read_by_id"]["side_effect"], "read")
            self.assertEqual(tools["inventory.create_unit_conversion_operation_draft"]["side_effect"], "draft")
            self.assertEqual(tools["intent.request_clarification"]["display_name"], "补充信息请求")
            self.assertEqual(tools["intent.request_clarification"]["side_effect"], "read")
            self.assertEqual(tools["recipe.create_cook_draft"]["display_name"], "做菜确认表单")
            self.assertEqual(tools["recipe.create_cook_draft"]["side_effect"], "draft")
            self.assertNotIn("shopping_list.create_draft", tools)
            self.assertEqual(
                sorted(tools["intent.request_clarification"]["input_schema"]["required"]),
                ["question", "questionType"],
            )
            self.assertIn(
                "unit_conversion",
                tools["intent.request_clarification"]["input_schema"]["properties"]["questionType"]["enum"],
            )
            self.assertIn("unitMismatch", tools["intent.request_clarification"]["input_schema"]["properties"])
            self.assertEqual(
                tools["meal_log.create_draft"]["input_schema"]["properties"]["draft"]["properties"]["draftType"]["enum"],
                ["meal_log"],
            )
            self.assertEqual(
                tools["recipe.create_cook_draft"]["input_schema"]["properties"]["draft"]["properties"]["draftType"]["enum"],
                ["recipe_cook"],
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
                    config = approval_config_for_payload(draft_type, payload)
                    self.assertEqual(config["approval_type"], approval_type)
                    self.assertEqual(config["approve_label"], approve_label)
