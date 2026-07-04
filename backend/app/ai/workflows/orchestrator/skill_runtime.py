from __future__ import annotations

from typing import Any

from app.ai.skills.base import SkillContext
from app.ai.tools.base import ToolDefinition
from app.ai.workflows.orchestrator.skill_injection import SkillInjectionBundle, SkillInjectionManager
from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.ai.workflows.orchestrator.tool_schemas import provider_visible_tools


def skill_injection_request(payload: dict[str, Any]) -> tuple[list[str], str | None]:
    skills = payload.get("skills")
    if not isinstance(skills, list):
        return [], "skill.inject.skills 必须是非空数组。"
    if not skills:
        return [], "skill.inject.skills 至少需要一个 Skill key。"
    requested: list[str] = []
    for item in skills:
        if not isinstance(item, str):
            return [], "skill.inject.skills 里的每一项都必须是 skill.yaml:key 字符串。"
        skill_key = item.strip()
        if not skill_key:
            return [], "skill.inject.skills 不能包含空 Skill key。"
        if skill_key not in requested:
            requested.append(skill_key)
    return requested, None


def execute_skill_injection(
    *,
    payload: dict[str, Any],
    context: SkillContext,
    injection_manager: SkillInjectionManager,
    state: OrchestratorRunState,
) -> dict[str, Any]:
    requested, payload_error = skill_injection_request(payload)
    if payload_error is not None:
        return {
            "error": payload_error,
            "code": "invalid_skill_inject_payload",
            "status": "invalid_tool_payload",
            "injectedSkills": [],
            "alreadyInjected": [],
            "availableTools": sorted(state.current_tool_names),
        }
    available_skill_keys = {
        key
        for key in injection_manager.skill_registry.keys()
        if state.capability_policy.allows_skill(key)
    }
    unknown_keys = [key for key in requested if key not in available_skill_keys]
    if unknown_keys:
        _record_skill_injection_trace(
            context=context,
            state=state,
            status="failed",
            payload={"requested": requested, "unknown": unknown_keys},
            error_code="unknown_skill",
            error_message="unknown skill injection",
        )
        return {
            "error": "请求注入的 Skill 不存在。请使用 catalog records 里的 skill.yaml:key。",
            "code": "unknown_skill",
            "unknownSkills": unknown_keys,
            "injectedSkills": [],
            "alreadyInjected": [key for key in requested if key in state.active_skill_keys],
            "availableTools": sorted(state.current_tool_names),
        }
    requested_existing = [key for key in requested if key in state.active_skill_keys]
    requested_new_all = [key for key in requested if key not in state.active_skill_keys]
    max_business_skills = state.budget_config.max_business_skills_per_run
    if requested_new_all and len(state.active_skill_keys) >= max_business_skills:
        _record_skill_injection_trace(
            context=context,
            state=state,
            status="failed",
            payload={
                "requested": requested,
                "activeSkillCount": len(state.active_skill_keys),
                "maxBusinessSkills": max_business_skills,
            },
            error_code="skill_budget_exhausted",
            error_message="skill budget exhausted",
        )
        return {
            "error": f"本次任务最多注入 {max_business_skills} 个业务 Skill。",
            "code": "skill_budget_exhausted",
            "injectedSkills": [],
            "alreadyInjected": requested_existing,
            "availableTools": sorted(state.current_tool_names),
        }

    available_slots = max(0, max_business_skills - len(state.active_skill_keys))
    requested_new = requested_new_all[:available_slots]
    state.active_skill_keys, added = injection_manager.inject(state.active_skill_keys, requested_new)
    state.budget_config = injection_manager.budget_config_for(
        state.active_skill_keys,
        state.base_budget_config,
        state.capability_policy,
    )
    state.requires_terminal_output, state.terminal_text_allowed = injection_manager.completion_policy_for(
        state.active_skill_keys,
        state.capability_policy,
    )
    _record_skill_injection_trace(
        context=context,
        state=state,
        payload={
            "requested": requested,
            "added": [bundle.key for bundle in added],
            "alreadyInjected": requested_existing,
        },
    )
    _publish_injected_skills(context, state, added)
    next_tools, _ = injection_manager.tool_definitions(
        state.active_skill_keys,
        context,
        state.capability_policy,
    )
    next_tools = provider_visible_tools(next_tools, injection_manager=injection_manager, state=state)
    return {
        "injectedSkills": [_injected_skill_payload(bundle) for bundle in added],
        "alreadyInjected": requested_existing,
        "availableTools": sorted(definition.name for definition in next_tools),
    }


def _record_skill_injection_trace(
    *,
    context: SkillContext,
    state: OrchestratorRunState,
    payload: dict[str, Any],
    status: str = "completed",
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    if context.tracer is None:
        return
    context.tracer.record_event(
        "skill_injection",
        "skill.inject",
        status=status,
        parent_span_id=context.trace_parent_span_id,
        round_index=state.trace_round_index,
        payload=payload,
        error_code=error_code,
        error_message=error_message,
    )


def _publish_injected_skills(
    context: SkillContext,
    state: OrchestratorRunState,
    added: list[SkillInjectionBundle],
) -> None:
    if not added:
        return
    state.injection_history.extend(
        {"skillKey": bundle.key, "displayName": bundle.display_name, "source": "tool"}
        for bundle in added
    )
    for bundle in added:
        context.emit_progress(
            "skill",
            f"{bundle.key}.start",
            f"调用「{bundle.display_name}」技能",
            status="completed",
        )


def _injected_skill_payload(bundle: SkillInjectionBundle) -> dict[str, Any]:
    return {
        "key": bundle.key,
        "displayName": bundle.display_name,
        "instructions": bundle.instructions,
        "allowedTools": bundle.allowed_tools,
        "draftTypes": bundle.draft_types,
        "draftContract": bundle.draft_contract,
        "approvalPolicy": bundle.approval_policy,
        "toolBudget": bundle.tool_budget,
        "completionPolicy": bundle.completion_policy,
    }
