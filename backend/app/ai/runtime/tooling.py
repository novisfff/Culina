from __future__ import annotations

import inspect
import json
import re
from typing import Any

from app.ai.runtime.prompt_cache import canonical_json
from app.ai.runtime.types import ToolCallHandler
from app.ai.tools.base import ToolDefinition


def model_tool_name(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", name)[:64]


def json_object(text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(text)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def invoke_tool_handler(
    tool_handler: ToolCallHandler,
    name: str,
    args: dict[str, Any],
    progress_event_id: str | None,
    tool_call_id: str | None = None,
) -> dict[str, Any]:
    try:
        parameters = inspect.signature(tool_handler).parameters
    except (TypeError, ValueError):
        return tool_handler(name, args, progress_event_id, tool_call_id)
    positional = [
        parameter
        for parameter in parameters.values()
        if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
    ]
    has_varargs = any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in parameters.values())
    if has_varargs or len(positional) >= 4:
        return tool_handler(name, args, progress_event_id, tool_call_id)
    if len(positional) >= 3:
        return tool_handler(name, args, progress_event_id)
    return tool_handler(name, args)


def tool_error_message(name: str, exc: Exception) -> dict[str, Any]:
    return {
        "status": "failed",
        "code": "tool_execution_failed",
        "tool": name,
        "error": str(exc) or exc.__class__.__name__,
        "recoverable": True,
    }


def chat_tool_definition_to_model_tool(definition: ToolDefinition) -> dict[str, Any]:
    description = f"{definition.display_name}: {definition.description} original_name={definition.name} side_effect={definition.side_effect}"
    parameters = definition.input_schema
    if definition.side_effect == "draft":
        from app.ai.workflows.orchestrator.continuation import CONTINUATION_INPUT_SCHEMA

        draft_schema = definition.input_schema
        if isinstance(definition.input_schema.get("properties"), dict) and isinstance(
            definition.input_schema["properties"].get("draft"),
            dict,
        ):
            draft_schema = definition.input_schema["properties"]["draft"]
        description = (
            f"{description}. Use arguments.draft for the business draft payload. "
            "Use arguments.continuation only for a declared typed Skill handoff after user approval."
        )
        parameters = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "draft": draft_schema,
                "continuation": CONTINUATION_INPUT_SCHEMA,
            },
            "required": ["draft"],
        }
    return {
        "type": "function",
        "function": {
            "name": model_tool_name(definition.name),
            "description": description,
            "parameters": parameters,
        },
    }


def responses_tool_definition_to_model_tool(definition: ToolDefinition) -> dict[str, Any]:
    chat_tool = chat_tool_definition_to_model_tool(definition)
    function = chat_tool.get("function") if isinstance(chat_tool.get("function"), dict) else {}
    return {
        "type": "function",
        "name": function.get("name"),
        "description": function.get("description"),
        "parameters": function.get("parameters") or {"type": "object"},
        "strict": False,
    }


def dedupe_responses_tool_calls(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for call in calls:
        call_id = call.get("id")
        if call_id:
            key = f"id:{call_id}"
        else:
            key = canonical_json(
                {
                    "name": call.get("name"),
                    "args": call.get("args") if isinstance(call.get("args"), dict) else {},
                }
            )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(call)
    return deduped
