from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from app.ai.skills.registry import SkillRegistry
from app.ai.skills.state_schemas import validate_continuation_state
from app.ai.workflows.orchestrator.profiles import OrchestratorCapabilityPolicy


CONTINUATION_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "workflowId",
        "stepKey",
        "reasonCode",
        "nextSkillKey",
        "resumeSkillKey",
        "requiredDraftType",
        "stateSchema",
        "state",
    ],
    "properties": {
        "workflowId": {"type": "string", "minLength": 1, "maxLength": 128},
        "stepKey": {"type": "string", "minLength": 1, "maxLength": 128},
        "reasonCode": {"type": "string", "minLength": 1, "maxLength": 64},
        "nextSkillKey": {"type": "string", "minLength": 1, "maxLength": 64},
        "resumeSkillKey": {"type": "string", "minLength": 1, "maxLength": 64},
        "requiredDraftType": {"type": "string", "minLength": 1, "maxLength": 64},
        "stateSchema": {"type": "string", "minLength": 1, "maxLength": 128},
        "state": {"type": "object"},
    },
}


class ContinuationValidationError(ValueError):
    def __init__(
        self,
        *,
        code: str,
        details: list[dict[str, str]] | None = None,
    ) -> None:
        self.code = code
        self.details = details or []
        super().__init__(code)


@dataclass(frozen=True, slots=True)
class ContinuationRequest:
    workflow_id: str
    step_key: str
    reason_code: str
    next_skill_key: str
    resume_skill_key: str
    required_draft_type: str
    state_schema: str
    state: dict[str, Any]


def _request_from_payload(payload: dict[str, Any]) -> ContinuationRequest:
    field_map = {
        "workflowId": "workflow_id",
        "stepKey": "step_key",
        "reasonCode": "reason_code",
        "nextSkillKey": "next_skill_key",
        "resumeSkillKey": "resume_skill_key",
        "requiredDraftType": "required_draft_type",
        "stateSchema": "state_schema",
    }
    values: dict[str, Any] = {}
    details: list[dict[str, str]] = []
    for source, target in field_map.items():
        value = payload.get(source)
        text = value.strip() if isinstance(value, str) else ""
        if not text:
            details.append({"path": source, "message": "Field required"})
        values[target] = text
    state = payload.get("state")
    if not isinstance(state, dict):
        details.append({"path": "state", "message": "Input should be an object"})
        state = {}
    if details:
        raise ContinuationValidationError(code="invalid_continuation", details=details)
    return ContinuationRequest(**values, state=state)


def _mismatch(condition: bool, code: str, path: str) -> None:
    if condition:
        raise ContinuationValidationError(
            code=code,
            details=[{"path": path, "message": "Value does not match the declared handoff"}],
        )


def normalize_continuation(
    *,
    payload: dict[str, Any],
    source_skill_key: str,
    skill_registry: SkillRegistry,
    capability_policy: OrchestratorCapabilityPolicy,
) -> dict[str, Any]:
    request = _request_from_payload(payload)
    try:
        source_manifest = skill_registry.get(source_skill_key).manifest
    except KeyError as exc:
        raise ContinuationValidationError(code="unknown_continuation_source_skill") from exc
    handoff = source_manifest.handoffs.get(request.reason_code)
    if handoff is None:
        raise ContinuationValidationError(code="unknown_continuation_reason")

    _mismatch(
        request.next_skill_key != handoff.target_skill,
        "continuation_target_mismatch",
        "nextSkillKey",
    )
    _mismatch(
        request.resume_skill_key != handoff.resume_skill,
        "continuation_resume_skill_mismatch",
        "resumeSkillKey",
    )
    _mismatch(
        request.required_draft_type != handoff.required_draft_type,
        "continuation_draft_type_mismatch",
        "requiredDraftType",
    )
    _mismatch(
        request.state_schema != handoff.state_schema,
        "continuation_state_schema_mismatch",
        "stateSchema",
    )
    if not capability_policy.allows_skill(request.next_skill_key) or not capability_policy.allows_skill(
        request.resume_skill_key
    ):
        raise ContinuationValidationError(code="continuation_skill_not_allowed")

    try:
        normalized_state = validate_continuation_state(request.state_schema, request.state)
    except ValidationError as exc:
        raise ContinuationValidationError(
            code="invalid_continuation_state",
            details=[
                {
                    "path": ".".join(str(part) for part in error["loc"]),
                    "message": error["msg"],
                }
                for error in exc.errors(include_url=False)
            ],
        ) from exc

    return {
        "workflowId": request.workflow_id,
        "stepKey": request.step_key,
        "reasonCode": request.reason_code,
        "nextSkillKey": request.next_skill_key,
        "resumeSkillKey": request.resume_skill_key,
        "requiredDraftType": request.required_draft_type,
        "stateSchema": request.state_schema,
        "state": normalized_state,
        "status": "pending",
        "version": 1,
    }
