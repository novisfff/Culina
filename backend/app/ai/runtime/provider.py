from __future__ import annotations

import base64
from collections.abc import Callable
from collections.abc import Iterator
from dataclasses import dataclass, field
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from app.ai.tools.base import ToolDefinition
from app.ai.errors import AIExecutionCancelled, HumanInputRequired
from app.core.config import get_settings

logger = logging.getLogger(__name__)
STREAM_TOOL_CALL_RETRY_COUNT = 3


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


ToolCallHandler = Callable[[str, dict[str, Any]], dict[str, Any]]
AssistantMessageHandler = Callable[[str], None]
ToolProvider = Callable[[], list[ToolDefinition]]
ProviderUserContent = str | ProviderUserInput


class BaseChatProvider:
    model_name: str = ""
    supports_vision: bool = False

    def generate(self, *, system: str, user: ProviderUserContent) -> ChatProviderResult:  # pragma: no cover - interface
        raise NotImplementedError

    def generate_with_tools(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        tools: ToolProvider,
        tool_handler: ToolCallHandler,
        message_handler: AssistantMessageHandler | None = None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del tools, tool_handler, message_handler, max_rounds
        return self.generate(system=system, user=user)

    def stream_generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
    ) -> Iterator[str]:
        result = self.generate(system=system, user=user)
        if result.text:
            yield result.text


class DisabledChatProvider(BaseChatProvider):
    def __init__(self, model_name: str = "") -> None:
        self.model_name = model_name

    def generate(self, *, system: str, user: ProviderUserContent) -> ChatProviderResult:
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
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        del system, user, tools, tool_handler, message_handler, max_rounds
        return ChatProviderResult(text=None, status="fallback", model=self.model_name, error="provider unavailable")


