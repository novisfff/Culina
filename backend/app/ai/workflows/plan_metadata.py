from __future__ import annotations

from typing import Any


def agent_key_for_plan(skill_registry: Any, plan: Any) -> str:
    if plan.failed:
        return "workspace_planner"
    if not plan.skills:
        return "general_chat_agent"
    if len(plan.skills) == 1:
        return skill_registry.get(plan.skills[0]).manifest.agent_key
    return "workspace_planner"


def intent_for_plan(skill_registry: Any, plan: Any) -> str:
    if plan.failed:
        return "planner_failed"
    if not plan.skills:
        return "general_chat"
    if len(plan.skills) == 1:
        return skill_registry.get(plan.skills[0]).manifest.intent
    return "multi_skill"
