from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any, Literal

from sqlalchemy.orm import Session


ToolSideEffect = Literal["read", "draft", "write"]
ToolHandler = Callable[["ToolContext", dict[str, Any]], dict[str, Any]]


@dataclass(slots=True)
class ToolContext:
    db: Session
    family_id: str
    user_id: str
    conversation_id: str
    run_id: str
    stream_writer: Callable[[dict[str, Any]], None] | None = None


@dataclass(slots=True)
class ToolDefinition:
    name: str
    display_name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    permission: str
    side_effect: ToolSideEffect
    handler: ToolHandler
    requires_confirmation: bool = False


@dataclass(slots=True)
class ToolResult:
    name: str
    input: dict[str, Any]
    permission: str
    side_effect: ToolSideEffect
    output: dict[str, Any] = field(default_factory=dict)
    status: str = "completed"
    duration_ms: int = 0
    error: str | None = None

    def to_record(self) -> dict[str, Any]:
        record: dict[str, Any] = {
            "name": self.name,
            "input": self.input,
            "permission": self.permission,
            "side_effect": self.side_effect,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "output_summary": self._summarize(self.output),
        }
        if self.error:
            record["error"] = self.error
        return record

    def _summarize(self, value: dict[str, Any]) -> dict[str, Any]:
        summary: dict[str, Any] = {}
        for key, item in value.items():
            if isinstance(item, list):
                summary[key] = {"count": len(item)}
            elif isinstance(item, dict):
                summary[key] = {nested_key: nested_value for nested_key, nested_value in item.items() if not isinstance(nested_value, list | dict)}
            else:
                summary[key] = item
        return summary


def timed_call(definition: ToolDefinition, context: ToolContext, payload: dict[str, Any]) -> ToolResult:
    started_at = perf_counter()
    try:
        output = definition.handler(context, payload)
        return ToolResult(
            name=definition.name,
            input=payload,
            permission=definition.permission,
            side_effect=definition.side_effect,
            output=output,
            status="completed",
            duration_ms=int((perf_counter() - started_at) * 1000),
        )
    except Exception as exc:
        return ToolResult(
            name=definition.name,
            input=payload,
            permission=definition.permission,
            side_effect=definition.side_effect,
            status="failed",
            duration_ms=int((perf_counter() - started_at) * 1000),
            error=str(exc),
        )
