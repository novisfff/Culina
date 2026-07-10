from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from app.ai.skills.base import BaseSkill, CatalogSkill, SkillCompletionPolicy, SkillManifest
from app.ai.skills.contracts import SkillAttachmentPolicy, SkillHandoffPolicy, SkillRoutingPolicy
from app.ai.tools.registry import ToolRegistry


SKILL_RUNTIME_FRONTMATTER_KEYS = {
    "agent_key",
    "allowed_tools",
    "approval_policy",
    "completion_policy",
    "completionPolicy",
    "context_policy",
    "contextPolicy",
    "display_name",
    "displayName",
    "draft_contract",
    "draftContract",
    "draft_types",
    "examples",
    "instruction_files",
    "intent",
    "key",
    "output_types",
    "route_hints",
    "routeHints",
    "runner",
    "script_files",
    "tool_budget",
    "toolBudget",
    "tools",
    "routing",
    "handoffs",
    "attachment_policy",
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
        skill = CatalogSkill(
            manifest,
            skill_dir,
            instructions=self._join_instructions(body, self._instruction_sections(skill_dir, runtime)),
        )
        self._validate_completion_policy_references(skill)
        self._validate_completion_policy_coverage(skill)
        return skill

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
        version = self._validate_runtime_version(skill_dir, frontmatter, runtime)
        slug = self._required_text(frontmatter, "name")
        description = self._required_text(frontmatter, "description")
        key = self._text(runtime.get("key")) or slug.replace("-", "_")
        if skill_dir.name not in {slug, key}:
            raise ValueError(f"Skill directory {skill_dir.name} does not match SKILL.md name {slug}")
        approval_policy = self._text(runtime.get("approval_policy")) or (
            "draft_then_confirm" if self._runtime_list(runtime, "draft_types") else "none"
        )
        manifest = SkillManifest(
            key=key,
            slug=slug,
            name=self._text(runtime.get("display_name")) or self._text(runtime.get("displayName")) or key,
            description=description,
            examples=self._runtime_list(runtime, "examples"),
            context_policy=self._runtime_list(runtime, "context_policy", "contextPolicy"),
            tools=self._runtime_list(runtime, "allowed_tools", "tools"),
            script_files=self._runtime_list(runtime, "script_files"),
            output_types=self._runtime_list(runtime, "output_types"),
            draft_types=self._runtime_list(runtime, "draft_types"),
            route_hints=self._runtime_list(runtime, "route_hints", "routeHints"),
            tool_budget=self._tool_budget(self._first_present(runtime, "tool_budget", "toolBudget")),
            completion_policy=self._completion_policy(
                self._first_present(runtime, "completion_policy", "completionPolicy")
            ),
            draft_contract=self._draft_contract(self._first_present(runtime, "draft_contract", "draftContract")),
            approval_policy=approval_policy,
            intent=self._text(runtime.get("intent")) or key,
            agent_key=self._text(runtime.get("agent_key")) or f"{key}_agent",
            contract_version=version,
            routing=self._routing_policy(
                runtime.get("routing"),
                version=version,
                examples=self._runtime_list(runtime, "examples"),
            ),
            handoffs=self._handoff_policies(runtime.get("handoffs"), version=version),
            attachment_policy=self._attachment_policy(runtime.get("attachment_policy"), version=version),
        )
        self._validate_manifest(manifest)
        self._validate_manifest_tools(manifest)
        return manifest

    def _validate_runtime_version(
        self,
        skill_dir: Path,
        frontmatter: dict[str, Any],
        runtime: dict[str, Any],
    ) -> int:
        version = runtime.get("version")
        if version not in {2, 3, "2", "3"}:
            raise ValueError(f"Skill {skill_dir.name} skill.yaml must declare version: 2 or 3")
        runtime_keys = sorted(set(frontmatter).intersection(SKILL_RUNTIME_FRONTMATTER_KEYS))
        if runtime_keys:
            raise ValueError(
                f"Skill {skill_dir.name} SKILL.md must not include Culina runtime fields when skill.yaml is present: "
                f"{', '.join(runtime_keys)}"
            )
        return int(version)

    def _routing_policy(
        self,
        value: Any,
        *,
        version: int,
        examples: list[str],
    ) -> SkillRoutingPolicy:
        if version == 2:
            return SkillRoutingPolicy(modes=("default",), include_examples=tuple(examples))
        if not isinstance(value, dict):
            raise ValueError("skill.yaml routing must be a mapping for version 3")
        modes = tuple(self._list(value.get("modes"), field_name="skill.yaml routing.modes"))
        includes = tuple(
            self._list(value.get("include_examples"), field_name="skill.yaml routing.include_examples")
        )
        excludes = tuple(
            self._list(value.get("exclude_examples"), field_name="skill.yaml routing.exclude_examples")
        )
        if not modes:
            raise ValueError("skill.yaml routing.modes must not be empty")
        overlap = sorted(set(includes).intersection(excludes))
        if overlap:
            raise ValueError(f"routing include/exclude examples overlap: {', '.join(overlap)}")
        raw_conflicts = value.get("conflict_rules") or []
        if not isinstance(raw_conflicts, list) or not all(isinstance(item, dict) for item in raw_conflicts):
            raise ValueError("skill.yaml routing.conflict_rules must be a list of mappings")
        return SkillRoutingPolicy(
            modes=modes,
            include_examples=includes,
            exclude_examples=excludes,
            conflict_rules=tuple(
                {str(key): str(item[key]) for key in item}
                for item in raw_conflicts
            ),
        )

    def _handoff_policies(self, value: Any, *, version: int) -> dict[str, SkillHandoffPolicy]:
        if version == 2:
            return {}
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("skill.yaml handoffs must be a mapping")
        policies: dict[str, SkillHandoffPolicy] = {}
        for raw_reason, raw_policy in value.items():
            reason = self._text(raw_reason)
            if not reason:
                raise ValueError("skill.yaml handoffs contains an empty reason code")
            if not isinstance(raw_policy, dict):
                raise ValueError(f"skill.yaml handoffs.{reason} must be a mapping")
            values = {
                field: self._text(raw_policy.get(field))
                for field in (
                    "target_skill",
                    "required_draft_type",
                    "resume_skill",
                    "state_schema",
                )
            }
            missing = [field for field, text in values.items() if not text]
            if missing:
                raise ValueError(
                    f"skill.yaml handoffs.{reason} missing required fields: {', '.join(missing)}"
                )
            policies[reason] = SkillHandoffPolicy(
                reason_code=reason,
                target_skill=values["target_skill"],
                required_draft_type=values["required_draft_type"],
                resume_skill=values["resume_skill"],
                state_schema=values["state_schema"],
            )
        return policies

    def _attachment_policy(self, value: Any, *, version: int) -> SkillAttachmentPolicy:
        if version == 2:
            return SkillAttachmentPolicy()
        if not isinstance(value, dict):
            raise ValueError("skill.yaml attachment_policy must be a mapping for version 3")
        return SkillAttachmentPolicy(
            accepted_kinds=tuple(
                self._list(value.get("accepted_kinds"), field_name="skill.yaml attachment_policy.accepted_kinds")
            ),
            usages=tuple(
                self._list(value.get("usages"), field_name="skill.yaml attachment_policy.usages")
            ),
            bindable_fields=tuple(
                self._list(value.get("bindable_fields"), field_name="skill.yaml attachment_policy.bindable_fields")
            ),
            current_message_only=self._required_bool(
                value.get("current_message_only"),
                fallback=True,
                field_name="attachment_policy.current_message_only",
            ),
            explicit_user_intent_required=self._required_bool(
                value.get("explicit_user_intent_required"),
                fallback=True,
                field_name="attachment_policy.explicit_user_intent_required",
            ),
        )

    def _validate_manifest(self, manifest: SkillManifest) -> None:
        if manifest.approval_policy not in {"none", "draft_then_confirm"}:
            raise ValueError(f"Skill {manifest.key} has invalid approval_policy: {manifest.approval_policy}")
        if manifest.approval_policy == "none" and manifest.draft_types:
            raise ValueError(f"Skill {manifest.key} declares draft types without approval")
        if manifest.approval_policy == "none" and manifest.draft_contract:
            raise ValueError(f"Skill {manifest.key} declares draft_contract without approval")
        if manifest.approval_policy == "draft_then_confirm":
            if not manifest.draft_types:
                raise ValueError(f"Skill {manifest.key} requires approval but declares no draft types")
        unknown_contract_types = sorted(set(manifest.draft_contract) - set(manifest.draft_types))
        if unknown_contract_types:
            raise ValueError(
                f"Skill {manifest.key} draft_contract references undeclared draft types: "
                f"{', '.join(unknown_contract_types)}"
            )
        if manifest.approval_policy == "draft_then_confirm":
            missing_contract_types = sorted(set(manifest.draft_types) - set(manifest.draft_contract))
            if missing_contract_types:
                raise ValueError(
                    f"Skill {manifest.key} draft_contract must cover declared draft types: "
                    f"{', '.join(missing_contract_types)}"
                )
        incomplete_contract_types = sorted(
            draft_type
            for draft_type, contract in manifest.draft_contract.items()
            if not {"schemaVersion", "approvalConfigKey", "commitHandlerKey"}.issubset(contract)
        )
        if incomplete_contract_types:
            raise ValueError(
                f"Skill {manifest.key} draft_contract entries must include schemaVersion, "
                f"approvalConfigKey, and commitHandlerKey: {', '.join(incomplete_contract_types)}"
            )

    def _validate_manifest_tools(self, manifest: SkillManifest) -> None:
        if self.tool_registry is None:
            return
        definitions = []
        for tool_name in manifest.tools:
            try:
                definitions.append(self.tool_registry.get(tool_name))
            except KeyError as exc:
                raise ValueError(f"Skill {manifest.key} declares unknown allowed tool: {tool_name}") from exc
        undeclared_output_types = sorted(
            {
                output_type
                for definition in definitions
                for output_type in definition.output_types
                if definition.name not in manifest.completion_policy.followup_required_tools
                if output_type not in manifest.output_types
            }
        )
        if undeclared_output_types:
            raise ValueError(
                f"Skill {manifest.key} allowed tools produce undeclared output types: "
                f"{', '.join(undeclared_output_types)}"
            )
        if any(definition.side_effect == "write" for definition in definitions):
            raise ValueError(f"Skill {manifest.key} must not expose write tools")
        if manifest.approval_policy == "none":
            unsupported = [definition.name for definition in definitions if definition.side_effect not in {"read", "control"}]
            if unsupported:
                raise ValueError(f"Skill {manifest.key} exposes non-read/control tools without approval: {', '.join(unsupported)}")
            return
        undeclared_draft_types = sorted(
            {
                draft_type
                for definition in definitions
                for draft_type in definition.draft_types
                if draft_type not in manifest.draft_types
            }
        )
        if undeclared_draft_types:
            raise ValueError(
                f"Skill {manifest.key} allowed tools produce undeclared draft types: "
                f"{', '.join(undeclared_draft_types)}"
            )
        draft_tools = [definition for definition in definitions if definition.side_effect == "draft"]
        if not draft_tools:
            raise ValueError(f"Skill {manifest.key} requires approval but exposes no draft tools")
        unconfirmed = [definition.name for definition in draft_tools if not definition.requires_confirmation]
        if unconfirmed:
            raise ValueError(f"Skill {manifest.key} exposes draft tools that do not require confirmation: {', '.join(unconfirmed)}")

    def _validate_completion_policy_references(self, skill: CatalogSkill) -> None:
        manifest = skill.manifest
        policy_tool_names = set(manifest.completion_policy.terminal_tools) | set(
            manifest.completion_policy.followup_required_tools
        )
        if not policy_tool_names:
            return
        declared_tool_names = set(manifest.tools)
        script_catalog = getattr(skill, "script_catalog", None)
        if script_catalog is not None:
            declared_tool_names.update(function.tool_name for function in script_catalog.functions())
        unknown = sorted(policy_tool_names - declared_tool_names)
        if unknown:
            raise ValueError(
                f"Skill {manifest.key} completion_policy references undeclared tools: {', '.join(unknown)}"
            )

    def _validate_completion_policy_coverage(self, skill: CatalogSkill) -> None:
        if self.tool_registry is None:
            return
        manifest = skill.manifest
        declared_policy_tools = set(manifest.completion_policy.terminal_tools) | set(
            manifest.completion_policy.followup_required_tools
        )
        missing = []
        for tool_name in manifest.tools:
            definition = self.tool_registry.get(tool_name)
            if definition.side_effect == "draft" or tool_name == "human.request_input":
                continue
            if tool_name not in declared_policy_tools:
                missing.append(tool_name)
        script_catalog = getattr(skill, "script_catalog", None)
        if script_catalog is not None:
            for function in script_catalog.functions():
                if function.tool_name not in declared_policy_tools:
                    missing.append(function.tool_name)
        if missing:
            raise ValueError(
                f"Skill {manifest.key} completion_policy must cover non-draft tools: "
                f"{', '.join(sorted(missing))}"
            )

    def _instruction_sections(self, skill_dir: Path, runtime: dict[str, Any]) -> list[str]:
        declared_files = self._runtime_list(runtime, "instruction_files")
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

    def _runtime_list(self, data: dict[str, Any], *keys: str) -> list[str]:
        value = self._first_present(data, *keys)
        return self._list(value, field_name=f"skill.yaml {keys[0]}")

    def _list(self, value: Any, *, field_name: str = "value") -> list[str]:
        if value is None:
            return []
        if isinstance(value, list):
            items = [str(item).strip() for item in value if str(item).strip()]
            duplicates = sorted({item for item in items if items.count(item) > 1})
            if duplicates:
                raise ValueError(f"{field_name} contains duplicate values: {', '.join(duplicates)}")
            return items
        raise ValueError(f"{field_name} must be a list")

    def _tool_budget(self, value: Any) -> dict[str, int]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("skill.yaml tool_budget must be a mapping")
        budget: dict[str, int] = {}
        max_tool_calls = self._required_non_negative_int(
            value,
            "max_tool_calls",
            "maxToolCalls",
            field_name="tool_budget.max_tool_calls",
        )
        max_same_read_calls = self._required_non_negative_int(
            value,
            "max_same_read_calls",
            "maxSameReadCalls",
            field_name="tool_budget.max_same_read_calls",
        )
        if max_tool_calls is not None:
            budget["max_tool_calls"] = max_tool_calls
        if max_same_read_calls is not None:
            budget["max_same_read_calls"] = max_same_read_calls
        return budget

    def _completion_policy(self, value: Any) -> SkillCompletionPolicy:
        if value is None:
            return SkillCompletionPolicy()
        if not isinstance(value, dict):
            raise ValueError("skill.yaml completion_policy must be a mapping")
        return SkillCompletionPolicy(
            requires_terminal_output=self._required_bool(
                self._first_present(value, "requires_terminal_output", "requiresTerminalOutput"),
                fallback=False,
                field_name="completion_policy.requires_terminal_output",
            ),
            terminal_text_allowed=self._required_bool(
                self._first_present(value, "terminal_text_allowed", "terminalTextAllowed"),
                fallback=True,
                field_name="completion_policy.terminal_text_allowed",
            ),
            terminal_tools=self._tool_hint_map(
                self._first_present(value, "terminal_tools", "terminalTools"),
                field_name="completion_policy.terminal_tools",
            ),
            followup_required_tools=self._tool_hint_map(
                self._first_present(value, "followup_required_tools", "followupRequiredTools"),
                field_name="completion_policy.followup_required_tools",
            ),
        )

    def _draft_contract(self, value: Any) -> dict[str, dict[str, str]]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("skill.yaml draft_contract must be a mapping")
        contracts: dict[str, dict[str, str]] = {}
        for raw_draft_type, raw_contract in value.items():
            draft_type = str(raw_draft_type).strip()
            if not draft_type:
                raise ValueError("skill.yaml draft_contract contains an empty draft type")
            if not isinstance(raw_contract, dict):
                raise ValueError(f"skill.yaml draft_contract.{draft_type} must be a mapping")
            contract: dict[str, str] = {}
            for source_key, target_key in (
                ("schema_version", "schemaVersion"),
                ("schemaVersion", "schemaVersion"),
                ("approval_config_key", "approvalConfigKey"),
                ("approvalConfigKey", "approvalConfigKey"),
                ("commit_handler_key", "commitHandlerKey"),
                ("commitHandlerKey", "commitHandlerKey"),
            ):
                if source_key not in raw_contract:
                    continue
                text = self._text(raw_contract.get(source_key))
                if text:
                    contract[target_key] = text
            if contract:
                contracts[draft_type] = contract
        return contracts

    def _tool_hint_map(self, value: Any, *, field_name: str) -> dict[str, str]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError(f"skill.yaml {field_name} must be a mapping")
        hints: dict[str, str] = {}
        for raw_tool_name, raw_hint in value.items():
            tool_name = str(raw_tool_name).strip()
            if not tool_name:
                raise ValueError(f"skill.yaml {field_name} contains an empty tool name")
            if not isinstance(raw_hint, str):
                raise ValueError(f"skill.yaml {field_name}.{tool_name} must be a string")
            hint = self._text(raw_hint)
            if not hint:
                raise ValueError(f"skill.yaml {field_name}.{tool_name} must include a hint")
            hints[tool_name] = hint
        return hints

    def _non_negative_int(self, value: Any) -> int | None:
        if value is None or isinstance(value, bool):
            return None
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return None
        return parsed if parsed >= 0 else None

    def _required_non_negative_int(self, data: dict[str, Any], *keys: str, field_name: str) -> int | None:
        value = self._first_present(data, *keys)
        if value is None:
            return None
        if isinstance(value, bool):
            raise ValueError(f"skill.yaml {field_name} must be a non-negative integer")
        try:
            parsed = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"skill.yaml {field_name} must be a non-negative integer") from exc
        if parsed < 0:
            raise ValueError(f"skill.yaml {field_name} must be a non-negative integer")
        return parsed

    def _required_bool(self, value: Any, *, fallback: bool, field_name: str) -> bool:
        if value is None:
            return fallback
        if isinstance(value, bool):
            return value
        raise ValueError(f"skill.yaml {field_name} must be a boolean")

    def _first_present(self, data: dict[str, Any], *keys: str) -> Any:
        for key in keys:
            if key in data:
                return data[key]
        return None


def load_skill_catalog(skills_dir: Path | None = None, *, tool_registry: ToolRegistry | None = None) -> list[BaseSkill]:
    return SkillDirectoryLoader(skills_dir, tool_registry=tool_registry).load()
