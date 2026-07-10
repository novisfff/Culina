from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
import json
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth, require_owner
from app.core.config import get_settings
from app.db.session import get_db
from app.db.transactions import commit_session
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIRunLLMExchange,
    AIOperation,
    AIRunEvent,
    AIRunTraceSpan,
    AITaskDraft,
    AIUserApproval,
    User,
)
from app.schemas.ai import (
    AIApprovalDecisionRequest,
    AIApprovalDecisionResponse,
    AIApprovalRequestDTO,
    AIChatRequest,
    AIChatResponse,
    AIConversationOut,
    AIMessageDTO,
    AIInventoryQuickDraftRequest,
    AIHumanInputResponseRequest,
    AIQualityMetricsResponse,
    AIRecommendationSelectionRequest,
    AIRegistryResponse,
    AIRunLLMExchangeDTO,
    AIRunLLMExchangeResponse,
    AIStatusResponse,
    AIRunEventDTO,
    AIRunTraceResponse,
    AIRunTraceTreeResponse,
    GenerateRecipeDraftRequest,
    GenerateRecipeDraftResponse,
)
from app.ai.errors import AIConflictError
from app.ai.skills import build_workspace_skill_registry
from app.ai.tools import build_workspace_tool_registry
from app.ai.workspace_service import AIApplicationService
from app.ai.workflows.checkpoint import SQLAlchemyCheckpointSaver
from app.ai.workflows.conversation_access import accessible_ai_conversation_clause
from app.ai.workflows.live_stream_cache import live_ai_stream_cache
from app.ai.workflows.orchestrator.profiles import ORCHESTRATOR_PROFILE_REGISTRY, OrchestratorProfile, profile_with_skill_route_hints
from app.ai.observability.serializers import serialize_ai_run_llm_exchange, serialize_ai_run_trace_span
from app.services.serializers import serialize_ai_conversation, serialize_ai_message, serialize_ai_run_event
from app.services.ai_quality import build_ai_quality_metrics

router = APIRouter(tags=["ai"])
logger = logging.getLogger(__name__)


def _model_supports_vision(model: str, configured: bool | None) -> bool:
    if configured is not None:
        return configured
    normalized_model = model.strip().lower()
    return any(marker in normalized_model for marker in ("gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4", "vision", "qwen-vl", "vl"))


def _discard_transient_chat_history(db: Session, *, family_id: str, response: dict) -> None:
    conversation_id = str(response.get("conversation_id") or "")
    run = response.get("run") if isinstance(response.get("run"), dict) else {}
    run_id = str(run.get("id") or "")
    if not conversation_id or not run_id:
        return
    approval_ids = list(
        db.scalars(
            select(AIApprovalRequest.id).where(
                AIApprovalRequest.conversation_id == conversation_id,
                AIApprovalRequest.family_id == family_id,
            )
        )
    )
    draft_ids = list(
        db.scalars(
            select(AITaskDraft.id).where(
                AITaskDraft.conversation_id == conversation_id,
                AITaskDraft.family_id == family_id,
            )
        )
    )
    if approval_ids:
        db.execute(
            delete(AIOperation).where(
                AIOperation.approval_request_id.in_(approval_ids),
                AIOperation.family_id == family_id,
            )
        )
        db.execute(
            delete(AIUserApproval).where(
                AIUserApproval.approval_request_id.in_(approval_ids),
                AIUserApproval.family_id == family_id,
            )
        )
        db.execute(
            delete(AIApprovalRequest).where(
                AIApprovalRequest.id.in_(approval_ids),
                AIApprovalRequest.family_id == family_id,
            )
        )
    if draft_ids:
        db.execute(delete(AITaskDraft).where(AITaskDraft.id.in_(draft_ids), AITaskDraft.family_id == family_id))
    db.execute(delete(AIRunEvent).where(AIRunEvent.run_id == run_id, AIRunEvent.family_id == family_id))
    db.execute(delete(AIMessage).where(AIMessage.conversation_id == conversation_id, AIMessage.family_id == family_id))
    db.execute(
        update(AIAgentRun)
        .where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id)
        .values(conversation_id=None, message_id=None)
    )
    db.execute(
        update(AIRunLLMExchange)
        .where(AIRunLLMExchange.run_id == run_id, AIRunLLMExchange.family_id == family_id)
        .values(conversation_id=None)
    )
    db.execute(delete(AIConversation).where(AIConversation.id == conversation_id, AIConversation.family_id == family_id))
    SQLAlchemyCheckpointSaver(db).delete_thread(conversation_id)


