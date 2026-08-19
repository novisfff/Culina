from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.deps import require_owner
from app.db.session import get_db
from app.db.transactions import commit_session
from app.repos.family_model_settings.profiles import (
    get_family_model_settings,
    list_provider_profiles,
    require_provider_profile,
)
from app.schemas.family_model_settings import (
    CapabilityTestOut,
    CapabilityTestRequest,
    FamilyModelCapability,
    FamilyModelConfigDraftOut,
    FamilyModelDraftValidationOut,
    FamilyModelPriceRateOut,
    FamilyModelPricesDraftOut,
    FamilyModelPricesOut,
    FamilyModelSettingsOut,
    CreateSearchReplacementRequest,
    FamilyModelPriceVersionSummaryOut,
    PublishedFamilyModelPricesOut,
    PublishedFamilyModelConfigurationOut,
    PublishFamilyModelPricesRequest,
    ProviderConnectionCheckOut,
    ProviderConnectionCheckRequest,
    ProviderProfileCreateRequest,
    ProviderProfileOut,
    ProviderProfilePatchRequest,
    RotateProviderProfileSecretOut,
    RotateProviderProfileSecretRequest,
    SaveConfigDraftRequest,
    SaveFamilyModelPricesDraftRequest,
    PublishFamilyModelSettingsRequest,
    SearchReplacementMutationRequest,
    SearchReplacementOut,
    SearchReplacementPreviewOut,
    SearchReplacementPreviewRequest,
    ValidateDraftRequest,
)
from app.services.family_model_settings.connection_tests import (
    ConnectionCheckCommand,
    run_connection_check,
)
from app.services.family_model_settings.capability_tests import (
    CapabilityTestCommand,
    CapabilityTestDependencies,
    run_family_capability_test,
)
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    create_provider_profile,
    provider_profile_response_record,
    provider_profile_snapshot,
    rotate_profile_secret,
    update_provider_profile,
    verify_owner_password,
)
from app.services.family_model_settings.drafts import (
    SaveConfigDraftCommand,
    load_config_draft,
    save_config_draft,
)
from app.services.family_model_settings.errors import (
    FamilyModelConfigDraftNotFound,
    FamilyModelEndpointBlocked,
    FamilyModelOperationIdempotencyConflict,
    FamilyModelOperationInProgress,
    FamilyModelOwnerReauthenticationFailed,
    FamilyModelProviderProfileInUse,
    FamilyModelProviderProfileNotFound,
    FamilyModelProviderProfileVersionConflict,
    FamilyModelProviderProtocolUnsupported,
    FamilyModelProviderResponseTooLarge,
    FamilyModelProviderScopeChangeRequiresNewProfile,
    FamilyModelProviderTransportError,
    FamilyModelConfigurationAlreadyPublished,
    FamilyModelSecretUnavailable,
    FamilyModelSettingsError,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.publishing import (
    PublishConfigurationCommand,
    PublishedFamilyModelConfiguration,
    publish_family_model_configuration,
)
from app.services.family_model_settings.prices import (
    FamilyPriceDraftSnapshot,
    PublishFamilyPriceVersionCommand,
    PublishedFamilyPriceVersionResult,
    SaveFamilyPriceDraftCommand,
    list_family_price_history,
    load_family_price_draft,
    publish_family_price_version,
    rates_for_family_price_version,
    save_family_price_draft,
)
from app.services.family_model_settings.search_profiles import (
    CreateSearchReplacementCommand,
    SearchReplacementMutationCommand,
    SearchReplacementProgress,
    cancel_search_replacement,
    create_search_replacement,
    preview_search_replacement,
    retry_search_replacement,
    search_replacement_progress,
)
from app.services.family_model_settings.transport import ProviderTransport
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.preflight import decode_receipt_integrity_keyring
from app.services.family_model_settings.types import (
    CreateProviderProfileCommand,
    RotateProfileSecretCommand,
    UpdateProviderProfileCommand,
)
from app.services.family_model_settings.validation import (
    DraftValidationResult,
    ValidateDraftCommand,
    validate_family_model_draft,
)


router = APIRouter(prefix="/api/family/model-settings", tags=["family-model-settings"])
FAMILY_MODEL_SETTINGS_API_PREFIX = "/api/family/model-settings"


def family_model_settings_request_validation_detail(
    errors: Sequence[dict[str, Any]],
) -> dict[str, object]:
    """Return field-addressable validation facts without echoing a secret input.

    Pydantic's stock error structure can include the whole request object for a
    model-level failure.  Provider create/rotate payloads legitimately contain
    write-only keys, so this route family uses an intentionally small safe
    envelope instead.
    """

    safe_errors: list[dict[str, object]] = []
    for error in errors:
        raw_location = error.get("loc", ())
        location = [str(item) for item in raw_location] if isinstance(raw_location, tuple) else []
        error_type = error.get("type")
        safe_errors.append(
            {
                "field": ".".join(location) if location else None,
                "type": str(error_type) if isinstance(error_type, str) else "validation_error",
            }
        )
    return {"code": "family_model_request_invalid", "errors": safe_errors}


def get_family_model_credential_cipher() -> FamilyModelCredentialCipher:
    return FamilyModelCredentialCipher.from_settings(get_settings())


def get_family_model_network_policy() -> ProviderNetworkPolicy:
    return ProviderNetworkPolicy.from_settings(get_settings())


def get_family_model_provider_transport() -> ProviderTransport:
    return ProviderTransport.from_settings(get_settings())


def get_family_model_capability_test_dependencies() -> CapabilityTestDependencies:
    settings = get_settings()
    return CapabilityTestDependencies(
        cipher=FamilyModelCredentialCipher.from_settings(settings),
        network_policy=ProviderNetworkPolicy.from_settings(settings),
        transport=ProviderTransport.from_settings(settings),
        usage_facade=ModelUsageFacade(),
        signer=decode_receipt_integrity_keyring(settings).signer(),
    )


def _profile_out(snapshot: object) -> ProviderProfileOut:
    return ProviderProfileOut.model_validate(provider_profile_response_record(snapshot))


def _draft_out(snapshot) -> FamilyModelConfigDraftOut:
    return FamilyModelConfigDraftOut.model_validate(
        {
            "base_config_revision_id": snapshot.base_config_revision_id,
            "draft_version_number": snapshot.draft_version_number,
            "payload": snapshot.payload,
            "validation_status": snapshot.validation_status,
            "validation_errors": list(snapshot.validation_errors),
            "updated_at": snapshot.updated_at,
        }
    )


def _validation_out(result: DraftValidationResult) -> FamilyModelDraftValidationOut:
    return FamilyModelDraftValidationOut(
        valid=result.valid,
        draft_version_number=result.draft_version_number,
        errors=[issue.record() for issue in result.errors],
        config_checksum=result.config_checksum,
        price_checksum=result.price_checksum,
    )


def _published_out(
    result: PublishedFamilyModelConfiguration,
) -> PublishedFamilyModelConfigurationOut:
    return PublishedFamilyModelConfigurationOut.model_validate(result.response_record())


def _price_draft_out(snapshot: FamilyPriceDraftSnapshot) -> FamilyModelPricesDraftOut:
    return FamilyModelPricesDraftOut.model_validate(snapshot.response_record())


def _published_price_out(
    result: PublishedFamilyPriceVersionResult,
) -> PublishedFamilyModelPricesOut:
    return PublishedFamilyModelPricesOut.model_validate(result.response_record())


def _search_replacement_out(progress: SearchReplacementProgress) -> SearchReplacementOut:
    return SearchReplacementOut.model_validate(progress.response_record())


def _search_replacement_preview_out(result) -> SearchReplacementPreviewOut:
    return SearchReplacementPreviewOut.model_validate(result.response_record())


def _price_rate_out(rate) -> FamilyModelPriceRateOut:
    return FamilyModelPriceRateOut(
        capability=rate.capability.value,
        variant_key=rate.variant_key,
        meter=rate.meter,
        provider_profile_id=rate.provider,
        billing_model=rate.billing_model,
        billing_scheme_key=rate.billing_scheme_key,
        unit_quantity=rate.unit_quantity,
        unit_price=rate.unit_price,
        source_currency=rate.source_currency,
        fx_to_cny=rate.fx_to_cny,
        unit_price_cny=rate.unit_price_cny,
        reported_model_aliases=list(rate.reported_model_aliases),
    )


def serialize_owner_model_prices(db: Session, *, family_id: str) -> FamilyModelPricesOut:
    settings = get_family_model_settings(db, family_id=family_id)
    if settings is None:
        raise FamilyModelSettingsError("family_model_settings_not_found")
    current_rates = (
        [_price_rate_out(rate) for rate in rates_for_family_price_version(
            db,
            family_id=family_id,
            price_version_id=settings.active_price_version_id,
        )]
        if settings.active_price_version_id is not None
        else []
    )
    history = [
        FamilyModelPriceVersionSummaryOut(
            id=version.id,
            config_revision_id=version.config_revision_id,
            search_profile_id=version.search_profile_id,
            base_price_version_id=version.base_price_version_id,
            purpose=version.purpose.value,
            version_number=version.version_number,
            checksum=version.manifest_checksum,
            change_note=version.change_note,
            published_by=version.published_by,
            published_at=version.created_at,
        )
        for version in list_family_price_history(db, family_id=family_id)
    ]
    draft = load_family_price_draft(db, family_id=family_id)
    return FamilyModelPricesOut(
        active_config_revision_id=settings.active_config_revision_id,
        active_price_version_id=settings.active_price_version_id,
        current_rates=current_rates,
        history=history,
        draft=_price_draft_out(draft) if draft is not None else None,
    )


def serialize_owner_model_settings(db: Session, *, family_id: str) -> FamilyModelSettingsOut:
    settings = get_family_model_settings(db, family_id=family_id)
    if settings is None:
        raise FamilyModelSettingsError("family_model_settings_not_found")
    profiles = [
        _profile_out(
            # The serializer only reads immutable endpoint metadata and safe
            # secret presence/version state.  It never decrypts a credential.
            provider_profile_snapshot(db, family_id=family_id, profile=profile)
        )
        for profile in list_provider_profiles(db, family_id=family_id)
    ]
    return FamilyModelSettingsOut(
        version_number=settings.version_number,
        active_config_revision_id=settings.active_config_revision_id,
        active_price_version_id=settings.active_price_version_id,
        active_search_profile_id=settings.active_search_profile_id,
        provider_profiles=profiles,
        updated_at=settings.updated_at,
    )


def _domain_error(exc: FamilyModelSettingsError) -> HTTPException:
    detail: dict[str, Any] = {"code": exc.code}
    if isinstance(exc, FamilyModelSettingsVersionConflict):
        if exc.current_draft_version_number is not None:
            detail["current_draft_version_number"] = exc.current_draft_version_number
        if exc.current_settings_version_number is not None:
            detail["current_settings_version_number"] = exc.current_settings_version_number
        if exc.current_config_revision_id is not None:
            detail["current_config_revision_id"] = exc.current_config_revision_id
        if exc.current_price_version_id is not None:
            detail["current_price_version_id"] = exc.current_price_version_id
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)
    if isinstance(exc, FamilyModelProviderProfileVersionConflict):
        if exc.current_profile_version_number is not None:
            detail["current_profile_version_number"] = exc.current_profile_version_number
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)
    if isinstance(exc, (FamilyModelProviderProfileNotFound, FamilyModelConfigDraftNotFound)) or exc.code == "family_search_profile_not_found":
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
    if isinstance(
        exc,
        (
            FamilyModelOperationIdempotencyConflict,
            FamilyModelOperationInProgress,
            FamilyModelProviderProfileInUse,
            FamilyModelConfigurationAlreadyPublished,
        ),
    ) or exc.code.endswith("_conflict"):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)
    if isinstance(exc, (FamilyModelProviderTransportError, FamilyModelProviderResponseTooLarge)):
        return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail)
    if isinstance(
        exc,
        (
            FamilyModelEndpointBlocked,
            FamilyModelProviderProtocolUnsupported,
            FamilyModelProviderScopeChangeRequiresNewProfile,
            FamilyModelSecretUnavailable,
            FamilyModelOwnerReauthenticationFailed,
        ),
    ):
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)


