from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol

from sqlalchemy.orm import Session


IntentClarity = Literal[
    "explicit_complete",
    "explicit_context_resolved",
    "explicit_incomplete",
    "inferred",
]
PolicyRoute = Literal["auto_execute", "manual_confirmation", "no_change"]
DraftExecutionRoute = Literal["manual_confirmation", "policy_auto", "policy_no_change"]
DraftRouteStatus = Literal["waiting_approval", "auto_executed", "no_change", "execution_failed"]
ExecutionMode = Literal["manual_approval", "policy_auto", "policy_no_change"]
AuthorizationSource = Literal[
    "approval_request",
    "member_preference",
    "member_and_family_policy",
]
AICacheScope = Literal[
    "food",
    "meal_log",
    "meal_plan",
    "shopping_list",
    "inventory",
    "ai_conversation",
]
RevertAvailability = Literal["available", "expired", "unsupported", "blocked", "reverted"]


@dataclass(frozen=True, slots=True)
class TrustedResolutionSource:
    kind: Literal["current_ui_context", "tool_result", "conversation_artifact"]
    reference_id: str
    family_id: str
    entity_versions: dict[str, int | str | None]
    entity_values: dict[str, dict[str, Any]] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class IntentEvidenceValidation:
    clarity: IntentClarity
    normalized_evidence: dict[str, Any]
    verified_fields: frozenset[str]
    verified_values: dict[str, Any]
    reason_codes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CriticalEvidenceRequirement:
    field: str
    expected_value: Any
    matcher_key: Literal[
        "explicit_action",
        "entity_id",
        "boolean_direction",
        "rating",
        "quantity",
        "unit",
        "date",
        "meal_type",
        "servings",
        "text",
    ]


@dataclass(frozen=True, slots=True)
class AuthorizationSnapshot:
    source: AuthorizationSource
    member_preference_version: int
    member_notice_version: str
    family_policy_version: int | None
    family_notice_version: str | None
    catalog_version: str
    policy_version: str


@dataclass(frozen=True, slots=True)
class AutoExecutionDecision:
    route: PolicyRoute
    policy_key: str | None
    policy_version: str | None
    reason_codes: tuple[str, ...]
    authorization_source: AuthorizationSource | None = None
    authorization_snapshot: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class EffectiveAuthorization:
    enabled: bool
    source: AuthorizationSource | None
    snapshot: dict[str, Any]
    reason_codes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ActionPolicyEvaluation:
    allowed: bool
    all_targets_satisfied: bool
    reason_codes: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AutoExecutionPolicyContext:
    db: Session
    family_id: str
    actor_user_id: str
    draft_type: str
    payload: dict[str, Any]
    evidence: IntentEvidenceValidation
    authorization: EffectiveAuthorization
    auto_execution_attempted: bool
    has_continuation: bool
    is_composite: bool
    has_external_side_effect: bool
    registered_revert_adapters: frozenset[str]


class AutoExecutionActionPolicy(Protocol):
    key: str
    version: str
    draft_types: frozenset[str]
    revert_adapter_key: str

    def matches(self, *, draft_type: str, payload: dict[str, Any]) -> bool: ...

    def evidence_requirements(
        self,
        *,
        db: Session,
        family_id: str,
        actor_user_id: str,
        payload: dict[str, Any],
    ) -> tuple[CriticalEvidenceRequirement, ...]: ...

    def evaluate(self, context: AutoExecutionPolicyContext) -> ActionPolicyEvaluation: ...

    def lock_no_change_targets(self, context: AutoExecutionPolicyContext) -> bool:
        """Lock every domain row needed to prove an action-owned no-change result."""
        ...


@dataclass(frozen=True, slots=True)
class DraftExecutionReceipt:
    business_entity: dict[str, Any]
    entity_ids: tuple[str, ...]
    cache_scopes: tuple[AICacheScope, ...]
    revert_adapter_key: str | None = None
    revert_context: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class DraftCommitRequest:
    family_id: str
    actor_user_id: str
    conversation_id: str
    run_id: str | None
    draft_id: str
    draft_version: int
    committed_payload: dict[str, Any]
    execution_mode: Literal["manual_approval", "policy_auto"]
    authorization_source: AuthorizationSource
    authorization_snapshot: dict[str, Any]
    approval_request_id: str | None
    policy_key: str | None
    policy_version: str | None
    policy_reason_codes: tuple[str, ...]
    committed_at: datetime


@dataclass(frozen=True, slots=True)
class AIOperationResultProjection:
    draft_id: str
    operation_id: str | None
    result_status: Literal["completed", "no_change", "failed", "reverted"]
    execution_mode: ExecutionMode
    operation_status: Literal["pending", "completed", "failed", "reverted"] | None
    execution_explanation: str
    revert_availability: RevertAvailability
    revertible_until: datetime | None
    revert_blocked_code: str | None
    server_now: datetime
    entities: tuple[dict[str, Any], ...]
    cache_scopes: tuple[AICacheScope, ...]


@dataclass(frozen=True, slots=True)
class DraftCommitResult:
    operation_id: str
    receipt: DraftExecutionReceipt
    projection: AIOperationResultProjection
    result_part: dict[str, Any]
    artifacts: tuple[dict[str, Any], ...]


@dataclass(frozen=True, slots=True)
class DraftRouteOutcome:
    status: DraftRouteStatus
    draft_id: str
    approval_id: str | None
    operation_id: str | None
    published_part_ids: tuple[str, ...]
    projection: AIOperationResultProjection | None