def _serialize_orchestrator_profile(profile: OrchestratorProfile, *, default_key: str) -> dict:
    return {
        "key": profile.key,
        "initial_skill_keys": list(profile.initial_skill_keys),
        "response_style": profile.response_style,
        "allowed_surface": profile.allowed_surface,
        "matcher": {
            "quickTasks": list(profile.matcher.quick_tasks),
            "subjectSources": list(profile.matcher.subject_sources),
            "surfaces": list(profile.matcher.surfaces),
            "routeHints": list(profile.matcher.route_hints),
        },
        "capability_policy": profile.capability_policy.to_state(),
        "budget_config": profile.budget_config.to_state(),
        "route_hints": [hint.to_state() for hint in profile.route_hints],
        "system_prompt_addon_present": bool(profile.system_prompt_addon.strip()),
        "default": profile.key == default_key,
    }


@router.get("/api/ai/status", response_model=AIStatusResponse)
def get_ai_status(auth: tuple = Depends(get_current_auth)) -> dict:
    _, _membership = auth
    settings = get_settings()
    provider = (settings.ai_provider or "disabled").strip().lower()
    model = settings.ai_model or "gpt-4o-mini"
    supports_vision = _model_supports_vision(model, getattr(settings, "ai_supports_vision", None))
    supported = {"enable", "enabled", "openai", "openai-compatible", "compatible", "custom", "dashscope"}
    if provider in {"", "disabled", "mock"}:
        return {
            "enabled": False,
            "provider": provider or "disabled",
            "model": model,
            "supports_vision": False,
            "status": "disabled",
            "detail": "AI 模型未配置。",
        }
    if provider not in supported:
        return {
            "enabled": False,
            "provider": provider,
            "model": model,
            "supports_vision": False,
            "status": "unsupported_provider",
            "detail": "AI provider 配置不受支持。",
        }
    if not settings.ai_api_key:
        return {
            "enabled": False,
            "provider": provider,
            "model": model,
            "supports_vision": False,
            "status": "missing_api_key",
            "detail": "AI API Key 未配置。",
        }
    return {
        "enabled": True,
        "provider": provider,
        "model": model,
        "supports_vision": supports_vision,
        "status": "ready",
        "detail": "AI 已就绪。",
    }


@router.get("/api/ai/conversations", response_model=list[AIConversationOut])
def list_ai_conversations(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    user, membership = auth
    rows = list(
        db.execute(
            select(AIConversation, User.display_name)
            .join(User, User.id == AIConversation.owner_user_id)
            .where(
                AIConversation.family_id == membership.family_id,
                accessible_ai_conversation_clause(user.id),
            )
            .order_by(func.coalesce(AIConversation.last_message_at, AIConversation.created_at).desc(), AIConversation.created_at.desc())
            .limit(20)
        )
    )
    return [
        serialize_ai_conversation(item, owner_display_name=display_name or "", current_user_id=user.id)
        for item, display_name in rows
    ]


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
                "scripts": [
                    function.tool_name
                    for function in skill_registry.get(manifest.key).script_catalog.functions()
                ],
                "output_types": manifest.output_types,
                "draft_types": manifest.draft_types,
                "draft_contract": manifest.draft_contract,
                "route_hints": manifest.route_hints,
                "tool_budget": manifest.tool_budget,
                "completion_policy": manifest.completion_policy.to_catalog_record(),
                "approval_policy": manifest.approval_policy,
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
                "requires_followup": tool.requires_followup,
                "terminal_output": tool.terminal_output,
                "followup_hint": tool.followup_hint,
                "output_types": tool.output_types,
                "draft_types": tool.draft_types,
                "input_schema": tool.input_schema,
                "output_schema": tool.output_schema,
            }
            for tool in tool_registry.list()
        ],
        "profiles": [
            _serialize_orchestrator_profile(
                profile_with_skill_route_hints(profile, skill_registry),
                default_key=ORCHESTRATOR_PROFILE_REGISTRY.default_profile.key,
            )
            for profile in ORCHESTRATOR_PROFILE_REGISTRY.profiles
        ],
    }


