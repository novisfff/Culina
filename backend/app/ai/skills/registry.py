from __future__ import annotations

from app.ai.skills.base import BaseSkill, SkillManifest
from app.ai.skills.loader import load_skill_catalog
from app.ai.skills.state_schemas import CONTINUATION_STATE_SCHEMAS
from app.ai.tools.registry import build_workspace_tool_registry


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

def build_workspace_skill_registry() -> SkillRegistry:
    registry = SkillRegistry()
    tool_registry = build_workspace_tool_registry()
    for skill in load_skill_catalog(tool_registry=tool_registry):
        registry.register(skill)
    registry.validate_contracts(tool_registry)
    return registry
