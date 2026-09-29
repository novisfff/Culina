"""Conservative crash recovery. Only project durable facts; NEVER execute a Run."""
from __future__ import annotations

from datetime import datetime, timedelta
import logging

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.ai.workflows.runner_support.human_input_resume_claim import clear_stream_resume_claim
from app.ai.workflows.runner_support.run_status import TERMINAL_RUN_STATUSES
from app.core.config import get_settings
from app.models.domain import AIAgentRun, AIApprovalRequest, AIConversation, AIOperation, AIRunCancelRequest, AIRunEvent, AIRunExecutionLease
from app.services.ai_operations.execution_lease import as_utc, database_now, is_lock_contention
from app.services.ai_operations.run_cancellation import _canonical_assistant_message, _finalize_waiting_run_cancellation, cancellation_wins, finalize_run_cancellation
from app.services.ai_timeline import AITimelineService
from app.services.ai_operations.status import normalize_operation_statuses

logger = logging.getLogger(__name__)
WAITING = {"waiting_approval", "waiting_input"}


def _abandoned(run: AIAgentRun, lease: AIRunExecutionLease | None, now: datetime) -> bool:
    if lease is not None and lease.worker_id is not None:
        return lease.lease_until is None or as_utc(lease.lease_until) <= now
    claim = (run.context_summary or {}).get("_streamResumeClaim")
    if claim is not None:
        try:
            started = as_utc(datetime.fromisoformat(claim["claimedAt"].replace("Z", "+00:00")))
        except (AttributeError, TypeError, KeyError, ValueError):
            started = as_utc(run.created_at)
        return now - started >= timedelta(seconds=get_settings().ai_run_lease_seconds)
    # Ordinary waiting is not abandoned, including historical waiting records.
    if run.status not in {"pending", "running", "cancelling"}:
        return False
    started = lease.heartbeat_at if lease is not None and lease.heartbeat_at else run.created_at
    return now - as_utc(started) >= timedelta(seconds=get_settings().ai_run_lease_seconds)


def _project_recovery(db: Session, run: AIAgentRun, *, provider_started: bool) -> None:
    if run.status in TERMINAL_RUN_STATUSES:
        clear_stream_resume_claim(run)
        return
    if cancellation_wins(db, run=run):
        request = db.scalar(select(AIRunCancelRequest).where(
            AIRunCancelRequest.family_id == run.family_id,
            AIRunCancelRequest.run_id == run.id,
        ).with_for_update())
        if request is not None:
            _finalize_waiting_run_cancellation(db, run=run, request=request, requested_by=request.requested_by)
        else:
            finalize_run_cancellation(db, run=run)
        return
    old_status = run.status
    had_claim = (run.context_summary or {}).get("_streamResumeClaim") is not None
    clear_stream_resume_claim(run)
    message = _canonical_assistant_message(db, run=run)
    pending_approval = db.scalar(select(AIApprovalRequest.id).where(AIApprovalRequest.family_id == run.family_id, AIApprovalRequest.run_id == run.id, AIApprovalRequest.status == "pending").limit(1))
    pending_input = message is not None and any(
        isinstance(part, dict) and part.get("type") == "human_input_request" and part.get("status", "pending") in {"pending", "pending_retry"}
        for part in message.parts or []
    )
    operation_statuses = normalize_operation_statuses(db.scalars(select(AIOperation.status).where(
        AIOperation.family_id == run.family_id, AIOperation.run_id == run.id,
    )))
    if pending_approval:
        status = "waiting_approval"
    elif pending_input:
        status = "waiting_input"
    elif had_claim and old_status in WAITING:
        # The durable decision/input has not been consumed; require user action.
        status = old_status
    else:
        status = "failed"
    code = "execution_interrupted"
    if status in WAITING:
        text = "处理因服务中断而暂停，请继续确认或补充信息。未自动重新发送模型请求。"
    elif operation_statuses - {"completed", "reverted", "failed"}:
        code = "execution_outcome_unknown"
        text = "处理因服务中断而停止，部分执行结果尚未确认。已有记录已保留，未自动重新执行或重发模型请求。"
    elif operation_statuses:
        code = "execution_continuation_interrupted"
        text = "后续处理因服务中断而停止。已有操作结果已保留，没有重复执行；重试将优先读取已有结果。"
    elif provider_started:
        code = "execution_outcome_unknown"
        text = "处理因服务中断而停止，模型调用结果未确认。未自动重发；手动重试可能再次计费。"
    else:
        text = "处理因服务中断而停止，未自动重发模型请求。你可以手动重试。"
    run.status = status
    run.error_code = code
    run.error = text if status == "failed" else None
    run.output_summary = text
    timeline = AITimelineService(db)
    if run.conversation_id:
        if message is None:
            message = timeline.create_message(family_id=run.family_id, conversation_id=run.conversation_id, run_id=run.id, role="assistant", content="", parts=[], status=status, created_by=run.created_by).message
        metadata = dict(message.message_metadata or {})
        for key in ("liveStreaming", "livePartIds", "liveTextPartIds"):
            metadata.pop(key, None)
        scope = dict(family_id=run.family_id, conversation_id=run.conversation_id, message_id=message.id, run_id=run.id, created_by=run.created_by)
        if not timeline.has_terminal(conversation_id=run.conversation_id, message_id=message.id):
            # Recovery can happen again after a later explicitly resumed phase.
            generation = db.get(AIRunExecutionLease, run.id).fencing_token
            timeline.append_part(**scope, part={"id": f"recovery:{run.id}:{generation}", "type": "text", "text": text})
            if status == "failed":
                timeline.terminal(**scope, status=status, metadata=metadata)
            else:
                timeline.update_message_metadata(**scope, metadata=metadata)
                timeline.update_message_status(**scope, status=status)
        conversation = db.scalar(select(AIConversation).where(AIConversation.id == run.conversation_id, AIConversation.family_id == run.family_id).with_for_update())
        if conversation is not None:
            context = dict(conversation.context or {})
            if status == "failed" and context.get("activeRunId") == run.id:
                context.pop("activeRunId", None)
            conversation.context = context
            conversation.last_run_status = status
            conversation.response = message.content
            conversation.summary = message.content[:255]
    for progress in db.scalars(select(AIRunEvent).where(AIRunEvent.family_id == run.family_id, AIRunEvent.run_id == run.id, AIRunEvent.status.in_(["pending", "running"]))):
        progress.status = "failed"
    db.add(AIRunEvent(family_id=run.family_id, run_id=run.id, conversation_id=run.conversation_id, type="recovery", internal_code=code, user_message=text, status=status, payload={"automaticReplay": False}))


