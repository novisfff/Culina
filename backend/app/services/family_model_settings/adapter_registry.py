from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

from app.services.family_model_settings.errors import FamilyModelProviderProtocolUnsupported
from app.services.family_model_settings.types import (
    FamilyModelAdapterKind,
    FamilyModelAuthMode,
    FamilyModelCapability,
    ResolvedProviderEndpoint,
)


@dataclass(frozen=True, slots=True)
class AdapterDefinition:
    kind: FamilyModelAdapterKind
    capabilities: frozenset[FamilyModelCapability]
    auth_modes: frozenset[FamilyModelAuthMode]
    http_protocols: frozenset[str]
    billing_schemes: Mapping[FamilyModelCapability, tuple[str, ...]]
    free_probe_path: str | None
    media_host_policy: Literal["same_origin", "dashscope_declared_hosts", "inline_only"]
    declared_media_hosts: frozenset[str] = frozenset()

    def supports(
        self,
        *,
        capability: str,
        auth_mode: str,
        billing_scheme_key: str | None = None,
    ) -> bool:
        if capability not in self.capabilities or auth_mode not in self.auth_modes:
            return False
        if billing_scheme_key is None:
            return True
        return billing_scheme_key in self.billing_schemes.get(capability, ())


def _definition(
    *,
    kind: FamilyModelAdapterKind,
    capabilities: frozenset[FamilyModelCapability],
    auth_modes: frozenset[FamilyModelAuthMode],
    http_protocols: frozenset[str],
    billing_schemes: Mapping[FamilyModelCapability, tuple[str, ...]],
    free_probe_path: str | None,
    media_host_policy: Literal["same_origin", "dashscope_declared_hosts", "inline_only"],
    declared_media_hosts: frozenset[str] = frozenset(),
) -> AdapterDefinition:
    return AdapterDefinition(
        kind=kind,
        capabilities=capabilities,
        auth_modes=auth_modes,
        http_protocols=http_protocols,
        billing_schemes=MappingProxyType(dict(billing_schemes)),
        free_probe_path=free_probe_path,
        media_host_policy=media_host_policy,
        declared_media_hosts=declared_media_hosts,
    )


_HTTP_CAPABILITIES = frozenset(
    {"llm", "image_generation", "stt", "tts", "embedding", "rerank"}
)
_HTTP_BILLING_SCHEMES: Mapping[FamilyModelCapability, tuple[str, ...]] = MappingProxyType(
    {
        "llm": ("llm-split-v1",),
        "image_generation": ("image-count-v1",),
        "stt": ("stt-seconds-v1",),
        "tts": ("tts-characters-v1",),
        "embedding": ("embedding-token-v1",),
        "rerank": ("rerank-token-v1",),
    }
)
_REALTIME_BILLING_SCHEMES: Mapping[FamilyModelCapability, tuple[str, ...]] = MappingProxyType(
    {"realtime_audio": ("realtime-asr-seconds-tts-characters-v1",)}
)
DASHSCOPE_API_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"
DASHSCOPE_WEBSOCKET_BASE_URL = "wss://dashscope.aliyuncs.com/api-ws/v1"

_ADAPTERS: Mapping[FamilyModelAdapterKind, AdapterDefinition] = MappingProxyType(
    {
        "openai_compatible_http": _definition(
            kind="openai_compatible_http",
            capabilities=_HTTP_CAPABILITIES,
            auth_modes=frozenset({"api_key", "no_auth"}),
            http_protocols=frozenset({"https", "http"}),
            billing_schemes=_HTTP_BILLING_SCHEMES,
            free_probe_path="/models",
            media_host_policy="same_origin",
        ),
        "dashscope": _definition(
            kind="dashscope",
            capabilities=frozenset(
                {
                    "llm",
                    "image_generation",
                    "stt",
                    "tts",
                    "realtime_audio",
                    "embedding",
                    "rerank",
                }
            ),
            auth_modes=frozenset({"api_key"}),
            http_protocols=frozenset({"https", "wss"}),
            billing_schemes={
                **_HTTP_BILLING_SCHEMES,
                "realtime_audio": _REALTIME_BILLING_SCHEMES["realtime_audio"],
            },
            free_probe_path=None,
            media_host_policy="dashscope_declared_hosts",
            declared_media_hosts=frozenset({"dashscope.aliyuncs.com"}),
        ),
        "openai_realtime": _definition(
            kind="openai_realtime",
            capabilities=frozenset({"realtime_audio"}),
            auth_modes=frozenset({"api_key"}),
            http_protocols=frozenset({"wss"}),
            billing_schemes=_REALTIME_BILLING_SCHEMES,
            free_probe_path=None,
            media_host_policy="inline_only",
        ),
    }
)


def adapter_definition(kind: str) -> AdapterDefinition:
    try:
        return _ADAPTERS[kind]  # type: ignore[index]
    except KeyError as exc:
        raise FamilyModelProviderProtocolUnsupported() from exc


def require_adapter_support(
    *,
    kind: str,
    capability: str,
    auth_mode: str,
    billing_scheme_key: str | None = None,
) -> AdapterDefinition:
    definition = adapter_definition(kind)
    if not definition.supports(
        capability=capability,
        auth_mode=auth_mode,
        billing_scheme_key=billing_scheme_key,
    ):
        raise FamilyModelProviderProtocolUnsupported()
    return definition


def require_adapter_endpoint_contract(
    *,
    kind: str,
    auth_mode: str,
    endpoint: ResolvedProviderEndpoint,
) -> AdapterDefinition:
    """Enforce endpoint/auth restrictions that a client-owned draft cannot relax."""

    definition = adapter_definition(kind)
    if auth_mode not in definition.auth_modes:
        raise FamilyModelProviderProtocolUnsupported()
    if endpoint.scheme not in definition.http_protocols:
        raise FamilyModelProviderProtocolUnsupported()
    if auth_mode == "no_auth" and (
        kind != "openai_compatible_http" or not endpoint.private_target
    ):
        raise FamilyModelProviderProtocolUnsupported()
    return definition
