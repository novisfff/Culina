from __future__ import annotations

import ast
import http.client
import json
import socket
import ssl
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Protocol
from urllib.parse import urljoin, urlsplit

import certifi
import httpx
from websockets.exceptions import WebSocketException
from websockets.sync.client import connect as connect_websocket

from app.services.family_model_settings.errors import (
    FamilyModelEndpointBlocked,
    FamilyModelProviderMediaTypeBlocked,
    FamilyModelProviderResponseTooLarge,
    FamilyModelProviderTransportError,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.types import ResolvedProviderEndpoint


ALLOWED_PROVIDER_MEDIA_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "audio/mpeg",
        "audio/wav",
        "audio/ogg",
        "audio/flac",
        "audio/mp4",
    }
)
_FORBIDDEN_HEADER_NAMES = frozenset(
    {"connection", "content-length", "host", "proxy-authorization", "transfer-encoding"}
)


@dataclass(frozen=True, slots=True)
class ProviderTransportSettings:
    connect_timeout_seconds: float
    request_timeout_seconds: float
    response_max_bytes: int
    media_max_bytes: int
    redirect_limit: int
    egress_proxy_url: str = ""

    @classmethod
    def from_settings(cls, settings: object) -> ProviderTransportSettings:
        return cls(
            connect_timeout_seconds=float(
                getattr(settings, "family_model_provider_connect_timeout_seconds")
            ),
            request_timeout_seconds=float(
                getattr(settings, "family_model_provider_request_timeout_seconds")
            ),
            response_max_bytes=int(getattr(settings, "family_model_provider_response_max_bytes")),
            media_max_bytes=int(getattr(settings, "family_model_provider_media_max_bytes")),
            redirect_limit=int(getattr(settings, "family_model_provider_redirect_limit")),
            egress_proxy_url=str(getattr(settings, "family_model_egress_proxy_url") or ""),
        )

    def __post_init__(self) -> None:
        if (
            self.connect_timeout_seconds <= 0
            or self.request_timeout_seconds <= 0
            or self.response_max_bytes <= 0
            or self.media_max_bytes <= 0
            or self.redirect_limit != 0
        ):
            raise ValueError("family_model_provider_transport_settings_invalid")


@dataclass(frozen=True, slots=True)
class ProviderResponse:
    status_code: int
    headers: Mapping[str, str]
    content: bytes

    def header(self, name: str) -> str | None:
        target = name.lower()
        return next((value for key, value in self.headers.items() if key.lower() == target), None)

    def json(self) -> object:
        try:
            return json.loads(self.content)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FamilyModelProviderTransportError("family_model_provider_response_invalid") from exc


@dataclass(frozen=True, slots=True)
class ProviderMedia:
    content: bytes
    content_type: str
    endpoint: ResolvedProviderEndpoint


class ProviderHttpDialer(Protocol):
    def request(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        method: str,
        headers: Mapping[str, str],
        json: object | None,
        body: bytes | None,
        max_response_bytes: int,
    ) -> ProviderResponse: ...

    def download(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        max_bytes: int,
        allowed_content_types: frozenset[str],
    ) -> ProviderMedia: ...


class ProviderWebSocketDialer(Protocol):
    def connect(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        headers: Mapping[str, str],
        connect_timeout_seconds: float,
    ) -> object: ...


def safe_headers(headers: Mapping[str, str]) -> Mapping[str, str]:
    normalized: dict[str, str] = {}
    for key, value in headers.items():
        if (
            not isinstance(key, str)
            or not isinstance(value, str)
            or not key.strip()
            or "\r" in key
            or "\n" in key
            or "\r" in value
            or "\n" in value
            or key.lower() in _FORBIDDEN_HEADER_NAMES
        ):
            raise FamilyModelProviderTransportError("family_model_provider_headers_invalid")
        normalized[key] = value
    return MappingProxyType(normalized)


def _host_header(endpoint: ResolvedProviderEndpoint) -> str:
    host = f"[{endpoint.host}]" if ":" in endpoint.host else endpoint.host
    default_port = 443 if endpoint.scheme in {"https", "wss"} else 80
    return host if endpoint.port == default_port else f"{host}:{endpoint.port}"


