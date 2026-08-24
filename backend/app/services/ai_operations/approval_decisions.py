from __future__ import annotations

from collections.abc import Callable
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.utils import create_id, utcnow
from app.models.domain import AIApprovalRequest, AIConversation, AIOperation, AITaskDraft, AIUserApproval
from app.services.ai_auto_execution.policy_types import DraftCommitRequest
from app.services.ai_operations.approval_requests import create_retry_ai_approval
from app.services.ai_operations.approval_values import validate_approval_values, validate_rejection_values
from app.services.ai_operations.artifacts import approval_decision_artifacts
from app.services.ai_operations.commit_coordinator import DraftCommitCoordinator
from app.services.ai_operations.common import is_database_lock_conflict
from app.services.ai_operations.messages import (
    append_message_approval_part,
    append_message_result_card,
    persist_message_artifacts,
    sync_message_approval_parts,
)
from app.services.ai_operations.recovery import build_failure_summary
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_operation,
    serialize_ai_task_draft,
)


ResolveUserId = Callable[[str], str | None]
logger = logging.getLogger(__name__)


def _lock_approval_and_draft(
    db: Session,
    *,
    family_id: str,
    conversation_id: str,
    approval_id: str,
) -> tuple[AIApprovalRequest, AITaskDraft, Any]:
    try:
        approval_ref = db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
        )
    except OperationalError as exc:
        if is_database_lock_conflict(exc):
            raise AIConflictError("确认请求正在处理，请稍后刷新或重试") from exc
        raise
    if approval_ref is None:
        raise LookupError("确认请求不存在")
    run = (
        lock_run_for_transition(db, family_id=family_id, run_id=approval_ref.run_id)
        if approval_ref.run_id
        else None
    )
    try:
        approval = db.scalar(
            select(AIApprovalRequest)
            .where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            )
            .with_for_update(nowait=True)
        )
        if approval is None:
            raise LookupError("确认请求不存在")
        if (run is None and approval.run_id is not None) or (
            run is not None and approval.run_id != run.id
        ):
            raise AIConflictError("确认请求关联的运行状态已变化，请刷新后重试")
        draft = db.scalar(
            select(AITaskDraft)
            .where(AITaskDraft.id == approval.draft_id, AITaskDraft.family_id == family_id)
            .with_for_update(nowait=True)
        )
        if draft is None:
            raise LookupError("草稿不存在")
    except OperationalError as exc:
        if is_database_lock_conflict(exc):
            raise AIConflictError("确认请求正在处理，请稍后刷新或重试") from exc
        raise
    return approval, draft, run


def _record_user_approval_once(
    db: Session,
    *,
    family_id: str,
    approval: AIApprovalRequest,
    draft: AITaskDraft,
    user_id: str,
    approved_at: Any,
    decision: str,
    submitted_values: dict[str, Any],
    operation_summary: dict[str, Any],
) -> None:
    existing = db.scalar(
        select(AIUserApproval.id).where(
            AIUserApproval.family_id == family_id,
            AIUserApproval.approval_request_id == approval.id,
            AIUserApproval.draft_id == draft.id,
        )
    )
    if existing is not None:
        return
    db.add(
        AIUserApproval(
            id=create_id("ai_user_approval"),
            family_id=family_id,
            approval_request_id=approval.id,
            draft_id=draft.id,
            approved_by=user_id,
            approved_at=approved_at,
            decision=decision,
            approval_payload=submitted_values,
            operation_summary=operation_summary,
            comment=approval.comment,
        )
    )


