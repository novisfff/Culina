from __future__ import annotations

from typing import Any

from app.ai.skills.base import SkillResult
from app.services.ai_operations.registry import draft_operation_registry

MAX_PREVIEW_ITEMS = 5
MAX_TEXT_LENGTH = 180
COMPACT_METADATA_EXCLUDE_KEYS = {
    "artifacts",
    "liveStreaming",
    "livePartIds",
    "liveTextPartIds",
    "progressiveDraftIds",
    "progressiveApprovalIds",
}
DRAFT_TYPES = set(draft_operation_registry.keys())
DRAFT_CONTEXT_ARTIFACT_TYPES = {
    "approval_decision",
    "draft_after_approval",
    "resume_after_approval",
    "workflow.continuation",
}


def compact_conversation(
    conversation: list[dict[str, Any]],
    *,
    include_draft_artifacts: bool = True,
) -> list[dict[str, Any]]:
    return [
        _compact_message(item, include_draft_artifacts=include_draft_artifacts)
        for item in conversation
        if isinstance(item, dict)
    ]


def compact_artifacts(
    artifacts: list[dict[str, Any]],
    *,
    include_draft_artifacts: bool = True,
) -> list[dict[str, Any]]:
    return [
        _compact_artifact(item)
        for item in artifacts
        if isinstance(item, dict) and (include_draft_artifacts or not is_draft_context_artifact(item))
    ]


def compact_previous_results(
    results: list[SkillResult],
    *,
    include_draft_artifacts: bool = True,
) -> list[dict[str, Any]]:
    compacted: list[dict[str, Any]] = []
    for result in results:
        draft_artifacts = [
            _compact_artifact(
                {
                    "id": draft.get("draft_id") or f"previous:{draft.get('draft_type') or 'draft'}:{index}",
                    "type": draft.get("draft_type"),
                    "kind": "draft",
                    "status": result.status,
                    "version": 1,
                    "payload": draft.get("payload") if isinstance(draft.get("payload"), dict) else {},
                    "schemaVersion": draft.get("schema_version"),
                    "sourceDraftId": draft.get("draft_id"),
                    "sourceApprovalId": draft.get("approval_id"),
                }
            )
            for index, draft in enumerate(result.drafts, start=1)
            if isinstance(draft, dict)
        ] if include_draft_artifacts else []
        card_artifacts = [
            _compact_artifact(
                {
                    "id": card.get("id") or f"previous:card:{index}",
                    "type": card.get("type"),
                    "kind": "result_card",
                    "status": result.status,
                    "payload": card.get("data") if isinstance(card.get("data"), dict) else {},
                    "summary": card.get("title"),
                }
            )
            for index, card in enumerate(result.cards, start=1)
            if isinstance(card, dict)
        ]
        record: dict[str, Any] = {
            "text": _truncate(result.text),
            "status": result.status,
            "drafts": draft_artifacts,
            "cards": card_artifacts,
        }
        if result.operation:
            record["operation"] = result.operation
        if result.source_artifact_id:
            record["sourceArtifactId"] = result.source_artifact_id
        compacted.append(record)
    return compacted


def is_draft_context_artifact(artifact: dict[str, Any]) -> bool:
    artifact_type = str(artifact.get("type") or "")
    kind = str(artifact.get("kind") or "")
    payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
    return bool(
        kind == "draft"
        or artifact_type in DRAFT_TYPES
        or artifact_type in DRAFT_CONTEXT_ARTIFACT_TYPES
        or payload.get("draftType")
    )


def _compact_message(message: dict[str, Any], *, include_draft_artifacts: bool = True) -> dict[str, Any]:
    compact: dict[str, Any] = {
        "id": message.get("id"),
        "role": message.get("role"),
        "content": message.get("content"),
    }
    attachments = message.get("attachments")
    if isinstance(attachments, list) and attachments:
        compact["attachments"] = [
            {
                "type": item.get("type"),
                "mediaId": item.get("mediaId") or item.get("media_id"),
                "alt": _truncate(item.get("alt")),
            }
            for item in attachments
            if isinstance(item, dict)
        ]
    metadata = _compact_metadata(message.get("metadata"))
    if metadata:
        compact["metadata"] = metadata
    artifacts = message.get("artifacts")
    if isinstance(artifacts, list):
        compact["artifacts"] = compact_artifacts(artifacts, include_draft_artifacts=include_draft_artifacts)
    return compact


