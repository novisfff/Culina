from __future__ import annotations

import socket
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from app.services.family_model_settings.errors import (
    FamilyModelEndpointBlocked,
    FamilyModelNetworkPolicyConfigurationError,
)
from app.services.family_model_settings.network_policy import (
    NetworkProtocol,
    ProviderNetworkPolicy,
    SystemAddressResolver,
    decode_private_target_allowlist,
)


@dataclass
class FakeResolver:
    answers: tuple[str, ...] = ("93.184.216.34",)

    def resolve_all(self, host: str) -> tuple[str, ...]:
        del host
        return self.answers


@pytest.mark.parametrize("ipv6_first", [False, True])
def test_system_dns_preference_survives_authorization(monkeypatch, ipv6_first: bool) -> None:
    # getaddrinfo ranks routes for the host; lexical sorting can prefer an
    # unreachable IPv6 route on an IPv4-only Docker network.
    ipv4 = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))
    ipv6 = (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 0, 0, 0))
    ordered = [ipv6, ipv4] if ipv6_first else [ipv4, ipv6]
    monkeypatch.setattr(socket, "getaddrinfo", lambda *args, **kwargs: ordered + ordered)
    policy = ProviderNetworkPolicy(resolver=SystemAddressResolver())

    endpoint = policy.authorize("https://provider.example/v1", protocol="http")

    assert endpoint.resolved_addresses == tuple(info[4][0] for info in ordered)


def test_preferred_public_address_does_not_hide_unsafe_dns_answers() -> None:
    policy = ProviderNetworkPolicy(resolver=FakeResolver(("93.184.216.34", "127.0.0.1")))

    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize("https://provider.example/v1", protocol="http")


@pytest.fixture()
def resolver() -> FakeResolver:
    return FakeResolver()


@pytest.fixture()
def policy(resolver: FakeResolver) -> ProviderNetworkPolicy:
    return ProviderNetworkPolicy(
        resolver=resolver,
        private_target_allowlist=decode_private_target_allowlist(
            SecretStr(
                """
                {
                  "http": [{
                    "host": "ollama.internal",
                    "port": 11434,
                    "cidrs": ["10.20.0.0/16"]
                  }],
                  "websocket": [{
                    "host": "voice.internal",
                    "port": 8443,
                    "cidrs": ["10.21.0.0/16"]
                  }]
                }
                """
            )
        ),
    )


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "https://user:pass@example.com/v1",
        "https://example.com/v1#fragment",
        "http://public.example.com/v1",
        "https://127.0.0.1/v1",
        "https://[::1]/v1",
        "https://169.254.169.254/latest/meta-data",
        "https://例子.测试/v1",
    ],
)
def test_endpoint_policy_blocks_unsafe_targets(policy: ProviderNetworkPolicy, url: str) -> None:
    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize(url, protocol="http")


@pytest.mark.parametrize("region", ["bj", "sh", "wlcb", "sz"])
@pytest.mark.parametrize("scheme", ["http", "https"])
def test_dashscope_signed_media_uses_exact_official_host_over_https(
    policy: ProviderNetworkPolicy, region: str, scheme: str,
) -> None:
    regions = {"bj": "beijing", "sh": "shanghai", "wlcb": "wulanchabu", "sz": "shenzhen"}
    host = f"dashscope-result-{region}.oss-cn-{regions[region]}.aliyuncs.com"
    source = policy.authorize("https://dashscope.aliyuncs.com/api/v1", protocol="http")
    query = "Expires=123&OSSAccessKeyId=fake&Signature=A%2B%2F%3D"
    endpoint = policy.authorize_media(
        f"{scheme}://{host}/result/file.png?{query}", source=source, adapter_kind="dashscope",
    )
    assert endpoint.normalized_url == f"https://{host}/result/file.png?{query}"
    assert endpoint.base_path == f"/result/file.png?{query}"
    assert endpoint.resolved_addresses == ("93.184.216.34",)


@pytest.mark.parametrize('scheme', ['http', 'https'])
def test_dashscope_accelerated_media_preserves_signed_query_over_https(policy, scheme):
    source = policy.authorize('https://dashscope.aliyuncs.com/api/v1', protocol='http')
    query = 'Expires=123&Signature=A%2B%2F%3D'
    endpoint = policy.authorize_media(f'{scheme}://dashscope-0484.oss-accelerate.aliyuncs.com/result.png?{query}',
        source=source, adapter_kind='dashscope')
    assert endpoint.normalized_url == f'https://dashscope-0484.oss-accelerate.aliyuncs.com/result.png?{query}'
    assert endpoint.base_path == f'/result.png?{query}'
    assert endpoint.resolved_addresses == ('93.184.216.34',)


