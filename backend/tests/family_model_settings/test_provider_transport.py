from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import certifi
import pytest
from pydantic import SecretStr

from app.services.family_model_settings.errors import (
    FamilyModelEndpointBlocked,
    FamilyModelProviderResponseTooLarge,
)
from app.services.family_model_settings.network_policy import (
    ProviderNetworkPolicy,
    decode_private_target_allowlist,
)
from app.services.family_model_settings.transport import (
    _PinnedHTTPSConnection,
    ProviderMedia,
    ProviderResponse,
    ProviderTransport,
    ProviderTransportSettings,
    provider_network_constructor_inventory,
)
from app.services.family_model_settings.types import ResolvedProviderEndpoint


@dataclass
class FakeResolver:
    answers: tuple[str, ...] = ("93.184.216.34",)

    def resolve_all(self, host: str) -> tuple[str, ...]:
        del host
        return self.answers


@dataclass
class FakeHttpDialer:
    responses: list[ProviderResponse] = field(default_factory=list)
    connected_ips: list[str] = field(default_factory=list)

    def request(
        self,
        *,
        endpoint,
        method: str,
        headers,
        json,
        body,
        max_response_bytes: int,
    ) -> ProviderResponse:
        del method, headers, json, body, max_response_bytes
        self.connected_ips.append(endpoint.resolved_addresses[0])
        return self.responses.pop(0) if self.responses else ProviderResponse(200, {}, b"{}")

    def download(self, *, endpoint, max_bytes: int, allowed_content_types) -> ProviderMedia:
        del max_bytes, allowed_content_types
        self.connected_ips.append(endpoint.resolved_addresses[0])
        return ProviderMedia(content=b"image", content_type="image/png", endpoint=endpoint)


@dataclass
class FakeWebSocketDialer:
    connected_ips: list[str] = field(default_factory=list)

    def connect(self, *, endpoint, headers, connect_timeout_seconds: float):
        del headers, connect_timeout_seconds
        self.connected_ips.append(endpoint.resolved_addresses[0])
        return {"connected": endpoint.normalized_url}


@pytest.fixture()
def resolver() -> FakeResolver:
    return FakeResolver()


@pytest.fixture()
def transport(resolver: FakeResolver) -> ProviderTransport:
    policy = ProviderNetworkPolicy(
        resolver=resolver,
        private_target_allowlist=decode_private_target_allowlist(
            SecretStr('{"http": [], "websocket": []}')
        ),
    )
    return ProviderTransport(
        policy=policy,
        http_dialer=FakeHttpDialer(),
        websocket_dialer=FakeWebSocketDialer(),
        settings=ProviderTransportSettings(
            connect_timeout_seconds=1,
            request_timeout_seconds=2,
            response_max_bytes=8,
            media_max_bytes=16,
            redirect_limit=0,
        ),
    )


def test_transport_reauthorizes_before_each_connect(
    transport: ProviderTransport,
    resolver: FakeResolver,
) -> None:
    http_dialer = transport.http_dialer
    resolver.answers = ("93.184.216.34",)

    transport.request("POST", "https://provider.example/v1/chat", headers={}, json={})
    resolver.answers = ("127.0.0.1",)

    with pytest.raises(FamilyModelEndpointBlocked):
        transport.request("POST", "https://provider.example/v1/chat", headers={}, json={})

    assert http_dialer.connected_ips == ["93.184.216.34"]


def test_redirect_is_not_followed_without_a_new_validated_policy(
    transport: ProviderTransport,
) -> None:
    transport.http_dialer.responses.append(
        ProviderResponse(302, {"location": "http://169.254.169.254/latest"}, b"")
    )

    with pytest.raises(FamilyModelEndpointBlocked):
        transport.request("GET", "https://provider.example/models", headers={})


def test_transport_rejects_response_larger_than_the_configured_bound(
    transport: ProviderTransport,
) -> None:
    transport.http_dialer.responses.append(ProviderResponse(200, {}, b"012345678"))

    with pytest.raises(FamilyModelProviderResponseTooLarge):
        transport.request("GET", "https://provider.example/models", headers={})


def test_media_download_requires_the_adapter_media_host_policy(transport: ProviderTransport) -> None:
    source = transport.policy.authorize("https://provider.example/v1/images", protocol="http")

    media = transport.download_media(
        "https://provider.example/v1/image.png",
        source=source,
        adapter_kind="openai_compatible_http",
    )

    assert media.content == b"image"
    with pytest.raises(FamilyModelEndpointBlocked):
        transport.download_media(
            "https://other.example/image.png",
            source=source,
            adapter_kind="openai_compatible_http",
        )


def test_websocket_uses_the_same_fresh_authorization_boundary(
    transport: ProviderTransport,
    resolver: FakeResolver,
) -> None:
    websocket_dialer = transport.websocket_dialer
    resolver.answers = ("93.184.216.34",)

    connection = transport.connect_websocket("wss://provider.example/realtime", headers={})

    assert connection == {"connected": "wss://provider.example/realtime"}
    assert websocket_dialer.connected_ips == ["93.184.216.34"]


def test_model_configuration_modules_cannot_bypass_the_shared_transport() -> None:
    assert provider_network_constructor_inventory() == []


def test_network_constructor_inventory_reports_unapproved_sources(tmp_path: Path) -> None:
    source = tmp_path / "unsafe_adapter.py"
    source.write_text("import httpx\nhttpx.Client()\n", encoding="utf-8")

    assert provider_network_constructor_inventory(root=tmp_path) == ["unsafe_adapter.py:httpx.Client"]


def test_pinned_https_connection_uses_certifi_ca_bundle(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    def fake_create_default_context(*, cafile: str | None = None):
        captured["cafile"] = cafile
        return object()

    monkeypatch.setattr(
        "app.services.family_model_settings.transport.ssl.create_default_context",
        fake_create_default_context,
    )

    _PinnedHTTPSConnection(
        ResolvedProviderEndpoint(
            normalized_url="https://provider.example/v1",
            scheme="https",
            host="provider.example",
            port=443,
            base_path="/v1",
            resolved_addresses=("93.184.216.34",),
            private_target=False,
        ),
        connect_timeout=1,
        request_timeout=2,
    )

    assert captured == {"cafile": certifi.where()}
