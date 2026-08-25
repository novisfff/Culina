from __future__ import annotations

import copy
from datetime import UTC, datetime
from typing import Any, cast

from fastapi.encoders import jsonable_encoder
from sqlalchemy.orm import Session

from app.models.domain import AIMessage, AIOperation, AITaskDraft
from app.services.ai_auto_execution.policy_types import (
    AICacheScope,
    AIOperationResultProjection,
    ExecutionMode,
    RevertAvailability,
)
from app.services.ai_operations.status import normalize_operation_status


PUBLIC_RESULT_FIELDS = (
    "draft_id",
    "operation_id",
    "result_status",
    "execution_mode",
    "operation_status",
    "execution_explanation",
    "revert_availability",
    "revertible_until",
    "revert_blocked_code",
    "server_now",
    "entities",
    "cache_scopes",
)

PUBLIC_RESULT_ENTITY_FIELDS = (
    "id",
    "label",
    "operation",
    "operationLabel",
    "updatedAt",
)

EXECUTION_EXPLANATIONS = {
    "manual_approval": "已按你的确认执行。",
    "policy_auto": "你明确要求执行此操作，且它符合已开启的低风险规则。",
    "policy_no_change": "相关内容已经是你要求的状态。",
    "pending": "操作正在处理中。",
    "reverted": "已撤销该操作。",
}

SAFE_FAILURE_EXPLANATIONS = {
    "draft_commit_transient_database_error": "数据库暂时不可用，请重试原草稿",
    "draft_commit_database_error": "数据库写入失败，请稍后重试",
    "draft_commit_domain_conflict": "目标状态已变化，请刷新后重新生成草稿",
    "idempotency_key_reused": "相同操作标识已用于不同内容，请重新生成草稿",
}
DEFAULT_FAILURE_EXPLANATION = "操作未能完成，请稍后重新生成草稿"


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _public_entities(entities: tuple[dict[str, Any], ...]) -> tuple[dict[str, Any], ...]:
    public: list[dict[str, Any]] = []
    for entity in entities:
        if not isinstance(entity, dict):
            continue
        public.append(
            {
                field: copy.deepcopy(entity[field])
                for field in PUBLIC_RESULT_ENTITY_FIELDS
                if field in entity
            }
        )
    return tuple(public)


def project_ai_operation_result(
    *,
    draft: AITaskDraft,
    operation: AIOperation | None,
    entities: tuple[dict[str, Any], ...],
    cache_scopes: tuple[AICacheScope, ...],
    server_now: datetime,
) -> AIOperationResultProjection:
    if draft.status == "no_change":
        return AIOperationResultProjection(
            draft_id=draft.id,
            operation_id=None,
            result_status="no_change",
            execution_mode="policy_no_change",
            operation_status=None,
            execution_explanation=EXECUTION_EXPLANATIONS["policy_no_change"],
            revert_availability="unsupported",
            revertible_until=None,
            revert_blocked_code=None,
            server_now=_as_utc(server_now),
            entities=_public_entities(entities),
            cache_scopes=("ai_conversation",),
        )
    if operation is None:
        raise ValueError("真实写入结果必须关联 AIOperation")
    return _project_persisted_operation(
        draft=draft,
        operation=operation,
        entities=entities,
        cache_scopes=cache_scopes,
        server_now=server_now,
    )


def _project_persisted_operation(
    *,
    draft: AITaskDraft,
    operation: AIOperation,
    entities: tuple[dict[str, Any], ...],
    cache_scopes: tuple[AICacheScope, ...],
    server_now: datetime,
) -> AIOperationResultProjection:
    now = _as_utc(server_now)
    raw_status = normalize_operation_status(operation.status)
    execution_mode = cast(ExecutionMode, operation.execution_mode)
    if raw_status == "failed":
        result_status = "failed"
        operation_status = "failed"
        explanation = SAFE_FAILURE_EXPLANATIONS.get(
            str(operation.error_code or ""),
            DEFAULT_FAILURE_EXPLANATION,
        )
        availability: RevertAvailability = "unsupported"
    elif raw_status == "reverted":
        result_status = "reverted"
        operation_status = "reverted"
        explanation = EXECUTION_EXPLANATIONS["reverted"]
        availability = "reverted"
    elif raw_status == "pending":
        result_status = "completed"
        operation_status = "pending"
        explanation = EXECUTION_EXPLANATIONS["pending"]
        availability = "unsupported"
    elif raw_status == "completed":
        result_status = "completed"
        operation_status = "completed"
        explanation = EXECUTION_EXPLANATIONS.get(
            execution_mode,
            EXECUTION_EXPLANATIONS["manual_approval"],
        )
        availability = _completed_revert_availability(operation, server_now=now)
    else:
        raise ValueError("AIOperation 操作状态无效")
    return AIOperationResultProjection(
        draft_id=draft.id,
        operation_id=operation.id,
        result_status=cast(Any, result_status),
        execution_mode=execution_mode,
        operation_status=cast(Any, operation_status),
        execution_explanation=explanation,
        revert_availability=availability,
        revertible_until=(
            _as_utc(operation.revertible_until)
            if operation.revertible_until is not None
            else None
        ),
        revert_blocked_code=operation.revert_blocked_code,
        server_now=now,
        entities=_public_entities(entities if result_status == "completed" else ()),
        cache_scopes=tuple(cache_scopes),
    )


