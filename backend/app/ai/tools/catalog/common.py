from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.ai.tools.base import ToolDefinition
from app.ai.tools.registry import ToolRegistry


def register_tool(
    registry: ToolRegistry,
    *,
    name: str,
    description: str,
    side_effect: str,
    handler,
    input_schema: dict[str, Any],
    output_schema: dict[str, Any],
    permission: str = "family:read",
) -> None:
    registry.register(
        ToolDefinition(
            name=name,
            description=description,
            input_schema=input_schema,
            output_schema=output_schema,
            permission=permission,
            side_effect=side_effect,  # type: ignore[arg-type]
            requires_confirmation=side_effect == "draft",
            handler=handler,
        )
    )


def decimal_text(value: Decimal | int | float | None) -> str:
    if value is None:
        return "0"
    return f"{float(value):g}"
