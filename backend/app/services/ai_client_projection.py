from __future__ import annotations

import copy
from typing import Any

from app.ai.draft_contracts import (
    RECIPE_COOK_V1,
    RECIPE_COOK_V2,
    ClientContractUpgradeRequired,
    DraftContractCapabilities,
)

UPGRADE_TEXT = "当前应用版本不支持新的做菜确认，请刷新并更新后继续。原草稿仍会安全保留。"
PUBLIC_CONVERSATION_CONTEXT_KEYS = frozenset({"activeRunId"})

_GATED_RECIPE_COOK_VERSIONS = frozenset({RECIPE_COOK_V1, RECIPE_COOK_V2})


def require_viewer_contract(schema_version: str | None, capabilities: DraftContractCapabilities) -> None:
    schema = str(schema_version or "").strip()
    if not schema or schema == RECIPE_COOK_V1:
        return
    if schema == RECIPE_COOK_V2 and RECIPE_COOK_V2 not in capabilities.recipe_cook_versions:
        raise ClientContractUpgradeRequired()
    if schema in _GATED_RECIPE_COOK_VERSIONS and schema not in capabilities.recipe_cook_versions:
        raise ClientContractUpgradeRequired()


def viewer_supports_schema(schema_version: str | None, capabilities: DraftContractCapabilities) -> bool:
    try:
        require_viewer_contract(schema_version, capabilities)
    except ClientContractUpgradeRequired:
        return False
    return True


def extract_contract_schema(value: Any) -> str | None:
    """Return the first gated draft-contract schema version found in a payload tree."""
    found = _collect_contract_schemas(value, limit=1)
    return next(iter(found), None)


def artifact_contains_v2_command(artifact: Any) -> bool:
    return RECIPE_COOK_V2 in _collect_contract_schemas(artifact)


