from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)

from app.core.enums import FamilyModelProviderStatus, ModelUsageMeter


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


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProviderProfileScopeOptions(_StrictModel):
    """The complete, non-secret credential scope declared by current adapters.

    These fields intentionally live only on profile creation.  A credential's
    endpoint/workspace scope is immutable after the first secret is written;
    changing it requires a second profile so an old endpoint can never observe
    a new key.
    """

    workspace_id: str | None = Field(default=None, min_length=1, max_length=160)
    region: str | None = Field(default=None, min_length=1, max_length=80)
    project_id: str | None = Field(default=None, min_length=1, max_length=160)

    @field_validator("workspace_id", "region", "project_id", mode="before")
    @classmethod
    def _strip_optional_scope_value(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip() or None
        return value


class ProviderCredentialMetadataOut(BaseModel):
    configured: bool
    version_number: int | None = None
    updated_at: datetime | None = None


class ProviderProfileCreateRequest(_StrictModel):
    display_name: str = Field(min_length=1, max_length=160)
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    api_base_url: str = Field(min_length=1, max_length=2048)
    websocket_base_url: str | None = Field(default=None, max_length=2048)
    options: ProviderProfileScopeOptions = Field(default_factory=ProviderProfileScopeOptions)
    workspace_id: str | None = Field(default=None, min_length=1, max_length=160)
    region: str | None = Field(default=None, min_length=1, max_length=80)
    project_id: str | None = Field(default=None, min_length=1, max_length=160)
    api_key: SecretStr | None = Field(default=None, max_length=4096)
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator(
        "display_name",
        "api_base_url",
        "websocket_base_url",
        "workspace_id",
        "region",
        "project_id",
        "idempotency_key",
        mode="before",
    )
    @classmethod
    def _strip_required_strings(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _require_auth_material(self) -> ProviderProfileCreateRequest:
        direct_scope = {
            key: value
            for key, value in {
                "workspace_id": self.workspace_id,
                "region": self.region,
                "project_id": self.project_id,
            }.items()
            if value is not None
        }
        nested_scope = self.options.model_dump(exclude_none=True)
        if any(
            key in nested_scope and nested_scope[key] != value
            for key, value in direct_scope.items()
        ):
            raise ValueError("family_model_provider_scope_options_conflict")
        self.options = ProviderProfileScopeOptions.model_validate(
            nested_scope | direct_scope
        )
        key = self.api_key.get_secret_value().strip() if self.api_key is not None else ""
        if self.auth_mode == "api_key" and not key:
            raise ValueError("family_model_api_key_required")
        if self.auth_mode == "no_auth" and key:
            raise ValueError("family_model_api_key_not_allowed")
        return self


class ProviderProfilePatchRequest(_StrictModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=160)
    status: FamilyModelProviderStatus | None = None
    base_profile_version_number: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator("display_name", "idempotency_key", mode="before")
    @classmethod
    def _strip_patch_strings(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _require_mutation(self) -> ProviderProfilePatchRequest:
        if self.display_name is None and self.status is None:
            raise ValueError("family_model_provider_patch_empty")
        return self


class ProviderProfileOut(BaseModel):
    id: str
    display_name: str
    adapter_kind: FamilyModelAdapterKind
    auth_mode: FamilyModelAuthMode
    api_base_url: str
    websocket_base_url: str | None = None
    options: ProviderProfileScopeOptions = Field(default_factory=ProviderProfileScopeOptions)
    status: FamilyModelProviderStatus
    archived: bool
    version_number: int
    profile_version_number: int
    credential: ProviderCredentialMetadataOut
    created_at: datetime
    updated_at: datetime


class RotateProviderProfileSecretRequest(_StrictModel):
    new_api_key: SecretStr = Field(min_length=1, max_length=4096)
    base_settings_version_number: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=160)


class RotateProviderProfileSecretOut(BaseModel):
    configured: bool
    secret_version_number: int
    updated_at: datetime


class ProviderConnectionCheckRequest(_StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=160)


class ProviderConnectionCheckOut(BaseModel):
    status: Literal["reachable", "not_supported"]
    detail: str | None = None
    checked_at: datetime
    latency_ms: int | None = Field(default=None, ge=0)
    profile_version_number: int
    models: list[str] = Field(default_factory=list, max_length=200)


class LlmBindingDraft(_StrictModel):
    capability: Literal["llm"]
    variant_key: Literal["primary", "fallback"]
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["llm-split-v1"] = "llm-split-v1"
    max_output_tokens: int = Field(ge=1, le=65536)
    supports_vision: bool = False
    prompt_cache_enabled: bool = True


class ImageGenerationBindingDraft(_StrictModel):
    capability: Literal["image_generation"]
    variant_key: Literal["text", "reference"]
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["image-count-v1"] = "image-count-v1"
    image_size: Literal["1024x1024", "1024x1536", "1536x1024"] = "1024x1024"
    response_format: Literal["b64_json", "url"] = "b64_json"


class SttBindingDraft(_StrictModel):
    capability: Literal["stt"]
    variant_key: Literal["default"] = "default"
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["stt-seconds-v1"] = "stt-seconds-v1"
    language_hint: str | None = Field(default=None, max_length=32)
    hotwords: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("hotwords")
    @classmethod
    def _validate_hotwords(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(not value or len(value) > 80 for value in normalized):
            raise ValueError("family_model_hotword_invalid")
        if len(set(normalized)) != len(normalized):
            raise ValueError("family_model_hotword_duplicate")
        return normalized


class TtsBindingDraft(_StrictModel):
    capability: Literal["tts"]
    variant_key: Literal["default"] = "default"
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["tts-characters-v1"] = "tts-characters-v1"
    voice: str | None = Field(default=None, max_length=80)
    output_format: Literal["mp3", "wav", "ogg", "flac", "mp4"] = "mp3"


class RealtimeAudioBindingDraft(_StrictModel):
    capability: Literal["realtime_audio"]
    variant_key: Literal["default"] = "default"
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["realtime-asr-seconds-tts-characters-v1"] = (
        "realtime-asr-seconds-tts-characters-v1"
    )
    voice: str | None = Field(default=None, max_length=80)
    language_hint: str | None = Field(default=None, max_length=32)


class EmbeddingBindingDraft(_StrictModel):
    capability: Literal["embedding"]
    variant_key: Literal["search"] = "search"
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["embedding-token-v1"] = "embedding-token-v1"
    dimensions: int = Field(ge=1, le=65536)


class RerankBindingDraft(_StrictModel):
    capability: Literal["rerank"]
    variant_key: Literal["search"] = "search"
    enabled: bool
    provider_profile_id: str | None = None
    requested_model: str = Field(default="", max_length=160)
    billing_scheme_key: Literal["rerank-token-v1"] = "rerank-token-v1"
    top_n: int = Field(default=20, ge=1, le=200)
    instruction: str | None = Field(default=None, max_length=500)


FamilyModelBindingDraft: TypeAlias = Annotated[
    LlmBindingDraft
    | ImageGenerationBindingDraft
    | SttBindingDraft
    | TtsBindingDraft
    | RealtimeAudioBindingDraft
    | EmbeddingBindingDraft
    | RerankBindingDraft,
    Field(discriminator="capability"),
]


class FamilyModelPriceRateRequest(_StrictModel):
    capability: FamilyModelCapability
    variant_key: str = Field(min_length=1, max_length=120)
    meter: ModelUsageMeter
    unit_quantity: Decimal = Field(gt=0, max_digits=30, decimal_places=6)
    unit_price: Decimal = Field(ge=0, max_digits=30, decimal_places=12)
    source_currency: str = Field(min_length=3, max_length=8)
    fx_to_cny: Decimal = Field(gt=0, max_digits=30, decimal_places=12)
    reported_model_aliases: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("source_currency", mode="before")
    @classmethod
    def _normalize_currency(cls, value: object) -> object:
        return value.strip().upper() if isinstance(value, str) else value

    @field_validator("reported_model_aliases")
    @classmethod
    def _normalize_aliases(cls, values: list[str]) -> list[str]:
        normalized = [value.strip() for value in values]
        if any(not value or len(value) > 160 for value in normalized):
            raise ValueError("family_model_reported_model_alias_invalid")
        if len(set(normalized)) != len(normalized):
            raise ValueError("family_model_reported_model_alias_duplicate")
        return normalized


class FamilyModelPriceDraftPayload(_StrictModel):
    """A non-secret price-only draft kept beside, not inside, config edits."""

    base_price_version_id: str | None = None
    rates: list[FamilyModelPriceRateRequest] = Field(default_factory=list, max_length=256)
    change_note: str = Field(default="", max_length=255)

    @model_validator(mode="after")
    def _validate_unique_rate_identities(self) -> FamilyModelPriceDraftPayload:
        identities = [
            (rate.capability, rate.variant_key, rate.meter.value)
            for rate in self.rates
        ]
        if len(identities) != len(set(identities)):
            raise ValueError("family_model_duplicate_price_rate")
        return self


class FamilyModelConfigDraftPayload(_StrictModel):
    base_config_revision_id: str | None = None
    search_profile_id: str | None = None
    bindings: list[FamilyModelBindingDraft] = Field(default_factory=list, max_length=16)
    price_rates: list[FamilyModelPriceRateRequest] = Field(default_factory=list, max_length=256)
    price_draft: FamilyModelPriceDraftPayload | None = None
    change_note: str = Field(default="", max_length=255)

    @model_validator(mode="after")
    def _validate_unique_identities(self) -> FamilyModelConfigDraftPayload:
        binding_identities = [
            (binding.capability, binding.variant_key) for binding in self.bindings
        ]
        if len(binding_identities) != len(set(binding_identities)):
            raise ValueError("family_model_duplicate_capability_binding")
        rate_identities = [
            (rate.capability, rate.variant_key, rate.meter.value)
            for rate in self.price_rates
        ]
        if len(rate_identities) != len(set(rate_identities)):
            raise ValueError("family_model_duplicate_price_rate")
        return self


class SaveConfigDraftRequest(FamilyModelConfigDraftPayload):
    base_draft_version_number: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=160)
    # A first vector identity creates an immutable search profile. Keep this
    # acknowledgement write-only so it can never be replayed as draft state.
    confirm_initial_search_index: bool = False

    def storage_payload(self) -> FamilyModelConfigDraftPayload:
        return FamilyModelConfigDraftPayload.model_validate(
            self.model_dump(
                mode="json",
                exclude={
                    "base_draft_version_number",
                    "idempotency_key",
                    "confirm_initial_search_index",
                },
            )
        )


class FamilyModelConfigDraftOut(BaseModel):
    base_config_revision_id: str | None = None
    draft_version_number: int
    payload: FamilyModelConfigDraftPayload
    validation_status: str
    validation_errors: list[dict[str, str]] = Field(default_factory=list)
    updated_at: datetime | None = None


class ValidateDraftRequest(_StrictModel):
    base_draft_version_number: int = Field(ge=0)


class FamilyModelDraftValidationIssueOut(BaseModel):
    code: str
    field: str | None = None


class FamilyModelDraftValidationOut(BaseModel):
    valid: bool
    draft_version_number: int
    errors: list[FamilyModelDraftValidationIssueOut] = Field(default_factory=list)
    config_checksum: str | None = None
    price_checksum: str | None = None


class PublishFamilyModelSettingsRequest(_StrictModel):
    base_settings_version_number: int = Field(ge=1)
    base_draft_version_number: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=160)
    config_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    price_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    current_password: SecretStr | None = Field(default=None, min_length=1, max_length=1024)

    @field_validator("idempotency_key", "config_checksum", "price_checksum", mode="before")
    @classmethod
    def _strip_publish_strings(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class PublishedFamilyModelConfigurationOut(BaseModel):
    config_revision_id: str
    price_version_id: str
    settings_version_number: int
    config_checksum: str
    price_checksum: str
    search_profile_id: str | None = None


class _SearchReplacementInput(_StrictModel):
    """Owner input for an immutable Embedding replacement preview/create."""

    base_settings_version_number: int = Field(ge=1)
    base_search_profile_id: str = Field(min_length=1, max_length=64)
    provider_profile_id: str = Field(min_length=1, max_length=64)
    requested_model: str = Field(min_length=1, max_length=160)
    dimensions: int = Field(ge=1, le=65536)
    rates: list[FamilyModelPriceRateRequest] = Field(min_length=1, max_length=8)

    @field_validator(
        "base_search_profile_id", "provider_profile_id", "requested_model", mode="before"
    )
    @classmethod
    def _strip_search_replacement_strings(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _validate_embedding_only_rates(self) -> _SearchReplacementInput:
        identities = [(rate.capability, rate.variant_key, rate.meter.value) for rate in self.rates]
        if len(identities) != len(set(identities)):
            raise ValueError("family_model_duplicate_price_rate")
        if any(
            rate.capability != "embedding" or rate.variant_key != "search"
            for rate in self.rates
        ):
            raise ValueError("family_search_replacement_price_invalid")
        return self


class SearchReplacementPreviewRequest(_SearchReplacementInput):
    pass


class CreateSearchReplacementRequest(_SearchReplacementInput):
    confirm_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    current_password: SecretStr = Field(min_length=1, max_length=1024)
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator("confirm_checksum", "idempotency_key", mode="before")
    @classmethod
    def _strip_search_replacement_confirmation(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class SearchReplacementMutationRequest(_StrictModel):
    base_settings_version_number: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator("idempotency_key", mode="before")
    @classmethod
    def _strip_search_replacement_mutation_key(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class CapabilityTestRequest(_StrictModel):
    variant_key: str = Field(min_length=1, max_length=120)
    confirm_billable: bool = False
    base_draft_version_number: int | None = Field(default=None, ge=0)
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator("variant_key", "idempotency_key", mode="before")
    @classmethod
    def _strip_capability_test_strings(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class CapabilityTestOut(BaseModel):
    capability: FamilyModelCapability
    variant_key: str
    status: Literal["succeeded", "failed", "blocked"]
    detail: str
    checked_at: datetime


class SearchReplacementPreviewOut(BaseModel):
    document_count: int
    minimum_estimated_tokens: int
    conservative_estimated_tokens: int
    minimum_estimated_cost_cny: Decimal
    conservative_estimated_cost_cny: Decimal
    confirmation_checksum: str


class SearchReplacementFailureOut(BaseModel):
    code: str
    detail: str
    provider_http_status: int | None = Field(default=None, ge=100, le=599)
    provider_error_code: str | None = None
    provider_error_message: str | None = None
    request_sent: bool | None = None
    execution_certainty: Literal["confirmed_executed", "confirmed_not_executed", "unknown"] | None = None


class SearchReplacementOut(BaseModel):
    profile_id: str
    status: Literal["provisioning", "failed", "active", "cancelled", "superseded", "retired"]
    total_documents: int
    indexed_documents: int
    failed_documents: int
    budget_blocked_documents: int
    retryable: bool
    created_at: datetime
    activated_at: datetime | None = None
    failure: SearchReplacementFailureOut | None = None


class SaveFamilyModelPricesDraftRequest(FamilyModelPriceDraftPayload):
    base_draft_version_number: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=160)

    @field_validator("idempotency_key", "change_note", mode="before")
    @classmethod
    def _strip_price_draft_strings(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class FamilyModelPriceRateOut(BaseModel):
    capability: FamilyModelCapability
    variant_key: str
    meter: ModelUsageMeter
    provider_profile_id: str
    billing_model: str
    billing_scheme_key: str
    unit_quantity: Decimal
    unit_price: Decimal
    source_currency: str
    fx_to_cny: Decimal
    unit_price_cny: Decimal
    reported_model_aliases: list[str] = Field(default_factory=list)


class FamilyModelPricesDraftOut(BaseModel):
    base_price_version_id: str | None = None
    draft_version_number: int
    rates: list[FamilyModelPriceRateRequest] = Field(default_factory=list)
    change_note: str = ""
    updated_at: datetime | None = None


class FamilyModelPriceVersionSummaryOut(BaseModel):
    id: str
    config_revision_id: str | None = None
    search_profile_id: str | None = None
    base_price_version_id: str | None = None
    purpose: str
    version_number: int
    checksum: str
    change_note: str
    published_by: str | None = None
    published_at: datetime


class FamilyModelPricesOut(BaseModel):
    active_config_revision_id: str | None = None
    active_price_version_id: str | None = None
    current_rates: list[FamilyModelPriceRateOut] = Field(default_factory=list)
    history: list[FamilyModelPriceVersionSummaryOut] = Field(default_factory=list)
    draft: FamilyModelPricesDraftOut | None = None


class PublishFamilyModelPricesRequest(_StrictModel):
    base_settings_version_number: int = Field(ge=1)
    base_price_version_id: str = Field(min_length=1, max_length=64)
    idempotency_key: str = Field(min_length=8, max_length=160)
    confirm_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    change_note: str = Field(min_length=1, max_length=255)
    rates: list[FamilyModelPriceRateRequest] = Field(min_length=1, max_length=256)

    @field_validator("idempotency_key", "confirm_checksum", "change_note", mode="before")
    @classmethod
    def _strip_price_publish_strings(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _validate_unique_rate_identities(self) -> PublishFamilyModelPricesRequest:
        identities = [
            (rate.capability, rate.variant_key, rate.meter.value)
            for rate in self.rates
        ]
        if len(identities) != len(set(identities)):
            raise ValueError("family_model_duplicate_price_rate")
        return self


class PublishedFamilyModelPricesOut(BaseModel):
    config_revision_id: str
    price_version_id: str
    settings_version_number: int
    price_checksum: str


class FamilyModelSettingsOut(BaseModel):
    version_number: int
    active_config_revision_id: str | None = None
    active_price_version_id: str | None = None
    active_search_profile_id: str | None = None
    provider_profiles: list[ProviderProfileOut] = Field(default_factory=list)
    updated_at: datetime