def _bounded_read(response: http.client.HTTPResponse, *, max_bytes: int) -> bytes:
    content_length = response.getheader("Content-Length")
    if content_length is not None:
        try:
            if int(content_length) > max_bytes:
                raise FamilyModelProviderResponseTooLarge()
        except ValueError:
            raise FamilyModelProviderTransportError("family_model_provider_response_invalid") from None
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(64 * 1024, max_bytes - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise FamilyModelProviderResponseTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(
        self,
        endpoint: ResolvedProviderEndpoint,
        *,
        connect_timeout: float,
        request_timeout: float,
    ) -> None:
        super().__init__(endpoint.host, endpoint.port, timeout=request_timeout)
        self._resolved_address = endpoint.resolved_addresses[0]
        self._connect_timeout = connect_timeout

    def connect(self) -> None:
        self.sock = socket.create_connection(
            (self._resolved_address, self.port),
            self._connect_timeout,
        )
        self.sock.settimeout(self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        endpoint: ResolvedProviderEndpoint,
        *,
        connect_timeout: float,
        request_timeout: float,
    ) -> None:
        super().__init__(
            endpoint.host,
            endpoint.port,
            timeout=request_timeout,
            context=ssl.create_default_context(cafile=certifi.where()),
        )
        self._resolved_address = endpoint.resolved_addresses[0]
        self._server_hostname = endpoint.host
        self._connect_timeout = connect_timeout

    def connect(self) -> None:
        raw_socket = socket.create_connection(
            (self._resolved_address, self.port),
            self._connect_timeout,
        )
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self._server_hostname)
        self.sock.settimeout(self.timeout)


class PinnedHttpDialer:
    """Direct dialer that pins each connection to a freshly authorized IP."""

    def __init__(self, settings: ProviderTransportSettings) -> None:
        self._settings = settings

    def _connection(self, endpoint: ResolvedProviderEndpoint):
        if endpoint.scheme == "https":
            return _PinnedHTTPSConnection(
                endpoint,
                connect_timeout=self._settings.connect_timeout_seconds,
                request_timeout=self._settings.request_timeout_seconds,
            )
        return _PinnedHTTPConnection(
            endpoint,
            connect_timeout=self._settings.connect_timeout_seconds,
            request_timeout=self._settings.request_timeout_seconds,
        )

    def request(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        method: str,
        headers: Mapping[str, str],
        json: object | None,
        body: bytes | None,
        max_response_bytes: int,
    ) -> ProviderResponse:
        if json is not None and body is not None:
            raise FamilyModelProviderTransportError("family_model_provider_request_invalid")
        request_body = body
        request_headers = dict(headers)
        if json is not None:
            try:
                request_body = json_module_bytes(json)
            except (TypeError, ValueError) as exc:
                raise FamilyModelProviderTransportError(
                    "family_model_provider_request_invalid"
                ) from exc
            request_headers.setdefault("Content-Type", "application/json")
        request_headers["Host"] = _host_header(endpoint)
        connection = self._connection(endpoint)
        try:
            connection.request(
                method.upper(), endpoint.base_path, body=request_body, headers=request_headers
            )
            response = connection.getresponse()
            return ProviderResponse(
                status_code=response.status,
                headers=dict(response.getheaders()),
                content=_bounded_read(response, max_bytes=max_response_bytes),
            )
        except FamilyModelProviderResponseTooLarge:
            raise
        except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
            raise FamilyModelProviderTransportError() from exc
        finally:
            connection.close()

    def download(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        max_bytes: int,
        allowed_content_types: frozenset[str],
    ) -> ProviderMedia:
        response = self.request(
            endpoint=endpoint,
            method="GET",
            headers={},
            json=None,
            body=None,
            max_response_bytes=max_bytes,
        )
        content_type = (response.header("content-type") or "").split(";", 1)[0].strip().lower()
        if content_type not in allowed_content_types:
            raise FamilyModelProviderMediaTypeBlocked()
        return ProviderMedia(content=response.content, content_type=content_type, endpoint=endpoint)