def _completed_revert_availability(
    operation: AIOperation,
    *,
    server_now: datetime,
) -> RevertAvailability:
    if operation.revert_blocked_code:
        return "blocked"
    if (
        not operation.revert_adapter_key
        or not isinstance(operation.revert_context_json, dict)
        or not operation.revert_context_json
        or operation.revertible_until is None
    ):
        return "unsupported"
    if server_now > _as_utc(operation.revertible_until):
        return "expired"
    return "available"


def serialize_ai_operation_result_projection(
    projection: AIOperationResultProjection,
) -> dict[str, Any]:
    encoded = jsonable_encoder(projection)
    return {field: encoded[field] for field in PUBLIC_RESULT_FIELDS}


def build_operation_result_card(
    projection: AIOperationResultProjection,
    *,
    title: str,
    workspace_label: str,
    approval_id: str | None = None,
    workspace_hint: str | None = None,
    error_code: str | None = None,
    recovery_hint: str | None = None,
) -> dict[str, Any]:
    count = len(projection.entities)
    if projection.result_status == "no_change":
        count_label = "无需修改"
    elif projection.result_status == "failed":
        count_label = "未完成"
    else:
        count_label = f"{count} 项"
    data: dict[str, Any] = {
        **serialize_ai_operation_result_projection(projection),
        "actionSummary": projection.execution_explanation,
        "entityCount": count,
        "entityCountLabel": count_label,
        "workspaceLabel": workspace_label,
        "workspaceHint": workspace_hint or f"可前往{workspace_label}查看",
        # Compatibility aliases remain display-only; the public result record
        # above is always produced from the fixed whitelist.
        "approvalId": approval_id,
        "operationId": projection.operation_id,
        "draftId": projection.draft_id,
    }
    if error_code:
        data["errorCode"] = error_code
    if recovery_hint:
        data["recoveryHint"] = recovery_hint
    return {
        "id": f"operation-result:{projection.draft_id}",
        "type": "operation_result",
        "title": title,
        "data": data,
    }


def operation_result_artifacts(
    projection: AIOperationResultProjection,
    *,
    card: dict[str, Any],
) -> tuple[dict[str, Any], ...]:
    return (
        {
            "id": f"ai_operation_result:{projection.draft_id}",
            "type": "ai_operation_result",
            "kind": "operation_result",
            "version": 1,
            "status": projection.result_status,
            "sourceDraftId": projection.draft_id,
            "sourceOperationId": projection.operation_id,
            "payload": copy.deepcopy(card),
        },
    )


def upsert_message_operation_result(
    db: Session,
    *,
    message_id: str | None,
    projection: AIOperationResultProjection,
    card: dict[str, Any],
    artifacts: tuple[dict[str, Any], ...],
    approval_id: str | None = None,
) -> dict[str, Any]:
    _validate_public_operation_result_artifacts(
        artifacts,
        draft_id=projection.draft_id,
    )
    if not message_id:
        return {}
    message = db.get(AIMessage, message_id)
    if message is None:
        return {}
    encoded_card = jsonable_encoder(card)
    parts = [part for part in (message.parts or []) if isinstance(part, dict)]
    existing_index = next(
        (
            index
            for index, part in enumerate(parts)
            if _part_draft_id(part) == projection.draft_id
        ),
        None,
    )
    if existing_index is None:
        result_part = {
            "id": f"operation-result-part:{projection.draft_id}",
            "type": "result_card",
            "card": encoded_card,
        }
        approval_index = _matching_approval_index(parts, approval_id=approval_id)
        if approval_index is None:
            parts.append(result_part)
        else:
            parts.insert(approval_index + 1, result_part)
    else:
        result_part = {
            **parts[existing_index],
            "type": "result_card",
            "card": encoded_card,
        }
        parts[existing_index] = result_part
    message.parts = parts
    _upsert_message_artifacts(message, artifacts=artifacts)
    return result_part


