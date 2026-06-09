from __future__ import annotations

from collections.abc import Iterator
from collections.abc import Callable
from dataclasses import dataclass, field
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from app.ai.tools.base import ToolDefinition
from app.core.config import get_settings

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ChatProviderResult:
    text: str | None
    status: str
    model: str
    error: str | None = None
    structured_mode: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


ToolCallHandler = Callable[[str, dict[str, Any]], dict[str, Any]]


class BaseChatProvider:
    model_name: str = ""

    def generate(self, *, system: str, user: str, response_schema: dict[str, Any] | None = None) -> ChatProviderResult:  # pragma: no cover - interface
        raise NotImplementedError

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools: list[ToolDefinition],
        tool_handler: ToolCallHandler,
        response_schema: dict[str, Any] | None = None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del tools, tool_handler, response_schema, max_rounds
        return self.generate(system=system, user=user)

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

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools: list[ToolDefinition],
        tool_handler: ToolCallHandler,
        response_schema: dict[str, Any] | None = None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del system, user, tools, tool_handler, response_schema, max_rounds
        return ChatProviderResult(text=None, status="fallback", model=self.model_name, error="provider unavailable")


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
                logger.warning(
                    "AI provider generate attempt failed model=%s mode=%s schema=%s error=%s",
                    self.model_name,
                    mode,
                    bool(response_schema),
                    exc,
                    exc_info=True,
                )
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
            logger.warning(
                "AI provider returned empty response model=%s mode=%s schema=%s",
                self.model_name,
                mode,
                bool(response_schema),
            )
        return ChatProviderResult(
            text=None,
            status="fallback",
            model=self.model_name,
            error="; ".join(errors) or "empty model response",
        )

    def generate_with_tools(
        self,
        *,
        system: str,
        user: str,
        tools: list[ToolDefinition],
        tool_handler: ToolCallHandler,
        response_schema: dict[str, Any] | None = None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        name_map = {self._model_tool_name(tool.name): tool.name for tool in tools}
        model_tools = [self._tool_definition_to_model_tool(tool) for tool in tools]
        client = self.client.bind_tools(model_tools).bind(temperature=0)
        schema_instruction = ""
        if response_schema:
            schema_instruction = (
                "\n\nFinal response JSON Schema:\n"
                f"{json.dumps(response_schema, ensure_ascii=False, default=str)}"
            )
        messages: list[Any] = [SystemMessage(content=f"{system}{schema_instruction}"), HumanMessage(content=user)]
        requested_calls: list[dict[str, Any]] = []

        for _round in range(max(1, max_rounds)):
            try:
                message = client.invoke(messages)
            except Exception as exc:  # pragma: no cover - network/provider failure
                logger.warning(
                    "AI provider tool-call invoke failed model=%s round=%s tool_count=%s requested_calls=%s error=%s",
                    self.model_name,
                    _round + 1,
                    len(tools),
                    len(requested_calls),
                    exc,
                    exc_info=True,
                )
                return ChatProviderResult(
                    text=None,
                    status="fallback",
                    model=self.model_name,
                    error=str(exc),
                    structured_mode="tool_call",
                    tool_calls=requested_calls,
                )
            messages.append(message)
            tool_calls = list(getattr(message, "tool_calls", None) or [])
            if not tool_calls:
                text = self._content_to_text(message.content).strip()
                return ChatProviderResult(
                    text=text or None,
                    status="completed" if text else "fallback",
                    model=self.model_name,
                    error=None if text else "empty model response",
                    structured_mode="tool_call",
                    tool_calls=requested_calls,
                )
            for call in tool_calls:
                model_name = str(call.get("name") or "")
                name = name_map.get(model_name, model_name)
                args = call.get("args") if isinstance(call.get("args"), dict) else {}
                call_id = str(call.get("id") or f"tool_call_{len(requested_calls) + 1}")
                requested_calls.append({"id": call_id, "name": name, "args": args})
                logger.info(
                    "AI provider requested tool model=%s call_id=%s tool=%s arg_keys=%s",
                    self.model_name,
                    call_id,
                    name,
                    sorted(args.keys()),
                )
                try:
                    output = tool_handler(name, args)
                except Exception as exc:
                    logger.warning(
                        "AI provider tool handler failed model=%s call_id=%s tool=%s error=%s",
                        self.model_name,
                        call_id,
                        name,
                        exc,
                        exc_info=True,
                    )
                    return ChatProviderResult(
                        text=None,
                        status="failed",
                        model=self.model_name,
                        error=str(exc),
                        structured_mode="tool_call",
                        tool_calls=requested_calls,
                    )
                messages.append(ToolMessage(content=json.dumps(output, ensure_ascii=False, default=str), tool_call_id=call_id))

        logger.warning(
            "AI provider tool-call exceeded max rounds model=%s max_rounds=%s requested_calls=%s",
            self.model_name,
            max_rounds,
            len(requested_calls),
        )
        return ChatProviderResult(
            text=None,
            status="failed",
            model=self.model_name,
            error=f"tool conversation exceeded max_rounds={max_rounds}",
            structured_mode="tool_call",
            tool_calls=requested_calls,
        )

    def _tool_definition_to_model_tool(self, definition: ToolDefinition) -> dict[str, Any]:
        description = f"{definition.display_name}: {definition.description} original_name={definition.name} side_effect={definition.side_effect}"
        return {
            "type": "function",
            "function": {
                "name": self._model_tool_name(definition.name),
                "description": description,
                "parameters": definition.input_schema,
            },
        }

    def _model_tool_name(self, name: str) -> str:
        return re.sub(r"[^a-zA-Z0-9_-]", "_", name)[:64]

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
