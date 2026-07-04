from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
from collections.abc import Iterator
from typing import Any

from openai import OpenAI

from app.ai.errors import AIExecutionCancelled, ApprovalRequired, HumanInputRequired
from app.ai.runtime.messages import field_value, openai_chat_content, openai_chat_messages
from app.ai.runtime.prompt_cache import (
    create_stream_with_unsupported_param_fallback,
    prompt_cache_api_params,
    prompt_cache_request_options,
)
from app.ai.runtime.tooling import (
    chat_tool_definition_to_model_tool,
    invoke_tool_handler,
    json_object,
    model_tool_name,
    tool_error_message,
)
from app.ai.runtime.types import (
    AssistantMessageHandler,
    BaseChatProvider,
    ChatProviderResult,
    ProviderUserContent,
    ProviderUserInput,
    ToolCallHandler,
    ToolPreviewHandler,
    ToolProvider,
)
from app.ai.tools.base import ToolDefinition

logger = logging.getLogger(__name__)
STREAM_TOOL_CALL_RETRY_COUNT = 3


@dataclass(slots=True)
class _ChatStreamResult:
    text: str
    chunks: list[str] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    token_usage: dict[str, Any] | None = None


class OpenAICompatibleChatProvider(BaseChatProvider):
    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        model_name: str,
        timeout_seconds: float = 20.0,
        supports_vision: bool = False,
        prompt_cache_enabled: bool | None = None,
    ) -> None:
        self.model_name = model_name
        self.supports_vision = supports_vision
        self.prompt_cache_enabled = True if prompt_cache_enabled is None else prompt_cache_enabled
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
        return openai_chat_content(user, supports_vision=self.supports_vision)

    def _request_openai_messages(self, system: str, user: ProviderUserContent) -> list[dict[str, Any]]:
        return openai_chat_messages(system, user, supports_vision=self.supports_vision)

    def _prefix_request_options(self, user: ProviderUserContent) -> dict[str, Any]:
        if not isinstance(user, ProviderUserInput):
            return {"prefixMessageCount": 0, "stablePrefixChars": 0, "runtimePayloadChars": len(user)}
        prefix_messages = [message for message in user.prefix_messages if isinstance(message, str) and message]
        return {
            "prefixMessageCount": len(prefix_messages),
            "stablePrefixChars": sum(len(message) for message in prefix_messages),
            "runtimePayloadChars": len(user.text),
        }

    def _prompt_cache_request_options(
        self,
        *,
        provider_protocol: str,
        system: str,
        user: ProviderUserContent,
        model_tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return prompt_cache_request_options(
            model_name=self.model_name,
            prompt_cache_enabled=bool(getattr(self, "prompt_cache_enabled", True)),
            provider_protocol=provider_protocol,
            system=system,
            user=user,
            model_tools=model_tools,
        )

    def _chat_completions_cache_request_options(
        self,
        system: str,
        user: ProviderUserContent,
        model_tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return self._prompt_cache_request_options(
            provider_protocol="chat_completions",
            system=system,
            user=user,
            model_tools=model_tools,
        )

    def _prompt_cache_api_params(self, request_options: dict[str, Any]) -> dict[str, Any]:
        return prompt_cache_api_params(request_options)

    def generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        trace_request_options: dict[str, Any] | None = None,
    ) -> ChatProviderResult:
        messages = self._request_openai_messages(system, user)
        cache_options = self._chat_completions_cache_request_options(system, user, [])
        request_options = {
            "model": self.model_name,
            "mode": "generate",
            "supportsVision": self.supports_vision,
            **self._prefix_request_options(user),
            **cache_options,
        }
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
            response = self._create_chat_completion(
                messages,
                temperature=0.5,
                prompt_cache_options=cache_options,
            )
            message = self._completion_message(response)
            text = self._content_to_text(field_value(message, "content")).strip()
        except AIExecutionCancelled:
            raise
        except Exception as exc:  # pragma: no cover - network/provider failure
            if exchange is not None:
                exchange.fail(error_code="provider_unavailable", error_message=str(exc))
            logger.warning("AI provider generate failed model=%s error=%s", self.model_name, exc, exc_info=True)
            return ChatProviderResult(text=None, status="fallback", model=self.model_name, error=str(exc))
        if text:
            if exchange is not None:
                token_usage = self._completion_token_usage(trace_recorder, response)
                exchange.finish(
                    response_message=message,
                    response_text=text,
                    token_usage=token_usage,
                    status="completed",
                )
            return ChatProviderResult(text=text, status="completed", model=self.model_name)
        logger.warning("AI provider returned empty response model=%s", self.model_name)
        if exchange is not None:
            token_usage = self._completion_token_usage(trace_recorder, response)
            exchange.finish(
                response_message=message,
                response_text=None,
                token_usage=token_usage,
                status="failed",
                error_code="provider_empty_response",
                error_message="empty model response",
            )
        return ChatProviderResult(text=None, status="fallback", model=self.model_name, error="empty model response")

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
        messages = self._request_openai_messages(system, user)
        requested_calls: list[dict[str, Any]] = []
        text_parts: list[str] = []

        for _round in range(max(1, max_rounds)):
            current_tools = tools()
            name_map = {self._model_tool_name(tool.name): tool.name for tool in current_tools}
            model_tools = [self._tool_definition_to_model_tool(tool) for tool in current_tools]
            cache_options = self._chat_completions_cache_request_options(system, user, model_tools)
            response = None
            exchange = None
            for attempt in range(STREAM_TOOL_CALL_RETRY_COUNT + 1):
                streamed_text_this_attempt: list[str] = []
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
                            **self._prefix_request_options(user),
                            **cache_options,
                        },
                    )
                    if trace_recorder is not None
                    else None
                )
                try:
                    response = self._collect_stream_response(
                        self._create_chat_completion_stream(
                            messages,
                            tools=model_tools,
                            temperature=0,
                            prompt_cache_options=cache_options,
                        ),
                        message_handler=message_handler,
                        streamed_text_parts=streamed_text_this_attempt,
                    )
                except AIExecutionCancelled:
                    raise
                except Exception as exc:  # pragma: no cover - network/provider failure
                    if exchange is not None:
                        exchange.fail(error_code="provider_stream_failed", error_message=str(exc), response_message={})
                    retrying = attempt < STREAM_TOOL_CALL_RETRY_COUNT and not streamed_text_this_attempt
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
                    return ChatProviderResult(
                        text=None,
                        status="failed",
                        model=self.model_name,
                        error=str(exc),
                        tool_calls=requested_calls,
                    )
                if exchange is not None:
                    token_usage = (
                        trace_recorder.extract_token_usage({"usage": response.token_usage})
                        if trace_recorder is not None and response.token_usage is not None
                        else None
                    )
                    exchange.finish(
                        response_message=self._assistant_message(response),
                        response_text=response.text.strip() or None,
                        response_tool_calls=response.tool_calls,
                        stream_chunks=trace_recorder.stream_chunks_payload(response.chunks),
                        token_usage=token_usage,
                        status="failed" if not response.text.strip() and not response.tool_calls else "completed",
                        error_code="provider_empty_response" if not response.text.strip() and not response.tool_calls else None,
                        error_message="empty model response" if not response.text.strip() and not response.tool_calls else None,
                    )
                if response.text.strip() or response.tool_calls:
                    break
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
                if not retrying:
                    return ChatProviderResult(
                        text=None,
                        status="failed",
                        model=self.model_name,
                        error="empty model response",
                        tool_calls=requested_calls,
                    )
            if response is None:
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=self.model_name,
                    error="empty model response",
                    tool_calls=requested_calls,
                )
            if response.text:
                text_parts.append(response.text)
            messages.append(self._assistant_message(response))
            if not response.tool_calls:
                return ChatProviderResult(
                    text="".join(text_parts).strip() or None,
                    status="completed",
                    model=self.model_name,
                    error=None,
                    tool_calls=requested_calls,
                )
            for index, call in enumerate(response.tool_calls):
                model_name = str(call.get("name") or "")
                name = name_map.get(model_name, model_name)
                args = call.get("args") if isinstance(call.get("args"), dict) else {}
                call_id = str(call.get("id") or f"tool_call_{len(requested_calls) + 1}")
                preview_key = str(index)
                progress_event_id = (
                    tool_preview_handler(name, preview_key, "running") if tool_preview_handler is not None else None
                )
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
                    output = self._tool_error_message(name, exc)
                    if tool_preview_handler is not None and progress_event_id is None:
                        tool_preview_handler(name, preview_key, "failed")
                messages.append(
                    {
                        "role": "tool",
                        "content": json.dumps(output, ensure_ascii=False, default=str),
                        "tool_call_id": call_id,
                    }
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

    def _create_chat_completion_stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]],
        temperature: float | None,
        prompt_cache_options: dict[str, Any],
    ) -> Any:
        request: dict[str, Any] = {
            "model": self.model_name,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
            **self._prompt_cache_api_params(prompt_cache_options),
        }
        if temperature is not None:
            request["temperature"] = temperature
        if tools:
            request["tools"] = tools
        return create_stream_with_unsupported_param_fallback(self.openai_client.chat.completions.create, request)

    def _create_chat_completion(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None,
        prompt_cache_options: dict[str, Any],
    ) -> Any:
        request: dict[str, Any] = {
            "model": self.model_name,
            "messages": messages,
            **self._prompt_cache_api_params(prompt_cache_options),
        }
        if temperature is not None:
            request["temperature"] = temperature
        return create_stream_with_unsupported_param_fallback(self.openai_client.chat.completions.create, request)

    def _completion_message(self, response: Any) -> dict[str, Any]:
        choices = field_value(response, "choices")
        if not isinstance(choices, list) or not choices:
            return {"role": "assistant", "content": ""}
        message = field_value(choices[0], "message")
        if isinstance(message, dict):
            return message
        return {
            "role": str(field_value(message, "role") or "assistant"),
            "content": field_value(message, "content") or "",
        }

    def _completion_token_usage(self, trace_recorder: Any | None, response: Any) -> dict[str, Any] | None:
        if trace_recorder is None or not hasattr(trace_recorder, "extract_token_usage"):
            return None
        usage = field_value(response, "usage")
        if usage is None:
            return None
        token_usage = trace_recorder.extract_token_usage({"usage": usage})
        return token_usage or None

    def _collect_stream_response(
        self,
        stream: Any,
        *,
        message_handler: AssistantMessageHandler | None,
        streamed_text_parts: list[str] | None = None,
    ) -> _ChatStreamResult:
        chunks = streamed_text_parts if streamed_text_parts is not None else []
        tool_chunks: dict[str, dict[str, str]] = {}
        token_usage: dict[str, Any] | None = None
        for raw_chunk in stream:
            chunk = raw_chunk.model_dump() if hasattr(raw_chunk, "model_dump") else raw_chunk
            if not isinstance(chunk, dict):
                continue
            usage = chunk.get("usage")
            if isinstance(usage, dict):
                token_usage = usage
            choices = chunk.get("choices") if isinstance(chunk.get("choices"), list) else []
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta")
                if not isinstance(delta, dict):
                    continue
                content = delta.get("content")
                if isinstance(content, str) and content:
                    chunks.append(content)
                    if message_handler is not None:
                        message_handler(content)
                for item in delta.get("tool_calls") if isinstance(delta.get("tool_calls"), list) else []:
                    if not isinstance(item, dict):
                        continue
                    index = str(item.get("index") if item.get("index") is not None else len(tool_chunks))
                    current = tool_chunks.setdefault(index, {"id": "", "name": "", "args": ""})
                    if item.get("id"):
                        current["id"] += str(item["id"])
                    function = item.get("function") if isinstance(item.get("function"), dict) else {}
                    if function.get("name"):
                        current["name"] += str(function["name"])
                    if function.get("arguments"):
                        current["args"] += str(function["arguments"])
        return _ChatStreamResult(
            text="".join(chunks),
            chunks=list(chunks),
            tool_calls=self._tool_calls_from_chunks(tool_chunks),
            token_usage=token_usage,
        )

    def _tool_calls_from_chunks(self, tool_chunks: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
        calls: list[dict[str, Any]] = []
        for index in sorted(tool_chunks, key=lambda value: int(value) if value.isdigit() else value):
            item = tool_chunks[index]
            args = json_object(item["args"])
            calls.append(
                {
                    "id": item["id"] or None,
                    "name": item["name"],
                    "args": args if isinstance(args, dict) else {},
                }
            )
        return calls

    def _assistant_message(self, response: _ChatStreamResult) -> dict[str, Any]:
        message: dict[str, Any] = {
            "role": "assistant",
            "content": response.text or "",
        }
        if response.tool_calls:
            message["tool_calls"] = [
                {
                    "id": str(call.get("id") or f"tool_call_{index + 1}"),
                    "type": "function",
                    "function": {
                        "name": str(call.get("name") or ""),
                        "arguments": json.dumps(call.get("args") or {}, ensure_ascii=False, default=str),
                    },
                }
                for index, call in enumerate(response.tool_calls)
            ]
        return message

    def _invoke_tool_handler(
        self,
        tool_handler: ToolCallHandler,
        name: str,
        args: dict[str, Any],
        progress_event_id: str | None,
    ) -> dict[str, Any]:
        return invoke_tool_handler(tool_handler, name, args, progress_event_id)

    def _latest_token_usage(
        self,
        trace_recorder: Any | None,
        usage: Any,
        previous: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if trace_recorder is None or not hasattr(trace_recorder, "extract_token_usage"):
            return previous
        token_usage = trace_recorder.extract_token_usage({"usage": usage})
        return token_usage if token_usage else previous

    def _tool_error_message(self, name: str, exc: Exception) -> dict[str, Any]:
        return tool_error_message(name, exc)

    def _tool_definition_to_model_tool(self, definition: ToolDefinition) -> dict[str, Any]:
        return chat_tool_definition_to_model_tool(definition)

    def _model_tool_name(self, name: str) -> str:
        return model_tool_name(name)

    def stream_generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
    ) -> Iterator[str]:
        messages = self._request_openai_messages(system, user)
        cache_options = self._chat_completions_cache_request_options(system, user, [])
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
                    **self._prefix_request_options(user),
                    **cache_options,
                },
            )
            if trace_recorder is not None
            else None
        )
        chunks: list[str] = []
        stream_token_usage: dict[str, Any] | None = None
        try:
            stream = self._create_chat_completion_stream(
                messages,
                tools=[],
                temperature=0.5,
                prompt_cache_options=cache_options,
            )
            for raw_chunk in stream:
                chunk = raw_chunk.model_dump() if hasattr(raw_chunk, "model_dump") else raw_chunk
                if not isinstance(chunk, dict):
                    continue
                usage = chunk.get("usage")
                if isinstance(usage, dict):
                    stream_token_usage = self._latest_token_usage(trace_recorder, usage, stream_token_usage)
                choices = chunk.get("choices") if isinstance(chunk.get("choices"), list) else []
                for choice in choices:
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta")
                    if not isinstance(delta, dict):
                        continue
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        chunks.append(content)
                        yield content
        except Exception as exc:  # pragma: no cover - network/provider failure
            if exchange is not None:
                exchange.fail(error_code="provider_stream_failed", error_message=str(exc), response_message={})
            return
        response_text = "".join(chunks).strip()
        if exchange is not None:
            exchange.finish(
                response_message={"role": "assistant", "content": response_text},
                response_text=response_text or None,
                response_tool_calls=[],
                stream_chunks=trace_recorder.stream_chunks_payload(chunks),
                token_usage=stream_token_usage,
                status="completed" if response_text else "failed",
                error_code=None if response_text else "provider_empty_response",
                error_message=None if response_text else "empty model response",
            )
