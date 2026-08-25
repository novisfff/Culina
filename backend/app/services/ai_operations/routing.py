from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
from typing import Any, cast

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.errors import AIConflictError, AIExecutionCancelled
from app.core.utils import create_id, utcnow
from app.models.domain import AIAgentRun, AIApprovalRequest, AIMessage, AIOperation, AITaskDraft
from app.services.ai_auto_execution.intent_evidence import intent_evidence_validation_record
from app.services.ai_auto_execution.policy_registry import (
    AutoExecutionPolicyRegistry,
    auto_execution_policy_registry,
)
from app.services.ai_auto_execution.policy_types import (
    AIOperationResultProjection,
    AutoExecutionPolicyContext,
    DraftCommitRequest,
    DraftRouteStatus,
    DraftRouteOutcome,
    EffectiveAuthorization,
    TrustedResolutionSource,
)
from app.services.ai_auto_execution.settings import resolve_effective_authorization
from app.services.ai_operations.commit_coordinator import (
    DraftCommitCoordinator,
    derive_draft_payload_hash,
)
from app.services.ai_operations.drafts import draft_preview_summary
from app.services.ai_operations.messages import persist_message_artifacts
from app.services.ai_operations.registry import draft_operation_registry
from app.services.ai_operations.run_cancellation import (
    cancellation_wins,
    finalize_run_cancellation,
    lock_run_for_transition,
)


AuthorizationResolver = Callable[..., EffectiveAuthorization]


@dataclass(frozen=True, slots=True)
class DraftRouteRequest:
    family_id: str
    actor_user_id: str
    conversation_id: str
    message_id: str
    run_id: str
    draft_type: str
    payload: dict[str, Any]
    intent_evidence_input: dict[str, Any] | None
    schema_version: str
    tool_name: str
    skill_approval_policy: str
    current_message: str
    trusted_resolution_sources: dict[str, TrustedResolutionSource]
    continuation: dict[str, Any]


