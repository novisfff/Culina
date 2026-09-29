from __future__ import annotations

import codecs
import json
from collections.abc import Callable, Iterator, Mapping
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from app.services.family_model_settings.errors import FamilyModelProviderTransportError
from app.services.family_model_settings.transport import ProviderResponse, ProviderTransport
from app.services.family_model_settings.streaming import ProviderStreamResponse
from app.ai.runtime.execution_guard import current_stream_cancel_check
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


def _sse_lines(chunks: Iterator[bytes]) -> Iterator[str]:
    decoder = codecs.getincrementaldecoder("utf-8-sig")("strict")
    pending = ""
    after_cr = False
    try:
        for chunk in chunks:
            text = decoder.decode(chunk)
            start = 0
            for index, char in enumerate(text):
                if after_cr:
                    after_cr = False
                    if char == "\n":
                        start = index + 1
                        continue
                if char in "\r\n":
                    yield pending + text[start:index]
                    pending = ""
                    start = index + 1
                    after_cr = char == "\r"
            pending += text[start:]
        pending += decoder.decode(b"", final=True)
        if pending:
            yield pending
    except UnicodeDecodeError as exc:
        raise FamilyModelProviderTransportError("family_model_provider_response_invalid") from exc


def _sse_events(response: ProviderStreamResponse) -> Iterator[dict[str, Any]]:
    """Emit complete events immediately, never treat a truncated SSE as success."""
    chunks = response.iter_bytes(check_cancel=current_stream_cancel_check())
    try:
        if "text/event-stream" not in (response.header("content-type") or "").lower():
            yield _json_object(ProviderResponse(response.status_code, response.headers, b"".join(chunks)))
            return
        data_lines: list[str] = []
        for line in _sse_lines(chunks):
            if line:
                if line.startswith("data:"):
                    value = line[5:]
                    data_lines.append(value[1:] if value.startswith(" ") else value)
                continue
            if not data_lines:
                continue
            raw = "\n".join(data_lines).strip()
            data_lines.clear()
            if raw == "[DONE]":
                return
            if not raw:
                continue
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise FamilyModelProviderTransportError("family_model_provider_response_invalid") from exc
            if not isinstance(payload, dict):
                raise FamilyModelProviderTransportError("family_model_provider_response_invalid")
            if "error" in payload:
                raise FamilyModelProviderTransportError("family_model_provider_stream_rejected")
            yield payload
            if payload.get("type") in {"response.completed", "response.failed", "response.incomplete"}:
                return
        raise FamilyModelProviderTransportError("family_model_provider_stream_incomplete")
    finally:
        chunks.close()


class _OwnedEventStream(Iterator[dict[str, Any]]):
    """Own the already-open response, including close before the first next()."""

    def __init__(self, response: ProviderStreamResponse, stack: ExitStack):
        self._events = _sse_events(response)
        self._stack = stack

    def __next__(self) -> dict[str, Any]:
        try:
            return next(self._events)
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        try:
            self._events.close()
        finally:
            self._stack.close()


@contextmanager
def closing_provider_stream(stream: Any) -> Iterator[Any]:
    # SDK/test iterators need not implement context managers. Real family
    # streams must close deterministically if a message callback raises.
    try:
        yield stream
    finally:
        close = getattr(stream, "close", None)
        if close is not None:
            close()


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
            if stream:
                return self._stream_json(suffix=suffix, payload=payload, permit=permit, credential=credential)
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
        return _json_object(response)

    def _stream_json(
        self, *, suffix: str, payload: Mapping[str, Any],
        permit: DispatchPermit | None, credential: DispatchCredential,
    ) -> Iterator[dict[str, Any]]:
        stack = ExitStack()
        try:
            response = stack.enter_context(self.transport.stream_request(
                "POST", binding_endpoint_url(self.binding, suffix),
                headers=_authorization_headers(self.binding, credential, permit, stream=True),
                json=dict(payload),
            ))
            if not 200 <= response.status_code < 300:
                raise FamilyProviderHttpStatusError(response.status_code)
            return _OwnedEventStream(response, stack)
        except BaseException:
            stack.close()
            raise
