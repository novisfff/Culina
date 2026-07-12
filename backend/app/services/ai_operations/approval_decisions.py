from __future__ import annotations

from collections.abc import Callable
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError
from app.core.enums import ActivityAction
from app.core.utils import create_id, utcnow
from app.models.domain import AIApprovalRequest, AIConversation, AIOperation, AITaskDraft, AIUserApproval
from app.services.activity import log_activity
from app.services.ai_operations.approval_requests import create_retry_ai_approval
from app.services.ai_operations.approval_values import validate_approval_values, validate_rejection_values
from app.services.ai_operations.artifacts import approval_decision_artifacts
from app.services.ai_operations.common import assert_updated_at_matches, is_database_lock_conflict
from app.services.ai_operations.executor import execute_ai_operation_draft
from app.services.ai_operations.highlights import classify_approval_highlight
from app.services.ai_operations.messages import (
    append_message_approval_part,
    append_message_result_card,
    persist_message_artifacts,
    sync_message_approval_parts,
)
from app.services.ai_operations.recovery import build_failure_summary
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import DraftPostExecuteContext
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_operation,
    serialize_ai_task_draft,
)

ResolveUserId = Callable[[str], str | None]

logger = logging.getLogger(__name__)


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
        select(AIConversation).where(AIConversation.id == conversation_id, AIConversation.family_id == family_id)
    )
    if conversation is None:
        raise LookupError("会话不存在")
    try:
        approval = db.scalar(
            select(AIApprovalRequest).where(
                AIApprovalRequest.id == approval_id,
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.conversation_id == conversation_id,
            ).with_for_update(nowait=True)
        )
        if approval is None:
            raise LookupError("确认请求不存在")
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
    if approval.status != "pending":
        raise AIConflictError("确认请求已处理，不能重复提交")
    if draft.status not in {"pending", "pending_retry"}:
        raise AIConflictError("草稿已处理，不能重复提交")
    if draft_version != draft.version or approval.draft_version != draft.version:
        raise AIConflictError("草稿已更新，请重新确认")
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

    operation: AIOperation | None = None
    business_entity: dict[str, Any] | None = None
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
        db.add(
            AIUserApproval(
                id=create_id("ai_user_approval"),
                family_id=family_id,
                approval_request_id=approval.id,
                draft_id=draft.id,
                approved_by=user_id,
                approved_at=now,
                decision=decision,
                approval_payload=submitted_values,
                operation_summary={},
                comment=approval.comment,
            )
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
    config = draft_operation_registry.approval_config_for_payload(draft.draft_type, draft.payload)
    submitted_payload = submitted_values[config["value_key"]]
    config = draft_operation_registry.approval_config_for_payload(draft.draft_type, submitted_payload)
    try:
        existing_operation = db.scalar(
            select(AIOperation)
            .where(
                AIOperation.approval_request_id == approval.id,
                AIOperation.family_id == family_id,
            )
            .with_for_update(nowait=True)
        )
    except OperationalError as exc:
        if is_database_lock_conflict(exc):
            raise AIConflictError("确认请求正在处理，请稍后刷新或重试") from exc
        raise
    if existing_operation is not None:
        raise AIConflictError("该确认请求已经创建过执行操作")
    operation = AIOperation(
        id=create_id("ai_operation"),
        family_id=family_id,
        approval_request_id=approval.id,
        draft_id=draft.id,
        operation_type=config["operation_type"],
        status="running",
        business_entity_type=config["business_entity_type"],
        business_entity_ids=[],
        idempotency_key=f"{approval.id}:{config['operation_type']}:v{draft.version}",
    )
    try:
        db.add(operation)
        db.flush()
    except IntegrityError as exc:
        raise AIConflictError("该确认请求已经创建过执行操作") from exc
    decision_approval = approval
    operation_summary: dict[str, Any] = {}
    try:
        with db.begin_nested():
            business_entity, entity_ids = execute_ai_operation_draft(
                db,
                family_id=family_id,
                user_id=user_id,
                draft_type=draft.draft_type,
                payload=submitted_payload,
                assert_updated_at_matches=assert_updated_at_matches,
                conversation_id=conversation_id,
            )
            draft_operation_registry.after_success(
                DraftPostExecuteContext(
                    db=db,
                    draft_type=draft.draft_type,
                    family_id=family_id,
                    user_id=user_id,
                    message_id=draft.message_id,
                    business_entity=business_entity,
                )
            )
            highlight = classify_approval_highlight(
                draft_operation_registry,
                draft_type=draft.draft_type,
                submitted_payload=submitted_payload,
                business_entity=business_entity,
            )
            if highlight is not None:
                log_activity(
                    db,
                    family_id=family_id,
                    actor_id=user_id,
                    action=ActivityAction.UPDATE,
                    entity_type="AIOperation",
                    entity_id=operation.id,
                    summary="AI 审批业务操作执行成功",
                    highlight=highlight,
                )
            db.flush()

        operation.status = "succeeded"
        operation.business_entity_ids = entity_ids
        operation.completed_at = utcnow()
        draft.status = "confirmed"
        draft.payload = submitted_payload
        draft.updated_by = user_id
        operation_summary = {"operationId": operation.id, "entityIds": entity_ids}
        logger.info(
            "AI approval operation succeeded family_id=%s user_id=%s conversation_id=%s approval_id=%s draft_id=%s draft_type=%s operation_id=%s entity_ids=%s",
            family_id,
            user_id,
            conversation_id,
            approval.id,
            draft.id,
            draft.draft_type,
            operation.id,
            entity_ids,
        )
    except Exception as exc:
        failure_summary = build_failure_summary(
            db,
            family_id=family_id,
            draft_type=draft.draft_type,
            payload=submitted_payload,
            error_message=str(exc),
        )
        logger.exception(
            "AI approval operation failed family_id=%s user_id=%s conversation_id=%s approval_id=%s draft_id=%s draft_type=%s operation_id=%s",
            family_id,
            user_id,
            conversation_id,
            approval.id,
            draft.id,
            draft.draft_type,
            operation.id,
        )
        operation.status = "failed"
        operation.error_message = str(exc)
        draft.status = "pending_retry"
        draft.payload = submitted_payload
        draft.updated_by = user_id
        operation_summary = failure_summary
        retry_approval = create_retry_ai_approval(
            db,
            family_id=family_id,
            user_id=user_id,
            conversation_id=conversation_id,
            message_id=approval.message_id,
            run_id=approval.run_id,
            draft=draft,
            values=submitted_values,
            error_message=str(exc),
            failure_summary=failure_summary,
        )
        sync_message_approval_parts(db, draft=draft, approval=decision_approval)
        append_message_approval_part(db, approval=retry_approval)
        approval = retry_approval
    db.add(
        AIUserApproval(
            id=create_id("ai_user_approval"),
            family_id=family_id,
            approval_request_id=decision_approval.id,
            draft_id=draft.id,
            approved_by=user_id,
            approved_at=now,
            decision=decision,
            approval_payload=submitted_values,
            operation_summary=operation_summary,
            comment=decision_approval.comment,
        )
    )
    db.flush()
    sync_message_approval_parts(db, draft=draft, approval=approval)
    decision_result = {
        "approval": serialize_ai_approval_request(approval),
        "draft": serialize_ai_task_draft(draft),
        "operation": serialize_ai_operation(operation),
        "business_entity": business_entity,
    }
    append_message_result_card(db, decision_result=decision_result)
    persist_message_artifacts(
        db,
        message_id=approval.message_id,
        artifacts=approval_decision_artifacts(
            approval=decision_result["approval"],
            draft=decision_result["draft"],
            operation=decision_result["operation"],
            business_entity=decision_result["business_entity"],
        ),
    )

    return decision_result