def route_draft(
    db: Session,
    request: DraftRouteRequest,
    *,
    policy_registry: AutoExecutionPolicyRegistry = auto_execution_policy_registry,
    authorization_resolver: AuthorizationResolver = resolve_effective_authorization,
    registered_revert_adapters: frozenset[str] = frozenset(),
    coordinator: type[DraftCommitCoordinator] = DraftCommitCoordinator,
) -> DraftRouteOutcome:
    """Persist and route one normalized draft under the run's single-attempt gate."""
    _validate_request_shape(request)
    run = lock_run_for_transition(
        db,
        family_id=request.family_id,
        run_id=request.run_id,
    )
    _validate_run_owner(run, request=request)
    _validate_message(db, request=request)
    _raise_if_cancelled(db, run=run)

    draft = _load_existing_draft(db, request=request)
    if draft is not None:
        replay = _replay_existing_route(db, draft=draft, coordinator=coordinator)
        if replay is not None:
            return replay

    policy = policy_registry.resolve_policy(
        draft_type=request.draft_type,
        payload=request.payload,
    )
    policy_key = policy.key if policy is not None else ""
    policy_version = policy.version if policy is not None else ""
    if request.skill_approval_policy == "draft_then_policy" and policy is not None:
        preflight_authorization = authorization_resolver(
            db,
            family_id=request.family_id,
            actor_user_id=request.actor_user_id,
            action_key=policy_key,
            policy_version=policy_version,
            for_update=False,
        )
    else:
        preflight_authorization = _disabled_authorization(
            policy_version=policy_version,
            reason_code=(
                "skill_requires_confirmation"
                if request.skill_approval_policy != "draft_then_policy"
                else "action_not_allowed"
            ),
        )
    evidence, preflight = policy_registry.evaluate_draft(
        db=db,
        family_id=request.family_id,
        actor_user_id=request.actor_user_id,
        draft_type=request.draft_type,
        payload=request.payload,
        evidence_input=request.intent_evidence_input,
        current_message=request.current_message,
        trusted_resolution_sources=request.trusted_resolution_sources,
        authorization=preflight_authorization,
        auto_execution_attempted=bool(run.auto_execution_attempted),
        has_continuation=bool(request.continuation),
        is_composite=request.draft_type == "composite_operation",
        has_external_side_effect=False,
        registered_revert_adapters=registered_revert_adapters,
    )
    if request.skill_approval_policy != "draft_then_policy" and "skill_requires_confirmation" not in preflight.reason_codes:
        preflight = _manual_decision_with_reason(preflight, "skill_requires_confirmation")

    evidence_record = intent_evidence_validation_record(evidence)
    if draft is None:
        draft = _create_draft(
            db,
            request=request,
            evidence_record=evidence_record,
        )
    else:
        draft.intent_clarity = str(evidence_record.get("clarity") or "inferred")
        draft.intent_evidence_json = dict(evidence_record)
        draft.updated_by = request.actor_user_id

    if request.skill_approval_policy != "draft_then_policy" or preflight.route == "manual_confirmation":
        return _route_manual(db, request=request, draft=draft, decision=preflight)

    # Run and Draft are already locked. The resolver locks family policy then
    # member preference; no-change routing next locks its supported domain
    # target, while auto execution delegates Operation/domain locks to the Coordinator.
    final_authorization = authorization_resolver(
        db,
        family_id=request.family_id,
        actor_user_id=request.actor_user_id,
        action_key=policy_key,
        policy_version=policy_version,
        for_update=True,
    )
    _validate_run_owner(run, request=request)
    _raise_if_cancelled(db, run=run)
    final_evidence, final_decision = policy_registry.evaluate_draft(
        db=db,
        family_id=request.family_id,
        actor_user_id=request.actor_user_id,
        draft_type=request.draft_type,
        payload=request.payload,
        evidence_input=request.intent_evidence_input,
        current_message=request.current_message,
        trusted_resolution_sources=request.trusted_resolution_sources,
        authorization=final_authorization,
        auto_execution_attempted=bool(run.auto_execution_attempted),
        has_continuation=bool(request.continuation),
        is_composite=request.draft_type == "composite_operation",
        has_external_side_effect=False,
        registered_revert_adapters=registered_revert_adapters,
    )
    draft.intent_clarity = final_evidence.clarity
    draft.intent_evidence_json = intent_evidence_validation_record(final_evidence)
    if final_decision.route == "manual_confirmation" or final_authorization.source is None:
        return _route_manual(db, request=request, draft=draft, decision=final_decision)

    if final_decision.route == "no_change":
        final_evidence, final_decision = _recheck_no_change_under_target_lock(
            db,
            request=request,
            policy_registry=policy_registry,
            authorization=final_authorization,
            decision=final_decision,
            evidence=final_evidence,
            registered_revert_adapters=registered_revert_adapters,
        )
        draft.intent_clarity = final_evidence.clarity
        draft.intent_evidence_json = intent_evidence_validation_record(final_evidence)
        if final_decision.route != "no_change":
            return _route_manual(db, request=request, draft=draft, decision=final_decision)

    run.auto_execution_attempted = True
    draft.policy_key = final_decision.policy_key
    draft.policy_version = final_decision.policy_version
    draft.policy_reason_codes = list(final_decision.reason_codes)
    draft.policy_evaluated_at = utcnow()
    draft.updated_by = request.actor_user_id
    if final_decision.route == "no_change":
        draft.execution_route = "policy_no_change"
        draft.status = "no_change"
        db.flush()
        projection, result_part, artifact = _persist_no_change_result(
            db,
            request=request,
            draft=draft,
        )
        outcome = DraftRouteOutcome(
            status="no_change",
            draft_id=draft.id,
            approval_id=None,
            operation_id=None,
            published_part_ids=((str(result_part.get("id")),) if result_part.get("id") else ()),
            projection=projection,
        )
        _store_route_outcome(draft, outcome)
        persist_message_artifacts(db, message_id=draft.message_id, artifacts=[artifact])
        db.flush()
        return outcome

    draft.execution_route = "policy_auto"
    draft.status = "pending"
    db.flush()
    commit = coordinator.commit_locked(
        db,
        request=DraftCommitRequest(
            family_id=request.family_id,
            actor_user_id=request.actor_user_id,
            conversation_id=request.conversation_id,
            run_id=request.run_id,
            draft_id=draft.id,
            draft_version=draft.version,
            committed_payload=dict(request.payload),
            execution_mode="policy_auto",
            authorization_source=final_authorization.source,
            authorization_snapshot=dict(final_authorization.snapshot),
            approval_request_id=None,
            policy_key=final_decision.policy_key,
            policy_version=final_decision.policy_version,
            policy_reason_codes=tuple(final_decision.reason_codes),
            committed_at=utcnow(),
        ),
        locked_run=run,
        locked_draft=draft,
    )
    status = "auto_executed" if commit.projection.result_status == "completed" else "execution_failed"
    result_part = commit.result_part
    if status == "execution_failed":
        operation = db.get(AIOperation, commit.operation_id)
        if (
            operation is None
            or operation.family_id != request.family_id
            or operation.draft_id != draft.id
            or operation.run_id != request.run_id
        ):
            raise AIConflictError("自动执行失败结果已丢失")
        result_part = _persist_execution_failure_result(
            db,
            draft=draft,
            operation=operation,
            projection=commit.projection,
        )
    outcome = DraftRouteOutcome(
        status=status,
        draft_id=draft.id,
        approval_id=None,
        operation_id=commit.operation_id,
        published_part_ids=((str(result_part.get("id")),) if result_part.get("id") else ()),
        projection=commit.projection,
    )
    _store_route_outcome(draft, outcome)
    db.flush()
    return outcome


