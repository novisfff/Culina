from __future__ import annotations

from app.ai.skills.base import SkillContext
from app.ai.workflows.orchestrator.state import OrchestratorRunState
from app.core.utils import create_id


def preview_tool_call_progress(
    *,
    context: SkillContext,
    state: OrchestratorRunState,
    tool_name: str,
    preview_key: str,
    status: str,
) -> str | None:
    context.ensure_active()
    if tool_name == "skill.inject" or tool_name not in state.current_tool_names:
        return None
    event_id = (
        create_id("ai_run_event")
        if status == "running"
        else state.preview_event_ids_by_key.get(preview_key) or create_id("ai_run_event")
    )
    state.preview_event_ids_by_key[preview_key] = event_id
    event_type = "script" if tool_name in state.current_script_executors else "tool"
    visible_status, user_message = tool_progress_message(state, tool_name, status)
    context.emit_progress(event_type, tool_name, user_message, status=visible_status, event_id=event_id)
    return event_id


def tool_progress_message(state: OrchestratorRunState, tool_name: str, status: str) -> tuple[str, str]:
    definition = state.current_tool_definitions.get(tool_name)
    display_name = definition.display_name if definition else tool_name
    side_effect = definition.side_effect if definition else "read"
    if tool_name == "human.request_input" and status != "failed":
        return "waiting", "等待用户补充信息"
    if status == "failed":
        return "failed", f"「{display_name}」调用失败"
    if side_effect == "draft":
        return status, f"生成「{display_name}」"
    return status, f"调用「{display_name}」"
