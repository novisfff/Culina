from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
import json
from collections.abc import Iterator
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIOperation,
    AIRunEvent,
    AITaskDraft,
    AIUserApproval,
)
from app.schemas.ai import (
    AIApprovalDecisionRequest,
    AIApprovalDecisionResponse,
    AIApprovalRequestDTO,
    AIChatRequest,
    AIChatResponse,
    AIConversationOut,
    AIMessageDTO,
    AIRunEventDTO,
    AIQueryRequest,
    AIQueryResponse,
    GenerateRecipeDraftRequest,
    GenerateRecipeDraftResponse,
)
from app.ai.kitchen.service import CulinaAgentService, run_ai_query
from app.ai.runtime.schemas import AgentRunRequest
from app.ai.workspace_service import AIApplicationService
from app.services.serializers import serialize_ai_conversation, serialize_ai_message, serialize_ai_run_event

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


@router.delete("/api/ai/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ai_conversation(
    conversation_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> Response:
    _, membership = auth
    conversation = db.scalar(
        select(AIConversation).where(AIConversation.id == conversation_id, AIConversation.family_id == membership.family_id)
    )
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")

    approval_ids = list(
        db.scalars(
            select(AIApprovalRequest.id).where(
                AIApprovalRequest.conversation_id == conversation_id,
                AIApprovalRequest.family_id == membership.family_id,
            )
        )
    )
    draft_ids = list(
        db.scalars(
            select(AITaskDraft.id).where(
                AITaskDraft.conversation_id == conversation_id,
                AITaskDraft.family_id == membership.family_id,
            )
        )
    )
    if approval_ids:
        db.execute(
            delete(AIOperation).where(
                AIOperation.approval_request_id.in_(approval_ids),
                AIOperation.family_id == membership.family_id,
            )
        )
        db.execute(
            delete(AIUserApproval).where(
                AIUserApproval.approval_request_id.in_(approval_ids),
                AIUserApproval.family_id == membership.family_id,
            )
        )
        db.execute(
            delete(AIApprovalRequest).where(
                AIApprovalRequest.id.in_(approval_ids),
                AIApprovalRequest.family_id == membership.family_id,
            )
        )
    if draft_ids:
        db.execute(delete(AITaskDraft).where(AITaskDraft.id.in_(draft_ids), AITaskDraft.family_id == membership.family_id))
    db.execute(
        delete(AIRunEvent).where(
            AIRunEvent.conversation_id == conversation_id,
            AIRunEvent.family_id == membership.family_id,
        )
    )
    db.execute(
        delete(AIMessage).where(
            AIMessage.conversation_id == conversation_id,
            AIMessage.family_id == membership.family_id,
        )
    )
    db.execute(
        update(AIAgentRun)
        .where(AIAgentRun.conversation_id == conversation_id, AIAgentRun.family_id == membership.family_id)
        .values(conversation_id=None)
    )
    db.delete(conversation)
    commit_session(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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


@router.post("/api/ai/chat", response_model=AIChatResponse)
def chat_ai(
    payload: AIChatRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        response = AIApplicationService(db).chat(
            family_id=membership.family_id,
            user_id=user.id,
            message=payload.message,
            conversation_id=payload.conversation_id,
            client_message_id=payload.client_message_id,
            client_run_id=payload.client_run_id,
            quick_task=payload.quick_task,
            subject=payload.subject.model_dump() if payload.subject else {},
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    commit_session(db)
    return response


@router.post("/api/ai/chat/stream")
def stream_chat_ai(
    payload: AIChatRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    user, membership = auth

    def encode(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(jsonable_encoder(data), ensure_ascii=False)}\n\n"

    def stream_text_chunks(message: dict, *, size: int = 12) -> Iterator[str]:
        for part in message.get("parts", []):
            if not isinstance(part, dict) or part.get("type") != "text":
                continue
            text = part.get("text")
            if not isinstance(text, str) or not text:
                continue
            for index in range(0, len(text), size):
                chunk = text[index : index + size]
                yield encode(
                    "message_delta",
                    {
                        "message_id": message.get("id"),
                        "conversation_id": message.get("conversation_id"),
                        "run_id": message.get("run_id"),
                        "part_id": part.get("id"),
                        "delta": chunk,
                    },
                )

    def generate():
        yield encode(
            "progress",
            {
                "id": f"{payload.client_run_id or 'pending'}-intent",
                "run_id": payload.client_run_id or "pending",
                "type": "intent",
                "internal_code": "detect_intent",
                "user_message": "正在理解你的需求",
                "status": "running",
            },
        )
        yield encode(
            "progress",
            {
                "id": f"{payload.client_run_id or 'pending'}-context",
                "run_id": payload.client_run_id or "pending",
                "type": "context",
                "internal_code": "load_context",
                "user_message": "正在查看你的厨房上下文",
                "status": "running",
            },
        )
        try:
            service = AIApplicationService(db)
            stream = service.stream_fallback_chat(
                family_id=membership.family_id,
                user_id=user.id,
                message=payload.message,
                conversation_id=payload.conversation_id,
                client_message_id=payload.client_message_id,
                client_run_id=payload.client_run_id,
                quick_task=payload.quick_task,
                subject=payload.subject.model_dump() if payload.subject else {},
            )
            if stream is not None:
                for event, data in stream:
                    if event == "response":
                        commit_session(db)
                    yield encode(event, data)
                return
            response = service.chat(
                family_id=membership.family_id,
                user_id=user.id,
                message=payload.message,
                conversation_id=payload.conversation_id,
                client_message_id=payload.client_message_id,
                client_run_id=payload.client_run_id,
                quick_task=payload.quick_task,
                subject=payload.subject.model_dump() if payload.subject else {},
            )
            commit_session(db)
        except ValueError as exc:
            yield encode("error", {"detail": str(exc), "status": 400})
            return
        except LookupError as exc:
            yield encode("error", {"detail": str(exc), "status": 404})
            return
        for event in response["events"]:
            yield encode("progress", event)
        yield from stream_text_chunks(response["message"])
        yield encode("response", response)

    return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/api/ai/conversations/{conversation_id}/messages", response_model=list[AIMessageDTO])
def list_ai_messages(
    conversation_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    conversation = db.scalar(
        select(AIConversation).where(AIConversation.id == conversation_id, AIConversation.family_id == membership.family_id)
    )
    if conversation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    messages = list(
        db.scalars(
            select(AIMessage)
            .where(AIMessage.conversation_id == conversation_id, AIMessage.family_id == membership.family_id)
            .order_by(AIMessage.created_at.asc())
        )
    )
    return [serialize_ai_message(item) for item in messages]


@router.get("/api/ai/runs/{run_id}/events", response_model=list[AIRunEventDTO])
def list_ai_run_events(
    run_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    events = list(
        db.scalars(
            select(AIRunEvent)
            .where(AIRunEvent.run_id == run_id, AIRunEvent.family_id == membership.family_id)
            .order_by(AIRunEvent.created_at.asc())
        )
    )
    return [serialize_ai_run_event(item) for item in events]


@router.get("/api/ai/runs/{run_id}/events/stream")
def stream_ai_run_events(
    run_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    _, membership = auth

    def generate():
        events = list(
            db.scalars(
                select(AIRunEvent)
                .where(AIRunEvent.run_id == run_id, AIRunEvent.family_id == membership.family_id)
                .order_by(AIRunEvent.created_at.asc())
            )
        )
        for item in events:
            yield f"event: progress\ndata: {json.dumps(jsonable_encoder(serialize_ai_run_event(item)), ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/api/ai/runs/{run_id}/cancel")
def cancel_ai_run(
    run_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        result = AIApplicationService(db).cancel_run(family_id=membership.family_id, user_id=user.id, run_id=run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    commit_session(db)
    return result


@router.post("/api/ai/runs/{run_id}/retry", response_model=AIChatResponse)
def retry_ai_run(
    run_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        result = AIApplicationService(db).retry_run(family_id=membership.family_id, user_id=user.id, run_id=run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    commit_session(db)
    return result


@router.post("/api/ai/messages/{message_id}/parts/{part_id}/regenerate", response_model=AIChatResponse)
def regenerate_ai_message_part(
    message_id: str,
    part_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        result = AIApplicationService(db).regenerate_part(
            family_id=membership.family_id,
            user_id=user.id,
            message_id=message_id,
            part_id=part_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    commit_session(db)
    return result


@router.get("/api/ai/conversations/{conversation_id}/approvals/pending", response_model=list[AIApprovalRequestDTO])
def list_pending_ai_approvals(
    conversation_id: str,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> list[dict]:
    _, membership = auth
    try:
        return AIApplicationService(db).pending_approvals(
            family_id=membership.family_id,
            conversation_id=conversation_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post(
    "/api/ai/conversations/{conversation_id}/approvals/{approval_id}/decision",
    response_model=AIApprovalDecisionResponse,
)
def decide_ai_approval(
    conversation_id: str,
    approval_id: str,
    payload: AIApprovalDecisionRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        result = AIApplicationService(db).decide_approval(
            family_id=membership.family_id,
            user_id=user.id,
            conversation_id=conversation_id,
            approval_id=approval_id,
            decision=payload.decision,
            draft_version=payload.draft_version,
            values=payload.values,
            comment=payload.comment,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    commit_session(db)
    return result


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
