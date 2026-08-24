from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


IntentClarity = Literal[
    "explicit_complete",
    "explicit_context_resolved",
    "explicit_incomplete",
    "inferred",
]


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
