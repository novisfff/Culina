from ._support import *


class AIWorkspaceStreamingTestCase(AIAgentInfraTestCase):
        def test_ai_workspace_phase4_streams_progress_and_final_response(self) -> None:
            with self.client.stream(
                "POST",
                "/api/ai/chat/stream",
                json={"message": "今日吃什么？", "quick_task": "today_recommendation", "client_run_id": "agent_run-client-test"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                body = "".join(response.iter_text())
            self.assertIn("event: progress", body)
            self.assertIn("调用「餐食计划」技能", body)
            self.assertIn("调用「可用库存」", body)
            self.assertIn("agent_run-client-test", body)
            self.assertIn("event: message_delta", body)
            self.assertIn("我先看一下库存、菜谱和最近餐食。", body)
            self.assertIn("我按当前库存和最近餐食整理了今天的建议。", body)
            self.assertNotIn("<structured_result>", body)
            self.assertNotIn("读取上下文：inventory.read_available_items", body)
            self.assertIn("餐食计划执行完成", body)
            self.assertLess(body.index("我先看一下库存、菜谱和最近餐食。"), body.index("调用「可用库存」"))
            self.assertLess(body.index("调用「可用库存」"), body.index("我按当前库存和最近餐食整理了今天的建议。"))
            self.assertLess(body.index("调用「餐食计划」技能"), body.index("调用「可用库存」"))
            self.assertLess(body.index("调用「餐食计划」技能"), body.index("event: response"))
            self.assertLess(body.index("餐食计划执行完成"), body.index("event: response"))
            self.assertIn("event: response", body)
            self.assertIn("meal_plan_agent", body)
            self.assertIn("我先看一下库存、菜谱和最近餐食。\\n我按当前库存和最近餐食整理了今天的建议。", body)
            events_response = self.client.get("/api/ai/runs/agent_run-client-test/events")
            self.assertEqual(events_response.status_code, 200)
            event_messages = [event["user_message"] for event in events_response.json()]
            self.assertIn("调用「餐食计划」技能", event_messages)
            self.assertIn("调用「可用库存」", event_messages)
            self.assertIn("餐食计划执行完成", event_messages)

        def test_ai_workspace_phase4_streams_draft_progress_before_approval_response(self) -> None:
            with self.client.stream(
                "POST",
                "/api/ai/chat/stream",
                json={"message": "安排三天晚餐", "client_run_id": "agent_run-draft-stream-test"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                body = "".join(response.iter_text())
            self.assertIn("event: progress", body)
            self.assertIn("调用「餐食计划」技能", body)
            self.assertIn("调用「临期食材」", body)
            self.assertIn("生成「餐食计划确认表单」", body)
            self.assertIn("event: message_delta", body)
            self.assertIn("我先看一下临期食材和最近餐食。", body)
            self.assertIn("我生成了 3 条餐食计划草稿。", body)
            self.assertNotIn("<structured_result>", body)
            self.assertNotIn("正在生成餐食计划结构化结果", body)
            self.assertNotIn("餐食计划：已准备草稿", body)
            self.assertIn("餐食计划执行完成", body)
            self.assertLess(body.index("我先看一下临期食材和最近餐食。"), body.index("调用「临期食材」"))
            self.assertLess(body.index("生成「餐食计划确认表单」"), body.index("我生成了 3 条餐食计划草稿。"))
            self.assertLess(body.index("调用「餐食计划」技能"), body.index("调用「临期食材」"))
            self.assertLess(body.index("调用「临期食材」"), body.index("生成「餐食计划确认表单」"))
            self.assertLess(body.index("调用「餐食计划」技能"), body.index("event: response"))
            self.assertLess(body.index("餐食计划执行完成"), body.index("event: response"))
            self.assertIn("waiting_approval", body)
            self.assertIn("meal_plan.create", body)
            self.assertIn("我先看一下临期食材和最近餐食。\\n我生成了 3 条餐食计划草稿。", body)
            events_response = self.client.get("/api/ai/runs/agent_run-draft-stream-test/events")
            self.assertEqual(events_response.status_code, 200)
            event_messages = [event["user_message"] for event in events_response.json()]
            self.assertIn("调用「餐食计划」技能", event_messages)
            self.assertIn("调用「临期食材」", event_messages)
            self.assertIn("生成「餐食计划确认表单」", event_messages)
            self.assertIn("餐食计划执行完成", event_messages)

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
            self.assertIn("general_chat_agent", body)

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
            self.assertIn("event: error", body)
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
                event = db.scalar(
                    select(AIRunEvent).where(
                        AIRunEvent.run_id == run.id,
                        AIRunEvent.internal_code == "runtime_exception",
                    )
                )
                self.assertIsNotNone(event)
                assert event is not None
                self.assertEqual(event.status, "failed")

        def test_ai_workspace_phase4_cancel_running_run_records_event(self) -> None:
            with self.SessionLocal() as db:
                run = AIAgentRun(
                    id="agent-run-cancel",
                    family_id=self.family.id,
                    conversation_id=None,
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
                db.add(run)
                db.commit()
            response = self.client.post("/api/ai/runs/agent-run-cancel/cancel")
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["status"], "cancelled")
            self.assertEqual(data["events"][0]["internal_code"], "user_cancel")

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

