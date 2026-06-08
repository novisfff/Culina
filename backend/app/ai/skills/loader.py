from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from app.ai.skills.base import BaseSkill, SkillManifest
from app.ai.skills.markdown import MarkdownInstructionSkill


class SkillDirectoryLoader:
    def __init__(self, catalog_dir: Path | None = None) -> None:
        self.catalog_dir = catalog_dir or Path(__file__).resolve().parent / "catalog"

    def load(self) -> list[BaseSkill]:
        manifest_paths = sorted(self.catalog_dir.glob("*/manifest.json"), key=lambda path: path.parent.name)
        return [self._load_skill(path.parent.name) for path in manifest_paths]

    def _load_skill(self, key: str) -> BaseSkill:
        skill_dir = self.catalog_dir / key
        manifest_path = skill_dir / "manifest.json"
        markdown_path = skill_dir / "SKILL.md"
        code_path = skill_dir / "skill.py"
        for path in [manifest_path, markdown_path]:
            if not path.exists():
                raise FileNotFoundError(f"Skill {key} missing required file: {path.name}")

        manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest = SkillManifest(**manifest_data)
        if manifest.key != key:
            raise ValueError(f"Skill directory {key} does not match manifest key {manifest.key}")
        self._validate_skill_markdown(markdown_path, manifest)

        if not code_path.exists():
            return MarkdownInstructionSkill(manifest, skill_dir)

        module_name = f"app.ai.skills.catalog.{key}.skill"
        spec = importlib.util.spec_from_file_location(module_name, code_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot load skill module for {key}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        factory = getattr(module, "create_skill", None)
        if not callable(factory):
            raise AttributeError(f"Skill {key} must expose create_skill(manifest, skill_dir)")
        skill = factory(manifest, skill_dir)
        if not isinstance(skill, BaseSkill):
            raise TypeError(f"Skill {key} factory returned {type(skill).__name__}, expected BaseSkill")
        if skill.manifest.key != key:
            raise ValueError(f"Skill {key} factory returned mismatched manifest {skill.manifest.key}")
        return skill

    def _validate_skill_markdown(self, path: Path, manifest: SkillManifest) -> None:
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            raise ValueError(f"{path} must start with YAML frontmatter")
        try:
            frontmatter = text.split("---\n", 2)[1]
        except IndexError as exc:
            raise ValueError(f"{path} has invalid YAML frontmatter") from exc
        values: dict[str, str] = {}
        for line in frontmatter.splitlines():
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            values[name.strip()] = value.strip().strip('"')
        if not values.get("name") or not values.get("description"):
            raise ValueError(f"{path} frontmatter must include name and description")
        if values["name"].replace("-", "_") != manifest.key:
            raise ValueError(f"{path} frontmatter name must map to manifest key {manifest.key}")


def load_skill_catalog(catalog_dir: Path | None = None) -> list[BaseSkill]:
    return SkillDirectoryLoader(catalog_dir).load()
