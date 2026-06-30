from __future__ import annotations

from app.ai.tools.base import ToolDefinition
from app.ai.tools.catalog.intent import skill_inject_request_schema
from app.ai.workflows.orchestrator.skill_injection import SkillInjectionManager
from app.ai.workflows.orchestrator.state import OrchestratorRunState


def remaining_skill_slots(state: OrchestratorRunState) -> int:
    if not state.capability_policy.allows_dynamic_skill_injection():
        return 0
    return max(
        0,
        state.budget_config.max_business_skills_per_run - len(state.active_skill_keys),
    )


def provider_visible_tools(
    definitions: list[ToolDefinition],
    *,
    injection_manager: SkillInjectionManager,
    state: OrchestratorRunState,
) -> list[ToolDefinition]:
    if remaining_skill_slots(state) <= 0:
        definitions = [definition for definition in definitions if definition.name != "skill.inject"]
    return [
        with_runtime_tool_schema(definition, injection_manager=injection_manager, state=state)
        for definition in definitions
    ]


def with_runtime_tool_schema(
    definition: ToolDefinition,
    *,
    injection_manager: SkillInjectionManager,
    state: OrchestratorRunState,
) -> ToolDefinition:
    if definition.name != "skill.inject":
        return definition
    skill_keys = injection_manager.skill_registry.keys()
    if state.capability_policy.allowed_skill_keys:
        skill_keys = [
            key
            for key in skill_keys
            if key in state.capability_policy.allowed_skill_keys
        ]
    return ToolDefinition(
        name=definition.name,
        display_name=definition.display_name,
        description=definition.description,
        input_schema=skill_inject_request_schema(
            sorted(skill_keys),
            max_items=remaining_skill_slots(state),
        ),
        output_schema=definition.output_schema,
        permission=definition.permission,
        side_effect=definition.side_effect,
        handler=definition.handler,
        requires_confirmation=definition.requires_confirmation,
        requires_followup=definition.requires_followup,
        terminal_output=definition.terminal_output,
        followup_hint=definition.followup_hint,
        output_types=list(definition.output_types),
        draft_types=list(definition.draft_types),
    )
