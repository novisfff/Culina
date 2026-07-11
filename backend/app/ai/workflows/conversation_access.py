from __future__ import annotations

from typing import Literal

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.enums import AIConversationVisibility
from app.models.domain import AIAgentRun, AIConversation, AIMessage

ConversationCapability = Literal["view", "contribute", "manage"]


def accessible_ai_conversation_clause(user_id: str):
    return and_(
        AIConversation.owner_user_id.is_not(None),
        or_(
            AIConversation.owner_user_id == user_id,
            AIConversation.visibility == AIConversationVisibility.FAMILY,
        ),
    )


def require_ai_conversation_access(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    conversation_id: str,
    capability: ConversationCapability,
    for_update: bool = False,
) -> AIConversation:
    query = select(AIConversation).where(
        AIConversation.id == conversation_id,
        AIConversation.family_id == family_id,
        AIConversation.owner_user_id.is_not(None),
    )
    if for_update:
        query = query.with_for_update()
    conversation = db.scalar(query)
    if conversation is None:
        raise LookupError("会话不存在")
    is_owner = conversation.owner_user_id == user_id
    is_family_public = conversation.visibility == AIConversationVisibility.FAMILY
    allowed = is_owner if capability == "manage" else is_owner or is_family_public
    if not allowed:
        raise LookupError("会话不存在")
    return conversation


def require_ai_message_access(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    message_id: str,
    capability: ConversationCapability,
) -> AIMessage:
    message = db.scalar(select(AIMessage).where(AIMessage.id == message_id, AIMessage.family_id == family_id))
    if message is None:
        raise LookupError("消息不存在")
    require_ai_conversation_access(
        db,
        family_id=family_id,
        user_id=user_id,
        conversation_id=message.conversation_id,
        capability=capability,
    )
    return message


def require_ai_run_access(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    run_id: str,
    capability: ConversationCapability,
) -> AIAgentRun:
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
    if run is None:
        raise LookupError("运行任务不存在")
    if run.conversation_id is not None:
        require_ai_conversation_access(
            db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=run.conversation_id,
            capability=capability,
        )
    return run
