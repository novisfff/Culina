from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import ActivityAction, FamilyModelPricePurpose
from app.core.utils import create_id, utcnow
from app.models.family_model_settings import FamilyModelConfigDraft
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.repos.family_model_settings.configurations import get_config_draft
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.profiles import (
    lock_family_model_settings,
)
from app.repos.model_usage.catalog import (
    get_complete_active_family_price_version,
    list_family_price_versions,
    next_price_version_number,
)
from app.services.activity import log_activity
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
)
from app.services.family_model_settings.errors import (
    FamilyModelDraftInvalid,
    FamilyModelOperationInProgress,
    FamilyModelSettingsError,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.publishing import insert_family_price_rates
from app.services.family_model_settings.validation import (
    ValidatedFamilyPriceRate,
    price_checksum,
)
from app.schemas.family_model_settings import (
    FamilyModelConfigDraftPayload,
    FamilyModelPriceDraftPayload,
    FamilyModelPriceRateRequest,
)
from app.services.model_usage.configured_variants import configured_usage_variants
from app.services.model_usage.decimal_math import CNY_QUANTUM


@dataclass(frozen=True, slots=True)
class FamilyPriceDraftSnapshot:
    base_price_version_id: str | None
    draft_version_number: int
    rates: tuple[FamilyModelPriceRateRequest, ...]
    change_note: str
    updated_at: datetime | None

    def response_record(self) -> dict[str, object]:
        return {
            "base_price_version_id": self.base_price_version_id,
            "draft_version_number": self.draft_version_number,
            "rates": [rate.model_dump(mode="json") for rate in self.rates],
            "change_note": self.change_note,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


@dataclass(frozen=True, slots=True)
class SaveFamilyPriceDraftCommand:
    family_id: str
    actor_user_id: str
    base_draft_version_number: int
    idempotency_key: str
    base_price_version_id: str | None
    rates: Sequence[FamilyModelPriceRateRequest | Mapping[str, object]]
    change_note: str


@dataclass(frozen=True, slots=True)
class PublishFamilyPriceVersionCommand:
    family_id: str
    actor_user_id: str
    base_settings_version_number: int
    base_price_version_id: str
    idempotency_key: str
    confirm_checksum: str
    change_note: str
    rates: Sequence[FamilyModelPriceRateRequest | Mapping[str, object]]


@dataclass(frozen=True, slots=True)
class PublishedFamilyPriceVersionResult:
    family_id: str
    config_revision_id: str
    price_version_id: str
    settings_version_number: int
    price_checksum: str

    def response_record(self) -> dict[str, object]:
        return {
            "family_id": self.family_id,
            "config_revision_id": self.config_revision_id,
            "price_version_id": self.price_version_id,
            "settings_version_number": self.settings_version_number,
            "price_checksum": self.price_checksum,
        }


def _normalize_rates(
    rates: Sequence[FamilyModelPriceRateRequest | Mapping[str, object]],
) -> tuple[FamilyModelPriceRateRequest, ...]:
    try:
        normalized = tuple(
            item
            if isinstance(item, FamilyModelPriceRateRequest)
            else FamilyModelPriceRateRequest.model_validate(item)
            for item in rates
        )
    except (TypeError, ValidationError) as exc:
        raise FamilyModelDraftInvalid("family_model_price_incomplete") from exc
    identities = [
        (rate.capability, rate.variant_key, rate.meter.value) for rate in normalized
    ]
    if len(identities) != len(set(identities)):
        raise FamilyModelDraftInvalid("family_model_duplicate_price_rate")
    return normalized


def validate_complete_family_price_rates(
    db: Session,
    *,
    family_id: str,
    config_revision_id: str,
    rates: Sequence[FamilyModelPriceRateRequest | Mapping[str, object]],
) -> tuple[ValidatedFamilyPriceRate, ...]:
    """Validate an exact, non-sparse price table for one immutable revision."""

    normalized = _normalize_rates(rates)
    variants = configured_usage_variants(
        db,
        family_id=family_id,
        config_revision_id=config_revision_id,
    )
    by_identity = {
        (variant.capability.value, variant.variant_key): variant for variant in variants
    }
    supplied: dict[tuple[str, str], list[FamilyModelPriceRateRequest]] = {}
    for rate in normalized:
        supplied.setdefault((rate.capability, rate.variant_key), []).append(rate)

    validated: list[ValidatedFamilyPriceRate] = []
    for identity, group in supplied.items():
        variant = by_identity.get(identity)
        if variant is None:
            raise FamilyModelDraftInvalid("family_model_price_incomplete")
        meters = {rate.meter for rate in group}
        if meters != variant.billable_meters:
            raise FamilyModelDraftInvalid("family_model_price_incomplete")
        for rate in group:
            validated.append(
                ValidatedFamilyPriceRate(
                    capability=variant.capability,
                    variant_key=variant.variant_key,
                    meter=rate.meter,
                    provider=variant.provider,
                    billing_model=variant.billing_model,
                    billing_scheme_key=variant.billing_scheme_key,
                    unit_quantity=rate.unit_quantity,
                    unit_price=rate.unit_price,
                    source_currency=rate.source_currency,
                    fx_to_cny=rate.fx_to_cny,
                    unit_price_cny=(rate.unit_price * rate.fx_to_cny).quantize(
                        CNY_QUANTUM,
                        rounding=ROUND_HALF_UP,
                    ),
                    reported_model_aliases=tuple(rate.reported_model_aliases),
                )
            )
    if set(supplied) != set(by_identity):
        raise FamilyModelDraftInvalid("family_model_price_incomplete")
    return tuple(
        sorted(
            validated,
            key=lambda rate: (
                rate.capability.value,
                rate.variant_key,
                rate.meter.value,
            ),
        )
    )


def _draft_snapshot(draft: FamilyModelConfigDraft | None) -> FamilyPriceDraftSnapshot | None:
    if draft is None:
        return None
    try:
        payload = FamilyModelConfigDraftPayload.model_validate(draft.payload_json)
    except ValidationError as exc:
        raise FamilyModelDraftInvalid() from exc
    price_draft = payload.price_draft
    if price_draft is None:
        return None
    return FamilyPriceDraftSnapshot(
        base_price_version_id=price_draft.base_price_version_id,
        draft_version_number=draft.draft_version_number,
        rates=tuple(price_draft.rates),
        change_note=price_draft.change_note,
        updated_at=draft.updated_at,
    )


def load_family_price_draft(
    db: Session,
    *,
    family_id: str,
) -> FamilyPriceDraftSnapshot | None:
    return _draft_snapshot(get_config_draft(db, family_id=family_id))


def _snapshot_from_response(response: object) -> FamilyPriceDraftSnapshot:
    if not isinstance(response, Mapping):
        raise FamilyModelOperationInProgress()
    try:
        version = response["draft_version_number"]
        raw_updated_at = response.get("updated_at")
        if not isinstance(version, int) or not isinstance(raw_updated_at, (str, type(None))):
            raise TypeError
        payload = FamilyModelPriceDraftPayload.model_validate(
            {
                "base_price_version_id": response.get("base_price_version_id"),
                "rates": response["rates"],
                "change_note": response["change_note"],
            }
        )
        updated_at = (
            datetime.fromisoformat(raw_updated_at.replace("Z", "+00:00"))
            if raw_updated_at is not None
            else None
        )
    except (KeyError, TypeError, ValueError, ValidationError) as exc:
        raise FamilyModelOperationInProgress() from exc
    return FamilyPriceDraftSnapshot(
        base_price_version_id=payload.base_price_version_id,
        draft_version_number=version,
        rates=tuple(payload.rates),
        change_note=payload.change_note,
        updated_at=updated_at,
    )


def save_family_price_draft(
    db: Session,
    command: SaveFamilyPriceDraftCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> FamilyPriceDraftSnapshot:
    normalized_rates = _normalize_rates(command.rates)
    price_payload = FamilyModelPriceDraftPayload(
        base_price_version_id=command.base_price_version_id,
        rates=list(normalized_rates),
        change_note=command.change_note,
    )
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="save_family_model_price_draft",
        public_fields={
            "family_id": command.family_id,
            "base_draft_version_number": command.base_draft_version_number,
            "price_draft": price_payload.model_dump(mode="json"),
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="save_family_model_price_draft",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _snapshot_from_response(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    if (
        settings.active_config_revision_id is None
        or settings.active_price_version_id is None
    ):
        raise FamilyModelSettingsError("family_model_settings_not_configured")
    if (
        price_payload.base_price_version_id is not None
        and price_payload.base_price_version_id != settings.active_price_version_id
    ):
        raise FamilyModelSettingsVersionConflict(
            current_settings_version_number=settings.version_number,
            current_config_revision_id=settings.active_config_revision_id,
            current_price_version_id=settings.active_price_version_id,
        )
    validate_complete_family_price_rates(
        db,
        family_id=command.family_id,
        config_revision_id=settings.active_config_revision_id,
        rates=normalized_rates,
    )
    draft = get_config_draft(db, family_id=command.family_id, for_update=True)
    current_version = draft.draft_version_number if draft is not None else 0
    if current_version != command.base_draft_version_number:
        raise FamilyModelSettingsVersionConflict(
            current_draft_version_number=current_version
        )
    try:
        payload = (
            FamilyModelConfigDraftPayload.model_validate(draft.payload_json)
            if draft is not None
            else FamilyModelConfigDraftPayload()
        )
    except ValidationError as exc:
        raise FamilyModelDraftInvalid() from exc
    stored = payload.model_dump(mode="json", exclude_none=True)
    stored["price_draft"] = price_payload.model_dump(mode="json", exclude_none=True)
    changed_at = utcnow()
    if draft is None:
        draft = FamilyModelConfigDraft(
            family_id=command.family_id,
            base_config_revision_id=settings.active_config_revision_id,
            draft_version_number=1,
            payload_json=stored,
            validation_status="unknown",
            validation_errors_json=[],
            updated_at=changed_at,
            updated_by=command.actor_user_id,
        )
        db.add(draft)
    else:
        draft.payload_json = stored
        draft.draft_version_number += 1
        draft.updated_at = changed_at
        draft.updated_by = command.actor_user_id
    db.flush()
    snapshot = _draft_snapshot(draft)
    assert snapshot is not None
    complete_operation(
        claim,
        result_id=command.family_id,
        response_json=snapshot.response_record(),
        completed_at=changed_at,
    )
    db.flush()
    return snapshot


def _price_aliases(
    rates: Sequence[ValidatedFamilyPriceRate],
) -> dict[str, str]:
    return {
        f"{rate.provider}:{alias}": rate.billing_model
        for rate in rates
        for alias in rate.reported_model_aliases
    }


def _published_result_from_response(response: object) -> PublishedFamilyPriceVersionResult:
    if not isinstance(response, Mapping):
        raise FamilyModelOperationInProgress()
    try:
        family_id = response["family_id"]
        config_revision_id = response["config_revision_id"]
        price_version_id = response["price_version_id"]
        settings_version_number = response["settings_version_number"]
        checksum = response["price_checksum"]
        if (
            not isinstance(family_id, str)
            or not isinstance(config_revision_id, str)
            or not isinstance(price_version_id, str)
            or not isinstance(settings_version_number, int)
            or not isinstance(checksum, str)
        ):
            raise TypeError
    except (KeyError, TypeError) as exc:
        raise FamilyModelOperationInProgress() from exc
    return PublishedFamilyPriceVersionResult(
        family_id=family_id,
        config_revision_id=config_revision_id,
        price_version_id=price_version_id,
        settings_version_number=settings_version_number,
        price_checksum=checksum,
    )


def publish_family_price_version(
    db: Session,
    command: PublishFamilyPriceVersionCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> PublishedFamilyPriceVersionResult:
    """Publish a complete price-only version under the settings lock."""

    normalized_rates = _normalize_rates(command.rates)
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="publish_family_model_prices",
        public_fields={
            "family_id": command.family_id,
            "base_settings_version_number": command.base_settings_version_number,
            "base_price_version_id": command.base_price_version_id,
            "confirm_checksum": command.confirm_checksum,
            "change_note": command.change_note,
            "rates": [rate.model_dump(mode="json") for rate in normalized_rates],
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="publish_family_model_prices",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _published_result_from_response(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    if settings.version_number != command.base_settings_version_number:
        raise FamilyModelSettingsVersionConflict(
            current_settings_version_number=settings.version_number,
            current_config_revision_id=settings.active_config_revision_id,
            current_price_version_id=settings.active_price_version_id,
        )
    if settings.active_config_revision_id is None or settings.active_price_version_id is None:
        raise FamilyModelSettingsError("family_model_settings_not_configured")
    if command.base_price_version_id != settings.active_price_version_id:
        raise FamilyModelSettingsVersionConflict(
            current_settings_version_number=settings.version_number,
            current_config_revision_id=settings.active_config_revision_id,
            current_price_version_id=settings.active_price_version_id,
        )
    base_price = get_complete_active_family_price_version(
        db,
        family_id=command.family_id,
        config_revision_id=settings.active_config_revision_id,
        price_version_id=command.base_price_version_id,
    )
    if base_price is None:
        raise FamilyModelSettingsError("family_model_price_pointer_invalid")
    validated_rates = validate_complete_family_price_rates(
        db,
        family_id=command.family_id,
        config_revision_id=settings.active_config_revision_id,
        rates=normalized_rates,
    )
    checksum = price_checksum(validated_rates)
    if checksum != command.confirm_checksum:
        raise FamilyModelDraftInvalid("family_model_price_checksum_mismatch")

    changed_at = utcnow()
    version = ModelUsagePriceVersion(
        id=create_id("family-model-price"),
        family_id=command.family_id,
        config_revision_id=settings.active_config_revision_id,
        base_price_version_id=base_price.id,
        purpose=FamilyModelPricePurpose.ACTIVE,
        published_by=command.actor_user_id,
        version_number=next_price_version_number(db),
        status="published",
        effective_from=changed_at,
        reviewed_at=changed_at,
        source_ref="family-managed-model-settings",
        change_note=command.change_note,
        operator=command.actor_user_id,
        change_ticket=None,
        manifest_checksum=checksum,
        model_aliases_json=_price_aliases(validated_rates),
        fx_rates_json={
            "CNY": "1",
            **{rate.source_currency: str(rate.fx_to_cny) for rate in validated_rates},
        },
    )
    db.add(version)
    db.flush()
    insert_family_price_rates(db, price_version=version, rates=validated_rates)
    settings.active_price_version_id = version.id
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = changed_at
    result = PublishedFamilyPriceVersionResult(
        family_id=command.family_id,
        config_revision_id=settings.active_config_revision_id,
        price_version_id=version.id,
        settings_version_number=settings.version_number,
        price_checksum=checksum,
    )
    complete_operation(
        claim,
        result_id=version.id,
        response_json=result.response_record(),
        completed_at=changed_at,
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="FamilyModelPriceVersion",
        entity_id=version.id,
        summary="更新了家庭模型价格",
    )
    db.flush()
    return result


def list_family_price_history(
    db: Session,
    *,
    family_id: str,
    limit: int = 50,
) -> tuple[ModelUsagePriceVersion, ...]:
    return list_family_price_versions(db, family_id=family_id, limit=limit)


def rates_for_family_price_version(
    db: Session,
    *,
    family_id: str,
    price_version_id: str,
) -> tuple[ModelUsagePriceRate, ...]:
    version = db.scalar(
        select(ModelUsagePriceVersion).where(
            ModelUsagePriceVersion.family_id == family_id,
            ModelUsagePriceVersion.id == price_version_id,
        )
    )
    if version is None:
        return ()
    return tuple(
        db.scalars(
            select(ModelUsagePriceRate)
            .where(ModelUsagePriceRate.price_version_id == version.id)
            .order_by(
                ModelUsagePriceRate.capability,
                ModelUsagePriceRate.variant_key,
                ModelUsagePriceRate.meter,
            )
        )
    )
