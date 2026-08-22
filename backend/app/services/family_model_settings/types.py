from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal


FamilyModelCapability = Literal[
    "llm",
    "image_generation",
    "stt",
    "tts",
    "realtime_audio",
    "embedding",
    "rerank",
]
FamilyModelAdapterKind = Literal[
    "openai_compatible_http",
    "openai_realtime",
    "dashscope_http",
    "dashscope_realtime",
]
FamilyModelAuthMode = Literal["api_key", "no_auth"]


@dataclass(frozen=True, slots=True)
class ResolvedProviderEndpoint:
    normalized_url: str
    scheme: Literal["https", "http", "wss", "ws"]
    host: str
    port: int
    base_path: str
    resolved_addresses: tuple[str, ...]
    private_target: bool


@dataclass(frozen=True, slots=True)
class CapabilityBindingIdentity:
    """Stable identity for one capability binding in an immutable revision."""

    capability: FamilyModelCapability
    variant_key: str


@dataclass(frozen=True, slots=True)
class ResolvedCapabilityBinding:
    """Provider metadata resolved from one family-owned config revision.

    This intentionally carries no credential plaintext.  Callers must first
    obtain a durable dispatch permit and then call
    ``FamilyModelConfigurationResolver.resolve_dispatch_credential`` with the
    secret version pinned by that permit.
    """

    family_id: str
    config_revision_id: str
    provider_profile_id: str
    provider_profile_version_id: str
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    endpoint: ResolvedProviderEndpoint
    websocket_endpoint: ResolvedProviderEndpoint | None
    requested_model: str
    billing_model: str
    capability: FamilyModelCapability
    variant_key: str
    billing_scheme_key: str
    options: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class ResolvedSearchProfile:
    """Immutable Embedding and vector-collection identity for one family."""

    family_id: str
    search_profile_id: str
    provider_profile_id: str
    provider_profile_version_id: str
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    endpoint: ResolvedProviderEndpoint
    embedding_model: str
    dimensions: int
    distance: Literal["Cosine"]
    document_builder_version: str
    qdrant_collection: str


@dataclass(frozen=True, slots=True)
class EmbeddingUsageSnapshot:
    """The price/config boundary captured for one embedding invocation."""

    config_revision_id: str | None
    price_version_id: str
    candidate: bool

    def __post_init__(self) -> None:
        if not self.price_version_id:
            raise ValueError("embedding usage price version is required")
        if self.candidate != (self.config_revision_id is None):
            raise ValueError("embedding usage snapshot candidate mismatch")


@dataclass(frozen=True, slots=True)
class DispatchCredential:
    family_id: str
    provider_profile_id: str
    secret_version_id: str | None
    api_key: str | None = field(repr=False)


@dataclass(frozen=True, slots=True)
class RotateProfileSecretCommand:
    family_id: str
    profile_id: str
    actor_user_id: str
    base_settings_version: int = 0
    idempotency_key: str = ""
    credential_scope_checksum: str = ""
    new_api_key: str = field(default="", repr=False)


@dataclass(frozen=True, slots=True)
class RotatedSecretResult:
    configured: bool
    secret_version_id: str
    secret_version_number: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class CanonicalCredentialScope:
    checksum: str
    endpoint_fingerprint: str
    api_endpoint: ResolvedProviderEndpoint
    websocket_endpoint: ResolvedProviderEndpoint | None
    options: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class CreateProviderProfileCommand:
    family_id: str
    actor_user_id: str
    display_name: str
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    api_base_url: str
    websocket_base_url: str | None
    options: Mapping[str, object]
    idempotency_key: str
    api_key: str | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class UpdateProviderProfileCommand:
    family_id: str
    actor_user_id: str
    profile_id: str
    base_profile_version_number: int
    idempotency_key: str
    display_name: str | None = None
    status: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderProfileSnapshot:
    id: str
    display_name: str
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    api_base_url: str
    websocket_base_url: str | None
    options: Mapping[str, object]
    status: str
    archived: bool
    version_number: int
    profile_version_number: int
    credential_configured: bool
    credential_version_number: int | None
    credential_updated_at: datetime | None
    created_at: datetime
    updated_at: datetime