def _validate_request_shape(request: DraftRouteRequest) -> None:
    if not request.actor_user_id.strip() or not request.message_id.strip():
        raise AIConflictError("草稿路由缺少执行人或消息")
    if request.skill_approval_policy not in {"draft_then_confirm", "draft_then_policy"}:
        raise AIConflictError("草稿 Skill 的确认策略无效")
    if not draft_operation_registry.supports(request.draft_type):
        raise ValueError("暂不支持的草稿类型")
    if "intentEvidence" in request.payload:
        raise AIConflictError("正式草稿载荷不能包含意图证据")


def _validate_run_owner(run: AIAgentRun, *, request: DraftRouteRequest) -> None:
    if (
        run.family_id != request.family_id
        or run.conversation_id != request.conversation_id
        or run.created_by != request.actor_user_id
    ):
        raise AIConflictError("运行、会话、消息或执行人已变化")


def _validate_message(db: Session, *, request: DraftRouteRequest) -> None:
    message = db.get(AIMessage, request.message_id)
    if (
        message is None
        or message.family_id != request.family_id
        or message.conversation_id != request.conversation_id
        or message.run_id != request.run_id
        or message.role != "assistant"
    ):
        raise AIConflictError("草稿结果消息已变化")


def _raise_if_cancelled(db: Session, *, run: AIAgentRun) -> None:
    if cancellation_wins(db, run=run):
        finalize_run_cancellation(db, run=run)
        raise AIExecutionCancelled("AI run was cancelled")


def _disabled_authorization(*, policy_version: str, reason_code: str) -> EffectiveAuthorization:
    return EffectiveAuthorization(
        enabled=False,
        source=None,
        snapshot={"policy_version": policy_version},
        reason_codes=(reason_code,),
    )


def _manual_decision_with_reason(decision: Any, reason_code: str) -> Any:
    from app.services.ai_auto_execution.policy_types import AutoExecutionDecision

    return AutoExecutionDecision(
        route="manual_confirmation",
        policy_key=decision.policy_key,
        policy_version=decision.policy_version,
        reason_codes=tuple(dict.fromkeys((*decision.reason_codes, reason_code))),
        authorization_source=decision.authorization_source,
        authorization_snapshot=dict(decision.authorization_snapshot),
    )


