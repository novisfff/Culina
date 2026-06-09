from __future__ import annotations

from pathlib import Path

from app.ai.skills.base import BaseSkill, SkillManifest
from app.ai.skills.runner_registry import get_skill_runner


def create_skill_from_manifest(manifest: SkillManifest, skill_dir: Path) -> BaseSkill:
    return get_skill_runner(manifest.runner)(manifest, skill_dir)
