from __future__ import annotations

from app.ai.skills.base import BaseSkill, SkillManifest
from app.ai.skills.loader import load_skill_catalog


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, BaseSkill] = {}

    def register(self, skill: BaseSkill) -> None:
        self._skills[skill.manifest.key] = skill

    def get(self, key: str) -> BaseSkill:
        return self._skills[key]

    def keys(self) -> set[str]:
        return set(self._skills)

    def list(self) -> list[BaseSkill]:
        return list(self._skills.values())

    def list_manifests(self) -> list[SkillManifest]:
        return [skill.manifest for skill in self._skills.values()]

def build_workspace_skill_registry() -> SkillRegistry:
    registry = SkillRegistry()
    for skill in load_skill_catalog():
        registry.register(skill)
    return registry
