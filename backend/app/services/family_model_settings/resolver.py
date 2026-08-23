from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import FamilyModelProviderStatus, FamilyModelSecretStatus
from app.models.family_model_settings import FamilyModelCapabilityBinding, FamilySearchProfile
from app.repos.family_model_settings.configurations import (
    get_capability_binding,
    get_config_revision,
    get_search_profile,
)
from app.repos.family_model_settings.profiles import (
    get_provider_profile,
    get_provider_profile_version,
    get_provider_secret_version,
    require_provider_profile,
)
from app.services.family_model_settings.adapter_registry import require_adapter_support
from app.services.family_model_settings.credentials import FamilyModelCredentialCipher
from app.services.family_model_settings.errors import FamilyModelSettingsError, FamilyModelSecretUnavailable
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.types import (
    DispatchCredential,
    FamilyModelCapability,
    ResolvedCapabilityBinding,
    ResolvedSearchProfile,
)


def _as_capability(value: str) -> FamilyModelCapability:
    if value not in {
        "llm",
        "image_generation",
        "stt",
        "tts",
        "realtime_audio",
        "embedding",
        "rerank",
    }:
        raise FamilyModelSettingsError("family_model_capability_disabled")
    return value  # type: ignore[return-value]


class FamilyModelConfigurationResolver:
    """Resolve family configuration identities without caching active pointers.

    A resolver is deliberately scoped to a request/worker session.  It never
    retains an active settings pointer or credential plaintext.  The provider
    transport still re-authorizes the URL immediately before every connection,
    so endpoint metadata returned here cannot become a DNS-pinning bypass.
    """

    def __init__(
        self,
        db: Session,
        *,
        network_policy: ProviderNetworkPolicy | None = None,
        cipher: FamilyModelCredentialCipher | None = None,
    ) -> None:
        self.db = db
        settings = get_settings()
        self.network_policy = network_policy or ProviderNetworkPolicy.from_settings(settings)
        # Normal resolution deliberately returns only immutable public
        # configuration metadata.  Do not require the credential keyring just
        # to determine that a family has no active capability; plaintext is
        # needed only after a durable dispatch permit selects a secret version.
        self._cipher = cipher

    def resolve_active(
        self,
        family_id: str,
        capability: FamilyModelCapability,
        variant_key: str,
    ) -> ResolvedCapabilityBinding:
        from app.repos.family_model_settings.profiles import get_family_model_settings

        settings = get_family_model_settings(self.db, family_id=family_id)
        if settings is None or settings.active_config_revision_id is None:
            raise FamilyModelSettingsError("family_model_settings_not_configured")
        return self.resolve_revision(
            family_id,
            settings.active_config_revision_id,
            capability,
            variant_key,
        )

    def resolve_revision(
        self,
        family_id: str,
        config_revision_id: str,
        capability: FamilyModelCapability,
        variant_key: str,
    ) -> ResolvedCapabilityBinding:
        revision = get_config_revision(
            self.db,
            family_id=family_id,
            config_revision_id=config_revision_id,
        )
        if revision is None:
            raise FamilyModelSettingsError("family_model_configuration_not_found")
        binding = get_capability_binding(
            self.db,
            family_id=family_id,
            config_revision_id=config_revision_id,
            capability=capability,
            variant_key=variant_key,
        )
        if binding is None or not binding.enabled:
            raise FamilyModelSettingsError("family_model_capability_disabled")
        return self._resolved_binding(binding)

    def optional_revision_variant(
        self,
        family_id: str,
        config_revision_id: str,
        capability: FamilyModelCapability,
        variant_key: str,
    ) -> ResolvedCapabilityBinding | None:
        binding = get_capability_binding(
            self.db,
            family_id=family_id,
            config_revision_id=config_revision_id,
            capability=capability,
            variant_key=variant_key,
        )
        if binding is None or not binding.enabled:
            return None
        return self._resolved_binding(binding)

    def _resolved_binding(
        self,
        binding: FamilyModelCapabilityBinding,
    ) -> ResolvedCapabilityBinding:
        if (
            binding.provider_profile_id is None
            or binding.provider_profile_version_id is None
            or not binding.requested_model
            or not binding.billing_scheme_key
        ):
            raise FamilyModelSettingsError("family_model_capability_disabled")
        profile = get_provider_profile(
            self.db,
            family_id=binding.family_id,
            profile_id=binding.provider_profile_id,
        )
        profile_version = get_provider_profile_version(
            self.db,
            family_id=binding.family_id,
            profile_id=binding.provider_profile_id,
            profile_version_id=binding.provider_profile_version_id,
        )
        if (
            profile is None
            or profile_version is None
            or profile.status is not FamilyModelProviderStatus.ACTIVE
            or profile_version.credential_scope_checksum != profile.credential_scope_checksum
        ):
            raise FamilyModelSettingsError("family_model_provider_disabled")
        capability = _as_capability(binding.capability.value)
        definition = require_adapter_support(
            kind=profile_version.adapter_kind,
            capability=capability,
            auth_mode=profile_version.auth_mode,
            billing_scheme_key=binding.billing_scheme_key,
        )
        protocol = (
            "http"
            if any(item in {"http", "https"} for item in definition.http_protocols)
            else "websocket"
        )
        endpoint = self.network_policy.authorize(
            profile_version.api_base_url,
            protocol=protocol,  # type: ignore[arg-type]
        )
        websocket_endpoint = (
            self.network_policy.authorize(
                profile_version.websocket_base_url,
                protocol="websocket",
            )
            if profile_version.websocket_base_url
            else None
        )
        return ResolvedCapabilityBinding(
            family_id=binding.family_id,
            config_revision_id=binding.config_revision_id,
            provider_profile_id=binding.provider_profile_id,
            provider_profile_version_id=binding.provider_profile_version_id,
            adapter_kind=profile_version.adapter_kind,
            auth_mode=profile_version.auth_mode,
            endpoint=endpoint,
            websocket_endpoint=websocket_endpoint,
            requested_model=binding.requested_model,
            billing_model=binding.requested_model,
            capability=capability,
            variant_key=binding.variant_key,
            billing_scheme_key=binding.billing_scheme_key,
            options=(
                dict(binding.options_json)
                if isinstance(binding.options_json, Mapping)
                else {}
            ),
        )

    def resolve_search_profile(
        self,
        family_id: str,
        search_profile_id: str,
    ) -> ResolvedSearchProfile:
        profile = get_search_profile(
            self.db,
            family_id=family_id,
            search_profile_id=search_profile_id,
        )
        if profile is None:
            raise FamilyModelSettingsError("family_search_profile_not_found")
        return self._resolved_search_profile(profile)

    def _resolved_search_profile(
        self,
        profile: FamilySearchProfile,
    ) -> ResolvedSearchProfile:
        provider = get_provider_profile(
            self.db,
            family_id=profile.family_id,
            profile_id=profile.provider_profile_id,
        )
        version = get_provider_profile_version(
            self.db,
            family_id=profile.family_id,
            profile_id=profile.provider_profile_id,
            profile_version_id=profile.provider_profile_version_id,
        )
        if (
            provider is None
            or version is None
            or provider.status is not FamilyModelProviderStatus.ACTIVE
        ):
            raise FamilyModelSettingsError("family_model_provider_disabled")
        definition = require_adapter_support(
            kind=version.adapter_kind,
            capability="embedding",
            auth_mode=version.auth_mode,
            billing_scheme_key="embedding-token-v1",
        )
        if not any(item in {"http", "https"} for item in definition.http_protocols):
            raise FamilyModelSettingsError("family_model_provider_protocol_unsupported")
        endpoint = self.network_policy.authorize(version.api_base_url, protocol="http")
        if profile.distance != "Cosine":
            raise FamilyModelSettingsError("family_search_profile_invalid")
        return ResolvedSearchProfile(
            family_id=profile.family_id,
            search_profile_id=profile.id,
            provider_profile_id=profile.provider_profile_id,
            provider_profile_version_id=profile.provider_profile_version_id,
            adapter_kind=version.adapter_kind,
            auth_mode=version.auth_mode,
            endpoint=endpoint,
            embedding_model=profile.embedding_model,
            dimensions=profile.dimensions,
            distance="Cosine",
            document_builder_version=profile.document_builder_version,
            qdrant_collection=profile.qdrant_collection,
        )

    def resolve_dispatch_credential(
        self,
        binding: ResolvedCapabilityBinding | ResolvedSearchProfile,
        credential_secret_version_id: str | None,
    ) -> DispatchCredential:
        if binding.auth_mode == "no_auth":
            if credential_secret_version_id is not None:
                raise FamilyModelSecretUnavailable()
            return DispatchCredential(
                family_id=binding.family_id,
                provider_profile_id=binding.provider_profile_id,
                secret_version_id=None,
                api_key=None,
            )
        if credential_secret_version_id is None:
            raise FamilyModelSecretUnavailable()
        profile = require_provider_profile(
            self.db,
            family_id=binding.family_id,
            profile_id=binding.provider_profile_id,
        )
        version = get_provider_secret_version(
            self.db,
            family_id=binding.family_id,
            profile_id=binding.provider_profile_id,
            secret_version_id=credential_secret_version_id,
        )
        if (
            version is None
            or version.status is FamilyModelSecretStatus.DESTROYED
            or version.nonce is None
            or version.ciphertext is None
            or version.auth_tag is None
        ):
            raise FamilyModelSecretUnavailable()
        cipher = self._cipher
        if cipher is None:
            cipher = FamilyModelCredentialCipher.from_settings(get_settings())
            self._cipher = cipher
        credential = cipher.decrypt(
            version=version,
            family_id=binding.family_id,
            profile_id=profile.id,
            secret_version_id=version.id,
        )
        return DispatchCredential(
            family_id=binding.family_id,
            provider_profile_id=binding.provider_profile_id,
            secret_version_id=version.id,
            api_key=credential,
        )
