import threading

from app.ai.workflows.live_stream_cache import live_ai_stream_cache

from ._support import *


class BlockingStreamingChatProvider(BaseChatProvider):
    model_name = "blocking-stream-model"

    def __init__(self, first_delta_persisted: threading.Event, continue_stream: threading.Event) -> None:
        self.first_delta_persisted = first_delta_persisted
        self.continue_stream = continue_stream

    def generate(self, *, system: str, user: str, response_schema: dict | None = None) -> ChatProviderResult:
        raise AssertionError("streaming chat should not call blocking generate")

    def stream_generate(self, *, system: str, user: str, response_schema: dict | None = None):
        yield "第一段"
        self.first_delta_persisted.set()
        if not self.continue_stream.wait(timeout=5):
            raise RuntimeError("stream test timed out")
        yield "第二段"

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
        del tools, tool_handler, response_schema, max_rounds
        chunks = []
        for chunk in self.stream_generate(system=system, user=user):
            chunks.append(chunk)
            if visible_text_handler is not None:
                visible_text_handler(f"<visible_text>{chunk}</visible_text>")
        text = "".join(chunks)
        return ChatProviderResult(
            text=f'<structured_result>{{"action":"finalize","text":{json.dumps(text, ensure_ascii=False)},"status":"completed","cards":[]}}</structured_result>',
            status="completed",
            model=self.model_name,
            structured_mode="tool_call",
        )


def _sse_events(body: str) -> list[tuple[str, dict]]:
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
    return events


def _response_event(body: str) -> dict:
    for event_name, data in reversed(_sse_events(body)):
        if event_name == "response":
            return data
    raise AssertionError("response event missing")


