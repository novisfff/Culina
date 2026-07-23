from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.utils import create_id
from app.models.domain import AIAgentRun, AIMessage


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
