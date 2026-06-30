from __future__ import annotations

from typing import Any

from app.ai.tools.base import ToolDefinition


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, definition: ToolDefinition) -> None:
        if definition.name in self._tools:
            raise ValueError(f"Duplicate AI tool registration: {definition.name}")
        self._validate_tool_contract(definition)
        self._tools[definition.name] = definition

    def get(self, name: str) -> ToolDefinition:
        try:
            return self._tools[name]
        except KeyError as exc:
            raise KeyError(f"Unknown AI tool: {name}") from exc

    def list(self) -> list[ToolDefinition]:
        return list(self._tools.values())

    def _validate_tool_contract(self, definition: ToolDefinition) -> None:
        if definition.side_effect == "draft" and not definition.draft_types:
            raise ValueError(f"AI draft tool {definition.name} must declare draft_types")
        if definition.side_effect != "draft" and definition.draft_types:
            raise ValueError(f"AI non-draft tool {definition.name} must not declare draft_types")
        schema_output_types = _card_output_types_from_schema(definition.output_schema)
        missing_output_types = sorted(schema_output_types - set(definition.output_types))
        if missing_output_types:
            raise ValueError(
                f"AI tool {definition.name} output_types must cover card schema types: "
                f"{', '.join(missing_output_types)}"
            )
        if definition.output_types and not schema_output_types:
            raise ValueError(f"AI tool {definition.name} declares output_types but output_schema has no card type enum")


def _card_output_types_from_schema(schema: dict[str, Any]) -> set[str]:
    card_schema = schema.get("properties", {}).get("card") if isinstance(schema.get("properties"), dict) else None
    if not isinstance(card_schema, dict):
        return set()
    card_properties = card_schema.get("properties")
    if not isinstance(card_properties, dict):
        return set()
    type_schema = card_properties.get("type")
    if not isinstance(type_schema, dict):
        return set()
    enum_values = type_schema.get("enum")
    if not isinstance(enum_values, list):
        return set()
    return {str(item).strip() for item in enum_values if str(item).strip()}


def build_workspace_tool_registry() -> ToolRegistry:
    from app.ai.tools.catalog import (
        register_food_tools,
        register_ingredient_tools,
        register_intent_tools,
        register_inventory_tools,
        register_meal_log_tools,
        register_meal_plan_tools,
        register_recipe_tools,
        register_shopping_tools,
        register_ui_tools,
        register_workspace_tools,
    )

    registry = ToolRegistry()
    register_intent_tools(registry)
    register_ui_tools(registry)
    register_workspace_tools(registry)
    register_ingredient_tools(registry)
    register_inventory_tools(registry)
    register_meal_log_tools(registry)
    register_food_tools(registry)
    register_recipe_tools(registry)
    register_shopping_tools(registry)
    register_meal_plan_tools(registry)
    return registry
