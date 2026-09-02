from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from app.ai.errors import ApprovalRequired, DraftRouted
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.orchestrator.skill_injection import SkillInjectionManager
from app.ai.workflows.orchestrator.continuation import normalize_continuation
from app.ai.workflows.orchestrator.profiles import OrchestratorCapabilityPolicy
from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.services.ai_auto_execution.intent_evidence import (
    intent_evidence_validation_record,
    validate_intent_evidence,
)
from app.services.ai_auto_execution.policy_types import TrustedResolutionSource


@dataclass(frozen=True, slots=True)
class PreparedToolPayload:
    payload: dict[str, Any]
    continuation: dict[str, Any] = field(default_factory=dict)


_INTENT_EVIDENCE_FIELDS = (
    "intentClarity",
    "sourceQuotes",
    "resolutionSources",
    "ambiguityCodes",
    "defaultedFields",
)


def _normalize_model_intent_evidence(payload: dict[str, Any]) -> dict[str, Any]:
    """Put evidence back on the draft boundary before strict validation.

    The model sometimes treats ``payload`` as the complete draft object and
    nests the policy metadata below it.  Evidence is not business data: the
    stable contract is ``arguments.draft.intentEvidence`` (a sibling of
    ``arguments.draft.payload``).  Repair only these known placements and keep
    conflicting copies visible to validation instead of silently choosing one.
    """
    draft = payload.get("draft")
    if not isinstance(draft, dict):
        return payload

    normalized_draft = dict(draft)
    business_payload = normalized_draft.get("payload")
    normalized_business_payload = dict(business_payload) if isinstance(business_payload, dict) else None

    evidence_candidates: list[tuple[str, dict[str, Any]]] = []
    for location, mapping in (
        ("draft", normalized_draft),
        ("root", payload),
        ("draft.payload", normalized_business_payload),
    ):
        if mapping is None:
            continue
        explicit = mapping.get("intentEvidence")
        if "intentEvidence" in mapping and not isinstance(explicit, dict):
            raise ValueError(f"{location}.intentEvidence must be an object")
        candidate = dict(explicit) if isinstance(explicit, dict) else {}
        has_candidate = isinstance(explicit, dict)
        for key in _INTENT_EVIDENCE_FIELDS:
            if key not in mapping:
                continue
            has_candidate = True
            value = mapping[key]
            if key in candidate and candidate[key] != value:
                raise ValueError(f"{key} conflicts with the value inside intentEvidence")
            candidate[key] = value
        if has_candidate:
            evidence_candidates.append((location, candidate))

    merged_evidence: dict[str, Any] | None = None
    for location, candidate in evidence_candidates:
        if merged_evidence is None:
            merged_evidence = dict(candidate)
            continue
        for key, value in candidate.items():
            if key in merged_evidence and merged_evidence[key] != value:
                raise ValueError("intentEvidence appears in multiple locations with conflicting values")
            merged_evidence[key] = value

    if merged_evidence is not None:
        normalized_draft["intentEvidence"] = merged_evidence
        # Evidence fields are metadata, never business-draft fields.  Remove
        # every flattened copy from the draft boundary after collecting it;
        # leaving even one behind still trips the draft schema's
        # ``additionalProperties: false`` check.
        for key in _INTENT_EVIDENCE_FIELDS:
            normalized_draft.pop(key, None)
        if normalized_business_payload is not None:
            for key in _INTENT_EVIDENCE_FIELDS:
                normalized_business_payload.pop(key, None)
            normalized_business_payload.pop("intentEvidence", None)
            normalized_draft["payload"] = normalized_business_payload

    if normalized_draft == draft:
        return payload
    return {**payload, "draft": normalized_draft}


def prepare_tool_payload(
    *,
    payload: dict[str, Any],
    execution_definition: ToolDefinition,
    source_skill_key: str | None = None,
    injection_manager: SkillInjectionManager | None = None,
    capability_policy: OrchestratorCapabilityPolicy | None = None,
) -> PreparedToolPayload:
    if execution_definition.side_effect != "draft" or not isinstance(payload.get("draft"), dict):
        return PreparedToolPayload(payload=payload)
    payload = _normalize_model_intent_evidence(payload)
    input_properties = (
        execution_definition.input_schema.get("properties")
        if isinstance(execution_definition.input_schema, dict)
        else {}
    )
    tool_payload = (
        {"draft": payload["draft"]}
        if isinstance(input_properties, dict) and "draft" in input_properties
        else payload["draft"]
    )
    raw_continuation = payload.get("continuation")
    if raw_continuation is None:
        return PreparedToolPayload(payload=tool_payload)
    if not isinstance(raw_continuation, dict):
        raise ValueError("continuation must be an object")
    if not source_skill_key or injection_manager is None or capability_policy is None:
        raise ValueError("continuation requires one owning Skill and active capability policy")
    continuation = normalize_continuation(
        payload=raw_continuation,
        source_skill_key=source_skill_key,
        skill_registry=injection_manager.skill_registry,
        capability_policy=capability_policy,
    )
    return PreparedToolPayload(payload=tool_payload, continuation=continuation)


