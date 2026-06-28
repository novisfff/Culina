import threading

from app.ai.errors import ApprovalRequired
from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.ai.workflows.runner import WorkspaceGraphRunner

from ._support import *


def _tool_names(tools) -> set[str]:
    current_tools = tools()
    return {tool.name for tool in current_tools}


def _emit_text(message_handler, text: str) -> None:
    if message_handler is not None:
        message_handler(text)


class BlockingStreamingChatProvider(BaseChatProvider):
    model_name = "blocking-stream-model"

    def __init__(self, first_delta_persisted: threading.Event, continue_stream: threading.Event) -> None:
        self.first_delta_persisted = first_delta_persisted
        self.continue_stream = continue_stream

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("streaming chat should not call blocking generate")

    def stream_generate(self, *, system: str, user: str):
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
        tools,
        tool_handler,
        message_handler=None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del tools, tool_handler, max_rounds
        chunks = []
        for chunk in self.stream_generate(system=system, user=user):
            chunks.append(chunk)
            _emit_text(message_handler, chunk)
        text = "".join(chunks)
        return ChatProviderResult(
            text=text,
            status="completed",
            model=self.model_name,
        )


class EmptyApprovalFollowupProvider(BaseChatProvider):
    model_name = "empty-approval-followup-model"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("approval follow-up should use stream_generate")

    def stream_generate(self, *, system: str, user: str):
        del system, user
        if False:
            yield ""

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
        raise AssertionError("approval follow-up test should not run the orchestrator loop")


class BlockingApprovalResumeProvider(BaseChatProvider):
    model_name = "blocking-approval-resume-model"

    def __init__(
        self,
        approval_commit_persisted: threading.Event,
        resume_started: threading.Event,
        continue_resume: threading.Event,
    ) -> None:
        self.approval_commit_persisted = approval_commit_persisted
        self.resume_started = resume_started
        self.continue_resume = continue_resume
        self.commit_seen_at_resume_start = False

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("workspace orchestrator should use generate_with_tools")

    def stream_generate(self, *, system: str, user: str):
        raise AssertionError("approval resume should not use stream_generate")

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
        del system, user, tools, tool_handler, message_handler, max_rounds
        self.commit_seen_at_resume_start = self.approval_commit_persisted.is_set()
        self.resume_started.set()
        if not self.continue_resume.wait(timeout=5):
            raise RuntimeError("approval resume stream test timed out")
        return ChatProviderResult(
            text="已确认菜谱，图片生成任务已开始。",
            status="completed",
            model=self.model_name,
        )


class ProgressiveMultiDraftProvider(BaseChatProvider):
    model_name = "progressive-multi-draft-model"

    def __init__(self) -> None:
        self.active_calls = 0

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("workspace orchestrator should use generate_with_tools")

    def stream_generate(self, *, system: str, user: str):
        del system, user
        raise AssertionError("approval resume should continue through the orchestrator agent loop")

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
        del system, max_rounds
        payload = json.loads(user)
        tool_handler("skill.inject", {"skills": ["meal_plan", "shopping_list"], "reason": "需要先安排餐食，确认后继续购物清单"})
        tool_names = _tool_names(tools)
        assert "meal_plan.create_draft" in tool_names
        assert "shopping.create_draft" in tool_names
        current_artifacts = payload.get("currentRunArtifacts") if isinstance(payload.get("currentRunArtifacts"), list) else []
        resume_artifacts = [
            artifact
            for artifact in current_artifacts
            if isinstance(artifact, dict) and artifact.get("type") == "draft_after_approval"
        ]
        meal_plan_draft = {
            "draftType": "meal_plan",
            "schemaVersion": "meal_plan.v1",
            "items": [
                {
                    "date": date.today().isoformat(),
                    "mealType": "dinner",
                    "title": "番茄小炒",
                    "foodId": "food-tomato",
                    "recipeId": "",
                    "reason": "先安排晚餐",
                    "usedInventory": [],
                    "missingIngredients": [],
                }
            ],
            "source": {"days": 1, "mealTypes": ["dinner"]},
        }
        shopping_draft = {
            "draftType": "shopping_list",
            "schemaVersion": "shopping_list.v1",
            "items": [{"title": "鸡蛋", "quantity": 2, "unit": "个", "reason": "搭配晚餐"}],
        }
        self.active_calls += 1
        if self.active_calls == 1:
            text = "我先生成餐食计划草稿，确认后再继续购物清单。"
            _emit_text(message_handler, text)
            tool_handler(
                "meal_plan.create_draft",
                {
                    "draft": meal_plan_draft,
                    "afterApproval": {
                        "continue": False,
                        "instruction": "确认餐食计划后，继续生成购物清单草稿。",
                        "nextDraftType": "shopping_list",
                    },
                },
            )
            return ChatProviderResult(
                text=text,
                status="waiting_approval",
                model=self.model_name,
            )
        assert resume_artifacts
        assert "购物清单" in str(resume_artifacts[-1].get("payload", {}))
        assert "continue" not in resume_artifacts[-1].get("payload", {})
        text = "已确认餐食计划。接下来我根据已确认的餐食计划生成购物清单草稿。"
        _emit_text(message_handler, text)
        tool_handler("shopping.create_draft", {"draft": shopping_draft})
        return ChatProviderResult(
            text=text,
            status="waiting_approval",
            model=self.model_name,
        )