@pytest.mark.parametrize("url", [
    "https://dashscope-0484.oss-accelerate.aliyuncs.com.evil.example/a.png",
    "https://dashscope-9999.oss-accelerate.aliyuncs.com/a.png",
    "https://other-bucket.oss-accelerate.aliyuncs.com/a.png",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/a.png?Signature=fake",
    "https://other-bucket.oss-cn-beijing.aliyuncs.com/a.png?Signature=fake",
    "http://user@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.png",
    "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8080/a.png",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.png#fragment",
    "http://[invalid",
    "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a\n.png?Signature=fake",
])
def test_media_host_allowlist_does_not_accept_spoofs_or_invalid_urls(
    policy: ProviderNetworkPolicy, url: str,
) -> None:
    source = policy.authorize("https://dashscope.aliyuncs.com/api/v1", protocol="http")
    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize_media(url, source=source, adapter_kind="dashscope")


@pytest.mark.parametrize('host', ['dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 'dashscope-0484.oss-accelerate.aliyuncs.com'])
@pytest.mark.parametrize("addresses", [("127.0.0.1",), ("93.184.216.34", "169.254.169.254"), ("10.20.0.4",)])
def test_declared_media_host_still_requires_safe_dns_answers(
    policy: ProviderNetworkPolicy, resolver: FakeResolver, addresses: tuple[str, ...], host: str,
) -> None:
    source = policy.authorize("https://dashscope.aliyuncs.com/api/v1", protocol="http")
    resolver.answers = addresses
    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize_media(
            f"http://{host}/a.wav?Signature=fake",
            source=source, adapter_kind="dashscope",
        )


def test_configured_base_urls_still_reject_query_parameters(policy: ProviderNetworkPolicy) -> None:
    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize("https://provider.example/v1?key=fake", protocol="http")


@pytest.mark.parametrize(
    ("url", "protocol", "resolved_addresses", "expected_code"),
    [
        (
            "not-a-url",
            "http",
            ("93.184.216.34",),
            "family_model_endpoint_url_invalid",
        ),
        (
            "wss://47.93.215.184:31317/v1",
            "http",
            ("93.184.216.34",),
            "family_model_endpoint_protocol_mismatch",
        ),
        (
            "https://provider.example/v1",
            "http",
            (),
            "family_model_endpoint_dns_resolution_failed",
        ),
        (
            "https://127.0.0.1/v1",
            "http",
            ("93.184.216.34",),
            "family_model_endpoint_address_forbidden",
        ),
        (
            "https://10.20.0.8:11434/v1",
            "http",
            ("93.184.216.34",),
            "family_model_endpoint_private_target_not_allowed",
        ),
        (
            "http://47.93.215.184:31317/v1",
            "http",
            ("93.184.216.34",),
            "family_model_endpoint_insecure_transport_not_allowed",
        ),
        (
            "ws://47.93.215.184:31317/v1",
            "websocket",
            ("93.184.216.34",),
            "family_model_endpoint_insecure_transport_not_allowed",
        ),
    ],
)
def test_endpoint_policy_reports_a_safe_actionable_reason_code(
    url: str,
    protocol: NetworkProtocol,
    resolved_addresses: tuple[str, ...],
    expected_code: str,
) -> None:
    policy = ProviderNetworkPolicy(resolver=FakeResolver(resolved_addresses))

    with pytest.raises(FamilyModelEndpointBlocked) as caught:
        policy.authorize(url, protocol=protocol)

    assert caught.value.code == expected_code


@pytest.mark.parametrize(
    ("url", "protocol"),
    [
        ("http://47.93.215.184:31317/v1", "http"),
        ("ws://47.93.215.184:31317/v1", "websocket"),
    ],
)
def test_cleartext_public_transports_are_blocked_by_default(
    url: str,
    protocol: NetworkProtocol,
) -> None:
    with pytest.raises(FamilyModelEndpointBlocked):
        ProviderNetworkPolicy().authorize(url, protocol=protocol)


@pytest.mark.parametrize(
    ("url", "protocol"),
    [
        ("http://47.93.215.184:31317/v1", "http"),
        ("ws://47.93.215.184:31317/v1", "websocket"),
    ],
)
def test_explicit_insecure_public_transport_switch_allows_cleartext_public_transport(
    url: str,
    protocol: NetworkProtocol,
) -> None:
    policy = ProviderNetworkPolicy(allow_insecure_public_transports=True)

    endpoint = policy.authorize(url, protocol=protocol)

    assert endpoint.normalized_url == url
    assert endpoint.private_target is False


def test_insecure_public_transport_switch_is_loaded_from_settings() -> None:
    settings = SimpleNamespace(
        family_model_private_target_allowlist_json=SecretStr(
            '{"http":[],"websocket":[]}'
        ),
        family_model_allow_insecure_public_transports=True,
    )

    endpoint = ProviderNetworkPolicy.from_settings(settings).authorize(
        "ws://47.93.215.184:31317/v1",
        protocol="websocket",
    )

    assert endpoint.normalized_url == "ws://47.93.215.184:31317/v1"


@pytest.mark.parametrize(
    ("url", "protocol"),
    [
        ("http://127.0.0.1:8010/v1", "http"),
        ("http://169.254.169.254/latest/meta-data", "http"),
        ("http://10.20.0.8:11434/v1", "http"),
        ("http://100.64.0.1:8080/v1", "http"),
        ("ws://127.0.0.1:8010/v1", "websocket"),
        ("ws://169.254.169.254/latest/meta-data", "websocket"),
        ("ws://10.20.0.8:11434/v1", "websocket"),
        ("ws://100.64.0.1:8080/v1", "websocket"),
    ],
)
def test_insecure_public_transport_switch_keeps_non_public_targets_blocked(
    url: str,
    protocol: NetworkProtocol,
) -> None:
    policy = ProviderNetworkPolicy(allow_insecure_public_transports=True)

    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize(url, protocol=protocol)


def test_allowlisted_private_http_requires_every_dns_answer_to_match(
    policy: ProviderNetworkPolicy,
    resolver: FakeResolver,
) -> None:
    resolver.answers = ("10.20.0.8", "93.184.216.34")

    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize("http://ollama.internal:11434/v1", protocol="http")


def test_allowlisted_private_http_returns_a_normalized_pinned_endpoint(
    policy: ProviderNetworkPolicy,
    resolver: FakeResolver,
) -> None:
    resolver.answers = ("10.20.0.8", "10.20.0.7")

    endpoint = policy.authorize("http://ollama.internal:11434/v1/", protocol="http")

    assert endpoint.normalized_url == "http://ollama.internal:11434/v1/"
    assert endpoint.host == "ollama.internal"
    assert endpoint.port == 11434
    assert endpoint.resolved_addresses == ("10.20.0.8", "10.20.0.7")
    assert endpoint.private_target is True


def test_public_host_is_rejected_when_any_dns_answer_is_non_public(
    policy: ProviderNetworkPolicy,
    resolver: FakeResolver,
) -> None:
    resolver.answers = ("93.184.216.34", "10.20.0.8")

    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize("https://provider.example/v1", protocol="http")


def test_websocket_private_targets_require_the_separate_websocket_allowlist(
    policy: ProviderNetworkPolicy,
    resolver: FakeResolver,
) -> None:
    resolver.answers = ("10.21.0.9",)
    endpoint = policy.authorize("ws://voice.internal:8443/v1", protocol="websocket")

    assert endpoint.private_target is True
    with pytest.raises(FamilyModelEndpointBlocked):
        policy.authorize("http://voice.internal:8443/v1", protocol="http")


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        '{"http": []}',
        '{"http": [{"host": "a", "port": 0, "cidrs": []}], "websocket": []}',
        '{"http": [{"host": "a", "port": 80, "cidrs": ["not-a-cidr"]}], "websocket": []}',
        '{"http": [{"host": "a", "port": 80, "cidrs": ["0.0.0.0/0"]}], "websocket": []}',
    ],
)
def test_private_target_allowlist_is_strictly_decoded(raw: str) -> None:
    with pytest.raises(FamilyModelNetworkPolicyConfigurationError):
        decode_private_target_allowlist(SecretStr(raw))