def apply_ai_approval_decision(
    db: Session,
    *,
    family_id: str,
    user_id: str,
    conversation_id: str,
    approval_id: str,
    decision: str,
    draft_version: int,
    values: dict[str, Any],
    resolve_user_id: ResolveUserId,
    comment: str | None = None,
) -> dict[str, Any]:
    conversation = db.scalar(
        select(AIConversation).where(
            AIConversation.id == conversation_id,
            AIConversation.family_id == family_id,
        )
    )
    if conversation is None:
        raise LookupError("会话不存在")
    approval, draft, run = _lock_approval_and_draft(
        db,
        family_id=family_id,
        conversation_id=conversation_id,
        approval_id=approval_id,
    )
    if approval.status != "pending":
        raise AIConflictError("确认请求已处理，不能重复提交")
    if draft.status not in {"pending", "pending_retry"}:
        raise AIConflictError("草稿已处理，不能重复提交")
    if draft_version != draft.version or approval.draft_version != draft.version:
        raise AIConflictError("草稿已更新，请重新确认")
    if run is not None and cancellation_wins(db, run=run, lock_request=False):
        finalize_run_cancellation(db, run=run)
        raise AIConflictError("运行任务已取消，不能继续提交确认")
    if decision == "rejected" and approval.request_payload.get("requireRejectComment") and not (comment or "").strip():
        raise ValueError("请填写拒绝原因")

    submitted_values = (
        validate_approval_values(
            db,
            approval=approval,
            draft=draft,
            values=values,
            resolve_user_id=resolve_user_id,
            enforce_required=True,
        )
        if decision == "approved"
        else validate_rejection_values(approval, values)
    )
    now = utcnow()
    approval.status = "approved" if decision == "approved" else "rejected"
    approval.decision = decision
    approval.comment = (comment or "").strip() or None
    approval.submitted_values = submitted_values
    approval.resolved_at = now
    approval.updated_by = user_id

    if decision == "rejected":
        logger.info(
            "AI approval rejected family_id=%s user_id=%s conversation_id=%s approval_id=%s draft_id=%s draft_type=%s",
            family_id,
            user_id,
            conversation_id,
            approval.id,
            draft.id,
            draft.draft_type,
        )
        draft.status = "rejected"
        draft.updated_by = user_id
        _record_user_approval_once(
            db,
            family_id=family_id,
            approval=approval,
            draft=draft,
            user_id=user_id,
            approved_at=now,
            decision=decision,
            submitted_values=submitted_values,
            operation_summary={},
        )
        db.flush()
        sync_message_approval_parts(db, draft=draft, approval=approval)
        return {
            "approval": serialize_ai_approval_request(approval),
            "draft": serialize_ai_task_draft(draft),
            "operation": None,
            "business_entity": None,
        }

    if not draft_operation_registry.supports(draft.draft_type):
        raise ValueError("暂不支持的草稿类型")
    initial_config = draft_operation_registry.approval_config_for_payload(draft.draft_type, draft.payload)
    submitted_payload = submitted_values[initial_config["value_key"]]
    draft_operation_registry.approval_config_for_payload(draft.draft_type, submitted_payload)
    request = DraftCommitRequest(
        family_id=family_id,
        actor_user_id=user_id,
        conversation_id=conversation_id,
        run_id=run.id if run is not None else None,
        draft_id=draft.id,
        draft_version=draft.version,
        committed_payload=submitted_payload,
        execution_mode="manual_approval",
        authorization_source="approval_request",
        authorization_snapshot={"approval_request_id": approval.id, "draft_version": draft.version},
        approval_request_id=approval.id,
        policy_key=None,
        policy_version=None,
        policy_reason_codes=(),
        committed_at=now,
    )
    commit_result = DraftCommitCoordinator.commit_locked(
        db,
        request=request,
        locked_run=run,
        locked_draft=draft,
    )

    # A connection-level failure may invalidate the whole outer transaction.
    # Re-apply the genuine human facts before adding recovery state.
    decision_approval = db.get(AIApprovalRequest, approval_id)
    committed_draft = db.get(AITaskDraft, draft.id)
    operation = db.get(AIOperation, commit_result.operation_id)
    if decision_approval is None or committed_draft is None or operation is None:
        raise AIConflictError("确认执行结果恢复失败，请刷新后重试")
    decision_approval.status = "approved"
    decision_approval.decision = "approved"
    decision_approval.comment = (comment or "").strip() or None
    decision_approval.submitted_values = submitted_values
    decision_approval.resolved_at = now
    decision_approval.updated_by = user_id

    response_approval = decision_approval
    if operation.status == "succeeded":
        operation_summary: dict[str, Any] = {
            "operationId": operation.id,
            "entityIds": list(operation.business_entity_ids or []),
        }
        logger.info(
            "AI approval operation succeeded family_id=%s user_id=%s conversation_id=%s approval_id=%s draft_id=%s draft_type=%s operation_id=%s entity_ids=%s",
            family_id,
            user_id,
            conversation_id,
            decision_approval.id,
            committed_draft.id,
            committed_draft.draft_type,
            operation.id,
            operation.business_entity_ids,
        )
    else:
        failure_summary = build_failure_summary(
            db,
            family_id=family_id,
            draft_type=committed_draft.draft_type,
            payload=submitted_payload,
            error_message=operation.error_message or "写入失败",
        )
        operation_summary = failure_summary
        committed_draft.status = "pending_retry"
        response_approval = create_retry_ai_approval(
            db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            message_id=decision_approval.message_id,
            run_id=decision_approval.run_id,
            draft=committed_draft,
            values=submitted_values,
            error_message=operation.error_message or "写入失败",
            failure_summary=failure_summary,
        )
        sync_message_approval_parts(db, draft=committed_draft, approval=decision_approval)
        append_message_approval_part(db, approval=response_approval)

    _record_user_approval_once(
        db,
        family_id=family_id,
        approval=decision_approval,
        draft=committed_draft,
        user_id=user_id,
        approved_at=now,
        decision="approved",
        submitted_values=submitted_values,
        operation_summary=operation_summary,
    )
    db.flush()
    sync_message_approval_parts(db, draft=committed_draft, approval=response_approval)

    business_entity = commit_result.receipt.business_entity or None
    decision_result = {
        "approval": serialize_ai_approval_request(response_approval),
        "draft": serialize_ai_task_draft(committed_draft),
        "operation": serialize_ai_operation(operation),
        "business_entity": business_entity,
    }
    append_message_result_card(db, decision_result=decision_result)
    persist_message_artifacts(
        db,
        message_id=decision_approval.message_id,
        artifacts=approval_decision_artifacts(
            approval=serialize_ai_approval_request(decision_approval),
            draft=decision_result["draft"],
            operation=decision_result["operation"],
            business_entity=business_entity,
        ),
    )

    if run is not None and cancellation_wins(db, run=run):
        finalize_run_cancellation(db, run=run)
        decision_result["suppress_continuation"] = True
    return decision_result
