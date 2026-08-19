"""Deterministic in-process Provider transport for family-settings acceptance tests.

The helper deliberately lives under ``tests`` rather than the application
package: it models only the small wire contracts that the published adapter
registry can send, records requests for assertions, and never opens a socket.
Secret markers are retained only in memory inside this helper so application
responses, traces, and logs cannot accidentally expose them.
"""

from __future__ import annotations

import base64
import copy
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from threading import RLock
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from app.services.family_model_settings.transport import ProviderMedia, ProviderResponse
from app.services.family_model_settings.types import ResolvedProviderEndpoint


@dataclass(frozen=True, slots=True)
class FakeProviderRequest:
    """One local fake-provider interaction, retained only for test assertions."""

    protocol: Literal["http", "media", "websocket", "websocket_frame"]
    path: str
    authorization: str | None
    model: str | None
    body: dict[str, object] | bytes


@dataclass(frozen=True, slots=True)
class _QueuedHttpOutcome:
    status_code: int | None = None
    content: bytes | None = None
    timeout: bool = False


class _FakeWebSocket:
    def __init__(
        self,
        provider: FakeFamilyModelProvider,
        *,
        path: str,
        authorization: str | None,
        model: str | None,
    ) -> None:
        self._provider = provider
        self._path = path
        self._authorization = authorization
        self._model = model
        self.closed = False
        self._receive_index = 0

    def send(self, payload: str | bytes) -> None:
        if self.closed:
            raise RuntimeError("fake_provider_websocket_closed")
        if isinstance(payload, bytes):
            body: dict[str, object] | bytes = bytes(payload)
        else:
            try:
                decoded = json.loads(payload)
            except json.JSONDecodeError:
                decoded = None
            body = decoded if isinstance(decoded, dict) else payload.encode("utf-8")
        self._provider._record(
            FakeProviderRequest(
                protocol="websocket_frame",
                path=self._path,
                authorization=self._authorization,
                model=self._model,
                body=body,
            )
        )

    def recv(self, timeout: float | None = None) -> str:
        del timeout
        if self.closed:
            raise RuntimeError("fake_provider_websocket_closed")
        events = (
            {
                "type": "session.created",
                "session": {"model": self._model or "fake-realtime-model"},
            },
            {
                "type": "response.audio.delta",
                "delta": base64.b64encode(b"\x00\x00" * 2400).decode("ascii"),
            },
            {"type": "session.finished"},
        )
        event = events[min(self._receive_index, len(events) - 1)]
        self._receive_index += 1
        return json.dumps(event, ensure_ascii=False)

    def close(self) -> None:
        self.closed = True


@dataclass(slots=True)
class FakeFamilyModelProvider:
    """ProviderTransport-compatible fake covering every supported wire shape.

    It records only in-process interactions.  ``requests_for`` is intentionally
    the sole secret-aware query API and should only be used with synthetic test
    markers; caller-visible application data never receives these records.
    """

    _requests: list[FakeProviderRequest] = field(default_factory=list, init=False, repr=False)
    _outcomes: list[_QueuedHttpOutcome] = field(default_factory=list, init=False, repr=False)
    _lock: RLock = field(default_factory=RLock, init=False, repr=False)

    def queue_retryable_error(self, *, status_code: int = 503) -> None:
        if not 500 <= status_code <= 599:
            raise ValueError("fake_provider_retryable_status_invalid")
        with self._lock:
            self._outcomes.append(_QueuedHttpOutcome(status_code=status_code))

    def queue_uncertain_timeout(self) -> None:
        with self._lock:
            self._outcomes.append(_QueuedHttpOutcome(timeout=True))

    def requests_for(self, secret_marker: str) -> list[FakeProviderRequest]:
        expected = f"Bearer {secret_marker}"
        with self._lock:
            return [request for request in self._requests if request.authorization == expected]

    @property
    def request_count(self) -> int:
        with self._lock:
            return len(self._requests)

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        json: object | None = None,
        body: bytes | None = None,
    ) -> ProviderResponse:
        if method.upper() != "POST":
            raise AssertionError("fake_provider_expected_post")
        if json is not None and body is not None:
            raise AssertionError("fake_provider_received_json_and_body")
        parsed = urlsplit(url)
        payload = self._request_body(json=json, body=body)
        model = _model_from_payload(payload)
        self._record(
            FakeProviderRequest(
                protocol="http",
                path=parsed.path,
                authorization=_authorization(headers),
                model=model,
                body=payload,
            )
        )
        outcome = self._next_outcome()
        if outcome is not None:
            if outcome.timeout:
                raise TimeoutError("fake_provider_timeout")
            if outcome.status_code is not None:
                return ProviderResponse(
                    status_code=outcome.status_code,
                    headers={"x-request-id": "fake-retryable"},
                    content=outcome.content or b'{"error":{"code":"fake_retryable"}}',
                )
        return _success_response(parsed.path, model)

    def connect_websocket(self, url: str, *, headers: Mapping[str, str]) -> _FakeWebSocket:
        parsed = urlsplit(url)
        model_values = parse_qs(parsed.query).get("model", [])
        model = model_values[0] if model_values else None
        authorization = _authorization(headers)
        self._record(
            FakeProviderRequest(
                protocol="websocket",
                path=parsed.path,
                authorization=authorization,
                model=model,
                body=b"",
            )
        )
        return _FakeWebSocket(
            self,
            path=parsed.path,
            authorization=authorization,
            model=model,
        )

    def download_media(
        self,
        url: str,
        *,
        source: ResolvedProviderEndpoint,
        adapter_kind: str,
    ) -> ProviderMedia:
        del adapter_kind
        parsed = urlsplit(url)
        self._record(
            FakeProviderRequest(
                protocol="media",
                path=parsed.path,
                authorization=None,
                model=None,
                body=b"",
            )
        )
        return ProviderMedia(content=b"fake-provider-media", content_type="image/png", endpoint=source)

    def _next_outcome(self) -> _QueuedHttpOutcome | None:
        with self._lock:
            return self._outcomes.pop(0) if self._outcomes else None

    def _record(self, request: FakeProviderRequest) -> None:
        with self._lock:
            self._requests.append(request)

    @staticmethod
    def _request_body(*, json: object | None, body: bytes | None) -> dict[str, object] | bytes:
        if isinstance(json, Mapping):
            return copy.deepcopy(dict(json))
        if json is not None:
            raise AssertionError("fake_provider_json_payload_invalid")
        return bytes(body or b"")


