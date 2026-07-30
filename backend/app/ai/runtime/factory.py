from __future__ import annotations

from typing import Any

from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.openai_responses import OpenAIResponsesChatProvider
from app.ai.runtime.types import BaseChatProvider, DisabledChatProvider
from app.db.session import SessionLocal
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring


def _model_usage_adapter(settings: Any, *, provider: str) -> LLMUsageAdapter | None:
    if not bool(getattr(settings, "model_usage_required", False)):
        return None
    signer = decode_receipt_integrity_keyring(settings).signer()
    return LLMUsageAdapter(
        provider=provider,
        usage_facade=ModelUsageFacade(session_factory=SessionLocal),
        session_factory=SessionLocal,
        signer=signer,
    )


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
    max_output_tokens = int(getattr(settings, "ai_max_output_tokens", 1024))
    fallback_model = str(getattr(settings, "ai_fallback_model", "")).strip()
    fallback_max_output_tokens = int(
        getattr(settings, "ai_fallback_max_output_tokens", 0) or 0
    )
    model_usage_required = bool(getattr(settings, "model_usage_required", False))
    if provider_name in {"openai-response", "openai-responses", "responses"}:
        return OpenAIResponsesChatProvider(
            api_base=settings.ai_api_base or "https://api.openai.com/v1",
            api_key=settings.ai_api_key,
            model_name=model_name,
            timeout_seconds=settings.ai_timeout_seconds,
            supports_vision=bool(supports_vision),
            prompt_cache_enabled=prompt_cache_enabled,
            max_output_tokens=max_output_tokens,
            usage_adapter=_model_usage_adapter(settings, provider="openai"),
            model_usage_required=model_usage_required,
            fallback_model=fallback_model,
            fallback_max_output_tokens=fallback_max_output_tokens,
        )
    if provider_name in {"enable", "enabled", "openai", "openai-compatible", "compatible", "custom", "dashscope"}:
        return OpenAICompatibleChatProvider(
            api_base=settings.ai_api_base or "https://api.openai.com/v1",
            api_key=settings.ai_api_key,
            model_name=model_name,
            timeout_seconds=settings.ai_timeout_seconds,
            supports_vision=bool(supports_vision),
            prompt_cache_enabled=prompt_cache_enabled,
            max_output_tokens=max_output_tokens,
            usage_adapter=_model_usage_adapter(settings, provider="openai"),
            model_usage_required=model_usage_required,
            fallback_model=fallback_model,
            fallback_max_output_tokens=fallback_max_output_tokens,
        )
    return DisabledChatProvider(model_name=model_name)
