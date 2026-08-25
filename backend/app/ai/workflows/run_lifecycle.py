from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.utils import create_id, utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIConversation,
    AIMessage,
    AIOperation,
    AITaskDraft,
)
from app.services.ai_operations.commit_coordinator import (
    DraftCommitCoordinator,
    derive_draft_payload_hash,
)
from app.services.ai_operations.run_cancellation import lock_run_for_transition


@dataclass(frozen=True, slots=True)
class DraftRetryResolution:
    conversation_id: str
    run_id: str
    kind: str


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


def recover_or_replay_draft_run(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    run_id: str,
) -> DraftRetryResolution | None:
    """Intercept durable Draft retries before any prompt/provider replay."""
    run = lock_run_for_transition(db, family_id=family_id, run_id=run_id)
    pending_retry_drafts = list(
        db.scalars(
            select(AITaskDraft)
            .where(
                AITaskDraft.family_id == family_id,
                AITaskDraft.source_run_id == run.id,
                AITaskDraft.status == "pending_retry",
            )
            .order_by(AITaskDraft.created_at.asc(), AITaskDraft.id.asc())
            .with_for_update()
        )
    )
    if len(pending_retry_drafts) > 1:
        raise AIConflictError("运行关联了多个待恢复草稿")
    if pending_retry_drafts:
        if run.created_by != actor_user_id:
            raise AIConflictError("只能由原执行人恢复待重试草稿")
        draft = pending_retry_drafts[0]
        _validate_retry_draft_identity(run=run, draft=draft)
        if draft.execution_route == "policy_auto":
            result = DraftCommitCoordinator.retry_pending_locked(
                db,
                family_id=family_id,
                actor_user_id=actor_user_id,
                locked_run=run,
                locked_draft=draft,
                expected_payload_hash=draft.payload_hash,
                now=utcnow(),
            )
            _apply_retry_result_status(
                db,
                run=run,
                draft=draft,
                succeeded=result.projection.result_status == "completed",
            )
            return DraftRetryResolution(
                conversation_id=draft.conversation_id,
                run_id=run.id,
                kind="policy_auto_recovered",
            )
        retry_approvals = list(
            db.scalars(
                select(AIApprovalRequest)
                .where(
                    AIApprovalRequest.family_id == family_id,
                    AIApprovalRequest.run_id == run.id,
                    AIApprovalRequest.draft_id == draft.id,
                    AIApprovalRequest.draft_version == draft.version,
                    AIApprovalRequest.status == "pending",
                    AIApprovalRequest.approval_type.like("%.retry"),
                )
                .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
                .with_for_update()
            )
        )
        if len(retry_approvals) != 1:
            raise AIConflictError("人工草稿缺少唯一的重试确认请求")
        _apply_manual_retry_waiting_status(db, run=run, draft=draft)
        return DraftRetryResolution(
            conversation_id=draft.conversation_id,
            run_id=run.id,
            kind="manual_retry_waiting_approval",
        )

    drafts = list(
        db.scalars(
            select(AITaskDraft)
            .where(
                AITaskDraft.family_id == family_id,
                AITaskDraft.source_run_id == run.id,
            )
            .order_by(AITaskDraft.created_at.asc(), AITaskDraft.id.asc())
            .with_for_update()
        )
    )
    if not drafts:
        return None
    terminal_draft_ids = {
        draft.id
        for draft in drafts
        if draft.status in {"executed", "no_change", "reverted", "execution_failed"}
    }
    operation_terminal_draft_ids = set(
        db.scalars(
            select(AIOperation.draft_id).where(
                AIOperation.family_id == family_id,
                AIOperation.run_id == run.id,
                AIOperation.status.in_({"succeeded", "reverted", "failed"}),
            )
        )
    )
    if terminal_draft_ids or operation_terminal_draft_ids:
        return DraftRetryResolution(
            conversation_id=str(run.conversation_id or drafts[0].conversation_id),
            run_id=run.id,
            kind="persisted_result_replay",
        )
    return None


def _validate_retry_draft_identity(*, run: AIAgentRun, draft: AITaskDraft) -> None:
    if (
        not run.conversation_id
        or draft.source_run_id != run.id
        or draft.conversation_id != run.conversation_id
        or not draft.message_id
    ):
        raise AIConflictError("待恢复草稿的运行或消息归属已变化")
    if not draft.payload_hash or derive_draft_payload_hash(draft.payload) != draft.payload_hash:
        raise AIConflictError("待恢复草稿的载荷摘要不匹配")


def _apply_retry_result_status(
    db: Session,
    *,
    run: AIAgentRun,
    draft: AITaskDraft,
    succeeded: bool,
) -> None:
    status = "completed" if succeeded else "failed"
    run.status = status
    message = db.get(AIMessage, draft.message_id)
    if message is not None:
        message.status = status
    conversation = db.get(AIConversation, draft.conversation_id)
    if conversation is not None:
        conversation.last_run_status = status
        if succeeded:
            context = dict(conversation.context or {})
            context.pop("activeRunId", None)
            conversation.context = context
    db.flush()


def _apply_manual_retry_waiting_status(
    db: Session,
    *,
    run: AIAgentRun,
    draft: AITaskDraft,
) -> None:
    run.status = "waiting_approval"
    message = db.get(AIMessage, draft.message_id)
    if message is not None:
        message.status = "waiting_approval"
    conversation = db.get(AIConversation, draft.conversation_id)
    if conversation is not None:
        conversation.last_run_status = "waiting_approval"
    db.flush()


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
