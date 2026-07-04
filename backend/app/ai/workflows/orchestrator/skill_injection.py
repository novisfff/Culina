from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from app.ai.skills.base import SkillContext
from app.ai.skills.registry import SkillRegistry
from app.ai.skills.scripts import SkillScriptExecutor
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.orchestrator.profiles import OrchestratorBudgetConfig, OrchestratorCapabilityPolicy


DEFAULT_ORCHESTRATOR_BASE_TOOL_NAMES = {"skill.inject", "human.request_input"}


@dataclass(slots=True)
class SkillInjectionBundle:
    key: str
    display_name: str
    instructions: str
    manifest_record: dict[str, Any]
    allowed_tools: list[str] = field(default_factory=list)
    output_types: list[str] = field(default_factory=list)
    draft_types: list[str] = field(default_factory=list)
    draft_contract: dict[str, dict[str, str]] = field(default_factory=dict)
    tool_budget: dict[str, int] = field(default_factory=dict)
    completion_policy: dict[str, Any] = field(default_factory=dict)
    approval_policy: str = "none"


class SkillInjectionManager:
    def __init__(self, skill_registry: SkillRegistry) -> None:
        self.skill_registry = skill_registry

    def catalog_records(
        self,
        capability_policy: OrchestratorCapabilityPolicy | None = None,
    ) -> list[dict[str, Any]]:
        return [
            manifest.to_catalog_record()
            for manifest in self.skill_registry.list_manifests()
            if capability_policy is None or capability_policy.allows_skill(manifest.key)
        ]

    def inject(
        self,
        existing_keys: list[str],
        requested_keys: list[str],
    ) -> tuple[list[str], list[SkillInjectionBundle]]:
        next_keys = list(dict.fromkeys(existing_keys))
        added: list[SkillInjectionBundle] = []
        for key in requested_keys:
            normalized_key = str(key or "").strip()
            if not normalized_key:
                continue
            if normalized_key not in self.skill_registry.keys():
                raise ValueError(f"unknown skill injection: {normalized_key}")
            if normalized_key in next_keys:
                continue
            next_keys.append(normalized_key)
            added.append(self.bundle_for(normalized_key))
        return next_keys, added

    def bundle_for(self, skill_key: str) -> SkillInjectionBundle:
        skill = self.skill_registry.get(skill_key)
        manifest = skill.manifest
        return SkillInjectionBundle(
            key=manifest.key,
            display_name=manifest.name,
            instructions=str(getattr(skill, "instructions", "") or ""),
            manifest_record=manifest.to_catalog_record(),
            allowed_tools=list(manifest.tools),
            output_types=list(manifest.output_types),
            draft_types=list(manifest.draft_types),
            draft_contract={draft_type: dict(contract) for draft_type, contract in manifest.draft_contract.items()},
            tool_budget=dict(manifest.tool_budget),
            completion_policy=manifest.completion_policy.to_catalog_record(),
            approval_policy=manifest.approval_policy,
        )

    def bundles_for(self, skill_keys: list[str]) -> list[SkillInjectionBundle]:
        return [self.bundle_for(key) for key in skill_keys]

    def allowed_tool_names(self, skill_keys: list[str], capability_policy: OrchestratorCapabilityPolicy) -> set[str]:
        names: set[str] = set(capability_policy.base_tools)
        for key in skill_keys:
            if not capability_policy.allows_skill(key):
                continue
            names.update(self.skill_registry.get(key).manifest.tools)
        return names

    def allowed_output_types(self, skill_keys: list[str]) -> set[str]:
        values: set[str] = set()
        for key in skill_keys:
            values.update(self.skill_registry.get(key).manifest.output_types)
        return values

    def allowed_draft_types(self, skill_keys: list[str]) -> set[str]:
        values: set[str] = set()
        for key in skill_keys:
            values.update(self.skill_registry.get(key).manifest.draft_types)
        return values

    def budget_config_for(
        self,
        skill_keys: list[str],
        base_config: OrchestratorBudgetConfig,
        capability_policy: OrchestratorCapabilityPolicy,
    ) -> OrchestratorBudgetConfig:
        skill_total_tool_calls = 0
        has_skill_tool_budget = False
        max_same_read_calls = base_config.max_same_read_tool_calls_per_run
        for key in skill_keys:
            if not capability_policy.allows_skill(key):
                continue
            budget = self.skill_registry.get(key).manifest.tool_budget
            if "max_tool_calls" in budget:
                has_skill_tool_budget = True
                skill_total_tool_calls += budget["max_tool_calls"]
            if "max_same_read_calls" in budget:
                max_same_read_calls = min(max_same_read_calls, budget["max_same_read_calls"])
        max_total_tool_calls = (
            min(base_config.max_total_tool_calls_per_run, skill_total_tool_calls)
            if has_skill_tool_budget
            else base_config.max_total_tool_calls_per_run
        )
        return OrchestratorBudgetConfig(
            max_business_skills_per_run=base_config.max_business_skills_per_run,
            max_total_tool_calls_per_run=max_total_tool_calls,
            max_same_read_tool_calls_per_run=max_same_read_calls,
        )

    def completion_policy_for(
        self,
        skill_keys: list[str],
        capability_policy: OrchestratorCapabilityPolicy,
    ) -> tuple[bool, bool]:
        active_policies = [
            self.skill_registry.get(key).manifest.completion_policy
            for key in skill_keys
            if capability_policy.allows_skill(key)
        ]
        return (
            any(policy.requires_terminal_output for policy in active_policies),
            all(policy.terminal_text_allowed for policy in active_policies),
        )

    def tool_definitions(
        self,
        skill_keys: list[str],
        context: SkillContext,
        capability_policy: OrchestratorCapabilityPolicy,
    ) -> tuple[list[ToolDefinition], dict[str, SkillScriptExecutor]]:
        definitions: list[ToolDefinition] = []
        script_executors: dict[str, SkillScriptExecutor] = {}
        base_tool_names = set(capability_policy.base_tools)
        for name in sorted(self.allowed_tool_names(skill_keys, capability_policy)):
            definition = context.tool_executor.registry.get(name)
            if name in base_tool_names and definition.side_effect != "control":
                raise ValueError(f"Orchestrator base tools must be control tools: {name}")
            if definition.side_effect == "write":
                raise ValueError(f"Injected skills must not expose write tool: {name}")
            definitions.append(self._with_skill_completion_policy(definition, skill_keys, capability_policy))

        for key in skill_keys:
            if not capability_policy.allows_skill(key):
                continue
            skill = self.skill_registry.get(key)
            script_catalog = getattr(skill, "script_catalog", None)
            if script_catalog is None:
                continue
            executor = SkillScriptExecutor(script_catalog, context)
            for definition in executor.tool_definitions():
                if definition.name in script_executors:
                    raise ValueError(f"Duplicate injected script tool: {definition.name}")
                script_executors[definition.name] = executor
                definitions.append(self._with_skill_completion_policy(definition, [key], capability_policy))
        return definitions, script_executors

    def _with_skill_completion_policy(
        self,
        definition: ToolDefinition,
        skill_keys: list[str],
        capability_policy: OrchestratorCapabilityPolicy,
    ) -> ToolDefinition:
        requires_followup = definition.requires_followup
        terminal_output = definition.terminal_output
        followup_hint = definition.followup_hint
        for key in skill_keys:
            if not capability_policy.allows_skill(key):
                continue
            policy = self.skill_registry.get(key).manifest.completion_policy
            if definition.name in policy.terminal_tools:
                terminal_output = True
                if not followup_hint:
                    followup_hint = policy.terminal_tools[definition.name]
            if definition.name in policy.followup_required_tools:
                requires_followup = True
                terminal_output = False
                followup_hint = policy.followup_required_tools[definition.name] or followup_hint
        if (
            requires_followup == definition.requires_followup
            and terminal_output == definition.terminal_output
            and followup_hint == definition.followup_hint
        ):
            return definition
        return replace(
            definition,
            requires_followup=requires_followup,
            terminal_output=terminal_output,
            followup_hint=followup_hint,
        )

    def scoped_tool_executor(
        self,
        context: SkillContext,
        skill_keys: list[str],
        capability_policy: OrchestratorCapabilityPolicy,
    ):
        allowed_side_effects = {"read", "control"}
        if capability_policy.exposes_draft_contract() and any(
            self.skill_registry.get(key).manifest.approval_policy == "draft_then_confirm"
            for key in skill_keys
            if capability_policy.allows_skill(key)
        ):
            allowed_side_effects.add("draft")
        return context.tool_executor.scoped(
            allowed_tools=self.allowed_tool_names(skill_keys, capability_policy),
            allowed_side_effects=allowed_side_effects,
        )

    def skill_keys_for_tool(self, tool_name: str, skill_keys: list[str]) -> list[str]:
        if tool_name in DEFAULT_ORCHESTRATOR_BASE_TOOL_NAMES:
            return []
        return [
            key
            for key in skill_keys
            if tool_name in self.skill_registry.get(key).manifest.tools
        ]

    def draft_type_from_tool_output(self, tool_name: str, draft: dict[str, Any], active_skill_keys: list[str]) -> str:
        draft_type = str(draft.get("draftType") or draft.get("draft_type") or "").strip()
        if draft_type:
            return draft_type
        candidate_types: set[str] = set()
        for key in self.skill_keys_for_tool(tool_name, active_skill_keys):
            manifest = self.skill_registry.get(key).manifest
            if len(manifest.draft_types) == 1:
                candidate_types.add(manifest.draft_types[0])
        if len(candidate_types) == 1:
            return next(iter(candidate_types))
        allowed = self.allowed_draft_types(active_skill_keys)
        if len(allowed) == 1:
            return next(iter(allowed))
        raise ValueError(f"Draft tool {tool_name} did not identify draft type")