def _recheck_no_change_under_target_lock(
    db: Session,
    *,
    request: DraftRouteRequest,
    policy_registry: AutoExecutionPolicyRegistry,
    authorization: EffectiveAuthorization,
    decision: Any,
    evidence: Any,
    registered_revert_adapters: frozenset[str],
) -> tuple[Any, Any]:
    context = AutoExecutionPolicyContext(
        db=db,
        family_id=request.family_id,
        actor_user_id=request.actor_user_id,
        draft_type=request.draft_type,
        payload=request.payload,
        evidence=evidence,
        authorization=authorization,
        auto_execution_attempted=False,
        has_continuation=bool(request.continuation),
        is_composite=request.draft_type == "composite_operation",
        has_external_side_effect=False,
        registered_revert_adapters=registered_revert_adapters,
    )
    locked_decision = policy_registry.recheck_no_change_under_lock(
        context=context,
        expected_policy_key=decision.policy_key,
        expected_policy_version=decision.policy_version,
    )
    return evidence, locked_decision


def _draft_idempotency_key(request: DraftRouteRequest) -> str:
    digest = hashlib.sha256(
        f"{request.run_id}\0{request.tool_name}\0{request.draft_type}".encode("utf-8")
    ).hexdigest()
    return f"draft-route:{digest}"


def _load_existing_draft(
    db: Session,
    *,
    request: DraftRouteRequest,
) -> AITaskDraft | None:
    key = _draft_idempotency_key(request)
    payload_hash = derive_draft_payload_hash(request.payload)
    draft = db.scalar(
        select(AITaskDraft)
        .where(AITaskDraft.idempotency_key == key)
        .with_for_update()
    )
    if draft is None:
        return None
    if (
        draft.family_id != request.family_id
        or draft.conversation_id != request.conversation_id
        or draft.source_run_id != request.run_id
        or draft.message_id != request.message_id
        or draft.draft_type != request.draft_type
        or draft.schema_version != request.schema_version
        or draft.payload_hash != payload_hash
        or derive_draft_payload_hash(draft.payload) != payload_hash
    ):
        raise AIConflictError("同一草稿版本的载荷或归属已变化")
    return draft


def _create_draft(
    db: Session,
    *,
    request: DraftRouteRequest,
    evidence_record: dict[str, Any],
) -> AITaskDraft:
    key = _draft_idempotency_key(request)
    payload_hash = derive_draft_payload_hash(request.payload)
    draft = AITaskDraft(
        id=create_id("ai_draft"),
        family_id=request.family_id,
        conversation_id=request.conversation_id,
        source_run_id=request.run_id,
        message_id=request.message_id,
        draft_type=request.draft_type,
        payload=dict(request.payload),
        preview_summary=draft_preview_summary(request.draft_type, request.payload),
        status="pending",
        version=1,
        schema_version=request.schema_version,
        validation_errors=[],
        ai_metadata={
            "toolName": request.tool_name,
            **({"continuation": dict(request.continuation)} if request.continuation else {}),
        },
        intent_clarity=str(evidence_record.get("clarity") or "inferred"),
        intent_evidence_json=dict(evidence_record),
        payload_hash=payload_hash,
        execution_route="manual_confirmation",
        idempotency_key=key,
        created_by=request.actor_user_id,
        updated_by=request.actor_user_id,
    )
    db.add(draft)
    db.flush()
    return draft


def _route_manual(db: Session, *, request: DraftRouteRequest, draft: AITaskDraft, decision: Any) -> DraftRouteOutcome:
    draft.status = "pending"
    draft.execution_route = "manual_confirmation"
    draft.policy_key = decision.policy_key
    draft.policy_version = decision.policy_version
    draft.policy_reason_codes = list(decision.reason_codes)
    draft.policy_evaluated_at = utcnow()
    draft.updated_by = request.actor_user_id
    approval = _ensure_approval(db, request=request, draft=draft)
    outcome = DraftRouteOutcome(
        status="waiting_approval",
        draft_id=draft.id,
        approval_id=approval.id,
        operation_id=None,
        published_part_ids=(),
        projection=None,
    )
    _store_route_outcome(draft, outcome)
    db.flush()
    return outcome


