from __future__ import annotations

from typing import Any

from app.ai.tools.base import ToolContext
from app.ai.tools.catalog.common import register_tool
from app.ai.tools.registry import ToolRegistry


CLARIFICATION_INPUT = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"missingFields": {"type": "array", "items": {"type": "string"}}},
}
CLARIFICATION_OUTPUT = {
    "type": "object",
    "required": ["missingFields"],
    "properties": {"missingFields": {"type": "array", "items": {"type": "string"}}},
}


def intent_request_clarification(context: ToolContext, payload: dict[str, Any]) -> dict[str, Any]:
    del context
    return {"missingFields": payload.get("missingFields") or []}


def register_intent_tools(registry: ToolRegistry) -> None:
    register_tool(
        registry,
        name="intent.request_clarification",
        description="请求用户补充缺失信息。",
        side_effect="read",
        handler=intent_request_clarification,
        input_schema=CLARIFICATION_INPUT,
        output_schema=CLARIFICATION_OUTPUT,
    )