def enforce_single_draft_per_call(
    *,
    state: OrchestratorRunState,
    injection_manager: SkillInjectionManager,
    tool_name: str,
    tool_payload: dict[str, Any],
) -> None:
    if not state.draft_created_this_call:
        return
    retry_draft = tool_payload.get("draft") if isinstance(tool_payload.get("draft"), dict) else {}
    if retry_draft:
        retry_draft_type = injection_manager.draft_type_from_tool_output(
            tool_name,
            retry_draft,
            state.active_skill_keys,
        )
        retry_key = (
            retry_draft_type,
            json.dumps(retry_draft, sort_keys=True, ensure_ascii=False, default=str),
        )
        if retry_key in state.draft_input_keys_this_call:
            raise ApprovalRequired("approval required")
    raise ApprovalRequired("approval required")


def capture_draft_output(
    *,
    state: OrchestratorRunState,
    injection_manager: SkillInjectionManager,
    tool_name: str,
    tool_payload: dict[str, Any],
    output: dict[str, Any],
    continuation: dict[str, Any],
    progressive_draft_publisher,
    current_message: str = "",
    family_id: str = "",
    trusted_resolution_sources: dict[str, TrustedResolutionSource] | None = None,
) -> None:
    state.draft_created_this_call = True
    input_draft = tool_payload.get("draft") if isinstance(tool_payload.get("draft"), dict) else {}
    raw_intent_evidence = input_draft.get("intentEvidence") if isinstance(input_draft.get("intentEvidence"), dict) else None
    draft = output.get("draft")
    if isinstance(draft, dict):
        draft_type = injection_manager.draft_type_from_tool_output(tool_name, draft, state.active_skill_keys)
        if input_draft:
            state.draft_input_keys_this_call.add(
                (
                    injection_manager.draft_type_from_tool_output(
                        tool_name,
                        input_draft,
                        state.active_skill_keys,
                    ),
                    json.dumps(input_draft, sort_keys=True, ensure_ascii=False, default=str),
                )
            )
        owning_skill_keys = (
            injection_manager.skill_keys_for_tool(tool_name, state.active_skill_keys)
            if hasattr(injection_manager, "skill_keys_for_tool")
            else []
        )
        skill_registry = getattr(injection_manager, "skill_registry", None)
        skill_approval_policy = (
            skill_registry.get(owning_skill_keys[0]).manifest.approval_policy
            if len(owning_skill_keys) == 1 and skill_registry is not None
            else "draft_then_confirm"
        )
        draft_record = {
            "draft_type": draft_type,
            "payload": draft,
            "schema_version": str(draft.get("schemaVersion") or f"{draft_type}.v1"),
            "tool": tool_name,
            "skill_approval_policy": skill_approval_policy,
            "continuation": continuation,
            "intent_evidence_input": raw_intent_evidence,
            "trusted_resolution_sources": dict(trusted_resolution_sources or {}),
            "intent_evidence_validation": intent_evidence_validation_record(
                validate_intent_evidence(
                    evidence=raw_intent_evidence,
                    current_message=current_message,
                    family_id=family_id,
                    requirements=(),
                    trusted_sources=trusted_resolution_sources or {},
                )
            ),
        }
        draft_key = (
            draft_type,
            json.dumps(draft, sort_keys=True, ensure_ascii=False, default=str),
        )
        published = state.published_drafts_by_key.get(draft_key)
        if published is None and progressive_draft_publisher is not None:
            published = progressive_draft_publisher(draft_record)
            state.published_drafts_by_key[draft_key] = published
        if published:
            draft_record.update(published)
        state.draft_outputs.append(draft_record)
        route_status = str(draft_record.get("route_status") or "")
        route_outcome = draft_record.get("route_outcome")
        if route_status in {"auto_executed", "no_change", "execution_failed"} and route_outcome is not None:
            raise DraftRouted(route_outcome)
    raise ApprovalRequired("approval required")
