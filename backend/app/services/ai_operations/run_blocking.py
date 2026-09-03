from __future__ import annotations

import hashlib
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.utils import utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage
from app.services.ai_timeline import AITimelineService


logger = logging.getLogger(__name__)

AUTO_EXECUTION_BLOCKED_CONTEXT_KEY = "autoExecutionBlocked"
AUTO_EXECUTION_BLOCKED_ERROR_CODE = "draft_terminalization_failed"
AUTO_EXECUTION_BLOCKED_MESSAGE = "自动执行结果未能安全保存，已停止继续重试"
AUTO_EXECUTION_BLOCKED_RECOVERY_HINT = "retry_later_or_contact_support"


def auto_execution_blocked_record() -> dict[str, str]:
    return {
        "errorCode": AUTO_EXECUTION_BLOCKED_ERROR_CODE,
        "message": AUTO_EXECUTION_BLOCKED_MESSAGE,
        "recoveryHint": AUTO_EXECUTION_BLOCKED_RECOVERY_HINT,
    }


def is_run_auto_execution_blocked(run: AIAgentRun) -> bool:
    blocked = (
        run.context_summary.get(AUTO_EXECUTION_BLOCKED_CONTEXT_KEY)
        if isinstance(run.context_summary, dict)
        else None
    )
    return bool(
        run.auto_execution_attempted
        and isinstance(blocked, dict)
        and blocked.get("errorCode") == AUTO_EXECUTION_BLOCKED_ERROR_CODE
        and blocked.get("recoveryHint") == AUTO_EXECUTION_BLOCKED_RECOVERY_HINT
    )


