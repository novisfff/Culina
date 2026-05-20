from __future__ import annotations

from dataclasses import dataclass

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from app.core.config import get_settings


@dataclass(slots=True)
class ChatProviderResult:
    text: str | None
    status: str
    model: str
    error: str | None = None


class BaseChatProvider:
    model_name: str = ""

    def generate(self, *, system: str, user: str) -> ChatProviderResult:  # pragma: no cover - interface
        raise NotImplementedError


class DisabledChatProvider(BaseChatProvider):
    def __init__(self, model_name: str = "") -> None:
        self.model_name = model_name

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        return ChatProviderResult(text=None, status="fallback", model=self.model_name, error=None)


class OpenAICompatibleChatProvider(BaseChatProvider):
    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        model_name: str,
        timeout_seconds: float = 20.0,
    ) -> None:
        self.model_name = model_name
        self.client = ChatOpenAI(
            model=model_name,
            api_key=api_key,
            base_url=api_base.rstrip("/"),
            timeout=timeout_seconds,
            temperature=0.5,
            max_retries=1,
        )

    def generate(self, *, system: str, user: str) -> ChatProviderResult:
        try:
            message = self.client.invoke([SystemMessage(content=system), HumanMessage(content=user)])
            content = message.content
            if isinstance(content, list):
                text = "".join(
                    part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)
                )
            else:
                text = str(content or "")
            text = text.strip()
            if not text:
                return ChatProviderResult(text=None, status="fallback", model=self.model_name, error="empty model response")
            return ChatProviderResult(text=text, status="completed", model=self.model_name)
        except Exception as exc:  # pragma: no cover - network/provider failure
            return ChatProviderResult(text=None, status="fallback", model=self.model_name, error=str(exc))


def get_chat_provider() -> BaseChatProvider:
    settings = get_settings()
    provider_name = (settings.ai_provider or "disabled").strip().lower()
    model_name = settings.ai_model or "gpt-4o-mini"
    if provider_name in {"", "disabled", "mock"} or not settings.ai_api_key:
        return DisabledChatProvider(model_name=model_name)
    if provider_name in {"enable", "enabled", "openai", "openai-compatible", "compatible", "custom", "dashscope"}:
        return OpenAICompatibleChatProvider(
            api_base=settings.ai_api_base or "https://api.openai.com/v1",
            api_key=settings.ai_api_key,
            model_name=model_name,
            timeout_seconds=settings.ai_timeout_seconds,
        )
    return DisabledChatProvider(model_name=model_name)
