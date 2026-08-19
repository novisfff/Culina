from __future__ import annotations

from dataclasses import dataclass

import pytest
from pydantic import SecretStr

from app.services.family_model_settings.errors import (
    FamilyModelEndpointBlocked,
    FamilyModelNetworkPolicyConfigurationError,
)
from app.services.family_model_settings.network_policy import (
    ProviderNetworkPolicy,
    decode_private_target_allowlist,
)


@dataclass
class FakeResolver:
    answers: tuple[str, ...] = ("93.184.216.34",)

    def resolve_all(self, host: str) -> tuple[str, ...]:
        del host
        return self.answers


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
    assert endpoint.resolved_addresses == ("10.20.0.7", "10.20.0.8")
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
