from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Iterator
from typing import Any

from openai import OpenAI

from app.ai.errors import AIExecutionCancelled, ApprovalRequired, HumanInputRequired, ToolBudgetHardStop
from app.ai.runtime.messages import dump_value, field_value, responses_input, responses_system_message, responses_text_message
from app.ai.runtime.prompt_cache import (
    UnsupportedOptionalProviderParameter,
    canonical_json,
    create_stream_once,
    create_stream_with_unsupported_param_fallback,
    prompt_cache_api_params,
    prompt_cache_request_options,
    remove_confirmed_unsupported_option,
)
from app.ai.runtime.tool_loop import (
    MAX_ROUNDS_FINALIZATION_PROMPT,
    max_rounds_finalization_round,
    max_rounds_finalization_trace_options,
)
from app.ai.runtime.tooling import (
    dedupe_responses_tool_calls,
    invoke_tool_handler,
    json_object,
    model_tool_name,
    responses_tool_definition_to_model_tool,
    tool_error_message,
)
from app.ai.tools.base import ToolDefinition
from app.ai.runtime.types import (
    AssistantMessageHandler,
    BaseChatProvider,
    ChatProviderResult,
    ProviderUserContent,
    ToolCallHandler,
    ToolPreviewHandler,
    ToolProvider,
)
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageContractError, ModelUsageError
from app.services.model_usage.types import DispatchPermit, UsageAttribution

logger = logging.getLogger(__name__)
MAX_COMPATIBILITY_ATTEMPTS = 3


