from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.models.domain import AIConversation
from app.schemas.domain import AIConversationOut, AIQueryRequest, AIQueryResponse
from app.services.ai import run_ai_query
from app.services.serializers import serialize_ai_conversation

router = APIRouter(tags=["ai"])


@router.get("/api/ai/conversations", response_model=list[AIConversationOut])
def list_ai_conversations(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    conversations = list(
        db.scalars(
            select(AIConversation)
            .where(AIConversation.family_id == membership.family_id)
            .order_by(AIConversation.created_at.desc())
            .limit(20)
        )
    )
    return [serialize_ai_conversation(item) for item in conversations]


@router.post("/api/ai/query", response_model=AIQueryResponse)
def query_ai(
    payload: AIQueryRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    conversation, recommendation = run_ai_query(
        db,
        family_id=membership.family_id,
        user_id=user.id,
        mode=payload.mode,
        prompt=payload.prompt,
        food_id=payload.food_id,
        ingredient_ids=payload.ingredient_ids,
    )
    db.commit()
    return {"conversation": conversation, "recommendation": recommendation}
