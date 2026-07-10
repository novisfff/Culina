from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class SkillRoutingPolicy:
    modes: tuple[str, ...] = ()
    include_examples: tuple[str, ...] = ()
    exclude_examples: tuple[str, ...] = ()
    conflict_rules: tuple[dict[str, str], ...] = ()

    def to_record(self) -> dict[str, Any]:
        return {
            "modes": list(self.modes),
            "includeExamples": list(self.include_examples),
            "excludeExamples": list(self.exclude_examples),
            "conflictRules": [dict(item) for item in self.conflict_rules],
        }


@dataclass(frozen=True, slots=True)
class SkillHandoffPolicy:
    reason_code: str
    target_skill: str
    required_draft_type: str
    resume_skill: str
    state_schema: str

    def to_record(self) -> dict[str, str]:
        return {
            "reasonCode": self.reason_code,
            "targetSkill": self.target_skill,
            "requiredDraftType": self.required_draft_type,
            "resumeSkill": self.resume_skill,
            "stateSchema": self.state_schema,
        }


@dataclass(frozen=True, slots=True)
class SkillAttachmentPolicy:
    accepted_kinds: tuple[str, ...] = ()
    usages: tuple[str, ...] = ()
    bindable_fields: tuple[str, ...] = ()
    current_message_only: bool = True
    explicit_user_intent_required: bool = True

    def to_record(self) -> dict[str, Any]:
        return {
            "acceptedKinds": list(self.accepted_kinds),
            "usages": list(self.usages),
            "bindableFields": list(self.bindable_fields),
            "currentMessageOnly": self.current_message_only,
            "explicitUserIntentRequired": self.explicit_user_intent_required,
        }
