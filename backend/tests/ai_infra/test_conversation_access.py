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
