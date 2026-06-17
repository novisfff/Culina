from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIApprovalRequest, AIConversation, AIMessage, AIRunEvent, AITaskDraft
from app.services.ai_operations import sync_message_approval_parts


def add_run_event(
    db: Session,
    *,
    family_id: str,
    conversation_id: str,
    run_id: str,
    event_type: str,
    internal_code: str,
    user_message: str,
    status: str,
) -> AIRunEvent:
    event = AIRunEvent(
        id=create_id("ai_run_event"),
        family_id=family_id,
        conversation_id=conversation_id,
        run_id=run_id,
        type=event_type,
        internal_code=internal_code,
        user_message=user_message,
        status="failed" if status == "failed" else "completed",
        payload={},
    )
    db.add(event)
    db.flush()
    return event


def cancel_workspace_run(db: Session, *, family_id: str, user_id: str, run_id: str) -> tuple[AIAgentRun, AIRunEvent]:
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
    if run is None:
        raise LookupError("运行任务不存在")
    if run.status not in {"pending", "running", "waiting_approval"}:
        raise ValueError("运行任务已结束，不能取消")
    pending_approvals = list(
        db.scalars(
            select(AIApprovalRequest)
            .where(
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.run_id == run.id,
                AIApprovalRequest.status == "pending",
            )
            .order_by(AIApprovalRequest.created_at.asc())
        )
    )
    run.status = "cancelled"
    run.error = "用户取消了这次任务"
    if run.conversation_id:
        conversation = db.get(AIConversation, run.conversation_id)
        if conversation is not None:
            conversation.last_run_status = "cancelled"
            conversation.last_message_at = utcnow()
    for approval in pending_approvals:
        approval.status = "cancelled"
        approval.decision = "rejected"
        approval.comment = "用户取消了这次任务"
        approval.resolved_at = utcnow()
        approval.updated_by = user_id
        draft = db.scalar(select(AITaskDraft).where(AITaskDraft.id == approval.draft_id, AITaskDraft.family_id == family_id))
        if draft is not None and draft.status in {"pending", "pending_retry"}:
            draft.status = "rejected"
            draft.updated_at = utcnow()
        if draft is not None:
            sync_message_approval_parts(db, draft=draft, approval=approval)
    event = add_run_event(
        db,
        family_id=family_id,
        conversation_id=run.conversation_id or "",
        run_id=run.id,
        event_type="cancel",
        internal_code="user_cancel",
        user_message="已取消这次任务",
        status="failed",
    )
    db.flush()
    return run, event


def build_retry_chat_request(db: Session, *, family_id: str, run_id: str) -> dict[str, Any]:
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
    if run is None:
        raise LookupError("运行任务不存在")
    if run.status not in {"failed", "fallback", "cancelled"}:
        raise ValueError("只有失败、fallback 或已取消的任务可以重试")
    source_input = run.input or {}
    prompt = str(source_input.get("prompt") or run.input_summary or "").strip()
    if not prompt:
        raise ValueError("找不到可重试的原始消息")
    retry_subject = source_input.get("subject") if isinstance(source_input.get("subject"), dict) else {}
    return {
        "message": prompt,
        "conversation_id": run.conversation_id,
        "client_message_id": f"retry-{run.id}-{create_id('client')}",
        "quick_task": source_input.get("quickTask") if isinstance(source_input.get("quickTask"), str) else None,
        "subject": {**retry_subject, "retryOfRunId": run.id},
    }


def build_regenerate_part_chat_request(
    db: Session,
    *,
    family_id: str,
    message_id: str,
    part_id: str,
) -> dict[str, Any]:
    message = db.scalar(select(AIMessage).where(AIMessage.id == message_id, AIMessage.family_id == family_id))
    if message is None:
        raise LookupError("消息不存在")
    if message.role != "assistant" or not message.run_id:
        raise ValueError("只能重新生成 AI 回复里的局部内容")
    part = next((item for item in message.parts or [] if item.get("id") == part_id), None)
    if part is None:
        raise LookupError("消息局部不存在")
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == message.run_id, AIAgentRun.family_id == family_id))
    if run is None:
        raise LookupError("原始运行任务不存在")
    source_input = run.input or {}
    prompt = str(source_input.get("prompt") or run.input_summary or "").strip()
    if not prompt:
        raise ValueError("找不到可局部重生成的原始消息")
    subject = source_input.get("subject") if isinstance(source_input.get("subject"), dict) else {}
    regenerate_subject = {
        **subject,
        "regenerate": {
            "messageId": message.id,
            "partId": part_id,
            "partType": part.get("type"),
            "cardType": part.get("card", {}).get("type") if isinstance(part.get("card"), dict) else None,
        },
    }
    return {
        "message": f"{prompt}\n\n请只重新生成上一条回复中需要调整的这一部分，并保持同一个草稿上下文。",
        "conversation_id": message.conversation_id,
        "client_message_id": f"regen-{message.id}-{part_id}-{create_id('client')}",
        "quick_task": source_input.get("quickTask") if isinstance(source_input.get("quickTask"), str) else None,
        "subject": regenerate_subject,
    }
