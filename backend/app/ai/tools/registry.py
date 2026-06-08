from __future__ import annotations

from app.ai.tools.base import ToolDefinition


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, definition: ToolDefinition) -> None:
        if definition.name in self._tools:
            raise ValueError(f"Duplicate AI tool registration: {definition.name}")
        self._tools[definition.name] = definition

    def get(self, name: str) -> ToolDefinition:
        try:
            return self._tools[name]
        except KeyError as exc:
            raise KeyError(f"Unknown AI tool: {name}") from exc

    def list(self) -> list[ToolDefinition]:
        return list(self._tools.values())


def build_workspace_tool_registry() -> ToolRegistry:
    from app.ai.tools.catalog import (
        register_food_tools,
        register_intent_tools,
        register_inventory_tools,
        register_meal_log_tools,
        register_meal_plan_tools,
        register_recipe_tools,
        register_shopping_tools,
    )

    registry = ToolRegistry()
    register_intent_tools(registry)
    register_inventory_tools(registry)
    register_meal_log_tools(registry)
    register_food_tools(registry)
    register_recipe_tools(registry)
    register_shopping_tools(registry)
    register_meal_plan_tools(registry)
    return registry
