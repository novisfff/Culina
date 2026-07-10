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