def _authorization(headers: Mapping[str, str]) -> str | None:
    return next((value for key, value in headers.items() if key.lower() == "authorization"), None)


def _model_from_payload(payload: dict[str, object] | bytes) -> str | None:
    if isinstance(payload, dict):
        model = payload.get("model")
        return model if isinstance(model, str) else None
    match = re.search(rb'name="model"\r\n\r\n([^\r\n]+)', payload)
    return match.group(1).decode("utf-8") if match is not None else None


def _success_response(path: str, model: str | None) -> ProviderResponse:
    request_id = "fake-provider-request"
    headers = {"x-request-id": request_id, "content-type": "application/json"}
    if path.endswith("/audio/speech"):
        return ProviderResponse(
            status_code=200,
            headers={**headers, "content-type": "audio/mpeg"},
            content=b"ID3fake-provider-audio",
        )
    payload: dict[str, object]
    if path.endswith("/chat/completions"):
        payload = {
            "id": "fake-chat-completion",
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "已完成能力测试。"}}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 1, "total_tokens": 9},
        }
    elif path.endswith("/responses"):
        payload = {
            "id": "fake-response",
            "model": model,
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "已完成能力测试。"}]}],
            "usage": {"input_tokens": 8, "output_tokens": 1, "total_tokens": 9},
        }
    elif path.endswith("/images/generations") or path.endswith("/image-synthesis"):
        payload = {"created": 0, "data": [{"b64_json": "ZmFrZS1pbWFnZQ=="}]}
    elif path.endswith("/audio/transcriptions"):
        payload = {"text": "能力测试。", "model": model}
    elif path.endswith("/embeddings") or path.endswith("/text-embedding"):
        payload = {
            "object": "list",
            "model": model,
            "data": [{"object": "embedding", "index": 0, "embedding": [0.25, 0.75]}],
            "usage": {"prompt_tokens": 4, "total_tokens": 4},
        }
    elif path.endswith("/rerank") or path.endswith("/text-rerank"):
        payload = {
            "model": model,
            "results": [{"index": 0, "relevance_score": 0.99}],
            "usage": {"total_tokens": 4},
        }
    else:
        # DashScope audio and text-generation shapes have a common minimal
        # response that is sufficient for a status-based capability probe.
        payload = {
            "request_id": request_id,
            "model": model,
            "output": {"text": "已完成能力测试。", "choices": [{"message": {"content": "已完成能力测试。"}}]},
            "usage": {"input_tokens": 8, "output_tokens": 1, "total_tokens": 9},
        }
    return ProviderResponse(
        status_code=200,
        headers=headers,
        content=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
    )
