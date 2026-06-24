from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from app.ai.skills.base import BaseSkill, CatalogSkill, SkillManifest
from app.ai.tools.registry import ToolRegistry


SKILL_RUNTIME_FRONTMATTER_KEYS = {
    "agent_key",
    "allowed_tools",
    "approval_policy",
    "context_policy",
    "contextPolicy",
    "display_name",
    "displayName",
    "draft_types",
    "examples",
    "instruction_files",
    "intent",
    "key",
    "output_types",
    "runner",
    "script_files",
    "tools",
}


class SkillDirectoryLoader:
    def __init__(self, skills_dir: Path | None = None, *, tool_registry: ToolRegistry | None = None) -> None:
        self.skills_dir = skills_dir or Path(__file__).resolve().parent / "catalog"
        self.tool_registry = tool_registry

    def load(self) -> list[BaseSkill]:
        skill_paths = []
        for path in sorted((item for item in self.skills_dir.iterdir() if item.is_dir()), key=lambda item: item.name):
            if path.name.startswith("__"):
                continue
            if not (path / "SKILL.md").exists():
                raise FileNotFoundError(f"Skill directory {path.name} missing required file: SKILL.md")
            skill_paths.append(path)
        return [self._load_skill(path) for path in skill_paths]

    def _load_skill(self, skill_dir: Path) -> BaseSkill:
        markdown_path = skill_dir / "SKILL.md"
        frontmatter, body = self._read_frontmatter(markdown_path)
        runtime_path = skill_dir / "skill.yaml"
        if not runtime_path.exists():
            raise FileNotFoundError(f"Skill directory {skill_dir.name} missing required file: skill.yaml")
        runtime = self._read_yaml_file(runtime_path)
        manifest = self._manifest_from_metadata(skill_dir, frontmatter, runtime)
        return CatalogSkill(
            manifest,
            skill_dir,
            instructions=self._join_instructions(body, self._instruction_sections(skill_dir, runtime)),
        )

    def _read_frontmatter(self, path: Path) -> tuple[dict[str, Any], str]:
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---\n"):
            raise ValueError(f"{path} must start with YAML frontmatter")
        try:
            _empty, yaml_text, body = text.split("---\n", 2)
        except ValueError as exc:
            raise ValueError(f"{path} has invalid YAML frontmatter") from exc
        data = yaml.safe_load(yaml_text) or {}
        if not isinstance(data, dict):
            raise ValueError(f"{path} frontmatter must be a YAML mapping")
        return data, body

    def _read_yaml_file(self, path: Path) -> dict[str, Any]:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            raise ValueError(f"{path} must be a YAML mapping")
        return data

    def _manifest_from_metadata(
        self,
        skill_dir: Path,
        frontmatter: dict[str, Any],
        runtime: dict[str, Any],
    ) -> SkillManifest:
        self._validate_v2_runtime(skill_dir, frontmatter, runtime)
        slug = self._required_text(frontmatter, "name")
        description = self._required_text(frontmatter, "description")
        key = self._text(runtime.get("key")) or slug.replace("-", "_")
        if skill_dir.name not in {slug, key}:
            raise ValueError(f"Skill directory {skill_dir.name} does not match SKILL.md name {slug}")
        approval_policy = self._text(runtime.get("approval_policy")) or (
            "draft_then_confirm" if self._list(runtime.get("draft_types")) else "none"
        )
        manifest = SkillManifest(
            key=key,
            slug=slug,
            name=self._text(runtime.get("display_name")) or self._text(runtime.get("displayName")) or key,
            description=description,
            examples=self._list(runtime.get("examples")),
            context_policy=self._list(runtime.get("context_policy") or runtime.get("contextPolicy")),
            tools=self._list(runtime.get("allowed_tools") or runtime.get("tools")),
            script_files=self._list(runtime.get("script_files")),
            output_types=self._list(runtime.get("output_types")),
            draft_types=self._list(runtime.get("draft_types")),
            approval_policy=approval_policy,
            intent=self._text(runtime.get("intent")) or key,
            agent_key=self._text(runtime.get("agent_key")) or f"{key}_agent",
        )
        self._validate_manifest(manifest)
        self._validate_manifest_tools(manifest)
        return manifest

    def _validate_v2_runtime(self, skill_dir: Path, frontmatter: dict[str, Any], runtime: dict[str, Any]) -> None:
        version = runtime.get("version")
        if version not in {2, "2"}:
            raise ValueError(f"Skill {skill_dir.name} skill.yaml must declare version: 2")
        runtime_keys = sorted(set(frontmatter).intersection(SKILL_RUNTIME_FRONTMATTER_KEYS))
        if runtime_keys:
            raise ValueError(
                f"Skill {skill_dir.name} SKILL.md must not include Culina runtime fields when skill.yaml is present: "
                f"{', '.join(runtime_keys)}"
            )

    def _validate_manifest(self, manifest: SkillManifest) -> None:
        if manifest.approval_policy not in {"none", "draft_then_confirm"}:
            raise ValueError(f"Skill {manifest.key} has invalid approval_policy: {manifest.approval_policy}")
        if manifest.approval_policy == "none" and manifest.draft_types:
            raise ValueError(f"Skill {manifest.key} declares draft types without approval")
        if manifest.approval_policy == "draft_then_confirm":
            if not manifest.draft_types:
                raise ValueError(f"Skill {manifest.key} requires approval but declares no draft types")

    def _validate_manifest_tools(self, manifest: SkillManifest) -> None:
        if self.tool_registry is None:
            return
        definitions = []
        for tool_name in manifest.tools:
            try:
                definitions.append(self.tool_registry.get(tool_name))
            except KeyError as exc:
                raise ValueError(f"Skill {manifest.key} declares unknown allowed tool: {tool_name}") from exc
        if any(definition.side_effect == "write" for definition in definitions):
            raise ValueError(f"Skill {manifest.key} must not expose write tools")
        if manifest.approval_policy == "none":
            non_read = [definition.name for definition in definitions if definition.side_effect != "read"]
            if non_read:
                raise ValueError(f"Skill {manifest.key} exposes non-read tools without approval: {', '.join(non_read)}")
            return
        draft_tools = [definition for definition in definitions if definition.side_effect == "draft"]
        if not draft_tools:
            raise ValueError(f"Skill {manifest.key} requires approval but exposes no draft tools")
        unconfirmed = [definition.name for definition in draft_tools if not definition.requires_confirmation]
        if unconfirmed:
            raise ValueError(f"Skill {manifest.key} exposes draft tools that do not require confirmation: {', '.join(unconfirmed)}")

    def _instruction_sections(self, skill_dir: Path, runtime: dict[str, Any]) -> list[str]:
        declared_files = self._list(runtime.get("instruction_files"))
        paths = [skill_dir / item for item in declared_files]
        if not paths:
            paths = [skill_dir / "references" / "workflows.md"]
        sections: list[str] = []
        skill_root = skill_dir.resolve()
        for path in paths:
            if not path.exists():
                if declared_files:
                    raise ValueError(f"Skill {skill_dir.name} instruction file does not exist: {path}")
                continue
            resolved = path.resolve()
            if not resolved.is_relative_to(skill_root):
                raise ValueError(f"Skill {skill_dir.name} instruction file must stay inside the skill directory")
            sections.append(f"# {resolved.relative_to(skill_root)}\n\n{resolved.read_text(encoding='utf-8').strip()}")
        return sections

    def _join_instructions(self, body: str, references: list[str]) -> str:
        chunks = [body.strip()]
        chunks.extend(references)
        return "\n\n---\n\n".join(chunk for chunk in chunks if chunk)

    def _required_text(self, data: dict[str, Any], key: str) -> str:
        value = self._text(data.get(key))
        if not value:
            raise ValueError(f"SKILL.md frontmatter must include {key}")
        return value

    def _text(self, value: Any) -> str:
        return str(value).strip() if value is not None else ""

    def _list(self, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        return [str(value).strip()] if str(value).strip() else []


def load_skill_catalog(skills_dir: Path | None = None, *, tool_registry: ToolRegistry | None = None) -> list[BaseSkill]:
    return SkillDirectoryLoader(skills_dir, tool_registry=tool_registry).load()
