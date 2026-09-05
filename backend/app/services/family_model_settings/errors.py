from __future__ import annotations

from typing import ClassVar


class FamilyModelSettingsError(Exception):
    """Base error with a stable, content-free code for this bounded domain."""

    default_code: ClassVar[str | None] = None

    def __init__(self, code: str | None = None) -> None:
        resolved_code = code or self.default_code
        if not resolved_code:
            raise ValueError("family model settings errors require a stable code")
        self.code = resolved_code
        super().__init__(resolved_code)


class FamilyModelCredentialConfigurationError(FamilyModelSettingsError):
    default_code = "family_model_credential_configuration_invalid"


class FamilyModelSecretUnavailable(FamilyModelSettingsError):
    default_code = "family_model_secret_unavailable"


class FamilyModelProviderProfileNotFound(FamilyModelSettingsError):
    default_code = "family_model_provider_not_found"


class FamilyModelConfigDraftNotFound(FamilyModelSettingsError):
    default_code = "family_model_draft_not_found"


class FamilyModelProviderScopeChangeRequiresNewProfile(FamilyModelSettingsError):
    default_code = "family_model_provider_scope_change_requires_new_profile"


class FamilyModelSettingsVersionConflict(FamilyModelSettingsError):
    default_code = "family_model_settings_version_conflict"

    def __init__(
        self,
        code: str | None = None,
        *,
        current_draft_version_number: int | None = None,
        current_settings_version_number: int | None = None,
        current_config_revision_id: str | None = None,
        current_price_version_id: str | None = None,
    ) -> None:
        super().__init__(code)
        self.current_draft_version_number = current_draft_version_number
        self.current_settings_version_number = current_settings_version_number
        self.current_config_revision_id = current_config_revision_id
        self.current_price_version_id = current_price_version_id


class FamilyModelProviderProfileVersionConflict(FamilyModelSettingsError):
    default_code = "family_model_provider_version_conflict"

    def __init__(self, current_profile_version_number: int | None = None) -> None:
        super().__init__()
        self.current_profile_version_number = current_profile_version_number


class FamilyModelProviderProfileInUse(FamilyModelSettingsError):
    default_code = "family_model_provider_profile_in_use"

    def __init__(self, references: tuple[dict[str, object], ...] = ()) -> None:
        super().__init__()
        self.references = references


class FamilyModelDraftInvalid(FamilyModelSettingsError):
    default_code = "family_model_draft_invalid"


class FamilyModelSearchProfileIdentityConflict(FamilyModelSettingsError):
    default_code = "family_search_profile_identity_conflict"


class FamilyModelConfigurationAlreadyPublished(FamilyModelSettingsError):
    default_code = "family_model_configuration_already_published"


class FamilyModelOperationIdempotencyConflict(FamilyModelSettingsError):
    default_code = "family_model_operation_idempotency_conflict"


class FamilyModelOperationInProgress(FamilyModelSettingsError):
    default_code = "family_model_operation_in_progress"


class FamilyModelOwnerReauthenticationFailed(FamilyModelSettingsError):
    default_code = "family_model_owner_reauthentication_failed"


class FamilyModelProviderProtocolUnsupported(FamilyModelSettingsError):
    default_code = "family_model_provider_protocol_unsupported"


class FamilyModelNetworkPolicyConfigurationError(FamilyModelSettingsError):
    default_code = "family_model_network_policy_configuration_invalid"


class FamilyModelEndpointBlocked(FamilyModelSettingsError):
    default_code = "family_model_endpoint_blocked"


class FamilyModelProviderTransportError(FamilyModelSettingsError):
    default_code = "family_model_provider_transport_failed"


class FamilyModelProviderResponseTooLarge(FamilyModelSettingsError):
    default_code = "family_model_provider_response_too_large"


class FamilyModelProviderMediaTypeBlocked(FamilyModelSettingsError):
    default_code = "family_model_provider_media_type_blocked"
