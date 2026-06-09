from __future__ import annotations

from typing import Any

from app.ai.tools.base import ToolContext, ToolResult, ToolSideEffect, timed_call
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.validation import validate_json_value
from app.core.utils import create_id, utcnow


class ToolExecutor:
    def __init__(
        self,
        registry: ToolRegistry,
        context: ToolContext,
        *,
        allowed_tools: set[str] | None = None,
        forbidden_tools: set[str] | None = None,
        allowed_side_effects: set[ToolSideEffect] | None = None,
        results: list[ToolResult] | None = None,
    ) -> None:
        self.registry = registry
        self.context = context
        self.allowed_tools = allowed_tools
        self.forbidden_tools = forbidden_tools or set()
        self.allowed_side_effects = allowed_side_effects
        self.results = results if results is not None else []

    def call(self, name: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        definition = self.registry.get(name)
        if name in self.forbidden_tools:
            raise PermissionError(f"当前 Skill 禁止调用工具 {name}")
        if self.allowed_tools is not None and name not in self.allowed_tools:
            raise PermissionError(f"当前 Skill 未声明工具 {name}")
        if self.allowed_side_effects is not None and definition.side_effect not in self.allowed_side_effects:
            raise PermissionError(f"当前 Skill 不允许调用 {definition.side_effect} 类型工具 {name}")

        tool_input = payload or {}
        validate_json_value(tool_input, definition.input_schema, location=f"{name} input")
        self._emit_tool_progress(name, self._tool_running_message(name, definition.side_effect), "running")
        result = timed_call(definition, self.context, tool_input)
        self.results.append(result)
        self._emit_tool_progress(name, self._tool_done_message(name, definition.side_effect, result.status), result.status)
        if result.status == "failed":
            raise ValueError(result.error or f"工具 {name} 执行失败")
        validate_json_value(result.output, definition.output_schema, location=f"{name} output")
        return result.output

    def scoped(
        self,
        *,
        allowed_tools: set[str],
        forbidden_tools: set[str] | None = None,
        allowed_side_effects: set[ToolSideEffect],
    ) -> "ToolExecutor":
        return ToolExecutor(
            self.registry,
            self.context,
            allowed_tools=allowed_tools,
            forbidden_tools=forbidden_tools,
            allowed_side_effects=allowed_side_effects,
            results=self.results,
        )

    def records(self) -> list[dict[str, Any]]:
        return [result.to_record() for result in self.results]

    def _emit_tool_progress(self, name: str, user_message: str, status: str) -> None:
        if self.context.stream_writer is None:
            return
        self.context.stream_writer(
            {
                "event": "progress",
                "data": {
                    "id": create_id("ai_run_event"),
                    "run_id": self.context.run_id,
                    "type": "tool",
                    "internal_code": name,
                    "user_message": user_message,
                    "status": "failed" if status == "failed" else status,
                    "created_at": utcnow(),
                },
            }
        )

    def _tool_running_message(self, name: str, side_effect: ToolSideEffect) -> str:
        action = "准备草稿" if side_effect == "draft" else "读取上下文" if side_effect == "read" else "执行操作"
        return f"{action}：{name}"

    def _tool_done_message(self, name: str, side_effect: ToolSideEffect, status: str) -> str:
        if status == "failed":
            return f"工具执行失败：{name}"
        action = "已准备草稿" if side_effect == "draft" else "已读取上下文" if side_effect == "read" else "已完成操作"
        return f"{action}：{name}"
