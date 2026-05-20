from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from app.core.enums import AiMode

AgentRunStatus = Literal["completed", "fallback", "failed"]


@dataclass(slots=True)
class AgentRunRequest:
    family_id: str
    user_id: str
    agent_key: str = "kitchen_assistant"
    feature_key: str = "ai_query"
    prompt: str = ""
    mode: AiMode | None = None
    subject: dict[str, Any] = field(default_factory=dict)
    response_format: str = "text"
    persist_conversation: bool = True


@dataclass(slots=True)
class AgentToolCall:
    name: str
    input: dict[str, Any] = field(default_factory=dict)
    output: Any = None
    status: str = "completed"
    error: str | None = None

    def to_record(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "input": self.input,
            "output": self.output,
            "status": self.status,
            "error": self.error,
        }


@dataclass(slots=True)
class AgentRunResult:
    text: str
    data: dict[str, Any]
    conversation: dict | None
    recommendation: dict | None
    run_id: str
    status: AgentRunStatus
    error: str | None = None


class AgentState(TypedDict, total=False):
    request: AgentRunRequest
    context: Any
    recommendation_model: Any
    recipe_draft: dict[str, Any] | None
    data: dict[str, Any]
    tool_calls: list[AgentToolCall]
    text: str
    status: AgentRunStatus
    error: str | None
    model: str