def mark_run_auto_execution_blocked(
    db: Session,
    *,
    family_id: str,
    run_id: str,
) -> AIAgentRun | None:
    """Persist an idempotent Run/message fact that prevents provider replay."""
    run = db.scalar(
        select(AIAgentRun)
        .where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None:
        return None
    blocked = auto_execution_blocked_record()
    context_summary = dict(run.context_summary or {})
    context_summary[AUTO_EXECUTION_BLOCKED_CONTEXT_KEY] = blocked
    run.context_summary = context_summary
    output = dict(run.output or {})
    output[AUTO_EXECUTION_BLOCKED_CONTEXT_KEY] = blocked
    run.output = output
    run.auto_execution_attempted = True
    run.status = "failed"
    run.error_code = AUTO_EXECUTION_BLOCKED_ERROR_CODE
    run.error = AUTO_EXECUTION_BLOCKED_MESSAGE
    run.output_summary = AUTO_EXECUTION_BLOCKED_MESSAGE

    message = _locked_run_message(db, run=run)
    if message is None:
        raise LookupError("预创建的 canonical 助手消息不存在")
    blocked_parts = _upsert_blocked_result_part(message.parts, run_id=run.id)
    blocked_part_id = next(
        (
            str(part.get("id") or "")
            for part in blocked_parts
            if isinstance(part, dict)
            and isinstance(part.get("card"), dict)
            and part["card"].get("id") == f"auto-execution-blocked-{run.id}"
        ),
        "",
    )
    if not blocked_part_id:
        raise LookupError("自动执行阻断结果缺少稳定 part id")
    blocked_part = next(
        part for part in blocked_parts if isinstance(part, dict) and str(part.get("id") or "") == blocked_part_id
    )
    timeline = AITimelineService(db)
    timeline.upsert_part(
        family_id=run.family_id,
        conversation_id=run.conversation_id,
        message_id=message.id,
        run_id=run.id,
        part=blocked_part,
        created_by=run.created_by,
    )
    metadata = dict(message.message_metadata or {})
    metadata.pop("liveStreaming", None)
    metadata.pop("liveTextPartIds", None)
    metadata.pop("livePartIds", None)
    timeline.update_message_metadata(
        family_id=run.family_id,
        conversation_id=run.conversation_id,
        message_id=message.id,
        run_id=run.id,
        metadata=metadata,
        created_by=run.created_by,
    )
    timeline.terminal(
        family_id=run.family_id,
        conversation_id=run.conversation_id,
        message_id=message.id,
        run_id=run.id,
        status="failed",
        content=AUTO_EXECUTION_BLOCKED_MESSAGE,
        created_by=run.created_by,
    )
    blocked_cards = [
        part["card"]
        for part in message.parts or []
        if isinstance(part, dict)
        and isinstance(part.get("card"), dict)
        and part["card"].get("data", {}).get("errorCode") == AUTO_EXECUTION_BLOCKED_ERROR_CODE
    ]
    run.output = {
        "text": AUTO_EXECUTION_BLOCKED_MESSAGE,
        "cards": blocked_cards,
        "routing": context_summary.get("routing", {}),
        AUTO_EXECUTION_BLOCKED_CONTEXT_KEY: blocked,
    }
    conversation = db.scalar(
        select(AIConversation)
        .where(
            AIConversation.id == run.conversation_id,
            AIConversation.family_id == family_id,
        )
        .with_for_update()
    )
    if conversation is not None:
        conversation.last_run_status = "failed"
        conversation.last_message_at = utcnow()
        conversation.response = AUTO_EXECUTION_BLOCKED_MESSAGE
        conversation.summary = AUTO_EXECUTION_BLOCKED_MESSAGE[:255]
        conversation_context = dict(conversation.context or {})
        if conversation_context.get("activeRunId") == run.id:
            conversation_context.pop("activeRunId", None)
        conversation.context = conversation_context
    db.flush()
    return run


def persist_run_auto_execution_blocked_after_rollback(
    db: Session,
    *,
    family_id: str,
    run_id: str | None,
) -> bool:
    """Rollback poisoned work, then record the blocked Run in an independent transaction."""
    bind = db.get_bind()
    try:
        db.rollback()
    except Exception:
        logger.exception(
            "AI auto-execution blocked recovery could not rollback family_id=%s run_id=%s",
            family_id,
            run_id,
        )
    if not run_id:
        return False
    try:
        with Session(bind=bind, expire_on_commit=False, future=True) as recovery_db:
            run = mark_run_auto_execution_blocked(
                recovery_db,
                family_id=family_id,
                run_id=run_id,
            )
            if run is None:
                recovery_db.rollback()
                return False
            recovery_db.commit()
            return True
    except Exception:
        logger.exception(
            "AI auto-execution blocked Run fact could not be persisted family_id=%s run_id=%s",
            family_id,
            run_id,
        )
        return False


def _locked_run_message(db: Session, *, run: AIAgentRun) -> AIMessage | None:
    return db.scalar(
        select(AIMessage)
        .where(
            AIMessage.family_id == run.family_id,
            AIMessage.run_id == run.id,
            AIMessage.role == "assistant",
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _upsert_blocked_result_part(parts: list[dict[str, Any]] | None, *, run_id: str) -> list[dict[str, Any]]:
    card_id = f"auto-execution-blocked-{run_id}"
    part_id = f"ai_part-{hashlib.sha256(card_id.encode('utf-8')).hexdigest()[:20]}"
    card = {
        "id": card_id,
        "type": "operation_result",
        "title": "自动执行未完成",
        "data": {
            "resultStatus": "failed",
            "executionMode": "policy_auto",
            **auto_execution_blocked_record(),
        },
    }
    existing = [part for part in (parts or []) if isinstance(part, dict)]
    next_part = {"id": part_id, "type": "result_card", "card": card}
    replaced = False
    next_parts: list[dict[str, Any]] = []
    for part in existing:
        current_card = part.get("card") if isinstance(part.get("card"), dict) else {}
        if part.get("id") == part_id or current_card.get("id") == card_id:
            if not replaced:
                next_parts.append(next_part)
                replaced = True
            continue
        next_parts.append(part)
    if not replaced:
        next_parts.append(next_part)
    return next_parts
