from __future__ import annotations

from dataclasses import replace

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
    if definition.name == "ui.propose_actions" and state.profile_key == "recipe_cook_page":
        return _with_compact_ui_action_schema(definition)
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


def _with_compact_ui_action_schema(definition: ToolDefinition) -> ToolDefinition:
    properties = definition.input_schema.get("properties") if isinstance(definition.input_schema, dict) else {}
    if not isinstance(properties, dict) or "actions" not in properties:
        return definition
    compact_properties = {"actions": properties["actions"]}
    if "requiresConfirmation" in properties:
        compact_properties["requiresConfirmation"] = properties["requiresConfirmation"]
    return replace(
        definition,
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "required": ["actions"],
            "properties": compact_properties,
        },
    )