class BlockingProgressiveRecipeDraftProvider(BaseChatProvider):
    model_name = "blocking-progressive-recipe-draft-model"

    def __init__(self, draft_published: threading.Event, continue_stream: threading.Event) -> None:
        self.draft_published = draft_published
        self.continue_stream = continue_stream

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
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
    ) -> ChatProviderResult:
        del system, user, max_rounds
        tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要生成菜谱草稿"})
        assert "recipe.create_draft" in _tool_names(tools)
        text = "我先生成菜谱草稿。"
        _emit_text(message_handler, text)
        try:
            tool_handler(
                "recipe.create_draft",
                {
                    "draft": {
                        "draftType": "recipe",
                        "schemaVersion": "recipe.v1",
                        "title": "番茄鸡蛋面",
                        "servings": 2,
                        "prep_minutes": 20,
                        "difficulty": "easy",
                        "ingredient_items": [
                            {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""},
                        ],
                        "steps": [
                            {
                                "title": "备菜",
                                "text": "番茄切块，鸡蛋打散。",
                                "icon": "bowl",
                                "summary": "备菜",
                                "estimated_minutes": 5,
                                "tip": "",
                                "key_points": [],
                            },
                            {
                                "title": "煮面",
                                "text": "煮面后加入番茄鸡蛋汤底。",
                                "icon": "pan",
                                "summary": "煮熟",
                                "estimated_minutes": 15,
                                "tip": "",
                                "key_points": [],
                            },
                            {
                                "title": "调味",
                                "text": "出锅前尝味，按家人口味少量加盐。",
                                "icon": "plate",
                                "summary": "调味出锅",
                                "estimated_minutes": 2,
                                "tip": "",
                                "key_points": [],
                            },
                        ],
                        "tips": "",
                        "scene_tags": [],
                        "media_ids": [],
                    }
                },
            )
        except ApprovalRequired:
            self.draft_published.set()
            if not self.continue_stream.wait(timeout=5):
                raise RuntimeError("stream test timed out")
            raise
        return ChatProviderResult(
            text=text,
            status="waiting_approval",
            model=self.model_name,
        )


class PreviewedRecipeDraftProvider(BaseChatProvider):
    model_name = "previewed-recipe-draft-model"

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        raise AssertionError("workspace orchestrator should use generate_with_tools")

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
        del system, user, max_rounds
        tool_handler("skill.inject", {"skills": ["recipe_draft"], "reason": "需要生成菜谱草稿"})
        assert "recipe.create_draft" in _tool_names(tools)
        event_id = tool_preview_handler("recipe.create_draft", "0", "running") if tool_preview_handler is not None else None
        _emit_text(message_handler, "我先生成菜谱草稿。")
        tool_handler(
            "recipe.create_draft",
            {
                "draft": {
                    "draftType": "recipe",
                    "schemaVersion": "recipe.v1",
                    "title": "番茄鸡蛋面",
                    "servings": 2,
                    "prep_minutes": 20,
                    "difficulty": "easy",
                    "ingredient_items": [
                        {"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""},
                    ],
                    "steps": [
                        {"title": "备菜", "text": "番茄切块，鸡蛋打散。", "icon": "bowl", "summary": "备菜", "estimated_minutes": 5, "tip": "", "key_points": []},
                        {"title": "煮面", "text": "煮面后加入番茄鸡蛋汤底。", "icon": "pan", "summary": "煮熟", "estimated_minutes": 15, "tip": "", "key_points": []},
                        {"title": "调味", "text": "出锅前少量加盐调味。", "icon": "plate", "summary": "调味出锅", "estimated_minutes": 2, "tip": "", "key_points": []},
                    ],
                    "tips": "",
                    "scene_tags": [],
                    "media_ids": [],
                }
            },
            event_id,
        )
        return ChatProviderResult(text="我先生成菜谱草稿。", status="waiting_approval", model=self.model_name)


class RetrySameDraftProvider(BaseChatProvider):
    model_name = "retry-same-draft-model"

    def __init__(self) -> None:
        self.calls = 0

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
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
    ) -> ChatProviderResult:
        del system, user, max_rounds
        tool_handler("skill.inject", {"skills": ["shopping_list"], "reason": "需要生成购物清单草稿"})
        assert "shopping.create_draft" in _tool_names(tools)
        draft = {
            "draftType": "shopping_list",
            "schemaVersion": "shopping_list.v1",
            "items": [{"title": "牛奶", "quantity": 1, "unit": "瓶", "reason": "早餐"}],
        }
        text = "我先生成购物清单草稿。"
        _emit_text(message_handler, text)
        self.calls += 1
        tool_handler("shopping.create_draft", {"draft": draft})
        return ChatProviderResult(
            text=text,
            status="waiting_approval",
            model=self.model_name,
        )


class CommitGatedRecipeProvider(BaseChatProvider):
    model_name = "commit-gated-recipe-model"

    def __init__(self) -> None:
        self.active_calls = 0

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
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
    ) -> ChatProviderResult:
        del system, user, max_rounds
        tool_handler("skill.inject", {"skills": ["recipe_draft", "meal_plan"], "reason": "先创建菜谱，确认后才能安排餐食计划"})
        self.active_calls += 1
        tool_names = _tool_names(tools)
        assert "recipe.create_draft" in tool_names
        assert "meal_plan.create_draft" in tool_names
        recipe_draft = {
            "draftType": "recipe",
            "schemaVersion": "recipe.v1",
            "title": "红烧牛肉",
            "servings": 2,
            "prep_minutes": 45,
            "difficulty": "medium",
            "ingredient_items": [{"ingredient_id": "ingredient-tomato", "ingredient_name": "番茄", "quantity": 2, "unit": "个", "note": ""}],
            "steps": [
                {
                    "title": "焯水",
                    "text": "牛肉冷水下锅，煮出浮沫后捞出冲净。",
                    "icon": "pan",
                    "summary": "去除浮沫",
                    "estimated_minutes": 10,
                    "tip": "",
                    "key_points": [],
                },
                {
                    "title": "炒香",
                    "text": "锅中加少量油，放入牛肉和调味料炒香。",
                    "icon": "pan",
                    "summary": "炒出香味",
                    "estimated_minutes": 8,
                    "tip": "",
                    "key_points": [],
                },
                {
                    "title": "炖煮",
                    "text": "加入热水，小火炖煮至牛肉软烂。",
                    "icon": "timer",
                    "summary": "炖到软烂",
                    "estimated_minutes": 45,
                    "tip": "",
                    "key_points": [],
                }
            ],
            "tips": "",
            "scene_tags": [],
            "media_ids": [],
        }
        text = "我先创建红烧牛肉菜谱草稿，确认后再安排到明天晚餐。"
        _emit_text(message_handler, text)
        tool_handler(
            "recipe.create_draft",
            {
                "draft": recipe_draft,
                "afterApproval": {
                    "instruction": "确认菜谱后，继续把这道菜安排到明天晚餐。",
                    "nextDraftType": "meal_plan",
                },
            },
        )
        return ChatProviderResult(
            text=text,
            status="waiting_approval",
            model=self.model_name,
        )


