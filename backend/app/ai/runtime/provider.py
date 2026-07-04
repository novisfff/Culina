from __future__ import annotations

from app.ai.runtime.factory import build_chat_provider
from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.openai_responses import OpenAIResponsesChatProvider
from app.ai.runtime.types import (
    AssistantMessageHandler,
    BaseChatProvider,
    ChatProviderResult,
    DisabledChatProvider,
    ProviderImageInput,
    ProviderUserContent,
    ProviderUserInput,
    ToolCallHandler,
    ToolPreviewHandler,
    ToolProvider,
)
from app.core.config import get_settings


def get_chat_provider() -> BaseChatProvider:
    return build_chat_provider(get_settings())


__all__ = [
    "AssistantMessageHandler",
    "BaseChatProvider",
    "ChatProviderResult",
    "DisabledChatProvider",
    "OpenAICompatibleChatProvider",
    "OpenAIResponsesChatProvider",
    "ProviderImageInput",
    "ProviderUserContent",
    "ProviderUserInput",
    "ToolCallHandler",
    "ToolPreviewHandler",
    "ToolProvider",
    "get_chat_provider",
]
