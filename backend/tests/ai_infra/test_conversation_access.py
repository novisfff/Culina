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