class EgressProxyHttpDialer:
    """Trusted deployment egress path; provider policy still runs before every send."""

    def __init__(self, settings: ProviderTransportSettings) -> None:
        self._settings = settings
        self._proxy_url = _validated_proxy_url(settings.egress_proxy_url)

    def request(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        method: str,
        headers: Mapping[str, str],
        json: object | None,
        body: bytes | None,
        max_response_bytes: int,
    ) -> ProviderResponse:
        if json is not None and body is not None:
            raise FamilyModelProviderTransportError("family_model_provider_request_invalid")
        try:
            with httpx.Client(
                proxy=self._proxy_url,
                follow_redirects=False,
                timeout=httpx.Timeout(
                    timeout=self._settings.request_timeout_seconds,
                    connect=self._settings.connect_timeout_seconds,
                ),
            ) as client, client.stream(
                method,
                endpoint.normalized_url,
                headers=dict(headers),
                json=json,
                content=body,
            ) as response:
                content_length = response.headers.get("content-length")
                if content_length is not None and int(content_length) > max_response_bytes:
                    raise FamilyModelProviderResponseTooLarge()
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > max_response_bytes:
                        raise FamilyModelProviderResponseTooLarge()
                    chunks.append(chunk)
                content = b"".join(chunks)
        except httpx.HTTPError as exc:
            raise FamilyModelProviderTransportError() from exc
        except ValueError as exc:
            raise FamilyModelProviderTransportError("family_model_provider_response_invalid") from exc
        return ProviderResponse(
            status_code=response.status_code,
            headers=dict(response.headers),
            content=content,
        )

    def download(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        max_bytes: int,
        allowed_content_types: frozenset[str],
    ) -> ProviderMedia:
        response = self.request(
            endpoint=endpoint,
            method="GET",
            headers={},
            json=None,
            body=None,
            max_response_bytes=max_bytes,
        )
        content_type = (response.header("content-type") or "").split(";", 1)[0].strip().lower()
        if content_type not in allowed_content_types:
            raise FamilyModelProviderMediaTypeBlocked()
        return ProviderMedia(content=response.content, content_type=content_type, endpoint=endpoint)


class PinnedWebSocketDialer:
    def __init__(self, settings: ProviderTransportSettings) -> None:
        self._settings = settings

    def connect(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        headers: Mapping[str, str],
        connect_timeout_seconds: float,
    ) -> object:
        raw_socket: socket.socket | None = None
        try:
            if self._settings.egress_proxy_url:
                return connect_websocket(
                    endpoint.normalized_url,
                    additional_headers=dict(headers),
                    proxy=_validated_proxy_url(self._settings.egress_proxy_url),
                    open_timeout=connect_timeout_seconds,
                )
            raw_socket = socket.create_connection(
                (endpoint.resolved_addresses[0], endpoint.port),
                timeout=connect_timeout_seconds,
            )
            return connect_websocket(
                endpoint.normalized_url,
                sock=raw_socket,
                server_hostname=endpoint.host if endpoint.scheme == "wss" else None,
                additional_headers=dict(headers),
                proxy=None,
                open_timeout=connect_timeout_seconds,
            )
        except (OSError, ssl.SSLError, WebSocketException) as exc:
            if raw_socket is not None:
                raw_socket.close()
            raise FamilyModelProviderTransportError() from exc


def json_module_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _validated_proxy_url(raw_url: str) -> str:
    if not raw_url:
        raise FamilyModelProviderTransportError("family_model_egress_proxy_missing")
    try:
        parsed = urlsplit(raw_url)
    except ValueError as exc:
        raise FamilyModelProviderTransportError("family_model_egress_proxy_invalid") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise FamilyModelProviderTransportError("family_model_egress_proxy_invalid")
    try:
        port = parsed.port
    except ValueError as exc:
        raise FamilyModelProviderTransportError("family_model_egress_proxy_invalid") from exc
    if port is not None and not 1 <= port <= 65535:
        raise FamilyModelProviderTransportError("family_model_egress_proxy_invalid")
    return raw_url