def _compact_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    metadata: dict[str, Any] = {}
    for key, item in value.items():
        if key in COMPACT_METADATA_EXCLUDE_KEYS:
            continue
        if isinstance(item, str):
            metadata[key] = _truncate(item)
        elif isinstance(item, bool | int | float) or item is None:
            metadata[key] = item
        elif isinstance(item, list):
            metadata[key] = _compact_list(item)
        elif isinstance(item, dict):
            metadata[key] = _compact_plain_dict(item)
    return metadata


def _compact_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    artifact_type = str(artifact.get("type") or "")
    kind = str(artifact.get("kind") or "") or _infer_kind(artifact)
    payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
    compact: dict[str, Any] = {
        "id": artifact.get("id"),
        "type": artifact_type,
        "kind": kind,
        "status": artifact.get("status"),
    }
    for key in ("version", "entityId", "businessEntityType", "updatedAt", "name", "sideEffect"):
        if artifact.get(key) is not None:
            compact[key] = artifact.get(key)
    _copy_source_ids(compact, artifact, payload)

    if artifact_type == "workflow.continuation":
        compact["payload"] = _compact_workflow_continuation(payload)
        return compact
    if artifact_type == "recipe_shortage":
        continuation = _as_dict(payload.get("continuation"))
        compact_continuation = _compact_workflow_continuation(continuation)
        compact_continuation["requiredDraftType"] = continuation.get("requiredDraftType")
        state = _as_dict(continuation.get("state"))
        shortages = state.get("shortages") if isinstance(state.get("shortages"), list) else []
        compact_continuation["state"] = {
            "recipeId": state.get("recipeId"),
            "shortages": [
                {
                    key: row[key]
                    for key in ("ingredientId", "ingredientName", "shortageType", "quantity", "unit")
                    if key in row and row[key] is not None
                }
                for row in shortages[:50]
                if isinstance(row, dict)
            ],
        }
        compact["summary"] = _truncate(artifact.get("summary") or payload.get("recipeTitle") or "菜谱缺料")
        compact["payload"] = {
            "recipeId": payload.get("recipeId"),
            "actionPrompt": _truncate(payload.get("actionPrompt")),
            "continuation": compact_continuation,
        }
        return compact

    if artifact_type in {"draft_after_approval", "resume_after_approval"}:
        compact["summary"] = _truncate(payload.get("instruction") or artifact.get("summary") or "确认后继续任务")
        compact["payload"] = _compact_resume_payload(payload)
        return compact
    if artifact_type == "human.input_result":
        compact["summary"] = _truncate(_as_dict(payload).get("summary") or "用户已补充信息")
        compact["payload"] = _compact_human_input_payload(payload)
        return compact
    if artifact_type == "approval_decision":
        return _compact_approval_decision(artifact, compact, payload)
    if artifact_type == "tool_call" or kind == "tool_call":
        compact["summary"] = _truncate(artifact.get("name") or "工具调用")
        if isinstance(payload.get("input"), dict):
            compact["inputKeys"] = sorted(str(key) for key in payload["input"].keys())
        return compact

    summary = _truncate(artifact.get("summary") or _payload_summary(artifact_type, payload))
    if summary:
        compact["summary"] = summary
    counts = _payload_counts(payload)
    if counts:
        compact["counts"] = counts
    preview_items = _preview_items(artifact_type, payload)
    if preview_items:
        compact["previewItems"] = preview_items
    schema_version = artifact.get("schemaVersion") or payload.get("schemaVersion")
    if schema_version:
        compact["schemaVersion"] = schema_version
    return compact


