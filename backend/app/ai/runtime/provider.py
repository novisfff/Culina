from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Iterator
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from app.core.config import get_settings


@dataclass(slots=True)
class ChatProviderResult:
    text: str | None
    status: str
    model: str
    error: str | None = None
    structured_mode: str | None = None


class BaseChatProvider:
    model_name: str = ""

    def generate(self, *, system: str, user: str, response_schema: dict[str, Any] | None = None) -> ChatProviderResult:  # pragma: no cover - interface
        raise NotImplementedError

    def stream_generate(
        self,
        *,
        system: str,
        user: str,
        response_schema: dict[str, Any] | None = None,
    ) -> Iterator[str]:
        result = self.generate(system=system, user=user, response_schema=response_schema)
        if result.text:
            yield result.text


class DisabledChatProvider(BaseChatProvider):
    def __init__(self, model_name: str = "") -> None:
        self.model_name = model_name

    def generate(self, *, system: str, user: str, response_schema: dict[str, Any] | None = None) -> ChatProviderResult:
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

    def _content_to_text(self, content: Any) -> str:
        if isinstance(content, list):
            return "".join(
                part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)
            )
        return str(content or "")

    def generate(self, *, system: str, user: str, response_schema: dict[str, Any] | None = None) -> ChatProviderResult:
        def invoke(client) -> str:
            message = client.invoke([SystemMessage(content=system), HumanMessage(content=user)])
            return self._content_to_text(message.content).strip()

        attempts: list[tuple[str, Any]] = []
        if response_schema:
            attempts.extend(
                [
                    (
                        "json_schema",
                        self.client.bind(
                            temperature=0,
                            response_format={
                                "type": "json_schema",
                                "json_schema": {
                                    "name": "culina_structured_response",
                                    "schema": response_schema,
                                    "strict": True,
                                },
                            },
                        ),
                    ),
                    (
                        "json_object",
                        self.client.bind(
                            temperature=0,
                            response_format={"type": "json_object"},
                        ),
                    ),
                ]
            )
        attempts.append(("text", self.client.bind(temperature=0) if response_schema else self.client))

        errors: list[str] = []
        for mode, client in attempts:
            try:
                text = invoke(client)
            except Exception as exc:  # pragma: no cover - network/provider failure
                errors.append(f"{mode}: {exc}")
                continue
            if text:
                return ChatProviderResult(
                    text=text,
                    status="completed",
                    model=self.model_name,
                    structured_mode=mode,
                )
            errors.append(f"{mode}: empty model response")
        return ChatProviderResult(
            text=None,
            status="fallback",
            model=self.model_name,
            error="; ".join(errors) or "empty model response",
        )

    def stream_generate(
        self,
        *,
        system: str,
        user: str,
        response_schema: dict[str, Any] | None = None,
    ) -> Iterator[str]:
        if response_schema:
            yield from super().stream_generate(system=system, user=user, response_schema=response_schema)
            return
        try:
            for chunk in self.client.stream([SystemMessage(content=system), HumanMessage(content=user)]):
                text = self._content_to_text(chunk.content)
                if text:
                    yield text
        except Exception:  # pragma: no cover - network/provider failure
            result = self.generate(system=system, user=user)
            if result.text:
                yield result.text


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
