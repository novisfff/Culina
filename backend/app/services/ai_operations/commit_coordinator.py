from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import replace
from datetime import datetime, timedelta
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError, AutoExecutionBlockRequired
from app.core.enums import ActivityAction
from app.core.utils import utcnow
from app.models.domain import (
    AIAgentRun,
    AIApprovalRequest,
    AIOperation,
    AITaskDraft,
)
from app.repos.ai_operations import (
    acquire_draft_operation,
    claim_failed_operation_for_retry,
    operation_for_draft_for_update,
)
from app.services.activity import log_activity
from app.services.ai_auto_execution.policies._common import active_actor
from app.services.ai_auto_execution.policy_registry import auto_execution_policy_registry
from app.services.ai_auto_execution.policy_types import (
    AutoExecutionPolicyContext,
    DraftCommitRequest,
    DraftCommitResult,
    DraftExecutionReceipt,
    IntentEvidenceValidation,
)
from app.services.ai_auto_execution.settings import resolve_effective_authorization
from app.services.ai_operations.artifacts import (
    approval_decision_artifacts,
    build_approval_result_card,
)
from app.services.ai_operations.common import assert_updated_at_matches, is_database_lock_conflict
from app.services.ai_operations.executor import execute_ai_operation_draft
from app.services.ai_operations.highlights import classify_approval_highlight
from app.services.ai_operations.result_projection import (
    build_operation_result_card,
    operation_result_artifacts,
    project_ai_operation_result,
    upsert_message_operation_result,
)
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.registry_types import DraftPostExecuteContext
from app.services.ai_operations.status import (
    DRAFT_EXECUTION_FAILED,
    DRAFT_EXECUTED,
    DRAFT_PENDING_RETRY,
    is_operation_completed,
    normalize_draft_status,
)
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    lock_run_for_transition,
)
from app.services.ai_operations.run_blocking import (
    auto_execution_blocked_record,
    persist_run_auto_execution_blocked_after_rollback,
)
from app.services.serializers import (
    serialize_ai_approval_request,
    serialize_ai_operation,
    serialize_ai_task_draft,
)


logger = logging.getLogger(__name__)

TRANSIENT_DATABASE_ERROR_CODE = "draft_commit_transient_database_error"
DOMAIN_CONFLICT_ERROR_CODE = "draft_commit_domain_conflict"
DOMAIN_FAILURE_ERROR_CODE = "draft_commit_domain_failed"
DATABASE_FAILURE_ERROR_CODE = "draft_commit_database_error"
DATABASE_FAILURE_ERROR_MESSAGE = "数据库写入失败，请稍后重试"
DOMAIN_CONFLICT_ERROR_MESSAGE = "目标状态已变化，请刷新后重新生成草稿"
DOMAIN_FAILURE_ERROR_MESSAGE = "操作未能完成，请稍后重新生成草稿"
REVERT_WINDOW = timedelta(hours=1)
TRANSIENT_DATABASE_ERROR_MESSAGE = "数据库暂时不可用，请重试原草稿"
DATABASE_CONNECTION_FAILURE_CODES = {2006, 2013, 2055}
DATABASE_CONNECTION_FAILURE_MARKERS = (
    "server has gone away",
    "lost connection",
    "connection reset",
    "connection refused",
    "connection is closed",
)


def _is_retryable_database_failure(error: OperationalError) -> bool:
    if is_database_lock_conflict(error) or bool(getattr(error, "connection_invalidated", False)):
        return True

    def matches(value: object) -> bool:
        if isinstance(value, int):
            return value in DATABASE_CONNECTION_FAILURE_CODES
        if isinstance(value, str):
            normalized = value.lower()
            return any(marker in normalized for marker in DATABASE_CONNECTION_FAILURE_MARKERS)
        if isinstance(value, BaseException):
            return any(matches(arg) for arg in value.args)
        if isinstance(value, tuple | list):
            return any(matches(item) for item in value)
        return False

    return any(matches(candidate) for candidate in (error, getattr(error, "orig", None)))


def derive_draft_operation_idempotency_key(draft_id: str, draft_version: int) -> str:
    digest = hashlib.sha256(f"{draft_id}\0{draft_version}".encode("utf-8")).hexdigest()
    return f"ai-draft:{digest}"


def derive_draft_payload_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _payload_contains_recipe_cook(draft_type: str, payload: dict[str, Any] | None) -> bool:
    if draft_type == "recipe_cook":
        return True
    if draft_type != "composite_operation" or not isinstance(payload, dict):
        return False
    steps = payload.get("steps")
    return isinstance(steps, list) and any(
        isinstance(step, dict) and str(step.get("domain") or "") == "recipe_cook"
        for step in steps
    )


def _empty_receipt() -> DraftExecutionReceipt:
    return DraftExecutionReceipt(
        business_entity={},
        entity_ids=(),
        cache_scopes=("ai_conversation",),
        revert_adapter_key=None,
        revert_context=None,
    )


def _apply_operation_request_audit(
    operation: AIOperation,
    *,
    request: DraftCommitRequest,
) -> None:
    operation.actor_user_id = request.actor_user_id
    operation.approval_request_id = request.approval_request_id
    operation.authorization_source = request.authorization_source
    operation.authorization_snapshot_json = dict(request.authorization_snapshot)


