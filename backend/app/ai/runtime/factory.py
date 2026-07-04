from __future__ import annotations

from typing import Any

from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.openai_responses import OpenAIResponsesChatProvider
from app.ai.runtime.types import BaseChatProvider, DisabledChatProvider


def build_chat_provider(settings: Any) -> BaseChatProvider:
    provider_name = (settings.ai_provider or "disabled").strip().lower()
    model_name = settings.ai_model or "gpt-4o-mini"
    supports_vision = getattr(settings, "ai_supports_vision", None)
    if supports_vision is None:
        normalized_model = model_name.strip().lower()
        supports_vision = any(
            marker in normalized_model
            for marker in ("gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4", "vision", "qwen-vl", "vl")
        )
    if provider_name in {"", "disabled", "mock"} or not settings.ai_api_key:
        return DisabledChatProvider(model_name=model_name)
    prompt_cache_enabled = bool(getattr(settings, "ai_prompt_cache_enabled", True))
    if provider_name in {"openai-response", "openai-responses", "responses"}:
        return OpenAIResponsesChatProvider(
            api_base=settings.ai_api_base or "https://api.openai.com/v1",
            api_key=settings.ai_api_key,
            model_name=model_name,
            timeout_seconds=settings.ai_timeout_seconds,
            supports_vision=bool(supports_vision),
            prompt_cache_enabled=prompt_cache_enabled,
        )
    if provider_name in {"enable", "enabled", "openai", "openai-compatible", "compatible", "custom", "dashscope"}:
        return OpenAICompatibleChatProvider(
            api_base=settings.ai_api_base or "https://api.openai.com/v1",
            api_key=settings.ai_api_key,
            model_name=model_name,
            timeout_seconds=settings.ai_timeout_seconds,
            supports_vision=bool(supports_vision),
            prompt_cache_enabled=prompt_cache_enabled,
        )
    return DisabledChatProvider(model_name=model_name)
