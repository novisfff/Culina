from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import logging
from collections.abc import Iterator
from typing import Any, Callable

from app.ai.errors import AIExecutionCancelled, ApprovalRequired, HumanInputRequired, ToolBudgetHardStop
from app.ai.runtime.messages import field_value, openai_chat_content, openai_chat_messages
from app.ai.runtime.family_transport import DeferredBindingTransport
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
    attach_provider_control_flow_metadata,
)
from app.ai.tools.base import ToolDefinition
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.errors import ModelUsageBlocked, ModelUsageContractError, ModelUsageError
from app.services.model_usage.types import DispatchPermit, UsageAttribution
from app.services.family_model_settings.transport import ProviderTransport
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
)

logger = logging.getLogger(__name__)
STREAM_TOOL_CALL_RETRY_COUNT = 3
MAX_COMPATIBILITY_ATTEMPTS = 3


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
        binding: ResolvedCapabilityBinding | None = None,
        transport: ProviderTransport | None = None,
        resolve_dispatch_credential: Callable[
            [ResolvedCapabilityBinding, str | None], DispatchCredential
        ]
        | None = None,
        # These legacy test-only arguments are retained temporarily for tests
        # which inject a fake ``openai_client`` after construction.  They never
        # create a network client or retain the supplied key.
        api_base: str | None = None,
        api_key: str | None = None,
        model_name: str | None = None,
        timeout_seconds: float | None = None,
        supports_vision: bool | None = None,
        prompt_cache_enabled: bool | None = None,
        max_output_tokens: int | None = None,
        usage_adapter: LLMUsageAdapter | None = None,
        model_usage_required: bool = False,
        fallback_model: str = "",
        fallback_max_output_tokens: int = 0,
        fallback_provider: OpenAICompatibleChatProvider | None = None,
    ) -> None:
        del api_base, api_key, timeout_seconds
        options = binding.options if binding is not None else {}
        resolved_model_name = binding.requested_model if binding is not None else (model_name or "")
        resolved_supports_vision = (
            bool(options.get("supports_vision", False))
            if binding is not None and supports_vision is None
            else bool(supports_vision)
        )
        resolved_prompt_cache_enabled = (
            bool(options.get("prompt_cache_enabled", True))
            if binding is not None and prompt_cache_enabled is None
            else (True if prompt_cache_enabled is None else prompt_cache_enabled)
        )
        configured_output_cap = options.get("max_output_tokens") if binding is not None else None
        resolved_output_cap = (
            configured_output_cap
            if max_output_tokens is None and isinstance(configured_output_cap, int)
            else (max_output_tokens if max_output_tokens is not None else 1024)
        )
        if not resolved_model_name:
            raise ValueError("family_model_llm_model_required")
        if isinstance(resolved_output_cap, bool) or not isinstance(resolved_output_cap, int):
            raise ValueError("max_output_tokens must be positive")
        if resolved_output_cap <= 0 or fallback_max_output_tokens < 0:
            raise ValueError("max_output_tokens must be positive")
        if binding is not None and (transport is None or resolve_dispatch_credential is None):
            raise ValueError("family_model_llm_transport_required")
        self.binding = binding
        self.model_name = resolved_model_name
        self.supports_vision = resolved_supports_vision
        self.prompt_cache_enabled = resolved_prompt_cache_enabled
        self.max_output_tokens = resolved_output_cap
        self.usage_adapter = usage_adapter
        self.model_usage_required = model_usage_required
        self.fallback_model = fallback_model.strip()
        self.fallback_max_output_tokens = fallback_max_output_tokens
        self.fallback_provider = fallback_provider
        self._deferred_transport = (
            DeferredBindingTransport(
                binding=binding,
                transport=transport,
                resolve_credential=resolve_dispatch_credential,
            )
            if binding is not None and transport is not None and resolve_dispatch_credential is not None
            else None
        )
        # Test doubles may set this attribute explicitly.  Production family
        # providers always use ``_deferred_transport`` after dispatch.
        self.openai_client: Any | None = None

    def _dispatch_chat_request(
        self,
        request: dict[str, Any],
        *,
        permit: DispatchPermit | None,
    ) -> Any:
        deferred_transport = getattr(self, "_deferred_transport", None)
        if deferred_transport is not None:
            return deferred_transport.request_json(
                suffix="chat/completions",
                payload=request,
                permit=permit,
                stream=bool(request.get("stream")),
            )
        client = getattr(self, "openai_client", None)
        create = getattr(
            getattr(getattr(client, "chat", None), "completions", None),
            "create",
            None,
        )
        if not callable(create):
            raise ModelUsageContractError("family_model_llm_runtime_binding_required")
        return create(**request)

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
        messages: list[dict[str, Any]],
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
            "protocol": "chat_completions",
            "mode": mode,
            "model": selected_model or self.model_name,
            "request": request,
        }
        if hasattr(adapter, "request_fingerprint"):
            fingerprint = adapter.request_fingerprint(fingerprint_payload)
        else:  # lightweight fakes used by non-ledger tests
            fingerprint = hashlib.sha256(canonical_json(fingerprint_payload).encode("utf-8")).hexdigest()
        input_estimate = max(1, (len(canonical_json(messages)) + 3) // 4)
        return adapter.start_round(
            usage_attribution,
            provider_round=provider_round,
            attempt_index=attempt_index,
            model=selected_model or self.model_name,
            input_estimate=input_estimate,
            output_cap=output_cap or self._output_cap(),
            fingerprint=fingerprint,
        )

    def _send_chat_request(
        self,
        *,
        request: dict[str, Any],
        messages: list[dict[str, Any]],
        usage_attribution: UsageAttribution | None,
        provider_round: int,
        attempt_index: int,
        mode: str,
        ambiguous_error_code: str = "provider_chat_transport_ambiguous",
        selected_model: str | None = None,
        output_cap: int | None = None,
    ) -> tuple[Any, Any | None, DispatchPermit | None]:
        """Send once per metered attempt; compatibility retries get new keys."""

        adapter = getattr(self, "usage_adapter", None)
        if adapter is None and not bool(getattr(self, "model_usage_required", False)):
            return (
                create_stream_with_unsupported_param_fallback(
                    lambda **payload: self._dispatch_chat_request(payload, permit=None),
                    request,
                ),
                None,
                None,
            )

        current_request = dict(request)
        current_attempt_index = attempt_index
        for _ in range(MAX_COMPATIBILITY_ATTEMPTS):
            metered_attempt = self._metered_attempt(
                messages=messages,
                request=current_request,
                usage_attribution=usage_attribution,
                provider_round=provider_round,
                attempt_index=current_attempt_index,
                mode=mode,
                selected_model=selected_model,
                output_cap=output_cap,
            )
            if metered_attempt is None:
                # Attribution is intentionally optional in local/non-required
                # environments.  Preserve the historical fake-provider path.
                return (
                    create_stream_with_unsupported_param_fallback(
                        lambda **payload: self._dispatch_chat_request(payload, permit=None),
                        current_request,
                    ),
                    None,
                    None,
                )
            permit = metered_attempt.prepare_dispatch()
            try:
                response = create_stream_once(
                    lambda **payload: self._dispatch_chat_request(payload, permit=permit),
                    current_request,
                )
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
                    metered_attempt.mark_uncertain(ambiguous_error_code)
                except ModelUsageError:
                    logger.exception("failed to mark ambiguous chat provider attempt")
                raise
            return response, metered_attempt, permit
        raise ModelUsageContractError("provider_optional_parameter_fallback_exhausted")

    def _send_chat_request_with_pre_dispatch_fallback(
        self,
        *,
        request: dict[str, Any],
        messages: list[dict[str, Any]],
        usage_attribution: UsageAttribution | None,
        provider_round: int,
        attempt_index: int,
        mode: str,
        ambiguous_error_code: str,
    ) -> tuple[Any, Any | None, DispatchPermit | None, str, bool, str | None]:
        """Use a configured light model only when the primary was never sent."""

        try:
            response, metered_attempt, permit = self._send_chat_request(
                request=request,
                messages=messages,
                usage_attribution=usage_attribution,
                provider_round=provider_round,
                attempt_index=attempt_index,
                mode=mode,
                ambiguous_error_code=ambiguous_error_code,
            )
            return response, metered_attempt, permit, self.model_name, False, None
        except ModelUsageBlocked as exc:
            fallback_provider = getattr(self, "fallback_provider", None)
            if fallback_provider is not None:
                fallback_request = dict(request)
                fallback_request["model"] = fallback_provider.model_name
                fallback_request["max_tokens"] = fallback_provider._output_cap()
                response, metered_attempt, permit = fallback_provider._send_chat_request(
                    request=fallback_request,
                    messages=messages,
                    usage_attribution=usage_attribution,
                    provider_round=provider_round,
                    attempt_index=attempt_index,
                    mode=f"{mode}_fallback",
                    ambiguous_error_code=ambiguous_error_code,
                    selected_model=fallback_provider.model_name,
                    output_cap=fallback_provider._output_cap(),
                )
                return (
                    response,
                    metered_attempt,
                    permit,
                    fallback_provider.model_name,
                    True,
                    exc.code,
                )
            fallback = self._fallback_target()
            if fallback is None:
                raise
            fallback_model, fallback_cap = fallback
            fallback_request = dict(request)
            fallback_request["model"] = fallback_model
            fallback_request["max_tokens"] = fallback_cap
            response, metered_attempt, permit = self._send_chat_request(
                request=fallback_request,
                messages=messages,
                usage_attribution=usage_attribution,
                provider_round=provider_round,
                attempt_index=attempt_index,
                mode=f"{mode}_fallback",
                ambiguous_error_code=ambiguous_error_code,
                selected_model=fallback_model,
                output_cap=fallback_cap,
            )
            return response, metered_attempt, permit, fallback_model, True, exc.code

    def _settle_chat_response(
        self,
        *,
        metered_attempt: Any | None,
        permit: DispatchPermit | None,
        response: Any,
        raw_usage: Any | None = None,
        reported_model: str | None = None,
        provider_request_id: str | None = None,
    ) -> None:
        if metered_attempt is None or permit is None:
            return
        adapter = getattr(self, "usage_adapter", None)
        if adapter is None:
            raise ModelUsageContractError("model_usage_adapter_required")
        metered_attempt.settle(
            adapter.receipt_from_openai_usage(
                permit,
                raw_usage=(field_value(response, "usage") if raw_usage is None else raw_usage),
                reported_model=(
                    reported_model
                    if reported_model is not None
                    else (str(field_value(response, "model")) if field_value(response, "model") else None)
                ),
                provider_request_id=(
                    provider_request_id
                    if provider_request_id is not None
                    else (str(field_value(response, "id")) if field_value(response, "id") else None)
                ),
            )
        )

    def _chat_completion_request(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None,
        prompt_cache_options: dict[str, Any],
        selected_model: str | None = None,
        output_cap: int | None = None,
    ) -> dict[str, Any]:
        request: dict[str, Any] = {
            "model": selected_model or self.model_name,
            "messages": messages,
            "max_tokens": output_cap or self._output_cap(),
            **self._prompt_cache_api_params(prompt_cache_options),
        }
        if temperature is not None:
            request["temperature"] = temperature
        return request

    def _chat_stream_request(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]],
        temperature: float | None,
        prompt_cache_options: dict[str, Any],
        selected_model: str | None = None,
        output_cap: int | None = None,
    ) -> dict[str, Any]:
        request = self._chat_completion_request(
            messages,
            temperature=temperature,
            prompt_cache_options=prompt_cache_options,
            selected_model=selected_model,
            output_cap=output_cap,
        )
        request["stream"] = True
        request["stream_options"] = {"include_usage": True}
        if tools:
            request["tools"] = tools
        return request

    def generate(
        self,
        *,
        system: str,
        user: ProviderUserContent,
        trace_recorder: Any | None = None,
        trace_request_options: dict[str, Any] | None = None,
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:
        messages = self._request_openai_messages(system, user)
        cache_options = self._chat_completions_cache_request_options(system, user, [])
        request_options = {
            "model": self.model_name,
            "mode": "generate",
            "supportsVision": self.supports_vision,
            "maxOutputTokens": self._output_cap(),
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
        selected_model = self.model_name
        fallback_used = False
        fallback_reason_code: str | None = None
        try:
            request = self._chat_completion_request(
                messages,
                temperature=0.5,
                prompt_cache_options=cache_options,
            )
            response, metered_attempt, permit, selected_model, fallback_used, fallback_reason_code = self._send_chat_request_with_pre_dispatch_fallback(
                request=request,
                messages=messages,
                usage_attribution=usage_attribution,
                provider_round=1,
                attempt_index=1,
                mode="generate",
                ambiguous_error_code="provider_chat_transport_ambiguous",
            )
        except ModelUsageError as exc:
            if exchange is not None:
                exchange.fail(error_code=exc.code, error_message=str(exc))
            return ChatProviderResult(
                text=None,
                status="failed",
                model=selected_model,
                error=exc.code,
                fallback_used=fallback_used,
                fallback_reason_code=fallback_reason_code,
            )
        except AIExecutionCancelled:
            raise
        except Exception as exc:  # pragma: no cover - network/provider failure
            if exchange is not None:
                exchange.fail(error_code="provider_unavailable", error_message=str(exc))
            logger.warning("AI provider generate failed model=%s error=%s", self.model_name, exc, exc_info=True)
            return ChatProviderResult(
                text=None,
                status="fallback",
                model=selected_model,
                error=str(exc),
                fallback_used=fallback_used,
                fallback_reason_code=fallback_reason_code,
            )
        try:
            self._settle_chat_response(
                metered_attempt=metered_attempt,
                permit=permit,
                response=response,
            )
            message = self._completion_message(response)
            text = self._content_to_text(field_value(message, "content")).strip()
        except ModelUsageError as exc:
            if exchange is not None:
                exchange.fail(error_code=exc.code, error_message=str(exc))
            return ChatProviderResult(
                text=None,
                status="failed",
                model=selected_model,
                error=exc.code,
                fallback_used=fallback_used,
                fallback_reason_code=fallback_reason_code,
            )
        except Exception as exc:  # pragma: no cover - settlement/provider payload failure
            if exchange is not None:
                exchange.fail(error_code="model_usage_settlement_failed", error_message=str(exc))
            logger.warning("AI provider usage settlement failed model=%s error=%s", self.model_name, exc, exc_info=True)
            return ChatProviderResult(
                text=None,
                status="failed",
                model=selected_model,
                error="model_usage_settlement_failed",
                fallback_used=fallback_used,
                fallback_reason_code=fallback_reason_code,
            )
        if text:
            if exchange is not None:
                token_usage = self._completion_token_usage(trace_recorder, response)
                exchange.finish(
                    response_message=message,
                    response_text=text,
                    token_usage=token_usage,
                    status="completed",
                )
            return ChatProviderResult(
                text=text,
                status="completed",
                model=selected_model,
                fallback_used=fallback_used,
                fallback_reason_code=fallback_reason_code,
            )
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
        return ChatProviderResult(
            text=None,
            status="fallback",
            model=selected_model,
            error="empty model response",
            fallback_used=fallback_used,
            fallback_reason_code=fallback_reason_code,
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
        usage_attribution: UsageAttribution | None = None,
    ) -> ChatProviderResult:
        messages = self._request_openai_messages(system, user)
        requested_calls: list[dict[str, Any]] = []
        text_parts: list[str] = []
        selected_model = self.model_name
        fallback_used = False
        fallback_reason_code: str | None = None

        for _round in range(max(1, max_rounds)):
            finalization_round = max_rounds_finalization_round(
                round_index=_round,
                max_rounds=max_rounds,
                requested_tool_call_count=len(requested_calls),
            )
            current_tools = [] if finalization_round else tools()
            name_map = {self._model_tool_name(tool.name): tool.name for tool in current_tools}
            model_tools = [self._tool_definition_to_model_tool(tool) for tool in current_tools]
            cache_options = self._chat_completions_cache_request_options(system, user, model_tools)
            request_messages = (
                [*messages, {"role": "user", "content": MAX_ROUNDS_FINALIZATION_PROMPT}]
                if finalization_round
                else messages
            )
            response = None
            exchange = None
            for attempt in range(STREAM_TOOL_CALL_RETRY_COUNT + 1):
                streamed_text_this_attempt: list[str] = []
                metered_attempt: Any | None = None
                permit: DispatchPermit | None = None
                exchange = (
                    trace_recorder.start_exchange(
                        span_id=None,
                        provider_round=_round + 1,
                        attempt_index=attempt + 1,
                        mode="stream",
                        model=self.model_name,
                        request_messages=request_messages,
                        request_tools=model_tools,
                        request_options={
                            "model": self.model_name,
                            "mode": "stream",
                            "roundIndex": _round + 1,
                            "attemptIndex": attempt + 1,
                            "maxRounds": max_rounds,
                            **max_rounds_finalization_trace_options(finalization_round),
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
                    stream_request = self._chat_stream_request(
                        request_messages,
                        tools=model_tools,
                        temperature=0,
                        prompt_cache_options=cache_options,
                    )
                    stream, metered_attempt, permit, selected_model, round_fallback_used, round_fallback_reason_code = self._send_chat_request_with_pre_dispatch_fallback(
                        request=stream_request,
                        messages=request_messages,
                        usage_attribution=usage_attribution,
                        provider_round=_round + 1,
                        attempt_index=attempt + 1,
                        mode="stream",
                        ambiguous_error_code="provider_stream_transport_ambiguous",
                    )
                    if round_fallback_used:
                        fallback_used = True
                        fallback_reason_code = round_fallback_reason_code
                    response = self._collect_stream_response(
                        stream,
                        message_handler=message_handler,
                        streamed_text_parts=streamed_text_this_attempt,
                    )
                    self._settle_chat_response(
                        metered_attempt=metered_attempt,
                        permit=permit,
                        response=response,
                        raw_usage=response.token_usage,
                    )
                except AIExecutionCancelled:
                    if metered_attempt is not None:
                        try:
                            metered_attempt.mark_uncertain("provider_stream_cancelled")
                        except ModelUsageError:
                            logger.exception("failed to mark cancelled chat provider attempt")
                    raise
                except ModelUsageError as exc:
                    if exchange is not None:
                        exchange.fail(error_code=exc.code, error_message=str(exc), response_message={})
                    return ChatProviderResult(
                        text=None,
                        status="failed",
                        model=selected_model,
                        error=exc.code,
                        tool_calls=requested_calls,
                        fallback_used=fallback_used,
                        fallback_reason_code=fallback_reason_code,
                    )
                except Exception as exc:  # pragma: no cover - network/provider failure
                    if metered_attempt is not None:
                        try:
                            metered_attempt.mark_uncertain("provider_stream_transport_ambiguous")
                        except ModelUsageError:
                            logger.exception("failed to mark ambiguous chat provider attempt")
                    if exchange is not None:
                        exchange.fail(error_code="provider_stream_failed", error_message=str(exc), response_message={})
                    retrying = (
                        metered_attempt is None
                        and attempt < STREAM_TOOL_CALL_RETRY_COUNT
                        and not streamed_text_this_attempt
                    )
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
                        model=selected_model,
                        error=str(exc),
                        tool_calls=requested_calls,
                        fallback_used=fallback_used,
                        fallback_reason_code=fallback_reason_code,
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
                        model=selected_model,
                        error="empty model response",
                        tool_calls=requested_calls,
                        fallback_used=fallback_used,
                        fallback_reason_code=fallback_reason_code,
                    )
            if response is None:
                return ChatProviderResult(
                    text=None,
                    status="failed",
                    model=selected_model,
                    error="empty model response",
                    tool_calls=requested_calls,
                    fallback_used=fallback_used,
                    fallback_reason_code=fallback_reason_code,
                )
            if response.text:
                text_parts.append(response.text)
            if finalization_round and response.tool_calls:
                break
            messages.append(self._assistant_message(response))
            if not response.tool_calls:
                return ChatProviderResult(
                    text="".join(text_parts).strip() or None,
                    status="completed",
                    model=selected_model,
                    error=None,
                    tool_calls=requested_calls,
                    fallback_used=fallback_used,
                    fallback_reason_code=fallback_reason_code,
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
                    output = self._invoke_tool_handler(tool_handler, name, args, progress_event_id, call_id)
                except AIExecutionCancelled:
                    raise
                except (ApprovalRequired, HumanInputRequired, ToolBudgetHardStop) as exc:
                    attach_provider_control_flow_metadata(
                        exc,
                        model=selected_model,
                        fallback_used=fallback_used,
                        fallback_reason_code=fallback_reason_code,
                    )
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
            model=selected_model,
            error=f"tool conversation exceeded max_rounds={max_rounds}",
            tool_calls=requested_calls,
            fallback_used=fallback_used,
            fallback_reason_code=fallback_reason_code,
        )

    def _create_chat_completion_stream(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]],
        temperature: float | None,
        prompt_cache_options: dict[str, Any],
    ) -> Any:
        request = self._chat_stream_request(
            messages,
            tools=tools,
            temperature=temperature,
            prompt_cache_options=prompt_cache_options,
        )
        return create_stream_with_unsupported_param_fallback(
            lambda **payload: self._dispatch_chat_request(payload, permit=None),
            request,
        )

    def _create_chat_completion(
        self,
        messages: list[dict[str, Any]],
        *,
        temperature: float | None,
        prompt_cache_options: dict[str, Any],
    ) -> Any:
        request = self._chat_completion_request(
            messages,
            temperature=temperature,
            prompt_cache_options=prompt_cache_options,
        )
        return create_stream_with_unsupported_param_fallback(
            lambda **payload: self._dispatch_chat_request(payload, permit=None),
            request,
        )

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
        tool_call_id: str | None = None,
    ) -> dict[str, Any]:
        return invoke_tool_handler(tool_handler, name, args, progress_event_id, tool_call_id)

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
        usage_attribution: UsageAttribution | None = None,
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
                    "maxOutputTokens": self._output_cap(),
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
        provider_stream_usage: dict[str, Any] | None = None
        metered_attempt: Any | None = None
        permit: DispatchPermit | None = None
        try:
            stream_request = self._chat_stream_request(
                messages,
                tools=[],
                temperature=0.5,
                prompt_cache_options=cache_options,
            )
            stream, metered_attempt, permit, _selected_model, _fallback_used, _fallback_reason_code = self._send_chat_request_with_pre_dispatch_fallback(
                request=stream_request,
                messages=messages,
                usage_attribution=usage_attribution,
                provider_round=1,
                attempt_index=1,
                mode="stream_generate",
                ambiguous_error_code="provider_stream_transport_ambiguous",
            )
            for raw_chunk in stream:
                chunk = raw_chunk.model_dump() if hasattr(raw_chunk, "model_dump") else raw_chunk
                if not isinstance(chunk, dict):
                    continue
                usage = chunk.get("usage")
                if isinstance(usage, dict):
                    provider_stream_usage = usage
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
        except AIExecutionCancelled:
            if metered_attempt is not None:
                try:
                    metered_attempt.mark_uncertain("provider_stream_cancelled")
                except ModelUsageError:
                    logger.exception("failed to mark cancelled chat provider stream")
            raise
        except Exception as exc:  # pragma: no cover - network/provider failure
            if metered_attempt is not None:
                try:
                    metered_attempt.mark_uncertain("provider_stream_transport_ambiguous")
                except ModelUsageError:
                    logger.exception("failed to mark ambiguous chat provider stream")
            if exchange is not None:
                exchange.fail(error_code="provider_stream_failed", error_message=str(exc), response_message={})
            return
        try:
            self._settle_chat_response(
                metered_attempt=metered_attempt,
                permit=permit,
                response={},
                raw_usage=provider_stream_usage,
            )
        except Exception as exc:  # provider succeeded; do not send or stream it again.
            if exchange is not None:
                exchange.fail(error_code="model_usage_settlement_failed", error_message=str(exc), response_message={})
            logger.warning("AI provider stream usage settlement failed model=%s error=%s", self.model_name, exc, exc_info=True)
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
