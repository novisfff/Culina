from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from app.ai.tools.base import ToolDefinition


@dataclass(slots=True)
class ChatProviderResult:
    text: str | None
    status: str
    model: str
    error: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class ProviderImageInput:
    media_id: str
    content_type: str
    payload: bytes
    filename: str = ""


@dataclass(slots=True)
class ProviderUserInput:
    text: str
    images: list[ProviderImageInput] = field(default_factory=list)
    prefix_messages: list[str] = field(default_factory=list)


ToolCallHandler = Callable[..., dict[str, Any]]
AssistantMessageHandler = Callable[[str], None]
ToolPreviewHandler = Callable[[str, str, str], str | None]
ToolProvider = Callable[[], list[ToolDefinition]]
ProviderUserContent = str | ProviderUserInput


class BaseChatProvider:
    model_name: str = ""
    supports_vision: bool = False

    def generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        trace_request_options: dict[str, Any] | None = None,
    ) -> ChatProviderResult:  # pragma: no cover - interface
        del trace_recorder, trace_request_options
        raise NotImplementedError

    def generate_with_tools(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        tools: ToolProvider,
        tool_handler: ToolCallHandler,
        message_handler: AssistantMessageHandler | None = None,
        tool_preview_handler: ToolPreviewHandler | None = None,
        max_rounds: int = 8,
        trace_recorder: Any | None = None,
    ) -> ChatProviderResult:
        del tools, tool_handler, message_handler, tool_preview_handler, max_rounds
        return self.generate(system=system, user=user, trace_recorder=trace_recorder)

    def stream_generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
    ) -> Iterator[str]:
        result = self.generate(system=system, user=user, trace_recorder=trace_recorder)
        if result.text:
            yield result.text


class DisabledChatProvider(BaseChatProvider):
    def __init__(self, model_name: str = "") -> None:
        self.model_name = model_name

    def generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        trace_request_options: dict[str, Any] | None = None,
    ) -> ChatProviderResult:
        del trace_recorder, trace_request_options
        if isinstance(user, ProviderUserInput) and user.images:
            return ChatProviderResult(
                text=None,
                status="fallback",
                model=self.model_name,
                error="provider does not support vision input",
            )
        return ChatProviderResult(text=None, status="fallback", model=self.model_name, error=None)

    def generate_with_tools(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        tools: ToolProvider,
        tool_handler: ToolCallHandler,
        message_handler: AssistantMessageHandler | None = None,
        tool_preview_handler: ToolPreviewHandler | None = None,
        max_rounds: int = 8,
        trace_recorder: Any | None = None,
    ) -> ChatProviderResult:
        del system, user, tools, tool_handler, message_handler, tool_preview_handler, max_rounds, trace_recorder
        return ChatProviderResult(text=None, status="fallback", model=self.model_name, error="provider unavailable")
