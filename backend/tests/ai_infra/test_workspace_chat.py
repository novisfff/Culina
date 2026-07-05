from ._support import *


class AIWorkspaceChatTestCase(AIAgentInfraTestCase):
        def test_workspace_chat_records_completed_graph_run_with_tools(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "库存怎么样"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["intent"], "inventory")
            card = data["included"]["result_cards"][0]
            self.assertEqual(card["type"], "inventory_summary")
            self.assertEqual(card["data"]["items"][0]["name"], "番茄")
            self.assertEqual(card["data"]["items"][0]["image"]["id"], "media-ingredient-tomato")
            self.assertEqual(card["data"]["items"][0]["displayStatus"], "expiring")
            with self.SessionLocal() as db:
                run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == data["run"]["id"]))
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.status, "completed")
                self.assertGreaterEqual(len(run.tool_calls), 1)
                self.assertEqual(run.conversation_id, data["conversation_id"])

        def test_workspace_graph_persists_all_drafts_from_single_skill_result(self) -> None:
            from app.ai.workflows.runner import WorkspaceGraphRunner

            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="生成多份草稿",
                    quick_task=None,
                )
                run = AIAgentRun(
                    id="agent_run-multi-draft-test",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="multi_draft",
                    input_summary="生成多份草稿",
                    context_summary={},
                    output_summary="",
                    status="running",
                    model="fake-model",
                    input={},
                    output={},
                    tool_calls=[],
                    created_by=self.user.id,
                )
                db.add(run)
                db.flush()
                meal_plan_payload = {
                    "draftType": "meal_plan",
                    "schemaVersion": "meal_plan.v1",
                    "items": [
                        {
                            "date": date.today().isoformat(),
                            "mealType": "dinner",
                            "title": "番茄小炒",
                            "foodId": "food-tomato",
                            "recipeId": None,
                            "reason": "测试多草稿",
                            "usedInventory": ["番茄"],
                            "missingIngredients": ["鸡蛋"],
                        }
                    ],
                    "source": {"days": 1, "mealTypes": ["dinner"]},
                }
                shopping_payload = {
                    "draftType": "shopping_list",
                    "schemaVersion": "shopping_list.v1",
                "items": [
                    {
                        "ingredientId": "ingredient-tomato",
                        "title": "番茄",
                        "quantity": 2,
                        "unit": "个",
                        "reason": "用于番茄鸡蛋面",
                            "sourceMeals": ["番茄鸡蛋面"],
                        }
                    ],
                    "sourceDraftId": None,
                }
                runner = WorkspaceGraphRunner(service)
                message = runner.assistant_result_persister.persist(
                    {
                        "family_id": self.family.id,
                        "user_id": self.user.id,
                        "conversation_id": conversation.id,
                        "run_id": run.id,
                        "message": "生成多份草稿",
                    },
                    SkillResult(
                        text="生成了两份草稿。",
                        drafts=[
                            {"draft_type": "meal_plan", "payload": meal_plan_payload, "schema_version": "meal_plan.v1"},
                            {"draft_type": "shopping_list", "payload": shopping_payload, "schema_version": "shopping_list.v1"},
                        ],
                        model="fake-model",
                    ),
                    skill_key="meal_plan",
                ).message
                response = runner._chat_response(conversation.id, run.id)

                draft_parts = [part for part in message.parts if part.get("type") == "draft"]
                approval_parts = [part for part in message.parts if part.get("type") == "approval_request"]
                self.assertEqual([part["draft"]["draft_type"] for part in draft_parts], ["meal_plan", "shopping_list"])
                self.assertEqual([part["approval"]["approval_type"] for part in approval_parts], ["meal_plan.create", "shopping_list.create"])
                self.assertEqual([draft["draft_type"] for draft in response["included"]["drafts"]], ["meal_plan", "shopping_list"])
                self.assertEqual([approval["approval_type"] for approval in response["included"]["approvals"]], ["meal_plan.create", "shopping_list.create"])
                self.assertEqual(response["included"]["result_cards"], [])
                self.assertEqual(response["run"]["status"], "waiting_approval")

        def test_workspace_graph_json_encodes_run_records_before_flush(self) -> None:
            with self.SessionLocal() as db:
                service = AIApplicationService(db, provider=FakeChatProvider())
                conversation = service._get_or_create_conversation(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    conversation_id=None,
                    prompt="记录时间对象",
                    quick_task=None,
                )
                run = AIAgentRun(
                    id="agent_run-json-record-test",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="json_record",
                    input_summary="记录时间对象",
                    context_summary={},
                    output_summary="",
                    status="running",
                    model="fake-model",
                    input={},
                    output={},
                    tool_calls=[],
                    created_by=self.user.id,
                )
                db.add(run)
                db.flush()
                observed_at = datetime(2026, 6, 16, 1, 46, 15)

                WorkspaceGraphRunner(service).assistant_result_persister.persist(
                    {
                        "family_id": self.family.id,
                        "user_id": self.user.id,
                        "conversation_id": conversation.id,
                        "run_id": run.id,
                        "message": "记录时间对象",
                    },
                    SkillResult(
                        text="已记录。",
                        context_summary={"observedAt": observed_at},
                        tool_calls=[{"name": "ingredient.read_by_id", "output_summary": {"updatedAt": observed_at}}],
                        model="fake-model",
                    ),
                    skill_key="ingredient_profile",
                )

                db.flush()
                self.assertEqual(run.context_summary["observedAt"], "2026-06-16T01:46:15")
                self.assertEqual(run.tool_calls[0]["output_summary"]["updatedAt"], "2026-06-16T01:46:15")

        def test_legacy_ai_query_api_is_removed(self) -> None:
            response = self.client.post("/api/ai/query", json={"mode": "inventoryQa", "prompt": "库存怎么样"})
            self.assertEqual(response.status_code, 404, response.text)

        def test_ai_workspace_chat_returns_today_recommendation_card_and_persists_lifecycle(self) -> None:
            response = self.client.post(
                "/api/ai/chat",
                json={"message": "今日吃什么？", "quick_task": "today_recommendation"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertIn("conversation_id", data)
            self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
            self.assertEqual(data["run"]["intent"], "meal_plan")
            self.assertEqual(data["included"]["drafts"], [])
            self.assertEqual(data["included"]["approvals"], [])
            card_parts = [part for part in data["message"]["parts"] if part["type"] == "result_card"]
            self.assertEqual(card_parts[0]["card"]["type"], "today_recommendation")
            recommendations = card_parts[0]["card"]["data"]["recommendations"]
            self.assertGreaterEqual(len(recommendations), 1)
            self.assertEqual(recommendations[0]["foodId"], "food-tomato")
            self.assertEqual(recommendations[0]["name"], "番茄小炒")
            self.assertEqual(recommendations[0]["image"]["id"], "media-food-tomato")
            self.assertIn("reason", recommendations[0])
            self.assertIn("evidence", recommendations[0])

            plan_response = self.client.post(
                "/api/food-plan",
                json={
                    "food_id": "food-tomato",
                    "plan_date": (date.today() + timedelta(days=1)).isoformat(),
                    "meal_type": "dinner",
                    "note": "来自 AI 推荐",
                },
            )
            self.assertEqual(plan_response.status_code, 201, plan_response.text)
            selection_response = self.client.post(
                f"/api/ai/messages/{data['message']['id']}/recommendation-selection",
                json={
                    "part_id": card_parts[0]["id"],
                    "card_id": card_parts[0]["card"]["id"],
                    "entity_id": recommendations[0]["entityId"],
                    "food_plan_item_id": plan_response.json()["id"],
                },
            )
            self.assertEqual(selection_response.status_code, 200, selection_response.text)
            selected_item = selection_response.json()["parts"][-1]["card"]["data"]["recommendations"][0]
            self.assertEqual(selected_item["planSelection"]["foodPlanItemId"], plan_response.json()["id"])
            self.assertEqual(selected_item["planSelection"]["mealType"], "dinner")

            with self.SessionLocal() as db:
                messages = list(db.scalars(select(AIMessage).where(AIMessage.conversation_id == data["conversation_id"])))
                events = list(db.scalars(select(AIRunEvent).where(AIRunEvent.run_id == data["run"]["id"])))
                run = db.get(AIAgentRun, data["run"]["id"])
                self.assertEqual(len(messages), 2)
                event_messages = [event.user_message for event in events]
                self.assertIn("调用「餐食安排」技能", event_messages)
                self.assertIn("调用「可用库存」", event_messages)
                self.assertNotIn("餐食安排执行完成", event_messages)
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.intent, "meal_plan")
                self.assertEqual(run.context_summary["routing"]["skills"], ["meal_plan"])
                self.assertEqual(run.context_summary["inventoryItemCount"], 1)
                tool_names = [item["name"] for item in run.tool_calls]
                self.assertIn("inventory.read_available_items", tool_names)
                self.assertIn("inventory.read_expiring_items", tool_names)
                self.assertIn("food.search", tool_names)
                self.assertIn("meal_log.read_recent", tool_names)
                self.assertIn("recipe.search", tool_names)
                self.assertIn("meal_plan.recommend_today", tool_names)
                self.assertNotIn("meal_plan.create_draft", tool_names)
                stored_message = db.get(AIMessage, data["message"]["id"])
                self.assertEqual(
                    stored_message.message_metadata["recommendationSelections"][0]["name"],
                    "番茄小炒",
                )
                timeline = build_planner_conversation(
                    db,
                    family_id=self.family.id,
                    conversation_id=data["conversation_id"],
                )
                assistant_entry = next(item for item in timeline if item["id"] == data["message"]["id"])
                self.assertEqual(
                    assistant_entry["metadata"]["recommendationSelections"][0]["foodPlanItemId"],
                    plan_response.json()["id"],
                )

        def test_ai_workspace_routes_natural_today_recommendation_to_meal_plan_without_draft(self) -> None:
            for message, meal_type in [("今晚吃什么？", "dinner"), ("中午吃啥？", "lunch"), ("给我早餐思路", "breakfast")]:
                response = self.client.post("/api/ai/chat", json={"message": message})
                self.assertEqual(response.status_code, 200, response.text)
                data = response.json()
                self.assertEqual(data["run"]["agent_key"], "workspace_orchestrator")
                self.assertEqual(data["run"]["intent"], "meal_plan")
                self.assertEqual(data["included"]["drafts"], [])
                self.assertEqual(data["included"]["approvals"], [])
                card = data["included"]["result_cards"][0]
                self.assertEqual(card["type"], "today_recommendation")
                self.assertEqual(card["data"]["mealType"], meal_type)
                with self.SessionLocal() as db:
                    run = db.get(AIAgentRun, data["run"]["id"])
                    assert run is not None
                    tool_names = [item["name"] for item in run.tool_calls]
                    self.assertIn("meal_plan.recommend_today", tool_names)

        def test_ai_workspace_messages_are_family_scoped(self) -> None:
            create_response = self.client.post("/api/ai/chat", json={"message": "随便聊聊"})
            self.assertEqual(create_response.status_code, 200, create_response.text)
            conversation_id = create_response.json()["conversation_id"]

            response = self.client.get(f"/api/ai/conversations/{conversation_id}/messages")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(len(response.json()), 2)

        def test_ai_workspace_general_chat_does_not_persist_task_progress(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "随便聊聊"})
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertEqual(data["run"]["intent"], "general_chat")
            self.assertEqual(data["events"], [])

        def test_ai_workspace_general_chat_sends_conversation_history_to_provider(self) -> None:
            provider = CapturingGeneralChatProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                first_response = self.client.post("/api/ai/chat", json={"message": "给我两个早餐思路"})
                self.assertEqual(first_response.status_code, 200, first_response.text)
                conversation_id = first_response.json()["conversation_id"]

                second_response = self.client.post(
                    "/api/ai/chat",
                    json={"conversation_id": conversation_id, "message": "那第二种呢"},
                )
                self.assertEqual(second_response.status_code, 200, second_response.text)

            self.assertGreaterEqual(len(provider.general_payloads), 2)
            second_payload = provider.general_payloads[-1]
            self.assertEqual(second_payload["currentMessage"], "那第二种呢")
            history = second_payload["conversation"]
            self.assertTrue(any(item["role"] == "user" and item["content"] == "给我两个早餐思路" for item in history), history)
            self.assertTrue(any(item["role"] == "assistant" and "收到" in item["content"] for item in history), history)
            self.assertTrue(any(item["role"] == "user" and item["content"] == "那第二种呢" for item in history), history)

        def test_ai_workspace_subject_references_reach_toolcalling_skill_payload(self) -> None:
            provider = CapturingToolSubjectProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                response = self.client.post(
                    "/api/ai/chat",
                    json={
                        "message": "安排三天晚餐",
                        "subject": {
                            "source": "ingredient-page",
                            "ingredientIds": ["ingredient-tomato"],
                        },
                    },
                )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertGreaterEqual(len(provider.tool_payloads), 1)
            subject = provider.tool_payloads[0]["subject"]
            self.assertEqual(subject["source"], "ingredient-page")
            self.assertEqual(subject["ingredient_ids"], ["ingredient-tomato"])
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, response.json()["run"]["id"])
                self.assertIsNotNone(run)
                assert run is not None
                self.assertEqual(run.input["subject"]["ingredient_ids"], ["ingredient-tomato"])

        def test_ai_workspace_reuses_completed_client_message_and_run_ids(self) -> None:
            payload = {
                "message": "随便聊聊",
                "client_message_id": "client-message-idempotent",
                "client_run_id": "agent_run-idempotent",
            }
            first_response = self.client.post("/api/ai/chat", json=payload)
            self.assertEqual(first_response.status_code, 200, first_response.text)
            second_response = self.client.post("/api/ai/chat", json=payload)
            self.assertEqual(second_response.status_code, 200, second_response.text)

            first_data = first_response.json()
            second_data = second_response.json()
            self.assertEqual(second_data["run"]["id"], first_data["run"]["id"])
            self.assertEqual(second_data["message"]["id"], first_data["message"]["id"])
            with self.SessionLocal() as db:
                user_messages = list(
                    db.scalars(
                        select(AIMessage).where(
                            AIMessage.family_id == self.family.id,
                            AIMessage.role == "user",
                            AIMessage.client_message_id == "client-message-idempotent",
                        )
                    )
                )
                runs = list(db.scalars(select(AIAgentRun).where(AIAgentRun.id == "agent_run-idempotent")))
                self.assertEqual(len(user_messages), 1)
                self.assertEqual(len(runs), 1)

        def test_ai_workspace_duplicate_running_client_run_returns_conflict(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-running-idempotency",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="处理中",
                    response="",
                    context={"workspace": True},
                    created_by=self.user.id,
                )
                run = AIAgentRun(
                    id="agent_run-running-idempotency",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    message_id=None,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="general_chat",
                    input_summary="处理中",
                    context_summary={},
                    output_summary="",
                    status="running",
                    model="fake-model",
                    input={"prompt": "处理中", "subject": {}},
                    output={},
                    tool_calls=[],
                    duration_ms=0,
                    created_by=self.user.id,
                )
                db.add_all([conversation, run])
                db.commit()

            response = self.client.post(
                "/api/ai/chat",
                json={"message": "重试同一个运行", "client_run_id": "agent_run-running-idempotency"},
            )
            self.assertEqual(response.status_code, 409, response.text)

        def test_ai_workspace_rejects_new_message_when_conversation_has_active_run(self) -> None:
            for status in ("running", "waiting_input"):
                with self.subTest(status=status):
                    conversation_id = f"conversation-active-run-{status}"
                    with self.SessionLocal() as db:
                        conversation = AIConversation(
                            id=conversation_id,
                            family_id=self.family.id,
                            mode=AiMode.RECOMMENDATION,
                            prompt="处理中",
                            response="",
                            context={"workspace": True},
                            created_by=self.user.id,
                        )
                        run = AIAgentRun(
                            id=f"agent_run-active-conversation-{status}",
                            family_id=self.family.id,
                            conversation_id=conversation.id,
                            message_id=None,
                            agent_key="workspace_orchestrator",
                            feature_key="ai_workspace_chat",
                            intent="general_chat",
                            input_summary="处理中",
                            context_summary={},
                            output_summary="",
                            status=status,
                            model="fake-model",
                            input={"prompt": "处理中", "subject": {}},
                            output={},
                            tool_calls=[],
                            duration_ms=0,
                            created_by=self.user.id,
                        )
                        db.add_all([conversation, run])
                        db.commit()

                    response = self.client.post(
                        "/api/ai/chat",
                        json={"message": "新消息", "conversation_id": conversation_id},
                    )
                    self.assertEqual(response.status_code, 409, response.text)
                    self.assertIn("当前会话已有 AI 任务", response.text)

        def test_ai_status_reports_disabled_provider_without_secrets(self) -> None:
            settings = SimpleNamespace(ai_provider="disabled", ai_model="", ai_api_key="")
            with patch("app.api.ai.get_settings", return_value=settings):
                response = self.client.get("/api/ai/status")
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertFalse(data["enabled"])
            self.assertEqual(data["status"], "disabled")
            self.assertEqual(data["provider"], "disabled")
            self.assertNotIn("api_key", data)

        def test_ai_status_reports_ready_provider_without_secrets(self) -> None:
            settings = SimpleNamespace(ai_provider="openai-compatible", ai_model="fake-model", ai_api_key="secret")
            with patch("app.api.ai.get_settings", return_value=settings):
                response = self.client.get("/api/ai/status")
            self.assertEqual(response.status_code, 200, response.text)
            data = response.json()
            self.assertTrue(data["enabled"])
            self.assertEqual(data["status"], "ready")
            self.assertEqual(data["model"], "fake-model")
            self.assertNotIn("secret", response.text)

        def test_ai_chat_request_rejects_blank_message_before_running_agent(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "   "})
            self.assertEqual(response.status_code, 422, response.text)

        def test_ai_chat_request_rejects_overlong_message_before_running_agent(self) -> None:
            response = self.client.post("/api/ai/chat", json={"message": "x" * 2001})
            self.assertEqual(response.status_code, 422, response.text)