class OpenAICompatibleChatProvider(BaseChatProvider):
    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        model_name: str,
        timeout_seconds: float = 20.0,
        supports_vision: bool = False,
    ) -> None:
        self.model_name = model_name
        self.supports_vision = supports_vision
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

    def _human_content(self, user: ProviderUserContent) -> str | list[dict[str, Any]]:
        if isinstance(user, str):
            return user
        if user.images and not self.supports_vision:
            raise ValueError("当前 AI 模型暂不支持图片识别，请切换支持视觉输入的模型后再试。")
        content: list[dict[str, Any]] = [{"type": "text", "text": user.text}]
        for image in user.images:
            encoded = base64.b64encode(image.payload).decode("ascii")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{image.content_type};base64,{encoded}",
                    },
                }
            )
        return content

    def generate(self, *, system: str, user: ProviderUserContent) -> ChatProviderResult:
        try:
            message = self.client.invoke([SystemMessage(content=system), HumanMessage(content=self._human_content(user))])
            text = self._content_to_text(message.content).strip()
        except AIExecutionCancelled:
            raise
        except Exception as exc:  # pragma: no cover - network/provider failure
            logger.warning(
                "AI provider generate failed model=%s error=%s",
                self.model_name,
                exc,
                exc_info=True,
            )
            return ChatProviderResult(text=None, status="fallback", model=self.model_name, error=str(exc))
        if text:
            return ChatProviderResult(text=text, status="completed", model=self.model_name)
        logger.warning("AI provider returned empty response model=%s", self.model_name)
        return ChatProviderResult(
            text=None,
            status="fallback",
            model=self.model_name,
            error="empty model response",
        )

    def generate_with_tools(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        tools: ToolProvider,
        tool_handler: ToolCallHandler,
        message_handler: AssistantMessageHandler | None = None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        messages: list[Any] = [SystemMessage(content=system), HumanMessage(content=self._human_content(user))]
        requested_calls: list[dict[str, Any]] = []
        text_parts: list[str] = []

        for _round in range(max(1, max_rounds)):
            current_tools = tools()
            name_map = {self._model_tool_name(tool.name): tool.name for tool in current_tools}
            model_tools = [self._tool_definition_to_model_tool(tool) for tool in current_tools]
            client = self.client.bind_tools(model_tools).bind(temperature=0)
            message = None
            for attempt in range(STREAM_TOOL_CALL_RETRY_COUNT + 1):
                emitted_text_this_attempt = False
                message = None
                try:
                    for chunk in client.stream(messages):
                        message = chunk if message is None else message + chunk
                        text = self._content_to_text(getattr(chunk, "content", ""))
                        if text:
                            emitted_text_this_attempt = True
                            text_parts.append(text)
                            if message_handler is not None:
                                message_handler(text)
                    break
                except AIExecutionCancelled:
                    raise
                except Exception as exc:  # pragma: no cover - network/provider failure
                    retrying = attempt < STREAM_TOOL_CALL_RETRY_COUNT and not emitted_text_this_attempt
                    logger.warning(
                        "AI provider streaming tool-call invoke failed model=%s round=%s attempt=%s/%s retrying=%s tool_count=%s requested_calls=%s error=%s",
                        self.model_name,
                        _round + 1,
                        attempt + 1,
                        STREAM_TOOL_CALL_RETRY_COUNT + 1,
                        retrying,
                        len(current_tools),
                        len(requested_calls),
                        exc,
                        exc_info=True,
                    )
                    if retrying:
                        continue
                    if not requested_calls:
                        return self._generate_with_tools_blocking(
                            system=system,
                            user=user,
                            tools=tools,
                            tool_handler=tool_handler,
                            message_handler=message_handler,
                            max_rounds=max_rounds,
                        )
                    return ChatProviderResult(
                        text=None,
                        status="failed",
                        model=self.model_name,
                        error=str(exc),
                        tool_calls=requested_calls,
                    )
            if message is None:
                logger.warning(
                    "AI provider streaming tool-call returned no chunks model=%s round=%s tool_count=%s requested_calls=%s",
                    self.model_name,
                    _round + 1,
                    len(current_tools),
                    len(requested_calls),
                )
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=self.model_name,
                    error="empty model stream",
                    tool_calls=requested_calls,
                )
            messages.append(message)
            tool_calls = self._message_tool_calls(message)
            if not tool_calls:
                text = "".join(text_parts).strip() or self._content_to_text(message.content).strip()
                return ChatProviderResult(
                    text=text or None,
                    status="completed",
                    model=self.model_name,
                    error=None,
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
                except (AIExecutionCancelled, HumanInputRequired):
                    raise
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
                        tool_calls=requested_calls,
                    )
                stop_loop = output.pop("__tool_loop_stop__", None) if isinstance(output, dict) else None
                if isinstance(stop_loop, dict):
                    return ChatProviderResult(
                        text="".join(text_parts).strip() or None,
                        status=str(stop_loop.get("status") or "completed"),
                        model=self.model_name,
                        error=None,
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
            tool_calls=requested_calls,
        )

    def _generate_with_tools_blocking(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        tools: ToolProvider,
        tool_handler: ToolCallHandler,
        message_handler: AssistantMessageHandler | None = None,
        max_rounds: int = 8,
    ) -> ChatProviderResult:
        messages: list[Any] = [SystemMessage(content=system), HumanMessage(content=self._human_content(user))]
        requested_calls: list[dict[str, Any]] = []
        text_parts: list[str] = []

        for _round in range(max(1, max_rounds)):
            current_tools = tools()
            name_map = {self._model_tool_name(tool.name): tool.name for tool in current_tools}
            model_tools = [self._tool_definition_to_model_tool(tool) for tool in current_tools]
            client = self.client.bind_tools(model_tools).bind(temperature=0)
            try:
                message = client.invoke(messages)
            except AIExecutionCancelled:
                raise
            except Exception as exc:  # pragma: no cover - network/provider failure
                logger.warning(
                    "AI provider tool-call invoke failed model=%s round=%s tool_count=%s requested_calls=%s error=%s",
                    self.model_name,
                    _round + 1,
                    len(current_tools),
                    len(requested_calls),
                    exc,
                    exc_info=True,
                )
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=self.model_name,
                    error=str(exc),
                    tool_calls=requested_calls,
                )
            messages.append(message)
            text = self._content_to_text(getattr(message, "content", ""))
            if text:
                text_parts.append(text)
                if message_handler is not None:
                    message_handler(text)
            tool_calls = self._message_tool_calls(message)
            if not tool_calls:
                text = "".join(text_parts).strip()
                return ChatProviderResult(
                    text=text or None,
                    status="completed",
                    model=self.model_name,
                    error=None,
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
                except (AIExecutionCancelled, HumanInputRequired):
                    raise
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
                        tool_calls=requested_calls,
                    )
                stop_loop = output.pop("__tool_loop_stop__", None) if isinstance(output, dict) else None
                if isinstance(stop_loop, dict):
                    return ChatProviderResult(
                        text="".join(text_parts).strip() or None,
                        status=str(stop_loop.get("status") or "completed"),
                        model=self.model_name,
                        error=None,
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
            tool_calls=requested_calls,
        )

    def _message_tool_calls(self, message: Any) -> list[dict[str, Any]]:
        tool_calls = list(getattr(message, "tool_calls", None) or [])
        normalized: list[dict[str, Any]] = []
        for call in tool_calls:
            if not isinstance(call, dict):
                continue
            args = call.get("args")
            if isinstance(args, str):
                parsed_args = self._json_object(args)
                args = parsed_args if isinstance(parsed_args, dict) else {}
            normalized.append(
                {
                    "id": call.get("id"),
                    "name": call.get("name"),
                    "args": args if isinstance(args, dict) else {},
                }
            )
        if normalized:
            return normalized

        chunks = list(getattr(message, "tool_call_chunks", None) or [])
        by_index: dict[str, dict[str, str]] = {}
        for index, chunk in enumerate(chunks):
            if not isinstance(chunk, dict):
                continue
            key = str(chunk.get("index") if chunk.get("index") is not None else index)
            if key not in by_index:
                by_index[key] = {"id": "", "name": "", "args": ""}
            item = by_index[key]
            if chunk.get("id"):
                item["id"] += str(chunk["id"])
            if chunk.get("name"):
                item["name"] += str(chunk["name"])
            if chunk.get("args"):
                item["args"] += str(chunk["args"])
        for item in by_index.values():
            args = self._json_object(item["args"])
            normalized.append({"id": item["id"] or None, "name": item["name"], "args": args if isinstance(args, dict) else {}})
        return normalized

    def _json_object(self, text: str) -> dict[str, Any] | None:
        try:
            parsed = json.loads(text)
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None

    def _tool_definition_to_model_tool(self, definition: ToolDefinition) -> dict[str, Any]:
        description = f"{definition.display_name}: {definition.description} original_name={definition.name} side_effect={definition.side_effect}"
        parameters = definition.input_schema
        if definition.side_effect == "draft":
            draft_schema = definition.input_schema
            if isinstance(definition.input_schema.get("properties"), dict) and isinstance(
                definition.input_schema["properties"].get("draft"),
                dict,
            ):
                draft_schema = definition.input_schema["properties"]["draft"]
            description = (
                f"{description}. Use arguments.draft for the business draft payload. "
                "Use arguments.afterApproval only for internal continuation instructions after user approval."
            )
            parameters = {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "draft": draft_schema,
                    "afterApproval": {
                        "type": "object",
                        "additionalProperties": True,
                        "properties": {
                            "continue": {"type": "boolean"},
                            "instruction": {"type": "string"},
                            "nextDraftType": {"type": "string"},
                            "taskState": {"type": "object"},
                        },
                    },
                },
                "required": ["draft"],
            }
        return {
            "type": "function",
            "function": {
                "name": self._model_tool_name(definition.name),
                "description": description,
                "parameters": parameters,
            },
        }

    def _model_tool_name(self, name: str) -> str:
        return re.sub(r"[^a-zA-Z0-9_-]", "_", name)[:64]

    def stream_generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
    ) -> Iterator[str]:
        try:
            for chunk in self.client.stream([SystemMessage(content=system), HumanMessage(content=self._human_content(user))]):
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
    supports_vision = getattr(settings, "ai_supports_vision", None)
    if supports_vision is None:
        normalized_model = model_name.strip().lower()
        supports_vision = any(
            marker in normalized_model
            for marker in ("gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4", "vision", "qwen-vl", "vl")
        )
    if provider_name in {"", "disabled", "mock"} or not settings.ai_api_key:
        return DisabledChatProvider(model_name=model_name)
    if provider_name in {"enable", "enabled", "openai", "openai-compatible", "compatible", "custom", "dashscope"}:
        return OpenAICompatibleChatProvider(
            api_base=settings.ai_api_base or "https://api.openai.com/v1",
            api_key=settings.ai_api_key,
            model_name=model_name,
            timeout_seconds=settings.ai_timeout_seconds,
            supports_vision=bool(supports_vision),
        )
    return DisabledChatProvider(model_name=model_name)
