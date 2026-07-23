from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.ai.workflows.conversation_access import require_ai_run_access
from app.ai.workflows.runner_support.run_status import ACTIVE_RUN_STATUSES, CANCELLED, CANCELLING, TERMINAL_RUN_STATUSES
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIConversation, AIMessage, AIRunCancelRequest, AIRunEvent
from app.services.serializers import serialize_ai_run, serialize_ai_run_cancel_request, serialize_ai_run_event


RunCancellationOutcome = Literal[
    "cancel_requested",
    "cancelled",
    "already_cancelled",
    "run_not_cancellable",
]


@dataclass(frozen=True)
class RunCancellationResult:
    outcome: RunCancellationOutcome
    request: AIRunCancelRequest
    run: AIAgentRun | None
    events: list[AIRunEvent]
    http_status: int


def _cancel_request(
    db: Session,
    *,
    family_id: str,
    run_id: str,
    for_update: bool = False,
) -> AIRunCancelRequest | None:
    query = select(AIRunCancelRequest).where(
        AIRunCancelRequest.family_id == family_id,
        AIRunCancelRequest.run_id == run_id,
    )
    if for_update:
        query = query.with_for_update()
    return db.scalar(query)


def _run_events(db: Session, *, family_id: str, run_id: str) -> list[AIRunEvent]:
    return list(
        db.scalars(
            select(AIRunEvent)
            .where(AIRunEvent.family_id == family_id, AIRunEvent.run_id == run_id)
            .order_by(AIRunEvent.created_at.asc(), AIRunEvent.id.asc())
        )
    )


def record_run_cancellation_request(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    run_id: str,
) -> AIRunCancelRequest:
    run = db.get(AIAgentRun, run_id)
    if run is not None:
        if run.family_id != family_id:
            raise LookupError("运行任务不存在")
        require_ai_run_access(
            db,
            family_id=family_id,
            user_id=user_id,
            run_id=run_id,
            capability="contribute",
        )
    existing = _cancel_request(db, family_id=family_id, run_id=run_id)
    if existing is not None:
        return existing
    request = AIRunCancelRequest(
        id=create_id("run_cancel"),
        family_id=family_id,
        run_id=run_id,
        requested_by=user_id,
        status="requested",
        outcome_code="cancel_requested",
    )
    try:
        with db.begin_nested():
            db.add(request)
            db.flush()
        return request
    except IntegrityError:
        existing = _cancel_request(db, family_id=family_id, run_id=run_id)
        if existing is None:
            raise
        return existing


def apply_run_cancellation_request(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    run_id: str,
) -> RunCancellationResult:
    run = db.scalar(
        select(AIAgentRun)
        .where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id)
        .with_for_update()
    )
    request = _cancel_request(db, family_id=family_id, run_id=run_id, for_update=True)
    if request is None:
        raise LookupError("取消请求不存在")
    if run is None:
        if request.requested_by != user_id:
            raise LookupError("运行任务不存在")
        return RunCancellationResult("cancel_requested", request, None, [], 202)
    require_ai_run_access(
        db,
        family_id=family_id,
        user_id=user_id,
        run_id=run_id,
        capability="contribute",
    )
    events = _run_events(db, family_id=family_id, run_id=run_id)
    if run.status == CANCELLED:
        request.status = "applied"
        request.outcome_code = "already_cancelled"
        request.resolved_at = request.resolved_at or utcnow()
        return RunCancellationResult("already_cancelled", request, run, events, 200)
    if run.status in TERMINAL_RUN_STATUSES:
        request.status = "rejected"
        request.outcome_code = "run_not_cancellable"
        request.resolved_at = request.resolved_at or utcnow()
        return RunCancellationResult("run_not_cancellable", request, run, events, 409)
    if run.status not in ACTIVE_RUN_STATUSES:
        request.status = "rejected"
        request.outcome_code = "run_not_cancellable"
        request.resolved_at = request.resolved_at or utcnow()
        return RunCancellationResult("run_not_cancellable", request, run, events, 409)
    if run.status != CANCELLING:
        run.status = CANCELLING
    return RunCancellationResult("cancel_requested", request, run, events, 202)


