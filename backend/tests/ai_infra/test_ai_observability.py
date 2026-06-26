from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from app.ai.observability.llm_exchange import LLMExchangeRecorder
from app.ai.observability.tracer import AIRunTracer
from app.ai.runtime.provider import BaseChatProvider, ChatProviderResult, OpenAICompatibleChatProvider
from app.core.utils import create_id, utcnow
from app.models.domain import AIRunLLMExchange, AIRunTraceSpan
from app.ai.workspace_service import AIApplicationService
from app.services.ai_operations.trace_retention import prune_ai_trace_records

from ._support import AIAgentInfraTestCase


class AIObservabilityTestCase(AIAgentInfraTestCase):
    def test_observability_tables_do_not_depend_on_business_foreign_keys(self) -> None:
        self.assertEqual(set(AIRunTraceSpan.__table__.foreign_keys), set())
        self.assertEqual(set(AIRunLLMExchange.__table__.foreign_keys), set())

    def test_observability_failures_do_not_touch_business_session_or_raise(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-isolation"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        run_id = data["run"]["id"]
        conversation_id = data["conversation_id"]

        with self.SessionLocal() as db:
            tracer = AIRunTracer(
                db=db,
                family_id=self.family.id,
                run_id=run_id,
                conversation_id=conversation_id,
                trace_id="ai_trace-isolation",
                user_id=self.user.id,
            )
            span = tracer.start_span("test", "durable only")
            self.assertIsNotNone(span.span_id)
            self.assertEqual(list(db.new), [])

            with patch.object(tracer, "_commit_durable_span", side_effect=RuntimeError("trace db failed")):
                failed_span = tracer.start_span("test", "db failure")
            self.assertIsNone(failed_span.span_id)
            self.assertEqual(list(db.new), [])

            with patch.object(tracer, "_clean_payload", side_effect=RuntimeError("redaction failed")):
                failed_span = tracer.start_span("test", "payload failure", payload={"bad": object()})
            self.assertIsNone(failed_span.span_id)
            self.assertEqual(list(db.new), [])

            recorder = LLMExchangeRecorder(
                db=db,
                family_id=self.family.id,
                run_id=run_id,
                conversation_id=conversation_id,
                trace_id="ai_trace-isolation",
                user_id=self.user.id,
            )
            handle = recorder.start_exchange(
                span_id=span.span_id,
                provider_round=1,
                attempt_index=1,
                mode="stream",
                model="debug-model",
                request_messages=[HumanMessage(content="request")],
                request_tools=[],
                request_options={},
            )
            self.assertIsNotNone(handle.exchange)
            self.assertEqual(list(db.new), [])

            with patch.object(recorder, "serialize_message", side_effect=RuntimeError("serialize failed")):
                failed_exchange = recorder.start_exchange(
                    span_id=span.span_id,
                    provider_round=2,
                    attempt_index=1,
                    mode="stream",
                    model="debug-model",
                    request_messages=[HumanMessage(content="request")],
                    request_tools=[],
                    request_options={},
                )
            self.assertIsNone(failed_exchange.exchange)
            self.assertEqual(list(db.new), [])

            with patch.object(recorder, "_clean_response", side_effect=RuntimeError("response redaction failed")):
                handle.finish(response_message=AIMessage(content="response"), response_text="response")
            self.assertEqual(list(db.new), [])

    def test_orchestrator_llm_exchanges_are_linked_to_trace_span(self) -> None:
        class TraceableProvider(BaseChatProvider):
            model_name = "traceable-provider"

            def generate(self, *, system: str, user: str, trace_recorder=None) -> ChatProviderResult:
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
                trace_recorder=None,
            ) -> ChatProviderResult:
                del tools, tool_handler, max_rounds
                text = "这是带 trace span 的回复。"
                if trace_recorder is not None:
                    exchange = trace_recorder.start_exchange(
                        span_id=None,
                        provider_round=1,
                        attempt_index=1,
                        mode="stream",
                        model=self.model_name,
                        request_messages=[SystemMessage(content=system), HumanMessage(content=user)],
                        request_tools=[],
                        request_options={"mode": "stream"},
                    )
                    exchange.finish(response_message=AIMessage(content=text), response_text=text, status="completed")
                if message_handler is not None:
                    message_handler(text)
                return ChatProviderResult(text=text, status="completed", model=self.model_name)

        with patch("app.ai.workspace_service.get_chat_provider", return_value=TraceableProvider()):
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "随便聊聊", "client_run_id": "agent_run-observability-span-link"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        run_id = response.json()["run"]["id"]

        trace_response = self.client.get(f"/api/ai/runs/{run_id}/trace")
        self.assertEqual(trace_response.status_code, 200, trace_response.text)
        span_ids = {item["spanId"] for item in trace_response.json()["spans"]}
        round_span_ids = {
            item["spanId"]
            for item in trace_response.json()["spans"]
            if item["spanType"] == "orchestrator_round"
        }

        exchange_response = self.client.get(f"/api/ai/runs/{run_id}/llm-exchanges")
        self.assertEqual(exchange_response.status_code, 200, exchange_response.text)
        exchanges = exchange_response.json()["exchanges"]
        self.assertEqual(len(exchanges), 1)
        self.assertIn(exchanges[0]["spanId"], span_ids)
        self.assertIn(exchanges[0]["spanId"], round_span_ids)

    def test_ai_run_trace_api_returns_agent_loop_spans(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-trace"},
        )
        self.assertEqual(response.status_code, 200)
        run_id = response.json()["run"]["id"]

        trace_response = self.client.get(f"/api/ai/runs/{run_id}/trace")
        self.assertEqual(trace_response.status_code, 200)
        trace = trace_response.json()
        self.assertEqual(trace["runId"], run_id)
        self.assertTrue(trace["traceId"])
        span_types = {item["spanType"] for item in trace["spans"]}
        self.assertIn("run", span_types)
        self.assertIn("graph_node", span_types)
        self.assertIn("orchestrator_round", span_types)

        tree_response = self.client.get(f"/api/ai/runs/{run_id}/trace/tree")
        self.assertEqual(tree_response.status_code, 200)
        tree = tree_response.json()
        self.assertEqual(tree["runId"], run_id)
        self.assertTrue(tree["tree"])

    def test_llm_exchange_api_returns_full_text_request_and_response_with_image_redacted(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-exchange"},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        run_id = data["run"]["id"]
        conversation_id = data["conversation_id"]

        with self.SessionLocal() as db:
            recorder = LLMExchangeRecorder(
                db=db,
                family_id=self.family.id,
                run_id=run_id,
                conversation_id=conversation_id,
                trace_id="ai_trace-test-exchange",
                user_id=self.user.id,
            )
            handle = recorder.start_exchange(
                span_id="ai_span-provider-test",
                provider_round=1,
                attempt_index=1,
                mode="stream",
                model="debug-model",
                request_messages=[
                    SystemMessage(content="系统提示完整内容"),
                    HumanMessage(
                        content=[
                            {"type": "text", "text": "用户最终发送给 AI 的完整内容"},
                            {
                                "type": "image_url",
                                "image_url": {"url": "data:image/png;base64,aGVsbG8="},
                            },
                        ]
                    ),
                ],
                request_tools=[
                    {
                        "type": "function",
                        "function": {
                            "name": "inventory_read_available_items",
                            "description": "读取库存",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
                request_options={"temperature": 0, "toolCount": 1},
            )
            handle.finish(
                response_message=AIMessage(
                    content="AI 响应完整内容",
                    tool_calls=[
                        {
                            "id": "tool-call-1",
                            "name": "inventory_read_available_items",
                            "args": {"limit": 5},
                        }
                    ],
                ),
                response_text="AI 响应完整内容",
                response_tool_calls=[
                    {
                        "id": "tool-call-1",
                        "name": "inventory.read_available_items",
                        "args": {"limit": 5},
                    }
                ],
                status="completed",
            )
            db.commit()

        exchange_response = self.client.get(f"/api/ai/runs/{run_id}/llm-exchanges")
        self.assertEqual(exchange_response.status_code, 200)
        payload = exchange_response.json()
        self.assertEqual(payload["runId"], run_id)
        self.assertEqual(len(payload["exchanges"]), 1)
        exchange = payload["exchanges"][0]
        self.assertEqual(exchange["responseText"], "AI 响应完整内容")
        self.assertEqual(exchange["responseToolCalls"][0]["name"], "inventory.read_available_items")
        self.assertTrue(exchange["requestDigest"])
        self.assertTrue(exchange["requestOriginalDigest"])
        self.assertGreater(exchange["requestOriginalBytes"], 0)
        self.assertGreater(exchange["requestBytes"], 0)
        self.assertFalse(exchange["requestTruncated"])
        self.assertTrue(exchange["responseDigest"])
        self.assertTrue(exchange["responseOriginalDigest"])
        self.assertGreater(exchange["responseOriginalBytes"], 0)
        self.assertGreater(exchange["responseBytes"], 0)
        self.assertFalse(exchange["responseTruncated"])
        self.assertIn("系统提示完整内容", exchange["requestMessages"][0]["content"])
        self.assertEqual(exchange["requestMessages"][1]["content"][0]["text"], "用户最终发送给 AI 的完整内容")
        image_url = exchange["requestMessages"][1]["content"][1]["image_url"]["url"]
        self.assertTrue(image_url["redacted"])
        self.assertEqual(image_url["contentType"], "image/png")

    def test_llm_exchange_api_orders_by_started_at_with_narrow_id_query_before_loading_payloads(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-exchange-order"},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        run_id = data["run"]["id"]
        conversation_id = data["conversation_id"]
        large_payload = "x" * 20000

        with self.SessionLocal() as db:
            db.add_all(
                [
                    AIRunLLMExchange(
                        id="ai-exchange-order-second",
                        family_id=self.family.id,
                        run_id=run_id,
                        conversation_id=conversation_id,
                        trace_id="ai_trace-exchange-order",
                        provider_round=2,
                        attempt_index=1,
                        mode="stream",
                        model="debug-model",
                        request_messages=[{"role": "user", "content": large_payload}],
                        request_tools=[],
                        request_options={},
                        request_digest="digest-second",
                        request_bytes=len(large_payload),
                        response_message={"content": large_payload},
                        response_text="第二轮",
                        response_tool_calls=[],
                        stream_chunks=[],
                        response_digest="response-digest-second",
                        response_bytes=len(large_payload),
                        status="completed",
                        duration_ms=20,
                        started_at=utcnow() - timedelta(minutes=2),
                    ),
                    AIRunLLMExchange(
                        id="ai-exchange-order-first",
                        family_id=self.family.id,
                        run_id=run_id,
                        conversation_id=conversation_id,
                        trace_id="ai_trace-exchange-order",
                        provider_round=1,
                        attempt_index=1,
                        mode="stream",
                        model="debug-model",
                        request_messages=[{"role": "user", "content": large_payload}],
                        request_tools=[],
                        request_options={},
                        request_digest="digest-first",
                        request_bytes=len(large_payload),
                        response_message={"content": large_payload},
                        response_text="第一轮",
                        response_tool_calls=[],
                        stream_chunks=[],
                        response_digest="response-digest-first",
                        response_bytes=len(large_payload),
                        status="completed",
                        duration_ms=10,
                        started_at=utcnow(),
                    ),
                ]
            )
            db.commit()

        exchange_response = self.client.get(f"/api/ai/runs/{run_id}/llm-exchanges")
        self.assertEqual(exchange_response.status_code, 200, exchange_response.text)
        payload = exchange_response.json()

        self.assertEqual(
            [item["responseText"] for item in payload["exchanges"]],
            ["第二轮", "第一轮"],
        )

    def test_stream_generate_empty_response_is_recorded_as_failed_exchange(self) -> None:
        class EmptyStreamClient:
            def stream(self, _messages):
                return iter(())

        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-empty-stream"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        run_id = data["run"]["id"]
        conversation_id = data["conversation_id"]

        provider = OpenAICompatibleChatProvider(
            api_base="https://example.invalid/v1",
            api_key="test-key",
            model_name="debug-model",
        )
        provider.client = EmptyStreamClient()

        with self.SessionLocal() as db:
            recorder = LLMExchangeRecorder(
                db=db,
                family_id=self.family.id,
                run_id=run_id,
                conversation_id=conversation_id,
                trace_id="ai_trace-empty-stream",
                user_id=self.user.id,
                span_id="ai_span-empty-stream",
            )
            chunks = list(provider.stream_generate(system="系统", user="用户", trace_recorder=recorder))
            db.commit()

        self.assertEqual(chunks, [])
        exchange_response = self.client.get(f"/api/ai/runs/{run_id}/llm-exchanges")
        self.assertEqual(exchange_response.status_code, 200, exchange_response.text)
        exchange = exchange_response.json()["exchanges"][-1]
        self.assertEqual(exchange["mode"], "stream_generate")
        self.assertEqual(exchange["spanId"], "ai_span-empty-stream")
        self.assertEqual(exchange["status"], "failed")
        self.assertEqual(exchange["errorCode"], "provider_empty_response")
        self.assertEqual(exchange["errorMessage"], "empty model response")

    def test_stream_generate_fallback_exchange_links_to_failed_stream_exchange(self) -> None:
        class FailingStreamClient:
            def stream(self, _messages):
                raise RuntimeError("stream transport closed")

            def invoke(self, _messages):
                return AIMessage(content="blocking fallback response")

        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-stream-fallback"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        run_id = data["run"]["id"]
        conversation_id = data["conversation_id"]

        provider = OpenAICompatibleChatProvider(
            api_base="https://example.invalid/v1",
            api_key="test-key",
            model_name="debug-model",
        )
        provider.client = FailingStreamClient()

        with self.SessionLocal() as db:
            recorder = LLMExchangeRecorder(
                db=db,
                family_id=self.family.id,
                run_id=run_id,
                conversation_id=conversation_id,
                trace_id="ai_trace-stream-fallback",
                user_id=self.user.id,
                span_id="ai_span-stream-fallback",
            )
            chunks = list(provider.stream_generate(system="系统", user="用户", trace_recorder=recorder))
            db.commit()

        self.assertEqual(chunks, ["blocking fallback response"])
        exchange_response = self.client.get(f"/api/ai/runs/{run_id}/llm-exchanges")
        self.assertEqual(exchange_response.status_code, 200, exchange_response.text)
        exchanges = [item for item in exchange_response.json()["exchanges"] if item["traceId"] == "ai_trace-stream-fallback"]
        self.assertEqual(len(exchanges), 2)
        failed_stream, fallback = exchanges
        self.assertEqual(failed_stream["status"], "failed")
        self.assertEqual(failed_stream["errorMessage"], "stream transport closed")
        self.assertEqual(fallback["mode"], "generate")
        self.assertEqual(fallback["requestOptions"]["fallbackFromMode"], "stream_generate")
        self.assertEqual(fallback["requestOptions"]["fallbackOfExchangeId"], failed_stream["id"])

    def test_durable_trace_writes_survive_business_session_rollback(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-durable-rollback"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        run_id = data["run"]["id"]
        conversation_id = data["conversation_id"]

        with self.SessionLocal() as db:
            tracer = AIRunTracer(
                db=db,
                family_id=self.family.id,
                run_id=run_id,
                conversation_id=conversation_id,
                trace_id="ai_trace-durable-rollback",
                user_id=self.user.id,
            )
            span = tracer.start_span("test", "durable rollback")
            recorder = LLMExchangeRecorder(
                db=db,
                family_id=self.family.id,
                run_id=run_id,
                conversation_id=conversation_id,
                trace_id=tracer.trace_id,
                user_id=self.user.id,
                span_id=span.span_id,
            )
            exchange = recorder.start_exchange(
                span_id=None,
                provider_round=1,
                attempt_index=1,
                mode="test",
                model="debug-model",
                request_messages=[HumanMessage(content="rollback request")],
                request_tools=[],
                request_options={},
            )
            exchange.finish(response_message=AIMessage(content="rollback response"), response_text="rollback response")
            span.finish()
            db.rollback()

        trace_response = self.client.get(f"/api/ai/runs/{run_id}/trace")
        self.assertEqual(trace_response.status_code, 200, trace_response.text)
        durable_spans = [item for item in trace_response.json()["spans"] if item["traceId"] == "ai_trace-durable-rollback"]
        self.assertEqual(len(durable_spans), 1)
        self.assertEqual(durable_spans[0]["status"], "completed")

        exchange_response = self.client.get(f"/api/ai/runs/{run_id}/llm-exchanges")
        self.assertEqual(exchange_response.status_code, 200, exchange_response.text)
        durable_exchanges = [item for item in exchange_response.json()["exchanges"] if item["traceId"] == "ai_trace-durable-rollback"]
        self.assertEqual(len(durable_exchanges), 1)
        self.assertEqual(durable_exchanges[0]["responseText"], "rollback response")

    def test_recipe_draft_provider_call_records_llm_exchange(self) -> None:
        class TraceableRecipeProvider(BaseChatProvider):
            model_name = "traceable-recipe-provider"

            def generate(self, *, system: str, user: str, trace_recorder=None) -> ChatProviderResult:
                raise AssertionError("recipe draft should use generate_with_tools")

            def generate_with_tools(
                self,
                *,
                system: str,
                user: str,
                tools,
                tool_handler,
                message_handler=None,
                max_rounds: int = 8,
                trace_recorder=None,
            ) -> ChatProviderResult:
                del message_handler, max_rounds
                draft = {
                    "title": "番茄炒蛋",
                    "servings": 2,
                    "prep_minutes": 15,
                    "difficulty": "easy",
                    "ingredient_items": [
                        {"ingredient_id": None, "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": "切块"},
                        {"ingredient_id": None, "ingredient_name": "鸡蛋", "quantity": 3, "unit": "个", "note": "打散"},
                    ],
                    "steps": [
                        {"title": "备菜", "text": "番茄洗净切块，鸡蛋打散备用。", "icon": "tomato", "summary": "处理食材", "estimated_minutes": 5, "tip": "", "key_points": []},
                        {"title": "炒制", "text": "中火先炒鸡蛋，再炒番茄出汁后合并。", "icon": "pan", "summary": "炒熟食材", "estimated_minutes": 8, "tip": "", "key_points": []},
                        {"title": "调味", "text": "加盐调味，确认鸡蛋熟透后装盘。", "icon": "plate", "summary": "调味出锅", "estimated_minutes": 2, "tip": "", "key_points": []},
                    ],
                    "tips": "中火快炒。",
                    "scene_tags": ["家常"],
                }
                available_tools = tools()
                if trace_recorder is not None:
                    exchange = trace_recorder.start_exchange(
                        span_id=None,
                        provider_round=1,
                        attempt_index=1,
                        mode="stream",
                        model=self.model_name,
                        request_messages=[SystemMessage(content=system), HumanMessage(content=user)],
                        request_tools=[{"name": tool.name} for tool in available_tools],
                        request_options={"mode": "stream"},
                    )
                else:
                    exchange = None
                output = tool_handler("recipe.create_draft", {"draft": draft})
                if exchange is not None:
                    exchange.finish(
                        response_message=AIMessage(content="", tool_calls=[{"name": "recipe_create_draft", "args": {"draft": draft}, "id": "tool-1"}]),
                        response_text=None,
                        response_tool_calls=[{"name": "recipe.create_draft", "args": {"draft": draft}}],
                    )
                return ChatProviderResult(
                    text=None,
                    status="completed",
                    model=self.model_name,
                    tool_calls=[{"name": "recipe.create_draft", "args": {"draft": draft}, "output": output}],
                )

        with self.SessionLocal() as db:
            result = AIApplicationService(db, provider=TraceableRecipeProvider()).generate_recipe_draft(
                family_id=self.family.id,
                user_id=self.user.id,
                prompt="做个番茄炒蛋",
                subject={"title": "番茄炒蛋"},
                generate_image=False,
            )
            db.commit()

        self.assertEqual(result["status"], "completed")
        exchange_response = self.client.get(f"/api/ai/runs/{result['agent_run_id']}/llm-exchanges")
        self.assertEqual(exchange_response.status_code, 200, exchange_response.text)
        exchanges = exchange_response.json()["exchanges"]
        self.assertEqual(len(exchanges), 1)
        self.assertIn("家庭菜谱生成智能体", exchanges[0]["requestMessages"][0]["content"])
        self.assertEqual(exchanges[0]["responseToolCalls"][0]["name"], "recipe.create_draft")

    def test_trace_retention_prunes_only_expired_records(self) -> None:
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "随便聊聊", "client_run_id": "agent_run-observability-retention"},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        run_id = data["run"]["id"]
        conversation_id = data["conversation_id"]
        old_started_at = utcnow() - timedelta(days=30)

        with self.SessionLocal() as db:
            db.add(
                AIRunTraceSpan(
                    id=create_id("ai_span"),
                    family_id=self.family.id,
                    run_id=run_id,
                    conversation_id=conversation_id,
                    trace_id="ai_trace-retention-old",
                    span_id="ai_span-retention-old",
                    span_type="run",
                    name="old",
                    status="completed",
                    started_at=old_started_at,
                    ended_at=old_started_at,
                    input_summary={},
                    output_summary={},
                    payload={},
                )
            )
            db.add(
                AIRunLLMExchange(
                    id=create_id("ai_llm_exchange"),
                    family_id=self.family.id,
                    run_id=run_id,
                    conversation_id=conversation_id,
                    trace_id="ai_trace-retention-old",
                    provider_round=1,
                    attempt_index=1,
                    mode="stream",
                    model="debug-model",
                    request_messages=[],
                    request_tools=[],
                    request_options={},
                    response_message={},
                    response_tool_calls=[],
                    stream_chunks=[],
                    status="completed",
                    started_at=old_started_at,
                    ended_at=old_started_at,
                )
            )
            db.commit()

        with self.SessionLocal() as db:
            result = prune_ai_trace_records(db, retention_days=7)
            db.commit()
            self.assertGreaterEqual(result["traceSpansDeleted"], 1)
            self.assertEqual(result["llmExchangesDeleted"], 1)
            remaining_current_spans = [
                span
                for span in db.query(AIRunTraceSpan).filter(AIRunTraceSpan.run_id == run_id).all()
                if span.trace_id != "ai_trace-retention-old"
            ]
            self.assertTrue(remaining_current_spans)
