from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from app.ai.tools.base import ToolDefinition
from app.services.model_usage.types import UsageAttribution


@dataclass(frozen=True, slots=True)
class ProviderControlFlowMetadata:
    """Provider state that must survive an orchestrator control-flow interrupt."""

    model: str | None = None
    fallback_used: bool = False
    fallback_reason_code: str | None = None


_CONTROL_FLOW_METADATA_ATTRIBUTE = "_culina_provider_control_flow"


def _normalized_model_usage_fallback(
    *,
    fallback_used: object,
    fallback_reason_code: object,
) -> tuple[bool, str | None]:
    reason_code = fallback_reason_code.strip() if isinstance(fallback_reason_code, str) else ""
    if fallback_used is not True or not reason_code.startswith("model_usage_"):
        return False, None
    return True, reason_code


def attach_provider_control_flow_metadata(
    exc: BaseException,
    *,
    model: str | None,
    fallback_used: bool,
    fallback_reason_code: str | None,
) -> None:
    normalized_model = model.strip() if isinstance(model, str) and model.strip() else None
    normalized_fallback_used, normalized_reason_code = _normalized_model_usage_fallback(
        fallback_used=fallback_used,
        fallback_reason_code=fallback_reason_code,
    )
    setattr(
        exc,
        _CONTROL_FLOW_METADATA_ATTRIBUTE,
        ProviderControlFlowMetadata(
            model=normalized_model,
            fallback_used=normalized_fallback_used,
            fallback_reason_code=normalized_reason_code,
        ),
    )


def provider_control_flow_metadata(exc: BaseException) -> ProviderControlFlowMetadata:
    payload = getattr(exc, _CONTROL_FLOW_METADATA_ATTRIBUTE, None)
    model = getattr(payload, "model", None)
    fallback_used, fallback_reason_code = _normalized_model_usage_fallback(
        fallback_used=getattr(payload, "fallback_used", False),
        fallback_reason_code=getattr(payload, "fallback_reason_code", None),
    )
    return ProviderControlFlowMetadata(
        model=model.strip() if isinstance(model, str) and model.strip() else None,
        fallback_used=fallback_used,
        fallback_reason_code=fallback_reason_code,
    )


@dataclass(slots=True)
class ChatProviderResult:
    text: str | None
    status: str
    model: str
    error: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    fallback_used: bool = False
    fallback_reason_code: str | None = None


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
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:  # pragma: no cover - interface
        del trace_recorder, trace_request_options, usage_attribution
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
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:
        del tools, tool_handler, message_handler, tool_preview_handler, max_rounds
        return self.generate(
            system=system,
            user=user,
            trace_recorder=trace_recorder,
            usage_attribution=usage_attribution,
        )

    def stream_generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        usage_attribution: UsageAttribution | None = None,
    ) -> Iterator[str]:
        result = self.generate(
            system=system,
            user=user,
            trace_recorder=trace_recorder,
            usage_attribution=usage_attribution,
        )
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
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:
        del trace_recorder, trace_request_options, usage_attribution
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
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:
        del system, user, tools, tool_handler, message_handler, tool_preview_handler, max_rounds, trace_recorder, usage_attribution
        return ChatProviderResult(text=None, status="fallback", model=self.model_name, error="provider unavailable")