class ProviderTransport:
    def __init__(
        self,
        *,
        policy: ProviderNetworkPolicy,
        settings: ProviderTransportSettings,
        http_dialer: ProviderHttpDialer | None = None,
        websocket_dialer: ProviderWebSocketDialer | None = None,
    ) -> None:
        self.policy = policy
        self.settings = settings
        self.http_dialer = http_dialer or (
            EgressProxyHttpDialer(settings)
            if settings.egress_proxy_url
            else PinnedHttpDialer(settings)
        )
        self.websocket_dialer = websocket_dialer or PinnedWebSocketDialer(settings)

    @classmethod
    def from_settings(
        cls,
        settings: object,
        *,
        policy: ProviderNetworkPolicy | None = None,
    ) -> ProviderTransport:
        return cls(
            policy=policy or ProviderNetworkPolicy.from_settings(settings),
            settings=ProviderTransportSettings.from_settings(settings),
        )

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        json: object | None = None,
        body: bytes | None = None,
    ) -> ProviderResponse:
        if json is not None and body is not None:
            raise FamilyModelProviderTransportError("family_model_provider_request_invalid")
        endpoint = self.policy.authorize(url, protocol="http")
        response = self.http_dialer.request(
            endpoint=endpoint,
            method=method,
            headers=safe_headers(headers),
            json=json,
            body=body,
            max_response_bytes=self.settings.response_max_bytes,
        )
        if len(response.content) > self.settings.response_max_bytes:
            raise FamilyModelProviderResponseTooLarge()
        if 300 <= response.status_code < 400 and response.header("location"):
            location = urljoin(endpoint.normalized_url, response.header("location") or "")
            self.policy.authorize(location, protocol="http")
            raise FamilyModelEndpointBlocked()
        return response

    def connect_websocket(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
    ) -> object:
        endpoint = self.policy.authorize(url, protocol="websocket")
        return self.websocket_dialer.connect(
            endpoint=endpoint,
            headers=safe_headers(headers),
            connect_timeout_seconds=self.settings.connect_timeout_seconds,
        )

    def download_media(
        self,
        url: str,
        *,
        source: ResolvedProviderEndpoint,
        adapter_kind: str,
    ) -> ProviderMedia:
        endpoint = self.policy.authorize_media(
            url,
            source=source,
            adapter_kind=adapter_kind,
        )
        media = self.http_dialer.download(
            endpoint=endpoint,
            max_bytes=self.settings.media_max_bytes,
            allowed_content_types=ALLOWED_PROVIDER_MEDIA_TYPES,
        )
        if len(media.content) > self.settings.media_max_bytes:
            raise FamilyModelProviderResponseTooLarge()
        content_type = media.content_type.split(";", 1)[0].strip().lower()
        if content_type not in ALLOWED_PROVIDER_MEDIA_TYPES:
            raise FamilyModelProviderMediaTypeBlocked()
        return media


def provider_network_constructor_inventory(root: Path | None = None) -> list[str]:
    """Find raw provider clients outside the dedicated transport module.

    This deliberately scopes the Task 3 gate to the new family-settings domain;
    legacy runtime modules are moved one capability at a time in Tasks 7–11.
    """

    source_root = root or Path(__file__).resolve().parent
    if not source_root.is_dir():
        raise ValueError("family_model_provider_inventory_root_invalid")
    violations: list[str] = []
    for source in sorted(source_root.rglob("*.py")):
        if source.name == "transport.py":
            continue
        try:
            tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        except (OSError, SyntaxError) as exc:
            raise ValueError("family_model_provider_inventory_parse_failed") from exc
        relative = source.relative_to(source_root).as_posix()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            rendered = _attribute_path(node.func)
            if rendered in {
                "httpx.Client",
                "httpx.AsyncClient",
                "websockets.connect",
                "requests.get",
                "requests.post",
                "requests.request",
                "OpenAI",
                "AsyncOpenAI",
            }:
                violations.append(f"{relative}:{rendered}")
    return sorted(violations)


def _attribute_path(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = _attribute_path(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""