class DraftCommitCoordinator:
    @classmethod
    def commit_locked(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        locked_run: AIAgentRun | None,
        locked_draft: AITaskDraft,
    ) -> DraftCommitResult:
        cls._validate_locked_request(
            db,
            request=request,
            locked_run=locked_run,
            locked_draft=locked_draft,
        )
        try:
            with db.begin_nested():
                return cls._commit_inside_savepoint(
                    db,
                    request=request,
                    locked_run=locked_run,
                    locked_draft=locked_draft,
                    retry_operation_id=None,
                )
        except OperationalError as error:
            if _is_retryable_database_failure(error):
                return cls._recover_retryable_database_failure(
                    db,
                    request=request,
                    locked_run=locked_run,
                    locked_draft=locked_draft,
                    error=error,
                )
            if request.execution_mode != "policy_auto":
                raise
            logger.exception(
                "AI policy draft commit terminal database failure family_id=%s draft_id=%s",
                request.family_id,
                request.draft_id,
            )
            return cls._recover_terminal_database_failure(
                db,
                request=request,
                locked_run=locked_run,
                locked_draft=locked_draft,
            )

    @classmethod
    def retry_pending_locked(
        cls,
        db: Session,
        *,
        family_id: str,
        actor_user_id: str,
        locked_run: AIAgentRun,
        locked_draft: AITaskDraft,
        expected_payload_hash: str,
        now: datetime,
    ) -> DraftCommitResult:
        if locked_run.family_id != family_id or locked_draft.family_id != family_id:
            raise AIConflictError("重试对象不属于当前家庭")
        if locked_draft.source_run_id != locked_run.id:
            raise AIConflictError("重试草稿关联的运行已变化")
        if locked_draft.execution_route != "policy_auto":
            raise AIConflictError("人工确认草稿必须通过原重试确认处理")
        if normalize_draft_status(locked_draft.status) != DRAFT_PENDING_RETRY:
            raise AIConflictError("草稿不处于可重试状态")
        if db.scalar(
            select(AIApprovalRequest.id).where(
                AIApprovalRequest.family_id == family_id,
                AIApprovalRequest.draft_id == locked_draft.id,
                AIApprovalRequest.approval_type.like("%.retry"),
            )
        ) is not None:
            raise AIConflictError("人工确认草稿必须通过原重试确认处理")
        if expected_payload_hash != locked_draft.payload_hash:
            raise AIConflictError("草稿载荷已变化，不能重试原操作")
        if derive_draft_payload_hash(locked_draft.payload) != locked_draft.payload_hash:
            raise AIConflictError("草稿载荷摘要不匹配，不能执行")
        if locked_run.created_by != actor_user_id:
            raise AIConflictError("只能由原执行人重试自动操作")
        if not active_actor(db, family_id=family_id, actor_user_id=actor_user_id):
            raise AIConflictError("当前用户已不是有效家庭成员")
        if not locked_run.auto_execution_attempted:
            raise AIConflictError("该运行没有可恢复的自动执行尝试")
        if cancellation_wins(db, run=locked_run, lock_request=False):
            raise AIConflictError("运行任务已取消，不能重试自动操作")

        operation_key = derive_draft_operation_idempotency_key(
            locked_draft.id,
            locked_draft.version,
        )
        operation_snapshot = db.scalar(
            select(AIOperation).where(
                AIOperation.family_id == family_id,
                AIOperation.draft_id == locked_draft.id,
                AIOperation.idempotency_key == operation_key,
            )
        )
        if operation_snapshot is None:
            any_operation = db.scalar(
                select(AIOperation.id).where(
                    AIOperation.family_id == family_id,
                    AIOperation.draft_id == locked_draft.id,
                )
            )
            if any_operation is not None:
                raise AIConflictError("草稿版本已变化，不能重试原操作")
            raise AIConflictError("没有可恢复的自动执行操作")
        cls._validate_operation_identity(
            operation_snapshot,
            request_payload=locked_draft.payload,
            request_mode="policy_auto",
            operation_type=operation_snapshot.operation_type,
            family_id=family_id,
            draft_id=locked_draft.id,
            run_id=locked_run.id,
        )
        if is_operation_completed(operation_snapshot.status):
            return cls._replay_result(db, operation=operation_snapshot, draft=locked_draft)

        # Re-resolve the server-owned catalog authorization before locking the
        # Operation row and the domain service's own target locks.
        policy_key = str(operation_snapshot.policy_key or locked_draft.policy_key or "")
        policy_version = str(operation_snapshot.policy_version or locked_draft.policy_version or "")
        authorization = resolve_effective_authorization(
            db,
            family_id=family_id,
            actor_user_id=actor_user_id,
            action_key=policy_key,
            policy_version=policy_version,
            for_update=True,
        )
        if not authorization.enabled:
            raise AIConflictError("自动执行授权已变化，不能重试原操作")
        cls._recheck_policy_target(
            db,
            draft=locked_draft,
            actor_user_id=actor_user_id,
            authorization=authorization,
        )

        db.expire(operation_snapshot)
        operation = operation_for_draft_for_update(
            db,
            family_id=family_id,
            draft_id=locked_draft.id,
            idempotency_key=operation_key,
        )
        if operation is None:
            raise AIConflictError("没有可恢复的自动执行操作")
        cls._validate_operation_identity(
            operation,
            request_payload=locked_draft.payload,
            request_mode="policy_auto",
            operation_type=operation.operation_type,
            family_id=family_id,
            draft_id=locked_draft.id,
            run_id=locked_run.id,
        )
        if is_operation_completed(operation.status):
            return cls._replay_result(db, operation=operation, draft=locked_draft)
        if operation.status != "failed" or operation.error_code != TRANSIENT_DATABASE_ERROR_CODE:
            raise AIConflictError("只有临时数据库失败可以重试原草稿")
        if locked_run.auto_operation_id not in {None, operation.id}:
            raise AIConflictError("运行已关联其他自动执行操作")
        if operation.actor_user_id != actor_user_id:
            raise AIConflictError("自动执行操作的原执行人已变化")
        if (
            authorization.source != operation.authorization_source
            or dict(authorization.snapshot) != dict(operation.authorization_snapshot_json or {})
        ):
            raise AIConflictError("自动执行授权已变化，不能重试原操作")

        request = DraftCommitRequest(
            family_id=family_id,
            actor_user_id=actor_user_id,
            conversation_id=locked_draft.conversation_id,
            run_id=locked_run.id,
            draft_id=locked_draft.id,
            draft_version=locked_draft.version,
            committed_payload=dict(operation.committed_payload_json or {}),
            execution_mode="policy_auto",
            authorization_source=operation.authorization_source,  # type: ignore[arg-type]
            authorization_snapshot=dict(operation.authorization_snapshot_json or {}),
            approval_request_id=None,
            policy_key=operation.policy_key,
            policy_version=operation.policy_version,
            policy_reason_codes=tuple(operation.policy_reason_codes or ()),
            committed_at=now,
        )
        try:
            with db.begin_nested():
                return cls._commit_inside_savepoint(
                    db,
                    request=request,
                    locked_run=locked_run,
                    locked_draft=locked_draft,
                    retry_operation_id=operation.id,
                )
        except OperationalError as exc:
            if db.get_bind().dialect.name == "sqlite" and "database is locked" in str(exc).lower():
                return cls._replay_after_sqlite_recovery_lock(
                    db,
                    family_id=family_id,
                    run_id=locked_run.id,
                    draft_id=locked_draft.id,
                    operation_key=operation_key,
                )
            if _is_retryable_database_failure(exc):
                return cls._recover_retryable_database_failure(
                    db,
                    request=request,
                    locked_run=locked_run,
                    locked_draft=locked_draft,
                    error=exc,
                )
            logger.exception(
                "AI policy draft retry terminal database failure family_id=%s draft_id=%s",
                request.family_id,
                request.draft_id,
            )
            return cls._recover_terminal_database_failure(
                db,
                request=request,
                locked_run=locked_run,
                locked_draft=locked_draft,
            )

    @classmethod
    def _replay_after_sqlite_recovery_lock(
        cls,
        db: Session,
        *,
        family_id: str,
        run_id: str,
        draft_id: str,
        operation_key: str,
    ) -> DraftCommitResult:
        """Emulate the production FOR UPDATE wait on SQLite test/dev databases."""
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        run = lock_run_for_transition(db, family_id=family_id, run_id=run_id)
        draft = db.scalar(
            select(AITaskDraft)
            .where(AITaskDraft.id == draft_id, AITaskDraft.family_id == family_id)
            .with_for_update()
        )
        operation = operation_for_draft_for_update(
            db,
            family_id=family_id,
            draft_id=draft_id,
            idempotency_key=operation_key,
        )
        if draft is None or operation is None or draft.source_run_id != run.id:
            raise AIConflictError("并发恢复后草稿或操作已变化")
        if is_operation_completed(operation.status):
            return cls._replay_result(db, operation=operation, draft=draft)
        raise AIConflictError("该草稿操作正在由另一请求恢复")

    @classmethod
    def _validate_locked_request(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        locked_run: AIAgentRun | None,
        locked_draft: AITaskDraft,
    ) -> None:
        del cls
        if not request.actor_user_id.strip():
            raise AIConflictError("草稿提交缺少有效执行人")
        if locked_draft.id != request.draft_id:
            raise AIConflictError("锁定草稿与提交请求不一致")
        if locked_draft.family_id != request.family_id:
            raise AIConflictError("草稿不属于当前家庭")
        if locked_draft.conversation_id != request.conversation_id:
            raise AIConflictError("草稿所属会话已变化")
        if locked_draft.version != request.draft_version:
            raise AIConflictError("草稿版本已变化，不能执行")
        if derive_draft_payload_hash(locked_draft.payload) != locked_draft.payload_hash:
            raise AIConflictError("草稿载荷摘要不匹配，不能执行")
        if request.run_id is None:
            if locked_run is not None or locked_draft.source_run_id is not None:
                raise AIConflictError("草稿关联的运行状态已变化")
        elif (
            locked_run is None
            or locked_run.id != request.run_id
            or locked_run.family_id != request.family_id
            or locked_draft.source_run_id != locked_run.id
        ):
            raise AIConflictError("草稿关联的运行状态已变化")
        if request.execution_mode == "manual_approval":
            if request.authorization_source != "approval_request" or not request.approval_request_id:
                raise AIConflictError("人工提交缺少真实确认依据")
            approval = db.get(AIApprovalRequest, request.approval_request_id)
            if (
                approval is None
                or approval.family_id != request.family_id
                or approval.conversation_id != request.conversation_id
                or approval.draft_id != locked_draft.id
                or approval.draft_version != locked_draft.version
                or approval.status != "approved"
                or approval.decision != "approved"
                or approval.updated_by != request.actor_user_id
            ):
                raise AIConflictError("人工确认事实与提交请求不一致")
        else:
            if request.approval_request_id is not None or locked_draft.execution_route != "policy_auto":
                raise AIConflictError("自动提交不能关联人工确认")
            if locked_run is None or locked_run.created_by != request.actor_user_id:
                raise AIConflictError("自动提交执行人和原运行不一致")
            if not locked_run.auto_execution_attempted:
                raise AIConflictError("该运行尚未通过单次自动执行门禁")
            if derive_draft_payload_hash(request.committed_payload) != locked_draft.payload_hash:
                raise AIConflictError("自动提交载荷与锁定草稿不一致")
        if not draft_operation_registry.supports(locked_draft.draft_type):
            raise ValueError("暂不支持的草稿类型")

    @classmethod
    def _commit_inside_savepoint(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        locked_run: AIAgentRun | None,
        locked_draft: AITaskDraft,
        retry_operation_id: str | None,
    ) -> DraftCommitResult:
        config = draft_operation_registry.approval_config_for_payload(
            locked_draft.draft_type,
            request.committed_payload,
        )
        operation_key = derive_draft_operation_idempotency_key(
            request.draft_id,
            request.draft_version,
        )
        operation, created = acquire_draft_operation(
            db,
            request=request,
            idempotency_key=operation_key,
            operation_type=config["operation_type"],
            business_entity_type=config["business_entity_type"],
        )
        cls._validate_operation_identity(
            operation,
            request_payload=request.committed_payload,
            request_mode=request.execution_mode,
            operation_type=config["operation_type"],
            family_id=request.family_id,
            draft_id=request.draft_id,
            run_id=request.run_id,
        )
        if is_operation_completed(operation.status):
            return cls._replay_result(db, operation=operation, draft=locked_draft)
        if not created and operation.status == "failed":
            retry_allowed = retry_operation_id == operation.id
            if request.execution_mode == "manual_approval" and request.approval_request_id:
                approval = db.get(AIApprovalRequest, request.approval_request_id)
                retry_allowed = bool(
                    approval is not None
                    and approval.approval_type.endswith(".retry")
                )
            if not retry_allowed:
                return cls._failed_result(db, operation=operation, draft=locked_draft)
            expected_code = TRANSIENT_DATABASE_ERROR_CODE if request.execution_mode == "policy_auto" else None
            claimed = claim_failed_operation_for_retry(
                db,
                operation_id=operation.id,
                expected_error_code=expected_code,
            )
            if not claimed:
                db.expire(operation)
                db.refresh(operation)
                if is_operation_completed(operation.status):
                    return cls._replay_result(db, operation=operation, draft=locked_draft)
                raise AIConflictError("该草稿操作正在由另一请求恢复")
        elif not created and operation.status not in {"pending"}:
            raise AIConflictError("该草稿操作正在执行")

        _apply_operation_request_audit(operation, request=request)
        operation.status = "pending"
        if locked_run is not None and request.execution_mode == "policy_auto":
            locked_run.auto_operation_id = operation.id
        return cls._execute_and_persist(
            db,
            request=request,
            operation=operation,
            draft=locked_draft,
            locked_run=locked_run,
        )

    @classmethod
    def _execute_and_persist(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        operation: AIOperation,
        draft: AITaskDraft,
        locked_run: AIAgentRun | None,
    ) -> DraftCommitResult:
        receipt: DraftExecutionReceipt | None = None
        recipe_cook_effect = _payload_contains_recipe_cook(
            draft.draft_type,
            request.committed_payload,
        )
        revertible_until = request.committed_at + REVERT_WINDOW
        try:
            with db.begin_nested():
                receipt = execute_ai_operation_draft(
                    db,
                    family_id=request.family_id,
                    user_id=request.actor_user_id,
                    draft_type=draft.draft_type,
                    payload=request.committed_payload,
                    assert_updated_at_matches=assert_updated_at_matches,
                    operation_idempotency_key=operation.idempotency_key,
                    conversation_id=request.conversation_id,
                    committed_at=request.committed_at,
                    revertible_until=revertible_until,
                )
                if (draft.ai_metadata or {}).get("continuation") and receipt.revert_adapter_key:
                    receipt = replace(
                        receipt,
                        revert_adapter_key=None,
                        revert_context=None,
                    )
                if not recipe_cook_effect:
                    cls._run_post_execute(
                        db,
                        request=request,
                        operation=operation,
                        draft=draft,
                        receipt=receipt,
                    )
                db.flush()
            if recipe_cook_effect:
                cls._run_post_execute(
                    db,
                    request=request,
                    operation=operation,
                    draft=draft,
                    receipt=receipt,
                )
                db.flush()

            operation.status = "completed"
            operation.result_json = cls._receipt_to_json(receipt)
            operation.business_entity_ids = list(receipt.entity_ids)
            operation.error_code = None
            operation.error_message = None
            operation.failed_at = None
            operation.completed_at = utcnow()
            operation.revert_adapter_key = receipt.revert_adapter_key
            operation.revert_context_json = (
                dict(receipt.revert_context) if receipt.revert_context is not None else None
            )
            operation.revertible_until = revertible_until if receipt.revert_adapter_key else None
            # Both manual approval and policy authorization produce the same
            # canonical Draft outcome.  Approval provenance lives on the
            # Approval/Operation rows, not in a legacy ``confirmed`` spelling.
            draft.status = DRAFT_EXECUTED
            draft.payload = dict(request.committed_payload)
            draft.payload_hash = derive_draft_payload_hash(request.committed_payload)
            draft.updated_by = request.actor_user_id
            db.flush()
            return cls._persist_result(
                db,
                request=request,
                operation=operation,
                draft=draft,
                receipt=receipt,
            )
        except OperationalError:
            raise
        except DBAPIError:
            if request.execution_mode == "manual_approval" and locked_run is not None:
                if cancellation_wins(db, run=locked_run):
                    raise
            logger.exception(
                "AI draft commit database failure family_id=%s draft_id=%s operation_id=%s mode=%s",
                request.family_id,
                request.draft_id,
                operation.id,
                request.execution_mode,
            )
            return cls._persist_failed_execution(
                db,
                request=request,
                operation=operation,
                draft=draft,
                receipt=receipt,
                error_code=DATABASE_FAILURE_ERROR_CODE,
                error_message=DATABASE_FAILURE_ERROR_MESSAGE,
            )
        except SQLAlchemyError:
            if request.execution_mode == "manual_approval" and locked_run is not None:
                if cancellation_wins(db, run=locked_run):
                    raise
            logger.exception(
                "AI draft commit SQLAlchemy failure family_id=%s draft_id=%s operation_id=%s mode=%s",
                request.family_id,
                request.draft_id,
                operation.id,
                request.execution_mode,
            )
            return cls._persist_failed_execution(
                db,
                request=request,
                operation=operation,
                draft=draft,
                receipt=receipt,
                error_code=DATABASE_FAILURE_ERROR_CODE,
                error_message=DATABASE_FAILURE_ERROR_MESSAGE,
            )
        except AIConflictError as exc:
            if request.execution_mode == "manual_approval" and locked_run is not None:
                if cancellation_wins(db, run=locked_run):
                    raise
            logger.exception(
                "AI draft commit conflicted family_id=%s draft_id=%s operation_id=%s mode=%s",
                request.family_id,
                request.draft_id,
                operation.id,
                request.execution_mode,
            )
            return cls._persist_failed_execution(
                db,
                request=request,
                operation=operation,
                draft=draft,
                receipt=receipt,
                error_code=exc.code or DOMAIN_CONFLICT_ERROR_CODE,
                error_message=DOMAIN_CONFLICT_ERROR_MESSAGE,
                recovery_hint=exc.recovery_hint,
            )
        except Exception:
            if request.execution_mode == "manual_approval" and locked_run is not None:
                if cancellation_wins(db, run=locked_run):
                    raise
            logger.exception(
                "AI draft commit failed family_id=%s draft_id=%s operation_id=%s mode=%s",
                request.family_id,
                request.draft_id,
                operation.id,
                request.execution_mode,
            )
            return cls._persist_failed_execution(
                db,
                request=request,
                operation=operation,
                draft=draft,
                receipt=receipt,
                error_code=DOMAIN_FAILURE_ERROR_CODE,
                error_message=DOMAIN_FAILURE_ERROR_MESSAGE,
            )

    @classmethod
    def _persist_failed_execution(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        operation: AIOperation,
        draft: AITaskDraft,
        receipt: DraftExecutionReceipt | None,
        error_code: str,
        error_message: str,
        recovery_hint: str | None = None,
    ) -> DraftCommitResult:
        operation.status = "failed"
        operation.result_json = (
            {"failure": {"recovery_hint": recovery_hint}}
            if recovery_hint is not None
            else None
        )
        operation.business_entity_ids = []
        operation.error_code = error_code
        operation.error_message = error_message
        operation.failed_at = utcnow()
        operation.completed_at = None
        operation.revert_adapter_key = None
        operation.revert_context_json = None
        operation.revertible_until = None
        draft.status = DRAFT_PENDING_RETRY if request.execution_mode == "manual_approval" else DRAFT_EXECUTION_FAILED
        draft.payload = dict(request.committed_payload)
        draft.payload_hash = derive_draft_payload_hash(request.committed_payload)
        draft.updated_by = request.actor_user_id
        db.flush()
        return cls._persist_result(
            db,
            request=request,
            operation=operation,
            draft=draft,
            receipt=receipt or _empty_receipt(),
        )

    @classmethod
    def _run_post_execute(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        operation: AIOperation,
        draft: AITaskDraft,
        receipt: DraftExecutionReceipt,
    ) -> None:
        del cls
        draft_operation_registry.after_success(
            DraftPostExecuteContext(
                db=db,
                draft_type=draft.draft_type,
                family_id=request.family_id,
                user_id=request.actor_user_id,
                message_id=draft.message_id,
                business_entity=receipt.business_entity,
            )
        )
        highlight = classify_approval_highlight(
            draft_operation_registry,
            draft_type=draft.draft_type,
            submitted_payload=request.committed_payload,
            business_entity=receipt.business_entity,
        )
        if highlight is not None:
            log_activity(
                db,
                family_id=request.family_id,
                actor_id=request.actor_user_id,
                action=ActivityAction.UPDATE,
                entity_type="AIOperation",
                entity_id=operation.id,
                summary="AI 草稿业务操作执行成功",
                highlight=highlight,
            )

    @classmethod
    def _recover_retryable_database_failure(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        locked_run: AIAgentRun | None,
        locked_draft: AITaskDraft,
        error: OperationalError,
    ) -> DraftCommitResult:
        transaction = db.get_transaction()
        if transaction is not None and not transaction.is_active:
            db.rollback()
            locked_run, locked_draft = cls._relock_after_full_rollback(db, request=request)
        config = draft_operation_registry.approval_config_for_payload(
            locked_draft.draft_type,
            request.committed_payload,
        )
        operation_key = derive_draft_operation_idempotency_key(
            request.draft_id,
            request.draft_version,
        )
        with db.begin_nested():
            operation, _created = acquire_draft_operation(
                db,
                request=request,
                idempotency_key=operation_key,
                operation_type=config["operation_type"],
                business_entity_type=config["business_entity_type"],
            )
            cls._validate_operation_identity(
                operation,
                request_payload=request.committed_payload,
                request_mode=request.execution_mode,
                operation_type=config["operation_type"],
                family_id=request.family_id,
                draft_id=request.draft_id,
                run_id=request.run_id,
            )
            if is_operation_completed(operation.status):
                return cls._replay_result(db, operation=operation, draft=locked_draft)
            _apply_operation_request_audit(operation, request=request)
            operation.status = "failed"
            operation.error_code = TRANSIENT_DATABASE_ERROR_CODE
            logger.warning(
                "AI draft commit will require retry family_id=%s draft_id=%s mode=%s",
                request.family_id,
                request.draft_id,
                request.execution_mode,
                exc_info=error,
            )
            operation.error_message = TRANSIENT_DATABASE_ERROR_MESSAGE
            operation.failed_at = utcnow()
            operation.completed_at = None
            operation.result_json = None
            operation.business_entity_ids = []
            locked_draft.status = DRAFT_PENDING_RETRY
            locked_draft.payload = dict(request.committed_payload)
            locked_draft.payload_hash = derive_draft_payload_hash(request.committed_payload)
            locked_draft.updated_by = request.actor_user_id
            if locked_run is not None and request.execution_mode == "policy_auto":
                locked_run.auto_operation_id = operation.id
            db.flush()
            return cls._persist_result(
                db,
                request=request,
                operation=operation,
                draft=locked_draft,
                receipt=_empty_receipt(),
            )

    @classmethod
    def _recover_terminal_database_failure(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        locked_run: AIAgentRun | None,
        locked_draft: AITaskDraft,
    ) -> DraftCommitResult:
        try:
            transaction = db.get_transaction()
            if transaction is not None and not transaction.is_active:
                db.rollback()
                locked_run, locked_draft = cls._relock_after_full_rollback(db, request=request)
                if request.execution_mode == "policy_auto":
                    resolve_effective_authorization(
                        db,
                        family_id=request.family_id,
                        actor_user_id=request.actor_user_id,
                        action_key=str(request.policy_key or ""),
                        policy_version=str(request.policy_version or ""),
                        for_update=True,
                    )
            config = draft_operation_registry.approval_config_for_payload(
                locked_draft.draft_type,
                request.committed_payload,
            )
            operation_key = derive_draft_operation_idempotency_key(
                request.draft_id,
                request.draft_version,
            )
            with db.begin_nested():
                operation, _created = acquire_draft_operation(
                    db,
                    request=request,
                    idempotency_key=operation_key,
                    operation_type=config["operation_type"],
                    business_entity_type=config["business_entity_type"],
                )
                cls._validate_operation_identity(
                    operation,
                    request_payload=request.committed_payload,
                    request_mode=request.execution_mode,
                    operation_type=config["operation_type"],
                    family_id=request.family_id,
                    draft_id=request.draft_id,
                    run_id=request.run_id,
                )
                if is_operation_completed(operation.status):
                    return cls._replay_result(db, operation=operation, draft=locked_draft)
                _apply_operation_request_audit(operation, request=request)
                if locked_run is not None:
                    locked_run.auto_operation_id = operation.id
                return cls._persist_failed_execution(
                    db,
                    request=request,
                    operation=operation,
                    draft=locked_draft,
                    receipt=None,
                    error_code=DATABASE_FAILURE_ERROR_CODE,
                    error_message=DATABASE_FAILURE_ERROR_MESSAGE,
                )
        except Exception:
            logger.exception(
                "AI policy draft terminal database failure could not be persisted family_id=%s draft_id=%s",
                request.family_id,
                request.draft_id,
            )
            blocker_persisted = persist_run_auto_execution_blocked_after_rollback(
                db,
                family_id=request.family_id,
                run_id=request.run_id,
            )
            if not blocker_persisted:
                blocked = auto_execution_blocked_record()
                raise AutoExecutionBlockRequired(
                    error_code=blocked["errorCode"],
                    message=blocked["message"],
                    recovery_hint=blocked["recoveryHint"],
                ) from None
            raise AIConflictError("数据库写入失败，自动执行结果无法安全保存") from None

    @classmethod
    def _relock_after_full_rollback(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
    ) -> tuple[AIAgentRun | None, AITaskDraft]:
        del cls
        run = (
            lock_run_for_transition(db, family_id=request.family_id, run_id=request.run_id)
            if request.run_id
            else None
        )
        if request.approval_request_id:
            approval = db.scalar(
                select(AIApprovalRequest)
                .where(
                    AIApprovalRequest.id == request.approval_request_id,
                    AIApprovalRequest.family_id == request.family_id,
                )
                .with_for_update()
            )
            if approval is None:
                raise AIConflictError("确认请求已不存在")
            if (
                approval.conversation_id != request.conversation_id
                or approval.draft_id != request.draft_id
                or approval.draft_version != request.draft_version
            ):
                raise AIConflictError("确认请求与草稿已变化")
            if approval.status != "pending":
                raise AIConflictError("确认请求已处理，不能覆盖既有决定")
        draft = db.scalar(
            select(AITaskDraft)
            .where(
                AITaskDraft.id == request.draft_id,
                AITaskDraft.family_id == request.family_id,
            )
            .with_for_update()
        )
        if draft is None or draft.version != request.draft_version:
            raise AIConflictError("草稿版本已变化，不能恢复失败状态")
        return run, draft

    @classmethod
    def _validate_operation_identity(
        cls,
        operation: AIOperation,
        *,
        request_payload: dict[str, Any],
        request_mode: str,
        operation_type: str,
        family_id: str,
        draft_id: str,
        run_id: str | None,
    ) -> None:
        del cls
        if operation.family_id != family_id or operation.draft_id != draft_id:
            raise AIConflictError("幂等操作不属于当前草稿")
        if operation.run_id != run_id:
            raise AIConflictError("幂等操作关联的运行已变化")
        if operation.operation_type != operation_type or operation.execution_mode != request_mode:
            raise AIConflictError("同一草稿版本不能切换执行语义")
        committed_payload = operation.committed_payload_json
        if not isinstance(committed_payload, dict):
            raise AIConflictError("幂等操作缺少已提交载荷")
        if derive_draft_payload_hash(committed_payload) != derive_draft_payload_hash(request_payload):
            raise AIConflictError("同一草稿版本不能提交不同载荷")

    @classmethod
    def _recheck_policy_target(
        cls,
        db: Session,
        *,
        draft: AITaskDraft,
        actor_user_id: str,
        authorization: Any,
    ) -> None:
        del cls
        policy = auto_execution_policy_registry.resolve_policy(
            draft_type=draft.draft_type,
            payload=draft.payload,
        )
        if policy is None or policy.key != draft.policy_key or policy.version != draft.policy_version:
            raise AIConflictError("自动执行策略已变化，不能重试原操作")
        evidence_record = draft.intent_evidence_json if isinstance(draft.intent_evidence_json, dict) else {}
        evidence = IntentEvidenceValidation(
            clarity=draft.intent_clarity or "inferred",  # type: ignore[arg-type]
            normalized_evidence=dict(evidence_record.get("normalized_evidence") or {}),
            verified_fields=frozenset(evidence_record.get("verified_fields") or ()),
            verified_values=dict(evidence_record.get("verified_values") or {}),
            reason_codes=tuple(evidence_record.get("reason_codes") or ()),
        )
        evaluation = policy.evaluate(
            AutoExecutionPolicyContext(
                db=db,
                family_id=draft.family_id,
                actor_user_id=actor_user_id,
                draft_type=draft.draft_type,
                payload=draft.payload,
                evidence=evidence,
                authorization=authorization,
                auto_execution_attempted=False,
                has_continuation=bool((draft.ai_metadata or {}).get("continuation")),
                is_composite=draft.draft_type == "composite_operation",
                has_external_side_effect=False,
                registered_revert_adapters=frozenset({policy.revert_adapter_key}),
            )
        )
        if not evaluation.allowed or evaluation.all_targets_satisfied:
            raise AIConflictError("自动执行目标或版本已变化，不能重试原操作")

    @classmethod
    def _receipt_to_json(cls, receipt: DraftExecutionReceipt) -> dict[str, Any]:
        del cls
        return jsonable_encoder({
            "business_entity": receipt.business_entity,
            "entity_ids": list(receipt.entity_ids),
            "cache_scopes": list(receipt.cache_scopes),
            "revert_adapter_key": receipt.revert_adapter_key,
            "revert_context": receipt.revert_context,
        })

    @classmethod
    def _receipt_from_operation(cls, operation: AIOperation) -> DraftExecutionReceipt:
        del cls
        result = operation.result_json if isinstance(operation.result_json, dict) else None
        if result is None:
            raise AIConflictError("已完成操作缺少可重放结果")
        return DraftExecutionReceipt(
            business_entity=dict(result.get("business_entity") or {}),
            entity_ids=tuple(str(value) for value in result.get("entity_ids") or ()),
            cache_scopes=tuple(result.get("cache_scopes") or ("ai_conversation",)),  # type: ignore[arg-type]
            revert_adapter_key=(
                str(result.get("revert_adapter_key")) if result.get("revert_adapter_key") else None
            ),
            revert_context=(
                dict(result.get("revert_context"))
                if isinstance(result.get("revert_context"), dict)
                else None
            ),
        )

    @classmethod
    def _replay_result(
        cls,
        db: Session,
        *,
        operation: AIOperation,
        draft: AITaskDraft,
    ) -> DraftCommitResult:
        request = DraftCommitRequest(
            family_id=operation.family_id,
            actor_user_id=str(operation.actor_user_id or draft.updated_by or draft.created_by or ""),
            conversation_id=draft.conversation_id,
            run_id=operation.run_id,
            draft_id=draft.id,
            draft_version=draft.version,
            committed_payload=dict(operation.committed_payload_json or {}),
            execution_mode=operation.execution_mode,  # type: ignore[arg-type]
            authorization_source=operation.authorization_source,  # type: ignore[arg-type]
            authorization_snapshot=dict(operation.authorization_snapshot_json or {}),
            approval_request_id=operation.approval_request_id,
            policy_key=operation.policy_key,
            policy_version=operation.policy_version,
            policy_reason_codes=tuple(operation.policy_reason_codes or ()),
            committed_at=operation.completed_at or utcnow(),
        )
        return cls._persist_result(
            db,
            request=request,
            operation=operation,
            draft=draft,
            receipt=cls._receipt_from_operation(operation),
        )

    @classmethod
    def _failed_result(
        cls,
        db: Session,
        *,
        operation: AIOperation,
        draft: AITaskDraft,
    ) -> DraftCommitResult:
        request = DraftCommitRequest(
            family_id=operation.family_id,
            actor_user_id=str(operation.actor_user_id or draft.updated_by or draft.created_by or ""),
            conversation_id=draft.conversation_id,
            run_id=operation.run_id,
            draft_id=draft.id,
            draft_version=draft.version,
            committed_payload=dict(operation.committed_payload_json or {}),
            execution_mode=operation.execution_mode,  # type: ignore[arg-type]
            authorization_source=operation.authorization_source,  # type: ignore[arg-type]
            authorization_snapshot=dict(operation.authorization_snapshot_json or {}),
            approval_request_id=operation.approval_request_id,
            policy_key=operation.policy_key,
            policy_version=operation.policy_version,
            policy_reason_codes=tuple(operation.policy_reason_codes or ()),
            committed_at=operation.failed_at or utcnow(),
        )
        return cls._persist_result(
            db,
            request=request,
            operation=operation,
            draft=draft,
            receipt=_empty_receipt(),
        )

    @classmethod
    def _persist_result(
        cls,
        db: Session,
        *,
        request: DraftCommitRequest,
        operation: AIOperation,
        draft: AITaskDraft,
        receipt: DraftExecutionReceipt,
    ) -> DraftCommitResult:
        approval_record: dict[str, Any]
        if request.approval_request_id:
            approval = db.get(AIApprovalRequest, request.approval_request_id)
            approval_record = serialize_ai_approval_request(approval) if approval is not None else {}
            if approval_record.get("status") != "approved":
                approval_record = {**approval_record, "status": "approved", "decision": "approved"}
        else:
            approval_record = {
                "id": None,
                "status": "approved",
                "approval_type": operation.operation_type,
                "message_id": draft.message_id,
            }
        draft_record = serialize_ai_task_draft(draft)
        operation_record = serialize_ai_operation(operation)
        internal_artifacts = tuple(
            approval_decision_artifacts(
                approval=approval_record,
                draft=draft_record,
                operation=operation_record,
                business_entity=receipt.business_entity or None,
            )
        )
        legacy_card = build_approval_result_card(
            approval=approval_record,
            draft=draft_record,
            operation=operation_record,
            draft_config=draft_operation_registry.approval_config_for_payload(
                draft.draft_type,
                draft.payload,
            ),
            business_artifacts=[
                artifact
                for artifact in internal_artifacts
                if artifact.get("kind") == "business_entity"
            ],
        )
        entities = tuple(
            dict(entity)
            for entity in (
                legacy_card.get("data", {}).get("entities", [])
                if isinstance(legacy_card, dict)
                else []
            )
            if isinstance(entity, dict)
        )
        projection = project_ai_operation_result(
            operation=operation,
            draft=draft,
            entities=entities,
            cache_scopes=receipt.cache_scopes,
            server_now=request.committed_at,
        )
        workspace_label = draft_operation_registry.workspace_label(draft.draft_type)
        failure = (
            operation.result_json.get("failure")
            if isinstance(operation.result_json, dict)
            and isinstance(operation.result_json.get("failure"), dict)
            else {}
        )
        explicit_recovery_hint = failure.get("recovery_hint")
        recovery_hint = (
            str(explicit_recovery_hint)
            if explicit_recovery_hint
            else (
                "请检查当前状态后重新生成草稿"
                if projection.result_status == "failed"
                else None
            )
        )
        card = build_operation_result_card(
            projection,
            title=(
                str(legacy_card.get("title") or "")
                if isinstance(legacy_card, dict)
                else "自动执行未完成"
            ),
            workspace_label=workspace_label,
            approval_id=(str(approval_record.get("id")) if approval_record.get("id") else None),
            workspace_hint=recovery_hint,
            error_code=(str(operation.error_code) if operation.error_code else None),
            recovery_hint=recovery_hint,
        )
        result_artifacts = operation_result_artifacts(projection, card=card)
        result_part = upsert_message_operation_result(
            db,
            message_id=draft.message_id,
            projection=projection,
            card=card,
            artifacts=result_artifacts,
            approval_id=(str(approval_record.get("id")) if approval_record.get("id") else None),
        )
        return DraftCommitResult(
            operation_id=operation.id,
            receipt=receipt,
            projection=projection,
            result_part=result_part,
            internal_artifacts=internal_artifacts,
            public_artifacts=result_artifacts,
        )

    @classmethod
    def _safe_failure_message(cls, error_code: str | None) -> str:
        del cls
        if error_code in {DATABASE_FAILURE_ERROR_CODE, TRANSIENT_DATABASE_ERROR_CODE}:
            return (
                TRANSIENT_DATABASE_ERROR_MESSAGE
                if error_code == TRANSIENT_DATABASE_ERROR_CODE
                else DATABASE_FAILURE_ERROR_MESSAGE
            )
        if error_code == DOMAIN_CONFLICT_ERROR_CODE:
            return DOMAIN_CONFLICT_ERROR_MESSAGE
        return DOMAIN_FAILURE_ERROR_MESSAGE
