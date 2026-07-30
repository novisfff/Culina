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


class UnsupportedOptionalProviderParameter(TypeError):
    """A conclusively pre-send optional-parameter rejection.

    Only local SDK ``TypeError`` instances and inspected 4xx rejections may be
    classified this way.  Timeouts, disconnects and 5xx responses remain
    ambiguous provider attempts and must never trigger an automatic resend.
    """

    def __init__(self, option_group: str, message: str) -> None:
        self.option_group = option_group
        self.code = f"provider_unsupported_{option_group}"
        super().__init__(message)


def create_stream_once(create, request: dict[str, Any]) -> Any:
    """Perform exactly one provider SDK call, classifying only safe fallback."""

    try:
        return create(**request)
    except TypeError as exc:
        option_group = _unsupported_option_group(request, str(exc))
        if option_group is not None:
            raise UnsupportedOptionalProviderParameter(option_group, str(exc)) from exc
        raise
    except Exception as exc:
        option_group = _unsupported_option_group_from_4xx(request, exc)
        if option_group is not None:
            raise UnsupportedOptionalProviderParameter(option_group, str(exc)) from exc
        raise


def remove_confirmed_unsupported_option(
    request: dict[str, Any],
    option_group: str,
) -> dict[str, Any]:
    updated = dict(request)
    if option_group == "prompt_cache":
        updated.pop("prompt_cache_key", None)
        updated.pop("prompt_cache_retention", None)
    elif option_group == "stream_options":
        updated.pop("stream_options", None)
    else:  # defensive: do not accidentally mutate a request for an unknown group.
        raise ValueError("unsupported optional provider parameter group")
    return updated


def create_stream_with_unsupported_param_fallback(create, request: dict[str, Any]) -> Any:
    """Legacy unmetered compatibility wrapper.

    Metered remote providers call :func:`create_stream_once` directly so each
    retry receives its own reservation.  Existing local/fake providers retain
    their historical convenience fallback through this wrapper.
    """

    current_request = dict(request)
    while True:
        try:
            return create_stream_once(create, current_request)
        except UnsupportedOptionalProviderParameter as exc:
            current_request = remove_confirmed_unsupported_option(
                current_request,
                exc.option_group,
            )


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


def _unsupported_option_group(request: dict[str, Any], message: str) -> str | None:
    if _drop_prompt_cache_if_unsupported(dict(request), message):
        return "prompt_cache"
    if _drop_stream_options_if_unsupported(dict(request), message):
        return "stream_options"
    return None


def _unsupported_option_group_from_4xx(request: dict[str, Any], exc: Exception) -> str | None:
    status_code = getattr(exc, "status_code", None)
    if not isinstance(status_code, int):
        response = getattr(exc, "response", None)
        status_code = getattr(response, "status_code", None)
    if not isinstance(status_code, int) or not 400 <= status_code < 500:
        return None
    message = str(exc).lower()
    if not any(marker in message for marker in ("unsupported", "unexpected", "unknown", "invalid parameter", "unrecognized")):
        return None
    return _unsupported_option_group(request, message)
