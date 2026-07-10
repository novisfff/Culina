from __future__ import annotations

import logging
from typing import Any

from app.ai.observability import error_codes
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
        self.context.tool_results = self.results

    def call(self, name: str, payload: dict[str, Any] | None = None, *, progress_event_id: str | None = None) -> dict[str, Any]:
        if self.context.cancel_check is not None and self.context.cancel_check():
            raise AIExecutionCancelled("AI run was cancelled")
        tool_input = payload or {}
        tracer = self.context.tracer
        try:
            definition = self.registry.get(name)
        except KeyError:
            if tracer is not None:
                tracer.record_event(
                    "tool_call",
                    name,
                    status="failed",
                    parent_span_id=self.context.trace_parent_span_id,
                    round_index=self.context.trace_round_index,
                    payload={"inputKeys": sorted(tool_input.keys())},
                    error_code=error_codes.TOOL_UNKNOWN,
                    error_message=f"unknown tool: {name}",
                )
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
        span = (
            tracer.start_span(
                "tool_call",
                name,
                parent_span_id=self.context.trace_parent_span_id,
                round_index=self.context.trace_round_index,
                input_summary={
                    "inputKeys": sorted(tool_input.keys()),
                    "sideEffect": definition.side_effect,
                    "permission": definition.permission,
                    "requiresConfirmation": definition.requires_confirmation,
                },
            )
            if tracer is not None
            else None
        )
        if name in self.forbidden_tools:
            if span is not None:
                span.finish(
                    status="failed",
                    error_code=error_codes.TOOL_PERMISSION_DENIED,
                    error_message=f"forbidden tool: {name}",
                )
            logger.warning(
                "AI tool rejected forbidden tool=%s run_id=%s conversation_id=%s family_id=%s",
                name,
                self.context.run_id,
                self.context.conversation_id,
                self.context.family_id,
            )
            raise PermissionError(f"当前 Skill 禁止调用工具 {name}")
        if self.allowed_tools is not None and name not in self.allowed_tools:
            if span is not None:
                span.finish(
                    status="failed",
                    error_code=error_codes.TOOL_PERMISSION_DENIED,
                    error_message=f"undeclared tool: {name}",
                )
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
            if span is not None:
                span.finish(
                    status="failed",
                    error_code=error_codes.TOOL_SIDE_EFFECT_DENIED,
                    error_message=f"side effect denied: {definition.side_effect}",
                )
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
            if span is not None:
                span.finish(
                    status="failed",
                    error_code=error_codes.TOOL_INPUT_VALIDATION_FAILED,
                    error_message=f"{name} input validation failed",
                )
            if progress_event_id:
                self._emit_tool_progress(
                    definition.name,
                    self._tool_message(definition.display_name, definition.side_effect, "failed"),
                    "failed",
                    event_id=progress_event_id,
                )
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
        progress_event_id = progress_event_id or create_id("ai_run_event")
        self._emit_tool_progress(
            definition.name,
            self._tool_message(definition.display_name, definition.side_effect, "running"),
            "running",
            event_id=progress_event_id,
        )
        try:
            result = timed_call(definition, self.context, tool_input)
        except Exception:
            if span is not None:
                span.finish(
                    status="failed",
                    error_code=error_codes.TOOL_HANDLER_FAILED,
                    error_message=f"{name} handler raised",
                )
            self._emit_tool_progress(
                definition.name,
                self._tool_message(definition.display_name, definition.side_effect, "failed"),
                "failed",
                event_id=progress_event_id,
            )
            raise
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
            if span is not None:
                span.finish(
                    status="failed",
                    output_summary={"durationMs": result.duration_ms},
                    error_code=error_codes.TOOL_HANDLER_FAILED,
                    error_message=result.error,
                )
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
            if span is not None:
                span.finish(
                    status="failed",
                    output_summary={"durationMs": result.duration_ms, "outputKeys": sorted(result.output.keys())},
                    error_code=error_codes.TOOL_OUTPUT_VALIDATION_FAILED,
                    error_message=f"{name} output validation failed",
                )
            self._emit_tool_progress(
                definition.name,
                self._tool_message(definition.display_name, definition.side_effect, "failed"),
                "failed",
                event_id=progress_event_id,
            )
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
        if span is not None:
            span.finish(
                status=result.status,
                output_summary={
                    "durationMs": result.duration_ms,
                    "status": result.status,
                    "outputKeys": sorted(result.output.keys()),
                },
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