def recover_expired_runs(db: Session, limit: int = 50, family_id: str | None = None) -> int:
    """Dedicated reaper Session only: each candidate commits/rolls back separately."""
    if limit <= 0:
        raise ValueError("recovery limit must be positive")
    now = database_now(db)
    cutoff = now - timedelta(seconds=get_settings().ai_run_lease_seconds)
    claim = AIAgentRun.context_summary["_streamResumeClaim"].as_string()
    idle = AIRunExecutionLease.worker_id.is_(None)
    query = select(AIAgentRun.id, AIAgentRun.family_id).outerjoin(AIRunExecutionLease, AIRunExecutionLease.run_id == AIAgentRun.id).where(
        AIAgentRun.feature_key == "ai_workspace_chat",
        or_(
            and_(AIRunExecutionLease.worker_id.is_not(None), or_(AIRunExecutionLease.lease_until <= now, AIRunExecutionLease.lease_until.is_(None))),
            and_(idle, AIAgentRun.status.in_(["pending", "running", "cancelling"]), func.coalesce(AIRunExecutionLease.heartbeat_at, AIAgentRun.created_at) <= cutoff),
            and_(idle, claim.is_not(None), AIAgentRun.created_at <= cutoff),
        ),
    ).order_by(AIAgentRun.created_at, AIAgentRun.id).limit(limit)
    if family_id is not None:
        query = query.where(AIAgentRun.family_id == family_id)
    candidates = list(db.execute(query))
    db.rollback()  # end the candidate-list snapshot before locking current state
    recovered = 0
    for run_id, owner_family in candidates:
        try:
            exists = db.scalar(select(AIRunExecutionLease.run_id).where(AIRunExecutionLease.run_id == run_id))
            lease = db.scalar(select(AIRunExecutionLease).where(AIRunExecutionLease.run_id == run_id, AIRunExecutionLease.family_id == owner_family).with_for_update(nowait=True).execution_options(populate_existing=True)) if exists else None
            run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == owner_family).with_for_update(nowait=True).execution_options(populate_existing=True))
            # First claim may have inserted while we waited for the Run lock.
            if lease is None:
                lease = db.scalar(select(AIRunExecutionLease).where(AIRunExecutionLease.run_id == run_id).with_for_update(nowait=True).execution_options(populate_existing=True))
            now = database_now(db)
            if run is None or not _abandoned(run, lease, now):
                db.rollback()
                continue
            provider_started = lease.provider_started if lease is not None else True
            if lease is None:
                lease = AIRunExecutionLease(run_id=run.id, family_id=run.family_id, fencing_token=0)
                db.add(lease)
            lease.fencing_token += 1
            lease.worker_id = None
            lease.lease_until = None
            lease.heartbeat_at = now
            db.flush()
            _project_recovery(db, run, provider_started=provider_started)
            db.commit()
            recovered += 1
            logger.warning("Recovered abandoned AI run run_id=%s family_id=%s status=%s", run_id, owner_family, run.status)
        except OperationalError as exc:
            db.rollback()
            if not is_lock_contention(exc):
                raise
        except Exception:
            db.rollback()
            logger.exception("AI Run recovery candidate failed run_id=%s family_id=%s", run_id, owner_family)
    return recovered
