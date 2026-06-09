from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from app.ai.skills.base import BaseSkill, SkillManifest
from app.ai.skills.runtime import create_skill_from_manifest
from app.ai.tools.registry import ToolRegistry


class SkillDirectoryLoader:
    def __init__(self, skills_dir: Path | None = None, *, tool_registry: ToolRegistry | None = None) -> None:
        self.skills_dir = skills_dir or Path(__file__).resolve().parent
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
        frontmatter, _body = self._read_frontmatter(markdown_path)
        manifest = self._manifest_from_frontmatter(skill_dir, frontmatter)
        self._validate_referenced_files(skill_dir, manifest)
        return create_skill_from_manifest(manifest, skill_dir)

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

    def _manifest_from_frontmatter(self, skill_dir: Path, data: dict[str, Any]) -> SkillManifest:
        slug = self._required_text(data, "name")
        key = self._text(data.get("key")) or slug.replace("-", "_")
        if skill_dir.name not in {slug, key}:
            raise ValueError(f"Skill directory {skill_dir.name} does not match SKILL.md name {slug}")
        display_name = self._text(data.get("display_name")) or self._text(data.get("displayName")) or key
        description = self._required_text(data, "description")
        approval_policy = self._text(data.get("approval_policy")) or ("draft_then_confirm" if self._list(data.get("draft_types")) else "none")
        manifest = SkillManifest(
            key=key,
            slug=slug,
            name=display_name,
            version=self._text(data.get("version")) or "1.0.0",
            description=description,
            category=self._text(data.get("category")) or "general",
            runner=self._text(data.get("runner")) or "toolcall",
            risk_level=self._text(data.get("risk_level")) or "low",
            examples=self._list(data.get("examples")),
            context_policy=self._list(data.get("context_policy")),
            tools=self._list(data.get("allowed_tools") or data.get("tools")),
            forbidden_tools=self._list(data.get("forbidden_tools")),
            requires_confirmation=self._list(data.get("requires_confirmation")),
            workflow_files=self._list(data.get("workflow_files")),
            hitl_files=self._list(data.get("hitl_files")),
            example_files=self._list(data.get("example_files")),
            script_files=self._list(data.get("script_files")),
            output_types=self._list(data.get("output_types")),
            draft_types=self._list(data.get("draft_types")),
            approval_policy=approval_policy,
            can_continue_from=self._list(data.get("can_continue_from")),
            intent=self._text(data.get("intent")) or key,
            agent_key=self._text(data.get("agent_key")) or f"{key}_agent",
        )
        self._validate_manifest(manifest)
        self._validate_manifest_tools(manifest)
        return manifest

    def _validate_manifest(self, manifest: SkillManifest) -> None:
        if manifest.risk_level not in {"low", "medium", "high"}:
            raise ValueError(f"Skill {manifest.key} has invalid risk_level: {manifest.risk_level}")
        if manifest.approval_policy not in {"none", "draft_then_confirm"}:
            raise ValueError(f"Skill {manifest.key} has invalid approval_policy: {manifest.approval_policy}")
        forbidden_overlap = set(manifest.tools) & set(manifest.forbidden_tools)
        if forbidden_overlap:
            raise ValueError(f"Skill {manifest.key} allows forbidden tools: {', '.join(sorted(forbidden_overlap))}")
        if manifest.approval_policy == "none" and (manifest.draft_types or manifest.requires_confirmation):
            raise ValueError(f"Skill {manifest.key} declares draft or confirmation fields without approval")
        if manifest.approval_policy == "draft_then_confirm":
            if manifest.risk_level == "low":
                raise ValueError(f"Skill {manifest.key} uses draft approval but risk_level is low")
            if not manifest.draft_types:
                raise ValueError(f"Skill {manifest.key} requires approval but declares no draft types")
            if not manifest.requires_confirmation:
                raise ValueError(f"Skill {manifest.key} requires approval but declares no confirmation actions")

    def _validate_referenced_files(self, skill_dir: Path, manifest: SkillManifest) -> None:
        for relative_path in [
            *manifest.workflow_files,
            *manifest.hitl_files,
            *manifest.example_files,
            *manifest.script_files,
        ]:
            if not (skill_dir / relative_path).exists():
                raise FileNotFoundError(f"Skill {manifest.key} references missing file: {relative_path}")

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
