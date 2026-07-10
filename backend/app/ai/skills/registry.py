from __future__ import annotations

from app.ai.skills.base import BaseSkill, SkillManifest
from app.ai.skills.loader import load_skill_catalog
from app.ai.skills.state_schemas import CONTINUATION_STATE_SCHEMAS
from app.ai.tools.registry import build_workspace_tool_registry


_ATTACHMENT_BINDING_FIELDS = {
    "food_profile": ("media_ids",),
    "ingredient_profile": ("media_ids",),
    "recipe_draft": ("media_ids",),
    "meal_log": ("mediaIds",),
}
_ATTACHMENT_USAGES = {"draft_media_binding", "image_generation_reference"}


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, BaseSkill] = {}

    def register(self, skill: BaseSkill) -> None:
        if skill.manifest.key in self._skills:
            raise ValueError(f"Duplicate skill key registered: {skill.manifest.key}")
        self._skills[skill.manifest.key] = skill

    def get(self, key: str) -> BaseSkill:
        return self._skills[key]

    def keys(self) -> set[str]:
        return set(self._skills)

    def list(self) -> list[BaseSkill]:
        return list(self._skills.values())

    def list_manifests(self) -> list[SkillManifest]:
        return [skill.manifest for skill in self._skills.values()]

    def validate_contracts(self, tool_registry) -> None:
        del tool_registry
        for skill in self.list():
            manifest = skill.manifest
            if manifest.contract_version == 3:
                self._validate_attachment_policy(manifest)
            for reason, handoff in manifest.handoffs.items():
                if handoff.target_skill not in self._skills:
                    raise ValueError(
                        f"Skill {manifest.key} handoff {reason} references unknown target Skill "
                        f"{handoff.target_skill}"
                    )
                if handoff.resume_skill not in self._skills:
                    raise ValueError(
                        f"Skill {manifest.key} handoff {reason} references unknown resume Skill "
                        f"{handoff.resume_skill}"
                    )
                target = self.get(handoff.target_skill).manifest
                if handoff.required_draft_type not in target.draft_types:
                    raise ValueError(
                        f"Skill {manifest.key} handoff {reason} requires undeclared target draft type "
                        f"{handoff.required_draft_type}"
                    )
                if handoff.state_schema not in CONTINUATION_STATE_SCHEMAS:
                    raise ValueError(
                        f"Skill {manifest.key} handoff {reason} references unknown state schema "
                        f"{handoff.state_schema}"
                    )

    @staticmethod
    def _validate_attachment_policy(manifest: SkillManifest) -> None:
        policy = manifest.attachment_policy
        if not policy.current_message_only or not policy.explicit_user_intent_required:
            raise ValueError(
                f"Skill {manifest.key} attachment policy must be current-message-only and explicit user intent"
            )

        allowed_fields = _ATTACHMENT_BINDING_FIELDS.get(manifest.key)
        declared_groups = (
            bool(policy.accepted_kinds),
            bool(policy.usages),
            bool(policy.bindable_fields),
        )
        if any(declared_groups) and not all(declared_groups):
            raise ValueError(
                f"Skill {manifest.key} attachment kinds, usages, and binding fields must be all empty or all non-empty"
            )
        if not any(declared_groups):
            return
        if allowed_fields is None:
            raise ValueError(
                f"Skill {manifest.key} cannot declare attachment kinds, usages, or binding fields"
            )

        if policy.bindable_fields != allowed_fields:
            raise ValueError(
                f"Skill {manifest.key} cannot bind attachment fields: {', '.join(policy.bindable_fields)}"
            )
        if policy.accepted_kinds != ("image",):
            raise ValueError(f"Skill {manifest.key} may accept only image attachments for binding")
        unknown_usages = sorted(set(policy.usages) - _ATTACHMENT_USAGES)
        if unknown_usages:
            raise ValueError(
                f"Skill {manifest.key} has unsupported attachment usages: {', '.join(unknown_usages)}"
            )


def build_workspace_skill_registry() -> SkillRegistry:
    registry = SkillRegistry()
    tool_registry = build_workspace_tool_registry()
    for skill in load_skill_catalog(tool_registry=tool_registry):
        registry.register(skill)
    registry.validate_contracts(tool_registry)
    return registry
