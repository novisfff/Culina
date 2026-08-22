from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.services.family_model_settings.errors import FamilyModelProviderTransportError
from app.services.family_model_settings.transport import ProviderResponse, ProviderTransport
from app.services.family_model_settings.types import (
    DispatchCredential,
    ResolvedCapabilityBinding,
)
from app.services.model_usage.types import DispatchPermit


class FamilyProviderHttpStatusError(FamilyModelProviderTransportError):
    """A safe, status-only provider rejection.

    Provider response payloads can contain customer data and credentials.  The
    runtime needs a status code for the existing optional-parameter handling,
    but deliberately never retains or renders the remote response body.
    """

    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        super().__init__("family_model_provider_http_rejected")


def binding_endpoint_url(binding: ResolvedCapabilityBinding, suffix: str) -> str:
    """Append an adapter-owned path without accepting a caller-provided URL."""

    parsed = urlsplit(binding.endpoint.normalized_url)
    base_path = parsed.path.rstrip("/")
    path = f"{base_path}/{suffix.lstrip('/')}"
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _authorization_headers(
    binding: ResolvedCapabilityBinding,
    credential: DispatchCredential,
    permit: DispatchPermit | None,
    *,
    stream: bool,
) -> dict[str, str]:
    headers = {
        "Accept": "text/event-stream" if stream else "application/json",
        "Content-Type": "application/json",
    }
    if binding.auth_mode == "api_key":
        if not credential.api_key:
            raise FamilyModelProviderTransportError("family_model_secret_unavailable")
        headers["Authorization"] = f"Bearer {credential.api_key}"
    if permit is not None and permit.provider_idempotency_key:
        headers["Idempotency-Key"] = permit.provider_idempotency_key
    return headers


def _json_object(response: ProviderResponse) -> dict[str, Any]:
    payload = response.json()
    if not isinstance(payload, dict):
        raise FamilyModelProviderTransportError("family_model_provider_response_invalid")
    return payload


def _sse_events(response: ProviderResponse) -> Iterator[dict[str, Any]]:
    """Decode a bounded SSE body into the dict-shaped events existing loops use."""

    content_type = (response.header("content-type") or "").lower()
    if "text/event-stream" not in content_type:
        yield _json_object(response)
        return

    try:
        text = response.content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FamilyModelProviderTransportError("family_model_provider_response_invalid") from exc

    data_lines: list[str] = []

    def emit() -> Iterator[dict[str, Any]]:
        if not data_lines:
            return
        raw = "\n".join(data_lines).strip()
        data_lines.clear()
        if not raw or raw == "[DONE]":
            return
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise FamilyModelProviderTransportError(
                "family_model_provider_response_invalid"
            ) from exc
        if not isinstance(payload, dict):
            raise FamilyModelProviderTransportError("family_model_provider_response_invalid")
        yield payload

    for line in text.splitlines():
        if not line:
            yield from emit()
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    yield from emit()


@dataclass(slots=True)
class DeferredBindingTransport:
    """Transport facade that resolves the dispatch-pinned secret just in time."""

    binding: ResolvedCapabilityBinding
    transport: ProviderTransport
    resolve_credential: Callable[
        [ResolvedCapabilityBinding, str | None], DispatchCredential
    ]

    def request_json(
        self,
        *,
        suffix: str,
        payload: Mapping[str, Any],
        permit: DispatchPermit | None,
        stream: bool,
    ) -> dict[str, Any] | Iterator[dict[str, Any]]:
        credential: DispatchCredential | None = None
        try:
            credential = self.resolve_credential(
                self.binding,
                permit.credential_secret_version_id if permit is not None else None,
            )
            response = self.transport.request(
                "POST",
                binding_endpoint_url(self.binding, suffix),
                headers=_authorization_headers(
                    self.binding,
                    credential,
                    permit,
                    stream=stream,
                ),
                json=dict(payload),
            )
        finally:
            # DispatchCredential is a short-lived boundary object.  Dropping
            # our reference here avoids keeping plaintext beyond one send.
            credential = None
        if not 200 <= response.status_code < 300:
            raise FamilyProviderHttpStatusError(response.status_code)
        return _sse_events(response) if stream else _json_object(response)