class RepeatedReadToolProvider(BaseChatProvider):
    model_name = "repeated-read-tool-model"

    def __init__(self) -> None:
        self.blocked_result: dict | None = None

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
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
    ) -> ChatProviderResult:
        del system, user, max_rounds
        tool_handler("skill.inject", {"skills": ["meal_plan"], "reason": "需要读取库存"})
        assert "inventory.read_available_items" in _tool_names(tools)
        read_payload = {"limit": 5}
        tool_handler("inventory.read_available_items", read_payload)
        tool_handler("inventory.read_available_items", read_payload)
        tool_handler("inventory.read_available_items", read_payload)
        self.blocked_result = tool_handler("inventory.read_available_items", read_payload)
        text = "我已基于已有库存读取结果停止重复查询。"
        _emit_text(message_handler, text)
        return ChatProviderResult(
            text=text,
            status="completed",
            model=self.model_name,
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
        def test_stream_chat_yields_delta_before_orchestrator_node_finishes(self) -> None:
            first_delta_persisted = threading.Event()
            continue_stream = threading.Event()
            provider = BlockingStreamingChatProvider(first_delta_persisted, continue_stream)

            with self.SessionLocal() as db:
                stream = AIApplicationService(db, provider=provider).stream_chat(
                    family_id=self.family.id,
                    user_id=self.user.id,
                    message="随便聊聊",
                    client_run_id="agent_run-realtime-delta-test",
                )
                event_name, data = next(stream)
                self.assertEqual(event_name, "message_delta")
                self.assertEqual(data["delta"], "第一段")
                self.assertTrue(first_delta_persisted.is_set())

                continue_stream.set()
                remaining_events = list(stream)

            self.assertTrue(any(event_name == "response" for event_name, _data in remaining_events))

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
                    self.assertEqual(message.content, "第一段第二段")
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
                self.assertEqual(assistant_messages[0]["content"], "第一段第二段")
                self.assertEqual(assistant_messages[0]["status"], "completed")
                self.assertFalse(assistant_messages[0]["metadata"].get("liveStreaming", False))
            finally:
                continue_stream.set()
                thread.join(timeout=5)

        def test_fast_approval_before_original_response_does_not_restore_pending(self) -> None:
            draft_published = threading.Event()
            continue_stream = threading.Event()
            provider = BlockingProgressiveRecipeDraftProvider(draft_published, continue_stream)
            captured: dict[str, str | int] = {}
            errors: list[BaseException] = []

            def consume_stream() -> None:
                try:
                    with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                        with self.client.stream(
                            "POST",
                            "/api/ai/chat/stream",
                            json={"message": "生成番茄鸡蛋面菜谱", "client_run_id": "agent_run-fast-approval-before-final"},
                        ) as response:
                            captured["status_code"] = response.status_code
                            captured["body"] = "".join(response.iter_text())
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=consume_stream)
            thread.start()
            try:
                self.assertTrue(draft_published.wait(timeout=5))
                with self.SessionLocal() as db:
                    approval = db.scalar(
                        select(AIApprovalRequest).where(AIApprovalRequest.run_id == "agent_run-fast-approval-before-final")
                    )
                    self.assertIsNotNone(approval)
                    assert approval is not None
                    approval_id = approval.id
                    conversation_id = approval.conversation_id
                    draft_version = approval.draft_version
                    values = approval.initial_values

                decision_response = self.client.post(
                    f"/api/ai/conversations/{conversation_id}/approvals/{approval_id}/decision",
                    json={"decision": "approved", "draft_version": draft_version, "values": values},
                )
                self.assertEqual(decision_response.status_code, 200, decision_response.text)
                self.assertEqual(decision_response.json()["approval"]["status"], "approved")

                continue_stream.set()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
                self.assertFalse(errors)
                self.assertEqual(captured.get("status_code"), 200)
                response_event = _response_event(str(captured.get("body") or ""))
                approval_parts = [
                    part
                    for part in response_event["message"]["parts"]
                    if part.get("type") == "approval_request" and part.get("approval", {}).get("id") == approval_id
                ]
                self.assertEqual(len(approval_parts), 1)
                self.assertEqual(approval_parts[0]["approval"]["status"], "approved")
                self.assertEqual(response_event["included"]["approvals"][0]["status"], "approved")
                with self.SessionLocal() as db:
                    message = db.scalar(select(AIMessage).where(AIMessage.run_id == "agent_run-fast-approval-before-final"))
                    self.assertIsNotNone(message)
                    assert message is not None
                    stored_approval_parts = [
                        part
                        for part in message.parts
                        if part.get("type") == "approval_request" and part.get("approval", {}).get("id") == approval_id
                    ]
                    self.assertEqual(len(stored_approval_parts), 1)
                    self.assertEqual(stored_approval_parts[0]["approval"]["status"], "approved")
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

        def test_ai_workspace_live_overlay_preserves_resolved_approval_result_position(self) -> None:
            run_id = "agent-run-overlay-approval-result-order"
            conversation_id = "conversation-overlay-approval-result-order"
            message_id = "message-overlay-approval-result-order"
            result_part = {
                "id": "operation-result-part-overlay",
                "type": "result_card",
                "card": {
                    "id": "operation-result:approval-overlay-approved",
                    "type": "operation_result",
                    "title": "已创建菜谱",
                    "data": {
                        "approvalId": "approval-overlay-approved",
                        "actionSummary": "白切鸡已写入菜谱库。",
                        "entityCount": 1,
                        "entityCountLabel": "1 个菜谱",
                        "workspaceLabel": "菜谱库",
                        "workspaceHint": "可前往菜谱库查看",
                    },
                },
            }
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id=conversation_id,
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="生成菜谱",
                    response="",
                    context={"workspace": True},
                    title="生成菜谱",
                    status="active",
                    last_run_status="running",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id=message_id,
                    family_id=self.family.id,
                    conversation_id=conversation_id,
                    role="assistant",
                    content="菜谱草稿已经生成，请确认。",
                    content_type="parts",
                    parts=[
                        {"id": "text-before-approval", "type": "text", "text": "菜谱草稿已经生成，请确认。"},
                        {
                            "id": "draft-part-overlay",
                            "type": "draft",
                            "draft": {
                                "id": "draft-overlay-approved",
                                "conversation_id": conversation_id,
                                "message_id": message_id,
                                "run_id": run_id,
                                "draft_type": "recipe",
                                "payload": {"draftType": "recipe", "schemaVersion": "recipe.v1", "title": "白切鸡"},
                                "preview_summary": "白切鸡",
                                "status": "confirmed",
                                "version": 1,
                                "schema_version": "recipe.v1",
                                "validation_errors": [],
                                "expires_at": None,
                                "created_at": utcnow().isoformat(),
                                "updated_at": utcnow().isoformat(),
                            },
                        },
                        {
                            "id": "approval-part-overlay",
                            "type": "approval_request",
                            "approval": {
                                "id": "approval-overlay-approved",
                                "conversation_id": conversation_id,
                                "message_id": message_id,
                                "run_id": run_id,
                                "draft_id": "draft-overlay-approved",
                                "draft_version": 1,
                                "draft_schema_version": "recipe.v1",
                                "approval_type": "recipe.create",
                                "status": "approved",
                                "decision": "approved",
                                "title": "确认创建菜谱",
                                "instruction": "确认后会创建菜谱。",
                                "approve_label": "创建菜谱",
                                "reject_label": "暂不创建",
                                "require_reject_comment": False,
                                "field_schema": [],
                                "initial_values": {},
                                "submitted_values": {},
                                "created_at": utcnow().isoformat(),
                            },
                        },
                        result_part,
                    ],
                    run_id=run_id,
                    status="running",
                    message_metadata={},
                    created_by=self.user.id,
                )
                db.add_all([conversation, message])
                db.commit()

            live_ai_stream_cache.append_part(
                family_id=self.family.id,
                conversation_id=conversation_id,
                run_id=run_id,
                message_id=message_id,
                part=result_part,
                created_by=self.user.id,
            )
            live_ai_stream_cache.append_activity(
                family_id=self.family.id,
                conversation_id=conversation_id,
                run_id=run_id,
                message_id=message_id,
                part={
                    "id": "activity-next-draft-overlay",
                    "type": "run_activity",
                    "activity": {
                        "id": "progress-next-draft-overlay",
                        "run_id": run_id,
                        "type": "tool",
                        "internal_code": "recipe.create_draft",
                        "user_message": "生成「菜谱确认表单」",
                        "status": "running",
                        "created_at": utcnow().isoformat(),
                    },
                },
                created_by=self.user.id,
            )
            try:
                response = self.client.get(f"/api/ai/conversations/{conversation_id}/messages")
                self.assertEqual(response.status_code, 200, response.text)
                assistant_message = next(message for message in response.json() if message["id"] == message_id)
                part_ids = [part["id"] for part in assistant_message["parts"]]
                self.assertLess(part_ids.index("approval-part-overlay"), part_ids.index("operation-result-part-overlay"))
                self.assertLess(part_ids.index("operation-result-part-overlay"), part_ids.index("activity-next-draft-overlay"))
                self.assertEqual(part_ids.count("operation-result-part-overlay"), 1)
                self.assertIn("approval-part-overlay", part_ids)
            finally:
                live_ai_stream_cache.clear_run(run_id)

        def test_ai_workspace_live_overlay_does_not_replace_completed_message(self) -> None:
            conversation_id = "conversation-live-overlay-completed"
            run_id = "run-live-overlay-completed"
            message_id = "message-live-overlay-completed"
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id=conversation_id,
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="已完成会话",
                    response="已完成",
                    context={"workspace": True},
                    title="已完成会话",
                    status="active",
                    last_run_status="completed",
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id=message_id,
                    family_id=self.family.id,
                    conversation_id=conversation_id,
                    role="assistant",
                    content="这是持久化完成消息。",
                    content_type="parts",
                    parts=[{"id": "text-completed", "type": "text", "text": "这是持久化完成消息。"}],
                    run_id=run_id,
                    status="completed",
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
                    "id": "activity-stale-running",
                    "type": "run_activity",
                    "activity": {
                        "id": "progress-stale-running",
                        "run_id": run_id,
                        "type": "tool",
                        "internal_code": "recipe.create_draft",
                        "user_message": "生成「菜谱确认表单」",
                        "status": "running",
                        "created_at": utcnow().isoformat(),
                    },
                },
                created_by=self.user.id,
            )
            response = self.client.get(f"/api/ai/conversations/{conversation_id}/messages")
            self.assertEqual(response.status_code, 200, response.text)
            assistant_message = next(message for message in response.json() if message["id"] == message_id)
            self.assertEqual(assistant_message["status"], "completed")
            self.assertEqual([part["id"] for part in assistant_message["parts"]], ["text-completed"])
            self.assertEqual(live_ai_stream_cache.parts_for_run(run_id), [])

        def test_graph_stream_disconnect_continues_worker_without_blocking_close(self) -> None:
            runner = WorkspaceGraphRunner.__new__(WorkspaceGraphRunner)
            runner._direct_stream_sink = None
            runner.db = SimpleNamespace(commit=lambda: None, rollback=lambda: None)
            continue_stream = threading.Event()
            graph_finished = threading.Event()
            disconnected = threading.Event()
            close_finished = threading.Event()

            def graph_stream():
                yield ("updates", {"step": 1})
                continue_stream.wait(timeout=2)
                graph_finished.set()

            def handle_update(_update):
                yield "progress", {
                    "id": "event-disconnect-progress",
                    "type": "tool",
                    "internal_code": "recipe.create_draft",
                    "user_message": "生成「菜谱确认表单」",
                    "status": "running",
                }

            stream = runner._stream_graph_events(
                lambda _runner: graph_stream(),
                handle_update=lambda _runner, update: handle_update(update),
                seen_event_ids=set(),
                on_disconnect=disconnected.set,
                runner_factory=lambda: runner,
            )
            self.assertEqual(next(stream)[0], "progress")

            closer = threading.Thread(target=lambda: (stream.close(), close_finished.set()))
            closer.start()
            self.assertTrue(disconnected.wait(timeout=1))
            self.assertTrue(close_finished.wait(timeout=1))
            self.assertFalse(graph_finished.is_set())
            continue_stream.set()
            self.assertTrue(graph_finished.wait(timeout=1))
            closer.join(timeout=1)

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
            self.assertNotIn("我生成了 3 条餐食计划草稿。", body)
            self.assertNotIn("<structured_result>", body)
            self.assertNotIn("正在生成餐食计划结构化结果", body)
            self.assertNotIn("餐食计划：已准备草稿", body)
            self.assertNotIn("餐食安排执行完成", body)
            self.assertLess(body.index("我先看一下临期食材和最近餐食。"), body.index("调用「临期食材」"))
            self.assertLess(body.index("调用「餐食安排」技能"), body.index("调用「临期食材」"))
            self.assertLess(body.index("调用「临期食材」"), body.index("生成「餐食计划确认表单」"))
            self.assertLess(body.index("调用「餐食安排」技能"), body.index("event: response"))
            self.assertIn("waiting_approval", body)
            self.assertIn("meal_plan.create", body)
            events = _sse_events(body)
            draft_activity_events = [
                data
                for event_name, data in events
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "run_activity"
                and data.get("part", {}).get("activity", {}).get("internal_code") == "meal_plan.create_draft"
            ]
            self.assertEqual(draft_activity_events[0]["part"]["activity"]["status"], "running")
            self.assertEqual(draft_activity_events[-1]["part"]["activity"]["status"], "completed")
            first_approval_event_index = next(
                index
                for index, (event_name, data) in enumerate(events)
                if event_name == "message_part" and data.get("part", {}).get("type") == "approval_request"
            )
            self.assertLess(
                next(index for index, item in enumerate(events) if item[1] in draft_activity_events),
                first_approval_event_index,
            )
            response_event = _response_event(body)
            parts = response_event["message"]["parts"]
            text_parts = [part["text"].strip() for part in parts if part["type"] == "text"]
            self.assertEqual(text_parts, ["我先看一下临期食材和最近餐食。"])
            self.assertLess(
                next(index for index, part in enumerate(parts) if part.get("text", "").startswith("我先看一下临期食材")),
                next(index for index, part in enumerate(parts) if part.get("activity", {}).get("user_message") == "调用「临期食材」"),
            )
            self.assertLess(
                next(index for index, part in enumerate(parts) if part.get("activity", {}).get("user_message") == "生成「餐食计划确认表单」"),
                next(index for index, part in enumerate(parts) if part.get("type") == "approval_request"),
            )
            events_response = self.client.get("/api/ai/runs/agent_run-draft-stream-test/events")
            self.assertEqual(events_response.status_code, 200)
            event_messages = [event["user_message"] for event in events_response.json()]
            self.assertIn("调用「餐食安排」技能", event_messages)
            self.assertIn("调用「临期食材」", event_messages)
            self.assertIn("生成「餐食计划确认表单」", event_messages)
            self.assertNotIn("餐食安排执行完成", event_messages)

        def test_ai_workspace_streams_previewed_tool_name_as_single_activity(self) -> None:
            with patch("app.ai.workspace_service.get_chat_provider", return_value=PreviewedRecipeDraftProvider()):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "生成一个番茄鸡蛋面菜谱", "client_run_id": "agent_run-preview-tool-name"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            events = _sse_events(body)
            draft_activity_events = [
                data
                for event_name, data in events
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "run_activity"
                and data.get("part", {}).get("activity", {}).get("internal_code") == "recipe.create_draft"
            ]
            self.assertEqual(draft_activity_events[0]["part"]["activity"]["status"], "running")
            self.assertEqual(draft_activity_events[-1]["part"]["activity"]["status"], "completed")
            self.assertEqual(
                len({event["part"]["activity"]["id"] for event in draft_activity_events}),
                1,
            )
            approval_index = next(
                index
                for index, (event_name, data) in enumerate(events)
                if event_name == "message_part" and data.get("part", {}).get("type") == "approval_request"
            )
            first_draft_activity_index = next(index for index, item in enumerate(events) if item[1] in draft_activity_events)
            self.assertLess(first_draft_activity_index, approval_index)

        def test_ai_workspace_stops_after_first_draft_before_approval(self) -> None:
            provider = ProgressiveMultiDraftProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "安排晚餐并列购物清单", "client_run_id": "agent_run-progressive-drafts"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            self.assertEqual(provider.active_calls, 1)
            events = _sse_events(body)
            approval_part_events = [
                data
                for event_name, data in events
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "approval_request"
            ]
            self.assertEqual(len(approval_part_events), 1)
            self.assertLess(body.index('"type": "approval_request"'), body.index("event: response"))
            self.assertEqual(
                [item["part"]["approval"]["approval_type"] for item in approval_part_events],
                ["meal_plan.create"],
            )
            response_event = _response_event(body)
            parts = response_event["message"]["parts"]
            approval_parts = [part for part in parts if part.get("type") == "approval_request"]
            draft_parts = [part for part in parts if part.get("type") == "draft"]
            self.assertEqual(len(approval_parts), 1)
            self.assertEqual(len(draft_parts), 1)
            self.assertEqual(response_event["message"]["status"], "waiting_approval")
            self.assertEqual(response_event["run"]["status"], "waiting_approval")
            self.assertEqual(len(response_event["included"]["drafts"]), 1)
            self.assertEqual(len(response_event["included"]["approvals"]), 1)
            with self.SessionLocal() as db:
                drafts = list(db.scalars(select(AITaskDraft).where(AITaskDraft.source_run_id == "agent_run-progressive-drafts")))
                approvals = list(db.scalars(select(AIApprovalRequest).where(AIApprovalRequest.run_id == "agent_run-progressive-drafts")))
                self.assertEqual(len(drafts), 1)
                self.assertEqual(len(approvals), 1)
                conversation = db.get(AIConversation, response_event["conversation_id"])
                self.assertIsNotNone(conversation)
                assert conversation is not None
                self.assertEqual(drafts[0].ai_metadata["afterApproval"]["nextDraftType"], "shopping_list")

        def test_ai_workspace_approval_resume_generates_next_draft(self) -> None:
            provider = ProgressiveMultiDraftProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "安排晚餐并列购物清单", "client_run_id": "agent_run-approval-resume-next-draft"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            response_event = _response_event(body)
            approval = response_event["included"]["approvals"][0]
            decision_response = self.client.post(
                f"/api/ai/conversations/{response_event['conversation_id']}/approvals/{approval['id']}/decision",
                json={
                    "decision": "approved",
                    "draft_version": approval["draft_version"],
                    "values": approval["initial_values"],
                },
            )
            self.assertEqual(decision_response.status_code, 200, decision_response.text)
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                with self.client.stream(
                    "POST",
                    f"/api/ai/conversations/{response_event['conversation_id']}/approvals/{approval['id']}/decision/stream",
                    json={
                        "decision": "approved",
                        "draft_version": approval["draft_version"],
                        "values": approval["initial_values"],
                    },
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    resume_body = "".join(response.iter_text())

            self.assertEqual(provider.active_calls, 2)
            self.assertIn("已确认餐食计划。接下来我根据已确认的餐食计划生成购物清单草稿。", resume_body)
            self.assertNotIn("如果还有", resume_body)
            self.assertNotIn("你也可以", resume_body)
            self.assertIn("生成「购物清单确认表单」", resume_body)
            self.assertNotIn("购物清单草稿也准备好了。", resume_body)
            resume_events = _sse_events(resume_body)
            approval_result_index = next(
                index
                for index, (event_name, data) in enumerate(resume_events)
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "approval_request"
                and data.get("part", {}).get("approval", {}).get("id") == approval["id"]
                and data.get("part", {}).get("approval", {}).get("status") == "approved"
            )
            result_part_index = next(
                index
                for index, (event_name, data) in enumerate(resume_events)
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "result_card"
                and data.get("part", {}).get("card", {}).get("type") == "operation_result"
                and data.get("part", {}).get("card", {}).get("data", {}).get("approvalId") == approval["id"]
            )
            followup_text_index = next(
                index
                for index, (event_name, data) in enumerate(resume_events)
                if event_name == "message_delta"
                and "接下来我根据已确认的餐食计划生成购物清单草稿。" in data.get("delta", "")
            )
            next_draft_activity_index = next(
                index
                for index, (event_name, data) in enumerate(resume_events)
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "run_activity"
                and data.get("part", {}).get("activity", {}).get("user_message") == "生成「购物清单确认表单」"
            )
            next_approval_index = next(
                index
                for index, (event_name, data) in enumerate(resume_events)
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "approval_request"
                and data.get("part", {}).get("approval", {}).get("approval_type") == "shopping_list.create"
            )
            self.assertLess(approval_result_index, result_part_index)
            self.assertLess(approval_result_index, followup_text_index)
            self.assertLess(result_part_index, followup_text_index)
            self.assertLess(result_part_index, next_draft_activity_index)
            self.assertLess(next_draft_activity_index, next_approval_index)
            self.assertLess(
                resume_body.index("接下来我根据已确认的餐食计划生成购物清单草稿。"),
                resume_body.index("生成「购物清单确认表单」"),
            )
            self.assertIn("shopping_list.create", resume_body)
            resume_response = _response_event(resume_body)
            self.assertEqual(resume_response["message"]["status"], "waiting_approval")
            self.assertEqual(resume_response["run"]["status"], "waiting_approval")
            self.assertEqual(len(resume_response["included"]["drafts"]), 2)
            self.assertEqual(len(resume_response["included"]["approvals"]), 2)
            pending_approvals = [
                approval
                for approval in resume_response["included"]["approvals"]
                if approval["status"] == "pending"
            ]
            self.assertEqual([approval["approval_type"] for approval in pending_approvals], ["shopping_list.create"])
            resume_parts = resume_response["message"]["parts"]
            self.assertEqual(
                [part["text"].strip() for part in resume_parts if part.get("type") == "text"],
                [
                    "我先生成餐食计划草稿，确认后再继续购物清单。",
                    "已确认餐食计划。接下来我根据已确认的餐食计划生成购物清单草稿。",
                ],
            )
            self.assertLess(
                next(index for index, part in enumerate(resume_parts) if part.get("text", "").startswith("已确认餐食计划")),
                next(index for index, part in enumerate(resume_parts) if part.get("activity", {}).get("user_message") == "生成「购物清单确认表单」"),
            )
            self.assertLess(
                next(index for index, part in enumerate(resume_parts) if part.get("activity", {}).get("user_message") == "生成「购物清单确认表单」"),
                next(index for index, part in enumerate(resume_parts) if part.get("approval", {}).get("approval_type") == "shopping_list.create"),
            )
            with self.SessionLocal() as db:
                drafts = list(db.scalars(select(AITaskDraft).where(AITaskDraft.source_run_id == "agent_run-approval-resume-next-draft")))
                approvals = list(db.scalars(select(AIApprovalRequest).where(AIApprovalRequest.run_id == "agent_run-approval-resume-next-draft")))
                self.assertEqual(len(drafts), 2)
                self.assertEqual(len(approvals), 2)
                conversation = db.get(AIConversation, response_event["conversation_id"])
                self.assertIsNotNone(conversation)
                assert conversation is not None
                self.assertNotIn("resumeAfterApproval", conversation.context or {})

        def test_ai_workspace_stream_approval_commits_image_job_before_resume_finishes(self) -> None:
            with patch("app.ai.workspace_service.get_chat_provider", return_value=PreviewedRecipeDraftProvider()):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "创建番茄鸡蛋面菜谱", "client_run_id": "agent_run-approval-image-early-commit"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            response_event = _response_event(body)
            approval = response_event["included"]["approvals"][0]

            approval_commit_persisted = threading.Event()
            resume_started = threading.Event()
            continue_resume = threading.Event()
            provider = BlockingApprovalResumeProvider(
                approval_commit_persisted,
                resume_started,
                continue_resume,
            )
            captured: dict[str, str | int] = {}
            errors: list[BaseException] = []
            original_commit = WorkspaceGraphRunner._commit_stream_checkpoint

            def spy_commit(runner: WorkspaceGraphRunner, state: dict, *, run_status: str) -> bool:
                persisted = original_commit(runner, state, run_status=run_status)
                if persisted and state.get("run_id") == response_event["run"]["id"] and run_status == "running":
                    approval_commit_persisted.set()
                return persisted

            def assert_recipe_image_job_committed() -> None:
                with self.SessionLocal() as db:
                    recipe = db.scalar(
                        select(Recipe).where(
                            Recipe.family_id == self.family.id,
                            Recipe.title == "番茄鸡蛋面",
                        )
                    )
                    self.assertIsNotNone(recipe)
                    assert recipe is not None
                    image_job = db.scalar(
                        select(AIImageGenerationJob).where(
                            AIImageGenerationJob.family_id == self.family.id,
                            AIImageGenerationJob.target_entity_type == "recipe",
                            AIImageGenerationJob.target_entity_id == recipe.id,
                        )
                    )
                    self.assertIsNotNone(image_job)
                    assert image_job is not None
                    self.assertEqual(image_job.status, "queued")
                    self.assertEqual(image_job.bind_status, "pending")
                    self.assertEqual(image_job.request_payload["entity_type"], "recipe")
                    approval_row = db.get(AIApprovalRequest, approval["id"])
                    self.assertIsNotNone(approval_row)
                    assert approval_row is not None
                    self.assertEqual(approval_row.status, "approved")

            def consume_decision_stream() -> None:
                try:
                    with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                        with patch.object(WorkspaceGraphRunner, "_commit_stream_checkpoint", spy_commit):
                            with self.client.stream(
                                "POST",
                                f"/api/ai/conversations/{response_event['conversation_id']}/approvals/{approval['id']}/decision/stream",
                                json={
                                    "decision": "approved",
                                    "draft_version": approval["draft_version"],
                                    "values": approval["initial_values"],
                                },
                            ) as response:
                                captured["status_code"] = response.status_code
                                captured["body"] = "".join(response.iter_text())
                except BaseException as exc:
                    errors.append(exc)

            thread = threading.Thread(target=consume_decision_stream)
            thread.start()
            try:
                self.assertTrue(resume_started.wait(timeout=5))
                self.assertTrue(provider.commit_seen_at_resume_start)
                self.assertTrue(approval_commit_persisted.is_set())
                self.assertEqual(captured, {})
                assert_recipe_image_job_committed()
            finally:
                continue_resume.set()
                thread.join(timeout=5)

            self.assertFalse(thread.is_alive())
            self.assertFalse(errors)
            self.assertEqual(captured.get("status_code"), 200)
            self.assertIn("event: response", str(captured.get("body") or ""))
            assert_recipe_image_job_committed()

        def test_ai_workspace_commit_gated_draft_waits_for_approval_before_next_action(self) -> None:
            provider = CommitGatedRecipeProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "创建红烧牛肉菜谱，然后安排到明天晚餐", "client_run_id": "agent_run-commit-gated"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            self.assertEqual(provider.active_calls, 1)
            response_event = _response_event(body)
            self.assertEqual(response_event["message"]["status"], "waiting_approval")
            self.assertEqual(response_event["run"]["status"], "waiting_approval")
            self.assertEqual(len(response_event["included"]["drafts"]), 1)
            self.assertEqual(len(response_event["included"]["approvals"]), 1)
            approval_parts = [part for part in response_event["message"]["parts"] if part.get("type") == "approval_request"]
            self.assertEqual(len(approval_parts), 1)
            self.assertEqual(approval_parts[0]["approval"]["approval_type"], "recipe.create")
            with self.SessionLocal() as db:
                drafts = list(db.scalars(select(AITaskDraft).where(AITaskDraft.source_run_id == "agent_run-commit-gated")))
                approvals = list(db.scalars(select(AIApprovalRequest).where(AIApprovalRequest.run_id == "agent_run-commit-gated")))
                self.assertEqual([draft.draft_type for draft in drafts], ["recipe"])
                self.assertEqual(len(approvals), 1)

        def test_ai_workspace_repeated_read_tool_is_guarded(self) -> None:
            provider = RepeatedReadToolProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "反复检查库存", "client_run_id": "agent_run-repeated-read"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            self.assertIsNotNone(provider.blocked_result)
            self.assertEqual(provider.blocked_result.get("code"), "tool_loop_detected")
            response_event = _response_event(body)
            self.assertEqual(response_event["run"]["status"], "completed")
            with self.SessionLocal() as db:
                run = db.get(AIAgentRun, "agent_run-repeated-read")
                self.assertIsNotNone(run)
                tool_calls = [record for record in (run.tool_calls or []) if record.get("name") == "inventory.read_available_items"]
                self.assertEqual(len(tool_calls), 3)

        def test_ai_workspace_non_stream_chat_returns_progressive_drafts_without_duplicates(self) -> None:
            provider = ProgressiveMultiDraftProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                response = self.client.post(
                    "/api/ai/chat",
                    json={"message": "安排晚餐并列购物清单", "client_run_id": "agent_run-progressive-drafts-non-stream"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(provider.active_calls, 1)
            data = response.json()
            self.assertEqual(data["run"]["status"], "waiting_approval")
            self.assertEqual(len(data["included"]["drafts"]), 1)
            self.assertEqual(len(data["included"]["approvals"]), 1)
            self.assertEqual(len([part for part in data["message"]["parts"] if part["type"] == "approval_request"]), 1)
            with self.SessionLocal() as db:
                drafts = list(db.scalars(select(AITaskDraft).where(AITaskDraft.source_run_id == "agent_run-progressive-drafts-non-stream")))
                approvals = list(db.scalars(select(AIApprovalRequest).where(AIApprovalRequest.run_id == "agent_run-progressive-drafts-non-stream")))
                self.assertEqual(len(drafts), 1)
                self.assertEqual(len(approvals), 1)

        def test_ai_workspace_progressive_draft_publish_dedupes_structured_retry(self) -> None:
            provider = RetrySameDraftProvider()
            with patch("app.ai.workspace_service.get_chat_provider", return_value=provider):
                with self.client.stream(
                    "POST",
                    "/api/ai/chat/stream",
                    json={"message": "买一瓶牛奶", "client_run_id": "agent_run-progressive-draft-retry"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    body = "".join(response.iter_text())

            self.assertEqual(provider.calls, 1)
            response_event = _response_event(body)
            self.assertEqual(len(response_event["included"]["drafts"]), 1)
            self.assertEqual(len(response_event["included"]["approvals"]), 1)
            approval_part_events = [
                data
                for event_name, data in _sse_events(body)
                if event_name == "message_part"
                and data.get("part", {}).get("type") == "approval_request"
            ]
            self.assertEqual(len(approval_part_events), 1)
            with self.SessionLocal() as db:
                drafts = list(db.scalars(select(AITaskDraft).where(AITaskDraft.source_run_id == "agent_run-progressive-draft-retry")))
                approvals = list(db.scalars(select(AIApprovalRequest).where(AIApprovalRequest.run_id == "agent_run-progressive-draft-retry")))
                self.assertEqual(len(drafts), 1)
                self.assertEqual(len(approvals), 1)

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

        def test_approval_followup_empty_response_appends_fallback_and_clears_active_run(self) -> None:
            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-empty-followup",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="确认更新菜谱",
                    response="",
                    context={"activeRunId": "agent_run-empty-followup", "workspace": True},
                    last_run_status="running",
                    created_by=self.user.id,
                )
                run = AIAgentRun(
                    id="agent_run-empty-followup",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    message_id=None,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="recipe_draft",
                    input_summary="确认更新菜谱",
                    context_summary={},
                    output_summary="",
                    status="running",
                    model="rules",
                    input={"prompt": "确认更新菜谱", "subject": {}},
                    output={},
                    tool_calls=[],
                    duration_ms=0,
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-empty-followup",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    content_type="parts",
                    parts=[
                        {
                            "id": "result-empty-followup",
                            "type": "result_card",
                            "card": {
                                "id": "operation-result-empty-followup",
                                "type": "operation_result",
                                "title": "已更新菜谱",
                                "data": {"approvalId": "approval-empty-followup"},
                            },
                        }
                    ],
                    run_id=run.id,
                    status="running",
                    message_metadata={"liveStreaming": True, "livePartIds": ["result-empty-followup"]},
                    created_by=self.user.id,
                )
                db.add_all([conversation, run, message])
                db.commit()

                runner = WorkspaceGraphRunner(AIApplicationService(db, provider=EmptyApprovalFollowupProvider()))
                runner._stream_approval_followup(
                    {
                        "family_id": self.family.id,
                        "user_id": self.user.id,
                        "conversation_id": conversation.id,
                        "run_id": run.id,
                        "message": "确认更新菜谱",
                        "status": "running",
                        "error": None,
                    },
                    {
                        "approval": {
                            "id": "approval-empty-followup",
                            "message_id": message.id,
                            "decision": "approved",
                        },
                        "operation": {
                            "status": "succeeded",
                            "action_summary": "已更新菜谱。",
                        },
                    },
                    terminal_status="completed",
                )
                db.commit()

            with self.SessionLocal() as db:
                message = db.get(AIMessage, "message-empty-followup")
                self.assertIsNotNone(message)
                assert message is not None
                self.assertIn("已更新菜谱。", message.content)
                self.assertIn("你可以继续告诉我需要调整的内容。", message.content)
                self.assertEqual(message.status, "completed")
                self.assertNotIn("liveStreaming", message.message_metadata or {})
                conversation = db.get(AIConversation, "conversation-empty-followup")
                self.assertIsNotNone(conversation)
                assert conversation is not None
                self.assertEqual(conversation.last_run_status, "completed")
                self.assertNotIn("activeRunId", conversation.context or {})

        def test_finalize_terminal_run_clears_stale_live_state_and_empty_text(self) -> None:
            from app.ai.workflows.runner import WorkspaceGraphRunner

            with self.SessionLocal() as db:
                conversation = AIConversation(
                    id="conversation-finalize-stale-active",
                    family_id=self.family.id,
                    mode=AiMode.RECOMMENDATION,
                    prompt="确认更新菜谱",
                    response="",
                    context={"activeRunId": "agent_run-finalize-stale-active", "workspace": True},
                    last_run_status="running",
                    created_by=self.user.id,
                )
                run = AIAgentRun(
                    id="agent_run-finalize-stale-active",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    message_id=None,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="recipe_draft",
                    input_summary="确认更新菜谱",
                    context_summary={},
                    output_summary="",
                    status="running",
                    model="rules",
                    input={"prompt": "确认更新菜谱", "subject": {}},
                    output={},
                    tool_calls=[],
                    duration_ms=0,
                    created_by=self.user.id,
                )
                message = AIMessage(
                    id="message-finalize-stale-active",
                    family_id=self.family.id,
                    conversation_id=conversation.id,
                    role="assistant",
                    content="",
                    content_type="parts",
                    parts=[
                        {
                            "id": "result-finalize-stale-active",
                            "type": "result_card",
                            "card": {"id": "operation-result-finalize-stale-active", "type": "operation_result", "title": "已更新菜谱"},
                        }
                    ],
                    run_id=run.id,
                    status="running",
                    message_metadata={"liveStreaming": True, "livePartIds": ["result-finalize-stale-active"]},
                    created_by=self.user.id,
                )
                db.add_all([conversation, run, message])
                db.flush()

                WorkspaceGraphRunner(AIApplicationService(db, provider=FakeChatProvider()))._finalize(
                    {
                        "family_id": self.family.id,
                        "user_id": self.user.id,
                        "conversation_id": conversation.id,
                        "run_id": run.id,
                        "message": "确认更新菜谱",
                        "status": "completed",
                        "error": None,
                    }
                )

                self.assertEqual(run.status, "completed")
                self.assertEqual(conversation.last_run_status, "completed")
                self.assertEqual(conversation.response, "任务已完成。")
                self.assertNotIn("activeRunId", conversation.context or {})
                self.assertEqual(message.content, "任务已完成。")
                self.assertEqual(message.status, "completed")
                self.assertNotIn("liveStreaming", message.message_metadata or {})

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
