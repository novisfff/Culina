from ._support import *


class AIFoundationTestCase(AIAgentInfraTestCase):
        def test_disabled_provider_returns_fallback_without_network(self) -> None:
            result = DisabledChatProvider(model_name="test-model").generate(system="s", user="u")
            self.assertIsNone(result.text)
            self.assertEqual(result.status, "fallback")
            self.assertEqual(result.model, "test-model")

        def test_sqlalchemy_checkpointer_roundtrip_writes_thread_isolation_and_delete(self) -> None:
            with self.SessionLocal() as db:
                saver = SQLAlchemyCheckpointSaver(db)
                checkpoint = empty_checkpoint()
                checkpoint["id"] = "checkpoint-1"
                checkpoint["channel_values"] = {"state": {"step": 1}}
                config = {"configurable": {"thread_id": "conversation-1"}}
                saved_config = saver.put(
                    config,
                    checkpoint,
                    {"source": "input", "step": 1, "parents": {}},
                    {},
                )
                saver.put_writes(saved_config, [("custom", {"pending": True})], "task-1", "skill_step")

                stored = saver.get_tuple(config)
                self.assertIsNotNone(stored)
                assert stored is not None
                self.assertEqual(stored.checkpoint["channel_values"]["state"], {"step": 1})
                self.assertEqual(stored.pending_writes, [("task-1", "custom", {"pending": True})])
                self.assertIsNone(saver.get_tuple({"configurable": {"thread_id": "conversation-2"}}))
                self.assertEqual(len(list(saver.list(config))), 1)

                saver.delete_thread("conversation-1")
                self.assertIsNone(saver.get_tuple(config))
                self.assertEqual(db.query(AIGraphCheckpoint).count(), 0)
                self.assertEqual(db.query(AIGraphWrite).count(), 0)

        def test_ai_workspace_disabled_provider_returns_planner_failure_without_business_fallback(self) -> None:
            with patch(
                "app.ai.workspace_service.get_chat_provider",
                return_value=DisabledChatProvider(model_name="disabled-model"),
            ):
                response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["intent"], "planner_failed")
            self.assertEqual(data["run"]["status"], "failed")
            self.assertEqual(data["included"]["drafts"], [])
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.tool_calls, [])
                self.assertEqual(run.error, "AI 服务暂时不可用，请稍后重试。")
                self.assertEqual(run.context_summary["routing"]["plannerAttempts"], 1)

        def test_context_tools_are_family_scoped(self) -> None:
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
                output = executor.call("inventory.read_available_items", {"limit": 50})
            output_text = str(output)
            self.assertIn("番茄", output_text)
            self.assertNotIn("其他家庭牛排", output_text)

        def test_phase_a_planner_creates_composite_skill_steps(self) -> None:
            skill_registry = build_workspace_skill_registry()
            planner = WorkspacePlanner(provider=FakeChatProvider(), skill_registry=skill_registry)
            plan = planner.plan(
                PlannerRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation=[
                        {
                            "id": "message-test",
                            "role": "user",
                            "content": "用快过期食材安排三天晚餐，顺便生成购物清单",
                            "artifacts": [],
                        }
                    ],
                    available_skills=[manifest.to_planner_record() for manifest in skill_registry.list_manifests()],
                )
            )
            self.assertEqual(plan.skills, ["meal_plan", "shopping_list"])
            self.assertEqual(plan.attempts, 1)

        def test_planner_retries_invalid_structured_output_once(self) -> None:
            provider = SequenceChatProvider(["不是 JSON", '{"skills":["meal_plan"]}'])
            planner = WorkspacePlanner(provider=provider, skill_registry=build_workspace_skill_registry())
            result = planner.plan(
                PlannerRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-artifacts",
                    conversation=[{"id": "message-1", "role": "user", "content": "修改餐食计划", "artifacts": []}],
                )
            )

            self.assertEqual(result.skills, ["meal_plan"])
            self.assertEqual(result.attempts, 2)
            self.assertFalse(result.failed)

        def test_planner_accepts_a_single_complete_json_code_fence(self) -> None:
            planner = WorkspacePlanner(
                provider=SequenceChatProvider(['```json\n{"skills":["meal_plan"]}\n```']),
                skill_registry=build_workspace_skill_registry(),
            )
            result = planner.plan(
                PlannerRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐", "artifacts": []}],
                )
            )
            self.assertEqual(result.skills, ["meal_plan"])
            self.assertFalse(result.failed)

        def test_planner_rejects_explanation_outside_json_code_fence(self) -> None:
            planner = WorkspacePlanner(
                provider=SequenceChatProvider(
                    [
                        '结果如下：\n```json\n{"skills":["meal_plan"]}\n```',
                        '仍然错误：\n```json\n{"skills":["meal_plan"]}\n```',
                    ]
                ),
                skill_registry=build_workspace_skill_registry(),
            )
            result = planner.plan(
                PlannerRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐", "artifacts": []}],
                )
            )
            self.assertTrue(result.failed)
            self.assertEqual(result.error, "AI 规划结果格式不正确，请重试。")
            self.assertIn("invalid JSON", result.diagnostic or "")

        def test_openai_compatible_provider_falls_back_to_json_object_mode(self) -> None:
            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            base_client = MagicMock()
            schema_client = MagicMock()
            json_object_client = MagicMock()
            base_client.bind.side_effect = [schema_client, json_object_client, base_client]
            schema_client.invoke.side_effect = RuntimeError("json_schema unsupported")
            json_object_client.invoke.return_value = type("Message", (), {"content": '{"skills":["meal_plan"]}'})()
            provider.client = base_client

            result = provider.generate(
                system="只输出 JSON",
                user="安排晚餐",
                response_schema={"type": "object"},
            )

            self.assertEqual(result.text, '{"skills":["meal_plan"]}')
            self.assertEqual(result.structured_mode, "json_object")
            self.assertEqual(schema_client.invoke.call_count, 1)
            self.assertEqual(json_object_client.invoke.call_count, 1)

        def test_planner_fails_after_two_invalid_outputs_without_rule_fallback(self) -> None:
            planner = WorkspacePlanner(
                provider=SequenceChatProvider(["不是 JSON", '{"skills":["unknown_skill"]}']),
                skill_registry=build_workspace_skill_registry(),
            )
            result = planner.plan(
                PlannerRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-artifacts",
                    conversation=[{"id": "message-1", "role": "user", "content": "安排三天晚餐", "artifacts": []}],
                )
            )
            self.assertTrue(result.failed)
            self.assertEqual(result.skills, [])
            self.assertEqual(result.attempts, 2)

        def test_planner_reports_provider_fallback_as_unavailable(self) -> None:
            planner = WorkspacePlanner(
                provider=SequenceChatProvider([None]),
                skill_registry=build_workspace_skill_registry(),
            )
            result = planner.plan(
                PlannerRequest(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation=[{"id": "message-1", "role": "user", "content": "安排晚餐", "artifacts": []}],
                )
            )
            self.assertTrue(result.failed)
            self.assertEqual(result.error, "AI 服务暂时不可用，请稍后重试。")
            self.assertEqual(result.attempts, 1)

