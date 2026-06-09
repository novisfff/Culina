from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
import json
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
    AIRegistryResponse,
    AIRunEventDTO,
    GenerateRecipeDraftRequest,
    GenerateRecipeDraftResponse,
)
from app.ai.skills import build_workspace_skill_registry
from app.ai.tools import build_workspace_tool_registry
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.services.serializers import serialize_ai_conversation, serialize_ai_message, serialize_ai_run_event

router = APIRouter(tags=["ai"])
logger = logging.getLogger(__name__)


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


@router.get("/api/ai/registry", response_model=AIRegistryResponse)
def get_ai_registry(auth: tuple = Depends(get_current_auth)) -> dict:
    # Auth dependency scopes this read-only diagnostics view to signed-in family members.
    _, _membership = auth
    skill_registry = build_workspace_skill_registry()
    tool_registry = build_workspace_tool_registry()
    return {
        "skills": [
            {
                "key": manifest.key,
                "name": manifest.name,
                "description": manifest.description,
                "runner": manifest.runner,
                "examples": manifest.examples,
                "context_policy": manifest.context_policy,
                "tools": manifest.tools,
                "output_types": manifest.output_types,
                "draft_types": manifest.draft_types,
                "approval_policy": manifest.approval_policy,
                "can_continue_from": manifest.can_continue_from,
                "intent": manifest.intent,
                "agent_key": manifest.agent_key,
            }
            for manifest in skill_registry.list_manifests()
        ],
        "tools": [
            {
                "name": tool.name,
                "display_name": tool.display_name,
                "description": tool.description,
                "permission": tool.permission,
                "side_effect": tool.side_effect,
                "requires_confirmation": tool.requires_confirmation,
                "input_schema": tool.input_schema,
                "output_schema": tool.output_schema,
            }
            for tool in tool_registry.list()
        ],
    }


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
    SQLAlchemyCheckpointSaver(db).delete_thread(conversation_id)
    db.delete(conversation)
    commit_session(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
        logger.warning(
            "AI chat request rejected status=400 family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s error=%s",
            membership.family_id,
            user.id,
            payload.conversation_id,
            payload.client_message_id,
            payload.client_run_id,
            len(payload.message or ""),
            exc,
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except LookupError as exc:
        logger.warning(
            "AI chat request rejected status=404 family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s error=%s",
            membership.family_id,
            user.id,
            payload.conversation_id,
            payload.client_message_id,
            payload.client_run_id,
            len(payload.message or ""),
            exc,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception:
        logger.exception(
            "AI chat request failed family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s",
            membership.family_id,
            user.id,
            payload.conversation_id,
            payload.client_message_id,
            payload.client_run_id,
            len(payload.message or ""),
        )
        raise
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

    def generate():
        try:
            service = AIApplicationService(db)
            for event, data in service.stream_chat(
                family_id=membership.family_id,
                user_id=user.id,
                message=payload.message,
                conversation_id=payload.conversation_id,
                client_message_id=payload.client_message_id,
                client_run_id=payload.client_run_id,
                quick_task=payload.quick_task,
                subject=payload.subject.model_dump() if payload.subject else {},
            ):
                if event == "response":
                    commit_session(db)
                yield encode(event, data)
        except ValueError as exc:
            logger.warning(
                "AI stream chat request rejected status=400 family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s error=%s",
                membership.family_id,
                user.id,
                payload.conversation_id,
                payload.client_message_id,
                payload.client_run_id,
                len(payload.message or ""),
                exc,
            )
            yield encode("error", {"detail": str(exc), "status": 400})
            return
        except LookupError as exc:
            logger.warning(
                "AI stream chat request rejected status=404 family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s error=%s",
                membership.family_id,
                user.id,
                payload.conversation_id,
                payload.client_message_id,
                payload.client_run_id,
                len(payload.message or ""),
                exc,
            )
            yield encode("error", {"detail": str(exc), "status": 404})
            return
        except Exception:
            logger.exception(
                "AI stream chat request failed family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s",
                membership.family_id,
                user.id,
                payload.conversation_id,
                payload.client_message_id,
                payload.client_run_id,
                len(payload.message or ""),
            )
            yield encode("error", {"detail": "AI 服务暂时不可用，请稍后重试。", "status": 500})
            return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
    result = AIApplicationService(db).generate_recipe_draft(
        family_id=membership.family_id,
        user_id=user.id,
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
        generate_image=payload.generate_image,
    )
    commit_session(db)
    return result
