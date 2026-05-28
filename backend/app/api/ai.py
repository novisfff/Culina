from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import AIConversation
from app.schemas.ai import AIConversationOut, AIQueryRequest, AIQueryResponse, GenerateRecipeDraftRequest, GenerateRecipeDraftResponse
from app.ai.kitchen.service import CulinaAgentService, run_ai_query
from app.ai.runtime.schemas import AgentRunRequest
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
    commit_session(db)
    return {"conversation": conversation, "recommendation": recommendation}


@router.post("/api/ai/recipes/draft", response_model=GenerateRecipeDraftResponse)
def generate_recipe_draft(
    payload: GenerateRecipeDraftRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    has_minimum_input = bool(
        payload.title.strip()
        or payload.prompt.strip()
        or payload.ingredient_ids
        or any(item.strip() for item in payload.extra_ingredients)
    )
    if not has_minimum_input:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请先填写菜名、添加至少一个食材，或写一句补充说明。",
        )
    user, membership = auth
    result = CulinaAgentService(db).run(
        AgentRunRequest(
            family_id=membership.family_id,
            user_id=user.id,
            feature_key="aiRecipeDraft",
            prompt=payload.prompt,
            subject={
                "title": payload.title,
                "ingredientIds": payload.ingredient_ids,
                "extraIngredients": payload.extra_ingredients,
                "servings": payload.servings,
                "prepMinutes": payload.prep_minutes,
                "difficulty": payload.difficulty.value if payload.difficulty else None,
                "sceneTags": payload.scene_tags,
            },
            response_format="recipe_draft",
            persist_conversation=False,
        )
    )
    commit_session(db)
    return {
        "draft": result.data["recipeDraft"],
        "agent_run_id": result.run_id,
        "status": result.status,
        "error": result.error,
        "image_render_payload": result.data.get("imageRenderPayload") if payload.generate_image and result.status != "failed" else None,
    }