class AIWorkspaceStreamingTestCase(AIAgentInfraTestCase):
        def test_ai_workspace_caches_live_delta_for_other_clients_before_final_response(self) -> None:
            first_delta_persisted = threading.Event()
            continue_stream = threading.Event()
            provider = BlockingStreamingChatProvider(first_delta_persisted, continue_stream)
            captured: dict[str, str | int] = {}
            errors: list[BaseException] = []

            def consume_stream() -> None:
                try:
                    with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                        with self.client.stream(
                            "POST",
                            "/api/ai/chat/stream",
                            json={"message": "随便聊聊", "client_run_id": "agent_run-live-persist-test"},
                        ) as response:
                            captured["status_code"] = response.status_code
                            captured["body"] = "".join(response.iter_text())
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=consume_stream)
            thread.start()
            try:
                self.assertTrue(first_delta_persisted.wait(timeout=5))
                with self.SessionLocal() as db:
                    run = db.get(AIAgentRun, "agent_run-live-persist-test")
                    self.assertIsNotNone(run)
                    assert run is not None
                    conversation = db.get(AIConversation, run.conversation_id)
                    self.assertIsNotNone(conversation)
                    assert conversation is not None
                    message = db.scalar(
                        select(AIMessage).where(AIMessage.run_id == run.id, AIMessage.role == "assistant")
                    )
                    self.assertIsNone(message)
                    self.assertEqual(conversation.last_run_status, "running")
                    self.assertEqual(conversation.context.get("activeRunId"), run.id)

                messages_response = self.client.get(f"/api/ai/conversations/{conversation.id}/messages")
                self.assertEqual(messages_response.status_code, 200, messages_response.text)
                live_messages = messages_response.json()
                assistant_messages = [message for message in live_messages if message["role"] == "assistant"]
                self.assertEqual(len(assistant_messages), 1)
                self.assertEqual(assistant_messages[0]["content"], "第一段")
                self.assertEqual(assistant_messages[0]["status"], "running")
                self.assertTrue(assistant_messages[0]["metadata"].get("liveStreaming"))

                continue_stream.set()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
                self.assertFalse(errors)
                self.assertEqual(captured.get("status_code"), 200)
                self.assertIn("event: response", str(captured.get("body") or ""))
                with self.SessionLocal() as db:
                    run = db.get(AIAgentRun, "agent_run-live-persist-test")
                    assert run is not None
                    conversation = db.get(AIConversation, run.conversation_id)
                    assert conversation is not None
                    message = db.scalar(
                        select(AIMessage).where(AIMessage.run_id == run.id, AIMessage.role == "assistant")
                    )
                    assert message is not None
                    self.assertEqual(message.content, "第一段\n第二段")
                    self.assertEqual(message.status, "completed")
                    self.assertNotIn("liveStreaming", message.message_metadata or {})
                    self.assertNotIn("liveTextPartIds", message.message_metadata or {})
                    self.assertNotIn("activeRunId", conversation.context or {})
                    self.assertEqual(conversation.last_run_status, "completed")
                messages_response = self.client.get(f"/api/ai/conversations/{conversation.id}/messages")
                self.assertEqual(messages_response.status_code, 200, messages_response.text)
                final_messages = messages_response.json()
                assistant_messages = [message for message in final_messages if message["role"] == "assistant"]
                self.assertEqual(len(assistant_messages), 1)
                self.assertEqual(assistant_messages[0]["content"], "第一段\n第二段")
                self.assertEqual(assistant_messages[0]["status"], "completed")
                self.assertFalse(assistant_messages[0]["metadata"].get("liveStreaming", False))
            finally:
                continue_stream.set()
                thread.join(timeout=5)

        def test_ai_workspace_live_overlay_keeps_activity_before_persisted_approval(self) -> None:
            run_id = "agent-run-overlay-activity-order"
            conversation_id = "conversation-overlay-activity-order"
            message_id = "message-overlay-activity-order"
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id=conversation_id,
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="更新食材档案",
                    response="",
                    context={"workspace": True},
                    title="更新食材档案",
                    status="active",
                    last_run_status="running",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id=message_id,
                    family_id=self.family.id,
                    conversation_id=conversation_id,
                    role="assistant",
                    content="",
                    content_type="parts",
                    parts=[
                        {
                            "id": "approval-part-overlay",
                            "type": "approval_request",
                            "approval": {
                                "id": "approval-overlay",
                                "conversation_id": conversation_id,
                                "message_id": message_id,
                                "run_id": run_id,
                                "draft_id": "draft-overlay",
                                "draft_version": 1,
                                "draft_schema_version": "ingredient_profile.v1",
                                "approval_type": "ingredient_profile.create",
                                "status": "pending",
                                "title": "确认更新食材档案",
                                "instruction": "确认后会更新当前家庭的食材档案。",
                                "approve_label": "确认更新",
                                "reject_label": "暂不更新",
                                "require_reject_comment": False,
                                "field_schema": [],
                                "initial_values": {},
                                "submitted_values": {},
                                "created_at": utcnow().isoformat(),
                            },
                        }
                    ],
                    run_id=run_id,
                    status="waiting_approval",
                    message_metadata={},
                    created_by=self.user.id,
                )
                db.add_all([conversation, message])
                db.commit()

            live_ai_stream_cache.append_activity(
                family_id=self.family.id,
                conversation_id=conversation_id,
                run_id=run_id,
                message_id=message_id,
                part={
                    "id": "activity-draft-overlay",
                    "type": "run_activity",
                    "activity": {
                        "id": "progress-draft-overlay",
                        "run_id": run_id,
                        "type": "tool",
                        "internal_code": "ingredient_profile.create_draft",
                        "user_message": "生成「食材档案确认表单」",
                        "status": "completed",
                        "created_at": utcnow().isoformat(),
                    },
                },
                created_by=self.user.id,
            )
            try:
                response = self.client.get(f"/api/ai/conversations/{conversation_id}/messages")
                self.assertEqual(response.status_code, 200, response.text)
                assistant_message = next(message for message in response.json() if message["id"] == message_id)
                part_types = [part["type"] for part in assistant_message["parts"]]
                self.assertLess(part_types.index("run_activity"), part_types.index("approval_request"))
            finally:
                live_ai_stream_cache.clear_run(run_id)

        def test_ai_conversation_history_orders_by_latest_message_time(self) -> None:
            with self.SessionLocal() as db:
                older_active = AIConversation(
                    id="conversation-older-active",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="旧会话刚回复",
                    response="",
                    context={"workspace": True},
                    title="旧会话刚回复",
                    status="active",
                    created_at=datetime(2026, 5, 1, 8, 0, 0),
                    last_message_at=datetime(2026, 6, 1, 8, 0, 0),
                    last_run_status="completed",
                    created_by=self.user.id,
                )
                newer_inactive = AIConversation(
                    id="conversation-newer-inactive",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="新建但无新消息",
                    response="",
                    context={"workspace": True},
                    title="新建但无新消息",
                    status="active",
                    created_at=datetime(2026, 5, 20, 8, 0, 0),
                    last_message_at=datetime(2026, 5, 20, 8, 0, 0),
                    last_run_status="completed",
                    created_by=self.user.id,
                )
                db.add_all([newer_inactive, older_active])
                db.commit()

            response = self.client.get("/api/ai/conversations")
            self.assertEqual(response.status_code, 200, response.text)
            ids = [item["id"] for item in response.json()]
            self.assertLess(ids.index("conversation-older-active"), ids.index("conversation-newer-inactive"))

        def test_ai_workspace_phase4_streams_progress_and_final_response(self) -> None:
            with self.client.stream(
                "POST",
                "/api/ai/chat/stream",
                json={"message": "今日吃什么？", "quick_task": "today_recommendation", "client_run_id": "agent_run-client-test"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                body = "".join(response.iter_text())
            self.assertIn("event: progress", body)
            self.assertIn("event: message_part", body)
            self.assertIn("调用「餐食安排」技能", body)
            self.assertIn("调用「可用库存」", body)
            self.assertIn("agent_run-client-test", body)
            self.assertIn("event: message_delta", body)
            self.assertIn("我先看一下库存、菜谱和最近餐食。", body)
            self.assertIn("我按当前库存和最近餐食整理了今天的建议。", body)
            self.assertNotIn("<structured_result>", body)
            self.assertNotIn("读取上下文：inventory.read_available_items", body)
            self.assertNotIn("餐食安排执行完成", body)
            self.assertLess(body.index("我先看一下库存、菜谱和最近餐食。"), body.index("调用「可用库存」"))
            self.assertLess(body.index("调用「可用库存」"), body.index("我按当前库存和最近餐食整理了今天的建议。"))
            self.assertLess(body.index("调用「餐食安排」技能"), body.index("调用「可用库存」"))
            self.assertLess(body.index("调用「餐食安排」技能"), body.index("event: response"))
            self.assertIn("event: response", body)
            self.assertIn("workspace_orchestrator", body)
            response_event = _response_event(body)
            parts = response_event["message"]["parts"]
            part_types = [part["type"] for part in parts]
            self.assertIn("run_activity", part_types)
            self.assertLess(part_types.index("run_activity"), part_types.index("text"))
            self.assertEqual(
                [part["type"] for part in parts[:3]],
                ["run_activity", "text", "run_activity"],
            )
            text_parts = [part["text"].strip() for part in parts if part["type"] == "text"]
            self.assertEqual(text_parts[:2], ["我先看一下库存、菜谱和最近餐食。", "我按当前库存和最近餐食整理了今天的建议。"])
            events_response = self.client.get("/api/ai/runs/agent_run-client-test/events")
            self.assertEqual(events_response.status_code, 200)
            event_messages = [event["user_message"] for event in events_response.json()]
            self.assertIn("调用「餐食安排」技能", event_messages)
            self.assertIn("调用「可用库存」", event_messages)
            self.assertNotIn("餐食安排执行完成", event_messages)

        def test_ai_workspace_phase4_streams_draft_progress_before_approval_response(self) -> None:
            with self.client.stream(
                "POST",
                "/api/ai/chat/stream",
                json={"message": "安排三天晚餐", "client_run_id": "agent_run-draft-stream-test"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                body = "".join(response.iter_text())
            self.assertIn("event: progress", body)
            self.assertIn("event: message_part", body)
            self.assertIn("调用「餐食安排」技能", body)
            self.assertIn("调用「临期食材」", body)
            self.assertIn("生成「餐食计划确认表单」", body)
            self.assertIn("event: message_delta", body)
            self.assertIn("我先看一下临期食材和最近餐食。", body)
            self.assertIn("我生成了 3 条餐食计划草稿。", body)
            self.assertNotIn("<structured_result>", body)
            self.assertNotIn("正在生成餐食计划结构化结果", body)
            self.assertNotIn("餐食计划：已准备草稿", body)
            self.assertNotIn("餐食安排执行完成", body)
            self.assertLess(body.index("我先看一下临期食材和最近餐食。"), body.index("调用「临期食材」"))
            self.assertLess(body.index("生成「餐食计划确认表单」"), body.index("我生成了 3 条餐食计划草稿。"))
            self.assertLess(body.index("调用「餐食安排」技能"), body.index("调用「临期食材」"))
            self.assertLess(body.index("调用「临期食材」"), body.index("生成「餐食计划确认表单」"))
            self.assertLess(body.index("调用「餐食安排」技能"), body.index("event: response"))
            self.assertIn("waiting_approval", body)
            self.assertIn("meal_plan.create", body)
            response_event = _response_event(body)
            parts = response_event["message"]["parts"]
            text_parts = [part["text"].strip() for part in parts if part["type"] == "text"]
            self.assertEqual(text_parts[:2], ["我先看一下临期食材和最近餐食。", "我生成了 3 条餐食计划草稿。"])
            self.assertLess(
                next(index for index, part in enumerate(parts) if part.get("text", "").startswith("我先看一下临期食材")),
                next(index for index, part in enumerate(parts) if part.get("activity", {}).get("user_message") == "调用「临期食材」"),
            )
            self.assertLess(
                next(index for index, part in enumerate(parts) if part.get("activity", {}).get("user_message") == "生成「餐食计划确认表单」"),
                next(index for index, part in enumerate(parts) if part.get("text", "").startswith("我生成了 3 条")),
            )
            events_response = self.client.get("/api/ai/runs/agent_run-draft-stream-test/events")
            self.assertEqual(events_response.status_code, 200)
            event_messages = [event["user_message"] for event in events_response.json()]
            self.assertIn("调用「餐食安排」技能", event_messages)
            self.assertIn("调用「临期食材」", event_messages)
            self.assertIn("生成「餐食计划确认表单」", event_messages)
            self.assertNotIn("餐食安排执行完成", event_messages)

        def test_ai_workspace_phase4_streams_fallback_model_deltas_before_final_response(self) -> None:
            with patch("app.ai.workspace_service.get_chat_provider", return_value=StreamingChatProvider()):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "随便聊聊", "client_run_id": "agent_run-stream-test"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())
            self.assertIn("event: message_delta", body)
            self.assertIn("第一段", body)
            self.assertIn("第二段", body)
            self.assertLess(body.index("第一段"), body.index("event: response"))
            self.assertIn("workspace_orchestrator", body)

        def test_ai_workspace_stream_failure_marks_run_failed(self) -> None:
            with patch("app.ai.workspace_service.get_chat_provider", return_value=FailingStreamingChatProvider()):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "随便聊聊", "client_run_id": "agent_run-stream-failure-test"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            self.assertIn("event: message_delta", body)
            self.assertIn('"status": "failed"', body)
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, "agent_run-stream-failure-test")
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.status, "failed")
                self.assertIn("stream broke", run.error or "")
                message = db.scalar(
                    select(AIMessage).where(
                        AIMessage.run_id == run.id,
                        AIMessage.role == "assistant",
                    )
                )
                self.assertIsNotNone(message)
                assert message is not None
                self.assertEqual(message.status, "failed")
                self.assertNotIn("liveStreaming", message.message_metadata or {})
                conversation = db.get(AIConversation, run.conversation_id)
                self.assertIsNotNone(conversation)
                assert conversation is not None
                self.assertNotIn("activeRunId", conversation.context or {})
                events = list(db.scalars(select(AIRunEvent).where(AIRunEvent.run_id == run.id)))
                self.assertEqual(events, [])

        def test_ai_workspace_phase4_cancel_running_run_records_event(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-cancel",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="安排三天晚餐",
                    response="",
                    context={"activeRunId": "agent-run-cancel", "workspace": True},
                    last_run_status="running",
                    created_by=self.user.id,
                )
                run = AIAgentRun(
                    id="agent-run-cancel",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    message_id=None,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="meal_plan",
                    input_summary="安排三天晚餐",
                    context_summary={},
                    output_summary="",
                    status="running",
                    model="rules",
                    input={"prompt": "安排三天晚餐", "subject": {}},
                    output={},
                    tool_calls=[],
                    duration_ms=0,
                    created_by=self.user.id,
                )
                db.add_all([conversation, run])
                db.commit()
            response = self.client.post("/api/ai/runs/agent-run-cancel/cancel")
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["status"], "cancelled")
            self.assertEqual(data["events"][0]["internal_code"], "user_cancel")
            with self.SessionLocal() as db:
                conversation = db.get(AIConversation, "conversation-cancel")
                self.assertIsNotNone(conversation)
                assert conversation is not None
                self.assertEqual(conversation.last_run_status, "cancelled")
                self.assertNotIn("activeRunId", conversation.context or {})

        def test_ai_workspace_finalize_does_not_overwrite_cancelled_run(self) -> None:
            from app.ai.workflows.runner import WorkspaceGraphRunner

            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-cancel-finalize",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="安排三天晚餐",
                    response="",
                    context={"workspace": True},
                    last_run_status="cancelled",
                    created_by=self.user.id,
                )
                run = AIAgentRun(
                    id="agent_run-cancel-finalize",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    message_id=None,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="meal_plan",
                    input_summary="安排三天晚餐",
                    context_summary={},
                    output_summary="",
                    status="cancelled",
                    model="fake-model",
                    input={"prompt": "安排三天晚餐", "subject": {}},
                    output={},
                    tool_calls=[],
                    duration_ms=0,
                    created_by=self.user.id,
                )
                db.add_all([conversation, run])
                db.flush()

                WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))._finalize(
                    {
                        "family_id": self.family.id,
                        "user_id": self.user.id,
                        "conversation_id": conversation.id,
                        "run_id": run.id,
                        "message": "安排三天晚餐",
                        "status": "completed",
                        "error": None,
                    }
                )

                self.assertEqual(run.status, "cancelled")
                self.assertEqual(conversation.last_run_status, "cancelled")

        def test_ai_workspace_phase4_retries_failed_run_in_same_conversation(self) -> None:
            failed_response = self.client.post("/api/ai/chat", json={"message": "随便聊聊"})
            self.assertEqual(failed_response.status_code, 200, failed_response.text)
            data = failed_response.json()
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, data["run"]["id"])
                assert run is not None
                run.status = "failed"
                run.error = "forced failure"
                db.commit()
            retry_response = self.client.post(f"/api/ai/runs/{data['run']['id']}/retry")
            self.assertEqual(retry_response.status_code, 200, retry_response.text)
            retry_data = retry_response.json()
            self.assertEqual(retry_data["conversation_id"], data["conversation_id"])
            self.assertNotEqual(retry_data["run"]["id"], data["run"]["id"])

        def test_ai_workspace_phase4_regenerates_message_part_with_same_context(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "今日吃什么？", "quick_task": "today_recommendation"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            result_part = next(part for part in data["message"]["parts"] if part["type"] == "result_card")
            regenerate_response = self.client.post(
                f"/api/ai/messages/{data['message']['id']}/parts/{result_part['id']}/regenerate"
            )
            self.assertEqual(regenerate_response.status_code, 200, regenerate_response.text)
            regenerated = regenerate_response.json()
            self.assertEqual(regenerated["conversation_id"], data["conversation_id"])
            self.assertEqual(regenerated["run"]["agent_key"], data["run"]["agent_key"])