def _validate_public_operation_result_artifacts(
    artifacts: tuple[dict[str, Any], ...],
    *,
    draft_id: str,
) -> None:
    if len(artifacts) != 1:
        raise ValueError("公开操作结果必须且只能包含一个 Artifact")
    artifact = artifacts[0]
    if (
        artifact.get("id") != f"ai_operation_result:{draft_id}"
        or artifact.get("type") != "ai_operation_result"
        or artifact.get("kind") != "operation_result"
        or artifact.get("sourceDraftId") != draft_id
    ):
        raise ValueError("公开操作结果 Artifact 与草稿不匹配")


def _part_draft_id(part: dict[str, Any]) -> str:
    if part.get("type") != "result_card" or not isinstance(part.get("card"), dict):
        return ""
    card = part["card"]
    data = card.get("data") if isinstance(card.get("data"), dict) else {}
    return str(data.get("draft_id") or data.get("draftId") or "")


def _matching_approval_index(
    parts: list[dict[str, Any]],
    *,
    approval_id: str | None,
) -> int | None:
    if not approval_id:
        return None
    return next(
        (
            index
            for index, part in enumerate(parts)
            if part.get("type") == "approval_request"
            and isinstance(part.get("approval"), dict)
            and str(part["approval"].get("id") or "") == approval_id
        ),
        None,
    )


def _upsert_message_artifacts(
    message: AIMessage,
    *,
    artifacts: tuple[dict[str, Any], ...],
) -> None:
    metadata = copy.deepcopy(message.message_metadata or {})
    existing = [item for item in metadata.get("artifacts") or [] if isinstance(item, dict)]
    positions = {
        str(item.get("id") or ""): index
        for index, item in enumerate(existing)
        if str(item.get("id") or "")
    }
    for artifact in artifacts:
        artifact_id = str(artifact.get("id") or "")
        if not artifact_id:
            continue
        encoded = jsonable_encoder(artifact)
        if artifact_id in positions:
            existing[positions[artifact_id]] = encoded
        else:
            positions[artifact_id] = len(existing)
            existing.append(encoded)
    metadata["artifacts"] = existing
    message.message_metadata = metadata


def hydrate_operation_result_server_now(
    payload: dict[str, Any],
    server_now: datetime,
) -> dict[str, Any]:
    hydrated = copy.deepcopy(payload)
    response_now = _as_utc(server_now)
    encoded_now = jsonable_encoder(response_now)
    _hydrate_operation_result_payload(
        hydrated,
        response_now=response_now,
        encoded_now=encoded_now,
    )
    return hydrated


def _hydrate_operation_result_payload(
    payload: Any,
    *,
    response_now: datetime,
    encoded_now: str,
) -> None:
    if isinstance(payload, list):
        for value in payload:
            _hydrate_operation_result_payload(
                value,
                response_now=response_now,
                encoded_now=encoded_now,
            )
        return
    if not isinstance(payload, dict):
        return
    if payload.get("type") == "operation_result" and isinstance(payload.get("data"), dict):
        data = payload["data"]
        if data.get("draft_id") or data.get("draftId"):
            data["server_now"] = encoded_now
            _expire_revert_availability(data, response_now=response_now)
    if (
        payload.get("draft_id")
        and payload.get("result_status")
        and payload.get("execution_mode")
        and "server_now" in payload
    ):
        payload["server_now"] = encoded_now
        _expire_revert_availability(payload, response_now=response_now)
    for value in payload.values():
        _hydrate_operation_result_payload(
            value,
            response_now=response_now,
            encoded_now=encoded_now,
        )


def _expire_revert_availability(
    record: dict[str, Any],
    *,
    response_now: datetime,
) -> None:
    if (
        record.get("result_status") != "completed"
        or record.get("revert_availability") != "available"
    ):
        return
    raw_deadline = record.get("revertible_until")
    if isinstance(raw_deadline, datetime):
        deadline = raw_deadline
    elif isinstance(raw_deadline, str) and raw_deadline:
        try:
            deadline = datetime.fromisoformat(raw_deadline.replace("Z", "+00:00"))
        except ValueError:
            return
    else:
        return
    if response_now > _as_utc(deadline):
        record["revert_availability"] = "expired"
