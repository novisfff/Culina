from ._support import *


class AIConversationAccessTestCase(AIAgentInfraTestCase):
    def test_conversation_persists_explicit_owner_and_private_visibility(self) -> None:
        with self.SessionLocal() as db:
            conversation = AIConversation(
                id="conversation-owned",
                family_id=self.family.id,
                owner_user_id=self.user.id,
                visibility=AIConversationVisibility.PRIVATE,
                mode=AiMode.RECOMMENDATION,
                prompt="我的问题",
                response="",
                context={"workspace": True},
                title="我的问题",
                summary="",
                status="active",
                created_by=self.user.id,
            )
            db.add(conversation)
            db.commit()
            stored = db.get(AIConversation, conversation.id)
            assert stored is not None
            self.assertEqual(stored.owner_user_id, self.user.id)
            self.assertEqual(stored.visibility, AIConversationVisibility.PRIVATE)

    def _conversation(
        self,
        conversation_id: str,
        owner_user_id: str,
        visibility: AIConversationVisibility,
        last_message_at: datetime,
    ) -> AIConversation:
        return AIConversation(
            id=conversation_id,
            family_id=self.family.id,
            owner_user_id=owner_user_id,
            visibility=visibility,
            mode=AiMode.RECOMMENDATION,
            prompt=conversation_id,
            response="",
            context={"workspace": True},
            title=conversation_id,
            summary="",
            status="active",
            last_message_at=last_message_at,
            last_run_status="completed",
            created_by=owner_user_id,
        )

    def _persist_conversation(
        self,
        conversation_id: str,
        owner_user_id: str,
        visibility: AIConversationVisibility,
    ) -> AIConversation:
        with self.SessionLocal() as db:
            conversation = self._conversation(
                conversation_id,
                owner_user_id,
                visibility,
                datetime(2026, 7, 11, 12, 0, 0),
            )
            db.add(conversation)
            db.commit()
            db.refresh(conversation)
            return conversation

    def test_history_contains_owned_private_and_family_public_only(self) -> None:
        other_user, other_membership = self.create_family_member()
        with self.SessionLocal() as db:
            db.add_all([
                self._conversation("mine-private", self.user.id, AIConversationVisibility.PRIVATE, datetime(2026, 7, 11, 10, 0, 0)),
                self._conversation("other-private", other_user.id, AIConversationVisibility.PRIVATE, datetime(2026, 7, 11, 11, 0, 0)),
                self._conversation("other-public", other_user.id, AIConversationVisibility.FAMILY, datetime(2026, 7, 11, 12, 0, 0)),
            ])
            db.commit()
        response = self.client.get("/api/ai/conversations")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([item["id"] for item in response.json()], ["other-public", "mine-private"])
        self.assertTrue(response.json()[1]["is_owner"])
        self.assertEqual(response.json()[0]["owner_display_name"], other_user.display_name)
    def test_only_owner_can_publish_unpublish_and_delete(self) -> None:
        other_user, other_membership = self.create_family_member()
        conversation = self._persist_conversation("conversation-manage", self.user.id, AIConversationVisibility.PRIVATE)
        published = self.client.patch(
            f"/api/ai/conversations/{conversation.id}/visibility",
            json={"visibility": "family"},
        )
        self.assertEqual(published.status_code, 200, published.text)
        self.assertEqual(published.json()["visibility"], "family")
        self.authenticate_as(other_user.id, other_membership.id)
        self.assertEqual(
            self.client.patch(f"/api/ai/conversations/{conversation.id}/visibility", json={"visibility": "private"}).status_code,
            404,
        )
        self.assertEqual(self.client.delete(f"/api/ai/conversations/{conversation.id}").status_code, 404)

    def test_owner_cannot_publish_or_delete_while_run_is_active(self) -> None:
        conversation = self._persist_conversation(
            "conversation-active-manage",
            self.user.id,
            AIConversationVisibility.PRIVATE,
        )
        with self.SessionLocal() as db:
            db.add(
                AIAgentRun(
                    id="run-active-manage",
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
            )
            db.commit()

        visibility_response = self.client.patch(
            f"/api/ai/conversations/{conversation.id}/visibility",
            json={"visibility": "family"},
        )
        self.assertEqual(visibility_response.status_code, 409, visibility_response.text)
        delete_response = self.client.delete(f"/api/ai/conversations/{conversation.id}")
        self.assertEqual(delete_response.status_code, 409, delete_response.text)

    def test_delete_scrubs_run_observability_and_unbinds_message_attachments(self) -> None:
        conversation = self._persist_conversation(
            "conversation-delete-sensitive-data",
            self.user.id,
            AIConversationVisibility.PRIVATE,
        )
        with self.SessionLocal() as db:
            message = AIMessage(
                id="message-delete-sensitive-data",
                family_id=self.family.id,
                conversation_id=conversation.id,
                role="user",
                content="我对花生过敏",
                content_type="parts",
                parts=[
                    {"type": "text", "text": "我对花生过敏"},
                    {"type": "image", "image": {"media_id": "media-delete-sensitive-data"}},
                ],
                status="completed",
                created_by=self.user.id,
            )
            run = AIAgentRun(
                id="run-delete-sensitive-data",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id=message.id,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="general_chat",
                input_summary="我对花生过敏",
                context_summary={
                    "runMetrics": {"toolCallCount": 2},
                    "pendingHumanInput": {"question": "还会对什么过敏？"},
                },
                output_summary="已记录你的过敏信息",
                error_code="provider_timeout",
                status="failed",
                model="fake-model",
                input={"prompt": "我对花生过敏", "conversation": [{"content": "家庭私密历史"}]},
                output={"text": "已记录你的过敏信息"},
                tool_calls=[{"tool": "food.read", "input": {"name": "花生"}}],
                error="包含用户原始输入的 provider 错误",
                duration_ms=321,
                created_by=self.user.id,
            )
            event = AIRunEvent(
                id="event-delete-sensitive-data",
                family_id=self.family.id,
                run_id=run.id,
                conversation_id=conversation.id,
                type="progress",
                internal_code="working",
                user_message="正在处理花生过敏信息",
                status="completed",
                payload={"prompt": "我对花生过敏"},
            )
            trace = AIRunTraceSpan(
                id="trace-delete-sensitive-data",
                family_id=self.family.id,
                run_id=run.id,
                conversation_id=conversation.id,
                trace_id="trace-delete-sensitive-data",
                span_id="span-delete-sensitive-data",
                parent_span_id=None,
                span_type="graph",
                name="workspace_graph",
                status="failed",
                duration_ms=123,
                input_summary={"prompt": "我对花生过敏"},
                output_summary={"text": "已记录你的过敏信息"},
                error_code="provider_timeout",
                error_message="包含用户输入的错误",
                exception_type="RuntimeError",
                payload={"subject": {"notes": "家庭私密信息"}},
                created_by=self.user.id,
            )
            exchange = AIRunLLMExchange(
                id="exchange-delete-sensitive-data",
                family_id=self.family.id,
                run_id=run.id,
                conversation_id=conversation.id,
                trace_id=trace.trace_id,
                span_id=trace.span_id,
                provider_round=1,
                attempt_index=1,
                mode="toolcall",
                model="fake-model",
                request_messages=[{"role": "user", "content": "我对花生过敏"}],
                request_tools=[{"name": "food.read"}],
                request_options={"subject": {"notes": "家庭私密信息"}},
                request_original_digest="request-original-digest",
                request_original_bytes=100,
                request_digest="request-digest",
                request_bytes=80,
                request_truncated=False,
                response_message={"role": "assistant", "content": "已记录你的过敏信息"},
                response_text="已记录你的过敏信息",
                response_tool_calls=[{"name": "food.read", "arguments": {"name": "花生"}}],
                stream_chunks=[{"text": "已记录"}],
                response_original_digest="response-original-digest",
                response_original_bytes=60,
                response_digest="response-digest",
                response_bytes=50,
                response_truncated=False,
                input_tokens=20,
                output_tokens=10,
                total_tokens=30,
                cached_tokens=5,
                estimated_cost_usd=0.01,
                token_usage={"prompt_tokens": 20, "completion_tokens": 10},
                status="failed",
                error_code="provider_timeout",
                error_message="包含用户输入的错误",
                duration_ms=234,
                created_by=self.user.id,
            )
            attachment = MediaAsset(
                id="media-delete-sensitive-data",
                family_id=self.family.id,
                name="allergy.jpg",
                url="/media/family-test/allergy.jpg",
                file_path="family-test/allergy.jpg",
                source=MediaSource.UPLOAD,
                alt="过敏检测结果",
                entity_type="ai_message",
                entity_id=message.id,
                created_by=self.user.id,
            )
            transferred = MediaAsset(
                id="media-delete-transferred",
                family_id=self.family.id,
                name="recipe.jpg",
                url="/media/family-test/recipe.jpg",
                file_path="family-test/recipe.jpg",
                source=MediaSource.UPLOAD,
                alt="正式菜谱图片",
                entity_type="recipe",
                entity_id="recipe-kept-after-conversation-delete",
                created_by=self.user.id,
            )
            db.add_all([message, run, event, trace, exchange, attachment, transferred])
            db.commit()

        response = self.client.delete(f"/api/ai/conversations/{conversation.id}")
        self.assertEqual(response.status_code, 204, response.text)

        with self.SessionLocal() as db:
            self.assertIsNone(db.get(AIConversation, conversation.id))
            self.assertIsNone(db.get(AIMessage, "message-delete-sensitive-data"))
            self.assertIsNone(db.get(AIRunEvent, "event-delete-sensitive-data"))

            run = db.get(AIAgentRun, "run-delete-sensitive-data")
            assert run is not None
            self.assertIsNone(run.conversation_id)
            self.assertIsNone(run.message_id)
            self.assertEqual(run.input_summary, "")
            self.assertEqual(run.context_summary, {"runMetrics": {"toolCallCount": 2}})
            self.assertEqual(run.output_summary, "")
            self.assertEqual(run.input, {})
            self.assertEqual(run.output, {})
            self.assertEqual(run.tool_calls, [])
            self.assertIsNone(run.error)
            self.assertEqual(run.error_code, "provider_timeout")
            self.assertEqual(run.status, "failed")
            self.assertEqual(run.model, "fake-model")
            self.assertEqual(run.duration_ms, 321)

            trace = db.get(AIRunTraceSpan, "trace-delete-sensitive-data")
            assert trace is not None
            self.assertIsNone(trace.conversation_id)
            self.assertEqual(trace.input_summary, {})
            self.assertEqual(trace.output_summary, {})
            self.assertIsNone(trace.error_message)
            self.assertIsNone(trace.exception_type)
            self.assertEqual(trace.payload, {})
            self.assertEqual(trace.error_code, "provider_timeout")
            self.assertEqual(trace.duration_ms, 123)

            exchange = db.get(AIRunLLMExchange, "exchange-delete-sensitive-data")
            assert exchange is not None
            self.assertIsNone(exchange.conversation_id)
            self.assertEqual(exchange.request_messages, [])
            self.assertEqual(exchange.request_tools, [])
            self.assertEqual(exchange.request_options, {})
            self.assertEqual(exchange.request_original_digest, "")
            self.assertEqual(exchange.request_digest, "")
            self.assertEqual(exchange.response_message, {})
            self.assertIsNone(exchange.response_text)
            self.assertEqual(exchange.response_tool_calls, [])
            self.assertEqual(exchange.stream_chunks, [])
            self.assertEqual(exchange.response_original_digest, "")
            self.assertEqual(exchange.response_digest, "")
            self.assertIsNone(exchange.error_message)
            self.assertEqual(exchange.total_tokens, 30)
            self.assertEqual(exchange.estimated_cost_usd, 0.01)
            self.assertEqual(exchange.token_usage, {"prompt_tokens": 20, "completion_tokens": 10})

            attachment = db.get(MediaAsset, "media-delete-sensitive-data")
            assert attachment is not None
            self.assertIsNone(attachment.entity_type)
            self.assertIsNone(attachment.entity_id)
            transferred = db.get(MediaAsset, "media-delete-transferred")
            assert transferred is not None
            self.assertEqual(transferred.entity_type, "recipe")
            self.assertEqual(transferred.entity_id, "recipe-kept-after-conversation-delete")

    def _seed_private_conversation_graph(self, *, owner_user_id: str) -> SimpleNamespace:
        with self.SessionLocal() as db:
            conversation = self._conversation(
                "conversation-private-graph",
                owner_user_id,
                AIConversationVisibility.PRIVATE,
                datetime(2026, 7, 11, 12, 0, 0),
            )
            run = AIAgentRun(
                id="run-private-graph",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id="message-private-graph",
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="general_chat",
                input_summary="私有问题",
                context_summary={},
                output_summary="",
                status="running",
                model="fake-model",
                input={"prompt": "私有问题"},
                output={},
                tool_calls=[],
                created_by=owner_user_id,
            )
            message = AIMessage(
                id="message-private-graph",
                family_id=self.family.id,
                conversation_id=conversation.id,
                role="assistant",
                content="私有回复",
                content_type="parts",
                parts=[{"id": "part-private-graph", "type": "text", "text": "私有回复"}],
                run_id=run.id,
                status="running",
                created_by=owner_user_id,
            )
            draft = AITaskDraft(
                id="draft-private-graph",
                family_id=self.family.id,
                conversation_id=conversation.id,
                source_run_id=run.id,
                message_id=message.id,
                draft_type="recipe",
                payload={},
                preview_summary="私有草稿",
                status="pending",
                version=1,
                schema_version="recipe.v1",
                validation_errors=[],
                ai_metadata={},
                idempotency_key="draft-private-graph",
                created_by=owner_user_id,
            )
            approval = AIApprovalRequest(
                id="approval-private-graph",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id=message.id,
                run_id=run.id,
                draft_id=draft.id,
                draft_version=1,
                draft_schema_version="recipe.v1",
                approval_type="recipe.create",
                status="pending",
                request_payload={},
                field_schema=[],
                initial_values={},
                submitted_values={},
                created_by=owner_user_id,
            )
            db.add_all([conversation, run, message, draft, approval])
            db.commit()
            return SimpleNamespace(
                conversation_id=conversation.id,
                run_id=run.id,
                message_id=message.id,
                part_id="part-private-graph",
                approval_id=approval.id,
            )

    def test_private_child_resource_endpoints_return_not_found_to_other_member(self) -> None:
        other_user, other_membership = self.create_family_member()
        seeded = self._seed_private_conversation_graph(owner_user_id=self.user.id)
        self.authenticate_as(other_user.id, other_membership.id)
        requests = [
            ("GET", f"/api/ai/conversations/{seeded.conversation_id}/messages", None),
            ("GET", f"/api/ai/conversations/{seeded.conversation_id}/approvals/pending", None),
            ("GET", f"/api/ai/runs/{seeded.run_id}/events", None),
            ("POST", f"/api/ai/runs/{seeded.run_id}/cancel", None),
            ("POST", f"/api/ai/runs/{seeded.run_id}/retry", None),
            ("POST", f"/api/ai/messages/{seeded.message_id}/parts/{seeded.part_id}/regenerate", None),
        ]
        for method, path, payload in requests:
            response = self.client.request(method, path, json=payload)
            self.assertEqual(response.status_code, 404, f"{method} {path}: {response.text}")

    def test_detached_run_endpoints_and_idempotent_lookup_return_not_found_to_other_member(self) -> None:
        run_owner, _ = self.create_family_member(user_id="user-detached-run-owner")
        with self.SessionLocal() as db:
            db.add(
                AIAgentRun(
                    id="run-detached-private",
                    family_id=self.family.id,
                    conversation_id=None,
                    message_id=None,
                    agent_key="workspace_orchestrator",
                    feature_key="ai_workspace_chat",
                    intent="general_chat",
                    input_summary="原用户的私有消息",
                    context_summary={},
                    output_summary="",
                    status="failed",
                    model="fake-model",
                    input={"prompt": "原用户的私有消息", "subject": {}},
                    output={},
                    tool_calls=[],
                    duration_ms=0,
                    created_by=run_owner.id,
                )
            )
            db.commit()

        requests = [
            ("GET", "/api/ai/runs/run-detached-private/events", None),
            ("POST", "/api/ai/runs/run-detached-private/cancel", None),
            ("POST", "/api/ai/runs/run-detached-private/retry", None),
            ("GET", "/api/ai/runs/run-detached-private/trace", None),
            ("GET", "/api/ai/runs/run-detached-private/trace/tree", None),
            ("GET", "/api/ai/runs/run-detached-private/llm-exchanges", None),
            (
                "POST",
                "/api/ai/chat",
                {"message": "复用其他成员的运行标识", "client_run_id": "run-detached-private"},
            ),
        ]
        for method, path, payload in requests:
            response = self.client.request(method, path, json=payload)
            self.assertEqual(response.status_code, 404, f"{method} {path}: {response.text}")

    def test_published_conversation_accepts_family_member_contribution(self) -> None:
        other_user, other_membership = self.create_family_member()
        seeded = self._seed_private_conversation_graph(owner_user_id=self.user.id)
        with self.SessionLocal() as db:
            conversation = db.get(AIConversation, seeded.conversation_id)
            assert conversation is not None
            conversation.visibility = AIConversationVisibility.FAMILY
            db.commit()
        self.authenticate_as(other_user.id, other_membership.id)
        messages = self.client.get(f"/api/ai/conversations/{seeded.conversation_id}/messages")
        self.assertEqual(messages.status_code, 200, messages.text)
        approvals = self.client.get(f"/api/ai/conversations/{seeded.conversation_id}/approvals/pending")
        self.assertEqual(approvals.status_code, 200, approvals.text)

    def test_published_conversation_rejects_collaborator_message_while_waiting_approval(self) -> None:
        other_user, other_membership = self.create_family_member()
        conversation = self._persist_conversation(
            "conversation-waiting-approval-collab",
            self.user.id,
            AIConversationVisibility.FAMILY,
        )
        with self.SessionLocal() as db:
            run = AIAgentRun(
                id="run-waiting-approval-collab",
                family_id=self.family.id,
                conversation_id=conversation.id,
                message_id=None,
                agent_key="workspace_orchestrator",
                feature_key="ai_workspace_chat",
                intent="general_chat",
                input_summary="等待审批",
                context_summary={},
                output_summary="",
                status="waiting_approval",
                model="fake-model",
                input={"prompt": "等待审批", "subject": {}},
                output={},
                tool_calls=[],
                duration_ms=0,
                created_by=self.user.id,
            )
            db.add(run)
            db.commit()

        self.authenticate_as(other_user.id, other_membership.id)
        response = self.client.post(
            "/api/ai/chat",
            json={"message": "协作者新消息", "conversation_id": conversation.id},
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("当前会话已有 AI 任务", response.text)

        with self.SessionLocal() as db:
            statuses = list(
                db.scalars(
                    select(AIAgentRun.status).where(
                        AIAgentRun.conversation_id == conversation.id,
                        AIAgentRun.family_id == self.family.id,
                    )
                )
            )
        self.assertEqual(statuses, ["waiting_approval"])