@router.get("", response_model=FamilyModelSettingsOut, response_model_exclude_none=True)
def get_settings_view(
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> FamilyModelSettingsOut:
    _, membership = auth
    try:
        return serialize_owner_model_settings(db, family_id=membership.family_id)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.get("/draft", response_model=FamilyModelConfigDraftOut, response_model_exclude_none=True)
def get_draft_view(
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> FamilyModelConfigDraftOut:
    _, membership = auth
    try:
        return _draft_out(load_config_draft(db, family_id=membership.family_id))
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.put("/draft", response_model=FamilyModelConfigDraftOut, response_model_exclude_none=True)
def save_draft_view(
    payload: SaveConfigDraftRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
) -> FamilyModelConfigDraftOut:
    user, membership = auth
    try:
        snapshot = save_config_draft(
            db,
            SaveConfigDraftCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                base_draft_version_number=payload.base_draft_version_number,
                idempotency_key=payload.idempotency_key,
                payload=payload.storage_payload().model_dump(mode="json", exclude_none=True),
            ),
            cipher=cipher,
        )
        commit_session(db)
        return _draft_out(snapshot)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/draft/validate",
    response_model=FamilyModelDraftValidationOut,
    response_model_exclude_none=True,
)
def validate_draft_view(
    payload: ValidateDraftRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    network_policy: ProviderNetworkPolicy = Depends(get_family_model_network_policy),
) -> FamilyModelDraftValidationOut:
    user, membership = auth
    try:
        result = validate_family_model_draft(
            db,
            ValidateDraftCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                network_policy=network_policy,
                base_draft_version_number=payload.base_draft_version_number,
            ),
        )
        commit_session(db)
        return _validation_out(result)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/publish",
    response_model=PublishedFamilyModelConfigurationOut,
    response_model_exclude_none=True,
)
def publish_settings_view(
    payload: PublishFamilyModelSettingsRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
    network_policy: ProviderNetworkPolicy = Depends(get_family_model_network_policy),
) -> PublishedFamilyModelConfigurationOut:
    user, membership = auth
    try:
        settings = get_family_model_settings(db, family_id=membership.family_id)
        if settings is None:
            raise FamilyModelSettingsError("family_model_settings_not_found")
        if settings.active_config_revision_id is None:
            if payload.current_password is None:
                raise FamilyModelOwnerReauthenticationFailed()
            verify_owner_password(
                db,
                family_id=membership.family_id,
                actor_user_id=user.id,
                current_password=payload.current_password.get_secret_value(),
            )
        result = publish_family_model_configuration(
            db,
            PublishConfigurationCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                base_settings_version_number=payload.base_settings_version_number,
                base_draft_version_number=payload.base_draft_version_number,
                idempotency_key=payload.idempotency_key,
                confirm_config_checksum=payload.config_checksum,
                confirm_price_checksum=payload.price_checksum,
                network_policy=network_policy,
            ),
            cipher=cipher,
        )
        commit_session(db)
        return _published_out(result)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.get(
    "/prices",
    response_model=FamilyModelPricesOut,
    response_model_exclude_none=True,
)
def get_prices_view(
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> FamilyModelPricesOut:
    _, membership = auth
    try:
        return serialize_owner_model_prices(db, family_id=membership.family_id)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.put(
    "/prices/draft",
    response_model=FamilyModelPricesDraftOut,
    response_model_exclude_none=True,
)
def save_prices_draft_view(
    payload: SaveFamilyModelPricesDraftRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
) -> FamilyModelPricesDraftOut:
    user, membership = auth
    try:
        snapshot = save_family_price_draft(
            db,
            SaveFamilyPriceDraftCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                base_draft_version_number=payload.base_draft_version_number,
                idempotency_key=payload.idempotency_key,
                base_price_version_id=payload.base_price_version_id,
                rates=payload.rates,
                change_note=payload.change_note,
            ),
            cipher=cipher,
        )
        commit_session(db)
        return _price_draft_out(snapshot)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/prices/publish",
    response_model=PublishedFamilyModelPricesOut,
    response_model_exclude_none=True,
)
def publish_prices_view(
    payload: PublishFamilyModelPricesRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
) -> PublishedFamilyModelPricesOut:
    user, membership = auth
    try:
        result = publish_family_price_version(
            db,
            PublishFamilyPriceVersionCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                base_settings_version_number=payload.base_settings_version_number,
                base_price_version_id=payload.base_price_version_id,
                idempotency_key=payload.idempotency_key,
                confirm_checksum=payload.confirm_checksum,
                change_note=payload.change_note,
                rates=payload.rates,
            ),
            cipher=cipher,
        )
        commit_session(db)
        return _published_price_out(result)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/provider-profiles",
    response_model=ProviderProfileOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def create_provider_profile_view(
    payload: ProviderProfileCreateRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
    network_policy: ProviderNetworkPolicy = Depends(get_family_model_network_policy),
) -> ProviderProfileOut:
    user, membership = auth
    try:
        snapshot = create_provider_profile(
            db,
            CreateProviderProfileCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                display_name=payload.display_name,
                adapter_kind=payload.adapter_kind,
                auth_mode=payload.auth_mode,
                api_base_url=payload.api_base_url,
                websocket_base_url=payload.websocket_base_url,
                options=payload.options.model_dump(mode="json", exclude_none=True),
                api_key=(
                    payload.api_key.get_secret_value() if payload.api_key is not None else None
                ),
                idempotency_key=payload.idempotency_key,
            ),
            cipher=cipher,
            network_policy=network_policy,
        )
        commit_session(db)
        return _profile_out(snapshot)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.patch(
    "/provider-profiles/{profile_id}",
    response_model=ProviderProfileOut,
    response_model_exclude_none=True,
)
def patch_provider_profile_view(
    profile_id: str,
    payload: ProviderProfilePatchRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
) -> ProviderProfileOut:
    user, membership = auth
    try:
        snapshot = update_provider_profile(
            db,
            UpdateProviderProfileCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                profile_id=profile_id,
                base_profile_version_number=payload.base_profile_version_number,
                idempotency_key=payload.idempotency_key,
                display_name=payload.display_name,
                status=payload.status.value if payload.status is not None else None,
            ),
            cipher=cipher,
        )
        commit_session(db)
        return _profile_out(snapshot)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/provider-profiles/{profile_id}/rotate-key",
    response_model=RotateProviderProfileSecretOut,
    response_model_exclude_none=True,
)
def rotate_provider_profile_key_view(
    profile_id: str,
    payload: RotateProviderProfileSecretRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
) -> RotateProviderProfileSecretOut:
    user, membership = auth
    try:
        # Capture the server-owned checksum before the rotation service obtains
        # its locks; that service rechecks it under lock before changing a key.
        profile = require_provider_profile(
            db,
            family_id=membership.family_id,
            profile_id=profile_id,
        )
        result = rotate_profile_secret(
            db,
            RotateProfileSecretCommand(
                family_id=membership.family_id,
                profile_id=profile_id,
                actor_user_id=user.id,
                current_password=payload.current_password.get_secret_value(),
                base_settings_version=payload.base_settings_version_number,
                idempotency_key=payload.idempotency_key,
                credential_scope_checksum=profile.credential_scope_checksum,
                new_api_key=payload.new_api_key.get_secret_value(),
            ),
            cipher=cipher,
        )
        commit_session(db)
        return RotateProviderProfileSecretOut(
            configured=result.configured,
            secret_version_number=result.secret_version_number,
            updated_at=result.updated_at,
        )
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/provider-profiles/{profile_id}/connection-check",
    response_model=ProviderConnectionCheckOut,
    response_model_exclude_none=True,
)
def provider_connection_check_view(
    profile_id: str,
    payload: ProviderConnectionCheckRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
    transport: ProviderTransport = Depends(get_family_model_provider_transport),
) -> ProviderConnectionCheckOut:
    user, membership = auth
    try:
        result = run_connection_check(
            db,
            ConnectionCheckCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                profile_id=profile_id,
                idempotency_key=payload.idempotency_key,
            ),
            cipher=cipher,
            transport=transport,
        )
        commit_session(db)
        return ProviderConnectionCheckOut(
            status=result.status,  # type: ignore[arg-type]
            detail=result.detail,
            checked_at=result.checked_at,
            latency_ms=result.latency_ms,
            profile_version_number=result.profile_version_number,
        )
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/capabilities/{capability}/test",
    response_model=CapabilityTestOut,
    response_model_exclude_none=True,
)
def capability_test_view(
    capability: FamilyModelCapability,
    payload: CapabilityTestRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    dependencies: CapabilityTestDependencies = Depends(
        get_family_model_capability_test_dependencies
    ),
) -> CapabilityTestOut:
    """Run one explicitly confirmed, billable test against active family config."""

    user, membership = auth
    try:
        result = run_family_capability_test(
            db,
            CapabilityTestCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                capability=capability,
                variant_key=payload.variant_key,
                confirm_billable=payload.confirm_billable,
                idempotency_key=payload.idempotency_key,
            ),
            dependencies=dependencies,
        )
        return CapabilityTestOut(
            capability=result.capability,
            variant_key=result.variant_key,
            status=result.status,
            detail=result.detail,
            checked_at=result.checked_at,
        )
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/search/replacements/preview",
    response_model=SearchReplacementPreviewOut,
    response_model_exclude_none=True,
)
def preview_search_replacement_view(
    payload: SearchReplacementPreviewRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    network_policy: ProviderNetworkPolicy = Depends(get_family_model_network_policy),
) -> SearchReplacementPreviewOut:
    """Return the server-calculated confirmation facts before a billable rebuild."""

    user, membership = auth
    try:
        result = preview_search_replacement(
            db,
            CreateSearchReplacementCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                current_password="",
                base_settings_version_number=payload.base_settings_version_number,
                base_search_profile_id=payload.base_search_profile_id,
                provider_profile_id=payload.provider_profile_id,
                requested_model=payload.requested_model,
                dimensions=payload.dimensions,
                rates=payload.rates,
                confirm_checksum="",
                idempotency_key="preview-not-persisted",
            ),
            network_policy=network_policy,
        )
        return _search_replacement_preview_out(result)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/search/replacements",
    response_model=SearchReplacementOut,
    response_model_exclude_none=True,
)
def create_search_replacement_view(
    payload: CreateSearchReplacementRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
    network_policy: ProviderNetworkPolicy = Depends(get_family_model_network_policy),
) -> SearchReplacementOut:
    user, membership = auth
    try:
        result = create_search_replacement(
            db,
            CreateSearchReplacementCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                current_password=payload.current_password.get_secret_value(),
                base_settings_version_number=payload.base_settings_version_number,
                base_search_profile_id=payload.base_search_profile_id,
                provider_profile_id=payload.provider_profile_id,
                requested_model=payload.requested_model,
                dimensions=payload.dimensions,
                rates=payload.rates,
                confirm_checksum=payload.confirm_checksum,
                idempotency_key=payload.idempotency_key,
            ),
            cipher=cipher,
            network_policy=network_policy,
        )
        commit_session(db)
        return _search_replacement_out(result.progress)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.get(
    "/search/replacements/{profile_id}",
    response_model=SearchReplacementOut,
    response_model_exclude_none=True,
)
def get_search_replacement_view(
    profile_id: str,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
) -> SearchReplacementOut:
    _, membership = auth
    try:
        return _search_replacement_out(
            search_replacement_progress(
                db,
                family_id=membership.family_id,
                profile_id=profile_id,
            )
        )
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/search/replacements/{profile_id}/retry",
    response_model=SearchReplacementOut,
    response_model_exclude_none=True,
)
def retry_search_replacement_view(
    profile_id: str,
    payload: SearchReplacementMutationRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
) -> SearchReplacementOut:
    user, membership = auth
    try:
        result = retry_search_replacement(
            db,
            SearchReplacementMutationCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                profile_id=profile_id,
                base_settings_version_number=payload.base_settings_version_number,
                idempotency_key=payload.idempotency_key,
            ),
            cipher=cipher,
        )
        commit_session(db)
        return _search_replacement_out(result.progress)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc


@router.post(
    "/search/replacements/{profile_id}/cancel",
    response_model=SearchReplacementOut,
    response_model_exclude_none=True,
)
def cancel_search_replacement_view(
    profile_id: str,
    payload: SearchReplacementMutationRequest,
    auth: tuple = Depends(require_owner),
    db: Session = Depends(get_db),
    cipher: FamilyModelCredentialCipher = Depends(get_family_model_credential_cipher),
) -> SearchReplacementOut:
    user, membership = auth
    try:
        result = cancel_search_replacement(
            db,
            SearchReplacementMutationCommand(
                family_id=membership.family_id,
                actor_user_id=user.id,
                profile_id=profile_id,
                base_settings_version_number=payload.base_settings_version_number,
                idempotency_key=payload.idempotency_key,
            ),
            cipher=cipher,
        )
        commit_session(db)
        return _search_replacement_out(result.progress)
    except FamilyModelSettingsError as exc:
        raise _domain_error(exc) from exc
