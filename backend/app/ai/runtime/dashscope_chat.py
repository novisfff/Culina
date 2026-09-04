from __future__ import annotations

from collections.abc import Iterator
from typing import Any, Callable

import openai

from app.ai.runtime.openai_chat import OpenAICompatibleChatProvider
from app.ai.runtime.types import ProviderUserContent
from app.services.family_model_settings.types import DispatchCredential, ResolvedCapabilityBinding
from app.services.model_usage.types import DispatchPermit
from app.services.model_usage.errors import ModelUsageContractError


DASHSCOPE_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


class DashScopeChatProvider(OpenAICompatibleChatProvider):
    """DashScope chat provider using one OpenAI-compatible chat protocol.

    The inherited orchestration keeps Culina's tool-loop, tracing and usage
    settlement behavior for text, image, tool and streaming requests. The
    dispatch credential is resolved immediately before the provider call and
    is never stored on the provider.
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

    def _dispatch_openai_request(self, request: dict[str, Any], *, api_key: str | None) -> Any:
        """Call DashScope's OpenAI-compatible endpoint without retaining credentials.

        A streaming response is lazy, so the client lifetime is scoped to the
        returned iterator and is closed as soon as the stream is exhausted.
        """

        if request.get("stream"):
            def iterate() -> Iterator[Any]:
                with openai.OpenAI(
                    api_key=api_key,
                    base_url=DASHSCOPE_COMPATIBLE_BASE_URL,
                    max_retries=0,
                ) as client:
                    yield from client.chat.completions.create(**request)

            return iterate()
        with openai.OpenAI(
            api_key=api_key,
            base_url=DASHSCOPE_COMPATIBLE_BASE_URL,
            max_retries=0,
        ) as client:
            return client.chat.completions.create(**request)

    def _dispatch_chat_request(self, request: dict[str, Any], *, permit: DispatchPermit | None) -> Any:
        api_key = self._credential(permit)
        return self._dispatch_openai_request(request, api_key=api_key)

    def _request_openai_messages(self, system: str, user: ProviderUserContent) -> list[dict[str, Any]]:
        # Reuse the OpenAI content encoder so binary image input remains
        # inline and never crosses an untrusted upload URL boundary.
        return super()._request_openai_messages(system, user)
