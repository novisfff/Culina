from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.enums import (
    ActivityAction,
    FamilyModelConfigRevisionStatus,
    FamilyModelPricePurpose,
    FamilyModelSearchProfileStatus,
    ModelUsageMeterRole,
)
from app.core.utils import create_id, utcnow
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigDraft,
    FamilyModelConfigRevision,
    FamilySearchProfile,
)
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.repos.family_model_settings.configurations import (
    get_config_revision,
    get_search_profile,
    get_search_profile_by_identity,
    lock_config_draft,
    require_draft_version,
)
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.profiles import (
    lock_family_model_settings,
    require_settings_version,
)
from app.repos.family_model_settings.resource_operations import (
    insert_ensure_collection_operation,
)
from app.services.activity import log_activity
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
)
from app.services.family_model_settings.errors import (
    FamilyModelConfigurationAlreadyPublished,
    FamilyModelDraftInvalid,
    FamilyModelOperationInProgress,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.validation import (
    DraftValidationResult,
    ValidateDraftCommand,
    ValidatedCapabilityBinding,
    ValidatedFamilyPriceRate,
    validate_family_model_draft,
)
from app.services.model_usage.decimal_math import CNY_QUANTUM
from app.repos.model_usage.catalog import next_price_version_number


_SEARCH_DOCUMENT_BUILDER_VERSION = "family-model-search-v1"


@dataclass(frozen=True, slots=True)
class PublishConfigurationCommand:
    family_id: str
    actor_user_id: str
    base_settings_version_number: int
    base_draft_version_number: int
    idempotency_key: str
    confirm_config_checksum: str
    confirm_price_checksum: str
    network_policy: ProviderNetworkPolicy


@dataclass(frozen=True, slots=True)
class PublishedFamilyModelConfiguration:
    family_id: str
    config_revision_id: str
    price_version_id: str
    settings_version_number: int
    config_checksum: str
    price_checksum: str
    search_profile_id: str | None

    def response_record(self) -> dict[str, object]:
        return {
            "family_id": self.family_id,
            "config_revision_id": self.config_revision_id,
            "price_version_id": self.price_version_id,
            "settings_version_number": self.settings_version_number,
            "config_checksum": self.config_checksum,
            "price_checksum": self.price_checksum,
            "search_profile_id": self.search_profile_id,
        }


def _published_result_from_response(response: object) -> PublishedFamilyModelConfiguration:
    if not isinstance(response, Mapping):
        raise FamilyModelOperationInProgress()
    fields = (
        "family_id",
        "config_revision_id",
        "price_version_id",
        "config_checksum",
        "price_checksum",
    )
    try:
        if any(not isinstance(response[field], str) for field in fields):
            raise TypeError
        if not isinstance(response["settings_version_number"], int):
            raise TypeError
        if not isinstance(response.get("search_profile_id"), (str, type(None))):
            raise TypeError
    except (KeyError, TypeError) as exc:
        raise FamilyModelOperationInProgress() from exc
    return PublishedFamilyModelConfiguration(
        family_id=response["family_id"],
        config_revision_id=response["config_revision_id"],
        price_version_id=response["price_version_id"],
        settings_version_number=response["settings_version_number"],
        config_checksum=response["config_checksum"],
        price_checksum=response["price_checksum"],
        search_profile_id=response.get("search_profile_id"),
    )


def _next_config_revision_number(db: Session, *, family_id: str) -> int:
    maximum = db.scalar(
        select(func.max(FamilyModelConfigRevision.version_number)).where(
            FamilyModelConfigRevision.family_id == family_id
        )
    )
    return int(maximum or 0) + 1


def _search_identity_checksum(binding: ValidatedCapabilityBinding) -> str:
    assert binding.profile is not None
    assert binding.profile_version is not None
    dimensions = binding.options.get("dimensions")
    if not isinstance(dimensions, int):
        raise FamilyModelDraftInvalid("family_model_embedding_dimensions_required")
    payload = {
        "provider_profile_id": binding.profile.id,
        "provider_profile_version_id": binding.profile_version.id,
        "adapter_kind": binding.profile_version.adapter_kind,
        "endpoint_fingerprint": binding.profile_version.endpoint_fingerprint,
        "embedding_model": binding.requested_model,
        "dimensions": dimensions,
        "distance": "Cosine",
        "document_builder_version": _SEARCH_DOCUMENT_BUILDER_VERSION,
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _search_collection_name(*, family_id: str, search_profile_id: str) -> str:
    """Generate an opaque per-profile Qdrant collection identity.

    A collection is tied to an immutable search profile, not an embedding
    model or provider endpoint. Keeping the profile ID in the digest allows
    two profiles with different dimensions to coexist during replacement.
    """

    prefix = get_settings().family_model_qdrant_collection_prefix
    token = hashlib.sha256(f"{family_id}\x1f{search_profile_id}".encode("utf-8")).hexdigest()
    return f"{prefix}_{token[:48]}"


def _create_initial_search_profile_if_required(
    db: Session,
    *,
    command: PublishConfigurationCommand,
    validation: DraftValidationResult,
) -> FamilySearchProfile | None:
    binding = next(
        (
            item
            for item in validation.bindings
            if item.enabled and item.capability.value == "embedding"
        ),
        None,
    )
    if binding is None:
        return None
    assert binding.profile is not None
    assert binding.profile_version is not None
    dimensions = binding.options.get("dimensions")
    if not isinstance(dimensions, int):
        raise FamilyModelDraftInvalid("family_model_embedding_dimensions_required")
    identity_checksum = _search_identity_checksum(binding)
    existing = get_search_profile_by_identity(
        db,
        family_id=command.family_id,
        index_identity_checksum=identity_checksum,
    )
    if existing is not None:
        return existing
    profile_id = create_id("family-search-profile")
    profile = FamilySearchProfile(
        id=profile_id,
        family_id=command.family_id,
        provider_profile_id=binding.profile.id,
        provider_profile_version_id=binding.profile_version.id,
        adapter_kind=binding.profile_version.adapter_kind,
        embedding_model=binding.requested_model,
        dimensions=dimensions,
        distance="Cosine",
        document_builder_version=_SEARCH_DOCUMENT_BUILDER_VERSION,
        index_identity_checksum=identity_checksum,
        qdrant_collection=_search_collection_name(
            family_id=command.family_id,
            search_profile_id=profile_id,
        ),
        status=FamilyModelSearchProfileStatus.PROVISIONING,
        created_by=command.actor_user_id,
    )
    db.add(profile)
    db.flush()
    insert_ensure_collection_operation(db, search_profile=profile)
    return profile


def _resolved_search_profile(
    db: Session,
    *,
    family_id: str,
    requested_search_profile_id: str | None,
) -> FamilySearchProfile | None:
    if requested_search_profile_id is None:
        return None
    profile = get_search_profile(
        db,
        family_id=family_id,
        search_profile_id=requested_search_profile_id,
    )
    if profile is None:
        raise FamilyModelDraftInvalid("family_search_profile_not_found")
    return profile


def _insert_config_revision(
    db: Session,
    *,
    command: PublishConfigurationCommand,
    validation: DraftValidationResult,
    base_revision_id: str | None,
    search_profile: FamilySearchProfile | None,
) -> FamilyModelConfigRevision:
    assert validation.config_checksum is not None
    revision = FamilyModelConfigRevision(
        id=create_id("family-model-revision"),
        family_id=command.family_id,
        version_number=_next_config_revision_number(db, family_id=command.family_id),
        base_revision_id=base_revision_id,
        config_checksum=validation.config_checksum,
        status=FamilyModelConfigRevisionStatus.PUBLISHED,
        search_profile_id=search_profile.id if search_profile is not None else None,
        change_note=validation.payload.change_note,
        published_by=command.actor_user_id,
    )
    db.add(revision)
    db.flush()
    return revision


def _insert_capability_bindings(
    db: Session,
    *,
    revision: FamilyModelConfigRevision,
    bindings: tuple[ValidatedCapabilityBinding, ...],
) -> None:
    for binding in bindings:
        db.add(
            FamilyModelCapabilityBinding(
                id=create_id("family-model-binding"),
                family_id=revision.family_id,
                config_revision_id=revision.id,
                capability=binding.capability,
                variant_key=binding.variant_key,
                enabled=binding.enabled,
                provider_profile_id=binding.provider_profile_id,
                provider_profile_version_id=binding.provider_profile_version_id,
                requested_model=binding.requested_model,
                options_json=dict(binding.options),
                billing_scheme_key=binding.billing_scheme_key,
                identity_checksum=binding.identity_checksum,
            )
        )
    db.flush()


def insert_family_price_rates(
    db: Session,
    *,
    price_version: ModelUsagePriceVersion,
    rates: tuple[ValidatedFamilyPriceRate, ...],
) -> None:
    for rate in rates:
        db.add(
            ModelUsagePriceRate(
                id=create_id("model-usage-rate"),
                price_version_id=price_version.id,
                provider=rate.provider,
                billing_model=rate.billing_model,
                capability=rate.capability,
                variant_key=rate.variant_key,
                billing_scheme_key=rate.billing_scheme_key,
                meter=rate.meter,
                meter_role=ModelUsageMeterRole.BILLABLE,
                unit_quantity=rate.unit_quantity,
                unit_price=rate.unit_price,
                source_currency=rate.source_currency,
                fx_to_cny=rate.fx_to_cny,
                unit_price_cny=rate.unit_price_cny.quantize(CNY_QUANTUM),
                reported_model_aliases=list(rate.reported_model_aliases),
            )
        )
    db.flush()


def _insert_complete_active_price_version(
    db: Session,
    *,
    command: PublishConfigurationCommand,
    revision: FamilyModelConfigRevision,
    base_price_version_id: str | None,
    validation: DraftValidationResult,
) -> ModelUsagePriceVersion:
    assert validation.price_checksum is not None
    now = utcnow()
    aliases = {
        f"{rate.provider}:{alias}": rate.billing_model
        for rate in validation.price_rates
        for alias in rate.reported_model_aliases
    }
    fx_rates = {"CNY": "1"}
    fx_rates.update(
        {rate.source_currency: str(rate.fx_to_cny) for rate in validation.price_rates}
    )
    price = ModelUsagePriceVersion(
        id=create_id("family-model-price"),
        family_id=command.family_id,
        config_revision_id=revision.id,
        base_price_version_id=base_price_version_id,
        purpose=FamilyModelPricePurpose.ACTIVE,
        published_by=command.actor_user_id,
        version_number=next_price_version_number(db),
        status="published",
        effective_from=now,
        reviewed_at=now,
        source_ref="family-managed-model-settings",
        change_note=validation.payload.change_note or "更新家庭模型配置",
        operator=command.actor_user_id,
        change_ticket=None,
        manifest_checksum=validation.price_checksum,
        model_aliases_json=aliases,
        fx_rates_json=fx_rates,
    )
    db.add(price)
    db.flush()
    insert_family_price_rates(db, price_version=price, rates=validation.price_rates)
    return price


def _reset_draft_after_publish(
    draft: FamilyModelConfigDraft,
    *,
    revision: FamilyModelConfigRevision,
    actor_user_id: str,
) -> None:
    payload = dict(draft.payload_json)
    payload["base_config_revision_id"] = revision.id
    draft.base_config_revision_id = revision.id
    draft.payload_json = payload
    draft.draft_version_number += 1
    draft.validation_status = "unknown"
    draft.validation_errors_json = []
    draft.updated_at = utcnow()
    draft.updated_by = actor_user_id


def publish_family_model_configuration(
    db: Session,
    command: PublishConfigurationCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> PublishedFamilyModelConfiguration:
    """Atomically publish one validated draft and its complete price snapshot."""

    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="publish_family_model_configuration",
        public_fields={
            "family_id": command.family_id,
            "base_settings_version_number": command.base_settings_version_number,
            "base_draft_version_number": command.base_draft_version_number,
            "confirm_config_checksum": command.confirm_config_checksum,
            "confirm_price_checksum": command.confirm_price_checksum,
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="publish_family_model_configuration",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _published_result_from_response(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    require_settings_version(settings, command.base_settings_version_number)
    draft = lock_config_draft(db, family_id=command.family_id)
    require_draft_version(draft, command.base_draft_version_number)
    if draft.base_config_revision_id != settings.active_config_revision_id:
        raise FamilyModelSettingsVersionConflict(
            current_settings_version_number=settings.version_number,
            current_config_revision_id=settings.active_config_revision_id,
        )
    validation = validate_family_model_draft(
        db,
        ValidateDraftCommand(
            family_id=command.family_id,
            actor_user_id=command.actor_user_id,
            network_policy=command.network_policy,
        ),
    )
    validation.require_confirmed_checksums(
        command.confirm_config_checksum,
        command.confirm_price_checksum,
    )
    assert validation.config_checksum is not None
    existing = db.scalar(
        select(FamilyModelConfigRevision.id).where(
            FamilyModelConfigRevision.family_id == command.family_id,
            FamilyModelConfigRevision.config_checksum == validation.config_checksum,
        )
    )
    if existing is not None:
        raise FamilyModelConfigurationAlreadyPublished()
    retained_search = _resolved_search_profile(
        db,
        family_id=command.family_id,
        requested_search_profile_id=validation.search_profile_id,
    )
    initial_search = (
        None
        if retained_search is not None
        else _create_initial_search_profile_if_required(
            db,
            command=command,
            validation=validation,
        )
    )
    search_profile = retained_search or initial_search
    revision = _insert_config_revision(
        db,
        command=command,
        validation=validation,
        base_revision_id=settings.active_config_revision_id,
        search_profile=search_profile,
    )
    _insert_capability_bindings(db, revision=revision, bindings=validation.bindings)
    price = _insert_complete_active_price_version(
        db,
        command=command,
        revision=revision,
        base_price_version_id=settings.active_price_version_id,
        validation=validation,
    )
    if settings.active_config_revision_id is not None:
        previous = get_config_revision(
            db,
            family_id=command.family_id,
            config_revision_id=settings.active_config_revision_id,
            for_update=True,
        )
        if previous is not None:
            previous.status = FamilyModelConfigRevisionStatus.SUPERSEDED
    settings.active_config_revision_id = revision.id
    settings.active_price_version_id = price.id
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = utcnow()
    _reset_draft_after_publish(
        draft,
        revision=revision,
        actor_user_id=command.actor_user_id,
    )
    assert validation.price_checksum is not None
    result = PublishedFamilyModelConfiguration(
        family_id=command.family_id,
        config_revision_id=revision.id,
        price_version_id=price.id,
        settings_version_number=settings.version_number,
        config_checksum=validation.config_checksum,
        price_checksum=validation.price_checksum,
        search_profile_id=search_profile.id if search_profile is not None else None,
    )
    complete_operation(
        claim,
        result_id=revision.id,
        response_json=result.response_record(),
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="FamilyModelConfiguration",
        entity_id=revision.id,
        summary="更新了家庭 AI 服务配置",
    )
    db.flush()
    return result
