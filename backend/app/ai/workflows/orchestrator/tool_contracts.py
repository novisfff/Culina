from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.ai.tools.base import ToolDefinition


@dataclass(frozen=True, slots=True)
class ToolCompletionMetadata:
    requires_followup: bool = False
    terminal_output: bool = False
    followup_hint: str = ""


def tool_completion_metadata(
    *,
    output: dict[str, Any],
    definition: ToolDefinition | None = None,
) -> ToolCompletionMetadata:
    followup_hint = str(getattr(definition, "followup_hint", "") or "").strip()
    requires_followup = bool(getattr(definition, "requires_followup", False))
    terminal_output = bool(getattr(definition, "terminal_output", False))
    if isinstance(output, dict):
        output_followup_hint = _tool_output_text_metadata(output, ("followup_hint", "followupHint"))
        if output_followup_hint:
            followup_hint = output_followup_hint
        requires_followup = _tool_output_bool_metadata(
            output,
            ("requires_followup", "requiresFollowup"),
            fallback=requires_followup,
        )
        terminal_output = _tool_output_bool_metadata(
            output,
            ("terminal_output", "terminalOutput"),
            fallback=terminal_output,
        )
    return ToolCompletionMetadata(
        requires_followup=requires_followup,
        terminal_output=terminal_output,
        followup_hint=followup_hint,
    )


def _tool_output_bool_metadata(output: dict[str, Any], keys: tuple[str, ...], *, fallback: bool = False) -> bool:
    value = _tool_output_metadata_value(output, keys)
    if value is None:
        return fallback
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return bool(value)


def _tool_output_text_metadata(output: dict[str, Any], keys: tuple[str, ...]) -> str:
    value = _tool_output_metadata_value(output, keys)
    return str(value).strip() if value is not None else ""


def _tool_output_metadata_value(output: dict[str, Any], keys: tuple[str, ...]) -> Any:
    sources: list[dict[str, Any]] = [output]
    for container_key in ("metadata", "_meta", "orchestrator", "orchestratorMetadata"):
        nested = output.get(container_key)
        if isinstance(nested, dict):
            sources.append(nested)
    for source in sources:
        for key in keys:
            if key in source:
                return source[key]
    return None
