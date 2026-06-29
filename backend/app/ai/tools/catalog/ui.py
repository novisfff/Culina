from __future__ import annotations

from typing import Any

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry
from app.core.utils import create_id


COOK_PAGE_ACTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["type"],
    "properties": {
        "type": {
            "type": "string",
            "enum": [
                "go_next_step",
                "go_previous_step",
                "jump_to_step",
                "switch_tab",
                "start_timer",
                "pause_timer",
                "reset_timer",
                "add_timer_seconds",
                "set_timer",
                "reset_cook_session",
                "delete_timer",
                "finish_cooking",
                "open_shopping_dialog",
            ],
        },
        "stepIndex": {"type": "integer", "minimum": 0, "maximum": 200},
        "tab": {"type": "string", "enum": ["step", "ingredients"]},
        "timerId": {"type": "string", "minLength": 1, "maxLength": 120},
        "seconds": {"type": "integer", "minimum": 1, "maximum": 21600},
        "name": {"type": "string", "minLength": 1, "maxLength": 40},
    },
}

UI_ACTIONS_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["surface", "recipeId", "cookSessionId", "sessionRevision", "actions"],
    "properties": {
        "surface": {"type": "string", "enum": ["recipe_cook_page"]},
        "recipeId": {"type": "string", "minLength": 1, "maxLength": 64},
        "cookSessionId": {"type": "string", "minLength": 1, "maxLength": 160},
        "sessionRevision": {"type": "integer", "minimum": 0},
        "actions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": COOK_PAGE_ACTION_SCHEMA,
        },
        "requiresConfirmation": {"type": "boolean"},
    },
}

UI_ACTIONS_OUTPUT_SCHEMA = {
    "type": "object",
    "required": ["card"],
    "properties": {
        "card": {
            "type": "object",
            "required": ["id", "type", "title", "data"],
            "properties": {
                "id": {"type": "string"},
                "type": {"type": "string", "enum": ["ui_actions"]},
                "title": {"type": "string"},
                "data": {"type": "object"},
            },
        },
    },
}

HIGH_RISK_COOK_ACTIONS = {"reset_cook_session", "delete_timer", "finish_cooking", "open_shopping_dialog"}


def _normalize_action(action: dict[str, Any]) -> dict[str, Any]:
    action_type = str(action.get("type") or "").strip()
    if action_type in {"jump_to_step"} and "stepIndex" not in action:
        raise ValueError("跳转步骤需要提供 stepIndex")
    if action_type == "switch_tab" and action.get("tab") not in {"step", "ingredients"}:
        raise ValueError("切换视图需要提供 tab")
    if action_type in {"add_timer_seconds", "set_timer"} and "seconds" not in action:
        raise ValueError("计时器动作需要提供 seconds")
    if action_type == "delete_timer" and not str(action.get("timerId") or "").strip():
        raise ValueError("删除计时器需要提供 timerId")
    normalized = {key: value for key, value in action.items() if value is not None}
    normalized["type"] = action_type
    return normalized


def ui_propose_actions(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    surface = str(payload.get("surface") or "").strip()
    if surface != "recipe_cook_page":
        raise ValueError("暂不支持该页面动作")
    actions = [_normalize_action(action) for action in payload.get("actions") or []]
    if not actions:
        raise ValueError("页面动作不能为空")
    requires_confirmation = bool(payload.get("requiresConfirmation")) or any(
        action["type"] in HIGH_RISK_COOK_ACTIONS for action in actions
    )
    return {
        "card": {
            "id": create_id("ai_card"),
            "type": "ui_actions",
            "title": "页面操作建议",
            "data": {
                "surface": surface,
                "recipeId": str(payload["recipeId"]),
                "cookSessionId": str(payload["cookSessionId"]),
                "sessionRevision": int(payload["sessionRevision"]),
                "actions": actions,
                "requiresConfirmation": requires_confirmation,
            },
        }
    }


def register_ui_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="ui.propose_actions",
        display_name="页面操作建议",
        description="返回可由前端校验并执行的页面动作建议；不写入业务数据。",
        side_effect="control",
        handler=ui_propose_actions,
        input_schema=UI_ACTIONS_INPUT_SCHEMA,
        output_schema=UI_ACTIONS_OUTPUT_SCHEMA,
    )
