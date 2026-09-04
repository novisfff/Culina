from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Callable

import dashscope

from app.ai.runtime.messages import dump_value
from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.types import ProviderUserContent, ProviderUserInput
from app.services.family_model_settings.types import DispatchCredential, ResolvedCapabilityBinding
from app.services.model_usage.types import DispatchPermit
from app.services.model_usage.errors import ModelUsageContractError


DASHSCOPE_HTTP_API_URL = "https://dashscope.aliyuncs.com/api/v1"


class DashScopeChatProvider(OpenAICompatibleChatProvider):
    """Chat provider backed by the native DashScope SDK.

    The inherited orchestration keeps Culina's tool-loop, tracing and usage
    settlement behavior.  Only request/response translation is provider
    specific; the dispatch credential is resolved immediately before the SDK
    call and is never stored on the provider.
    """

    def __init__(
        self,
        *,
        binding: ResolvedCapabilityBinding,
        resolve_dispatch_credential: Callable[[ResolvedCapabilityBinding, str | None], DispatchCredential] | None = None,
        usage_adapter: Any | None = None,
        model_usage_required: bool = False,
    ) -> None:
        super().__init__(
            binding=None,
            model_name=binding.requested_model,
            supports_vision=bool(binding.options.get("supports_vision", False)),
            prompt_cache_enabled=bool(binding.options.get("prompt_cache_enabled", True)),
            max_output_tokens=(
                int(binding.options["max_output_tokens"])
                if isinstance(binding.options.get("max_output_tokens"), int)
                else 1024
            ),
            usage_adapter=usage_adapter,
            model_usage_required=model_usage_required,
        )
        self.binding = binding
        self._resolve_dispatch_credential = resolve_dispatch_credential
        self._deferred_transport = None

    def _request_messages(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        messages = request.get("messages")
        return messages if isinstance(messages, list) else []

    @staticmethod
    def _dashscope_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        converted: list[dict[str, Any]] = []
        for message in messages:
            role = str(message.get("role") or "user")
            content = message.get("content")
            if isinstance(content, list):
                parts: list[dict[str, Any]] = []
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if part.get("type") == "text":
                        parts.append({"text": str(part.get("text") or "")})
                    elif part.get("type") == "image_url":
                        image_url = part.get("image_url")
                        if isinstance(image_url, dict):
                            image_url = image_url.get("url")
                        if image_url:
                            parts.append({"image": str(image_url)})
                content = parts
            converted.append({"role": role, "content": content if content is not None else ""})
        return converted

    def _credential(self, permit: DispatchPermit | None) -> str | None:
        if self._resolve_dispatch_credential is None:
            return None
        credential = self._resolve_dispatch_credential(
            self.binding,
            permit.credential_secret_version_id if permit is not None else None,
        )
        if not credential.api_key:
            raise ModelUsageContractError("family_model_secret_unavailable")
        return credential.api_key

    @staticmethod
    def _normalize_response(response: Any, *, model: str) -> dict[str, Any]:
        payload = dump_value(response)
        if not isinstance(payload, dict):
            payload = {}
        output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
        choices = output.get("choices") if isinstance(output.get("choices"), list) else []
        if choices:
            raw_message = choices[0].get("message") if isinstance(choices[0], dict) else {}
            message = dump_value(raw_message) if raw_message is not None else {}
            if not isinstance(message, dict):
                message = {}
        else:
            message = {"role": "assistant", "content": output.get("text") or ""}
        message.setdefault("role", "assistant")
        message.setdefault("content", output.get("text") or "")
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else None
        return {
            "id": payload.get("request_id"),
            "model": model,
            "choices": [{"index": 0, "message": message, "delta": message}],
            "usage": usage,
        }

    def _normalize_stream(self, stream: Any, *, model: str) -> Iterator[dict[str, Any]]:
        for response in stream:
            yield self._normalize_response(response, model=model)

    def _dispatch_chat_request(self, request: dict[str, Any], *, permit: DispatchPermit | None) -> Any:
        api_key = self._credential(permit)
        kwargs: dict[str, Any] = {
            "model": str(request.get("model") or self.model_name),
            "messages": self._dashscope_messages(self._request_messages(request)),
            "api_key": api_key,
            "temperature": request.get("temperature"),
            "max_tokens": request.get("max_tokens"),
            "tools": request.get("tools") or None,
            "result_format": "message",
        }
        is_multimodal = any(
            isinstance(message.get("content"), list)
            and any(isinstance(part, dict) and part.get("image") for part in message["content"])
            for message in kwargs["messages"]
            if isinstance(message, dict)
        )
        stream = bool(request.get("stream"))
        if stream:
            kwargs["stream"] = True
            kwargs["incremental_output"] = True
        dashscope.base_http_api_url = DASHSCOPE_HTTP_API_URL
        call = dashscope.MultiModalConversation.call if is_multimodal else dashscope.Generation.call
        response = call(**{key: value for key, value in kwargs.items() if value is not None})
        return self._normalize_stream(response, model=kwargs["model"]) if stream else self._normalize_response(response, model=kwargs["model"])

    def _request_openai_messages(self, system: str, user: ProviderUserContent) -> list[dict[str, Any]]:
        # Reuse the OpenAI content encoder so binary image input remains
        # inline and never crosses an untrusted upload URL boundary.
        return super()._request_openai_messages(system, user)
