from __future__ import annotations

import base64
from collections.abc import Callable
from collections.abc import Iterator
from dataclasses import dataclass, field
import inspect
import json
import logging
import re
from typing import Any

from langchain_core.messages import AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from openai import OpenAI

from app.ai.tools.base import ToolDefinition
from app.ai.errors import AIExecutionCancelled, ApprovalRequired, HumanInputRequired
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


ToolCallHandler = Callable[[str, dict[str, Any], str | None], dict[str, Any]]
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
            stream_usage=True,
            max_retries=1,
        )
        self._langchain_client = self.client
        self.openai_client = OpenAI(
            api_key=api_key,
            base_url=api_base.rstrip("/"),
            timeout=timeout_seconds,
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

    def generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        trace_request_options: dict[str, Any] | None = None,
    ) -> ChatProviderResult:
        messages = [SystemMessage(content=system), HumanMessage(content=self._human_content(user))]
        request_options = {"model": self.model_name, "mode": "generate", "supportsVision": self.supports_vision}
        if trace_request_options:
            request_options.update(trace_request_options)
        exchange = (
            trace_recorder.start_exchange(
                span_id=None,
                provider_round=1,
                attempt_index=1,
                mode="generate",
                model=self.model_name,
                request_messages=messages,
                request_tools=[],
                request_options=request_options,
            )
            if trace_recorder is not None
            else None
        )
        try:
            message = self.client.invoke(messages)
            text = self._content_to_text(message.content).strip()
        except AIExecutionCancelled:
            raise
        except Exception as exc:  # pragma: no cover - network/provider failure
            if exchange is not None:
                exchange.fail(error_code="provider_unavailable", error_message=str(exc))
            logger.warning(
                "AI provider generate failed model=%s error=%s",
                self.model_name,
                exc,
                exc_info=True,
            )
            return ChatProviderResult(text=None, status="fallback", model=self.model_name, error=str(exc))
        if text:
            if exchange is not None:
                exchange.finish(response_message=message, response_text=text, status="completed")
            return ChatProviderResult(text=text, status="completed", model=self.model_name)
        logger.warning("AI provider returned empty response model=%s", self.model_name)
        if exchange is not None:
            exchange.finish(
                response_message=message,
                response_text=None,
                status="failed",
                error_code="provider_empty_response",
                error_message="empty model response",
            )
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
        tool_preview_handler: ToolPreviewHandler | None = None,
        max_rounds: int = 8,
        trace_recorder: Any | None = None,
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
            preview_names_by_key: dict[str, str] = {}
            preview_event_ids_by_key: dict[str, str] = {}
            for attempt in range(STREAM_TOOL_CALL_RETRY_COUNT + 1):
                emitted_text_this_attempt = False
                streamed_text_this_attempt: list[str] = []
                stream_token_usage: dict[str, Any] | None = None
                message = None
                exchange = (
                    trace_recorder.start_exchange(
                        span_id=None,
                        provider_round=_round + 1,
                        attempt_index=attempt + 1,
                        mode="stream",
                        model=self.model_name,
                        request_messages=messages,
                        request_tools=model_tools,
                        request_options={
                            "model": self.model_name,
                            "mode": "stream",
                            "roundIndex": _round + 1,
                            "attemptIndex": attempt + 1,
                            "maxRounds": max_rounds,
                            "toolCount": len(current_tools),
                            "supportsVision": self.supports_vision,
                            "temperature": 0,
                            "streamOptions": {"includeUsage": True},
                        },
                    )
                    if trace_recorder is not None
                    else None
                )
                try:
                    for chunk in self._stream_with_usage(client, messages, tools=model_tools, temperature=0):
                        message = chunk if message is None else message + chunk
                        stream_token_usage = self._latest_token_usage(
                            trace_recorder,
                            chunk,
                            stream_token_usage,
                        )
                        self._emit_tool_call_previews(
                            chunk,
                            name_map=name_map,
                            preview_names_by_key=preview_names_by_key,
                            preview_event_ids_by_key=preview_event_ids_by_key,
                            tool_preview_handler=tool_preview_handler,
                        )
                        text = self._content_to_text(getattr(chunk, "content", ""))
                        if text:
                            emitted_text_this_attempt = True
                            streamed_text_this_attempt.append(text)
                            text_parts.append(text)
                            if message_handler is not None:
                                message_handler(text)
                    if message is None:
                        if exchange is not None:
                            exchange.fail(error_code="provider_empty_response", error_message="empty model response")
                        retrying = attempt < STREAM_TOOL_CALL_RETRY_COUNT
                        logger.warning(
                            "AI provider streaming tool-call returned no chunks model=%s round=%s attempt=%s/%s retrying=%s tool_count=%s requested_calls=%s",
                            self.model_name,
                            _round + 1,
                            attempt + 1,
                            STREAM_TOOL_CALL_RETRY_COUNT + 1,
                            retrying,
                            len(current_tools),
                            len(requested_calls),
                        )
                        if retrying:
                            continue
                        self._mark_tool_call_previews_failed(
                            preview_names_by_key=preview_names_by_key,
                            preview_event_ids_by_key=preview_event_ids_by_key,
                            tool_preview_handler=tool_preview_handler,
                        )
                        return ChatProviderResult(
                            text=None,
                            status="failed",
                            model=self.model_name,
                            error="empty model response",
                            tool_calls=requested_calls,
                        )
                    if message is not None:
                        self._emit_unstreamed_message_text(
                            message,
                            streamed_text_parts=streamed_text_this_attempt,
                            text_parts=text_parts,
                            message_handler=message_handler,
                        )
                        if exchange is not None:
                            response_text = "".join(streamed_text_this_attempt).strip() or self._content_to_text(message.content).strip() or None
                            response_tool_calls = self._message_tool_calls(message)
                            exchange.finish(
                                response_message=message,
                                response_text=response_text,
                                response_tool_calls=response_tool_calls,
                                stream_chunks=trace_recorder.stream_chunks_payload(streamed_text_this_attempt),
                                token_usage=stream_token_usage,
                                status="failed" if not response_text and not response_tool_calls else "completed",
                                error_code="provider_empty_response" if not response_text and not response_tool_calls else None,
                                error_message="empty model response" if not response_text and not response_tool_calls else None,
                            )
                        response_text = "".join(streamed_text_this_attempt).strip() or self._content_to_text(message.content).strip()
                        response_tool_calls = self._message_tool_calls(message)
                        if not response_text and not response_tool_calls:
                            retrying = attempt < STREAM_TOOL_CALL_RETRY_COUNT
                            logger.warning(
                                "AI provider streaming tool-call returned empty response model=%s round=%s attempt=%s/%s retrying=%s tool_count=%s requested_calls=%s",
                                self.model_name,
                                _round + 1,
                                attempt + 1,
                                STREAM_TOOL_CALL_RETRY_COUNT + 1,
                                retrying,
                                len(current_tools),
                                len(requested_calls),
                            )
                            if retrying:
                                message = None
                                continue
                            self._mark_tool_call_previews_failed(
                                preview_names_by_key=preview_names_by_key,
                                preview_event_ids_by_key=preview_event_ids_by_key,
                                tool_preview_handler=tool_preview_handler,
                            )
                            return ChatProviderResult(
                                text=None,
                                status="failed",
                                model=self.model_name,
                                error="empty model response",
                                tool_calls=requested_calls,
                            )
                    break
                except AIExecutionCancelled:
                    raise
                except Exception as exc:  # pragma: no cover - network/provider failure
                    if exchange is not None:
                        exchange.fail(error_code="provider_stream_failed", error_message=str(exc), response_message=message)
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
                    self._mark_tool_call_previews_failed(
                        preview_names_by_key=preview_names_by_key,
                        preview_event_ids_by_key=preview_event_ids_by_key,
                        tool_preview_handler=tool_preview_handler,
                    )
                    if not requested_calls:
                        return self._generate_with_tools_blocking(
                            system=system,
                            user=user,
                            tools=tools,
                            tool_handler=tool_handler,
                            message_handler=message_handler,
                            tool_preview_handler=tool_preview_handler,
                            max_rounds=max_rounds,
                            trace_recorder=trace_recorder,
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
                    "AI provider streaming tool-call returned no chunks after retries model=%s round=%s tool_count=%s requested_calls=%s",
                    self.model_name,
                    _round + 1,
                    len(current_tools),
                    len(requested_calls),
                )
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=self.model_name,
                    error="empty model response",
                    tool_calls=requested_calls,
                )
            messages.append(message)
            tool_calls = self._message_tool_calls(message)
            if not tool_calls:
                self._mark_tool_call_previews_failed(
                    preview_names_by_key=preview_names_by_key,
                    preview_event_ids_by_key=preview_event_ids_by_key,
                    tool_preview_handler=tool_preview_handler,
                )
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
                preview_key = str(call.get("_preview_key") or len(requested_calls))
                progress_event_id = preview_event_ids_by_key.get(preview_key)
                requested_calls.append({"id": call_id, "name": name, "args": args})
                logger.info(
                    "AI provider requested tool model=%s call_id=%s tool=%s arg_keys=%s",
                    self.model_name,
                    call_id,
                    name,
                    sorted(args.keys()),
                )
                try:
                    output = self._invoke_tool_handler(tool_handler, name, args, progress_event_id)
                except (AIExecutionCancelled, ApprovalRequired, HumanInputRequired):
                    raise
                except Exception as exc:
                    logger.warning(
                        "AI provider tool handler returned recoverable error model=%s call_id=%s tool=%s error=%s",
                        self.model_name,
                        call_id,
                        name,
                        exc,
                        exc_info=True,
                    )
                    if tool_preview_handler is not None and progress_event_id is None:
                        tool_preview_handler(name, preview_key, "failed")
                    output = self._tool_error_message(name, exc)
                messages.append(
                    ToolMessage(
                        content=json.dumps(output, ensure_ascii=False, default=str),
                        tool_call_id=call_id,
                    )
                )

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
        tool_preview_handler: ToolPreviewHandler | None = None,
        max_rounds: int = 8,
        trace_recorder: Any | None = None,
    ) -> ChatProviderResult:
        del tool_preview_handler
        messages: list[Any] = [SystemMessage(content=system), HumanMessage(content=self._human_content(user))]
        requested_calls: list[dict[str, Any]] = []
        text_parts: list[str] = []

        for _round in range(max(1, max_rounds)):
            current_tools = tools()
            name_map = {self._model_tool_name(tool.name): tool.name for tool in current_tools}
            model_tools = [self._tool_definition_to_model_tool(tool) for tool in current_tools]
            client = self.client.bind_tools(model_tools).bind(temperature=0)
            exchange = (
                trace_recorder.start_exchange(
                    span_id=None,
                    provider_round=_round + 1,
                    attempt_index=1,
                    mode="blocking",
                    model=self.model_name,
                    request_messages=messages,
                    request_tools=model_tools,
                    request_options={
                        "model": self.model_name,
                        "mode": "blocking",
                        "roundIndex": _round + 1,
                        "maxRounds": max_rounds,
                        "toolCount": len(current_tools),
                        "supportsVision": self.supports_vision,
                        "temperature": 0,
                    },
                )
                if trace_recorder is not None
                else None
            )
            message = None
            for attempt in range(STREAM_TOOL_CALL_RETRY_COUNT + 1):
                if attempt:
                    exchange = (
                        trace_recorder.start_exchange(
                            span_id=None,
                            provider_round=_round + 1,
                            attempt_index=attempt + 1,
                            mode="blocking",
                            model=self.model_name,
                            request_messages=messages,
                            request_tools=model_tools,
                            request_options={
                                "model": self.model_name,
                                "mode": "blocking",
                                "roundIndex": _round + 1,
                                "attemptIndex": attempt + 1,
                                "maxRounds": max_rounds,
                                "toolCount": len(current_tools),
                                "supportsVision": self.supports_vision,
                                "temperature": 0,
                            },
                        )
                        if trace_recorder is not None
                        else None
                    )
                try:
                    message = client.invoke(messages)
                except AIExecutionCancelled:
                    raise
                except Exception as exc:  # pragma: no cover - network/provider failure
                    if exchange is not None:
                        exchange.fail(error_code="provider_blocking_failed", error_message=str(exc))
                    logger.warning(
                        "AI provider tool-call invoke failed model=%s round=%s attempt=%s/%s tool_count=%s requested_calls=%s error=%s",
                        self.model_name,
                        _round + 1,
                        attempt + 1,
                        STREAM_TOOL_CALL_RETRY_COUNT + 1,
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
                text = self._content_to_text(getattr(message, "content", ""))
                tool_calls = self._message_tool_calls(message)
                if exchange is not None:
                    exchange.finish(
                        response_message=message,
                        response_text=text.strip() or None,
                        response_tool_calls=tool_calls,
                        status="failed" if not text.strip() and not tool_calls else "completed",
                        error_code="provider_empty_response" if not text.strip() and not tool_calls else None,
                        error_message="empty model response" if not text.strip() and not tool_calls else None,
                    )
                if text.strip() or tool_calls:
                    break
                retrying = attempt < STREAM_TOOL_CALL_RETRY_COUNT
                logger.warning(
                    "AI provider blocking tool-call returned empty response model=%s round=%s attempt=%s/%s retrying=%s tool_count=%s requested_calls=%s",
                    self.model_name,
                    _round + 1,
                    attempt + 1,
                    STREAM_TOOL_CALL_RETRY_COUNT + 1,
                    retrying,
                    len(current_tools),
                    len(requested_calls),
                )
                if not retrying:
                    return ChatProviderResult(
                        text=None,
                        status="failed",
                        model=self.model_name,
                        error="empty model response",
                        tool_calls=requested_calls,
                    )
            messages.append(message)
            text = self._content_to_text(getattr(message, "content", ""))
            tool_calls = self._message_tool_calls(message)
            if text:
                text_parts.append(text)
                if message_handler is not None:
                    message_handler(text)
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
                    output = self._invoke_tool_handler(tool_handler, name, args, None)
                except (AIExecutionCancelled, ApprovalRequired, HumanInputRequired):
                    raise
                except Exception as exc:
                    logger.warning(
                        "AI provider tool handler returned recoverable error model=%s call_id=%s tool=%s error=%s",
                        self.model_name,
                        call_id,
                        name,
                        exc,
                        exc_info=True,
                    )
                    output = self._tool_error_message(name, exc)
                messages.append(ToolMessage(content=json.dumps(output, ensure_ascii=False, default=str), tool_call_id=call_id))

        logger.warning(
            "AI provider tool-call exceeded max rounds model=%s max_rounds=%s requested_calls=%s",
            self.model_name,
            max_rounds,
            len(requested_calls),
        )
        if trace_recorder is not None:
            max_round_exchange = trace_recorder.start_exchange(
                span_id=None,
                provider_round=max(1, max_rounds),
                attempt_index=1,
                mode="blocking",
                model=self.model_name,
                request_messages=messages,
                request_tools=[],
                request_options={"model": self.model_name, "mode": "blocking", "maxRounds": max_rounds},
            )
            max_round_exchange.fail(
                error_code="provider_max_rounds_exceeded",
                error_message=f"tool conversation exceeded max_rounds={max_rounds}",
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
        for index, call in enumerate(tool_calls):
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
                    "_preview_key": str(call.get("index") if call.get("index") is not None else index),
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
                by_index[key] = {"id": "", "name": "", "args": "", "preview_key": key}
            item = by_index[key]
            if chunk.get("id"):
                item["id"] += str(chunk["id"])
            if chunk.get("name"):
                item["name"] += str(chunk["name"])
            if chunk.get("args"):
                item["args"] += str(chunk["args"])
        for item in by_index.values():
            args = self._json_object(item["args"])
            normalized.append(
                {
                    "id": item["id"] or None,
                    "name": item["name"],
                    "args": args if isinstance(args, dict) else {},
                    "_preview_key": item["preview_key"],
                }
            )
        return normalized

    def _emit_unstreamed_message_text(
        self,
        message: Any,
        *,
        streamed_text_parts: list[str],
        text_parts: list[str],
        message_handler: AssistantMessageHandler | None,
    ) -> None:
        final_text = self._content_to_text(getattr(message, "content", ""))
        if not final_text:
            return
        streamed_text = "".join(streamed_text_parts)
        if final_text == streamed_text:
            return
        if not streamed_text:
            delta = final_text
        elif final_text.startswith(streamed_text):
            delta = final_text[len(streamed_text):]
        else:
            return
        if not delta:
            return
        text_parts.append(delta)
        if message_handler is not None:
            message_handler(delta)

    def _emit_tool_call_previews(
        self,
        chunk: Any,
        *,
        name_map: dict[str, str],
        preview_names_by_key: dict[str, str],
        preview_event_ids_by_key: dict[str, str],
        tool_preview_handler: ToolPreviewHandler | None,
    ) -> None:
        if tool_preview_handler is None:
            return
        for key, model_name in self._tool_call_names_from_chunk(chunk).items():
            if key in preview_event_ids_by_key:
                continue
            previous_name = preview_names_by_key.get(key, "")
            if model_name in name_map or not previous_name or model_name.startswith(previous_name):
                candidate_name = model_name
            else:
                candidate_name = f"{previous_name}{model_name}"
            preview_names_by_key[key] = candidate_name
            tool_name = name_map.get(candidate_name)
            if not tool_name:
                continue
            event_id = tool_preview_handler(tool_name, key, "running")
            if event_id:
                preview_names_by_key[key] = tool_name
                preview_event_ids_by_key[key] = event_id

    def _mark_tool_call_previews_failed(
        self,
        *,
        preview_names_by_key: dict[str, str],
        preview_event_ids_by_key: dict[str, str],
        tool_preview_handler: ToolPreviewHandler | None,
    ) -> None:
        if tool_preview_handler is None:
            return
        for key, event_id in preview_event_ids_by_key.items():
            tool_name = preview_names_by_key.get(key)
            if tool_name and event_id:
                tool_preview_handler(tool_name, key, "failed")

    def _invoke_tool_handler(
        self,
        tool_handler: ToolCallHandler,
        name: str,
        args: dict[str, Any],
        progress_event_id: str | None,
    ) -> dict[str, Any]:
        try:
            parameters = inspect.signature(tool_handler).parameters
        except (TypeError, ValueError):
            return tool_handler(name, args, progress_event_id)
        positional = [
            parameter
            for parameter in parameters.values()
            if parameter.kind in {inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD}
        ]
        has_varargs = any(parameter.kind == inspect.Parameter.VAR_POSITIONAL for parameter in parameters.values())
        if has_varargs or len(positional) >= 3:
            return tool_handler(name, args, progress_event_id)
        return tool_handler(name, args)

    def _latest_token_usage(
        self,
        trace_recorder: Any | None,
        chunk: Any,
        previous: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if trace_recorder is None or not hasattr(trace_recorder, "extract_token_usage"):
            return previous
        usage = trace_recorder.extract_token_usage(chunk)
        return usage if usage else previous

    def _stream_with_usage(
        self,
        client: Any,
        messages: list[Any],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
    ) -> Iterator[Any]:
        langchain_client = getattr(self, "_langchain_client", None)
        if langchain_client is not None and self.client is langchain_client and hasattr(self, "openai_client"):
            yield from self._stream_openai_with_usage(messages, tools=tools or [], temperature=temperature)
            return
        try:
            yield from client.stream(
                messages,
                stream_usage=True,
                stream_options={"include_usage": True},
            )
        except TypeError as exc:
            if "stream_usage" not in str(exc) and "stream_options" not in str(exc):
                raise
            yield from client.stream(messages)

    def _stream_openai_with_usage(
        self,
        messages: list[Any],
        *,
        tools: list[dict[str, Any]],
        temperature: float | None,
    ) -> Iterator[AIMessageChunk]:
        request: dict[str, Any] = {
            "model": self.model_name,
            "messages": [self._message_to_openai(message) for message in messages],
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if temperature is not None:
            request["temperature"] = temperature
        if tools:
            request["tools"] = tools
        try:
            stream = self.openai_client.chat.completions.create(**request)
        except TypeError as exc:
            if "stream_options" not in str(exc):
                raise
            request.pop("stream_options", None)
            stream = self.openai_client.chat.completions.create(**request)

        for raw_chunk in stream:
            chunk = raw_chunk.model_dump() if hasattr(raw_chunk, "model_dump") else raw_chunk
            if not isinstance(chunk, dict):
                continue
            usage = chunk.get("usage")
            choices = chunk.get("choices") if isinstance(chunk.get("choices"), list) else []
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta")
                if not isinstance(delta, dict):
                    continue
                content = delta.get("content")
                text = content if isinstance(content, str) else ""
                tool_call_chunks = self._openai_delta_tool_call_chunks(delta)
                if text or tool_call_chunks:
                    yield AIMessageChunk(content=text, tool_call_chunks=tool_call_chunks)
            if isinstance(usage, dict):
                yield AIMessageChunk(content="", response_metadata={"token_usage": usage})

    def _openai_delta_tool_call_chunks(self, delta: dict[str, Any]) -> list[dict[str, Any]]:
        raw_tool_calls = delta.get("tool_calls")
        if not isinstance(raw_tool_calls, list):
            return []
        chunks: list[dict[str, Any]] = []
        for index, item in enumerate(raw_tool_calls):
            if not isinstance(item, dict):
                continue
            function = item.get("function") if isinstance(item.get("function"), dict) else {}
            chunks.append(
                {
                    "name": str(function.get("name") or ""),
                    "args": str(function.get("arguments") or ""),
                    "id": str(item.get("id") or ""),
                    "index": item.get("index") if item.get("index") is not None else index,
                }
            )
        return chunks

    def _message_to_openai(self, message: Any) -> dict[str, Any]:
        if isinstance(message, dict):
            return message
        if isinstance(message, SystemMessage):
            return {"role": "system", "content": getattr(message, "content", "")}
        if isinstance(message, HumanMessage):
            return {"role": "user", "content": getattr(message, "content", "")}
        if isinstance(message, ToolMessage):
            return {
                "role": "tool",
                "content": getattr(message, "content", ""),
                "tool_call_id": getattr(message, "tool_call_id", None),
            }
        tool_calls = self._message_tool_calls(message)
        payload: dict[str, Any] = {
            "role": "assistant",
            "content": self._content_to_text(getattr(message, "content", "")),
        }
        if tool_calls:
            payload["tool_calls"] = [
                {
                    "id": str(call.get("id") or f"tool_call_{index + 1}"),
                    "type": "function",
                    "function": {
                        "name": str(call.get("name") or ""),
                        "arguments": json.dumps(call.get("args") or {}, ensure_ascii=False, default=str),
                    },
                }
                for index, call in enumerate(tool_calls)
            ]
        return payload

    def _tool_error_message(self, name: str, exc: Exception) -> dict[str, Any]:
        return {
            "status": "failed",
            "code": "tool_execution_failed",
            "tool": name,
            "error": str(exc) or exc.__class__.__name__,
            "recoverable": True,
        }

    def _tool_call_names_from_chunk(self, chunk: Any) -> dict[str, str]:
        names: dict[str, str] = {}
        tool_calls = list(getattr(chunk, "tool_calls", None) or [])
        for index, call in enumerate(tool_calls):
            if not isinstance(call, dict):
                continue
            name = str(call.get("name") or "")
            if name:
                names[str(call.get("index") if call.get("index") is not None else index)] = name
        chunks = list(getattr(chunk, "tool_call_chunks", None) or [])
        for index, item in enumerate(chunks):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            if name:
                names[str(item.get("index") if item.get("index") is not None else index)] = name
        return names

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
                "Use arguments.afterApproval only for optional resume instructions after user approval."
            )
            parameters = {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "draft": draft_schema,
                    "afterApproval": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
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
        trace_recorder: Any | None = None,
    ) -> Iterator[str]:
        messages = [SystemMessage(content=system), HumanMessage(content=self._human_content(user))]
        exchange = (
            trace_recorder.start_exchange(
                span_id=None,
                provider_round=1,
                attempt_index=1,
                mode="stream_generate",
                model=self.model_name,
                request_messages=messages,
                request_tools=[],
                request_options={
                    "model": self.model_name,
                    "mode": "stream_generate",
                    "supportsVision": self.supports_vision,
                    "streamOptions": {"includeUsage": True},
                },
            )
            if trace_recorder is not None
            else None
        )
        message = None
        chunks: list[str] = []
        stream_token_usage: dict[str, Any] | None = None
        try:
            for chunk in self._stream_with_usage(self.client, messages, tools=[], temperature=0.5):
                message = chunk if message is None else message + chunk
                stream_token_usage = self._latest_token_usage(trace_recorder, chunk, stream_token_usage)
                text = self._content_to_text(chunk.content)
                if text:
                    chunks.append(text)
                    yield text
        except Exception as exc:  # pragma: no cover - network/provider failure
            if exchange is not None:
                exchange.fail(error_code="provider_stream_failed", error_message=str(exc), response_message=message)
            fallback_options = {
                "fallbackFromMode": "stream_generate",
                "fallbackReason": str(exc),
            }
            if exchange is not None and exchange.exchange is not None:
                fallback_options["fallbackOfExchangeId"] = exchange.exchange.id
            result = self.generate(
                system=system,
                user=user,
                trace_recorder=trace_recorder,
                trace_request_options=fallback_options,
            )
            if result.text:
                yield result.text
            return
        response_text = "".join(chunks).strip() or (self._content_to_text(getattr(message, "content", "")).strip() if message is not None else "")
        if exchange is not None:
            exchange.finish(
                response_message=message or {},
                response_text=response_text or None,
                response_tool_calls=[],
                stream_chunks=trace_recorder.stream_chunks_payload(chunks),
                token_usage=stream_token_usage,
                status="completed" if response_text else "failed",
                error_code=None if response_text else "provider_empty_response",
                error_message=None if response_text else "empty model response",
            )


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
