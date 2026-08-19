from __future__ import annotations

import ipaddress
import json
import socket
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal, Protocol
from urllib.parse import urlsplit

from pydantic import SecretStr

from app.services.family_model_settings.adapter_registry import adapter_definition
from app.services.family_model_settings.errors import (
    FamilyModelEndpointBlocked,
    FamilyModelNetworkPolicyConfigurationError,
)
from app.services.family_model_settings.types import ResolvedProviderEndpoint


NetworkProtocol = Literal["http", "websocket"]
_DEFAULT_PORTS = {"https": 443, "http": 80, "wss": 443, "ws": 80}
_FORBIDDEN_ADDRESS_CLASSES = frozenset(
    {
        "loopback",
        "link_local",
        "multicast",
        "unspecified",
        "reserved",
        "carrier_grade_nat",
    }
)


class AddressResolver(Protocol):
    def resolve_all(self, host: str) -> tuple[str, ...]: ...


class SystemAddressResolver:
    def resolve_all(self, host: str) -> tuple[str, ...]:
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None:
            return (str(literal),)
        try:
            infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        except OSError:
            return ()
        return tuple(sorted({str(info[4][0]) for info in infos}))


@dataclass(frozen=True, slots=True)
class PrivateTargetAllowlistRule:
    host: str
    port: int
    cidrs: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]

    def matches(self, *, host: str, port: int, addresses: Sequence[str]) -> bool:
        if self.host != host or self.port != port:
            return False
        return all(
            any(ipaddress.ip_address(address) in network for network in self.cidrs)
            for address in addresses
        )


@dataclass(frozen=True, slots=True)
class PrivateTargetAllowlist:
    rules: Mapping[NetworkProtocol, tuple[PrivateTargetAllowlistRule, ...]]

    def require_exact_match(
        self,
        *,
        endpoint: ResolvedProviderEndpoint,
        protocol: NetworkProtocol,
    ) -> None:
        if any(
            rule.matches(
                host=endpoint.host,
                port=endpoint.port,
                addresses=endpoint.resolved_addresses,
            )
            for rule in self.rules[protocol]
        ):
            return
        raise FamilyModelEndpointBlocked()


@dataclass(frozen=True, slots=True)
class _ParsedProviderUrl:
    scheme: Literal["https", "http", "wss", "ws"]
    host: str
    port: int
    base_path: str
    normalized_url: str


def _blocked() -> FamilyModelEndpointBlocked:
    return FamilyModelEndpointBlocked()


def _normalize_host(host: str) -> str:
    candidate = host.rstrip(".").lower()
    if not candidate or "%" in candidate or any(ord(character) > 127 for character in candidate):
        raise _blocked()
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        pass
    if any(character in candidate for character in " /\\@?#:"):
        raise _blocked()
    try:
        normalized = candidate.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise _blocked() from exc
    if not normalized or len(normalized) > 253 or any(not label for label in normalized.split(".")):
        raise _blocked()
    return normalized


def _authority(host: str, port: int, scheme: str) -> str:
    rendered_host = f"[{host}]" if ":" in host else host
    if port == _DEFAULT_PORTS[scheme]:
        return rendered_host
    return f"{rendered_host}:{port}"


def parse_and_normalize_provider_url(raw_url: str) -> _ParsedProviderUrl:
    if not isinstance(raw_url, str) or not raw_url or any(
        character.isspace() or ord(character) < 32 for character in raw_url
    ):
        raise _blocked()
    try:
        parsed = urlsplit(raw_url)
        port = parsed.port
    except ValueError as exc:
        raise _blocked() from exc
    scheme = parsed.scheme.lower()
    if scheme not in _DEFAULT_PORTS or not parsed.netloc:
        raise _blocked()
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise _blocked()
    if parsed.query or parsed.fragment or parsed.hostname is None:
        raise _blocked()
    host = _normalize_host(parsed.hostname)
    normalized_port = port if port is not None else _DEFAULT_PORTS[scheme]
    if not 1 <= normalized_port <= 65535:
        raise _blocked()
    base_path = parsed.path or "/"
    if not base_path.startswith("/") or "\\" in base_path:
        raise _blocked()
    normalized_url = f"{scheme}://{_authority(host, normalized_port, scheme)}{base_path}"
    return _ParsedProviderUrl(
        scheme=scheme,  # type: ignore[arg-type]
        host=host,
        port=normalized_port,
        base_path=base_path,
        normalized_url=normalized_url,
    )