def project_ai_conversation(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    del capabilities  # public allowlist is viewer-independent
    projected = copy.deepcopy(payload)
    source = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    projected["context"] = {
        key: copy.deepcopy(source[key])
        for key in PUBLIC_CONVERSATION_CONTEXT_KEYS
        if key in source
    }
    return projected


def upgrade_message_part(part_id: str) -> dict[str, Any]:
    return {
        "id": part_id,
        "type": "error_recovery",
        "status": "blocked",
        "text": UPGRADE_TEXT,
    }


def project_message_part(part: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(part)
    if not isinstance(projected, dict):
        return projected
    part_type = str(projected.get("type") or "")
    if part_type == "draft":
        draft = projected.get("draft") if isinstance(projected.get("draft"), dict) else {}
        schema = _schema_from_draft(draft)
        if not viewer_supports_schema(schema, capabilities):
            return upgrade_message_part(str(projected.get("id") or "draft-part"))
        projected["draft"] = project_ai_draft(draft, capabilities)
        return projected
    if part_type == "approval_request":
        approval = projected.get("approval") if isinstance(projected.get("approval"), dict) else {}
        schema = _schema_from_approval(approval)
        if not viewer_supports_schema(schema, capabilities):
            return upgrade_message_part(str(projected.get("id") or "approval-part"))
        projected["approval"] = project_ai_approval(approval, capabilities)
        return projected
    if part_type == "result_card" and isinstance(projected.get("card"), dict):
        card = projected["card"]
        if RECIPE_COOK_V2 in _collect_contract_schemas(card) and not viewer_supports_schema(
            RECIPE_COOK_V2, capabilities
        ):
            return upgrade_message_part(str(projected.get("id") or "card-part"))
    return projected


def project_message_metadata(metadata: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(metadata) if isinstance(metadata, dict) else {}
    if not isinstance(projected, dict):
        return {}
    artifacts = projected.get("artifacts")
    if not isinstance(artifacts, list):
        return projected
    if viewer_supports_schema(RECIPE_COOK_V2, capabilities):
        projected["artifacts"] = [copy.deepcopy(item) for item in artifacts if isinstance(item, dict)]
        return projected
    projected["artifacts"] = [
        copy.deepcopy(item)
        for item in artifacts
        if isinstance(item, dict) and not artifact_contains_v2_command(item)
    ]
    return projected


def project_ai_message(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    projected["parts"] = [
        project_message_part(part, capabilities)
        for part in projected.get("parts") or []
        if isinstance(part, dict)
    ]
    projected["metadata"] = project_message_metadata(projected.get("metadata") or {}, capabilities)
    return projected


def project_ai_draft(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    schema = _schema_from_draft(projected)
    if viewer_supports_schema(schema, capabilities):
        return projected
    # Defense in depth: never hand an editable gated command to an old viewer.
    projected["payload"] = {}
    return projected


def project_ai_approval(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    schema = _schema_from_approval(projected)
    if viewer_supports_schema(schema, capabilities):
        return projected
    projected["initial_values"] = {}
    projected["submitted_values"] = {}
    projected["field_schema"] = []
    return projected


def project_ai_chat_response(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    if isinstance(projected.get("message"), dict):
        projected["message"] = project_ai_message(projected["message"], capabilities)
    included = projected.get("included") if isinstance(projected.get("included"), dict) else {}
    next_included = copy.deepcopy(included) if isinstance(included, dict) else {}
    drafts = next_included.get("drafts") if isinstance(next_included.get("drafts"), list) else []
    approvals = next_included.get("approvals") if isinstance(next_included.get("approvals"), list) else []
    next_included["drafts"] = [
        project_ai_draft(item, capabilities)
        for item in drafts
        if isinstance(item, dict) and viewer_supports_schema(_schema_from_draft(item), capabilities)
    ]
    next_included["approvals"] = [
        project_ai_approval(item, capabilities)
        for item in approvals
        if isinstance(item, dict) and viewer_supports_schema(_schema_from_approval(item), capabilities)
    ]
    if "result_cards" in next_included and isinstance(next_included.get("result_cards"), list):
        next_included["result_cards"] = [
            copy.deepcopy(card)
            for card in next_included["result_cards"]
            if isinstance(card, dict)
            and (
                viewer_supports_schema(RECIPE_COOK_V2, capabilities)
                or RECIPE_COOK_V2 not in _collect_contract_schemas(card)
            )
        ]
    projected["included"] = next_included
    if isinstance(projected.get("events"), list):
        projected["events"] = [
            project_ai_run_event(event, capabilities) if isinstance(event, dict) else event
            for event in projected["events"]
        ]
    return projected


def project_ai_decision_response(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    if isinstance(projected.get("approval"), dict):
        projected["approval"] = project_ai_approval(projected["approval"], capabilities)
    if isinstance(projected.get("draft"), dict):
        projected["draft"] = project_ai_draft(projected["draft"], capabilities)
    if isinstance(projected.get("message"), dict):
        projected["message"] = project_ai_message(projected["message"], capabilities)
    if isinstance(projected.get("business_entity"), dict):
        # Do not gate on first-schema only: composite trees can surface v1 before nested v2.
        if (
            not viewer_supports_schema(RECIPE_COOK_V2, capabilities)
            and RECIPE_COOK_V2 in _collect_contract_schemas(projected["business_entity"])
        ):
            projected["business_entity"] = _strip_v2_commands(projected["business_entity"])
    return projected


def project_ai_run_event(payload: dict[str, Any], capabilities: DraftContractCapabilities) -> dict[str, Any]:
    projected = copy.deepcopy(payload)
    if isinstance(projected.get("message"), dict):
        projected["message"] = project_ai_message(projected["message"], capabilities)
    if isinstance(projected.get("part"), dict):
        projected["part"] = project_message_part(projected["part"], capabilities)
    if isinstance(projected.get("approval"), dict):
        schema = _schema_from_approval(projected["approval"])
        if viewer_supports_schema(schema, capabilities):
            projected["approval"] = project_ai_approval(projected["approval"], capabilities)
        else:
            projected.pop("approval", None)
    if isinstance(projected.get("draft"), dict):
        schema = _schema_from_draft(projected["draft"])
        if viewer_supports_schema(schema, capabilities):
            projected["draft"] = project_ai_draft(projected["draft"], capabilities)
        else:
            projected.pop("draft", None)
    if isinstance(projected.get("payload"), dict):
        # Always scan the full tree for nested v2; first-schema short-circuit can miss it.
        if (
            not viewer_supports_schema(RECIPE_COOK_V2, capabilities)
            and RECIPE_COOK_V2 in _collect_contract_schemas(projected["payload"])
        ):
            projected["payload"] = _strip_v2_commands(projected["payload"])
    return projected


def project_ai_sse_event(
    event_name: str,
    data: dict[str, Any],
    *,
    viewer_capabilities: DraftContractCapabilities,
) -> tuple[str, dict[str, Any]]:
    name = str(event_name or "")
    payload = data if isinstance(data, dict) else {}
    if name == "response":
        return name, project_ai_chat_response(payload, viewer_capabilities)
    if name == "message_part":
        projected = copy.deepcopy(payload)
        if isinstance(projected.get("part"), dict):
            projected["part"] = project_message_part(projected["part"], viewer_capabilities)
        if isinstance(projected.get("message"), dict):
            projected["message"] = project_ai_message(projected["message"], viewer_capabilities)
        return name, projected
    if name in {"progress", "run_event"}:
        return name, project_ai_run_event(payload, viewer_capabilities)
    if name in {"approval_required", "decision", "approval"}:
        return name, project_ai_decision_response(payload, viewer_capabilities)
    # Generic defense: project any nested public AI structures that may appear.
    projected = copy.deepcopy(payload)
    if isinstance(projected.get("message"), dict):
        projected["message"] = project_ai_message(projected["message"], viewer_capabilities)
    if isinstance(projected.get("part"), dict):
        projected["part"] = project_message_part(projected["part"], viewer_capabilities)
    if isinstance(projected.get("approval"), dict):
        schema = _schema_from_approval(projected["approval"])
        if viewer_supports_schema(schema, viewer_capabilities):
            projected["approval"] = project_ai_approval(projected["approval"], viewer_capabilities)
        else:
            projected.pop("approval", None)
    if isinstance(projected.get("draft"), dict):
        schema = _schema_from_draft(projected["draft"])
        if viewer_supports_schema(schema, viewer_capabilities):
            projected["draft"] = project_ai_draft(projected["draft"], viewer_capabilities)
        else:
            projected.pop("draft", None)
    if isinstance(projected.get("included"), dict):
        projected = project_ai_chat_response(projected, viewer_capabilities)
    return name, projected


def _schema_from_draft(draft: dict[str, Any]) -> str | None:
    if not isinstance(draft, dict):
        return None
    schema = str(draft.get("schema_version") or draft.get("schemaVersion") or "").strip()
    if schema:
        return schema
    payload = draft.get("payload") if isinstance(draft.get("payload"), dict) else {}
    nested = str(payload.get("schemaVersion") or payload.get("schema_version") or "").strip()
    return nested or None


def _schema_from_approval(approval: dict[str, Any]) -> str | None:
    if not isinstance(approval, dict):
        return None
    schema = str(approval.get("draft_schema_version") or approval.get("draftSchemaVersion") or "").strip()
    if schema:
        return schema
    for key in ("initial_values", "submitted_values", "initialValues", "submittedValues"):
        values = approval.get(key)
        if isinstance(values, dict):
            found = extract_contract_schema(values)
            if found:
                return found
    return None


def _collect_contract_schemas(value: Any, *, limit: int | None = None) -> set[str]:
    found: set[str] = set()

    def visit(node: Any) -> None:
        if limit is not None and len(found) >= limit:
            return
        if isinstance(node, dict):
            for key, child in node.items():
                if key in {"schemaVersion", "schema_version", "draft_schema_version", "draftSchemaVersion"}:
                    schema = str(child or "").strip()
                    if schema in _GATED_RECIPE_COOK_VERSIONS:
                        found.add(schema)
                        if limit is not None and len(found) >= limit:
                            return
                visit(child)
            return
        if isinstance(node, list):
            for item in node:
                visit(item)
                if limit is not None and len(found) >= limit:
                    return

    visit(value)
    return found


def _strip_v2_commands(value: Any) -> Any:
    if isinstance(value, dict):
        schema = str(value.get("schemaVersion") or value.get("schema_version") or "").strip()
        if schema == RECIPE_COOK_V2:
            return {"schemaVersion": RECIPE_COOK_V2, "blocked": True}
        return {key: _strip_v2_commands(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_strip_v2_commands(item) for item in value]
    return value
