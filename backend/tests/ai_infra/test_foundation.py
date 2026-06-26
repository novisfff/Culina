from ._support import *

from typing import Any

from langchain_core.messages import ToolMessage

from app.ai.errors import ApprovalRequired, HumanInputRequired
from app.schemas.ai import AIResultCardDTO


def _tool_names(tools) -> list[str]:
    current_tools = tools()
    return sorted(tool.name for tool in current_tools)


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

        def test_openai_compatible_provider_generate_uses_plain_text_mode(self) -> None:
            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            base_client = MagicMock()
            base_client.invoke.return_value = type("Message", (), {"content": "普通回复"})()
            provider.client = base_client

            result = provider.generate(
                system="直接回复",
                user="安排晚餐",
            )

            self.assertEqual(result.text, "普通回复")
            self.assertEqual(base_client.invoke.call_count, 1)
            self.assertEqual(base_client.bind.call_count, 0)

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
                tools=lambda: [tool],
                tool_handler=lambda name, payload: (_ for _ in ()).throw(
                    HumanInputRequired({"id": "human_input-test", **payload})
                ),
                )

        def test_openai_compatible_provider_returns_tool_error_to_model(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-bad-tool",
                        "name": "inventory_read_available_items",
                        "args": {"limit": -1},
                    }
                ]

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [[ToolCallChunk()], [TextChunk("我已根据错误调整处理。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: (_ for _ in ()).throw(ValueError("limit must be positive")),
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我已根据错误调整处理。")
            self.assertEqual(stream_client.stream.call_count, 2)
            second_messages = stream_client.stream.call_args_list[1].args[0]
            tool_message = next(message for message in second_messages if isinstance(message, ToolMessage))
            self.assertIsInstance(tool_message, ToolMessage)
            self.assertIn("tool_execution_failed", str(tool_message.content))
            self.assertIn("limit must be positive", str(tool_message.content))

        def test_openai_compatible_provider_retries_empty_tool_response_before_completion(self) -> None:
            class EmptyChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [[EmptyChunk()], [TextChunk("重试后有结果。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: self.fail("tool handler should not run"),
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "重试后有结果。")
            self.assertEqual(result.error, None)
            self.assertEqual(stream_client.stream.call_count, 2)

        def test_openai_compatible_provider_fails_after_empty_tool_response_retries(self) -> None:
            class EmptyChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.return_value = [EmptyChunk()]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: self.fail("tool handler should not run"),
            )

            self.assertEqual(result.status, "failed")
            self.assertEqual(result.text, None)
            self.assertEqual(result.error, "empty model response")
            self.assertEqual(stream_client.stream.call_count, 4)

        def test_openai_compatible_provider_does_not_duplicate_failed_preview_after_progress_handoff(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_call_chunks = [
                    {
                        "index": 0,
                        "id": "call-bad-tool",
                        "name": "inventory_read_available_items",
                        "args": "",
                    }
                ]
                tool_calls = [
                    {
                        "id": "call-bad-tool",
                        "name": "inventory_read_available_items",
                        "args": {"limit": -1},
                    }
                ]

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [[ToolCallChunk()], [TextChunk("我已换一种方式处理。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            previews: list[tuple[str, str, str]] = []
            handler_event_ids: list[str | None] = []

            def preview_handler(name: str, preview_key: str, status: str) -> str:
                previews.append((name, preview_key, status))
                return f"event-{preview_key}"

            def tool_handler(_name: str, _payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
                handler_event_ids.append(progress_event_id)
                raise ValueError("limit must be positive")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=tool_handler,
                tool_preview_handler=preview_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我已换一种方式处理。")
            self.assertEqual(previews, [("inventory.read_available_items", "0", "running")])
            self.assertEqual(handler_event_ids, ["event-0"])
            second_messages = stream_client.stream.call_args_list[1].args[0]
            tool_message = next(message for message in second_messages if isinstance(message, ToolMessage))
            self.assertIn("tool_execution_failed", str(tool_message.content))

        def test_openai_compatible_provider_ignores_tool_stop_marker_output(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-read",
                        "name": "inventory_read_available_items",
                        "args": {"limit": 10},
                    }
                ]

                def __add__(self, other):
                    return other

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [[ToolCallChunk()], [TextChunk("读取完成。")]]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda name, payload: {"__tool_loop_stop__": {"status": "waiting_approval"}},
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "读取完成。")
            self.assertEqual(stream_client.stream.call_count, 2)

        def test_openai_compatible_provider_propagates_approval_interrupt(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-draft",
                        "name": "recipe_create_draft",
                        "args": {"draft": {"title": "番茄炒蛋"}},
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
            tool = build_workspace_tool_registry().get("recipe.create_draft")

            with self.assertRaises(ApprovalRequired):
                provider.generate_with_tools(
                    system="s",
                    user="u",
                    tools=lambda: [tool],
                    tool_handler=lambda name, payload: (_ for _ in ()).throw(ApprovalRequired("approval required")),
                )

        def test_openai_compatible_provider_retries_stream_failure_before_output(self) -> None:
            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [RuntimeError("incomplete chunked read"), [TextChunk("继续处理完成")]]

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [],
                tool_handler=lambda _name, _payload: {},
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "继续处理完成")
            self.assertEqual(stream_client.stream.call_count, 2)

        def test_openai_compatible_provider_previews_tool_name_before_args_complete(self) -> None:
            class StreamChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, chunks: list[dict[str, Any]]) -> None:
                    self.tool_call_chunks = chunks

                def __add__(self, other):
                    return StreamChunk([*self.tool_call_chunks, *getattr(other, "tool_call_chunks", [])])

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [
                [
                    StreamChunk([{"index": 0, "id": "call-read-items", "name": "inventory_read_available_items", "args": ""}]),
                    StreamChunk([{"index": 0, "args": "{\"limit\": 50}"}]),
                ],
                [TextChunk("读取完成")],
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            previews: list[tuple[str, str, str]] = []
            handler_event_ids: list[str | None] = []

            def preview_handler(name: str, preview_key: str, status: str) -> str:
                previews.append((name, preview_key, status))
                return f"event-{preview_key}"

            def tool_handler(name: str, payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
                handler_event_ids.append(progress_event_id)
                self.assertEqual(name, "inventory.read_available_items")
                self.assertEqual(payload, {"limit": 50})
                return {"items": []}

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=tool_handler,
                tool_preview_handler=preview_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(previews, [("inventory.read_available_items", "0", "running")])
            self.assertEqual(handler_event_ids, ["event-0"])

        def test_openai_compatible_provider_marks_preview_failed_without_final_tool_call(self) -> None:
            class PreviewChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, chunks: list[dict[str, Any]]) -> None:
                    self.tool_call_chunks = chunks

                def __add__(self, other):
                    return FinalTextMessage(getattr(other, "content", ""))

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return FinalTextMessage(f"{self.content}{getattr(other, 'content', '')}")

            class FinalTextMessage:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return FinalTextMessage(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.return_value = [
                PreviewChunk([{"index": 0, "id": "call-read-items", "name": "inventory_read_available_items", "args": ""}]),
                TextChunk("我会先查看库存。"),
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            previews: list[tuple[str, str, str]] = []

            def preview_handler(name: str, preview_key: str, status: str) -> str:
                previews.append((name, preview_key, status))
                return f"event-{preview_key}"

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda _name, _payload: self.fail("tool handler should not run"),
                tool_preview_handler=preview_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.text, "我会先查看库存。")
            self.assertEqual(
                previews,
                [
                    ("inventory.read_available_items", "0", "running"),
                    ("inventory.read_available_items", "0", "failed"),
                ],
            )

        def test_openai_compatible_provider_flushes_final_text_before_tool_execution(self) -> None:
            class AggregateChunk:
                content = ""
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, final_content: str = "", chunks: list[dict[str, Any]] | None = None) -> None:
                    self.final_content = final_content
                    self.tool_call_chunks = chunks or []

                def __add__(self, other):
                    current_content = getattr(self, "content", "") or getattr(self, "final_content", "")
                    next_content = getattr(other, "content", "") or getattr(other, "final_content", "")
                    return AggregateMessage(
                        content=f"{current_content}{next_content}",
                        chunks=[*getattr(self, "tool_call_chunks", []), *getattr(other, "tool_call_chunks", [])],
                    )

            class AggregateMessage:
                tool_calls: list[dict[str, Any]] = []

                def __init__(self, *, content: str, chunks: list[dict[str, Any]]) -> None:
                    self.content = content
                    self.tool_call_chunks = chunks

                def __add__(self, other):
                    next_content = getattr(other, "content", "") or getattr(other, "final_content", "")
                    return AggregateMessage(
                        content=f"{self.content}{next_content}",
                        chunks=[*self.tool_call_chunks, *getattr(other, "tool_call_chunks", [])],
                    )

            class TextChunk:
                tool_calls: list[dict[str, Any]] = []
                tool_call_chunks: list[dict[str, Any]] = []

                def __init__(self, content: str) -> None:
                    self.content = content

                def __add__(self, other):
                    return TextChunk(f"{self.content}{getattr(other, 'content', '')}")

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [
                [
                    AggregateChunk(final_content="我先看一下库存，再继续整理建议。"),
                    AggregateChunk(chunks=[{"index": 0, "id": "call-read-items", "name": "inventory_read_available_items", "args": "{\"limit\": 50}"}]),
                ],
                [TextChunk("整理完成。")],
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")
            order: list[str] = []

            def message_handler(delta: str) -> None:
                order.append(f"text:{delta}")

            def tool_handler(name: str, payload: dict[str, Any], progress_event_id: str | None = None) -> dict[str, Any]:
                del progress_event_id
                order.append(f"tool:{name}")
                self.assertEqual(payload, {"limit": 50})
                return {"items": []}

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=tool_handler,
                message_handler=message_handler,
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(
                order,
                [
                    "text:我先看一下库存，再继续整理建议。",
                    "tool:inventory.read_available_items",
                    "text:整理完成。",
                ],
            )
            self.assertEqual(result.text, "我先看一下库存，再继续整理建议。整理完成。")

        def test_openai_compatible_provider_fails_after_stream_retries_when_tool_already_ran(self) -> None:
            class ToolCallChunk:
                content = ""
                tool_calls = [
                    {
                        "id": "call-read-items",
                        "name": "inventory_read_available_items",
                        "args": {"limit": 50},
                    }
                ]
                tool_call_chunks: list[dict[str, Any]] = []

                def __add__(self, other):
                    return other

            provider = OpenAICompatibleChatProvider.__new__(OpenAICompatibleChatProvider)
            provider.model_name = "compatible-model"
            stream_client = MagicMock()
            tool_client = MagicMock()
            tool_client.bind.return_value = stream_client
            provider.client = MagicMock()
            provider.client.bind_tools.return_value = tool_client
            stream_client.stream.side_effect = [
                [ToolCallChunk()],
                RuntimeError("incomplete chunked read"),
                RuntimeError("incomplete chunked read"),
                RuntimeError("incomplete chunked read"),
                RuntimeError("incomplete chunked read"),
            ]
            tool = build_workspace_tool_registry().get("inventory.read_available_items")

            result = provider.generate_with_tools(
                system="s",
                user="u",
                tools=lambda: [tool],
                tool_handler=lambda _name, _payload: {"items": []},
            )

            self.assertEqual(result.status, "failed")
            self.assertIn("incomplete chunked read", result.error or "")
            self.assertEqual(result.tool_calls, [{"id": "call-read-items", "name": "inventory.read_available_items", "args": {"limit": 50}}])
            self.assertEqual(stream_client.stream.call_count, 5)

        def test_orchestrator_injects_multiple_skills_and_exposes_union_tools(self) -> None:
            class InjectingProvider(BaseChatProvider):
                model_name = "orchestrator-test-model"

                def __init__(self) -> None:
                    self.tool_names_by_call: list[list[str]] = []
                    self.systems: list[str] = []
                    self.inject_result: dict = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del user, max_rounds
                    self.systems.append(system)
                    self.tool_names_by_call.append(_tool_names(tools))
                    self.inject_result = tool_handler("skill.inject", {"skills": ["meal_plan", "shopping_list"], "reason": "需要同时安排餐食和购物清单"})
                    self.tool_names_by_call.append(_tool_names(tools))
                    text = "已准备好餐食计划和购物清单能力。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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
            self.assertEqual(provider.tool_names_by_call[0], ["human.request_input", "skill.inject"])
            self.assertIn("meal_plan.create_draft", provider.tool_names_by_call[1])
            self.assertIn("shopping.create_draft", provider.tool_names_by_call[1])
            self.assertIn("script.validate_meal_plan", provider.tool_names_by_call[1])
            self.assertNotIn("script.suggest_items_from_sources", provider.tool_names_by_call[1])
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], ["meal_plan", "shopping_list"])
            injected_instructions = "\n".join(
                str(item.get("instructions") or "")
                for item in provider.inject_result.get("injectedSkills", [])
                if isinstance(item, dict)
            )
            self.assertIn("餐食", injected_instructions)
            self.assertIn("购物", injected_instructions)

        def test_orchestrator_tool_preview_skips_skill_inject_and_does_not_reuse_next_call_id(self) -> None:
            outer = self

            class PreviewProvider(BaseChatProvider):
                model_name = "orchestrator-preview-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

                def generate_with_tools(
                    self,
                    *,
                    system: str,
                    user: str,
                    tools,
                    tool_handler,
                    message_handler=None,
                    tool_preview_handler=None,
                    max_rounds: int = 8,
                ) -> ChatProviderResult:
                    del system, user, max_rounds, message_handler
                    assert tool_preview_handler is not None
                    outer.assertIsNone(tool_preview_handler("skill.inject", "0", "running"))
                    tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要整理菜谱"})
                    _tool_names(tools)
                    first_id = tool_preview_handler("recipe.create_draft", "0", "running")
                    second_id = tool_preview_handler("recipe.create_draft", "0", "running")
                    outer.assertIsNotNone(first_id)
                    outer.assertIsNotNone(second_id)
                    outer.assertNotEqual(first_id, second_id)
                    return ChatProviderResult(text="继续整理。", status="completed", model=self.model_name)

            progress_events: list[dict[str, Any]] = []
            context = SkillContext(
                db=MagicMock(),
                family_id=self.family.id,
                user_id=self.user.id,
                conversation_id="conversation-orchestrator-preview",
                run_id="run-orchestrator-preview",
                conversation=[{"id": "message-1", "role": "user", "content": "整理菜谱", "artifacts": []}],
                current_message="整理菜谱",
                tool_executor=ToolExecutor(
                    build_workspace_tool_registry(),
                    ToolContext(
                        db=MagicMock(),
                        family_id=self.family.id,
                        user_id=self.user.id,
                        conversation_id="conversation-orchestrator-preview",
                        run_id="run-orchestrator-preview",
                    ),
                ),
                stream_writer=lambda update: progress_events.append(update["data"]) if update.get("event") == "progress" else None,
            )

            result = WorkspaceOrchestratorAgent(
                provider=PreviewProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            self.assertNotIn("skill.inject", [event["internal_code"] for event in progress_events])
            recipe_events = [event for event in progress_events if event["internal_code"] == "recipe.create_draft"]
            self.assertEqual(len(recipe_events), 2)
            self.assertEqual(len({event["id"] for event in recipe_events}), 2)

        def test_skill_injection_manager_keeps_repeated_injection_as_noop(self) -> None:
            manager = SkillInjectionManager(build_workspace_skill_registry())

            keys, added = manager.inject([], ["meal_plan", "shopping_list"])
            self.assertEqual(keys, ["meal_plan", "shopping_list"])
            self.assertEqual([bundle.key for bundle in added], ["meal_plan", "shopping_list"])

            keys, added = manager.inject(keys, ["meal_plan", "shopping_list"])
            self.assertEqual(keys, ["meal_plan", "shopping_list"])
            self.assertEqual(added, [])

        def test_orchestrator_catalog_prompt_uses_skill_keys_not_slugs(self) -> None:
            agent = WorkspaceOrchestratorAgent(
                provider=DisabledChatProvider(model_name="unused"),
                skill_registry=build_workspace_skill_registry(),
            )

            prompt = agent._system_prompt([])

            self.assertIn("skill.yaml:key", prompt)
            self.assertIn("必须写 inventory_analysis", prompt)
            self.assertIn('"key": "inventory_analysis"', prompt)
            self.assertIn('"displayName": "库存查看与处理"', prompt)
            self.assertNotIn('"slug"', prompt)
            self.assertNotIn('"name": "inventory-analysis"', prompt)

        def test_orchestrator_rejects_ambiguous_draft_tool_without_type(self) -> None:
            agent = WorkspaceOrchestratorAgent(
                provider=DisabledChatProvider(model_name="unused"),
                skill_registry=build_workspace_skill_registry(),
            )

            with self.assertRaisesRegex(ValueError, "Draft tool custom.create_draft did not identify draft type"):
                agent._draft_type_from_tool_output("custom.create_draft", {}, ["meal_plan", "shopping_list"])

        def test_orchestrator_treats_model_card_json_as_plain_text(self) -> None:
            class MissingCardFieldsProvider(BaseChatProvider):
                model_name = "missing-card-fields-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, tool_handler, max_rounds
                    text = '{"cards":[{"type":"inventory_summary"}]}'
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.cards, [])
            self.assertEqual(result.text, '{"cards":[{"type":"inventory_summary"}]}')

        def test_orchestrator_does_not_create_result_cards_from_model_text(self) -> None:
            class IncompleteCardDataProvider(BaseChatProvider):
                model_name = "incomplete-card-data-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, tool_handler, max_rounds
                    text = '{"id":"card-1","type":"inventory_summary","title":"库存概览","data":{}}'
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.cards, [])
            self.assertEqual(result.error, None)

        def test_orchestrator_payload_exposes_allowed_draft_types_as_prompt_context(self) -> None:
            class SchemaCapturingProvider(BaseChatProvider):
                model_name = "orchestrator-schema-model"

                def __init__(self) -> None:
                    self.payloads: list[dict] = []
                    self.systems: list[str] = []
                    self.tool_names_by_round: list[list[str]] = []
                    self.inject_result: dict = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del max_rounds
                    self.payloads.append(json.loads(user))
                    self.systems.append(system)
                    self.tool_names_by_round.append(_tool_names(tools))
                    self.inject_result = tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要生成菜谱草稿"})
                    self.tool_names_by_round.append(_tool_names(tools))
                    text = "我会生成菜谱草稿，确认后再写入。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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
            self.assertEqual(provider.payloads[0]["allowedDraftTypes"], [])
            self.assertNotIn("allowedCardTypes", provider.payloads[0])
            self.assertIn("recipe.create_draft", provider.tool_names_by_round[1])
            self.assertIn("instructions", provider.inject_result["injectedSkills"][0])
            self.assertIn("菜谱", provider.inject_result["injectedSkills"][0]["instructions"])
            self.assertIn("这些是当前已注入 Skill 允许的 draft_types", provider.systems[0])

        def test_orchestrator_creates_draft_only_from_draft_tool(self) -> None:
            class DraftCardProvider(BaseChatProvider):
                model_name = "orchestrator-draft-card-model"

                def __init__(self) -> None:
                    self.tool_calls: list[str] = []

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, max_rounds
                    tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要生成菜谱草稿"})
                    _tool_names(tools)
                    text = "我先生成番茄菜谱草稿。"
                    if message_handler is not None:
                        message_handler(text)
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
                        text=text,
                        status="waiting_approval",
                        model=self.model_name,
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

            self.assertEqual(result.status, "waiting_approval")
            self.assertEqual([draft["draft_type"] for draft in result.drafts], ["recipe"])
            self.assertEqual(result.cards, [])
            self.assertEqual(provider.tool_calls, ["recipe.create_draft"])

        def test_orchestrator_does_not_create_draft_from_model_text(self) -> None:
            class DraftCardWithoutToolProvider(BaseChatProvider):
                model_name = "orchestrator-draft-card-without-tool-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, tool_handler, max_rounds
                    self.calls += 1
                    text = '{"cards":[{"type":"draft","title":"菜谱草稿","data":{}}]}'
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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
                ),
                injected_skill_keys=["recipe_draft"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.drafts, [])
            self.assertEqual(result.cards, [])
            self.assertEqual(result.error, None)

        def test_orchestrator_allows_skill_completion_without_business_output(self) -> None:
            class IncompleteRecipeCookProvider(BaseChatProvider):
                model_name = "incomplete-recipe-cook-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, tool_handler, max_rounds
                    text = "我会先查找番茄炒蛋的已有菜谱，并按 2 人份预览库存扣减。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

            result = WorkspaceOrchestratorAgent(
                provider=IncompleteRecipeCookProvider(),
                skill_registry=build_workspace_skill_registry(),
            ).run(
                SkillContext(
                    db=MagicMock(),
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id="conversation-incomplete-recipe-cook",
                    run_id="run-incomplete-recipe-cook",
                    conversation=[{"id": "message-1", "role": "user", "content": "开始做番茄炒蛋，按 2 人份，做完后记录到今晚晚餐。", "artifacts": []}],
                    current_message="开始做番茄炒蛋，按 2 人份，做完后记录到今晚晚餐。",
                    tool_executor=ToolExecutor(
                        build_workspace_tool_registry(),
                        ToolContext(
                            db=MagicMock(),
                            family_id=self.family.id,
                            user_id=self.user.id,
                            conversation_id="conversation-incomplete-recipe-cook",
                            run_id="run-incomplete-recipe-cook",
                        ),
                    ),
                ),
                injected_skill_keys=["recipe_cook"],
            )

            self.assertEqual(result.status, "completed")
            self.assertEqual(result.drafts, [])
            self.assertEqual(result.error, None)
            self.assertEqual(result.context_summary["orchestrator"]["injectedSkills"], ["recipe_cook"])

        def test_orchestrator_rejects_tool_call_before_skill_injection(self) -> None:
            class PrematureToolProvider(BaseChatProvider):
                model_name = "premature-tool-model"

                def __init__(self) -> None:
                    self.tool_result: dict = {}

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, max_rounds
                    self.tool_result = tool_handler("meal_plan.create_draft", {})
                    text = "我还不能直接创建餐食计划草稿。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(text=text, status="completed", model=self.model_name)

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

            provider = PrematureToolProvider()
            result = WorkspaceOrchestratorAgent(
                provider=provider,
                skill_registry=build_workspace_skill_registry(),
            ).run(context)

            self.assertEqual(result.status, "completed")
            self.assertEqual(provider.tool_result.get("code"), "unavailable_tool")
            self.assertEqual(result.drafts, [])

        def test_workspace_graph_can_run_orchestrator_as_langgraph_node(self) -> None:
            class DirectOrchestratorProvider(BaseChatProvider):
                model_name = "direct-orchestrator-model"

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, tool_handler, max_rounds
                    text = "可以，今天先吃清淡一点。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, tools, max_rounds
                    self.calls += 1
                    if self.calls == 1:
                        tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要安排餐食计划"})
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
                    text = "好的，我按三天继续整理。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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
            self.assertEqual(provider.calls, 2)
            self.assertIsNotNone(run)
            self.assertIsNotNone(message)
            assert run is not None
            assert message is not None
            self.assertEqual(run.status, "completed")
            self.assertEqual(run.context_summary["lastHumanInputResult"]["selectedOptionIds"], ["three-days"])
            self.assertEqual(run.context_summary["lastHumanInputResult"]["summary"], "三天")
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
            self.assertEqual(human_input_parts[0].get("response", {}).get("selectedOptionIds"), ["three-days"])
            self.assertEqual(human_input_parts[0].get("response", {}).get("text"), "三天")
            self.assertEqual(human_input_parts[0].get("response", {}).get("summary"), "三天")

        def test_human_input_response_api_accepts_path_request_id_only(self) -> None:
            class HumanInputApiProvider(BaseChatProvider):
                model_name = "human-input-api-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, max_rounds
                    self.calls += 1
                    if self.calls == 1:
                        tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要安排晚餐"})
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
                    text = "已按一天继续。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
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

                conflict_response = self.client.post(
                    "/api/ai/chat",
                    json={"conversation_id": first_data["conversation_id"], "message": "再安排两天"},
                )
                self.assertEqual(conflict_response.status_code, 409, conflict_response.text)
                self.assertIn("当前会话已有 AI 任务正在处理中", conflict_response.json()["detail"])

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
            self.assertEqual(response_request_part.get("response", {}).get("selectedOptionIds"), ["one-day"])
            self.assertEqual(response_request_part.get("response", {}).get("text"), "一天")
            self.assertEqual(response_request_part.get("response", {}).get("summary"), "一天")

        def test_human_input_response_stream_returns_message_deltas(self) -> None:
            class HumanInputStreamProvider(BaseChatProvider):
                model_name = "human-input-stream-model"

                def __init__(self) -> None:
                    self.calls = 0

                def generate(self, *, system: str, user: str) -> ChatProviderResult:
                    raise AssertionError("orchestrator should use generate_with_tools")

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
                    del system, user, tools, max_rounds
                    self.calls += 1
                    if self.calls == 1:
                        tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要安排晚餐"})
                        tool_handler(
                            "human.request_input",
                            {
                                "question": "要安排几天？",
                                "inputMode": "choice",
                                "options": [{"id": "three-days", "label": "三天"}],
                                "sourceSkills": ["meal_plan"],
                                "resumeHint": {"expectedField": "days"},
                            },
                        )
                    text = "已按三天继续安排。"
                    if message_handler is not None:
                        message_handler(text)
                    return ChatProviderResult(
                        text=text,
                        status="completed",
                        model=self.model_name,
                    )

            provider = HumanInputStreamProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                first_response = self.client.post("/api/ai/chat", json={"message": "帮我安排晚餐"})
                self.assertEqual(first_response.status_code, 200, first_response.text)
                first_data = first_response.json()
                request_part = next(
                    part
                    for part in first_data["message"]["parts"]
                    if part.get("type") == "human_input_request"
                )
                first_text_part = next(
                    part
                    for part in first_data["message"]["parts"]
                    if part.get("type") == "text"
                )
                request_id = request_part["request"]["id"]

                with self.client.stream(
                    "POST",
                    f"/api/ai/conversations/{first_data['conversation_id']}/human-input/{request_id}/response/stream",
                    json={"selected_option_ids": ["three-days"], "text": "三天"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            self.assertIn("event: message_delta", body)
            self.assertIn("已按三天继续安排。", body)
            self.assertIn("event: response", body)
            self.assertEqual(provider.calls, 2)
            events: list[tuple[str, dict]] = []
            for block in body.split("\n\n"):
                if not block.strip():
                    continue
                event_name = ""
                data_lines: list[str] = []
                for line in block.splitlines():
                    if line.startswith("event:"):
                        event_name = line.removeprefix("event:").strip()
                    elif line.startswith("data:"):
                        data_lines.append(line.removeprefix("data:").strip())
                if event_name and data_lines:
                    events.append((event_name, json.loads("\n".join(data_lines))))
            delta_event = next(data for event_name, data in events if event_name == "message_delta")
            self.assertNotEqual(delta_event["part_id"], first_text_part["id"])
            response_event = next(data for event_name, data in events if event_name == "response")
            parts = response_event["message"]["parts"]
            human_input_index = next(index for index, part in enumerate(parts) if part.get("type") == "human_input_request")
            resumed_text_index = next(index for index, part in enumerate(parts) if part.get("type") == "text" and "已按三天继续安排。" in str(part.get("text") or ""))
            self.assertLess(human_input_index, resumed_text_index)
