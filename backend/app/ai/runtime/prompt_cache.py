from __future__ import annotations

import hashlib
import json
from typing import Any

from app.ai.runtime.types import ProviderUserContent, ProviderUserInput


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def prompt_cache_request_options(
    *,
    model_name: str,
    prompt_cache_enabled: bool,
    provider_protocol: str,
    system: str,
    user: ProviderUserContent,
    model_tools: list[dict[str, Any]],
) -> dict[str, Any]:
    if isinstance(user, ProviderUserInput):
        prefix_messages = [message for message in user.prefix_messages if isinstance(message, str) and message]
        runtime_chars = len(user.text)
    else:
        prefix_messages = []
        runtime_chars = len(user)
    canonical_tools = canonical_json(model_tools)
    request_prefix_hash = short_hash(
        canonical_json(
            {
                "model": model_name,
                "system": system,
                "prefixMessages": prefix_messages,
                "tools": model_tools,
            }
        )
    )
    options = {
        "providerProtocol": provider_protocol,
        "systemHash": short_hash(system),
        "stablePrefixHash": short_hash(canonical_json(prefix_messages)),
        "toolsHash": short_hash(canonical_tools),
        "requestPrefixHash": request_prefix_hash,
        "prefixMessageCount": len(prefix_messages),
        "stablePrefixChars": sum(len(message) for message in prefix_messages),
        "runtimePayloadChars": runtime_chars,
    }
    if prompt_cache_enabled:
        options["promptCacheKey"] = f"culina:{request_prefix_hash}"
        options["promptCacheRetention"] = "24h"
    return options


def prompt_cache_api_params(request_options: dict[str, Any]) -> dict[str, Any]:
    prompt_cache_key = request_options.get("promptCacheKey")
    if not isinstance(prompt_cache_key, str) or not prompt_cache_key:
        return {}
    params = {"prompt_cache_key": prompt_cache_key}
    retention = request_options.get("promptCacheRetention")
    if isinstance(retention, str) and retention:
        params["prompt_cache_retention"] = retention
    return params


def create_stream_with_unsupported_param_fallback(create, request: dict[str, Any]) -> Any:
    request = dict(request)
    while True:
        try:
            return create(**request)
        except TypeError as exc:
            message = str(exc)
            if _drop_prompt_cache_if_unsupported(request, message):
                continue
            if _drop_stream_options_if_unsupported(request, message):
                continue
            raise
        except Exception as exc:
            if _drop_prompt_cache_if_unsupported(request, str(exc)):
                continue
            raise


def _drop_prompt_cache_if_unsupported(request: dict[str, Any], message: str) -> bool:
    if "prompt_cache" not in message:
        return False
    if "prompt_cache_key" not in request and "prompt_cache_retention" not in request:
        return False
    request.pop("prompt_cache_key", None)
    request.pop("prompt_cache_retention", None)
    return True


def _drop_stream_options_if_unsupported(request: dict[str, Any], message: str) -> bool:
    if "stream_options" not in message or "stream_options" not in request:
        return False
    request.pop("stream_options", None)
    return True
