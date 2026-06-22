from ._support import *

from app.ai.errors import HumanInputRequired
from app.schemas.ai import AIResultCardDTO


class AIFoundationTestCase(AIAgentInfraTestCase):
        def test_result_card_dto_rejects_removed_clarification_card_type(self) -> None:
            with self.assertRaises(ValueError):
                AIResultCardDTO.model_validate(
                    {
                        "id": "card-old-clarification",
                        "type": "clarification_request",
                        "title": "还需要你确认一下",
                        "data": {
                            "question": "要处理哪个食材？",
                            "questionType": "entity_disambiguation",
                        },
                    }
                )

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

        def test_ai_workspace_disabled_provider_returns_orchestrator_failure_without_business_fallback(self) -> None:
            with patch(
                "app.ai.workspace_service.get_chat_provider",
                return_value=DisabledChatProvider(model_name="disabled-model"),
            ):
                response = self.client.post("/api/ai/chat", json={"message": "安排三天晚餐"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["status"], "failed")
            self.assertEqual(data["included"]["drafts"], [])
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.tool_calls, [])
                self.assertEqual(run.error, "provider unavailable")
                self.assertIn("orchestrator", run.context_summary)

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

        def test_openai_compatible_provider_propagates_human_input_interrupt(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-human-input",
                        "name": "human_request_input",
                        "args": {
                            "question": "要关联哪一条计划？",
                            "inputMode": "choice",
                        },
                    }
                ]

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.return_value = [ToolCallChunk()]
            tool = build_workspace_tool_registry().get("human.request_input")

            with self.assertRaises(HumanInputRequired):
                provider.generate_with_tools(
                    system="s",
                    user="u",
                    tools=[tool],
                    tool_handler=lambda name, payload: (_ for _ in ()).throw(
                        HumanInputRequired({"id": "human_input-test", **payload})
                    ),
                )

        def test_orchestrator_injects_multiple_skills_and_exposes_union_tools(self) -> None:
            class InjectingProvider(BaseChatProvider):
                model_name = "orchestrator-test-model"

                def __init__(self) -> None:
                    self.tool_names_by_call: list[list[str]] = []
                    self.systems: list[str] = []

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del user, tool_handler, response_schema, max_rounds, visible_text_handler
                    self.systems.append(system)
                    self.tool_names_by_call.append(sorted(tool.name for tool in tools))
                    if len(self.tool_names_by_call) == 1:
                        return ChatProviderResult(
                            text='<structured_result>{"action":"continue","injectSkills":["meal_plan","shopping_list"]}</structured_result>',
                            status="completed",
                            model=self.model_name,
                            structured_mode="tool_call",
                        )
                    return ChatProviderResult(
                        text=(
                            "<visible_text>已准备好餐食计划和购物清单能力。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"已准备好餐食计划和购物清单能力。","status":"completed","cards":[]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            provider = InjectingProvider()
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator",
                run_id="run-orchestrator",
                conversation=[{"id": "message-1", "role": "user", "content": "安排三天晚餐并生成购物清单", "artifacts": []}],
                current_message="安排三天晚餐并生成购物清单",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator",
                        run_id="run-orchestrator",
                    ),
                ),
            )

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.tool_names_by_call[0], ["human.request_input"])
            self.assertIn("meal_plan.create_draft", provider.tool_names_by_call[1])
            self.assertIn("shopping.create_draft", provider.tool_names_by_call[1])
            self.assertIn("script.validate_meal_plan", provider.tool_names_by_call[1])
            self.assertNotIn("script.suggest_items_from_sources", provider.tool_names_by_call[1])
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], ["meal_plan", "shopping_list"])
            self.assertIn("餐食安排", provider.systems[1])
            self.assertIn("购物清单整理", provider.systems[1])

        def test_skill_injection_manager_keeps_repeated_injection_as_noop(self) -> None:
            manager = SkillInjectionManager(build_workspace_skill_registry())

            keys, added = manager.inject([], ["meal_plan", "shopping_list"])
            self.assertEqual(keys, ["meal_plan", "shopping_list"])
            self.assertEqual([bundle.key for bundle in added], ["meal_plan", "shopping_list"])

            keys, added = manager.inject(keys, ["meal_plan", "shopping_list"])
            self.assertEqual(keys, ["meal_plan", "shopping_list"])
            self.assertEqual(added, [])

        def test_orchestrator_rejects_ambiguous_draft_tool_without_type(self) -> None:
            agent = WorkspaceOrchestratorAgent(
                provider=DisabledChatProvider(model_name="unused"),
                skill_registry=build_workspace_skill_registry(),
            )

            with self.assertRaisesRegex(ValueError, "Draft tool custom.create_draft did not identify draft type"):
                agent._draft_type_from_tool_output("custom.create_draft", {}, ["meal_plan", "shopping_list"])

        def test_orchestrator_rejects_result_card_missing_required_fields(self) -> None:
            class MissingCardFieldsProvider(BaseChatProvider):
                model_name = "missing-card-fields-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                        text=(
                            "<visible_text>库存如下。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"库存如下。","status":"completed",'
                            '"cards":[{"type":"inventory_summary"}]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            result = WorkspaceOrchestratorAgent(
                provider=MissingCardFieldsProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-missing-card-fields",
                    run_id="run-missing-card-fields",
                    conversation=[],
                    current_message="库存怎么样",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-missing-card-fields",
                            run_id="run-missing-card-fields",
                        ),
                    ),
                ),
                injected_skill_keys=["inventory_analysis"],
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "invalid orchestrator structured result schema")

        def test_orchestrator_rejects_result_card_with_incomplete_data(self) -> None:
            class IncompleteCardDataProvider(BaseChatProvider):
                model_name = "incomplete-card-data-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                        text=(
                            "<visible_text>库存如下。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"库存如下。","status":"completed",'
                            '"cards":[{"id":"card-1","type":"inventory_summary","title":"库存概览","data":{}}]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            result = WorkspaceOrchestratorAgent(
                provider=IncompleteCardDataProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-incomplete-card-data",
                    run_id="run-incomplete-card-data",
                    conversation=[],
                    current_message="库存怎么样",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-incomplete-card-data",
                            run_id="run-incomplete-card-data",
                        ),
                    ),
                ),
                injected_skill_keys=["inventory_analysis"],
            )

            self.assertEqual(result.status, "failed")
            self.assertIn("availableCount", result.error or "")

        def test_orchestrator_schema_separates_result_cards_from_draft_types(self) -> None:
            class SchemaCapturingProvider(BaseChatProvider):
                model_name = "orchestrator-schema-model"

                def __init__(self) -> None:
                    self.schemas: list[dict] = []
                    self.payloads: list[dict] = []
                    self.systems: list[str] = []

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del tools, tool_handler, max_rounds, visible_text_handler
                    self.schemas.append(response_schema or {})
                    self.payloads.append(json.loads(user))
                    self.systems.append(system)
                    if len(self.schemas) == 1:
                        return ChatProviderResult(
                            text='<structured_result>{"action":"continue","injectSkills":["recipe_draft"]}</structured_result>',
                            status="completed",
                            model=self.model_name,
                            structured_mode="tool_call",
                        )
                    return ChatProviderResult(
                        text=(
                            "<visible_text>我会生成菜谱草稿，确认后再写入。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"我会生成菜谱草稿，确认后再写入。","status":"completed","cards":[]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            provider = SchemaCapturingProvider()
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator-schema",
                run_id="run-orchestrator-schema",
                conversation=[{"id": "message-1", "role": "user", "content": "生成一个番茄鸡蛋菜谱", "artifacts": []}],
                current_message="生成一个番茄鸡蛋菜谱",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator-schema",
                        run_id="run-orchestrator-schema",
                    ),
                ),
            )

            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            card_schema = provider.schemas[1]["properties"]["cards"]["items"]
            card_type_schema = card_schema["properties"]["type"]
            self.assertFalse(card_schema["additionalProperties"])
            self.assertEqual(card_schema["required"], ["id", "type", "title", "data"])
            self.assertEqual(card_type_schema["enum"], ["error_recovery"])
            self.assertNotIn("recipe", card_type_schema["enum"])
            self.assertEqual(provider.payloads[1]["allowedCardTypes"], ["error_recovery"])
            self.assertEqual(provider.payloads[1]["allowedDraftTypes"], ["recipe"])
            self.assertIn("不能放进 cards[].type", provider.systems[1])
            self.assertIn('"recipe"', provider.systems[1])

        def test_orchestrator_rejects_model_draft_card_when_tool_created_draft(self) -> None:
            class DraftCardProvider(BaseChatProvider):
                model_name = "orchestrator-draft-card-model"

                def __init__(self) -> None:
                    self.tool_calls: list[str] = []

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    if not self.tool_calls:
                        self.tool_calls.append("inject")
                        return ChatProviderResult(
                            text='<structured_result>{"action":"continue","injectSkills":["recipe_draft"]}</structured_result>',
                            status="completed",
                            model=self.model_name,
                            structured_mode="tool_call",
                        )
                    self.tool_calls.append("recipe.create_draft")
                    tool_handler(
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
                                    {
                                        "ingredient_id": "ingredient-tomato",
                                        "ingredient_name": "番茄",
                                        "quantity": 1,
                                        "unit": "个",
                                        "note": "",
                                    }
                                ],
                                "steps": [
                                    {
                                        "title": "处理食材",
                                        "text": "番茄切块。",
                                        "icon": "tomato",
                                        "summary": "切番茄",
                                        "estimated_minutes": 3,
                                        "tip": "",
                                        "key_points": ["切块"],
                                    },
                                    {
                                        "title": "下锅翻炒",
                                        "text": "热锅后放入番茄翻炒出汁。",
                                        "icon": "pan",
                                        "summary": "炒出汤汁",
                                        "estimated_minutes": 6,
                                        "tip": "",
                                        "key_points": ["中火"],
                                    },
                                    {
                                        "title": "调味装盘",
                                        "text": "加盐调味后装盘。",
                                        "icon": "plate",
                                        "summary": "完成装盘",
                                        "estimated_minutes": 3,
                                        "tip": "",
                                        "key_points": ["调味"],
                                    },
                                ],
                                "tips": "",
                                "scene_tags": [],
                            }
                        },
                    )
                    return ChatProviderResult(
                        text=(
                            "<visible_text>我生成了菜谱草稿，请确认。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"我生成了菜谱草稿，请确认。",'
                            '"status":"completed","cards":[{"type":"draft","title":"菜谱草稿","data":{}}]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            provider = DraftCardProvider()
            with self.SessionLocal() as db:
                context = SkillContext(
                    db=db,
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-orchestrator-draft-card",
                    run_id="run-orchestrator-draft-card",
                    conversation=[{"id": "message-1", "role": "user", "content": "生成一个番茄菜谱", "artifacts": []}],
                    current_message="生成一个番茄菜谱",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=db,
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-orchestrator-draft-card",
                            run_id="run-orchestrator-draft-card",
                        ),
                    ),
                )

                result = WorkspaceOrchestratorAgent(
                    provider=provider,
                    skill_registry=build_workspace_skill_registry(),
                ).run(context)

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "invalid orchestrator structured result schema")

        def test_orchestrator_still_rejects_model_draft_card_without_tool_draft(self) -> None:
            class DraftCardWithoutToolProvider(BaseChatProvider):
                model_name = "orchestrator-draft-card-without-tool-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    self.calls += 1
                    if self.calls == 1:
                        return ChatProviderResult(
                            text='<structured_result>{"action":"continue","injectSkills":["recipe_draft"]}</structured_result>',
                            status="completed",
                            model=self.model_name,
                            structured_mode="tool_call",
                        )
                    return ChatProviderResult(
                        text=(
                            "<visible_text>我生成了菜谱草稿。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"我生成了菜谱草稿。",'
                            '"status":"completed","cards":[{"type":"draft","title":"菜谱草稿","data":{}}]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            result = WorkspaceOrchestratorAgent(
                provider=DraftCardWithoutToolProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-orchestrator-draft-card-without-tool",
                    run_id="run-orchestrator-draft-card-without-tool",
                    conversation=[{"id": "message-1", "role": "user", "content": "生成一个番茄菜谱", "artifacts": []}],
                    current_message="生成一个番茄菜谱",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-orchestrator-draft-card-without-tool",
                            run_id="run-orchestrator-draft-card-without-tool",
                        ),
                    ),
                )
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.error, "invalid orchestrator structured result schema")

        def test_orchestrator_rejects_tool_call_before_skill_injection(self) -> None:
            class PrematureToolProvider(BaseChatProvider):
                model_name = "premature-tool-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    tool_handler("meal_plan.create_draft", {})
                    return ChatProviderResult(text='{"action":"finalize"}', status="completed", model=self.model_name)

            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator",
                run_id="run-orchestrator",
                conversation=[],
                current_message="安排晚餐",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator",
                        run_id="run-orchestrator",
                    ),
                ),
            )

            result = WorkspaceOrchestratorAgent(
                provider=PrematureToolProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "failed")
            self.assertIn("当前 Skill 未声明工具 meal_plan.create_draft", result.error or "")

        def test_workspace_graph_can_run_orchestrator_as_langgraph_node(self) -> None:
            class DirectOrchestratorProvider(BaseChatProvider):
                model_name = "direct-orchestrator-model"

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                        text=(
                            "<visible_text>可以，今天先吃清淡一点。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"可以，今天先吃清淡一点。","status":"completed","cards":[]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=DirectOrchestratorProvider())
                response = WorkspaceGraphRunner(service).invoke_user_message(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="今天简单吃点什么？",
                )
                run = db.get(AIAgentRun, response["run"]["id"])

            self.assertEqual(response["run"]["status"], "completed")
            self.assertEqual(response["message"]["content"], "可以，今天先吃清淡一点。")
            self.assertIsNotNone(run)
            assert run is not None
            self.assertIn("orchestrator", run.context_summary)
            self.assertEqual(run.agent_key, "workspace_orchestrator")

        def test_workspace_orchestrator_human_input_interrupt_resumes_same_run(self) -> None:
            class HumanInputProvider(BaseChatProvider):
                model_name = "human-input-orchestrator-model"

                def __init__(self) -> None:
                    self.calls = 0
                    self.resume_artifacts: list[dict] = []
                    self.resume_injected_skills: list[str] = []

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    self.calls += 1
                    if self.calls == 1:
                        return ChatProviderResult(
                            text=(
                                "<visible_text></visible_text>"
                                '<structured_result>{"action":"continue","injectSkills":["meal_plan"],"text":"","status":"running","cards":[]}</structured_result>'
                            ),
                            status="completed",
                            model=self.model_name,
                            structured_mode="tool_call",
                        )
                    if self.calls == 2:
                        tool_handler(
                            "human.request_input",
                            {
                                "question": "你想安排几天晚餐？",
                                "inputMode": "choice_or_text",
                                "options": [{"id": "three-days", "label": "三天"}],
                                "sourceSkills": ["meal_plan"],
                                "resumeHint": {"expectedField": "days"},
                            },
                        )
                    payload = json.loads(user)
                    self.resume_injected_skills = payload.get("injectedSkills") or []
                    self.resume_artifacts = [*(payload.get("artifacts") or []), *(payload.get("currentRunArtifacts") or [])]
                    return ChatProviderResult(
                        text=(
                            "<visible_text>好的，我按三天继续整理。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"好的，我按三天继续整理。","status":"completed","cards":[]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            provider = HumanInputProvider()
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=provider)
                response = WorkspaceGraphRunner(service).invoke_user_message(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="帮我安排晚餐",
                )
                self.assertEqual(response["run"]["status"], "waiting_input")
                request_parts = [
                    part
                    for part in response["message"]["parts"]
                    if isinstance(part, dict) and part.get("type") == "human_input_request"
                ]
                self.assertEqual(len(request_parts), 1)
                request_id = request_parts[0]["request"]["id"]

                resumed = service.respond_human_input(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=response["conversation_id"],
                    request_id=request_id,
                    selected_option_ids=["three-days"],
                    text="三天",
                )
                db.expire_all()
                run = db.get(AIAgentRun, response["run"]["id"])
                message = db.get(AIMessage, response["message"]["id"])

            self.assertEqual(resumed["run"]["status"], "completed")
            self.assertEqual(resumed["message"]["content"], "你想安排几天晚餐？\n\n好的，我按三天继续整理。")
            self.assertEqual(provider.calls, 3)
            self.assertIsNotNone(run)
            self.assertIsNotNone(message)
            assert run is not None
            assert message is not None
            self.assertEqual(run.status, "completed")
            self.assertEqual(run.context_summary["lastHumanInputResult"]["selectedOptionIds"], ["three-days"])
            self.assertEqual(run.context_summary["orchestrator"]["injectedSkills"], ["meal_plan"])
            self.assertEqual(provider.resume_injected_skills, ["meal_plan"])
            self.assertIn("meal_plan", provider.resume_artifacts[-1].get("payload", {}).get("request", {}).get("sourceSkills", []))
            self.assertTrue(
                any(
                    item.get("type") == "human.input_result"
                    for item in (message.message_metadata or {}).get("artifacts", [])
                    if isinstance(item, dict)
                )
            )
            human_input_parts = [
                part
                for part in (message.parts or [])
                if isinstance(part, dict) and part.get("type") == "human_input_request"
            ]
            self.assertEqual(human_input_parts[0].get("status"), "completed")
            self.assertIsNotNone(human_input_parts[0].get("responded_at"))

        def test_human_input_response_api_accepts_path_request_id_only(self) -> None:
            class HumanInputApiProvider(BaseChatProvider):
                model_name = "human-input-api-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    self.calls += 1
                    if self.calls == 1:
                        tool_handler(
                            "human.request_input",
                            {
                                "question": "要安排几天？",
                                "inputMode": "choice",
                                "options": [{"id": "one-day", "label": "一天"}],
                                "sourceSkills": ["meal_plan"],
                                "resumeHint": {"expectedField": "days"},
                            },
                        )
                    return ChatProviderResult(
                        text=(
                            "<visible_text>已按一天继续。</visible_text>"
                            '<structured_result>{"action":"finalize","text":"已按一天继续。","status":"completed","cards":[]}</structured_result>'
                        ),
                        status="completed",
                        model=self.model_name,
                        structured_mode="tool_call",
                    )

            provider = HumanInputApiProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                first_response = self.client.post("/api/ai/chat", json={"message": "帮我安排晚餐"})
                self.assertEqual(first_response.status_code, 200, first_response.text)
                first_data = first_response.json()
                request_part = next(
                    part
                    for part in first_data["message"]["parts"]
                    if part.get("type") == "human_input_request"
                )
                request_id = request_part["request"]["id"]

                response = self.client.post(
                    f"/api/ai/conversations/{first_data['conversation_id']}/human-input/{request_id}/response",
                    json={"selected_option_ids": ["one-day"], "text": "一天"},
                )

            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["status"], "completed")
            self.assertEqual(provider.calls, 2)
            response_request_part = next(
                part
                for part in data["message"]["parts"]
                if part.get("type") == "human_input_request"
            )
            self.assertEqual(response_request_part.get("status"), "completed")