def _compact_workflow_continuation(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "workflowId": payload.get("workflowId"),
        "stepKey": payload.get("stepKey"),
        "reasonCode": payload.get("reasonCode"),
        "nextSkillKey": payload.get("nextSkillKey"),
        "resumeSkillKey": payload.get("resumeSkillKey"),
        "stateSchema": payload.get("stateSchema"),
        "state": _compact_plain_dict(payload.get("state") or {}),
        "businessEntityIds": list(payload.get("businessEntityIds") or [])[:20],
    }


def _compact_approval_decision(
    artifact: dict[str, Any],
    compact: dict[str, Any],
    payload: dict[str, Any],
) -> dict[str, Any]:
    approval = _as_dict(payload.get("approval"))
    draft = _as_dict(payload.get("draft"))
    operation = _as_dict(payload.get("operation"))
    draft_payload = _as_dict(draft.get("payload"))
    draft_type = str(draft.get("draft_type") or draft.get("draftType") or draft_payload.get("draftType") or "")
    operation_summary = _truncate(operation.get("action_summary") or operation.get("summary"))
    summary = operation_summary or _truncate(artifact.get("summary") or _payload_summary(draft_type, draft_payload))
    compact.update(
        {
            "status": artifact.get("status") or approval.get("status"),
            "sourceDraftId": artifact.get("sourceDraftId") or draft.get("id") or approval.get("draft_id"),
            "sourceApprovalId": artifact.get("sourceApprovalId") or approval.get("id"),
            "summary": summary or f"approval {approval.get('status') or artifact.get('status') or 'resolved'}",
            "payload": {
                "approval": {
                    "id": approval.get("id"),
                    "status": approval.get("status"),
                    "decision": approval.get("decision"),
                    "approvalType": approval.get("approval_type") or approval.get("approvalType"),
                    "title": _truncate(approval.get("title")),
                },
                "draft": {
                    "id": draft.get("id") or approval.get("draft_id"),
                    "draft_type": draft_type,
                    "status": draft.get("status"),
                    "summary": _truncate(draft.get("preview_summary") or _payload_summary(draft_type, draft_payload)),
                    "schemaVersion": draft.get("schema_version") or draft.get("schemaVersion"),
                },
                "operation": {
                    "id": operation.get("id"),
                    "status": operation.get("status"),
                    "businessEntityType": operation.get("business_entity_type") or operation.get("businessEntityType"),
                    "actionSummary": operation_summary,
                },
            },
        }
    )
    return compact


def _copy_source_ids(compact: dict[str, Any], artifact: dict[str, Any], payload: dict[str, Any]) -> None:
    for target_key, candidates in {
        "sourceDraftId": ("sourceDraftId", "source_draft_id", "draftId", "draft_id"),
        "sourceApprovalId": ("sourceApprovalId", "source_approval_id", "approvalId", "approval_id"),
        "sourceOperationId": ("sourceOperationId", "source_operation_id", "operationId", "operation_id"),
    }.items():
        for key in candidates:
            value = artifact.get(key)
            if value is None:
                value = payload.get(key)
            if value:
                compact[target_key] = value
                break


def _infer_kind(artifact: dict[str, Any]) -> str:
    artifact_type = str(artifact.get("type") or "")
    payload = artifact.get("payload") if isinstance(artifact.get("payload"), dict) else {}
    if artifact_type in DRAFT_TYPES or payload.get("draftType"):
        return "draft"
    if artifact_type in {"approval_decision", "draft_after_approval", "human.input_result"}:
        return artifact_type
    if payload:
        return "artifact"
    return ""


def _compact_resume_payload(payload: dict[str, Any]) -> dict[str, Any]:
    compact: dict[str, Any] = {}
    for key in ("instruction", "nextDraftType"):
        if payload.get(key):
            compact[key] = _truncate(payload.get(key))
    if isinstance(payload.get("taskState"), dict):
        compact["taskState"] = _compact_plain_dict(payload["taskState"])
    return compact