@router.get("/api/ai/quality-metrics", response_model=AIQualityMetricsResponse)
def get_ai_quality_metrics(
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
    days: int | None = Query(default=None, ge=1, le=365),
) -> dict:
    _, membership = auth
    return build_ai_quality_metrics(db, family_id=membership.family_id, limit=limit, days=days)


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
            attachments=[attachment.model_dump() for attachment in payload.attachments],
        )
    except AIConflictError as exc:
        logger.warning(
            "AI chat request rejected status=409 family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s error=%s",
            membership.family_id,
            user.id,
            payload.conversation_id,
            payload.client_message_id,
            payload.client_run_id,
            len(payload.message or ""),
            exc,
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
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
    if not payload.persist_history:
        _discard_transient_chat_history(db, family_id=membership.family_id, response=response)
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
                attachments=[attachment.model_dump() for attachment in payload.attachments],
            ):
                if event == "response":
                    if not payload.persist_history:
                        _discard_transient_chat_history(db, family_id=membership.family_id, response=data)
                    commit_session(db)
                    run_id = data.get("run", {}).get("id") if isinstance(data.get("run"), dict) else None
                    live_ai_stream_cache.clear_run(run_id)
                yield encode(event, data)
        except AIConflictError as exc:
            logger.warning(
                "AI stream chat request rejected status=409 family_id=%s user_id=%s conversation_id=%s client_message_id=%s client_run_id=%s message_length=%s error=%s",
                membership.family_id,
                user.id,
                payload.conversation_id,
                payload.client_message_id,
                payload.client_run_id,
                len(payload.message or ""),
                exc,
            )
            yield encode("error", {"detail": str(exc), "status": 409})
            return
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
    serialized_messages = [serialize_ai_message(item) for item in messages]
    return live_ai_stream_cache.overlay_messages(
        family_id=membership.family_id,
        conversation_id=conversation_id,
        messages=serialized_messages,
    )