def _ensure_approval(db: Session, *, request: DraftRouteRequest, draft: AITaskDraft) -> AIApprovalRequest:
    existing = db.scalar(
        select(AIApprovalRequest)
        .where(
            AIApprovalRequest.family_id == request.family_id,
            AIApprovalRequest.draft_id == draft.id,
            AIApprovalRequest.draft_version == draft.version,
        )
        .order_by(AIApprovalRequest.created_at.asc(), AIApprovalRequest.id.asc())
        .with_for_update()
    )
    if existing is not None:
        return existing
    config = draft_operation_registry.approval_config_for_payload(draft.draft_type, draft.payload)
    approval = AIApprovalRequest(
        id=create_id("ai_approval"),
        family_id=request.family_id,
        conversation_id=request.conversation_id,
        message_id=request.message_id,
        run_id=request.run_id,
        draft_id=draft.id,
        draft_version=draft.version,
        draft_schema_version=draft.schema_version,
        approval_type=config["approval_type"],
        status="pending",
        request_payload={
            "title": config["title"],
            "instruction": config["instruction"],
            "approveLabel": config["approve_label"],
            "rejectLabel": config["reject_label"],
            "requireRejectComment": False,
        },
        field_schema=[
            {
                "name": config["value_key"],
                "label": "草稿内容",
                "type": "object",
                "widget": config["widget"],
                "required": True,
            }
        ],
        initial_values={config["value_key"]: dict(draft.payload)},
        submitted_values={},
        created_by=request.actor_user_id,
        updated_by=request.actor_user_id,
    )
    db.add(approval)
    db.flush()
    return approval


def _persist_no_change_result(
    db: Session,
    *,
    request: DraftRouteRequest,
    draft: AITaskDraft,
) -> tuple[AIOperationResultProjection, dict[str, Any], dict[str, Any]]:
    now = utcnow()
    projection = AIOperationResultProjection(
        draft_id=draft.id,
        operation_id=None,
        result_status="no_change",
        execution_mode="policy_no_change",
        operation_status=None,
        execution_explanation="当前状态已满足，无需修改",
        revert_availability="unsupported",
        revertible_until=None,
        revert_blocked_code=None,
        server_now=now,
        entities=(),
        cache_scopes=("ai_conversation",),
    )
    card = {
        "id": f"operation-result:{draft.id}",
        "type": "operation_result",
        "title": "当前状态已满足",
        "data": {
            "actionSummary": projection.execution_explanation,
            "entityCount": 0,
            "entityCountLabel": "无需修改",
            "workspaceLabel": draft_operation_registry.workspace_label(draft.draft_type),
            "workspaceHint": "当前数据没有变化",
            "entities": [],
            "approvalId": None,
            "operationId": None,
            "draftId": draft.id,
        },
    }
    message = db.get(AIMessage, request.message_id)
    result_part: dict[str, Any] = {}
    if message is not None:
        existing = next(
            (
                part
                for part in message.parts or []
                if isinstance(part, dict)
                and part.get("type") == "result_card"
                and isinstance(part.get("card"), dict)
                and part["card"].get("id") == card["id"]
            ),
            None,
        )
        result_part = existing or {
            "id": create_id("ai_part"),
            "type": "result_card",
            "card": jsonable_encoder(card),
        }
        if existing is None:
            message.parts = [*(message.parts or []), result_part]
    artifact = {
        "id": f"draft-route:{draft.id}",
        "type": "draft_route_result",
        "kind": "control",
        "version": 1,
        "status": "no_change",
        "payload": jsonable_encoder(projection),
        "sourceDraftId": draft.id,
    }
    return projection, result_part, artifact