def get_run_cancellation_result(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    run_id: str,
) -> RunCancellationResult:
    request = _cancel_request(db, family_id=family_id, run_id=run_id)
    if request is None:
        raise LookupError("取消请求不存在")
    run = db.scalar(select(AIAgentRun).where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id))
    if run is None and request.requested_by != user_id:
        raise LookupError("取消请求不存在")
    if run is not None:
        require_ai_run_access(
            db,
            family_id=family_id,
            user_id=user_id,
            run_id=run_id,
            capability="view",
        )
    events = _run_events(db, family_id=family_id, run_id=run_id)
    if run is not None and run.status == CANCELLED:
        outcome: RunCancellationOutcome = (
            "already_cancelled" if request.outcome_code == "already_cancelled" else "cancelled"
        )
        return RunCancellationResult(outcome, request, run, events, 200)
    if request.status == "rejected":
        return RunCancellationResult("run_not_cancellable", request, run, events, 409)
    return RunCancellationResult("cancel_requested", request, run, events, 202)


def is_run_cancellation_requested(db: Session, *, family_id: str, run_id: str) -> bool:
    return bool(
        db.scalar(
            select(AIRunCancelRequest.id).where(
                AIRunCancelRequest.family_id == family_id,
                AIRunCancelRequest.run_id == run_id,
                AIRunCancelRequest.status.in_({"requested", "applied"}),
            )
        )
    )


def lock_run_for_transition(
    db: Session,
    *,
    family_id: str,
    run_id: str,
) -> AIAgentRun:
    run = db.scalar(
        select(AIAgentRun)
        .where(AIAgentRun.id == run_id, AIAgentRun.family_id == family_id)
        .with_for_update()
    )
    if run is None:
        raise LookupError("运行任务不存在")
    return run


def cancellation_wins(db: Session, *, run: AIAgentRun) -> bool:
    if run.status in {CANCELLING, CANCELLED}:
        return True
    request = _cancel_request(
        db,
        family_id=run.family_id,
        run_id=run.id,
        for_update=True,
    )
    return request is not None and request.status in {"requested", "applied"}


def finalize_run_cancellation(db: Session, *, run: AIAgentRun) -> None:
    run.status = CANCELLED
    run.error = None
    request = _cancel_request(
        db,
        family_id=run.family_id,
        run_id=run.id,
        for_update=True,
    )
    if request is not None:
        request.status = "applied"
        request.outcome_code = "cancelled"
        request.resolved_at = request.resolved_at or utcnow()
    messages = list(
        db.scalars(
            select(AIMessage)
            .where(
                AIMessage.family_id == run.family_id,
                AIMessage.run_id == run.id,
                AIMessage.role == "assistant",
            )
            .order_by(AIMessage.created_at.asc(), AIMessage.id.asc())
            .with_for_update()
        )
    )
    for message in messages:
        message.status = CANCELLED
        metadata = dict(message.message_metadata or {})
        metadata.pop("liveStreaming", None)
        metadata.pop("livePartIds", None)
        metadata.pop("liveTextPartIds", None)
        message.message_metadata = metadata
    if run.conversation_id:
        conversation = db.scalar(
            select(AIConversation)
            .where(
                AIConversation.id == run.conversation_id,
                AIConversation.family_id == run.family_id,
            )
            .with_for_update()
        )
        if conversation is not None:
            conversation.last_run_status = CANCELLED
            conversation.last_message_at = utcnow()
            context = dict(conversation.context or {})
            context.pop("activeRunId", None)
            conversation.context = context


def serialize_run_cancellation_result(result: RunCancellationResult) -> dict:
    return {
        "outcome": result.outcome,
        "request": serialize_ai_run_cancel_request(result.request),
        "run": serialize_ai_run(result.run) if result.run is not None else None,
        "events": [serialize_ai_run_event(event) for event in result.events],
    }