def _compact_human_input_payload(payload: dict[str, Any]) -> dict[str, Any]:
    request = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    compact: dict[str, Any] = {
        "requestId": request.get("id"),
        "question": _truncate(request.get("question")),
        "request": {
            "id": request.get("id"),
            "question": _truncate(request.get("question")),
            "inputMode": request.get("inputMode"),
            "resumeHint": request.get("resumeHint") if isinstance(request.get("resumeHint"), dict) else {},
            "sourceSkills": request.get("sourceSkills") if isinstance(request.get("sourceSkills"), list) else [],
        },
        "summary": _truncate(payload.get("summary")),
    }
    selected = payload.get("selectedOptionIds")
    if isinstance(selected, list):
        compact["selectedOptionIds"] = [str(item) for item in selected[:MAX_PREVIEW_ITEMS]]
    if payload.get("text"):
        compact["text"] = _truncate(payload.get("text"))
    return {key: value for key, value in compact.items() if value not in (None, "", [])}


def _payload_summary(artifact_type: str, payload: dict[str, Any]) -> str:
    draft_type = str(payload.get("draftType") or payload.get("draft_type") or artifact_type or "")
    if draft_type:
        try:
            return draft_operation_registry.preview_summary(draft_type, payload)
        except (KeyError, TypeError, ValueError):
            pass
    if payload.get("action"):
        action = str(payload.get("action") or "")
        target = _payload_label(_as_dict(payload.get("payload"))) or _payload_label(_as_dict(payload.get("before"))) or str(payload.get("targetId") or "")
        return " · ".join(item for item in [action, target] if item)
    return _payload_label(payload) or artifact_type


def _payload_counts(payload: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for source_key, target_key in {
        "items": "itemCount",
        "operations": "operationCount",
        "steps": "stepCount",
        "ingredient_items": "ingredientCount",
        "ingredients": "ingredientCount",
        "foods": "foodCount",
        "shortages": "shortageCount",
    }.items():
        value = payload.get(source_key)
        if isinstance(value, list):
            counts[target_key] = len(value)
    nested_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    if nested_payload:
        for key, value in _payload_counts(nested_payload).items():
            counts.setdefault(key, value)
    return counts


def _preview_items(artifact_type: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    draft_payload = _as_dict(payload.get("payload")) if payload.get("action") else payload
    candidates: list[Any] = []
    for key in ("items", "operations", "foods", "shortages", "ingredient_items", "ingredients", "steps"):
        value = draft_payload.get(key)
        if isinstance(value, list) and value:
            candidates = value
            break
    preview: list[dict[str, Any]] = []
    for item in candidates[:MAX_PREVIEW_ITEMS]:
        if not isinstance(item, dict):
            preview.append({"label": _truncate(item)})
            continue
        label = _payload_label(item) or _payload_label(_as_dict(item.get("payload"))) or str(item.get("operationId") or item.get("stepId") or "")
        record: dict[str, Any] = {"label": _truncate(label or artifact_type)}
        for key in ("id", "targetId", "action", "date", "mealType", "quantity", "unit"):
            if item.get(key) is not None:
                record[key] = item.get(key)
        preview.append(record)
    return preview


def _payload_label(payload: dict[str, Any]) -> str:
    for key in ("title", "name", "ingredient_name", "ingredientName", "food_name", "foodName", "summary"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if payload.get("date") and payload.get("mealType"):
        return f"{payload.get('date')} {payload.get('mealType')}"
    return ""


def _compact_plain_dict(value: dict[str, Any]) -> dict[str, Any]:
    compact: dict[str, Any] = {}
    for key, item in value.items():
        if key in COMPACT_METADATA_EXCLUDE_KEYS:
            continue
        if isinstance(item, str):
            compact[key] = _truncate(item)
        elif isinstance(item, bool | int | float) or item is None:
            compact[key] = item
        elif isinstance(item, list):
            compact[key] = _compact_list(item)
    return compact


def _compact_list(value: list[Any]) -> dict[str, Any]:
    preview = []
    for item in value[:MAX_PREVIEW_ITEMS]:
        if isinstance(item, dict):
            preview.append(_compact_plain_dict(item))
        else:
            preview.append(_truncate(item))
    return {"count": len(value), "preview": preview}


def _truncate(value: Any, limit: int = MAX_TEXT_LENGTH) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[: limit - 1]}..."


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}