def _persist_execution_failure_result(
    db: Session,
    *,
    draft: AITaskDraft,
    operation: AIOperation,
    projection: AIOperationResultProjection,
) -> dict[str, Any]:
    recovery_hint = "请检查当前状态后重新生成草稿"
    error_code = str(operation.error_code or "draft_commit_domain_failed")
    card = {
        "id": f"operation-failure:{operation.id}",
        "type": "operation_result",
        "title": "自动执行未完成",
        "data": {
            "actionSummary": projection.execution_explanation,
            "entityCount": 0,
            "entityCountLabel": "未完成",
            "workspaceLabel": draft_operation_registry.workspace_label(draft.draft_type),
            "workspaceHint": recovery_hint,
            "entities": [],
            "approvalId": None,
            "operationId": operation.id,
            "draftId": draft.id,
            "errorCode": error_code,
            "recoveryHint": recovery_hint,
        },
    }
    message = db.get(AIMessage, draft.message_id)
    result_part: dict[str, Any] = {}
    if message is not None:
        existing = next(
            (
                part
                for part in message.parts or []
                if isinstance(part, dict)
                and part.get("type") == "result_card"
                and isinstance(part.get("card"), dict)
                and part["card"].get("id") == card["id"]
            ),
            None,
        )
        result_part = existing or {
            "id": create_id("ai_part"),
            "type": "result_card",
            "card": jsonable_encoder(card),
        }
        if existing is None:
            message.parts = [*(message.parts or []), result_part]
    artifact = {
        "id": f"draft-route-failure:{draft.id}",
        "type": "draft_route_result",
        "kind": "control",
        "version": 1,
        "status": "failed",
        "payload": {
            "draftId": draft.id,
            "operationId": operation.id,
            "errorCode": error_code,
            "message": projection.execution_explanation,
            "recoveryHint": recovery_hint,
        },
        "sourceDraftId": draft.id,
        "sourceOperationId": operation.id,
    }
    persist_message_artifacts(db, message_id=draft.message_id, artifacts=[artifact])
    return result_part


def _replay_existing_route(
    db: Session,
    *,
    draft: AITaskDraft,
    coordinator: type[DraftCommitCoordinator],
) -> DraftRouteOutcome | None:
    metadata = draft.ai_metadata if isinstance(draft.ai_metadata, dict) else {}
    stored = metadata.get("routeOutcome") if isinstance(metadata.get("routeOutcome"), dict) else None
    if stored is None:
        return None
    status = str(stored.get("status") or "")
    operation_id = str(stored.get("operationId") or "") or None
    projection = None
    published_part_ids = tuple(str(value) for value in stored.get("publishedPartIds") or () if str(value))
    if status in {"auto_executed", "execution_failed"} and operation_id:
        operation = db.get(AIOperation, operation_id)
        if operation is None or operation.draft_id != draft.id:
            raise AIConflictError("自动执行结果已丢失")
        commit = (
            coordinator._replay_result(db, operation=operation, draft=draft)
            if operation.status == "succeeded"
            else coordinator._failed_result(db, operation=operation, draft=draft)
        )
        projection = commit.projection
        result_part = commit.result_part
        if status == "execution_failed":
            result_part = _persist_execution_failure_result(
                db,
                draft=draft,
                operation=operation,
                projection=commit.projection,
            )
        if result_part.get("id"):
            published_part_ids = (str(result_part["id"]),)
    elif status == "no_change":
        projection, part, artifact = _persist_no_change_result(
            db,
            request=DraftRouteRequest(
                family_id=draft.family_id,
                actor_user_id=str(draft.updated_by or draft.created_by or ""),
                conversation_id=draft.conversation_id,
                message_id=str(draft.message_id or ""),
                run_id=str(draft.source_run_id or ""),
                draft_type=draft.draft_type,
                payload=dict(draft.payload),
                intent_evidence_input=None,
                schema_version=draft.schema_version,
                tool_name=str(metadata.get("toolName") or ""),
                skill_approval_policy="draft_then_policy",
                current_message="",
                trusted_resolution_sources={},
                continuation={},
            ),
            draft=draft,
        )
        persist_message_artifacts(db, message_id=draft.message_id, artifacts=[artifact])
        if part.get("id"):
            published_part_ids = (str(part["id"]),)
    if status not in {"waiting_approval", "auto_executed", "no_change", "execution_failed"}:
        raise AIConflictError("草稿路由结果无效")
    return DraftRouteOutcome(
        status=cast(DraftRouteStatus, status),
        draft_id=draft.id,
        approval_id=(str(stored.get("approvalId")) if stored.get("approvalId") else None),
        operation_id=operation_id,
        published_part_ids=published_part_ids,
        projection=projection,
    )


def _store_route_outcome(draft: AITaskDraft, outcome: DraftRouteOutcome) -> None:
    metadata = dict(draft.ai_metadata or {})
    metadata["routeOutcome"] = {
        "status": outcome.status,
        "draftId": outcome.draft_id,
        "approvalId": outcome.approval_id,
        "operationId": outcome.operation_id,
        "publishedPartIds": list(outcome.published_part_ids),
    }
    draft.ai_metadata = metadata