def classify_ip(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str:
    if address.is_loopback:
        return "loopback"
    if address.is_link_local:
        return "link_local"
    if address.is_multicast:
        return "multicast"
    if address.is_unspecified:
        return "unspecified"
    if address.is_reserved:
        return "reserved"
    if address.version == 4 and address in ipaddress.ip_network("100.64.0.0/10"):
        return "carrier_grade_nat"
    if address.is_private:
        return "private"
    return "public"


def _decode_rule(value: object) -> PrivateTargetAllowlistRule:
    if not isinstance(value, dict) or set(value) != {"host", "port", "cidrs"}:
        raise FamilyModelNetworkPolicyConfigurationError()
    raw_host = value["host"]
    raw_port = value["port"]
    raw_cidrs = value["cidrs"]
    if (
        not isinstance(raw_host, str)
        or isinstance(raw_port, bool)
        or not isinstance(raw_port, int)
        or not 1 <= raw_port <= 65535
        or not isinstance(raw_cidrs, list)
        or not raw_cidrs
    ):
        raise FamilyModelNetworkPolicyConfigurationError()
    try:
        cidrs = tuple(ipaddress.ip_network(value, strict=True) for value in raw_cidrs)
    except (TypeError, ValueError) as exc:
        raise FamilyModelNetworkPolicyConfigurationError() from exc
    if not all(isinstance(value, str) for value in raw_cidrs):
        raise FamilyModelNetworkPolicyConfigurationError()
    if any(classify_ip(network.network_address) != "private" for network in cidrs):
        raise FamilyModelNetworkPolicyConfigurationError()
    try:
        host = _normalize_host(raw_host)
    except FamilyModelEndpointBlocked as exc:
        raise FamilyModelNetworkPolicyConfigurationError() from exc
    return PrivateTargetAllowlistRule(host=host, port=raw_port, cidrs=cidrs)


def decode_private_target_allowlist(raw: SecretStr) -> PrivateTargetAllowlist:
    """Strictly decode deployment-owned HTTP/WebSocket private target rules."""

    try:
        payload = json.loads(raw.get_secret_value())
    except json.JSONDecodeError as exc:
        raise FamilyModelNetworkPolicyConfigurationError() from exc
    if not isinstance(payload, dict) or set(payload) != {"http", "websocket"}:
        raise FamilyModelNetworkPolicyConfigurationError()
    decoded: dict[NetworkProtocol, tuple[PrivateTargetAllowlistRule, ...]] = {}
    for protocol in ("http", "websocket"):
        entries = payload[protocol]
        if not isinstance(entries, list):
            raise FamilyModelNetworkPolicyConfigurationError()
        decoded[protocol] = tuple(_decode_rule(entry) for entry in entries)
    return PrivateTargetAllowlist(rules=MappingProxyType(decoded))


class ProviderNetworkPolicy:
    def __init__(
        self,
        *,
        resolver: AddressResolver | None = None,
        private_target_allowlist: PrivateTargetAllowlist | None = None,
    ) -> None:
        self.resolver = resolver or SystemAddressResolver()
        self.private_target_allowlist = private_target_allowlist or decode_private_target_allowlist(
            SecretStr('{"http":[],"websocket":[]}')
        )

    @classmethod
    def from_settings(cls, settings: object, *, resolver: AddressResolver | None = None) -> ProviderNetworkPolicy:
        return cls(
            resolver=resolver,
            private_target_allowlist=decode_private_target_allowlist(
                getattr(settings, "family_model_private_target_allowlist_json")
            ),
        )

    def authorize(
        self,
        raw_url: str,
        *,
        protocol: NetworkProtocol,
    ) -> ResolvedProviderEndpoint:
        parsed = parse_and_normalize_provider_url(raw_url)
        if protocol == "http" and parsed.scheme not in {"http", "https"}:
            raise _blocked()
        if protocol == "websocket" and parsed.scheme not in {"ws", "wss"}:
            raise _blocked()
        try:
            literal_address = ipaddress.ip_address(parsed.host)
        except ValueError:
            resolved_values = self.resolver.resolve_all(parsed.host)
        else:
            # A literal address is already the target.  Never hand it to a DNS
            # resolver that could substitute an unrelated public answer.
            resolved_values = (str(literal_address),)
        try:
            addresses = tuple(
                sorted({str(ipaddress.ip_address(value)) for value in resolved_values})
            )
        except ValueError as exc:
            raise _blocked() from exc
        if not addresses:
            raise _blocked()
        classes = tuple(classify_ip(ipaddress.ip_address(address)) for address in addresses)
        if any(address_class in _FORBIDDEN_ADDRESS_CLASSES for address_class in classes):
            raise _blocked()
        private_target = any(address_class == "private" for address_class in classes)
        endpoint = ResolvedProviderEndpoint(
            normalized_url=parsed.normalized_url,
            scheme=parsed.scheme,
            host=parsed.host,
            port=parsed.port,
            base_path=parsed.base_path,
            resolved_addresses=addresses,
            private_target=private_target,
        )
        if private_target:
            self.private_target_allowlist.require_exact_match(endpoint=endpoint, protocol=protocol)
        elif parsed.scheme in {"http", "ws"}:
            raise _blocked()
        return endpoint

    def authorize_media(
        self,
        raw_url: str,
        *,
        source: ResolvedProviderEndpoint,
        adapter_kind: str,
    ) -> ResolvedProviderEndpoint:
        definition = adapter_definition(adapter_kind)
        if definition.media_host_policy == "inline_only":
            raise _blocked()
        endpoint = self.authorize(raw_url, protocol="http")
        same_origin = (
            endpoint.scheme == source.scheme
            and endpoint.host == source.host
            and endpoint.port == source.port
        )
        if definition.media_host_policy == "same_origin":
            if not same_origin:
                raise _blocked()
            return endpoint
        if same_origin or endpoint.host in definition.declared_media_hosts:
            return endpoint
        raise _blocked()
