from __future__ import annotations

import logging
from typing import Any

from app.ai.tools.base import ToolContext, ToolResult, ToolSideEffect, timed_call
from app.ai.tools.registry import ToolRegistry
from app.ai.tools.validation import validate_json_value
from app.ai.errors import AIExecutionCancelled
from app.core.utils import create_id, utcnow

logger = logging.getLogger(__name__)


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
        if self.context.cancel_check is not None and self.context.cancel_check():
            raise AIExecutionCancelled("AI run was cancelled")
        tool_input = payload or {}
        try:
            definition = self.registry.get(name)
        except KeyError:
            logger.warning(
                "AI tool rejected unknown tool=%s run_id=%s conversation_id=%s family_id=%s input_keys=%s",
                name,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
                sorted(tool_input.keys()),
                exc_info=True,
            )
            raise
        if name in self.forbidden_tools:
            logger.warning(
                "AI tool rejected forbidden tool=%s run_id=%s conversation_id=%s family_id=%s",
                name,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
            )
            raise PermissionError(f"当前 Skill 禁止调用工具 {name}")
        if self.allowed_tools is not None and name not in self.allowed_tools:
            logger.warning(
                "AI tool rejected undeclared tool=%s run_id=%s conversation_id=%s family_id=%s allowed_tools=%s",
                name,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
                sorted(self.allowed_tools),
            )
            raise PermissionError(f"当前 Skill 未声明工具 {name}")
        if self.allowed_side_effects is not None and definition.side_effect not in self.allowed_side_effects:
            logger.warning(
                "AI tool rejected side effect tool=%s side_effect=%s run_id=%s conversation_id=%s family_id=%s allowed_side_effects=%s",
                name,
                definition.side_effect,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
                sorted(self.allowed_side_effects),
            )
            raise PermissionError(f"当前 Skill 不允许调用 {definition.side_effect} 类型工具 {name}")

        try:
            validate_json_value(tool_input, definition.input_schema, location=f"{name} input")
        except Exception:
            logger.warning(
                "AI tool input validation failed tool=%s run_id=%s conversation_id=%s family_id=%s input_keys=%s",
                name,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
                sorted(tool_input.keys()),
                exc_info=True,
            )
            raise
        logger.info(
            "AI tool call started tool=%s side_effect=%s run_id=%s conversation_id=%s family_id=%s input_keys=%s",
            name,
            definition.side_effect,
            self.context.run_id,
            self.context.conversation_id,
            self.context.family_id,
            sorted(tool_input.keys()),
        )
        progress_event_id = create_id("ai_run_event")
        self._emit_tool_progress(
            definition.name,
            self._tool_message(definition.display_name, definition.side_effect, "running"),
            "running",
            event_id=progress_event_id,
        )
        result = timed_call(definition, self.context, tool_input)
        if self.context.cancel_check is not None and self.context.cancel_check():
            raise AIExecutionCancelled("AI run was cancelled")
        self.results.append(result)
        self._emit_tool_progress(
            definition.name,
            self._tool_message(definition.display_name, definition.side_effect, result.status),
            result.status,
            event_id=progress_event_id,
        )
        if result.status == "failed":
            logger.warning(
                "AI tool call failed tool=%s side_effect=%s run_id=%s conversation_id=%s family_id=%s duration_ms=%s error=%s",
                name,
                definition.side_effect,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
                result.duration_ms,
                result.error,
            )
            raise ValueError(result.error or f"工具 {name} 执行失败")
        try:
            validate_json_value(result.output, definition.output_schema, location=f"{name} output")
        except Exception:
            logger.warning(
                "AI tool output validation failed tool=%s run_id=%s conversation_id=%s family_id=%s output_keys=%s",
                name,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
                sorted(result.output.keys()),
                exc_info=True,
            )
            raise
        logger.info(
            "AI tool call completed tool=%s side_effect=%s run_id=%s conversation_id=%s family_id=%s duration_ms=%s output_keys=%s",
            name,
            definition.side_effect,
            self.context.run_id,
            self.context.conversation_id,
            self.context.family_id,
            result.duration_ms,
            sorted(result.output.keys()),
        )
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

    def _emit_tool_progress(self, name: str, user_message: str, status: str, *, event_id: str | None = None) -> None:
        if self.context.stream_writer is None:
            return
        visible_status = "failed" if status == "failed" else status
        visible_message = user_message
        if name == "human.request_input" and status != "failed":
            visible_status = "waiting"
            visible_message = "等待用户补充信息"
        self.context.stream_writer(
            {
                "event": "progress",
                "data": {
                    "id": event_id or create_id("ai_run_event"),
                    "run_id": self.context.run_id,
                    "type": "tool",
                    "internal_code": name,
                    "user_message": visible_message,
                    "status": visible_status,
                    "created_at": utcnow(),
                },
            }
        )

    def _tool_message(self, display_name: str, side_effect: ToolSideEffect, status: str) -> str:
        if status == "failed":
            return f"「{display_name}」调用失败"
        if side_effect == "draft":
            return f"生成「{display_name}」"
        return f"调用「{display_name}」"
