from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal


@dataclass(slots=True)
class AgentDefinition:
    key: str
    name: str
    description: str
    supported_intents: list[str]
    output_schema: Any
    handler: Callable[..., Any]
    requires_confirmation: bool = False


@dataclass(slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict
    output_schema: dict
    permission: str
    side_effect: Literal["read", "draft", "operation"]
    requires_confirmation: bool = False


class AgentRegistry:
    def __init__(self) -> None:
        self._agents: dict[str, AgentDefinition] = {}

    def register(self, definition: AgentDefinition) -> None:
        self._agents[definition.key] = definition

    def get(self, key: str) -> AgentDefinition:
        return self._agents[key]

    def find_for_intent(self, intent: str) -> AgentDefinition | None:
        for definition in self._agents.values():
            if intent in definition.supported_intents:
                return definition
        return None

    def list(self) -> list[AgentDefinition]:
        return list(self._agents.values())


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolDefinition] = {}

    def register(self, definition: ToolDefinition) -> None:
        self._tools[definition.name] = definition

    def get(self, name: str) -> ToolDefinition:
        return self._tools[name]

    def list(self) -> list[ToolDefinition]:
        return list(self._tools.values())