class OpenAIResponsesChatProvider(BaseChatProvider):
    def __init__(
        self,
        *,
        api_base: str,
        api_key: str,
        model_name: str,
        timeout_seconds: float = 20.0,
        supports_vision: bool = False,
        prompt_cache_enabled: bool | None = None,
        max_output_tokens: int = 1024,
        usage_adapter: LLMUsageAdapter | None = None,
        model_usage_required: bool = False,
        fallback_model: str = "",
        fallback_max_output_tokens: int = 0,
    ) -> None:
        if max_output_tokens <= 0 or fallback_max_output_tokens < 0:
            raise ValueError("max_output_tokens must be positive")
        self.model_name = model_name
        self.supports_vision = supports_vision
        self.prompt_cache_enabled = True if prompt_cache_enabled is None else prompt_cache_enabled
        self.max_output_tokens = max_output_tokens
        self.usage_adapter = usage_adapter
        self.model_usage_required = model_usage_required
        self.fallback_model = fallback_model.strip()
        self.fallback_max_output_tokens = fallback_max_output_tokens
        self.client = OpenAI(
            api_key=api_key,
            base_url=api_base.rstrip("/"),
            timeout=timeout_seconds,
            max_retries=0,
        )

    def generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        trace_request_options: dict[str, Any] | None = None,
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:
        return self.generate_with_tools(
            system=system,
            user=user,
            tools=lambda: [],
            tool_handler=lambda _name, _payload, _event_id=None: {},
            trace_recorder=trace_recorder,
            trace_request_options=trace_request_options,
            max_rounds=1,
            usage_attribution=usage_attribution,
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
        trace_request_options: dict[str, Any] | None = None,
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:
        input_items = self._responses_input(user)
        requested_calls: list[dict[str, Any]] = []
        text_parts: list[str] = []
        selected_model = self.model_name

        for _round in range(max(1, max_rounds)):
            finalization_round = max_rounds_finalization_round(
                round_index=_round,
                max_rounds=max_rounds,
                requested_tool_call_count=len(requested_calls),
            )
            current_tools = [] if finalization_round else tools()
            name_map = {self._model_tool_name(tool.name): tool.name for tool in current_tools}
            model_tools = sorted(
                [self._tool_definition_to_model_tool(tool) for tool in current_tools],
                key=lambda tool: str(tool.get("name") or ""),
            )
            finalization_input = (
                [self._responses_text_message("user", MAX_ROUNDS_FINALIZATION_PROMPT)]
                if finalization_round
                else []
            )
            request_input = [self._responses_system_message(system), *input_items, *finalization_input]
            request_options = {
                "model": self.model_name,
                "mode": "responses_stream",
                "roundIndex": _round + 1,
                "maxRounds": max_rounds,
                **max_rounds_finalization_trace_options(finalization_round),
                "toolCount": len(current_tools),
                "supportsVision": self.supports_vision,
                "temperature": 0,
                "maxOutputTokens": self._output_cap(),
                "streamOptions": {"includeUsage": True},
                **self._responses_cache_request_options(system, user, model_tools),
            }
            if trace_request_options:
                request_options.update(trace_request_options)
            exchange = (
                trace_recorder.start_exchange(
                    span_id=None,
                    provider_round=_round + 1,
                    attempt_index=1,
                    mode="responses_stream",
                    model=self.model_name,
                    request_messages=request_input,
                    request_tools=model_tools,
                    request_options=request_options,
                )
                if trace_recorder is not None
                else None
            )
            completed_response: Any | None = None
            response_tool_calls: list[dict[str, Any]] = []
            streamed_text_this_round: list[str] = []
            metered_attempt: Any | None = None
            permit: DispatchPermit | None = None
            try:
                request = self._responses_stream_request(request_input, temperature=0)
                cache_params = self._prompt_cache_api_params(request_options)
                request.update(cache_params)
                if model_tools:
                    request["tools"] = model_tools
                stream, metered_attempt, permit, selected_model = self._send_responses_request_with_pre_dispatch_fallback(
                    request=request,
                    request_input=request_input,
                    usage_attribution=usage_attribution,
                    provider_round=_round + 1,
                    attempt_index=1,
                    mode="responses_stream",
                )
                for event in stream:
                    event_type = self._event_type(event)
                    if event_type == "response.output_text.delta":
                        delta = str(self._field_value(event, "delta") or "")
                        if delta:
                            streamed_text_this_round.append(delta)
                            text_parts.append(delta)
                            if message_handler is not None:
                                message_handler(delta)
                    elif event_type == "response.output_item.done":
                        call = self._responses_function_call_from_item(self._field_value(event, "item"))
                        if call is not None:
                            response_tool_calls.append(call)
                    elif event_type == "response.function_call_arguments.done":
                        call = self._responses_function_call_from_item(event)
                        if call is not None:
                            response_tool_calls.append(call)
                    elif event_type == "response.completed":
                        completed_response = self._field_value(event, "response") or event
                    elif event_type in {"response.failed", "response.incomplete"}:
                        raise RuntimeError(self._responses_event_error(event))
                if completed_response is None:
                    # A stream ending without the provider's terminal event
                    # is not evidence that the remote execution completed.
                    raise RuntimeError("provider_responses_completion_missing")
            except (AIExecutionCancelled, ApprovalRequired, HumanInputRequired, ToolBudgetHardStop):
                if metered_attempt is not None:
                    try:
                        metered_attempt.mark_uncertain("provider_responses_stream_cancelled")
                    except ModelUsageError:
                        logger.exception("failed to mark cancelled Responses provider attempt")
                raise
            except ModelUsageError as exc:
                if exchange is not None:
                    exchange.fail(error_code=exc.code, error_message=str(exc), response_message=completed_response)
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=selected_model,
                    error=exc.code,
                    tool_calls=requested_calls,
                )
            except Exception as exc:  # pragma: no cover - network/provider failure
                if metered_attempt is not None:
                    try:
                        metered_attempt.mark_uncertain("provider_responses_stream_transport_ambiguous")
                    except ModelUsageError:
                        logger.exception("failed to mark ambiguous Responses provider attempt")
                if exchange is not None:
                    exchange.fail(error_code="provider_stream_failed", error_message=str(exc), response_message=completed_response)
                logger.warning(
                    "AI responses provider invoke failed model=%s round=%s tool_count=%s requested_calls=%s error=%s",
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
                    model=selected_model,
                    error=str(exc),
                    tool_calls=requested_calls,
                )

            try:
                self._settle_responses_response(
                    metered_attempt=metered_attempt,
                    permit=permit,
                    completed_response=completed_response,
                )
            except ModelUsageError as exc:
                if exchange is not None:
                    exchange.fail(error_code=exc.code, error_message=str(exc), response_message=completed_response)
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=selected_model,
                    error=exc.code,
                    tool_calls=requested_calls,
                )
            except Exception as exc:
                if exchange is not None:
                    exchange.fail(
                        error_code="model_usage_settlement_failed",
                        error_message=str(exc),
                        response_message=completed_response,
                    )
                logger.warning("AI Responses usage settlement failed model=%s error=%s", self.model_name, exc, exc_info=True)
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=selected_model,
                    error="model_usage_settlement_failed",
                    tool_calls=requested_calls,
                )

            response_tool_calls = self._dedupe_responses_tool_calls(
                response_tool_calls + self._responses_function_calls_from_response(completed_response)
            )
            response_text = "".join(streamed_text_this_round).strip() or None
            if exchange is not None:
                token_usage = (
                    trace_recorder.extract_token_usage(completed_response)
                    if trace_recorder is not None and completed_response is not None
                    else None
                )
                exchange.finish(
                    response_message=completed_response or {},
                    response_text=response_text,
                    response_tool_calls=response_tool_calls,
                    stream_chunks=trace_recorder.stream_chunks_payload(streamed_text_this_round),
                    token_usage=token_usage,
                    status="failed" if not response_text and not response_tool_calls else "completed",
                    error_code="provider_empty_response" if not response_text and not response_tool_calls else None,
                    error_message="empty model response" if not response_text and not response_tool_calls else None,
                )
            if not response_text and not response_tool_calls:
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=selected_model,
                    error="empty model response",
                    tool_calls=requested_calls,
                )
            if not response_tool_calls:
                return ChatProviderResult(
                    text="".join(text_parts).strip() or None,
                    status="completed",
                    model=selected_model,
                    tool_calls=requested_calls,
                )
            if finalization_round:
                break

            for index, call in enumerate(response_tool_calls):
                model_name = str(call.get("name") or "")
                name = name_map.get(model_name, model_name)
                args = call.get("args") if isinstance(call.get("args"), dict) else {}
                call_id = str(call.get("id") or f"call_{len(requested_calls) + 1}")
                preview_key = str(index)
                progress_event_id = None
                if tool_preview_handler is not None:
                    progress_event_id = tool_preview_handler(name, preview_key, "running")
                requested_calls.append({"id": call_id, "name": name, "args": args})
                try:
                    output = self._invoke_tool_handler(tool_handler, name, args, progress_event_id, call_id)
                except (AIExecutionCancelled, ApprovalRequired, HumanInputRequired, ToolBudgetHardStop):
                    raise
                except Exception as exc:
                    logger.warning(
                        "AI responses provider tool handler returned recoverable error model=%s call_id=%s tool=%s error=%s",
                        self.model_name,
                        call_id,
                        name,
                        exc,
                        exc_info=True,
                    )
                    output = self._tool_error_message(name, exc)
                    if tool_preview_handler is not None and progress_event_id is None:
                        tool_preview_handler(name, preview_key, "failed")
                input_items.append(self._responses_function_call_input_item(call, call_id=call_id, model_name=model_name, args=args))
                input_items.append(
                    {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": json.dumps(output, ensure_ascii=False, default=str),
                    }
                )

        logger.warning(
            "AI responses provider tool-call exceeded max rounds model=%s max_rounds=%s requested_calls=%s",
            self.model_name,
            max_rounds,
            len(requested_calls),
        )
        return ChatProviderResult(
            text=None,
            status="failed",
            model=selected_model,
            error=f"tool conversation exceeded max_rounds={max_rounds}",
            tool_calls=requested_calls,
        )

    def stream_generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        usage_attribution: UsageAttribution | None = None,
    ) -> Iterator[str]:
        chunks: list[str] = []

        def collect(delta: str) -> None:
            chunks.append(delta)

        result = self.generate_with_tools(
            system=system,
            user=user,
            tools=lambda: [],
            tool_handler=lambda _name, _payload, _event_id=None: {},
            message_handler=collect,
            trace_recorder=trace_recorder,
            max_rounds=1,
            usage_attribution=usage_attribution,
        )
        if chunks:
            yield from chunks
        elif result.text:
            yield result.text


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

    def _output_cap(self) -> int:
        cap = int(getattr(self, "max_output_tokens", 1024))
        if cap <= 0:
            raise ModelUsageContractError("llm_output_cap_required")
        return cap

    def _fallback_target(self) -> tuple[str, int] | None:
        fallback_model = str(getattr(self, "fallback_model", "")).strip()
        if not fallback_model or fallback_model == self.model_name:
            return None
        configured_cap = int(getattr(self, "fallback_max_output_tokens", 0) or 0)
        return fallback_model, configured_cap if configured_cap > 0 else self._output_cap()

    def _metered_attempt(
        self,
        *,
        request_input: list[dict[str, Any]],
        request: dict[str, Any],
        usage_attribution: UsageAttribution | None,
        provider_round: int,
        attempt_index: int,
        mode: str,
        selected_model: str | None = None,
        output_cap: int | None = None,
    ) -> Any | None:
        adapter = getattr(self, "usage_adapter", None)
        required = bool(getattr(self, "model_usage_required", False))
        if usage_attribution is None:
            if required:
                raise ModelUsageContractError("model_usage_attribution_required")
            return None
        if adapter is None:
            if required:
                raise ModelUsageContractError("model_usage_adapter_required")
            return None
        fingerprint_payload = {
            "protocol": "responses",
            "mode": mode,
            "model": selected_model or self.model_name,
            "request": request,
        }
        if hasattr(adapter, "request_fingerprint"):
            fingerprint = adapter.request_fingerprint(fingerprint_payload)
        else:
            fingerprint = hashlib.sha256(canonical_json(fingerprint_payload).encode("utf-8")).hexdigest()
        input_estimate = max(1, (len(canonical_json(request_input)) + 3) // 4)
        return adapter.start_round(
            usage_attribution,
            provider_round=provider_round,
            attempt_index=attempt_index,
            model=selected_model or self.model_name,
            input_estimate=input_estimate,
            output_cap=output_cap or self._output_cap(),
            fingerprint=fingerprint,
        )

    def _send_responses_request(
        self,
        *,
        request: dict[str, Any],
        request_input: list[dict[str, Any]],
        usage_attribution: UsageAttribution | None,
        provider_round: int,
        attempt_index: int,
        mode: str,
        selected_model: str | None = None,
        output_cap: int | None = None,
    ) -> tuple[Any, Any | None, DispatchPermit | None]:
        adapter = getattr(self, "usage_adapter", None)
        if adapter is None and not bool(getattr(self, "model_usage_required", False)):
            return (
                create_stream_with_unsupported_param_fallback(self.client.responses.create, request),
                None,
                None,
            )
        current_request = dict(request)
        current_attempt_index = attempt_index
        for _ in range(MAX_COMPATIBILITY_ATTEMPTS):
            metered_attempt = self._metered_attempt(
                request_input=request_input,
                request=current_request,
                usage_attribution=usage_attribution,
                provider_round=provider_round,
                attempt_index=current_attempt_index,
                mode=mode,
                selected_model=selected_model,
                output_cap=output_cap,
            )
            if metered_attempt is None:
                return (
                    create_stream_with_unsupported_param_fallback(
                        self.client.responses.create,
                        current_request,
                    ),
                    None,
                    None,
                )
            permit = metered_attempt.prepare_dispatch()
            try:
                stream = create_stream_once(self.client.responses.create, current_request)
            except UnsupportedOptionalProviderParameter as exc:
                metered_attempt.settle(
                    adapter.confirmed_not_executed_receipt(
                        permit,
                        stable_provider_request_id=exc.code,
                    )
                )
                current_request = remove_confirmed_unsupported_option(
                    current_request,
                    exc.option_group,
                )
                current_attempt_index += 1
                continue
            except Exception:
                try:
                    metered_attempt.mark_uncertain("provider_responses_stream_transport_ambiguous")
                except ModelUsageError:
                    logger.exception("failed to mark ambiguous Responses provider attempt")
                raise
            return stream, metered_attempt, permit
        raise ModelUsageContractError("provider_optional_parameter_fallback_exhausted")

    def _send_responses_request_with_pre_dispatch_fallback(
        self,
        *,
        request: dict[str, Any],
        request_input: list[dict[str, Any]],
        usage_attribution: UsageAttribution | None,
        provider_round: int,
        attempt_index: int,
        mode: str,
    ) -> tuple[Any, Any | None, DispatchPermit | None, str]:
        try:
            stream, metered_attempt, permit = self._send_responses_request(
                request=request,
                request_input=request_input,
                usage_attribution=usage_attribution,
                provider_round=provider_round,
                attempt_index=attempt_index,
                mode=mode,
            )
            return stream, metered_attempt, permit, self.model_name
        except ModelUsageBlocked:
            fallback = self._fallback_target()
            if fallback is None:
                raise
            fallback_model, fallback_cap = fallback
            fallback_request = dict(request)
            fallback_request["model"] = fallback_model
            fallback_request["max_output_tokens"] = fallback_cap
            stream, metered_attempt, permit = self._send_responses_request(
                request=fallback_request,
                request_input=request_input,
                usage_attribution=usage_attribution,
                provider_round=provider_round,
                attempt_index=attempt_index,
                mode=f"{mode}_fallback",
                selected_model=fallback_model,
                output_cap=fallback_cap,
            )
            return stream, metered_attempt, permit, fallback_model

    def _settle_responses_response(
        self,
        *,
        metered_attempt: Any | None,
        permit: DispatchPermit | None,
        completed_response: Any | None,
    ) -> None:
        if metered_attempt is None or permit is None:
            return
        adapter = getattr(self, "usage_adapter", None)
        if adapter is None:
            raise ModelUsageContractError("model_usage_adapter_required")
        metered_attempt.settle(
            adapter.receipt_from_openai_usage(
                permit,
                raw_usage=(self._field_value(completed_response, "usage") if completed_response is not None else None),
                reported_model=(
                    str(self._field_value(completed_response, "model"))
                    if completed_response is not None and self._field_value(completed_response, "model")
                    else None
                ),
                provider_request_id=(
                    str(self._field_value(completed_response, "id"))
                    if completed_response is not None and self._field_value(completed_response, "id")
                    else None
                ),
            )
        )

    def _responses_stream_request(
        self,
        request_input: list[dict[str, Any]],
        *,
        temperature: float,
        selected_model: str | None = None,
        output_cap: int | None = None,
    ) -> dict[str, Any]:
        return {
            "model": selected_model or self.model_name,
            "input": request_input,
            "stream": True,
            "stream_options": {"include_usage": True},
            "temperature": temperature,
            "max_output_tokens": output_cap or self._output_cap(),
            "store": False,
        }

    def _prompt_cache_api_params(self, request_options: dict[str, Any]) -> dict[str, Any]:
        return prompt_cache_api_params(request_options)

    def _invoke_tool_handler(
        self,
        tool_handler: ToolCallHandler,
        name: str,
        args: dict[str, Any],
        progress_event_id: str | None,
        tool_call_id: str | None = None,
    ) -> dict[str, Any]:
        return invoke_tool_handler(tool_handler, name, args, progress_event_id, tool_call_id)

    def _tool_error_message(self, name: str, exc: Exception) -> dict[str, Any]:
        return tool_error_message(name, exc)

    def _json_object(self, text: str) -> dict[str, Any] | None:
        return json_object(text)

    def _model_tool_name(self, name: str) -> str:
        return model_tool_name(name)

    def _responses_input(self, user: ProviderUserContent) -> list[dict[str, Any]]:
        return responses_input(user, supports_vision=self.supports_vision)

    def _responses_system_message(self, system: str) -> dict[str, Any]:
        return responses_system_message(system)

    def _responses_text_message(self, role: str, text: str) -> dict[str, Any]:
        return responses_text_message(role, text)

    def _responses_cache_request_options(
        self,
        system: str,
        user: ProviderUserContent,
        model_tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return self._prompt_cache_request_options(
            provider_protocol="responses",
            system=system,
            user=user,
            model_tools=model_tools,
        )

    def _tool_definition_to_model_tool(self, definition: ToolDefinition) -> dict[str, Any]:
        return responses_tool_definition_to_model_tool(definition)

    def _responses_function_call_from_item(self, item: Any) -> dict[str, Any] | None:
        payload = self._dump(item)
        if not isinstance(payload, dict) or payload.get("type") != "function_call":
            return None
        args = payload.get("arguments")
        parsed_args = self._json_object(args) if isinstance(args, str) else args
        return {
            "id": payload.get("call_id") or payload.get("id") or payload.get("item_id"),
            "name": payload.get("name"),
            "args": parsed_args if isinstance(parsed_args, dict) else {},
            "_raw": payload,
        }

    def _responses_function_calls_from_response(self, response: Any) -> list[dict[str, Any]]:
        output = self._field_value(response, "output") if response is not None else None
        if not isinstance(output, list):
            return []
        return [
            call
            for item in output
            if (call := self._responses_function_call_from_item(item)) is not None
        ]

    def _dedupe_responses_tool_calls(self, calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return dedupe_responses_tool_calls(calls)

    def _create_responses_stream(self, request: dict[str, Any]) -> Any:
        return create_stream_with_unsupported_param_fallback(self.client.responses.create, request)

    def _responses_function_call_input_item(
        self,
        call: dict[str, Any],
        *,
        call_id: str,
        model_name: str,
        args: dict[str, Any],
    ) -> dict[str, Any]:
        raw = call.get("_raw")
        if isinstance(raw, dict):
            item = dict(raw)
            item["call_id"] = call_id
            item["name"] = model_name
            item["arguments"] = json.dumps(args, ensure_ascii=False, default=str)
            item.setdefault("type", "function_call")
            item.setdefault("status", "completed")
            return item
        return {
            "type": "function_call",
            "call_id": call_id,
            "name": model_name,
            "arguments": json.dumps(args, ensure_ascii=False, default=str),
            "status": "completed",
        }

    def _event_type(self, event: Any) -> str:
        return str(self._field_value(event, "type") or "")

    def _responses_event_error(self, event: Any) -> str:
        payload = self._dump(event)
        if isinstance(payload, dict):
            error = payload.get("error") or payload.get("incomplete_details") or payload
            return json.dumps(error, ensure_ascii=False, sort_keys=True, default=str)
        return str(event)

    def _field_value(self, value: Any, key: str) -> Any:
        return field_value(value, key)

    def _dump(self, value: Any) -> Any:
        return dump_value(value)
