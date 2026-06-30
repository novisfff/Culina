from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from app.ai.errors import ApprovalRequired
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.orchestrator.skill_injection import SkillInjectionManager
from app.ai.workflows.orchestrator.state import OrchestratorRunState


@dataclass(frozen=True, slots=True)
class PreparedToolPayload:
    payload: dict[str, Any]
    after_approval: dict[str, Any] = field(default_factory=dict)


def prepare_tool_payload(
    *,
    payload: dict[str, Any],
    execution_definition: ToolDefinition,
) -> PreparedToolPayload:
    if execution_definition.side_effect != "draft" or not isinstance(payload.get("draft"), dict):
        return PreparedToolPayload(payload=payload)
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
    after_approval = payload.get("afterApproval") if isinstance(payload.get("afterApproval"), dict) else {}
    return PreparedToolPayload(payload=tool_payload, after_approval=after_approval)


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
    after_approval: dict[str, Any],
    progressive_draft_publisher,
) -> None:
    state.draft_created_this_call = True
    input_draft = tool_payload.get("draft") if isinstance(tool_payload.get("draft"), dict) else {}
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
        draft_record = {
            "draft_type": draft_type,
            "payload": draft,
            "schema_version": str(draft.get("schemaVersion") or f"{draft_type}.v1"),
            "tool": tool_name,
            "after_approval": after_approval,
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
    raise ApprovalRequired("approval required")