@router.post("/api/ai/messages/{message_id}/recommendation-selection", response_model=AIMessageDTO)
def record_ai_recommendation_selection(
    message_id: str,
    payload: AIRecommendationSelectionRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        message = AIApplicationService(db).record_recommendation_selection(
            family_id=membership.family_id,
            user_id=user.id,
            message_id=message_id,
            part_id=payload.part_id,
            card_id=payload.card_id,
            entity_id=payload.entity_id,
            food_plan_item_id=payload.food_plan_item_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    commit_session(db)
    return serialize_ai_message(message)


@router.post("/api/ai/messages/{message_id}/inventory-operation-draft", response_model=AIMessageDTO)
def create_ai_inventory_operation_draft(
    message_id: str,
    payload: AIInventoryQuickDraftRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        message = AIApplicationService(db).create_inventory_quick_draft(
            family_id=membership.family_id,
            user_id=user.id,
            message_id=message_id,
            part_id=payload.part_id,
            card_id=payload.card_id,
            item_id=payload.item_id,
            action=payload.action,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    commit_session(db)
    return serialize_ai_message(message)


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


@router.get("/api/ai/runs/{run_id}/trace", response_model=AIRunTraceResponse)
def get_ai_run_trace(
    run_id: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == membership.family_id))
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI run not found")
    spans = list(
        db.scalars(
            select(AIRunTraceSpan)
            .where(AIRunTraceSpan.run_id == run_id, AIRunTraceSpan.family_id == membership.family_id)
            .order_by(AIRunTraceSpan.started_at.asc(), AIRunTraceSpan.id.asc())
        )
    )
    trace_id = spans[0].trace_id if spans else ""
    return {
        "runId": run.id,
        "traceId": trace_id,
        "status": run.status,
        "spans": [serialize_ai_run_trace_span(item) for item in spans],
    }


@router.get("/api/ai/runs/{run_id}/trace/tree", response_model=AIRunTraceTreeResponse)
def get_ai_run_trace_tree(
    run_id: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == membership.family_id))
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI run not found")
    spans = list(
        db.scalars(
            select(AIRunTraceSpan)
            .where(AIRunTraceSpan.run_id == run_id, AIRunTraceSpan.family_id == membership.family_id)
            .order_by(AIRunTraceSpan.started_at.asc(), AIRunTraceSpan.id.asc())
        )
    )
    serialized_by_span_id = {item.span_id: {**serialize_ai_run_trace_span(item), "children": []} for item in spans}
    roots: list[dict] = []
    for item in spans:
        node = serialized_by_span_id[item.span_id]
        if item.parent_span_id and item.parent_span_id in serialized_by_span_id:
            serialized_by_span_id[item.parent_span_id]["children"].append(node)
        else:
            roots.append(node)
    trace_id = spans[0].trace_id if spans else ""
    return {"runId": run.id, "traceId": trace_id, "status": run.status, "tree": roots}


@router.get("/api/ai/runs/{run_id}/llm-exchanges", response_model=AIRunLLMExchangeResponse)
def list_ai_run_llm_exchanges(
    run_id: str,
    include_payload: bool = Query(True, alias="includePayload"),
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == membership.family_id))
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI run not found")
    exchange_ids = list(
        db.scalars(
            select(AIRunLLMExchange.id)
            .where(AIRunLLMExchange.run_id == run_id, AIRunLLMExchange.family_id == membership.family_id)
            .order_by(AIRunLLMExchange.started_at.asc(), AIRunLLMExchange.id.asc())
        )
    )
    exchanges_by_id = {}
    if exchange_ids:
        exchanges_by_id = {
            item.id: item
            for item in db.scalars(select(AIRunLLMExchange).where(AIRunLLMExchange.id.in_(exchange_ids)))
        }
    exchanges = [exchanges_by_id[item_id] for item_id in exchange_ids if item_id in exchanges_by_id]
    trace_id = exchanges[0].trace_id if exchanges else ""
    return {
        "runId": run.id,
        "traceId": trace_id,
        "exchanges": [serialize_ai_run_llm_exchange(item, include_payload=include_payload) for item in exchanges],
    }


@router.get("/api/ai/runs/{run_id}/llm-exchanges/{exchange_id}", response_model=AIRunLLMExchangeDTO)
def get_ai_run_llm_exchange(
    run_id: str,
    exchange_id: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    exchange = db.scalar(
        select(AIRunLLMExchange).where(
            AIRunLLMExchange.id == exchange_id,
            AIRunLLMExchange.run_id == run_id,
            AIRunLLMExchange.family_id == membership.family_id,
        )
    )
    if exchange is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="AI LLM exchange not found")
    return serialize_ai_run_llm_exchange(exchange)


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
    except AIConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
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
    except AIConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
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
    except AIConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
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
    except AIConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    commit_session(db)
    return result


@router.post("/api/ai/conversations/{conversation_id}/human-input/{request_id}/response", response_model=AIChatResponse)
def respond_ai_human_input(
    conversation_id: str,
    request_id: str,
    payload: AIHumanInputResponseRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    user, membership = auth
    try:
        result = AIApplicationService(db).respond_human_input(
            family_id=membership.family_id,
            user_id=user.id,
            conversation_id=conversation_id,
            request_id=request_id,
            selected_option_ids=payload.selected_option_ids,
            text=payload.text,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    commit_session(db)
    return result


@router.post("/api/ai/conversations/{conversation_id}/human-input/{request_id}/response/stream")
def stream_ai_human_input_response(
    conversation_id: str,
    request_id: str,
    payload: AIHumanInputResponseRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    user, membership = auth

    def encode(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(jsonable_encoder(data), ensure_ascii=False)}\n\n"

    def generate():
        try:
            service = AIApplicationService(db)
            for event, data in service.stream_human_input_response(
                family_id=membership.family_id,
                user_id=user.id,
                conversation_id=conversation_id,
                request_id=request_id,
                selected_option_ids=payload.selected_option_ids,
                text=payload.text,
            ):
                if event == "response":
                    commit_session(db)
                    run_id = data.get("run", {}).get("id") if isinstance(data.get("run"), dict) else None
                    live_ai_stream_cache.clear_run(run_id)
                yield encode(event, data)
        except ValueError as exc:
            yield encode("error", {"detail": str(exc), "status": 400})
            return
        except LookupError as exc:
            yield encode("error", {"detail": str(exc), "status": 404})
            return
        except Exception:
            logger.exception(
                "AI human input stream failed family_id=%s user_id=%s conversation_id=%s request_id=%s",
                membership.family_id,
                user.id,
                conversation_id,
                request_id,
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


@router.post("/api/ai/conversations/{conversation_id}/approvals/{approval_id}/decision/stream")
def stream_ai_approval_decision(
    conversation_id: str,
    approval_id: str,
    payload: AIApprovalDecisionRequest,
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    user, membership = auth

    def encode(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(jsonable_encoder(data), ensure_ascii=False)}\n\n"

    def generate():
        try:
            service = AIApplicationService(db)
            for event, data in service.stream_approval_decision(
                family_id=membership.family_id,
                user_id=user.id,
                conversation_id=conversation_id,
                approval_id=approval_id,
                decision=payload.decision,
                draft_version=payload.draft_version,
                values=payload.values,
                comment=payload.comment,
            ):
                if event == "response":
                    commit_session(db)
                    run_id = data.get("run", {}).get("id") if isinstance(data.get("run"), dict) else None
                    live_ai_stream_cache.clear_run(run_id)
                yield encode(event, data)
        except LookupError as exc:
            yield encode("error", {"detail": str(exc), "status": 404})
            return
        except AIConflictError as exc:
            yield encode("error", {"detail": str(exc), "status": 409})
            return
        except ValueError as exc:
            yield encode("error", {"detail": str(exc), "status": 409})
            return
        except Exception:
            logger.exception(
                "AI approval decision stream failed family_id=%s user_id=%s conversation_id=%s approval_id=%s",
                membership.family_id,
                user.id,
                conversation_id,
                approval_id,
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
