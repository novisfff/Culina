from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
import re
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    FamilyModelConfigRevisionStatus,
    FamilyModelPricePurpose,
    ModelUsageCapability,
    ModelUsageMeter,
)
from app.core.utils import utcnow
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigRevision,
    FamilyModelConfigDraft,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSettings,
)
from app.models.model_usage import ModelUsagePriceRate, ModelUsagePriceVersion
from app.repos.family_model_settings.configurations import get_config_draft
from app.repos.family_model_settings.configurations import get_config_revision
from app.repos.family_model_settings.configurations import list_capability_bindings
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.search_profiles import get_search_profile
from app.repos.family_model_settings.profiles import (
    get_family_model_settings,
    lock_family_model_settings,
)
from app.schemas.family_model_settings import (
    FamilyModelConfigDraftPayload,
    FamilyModelPriceRateRequest,
)
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    operation_request_fingerprint,
)
from app.services.family_model_settings.errors import (
    FamilyModelDraftInvalid,
    FamilyModelOperationInProgress,
    FamilyModelProviderProfileNotFound,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.validation import (
    DraftValidationIssue,
    DraftValidationResult,
    ValidatedCapabilityBinding,
    ValidatedFamilyPriceRate,
    _binding_identity_checksum,
    _active_search_profile,
    config_checksum,
    price_checksum,
    required_meters_for_capability,
    validate_family_model_capability_rates,
    validate_family_model_capability,
)


_WRITE_ONLY_DRAFT_KEYS = frozenset(
    {
        "api_key",
        "new_api_key",
        "current_password",
        "nonce",
        "ciphertext",
        "auth_tag",
        "secret_fingerprint",
    }
)

_ACTIVE_BINDING_OPTION_FIELDS: Mapping[ModelUsageCapability, frozenset[str]] = {
    ModelUsageCapability.LLM: frozenset(
        {"max_output_tokens", "supports_vision", "prompt_cache_enabled"}
    ),
    ModelUsageCapability.IMAGE_GENERATION: frozenset({"image_size", "response_format"}),
    ModelUsageCapability.STT: frozenset({"language_hint", "hotwords"}),
    ModelUsageCapability.TTS: frozenset({"voice", "output_format"}),
    ModelUsageCapability.REALTIME_AUDIO: frozenset({"voice", "language_hint"}),
    ModelUsageCapability.EMBEDDING: frozenset({"dimensions"}),
    ModelUsageCapability.RERANK: frozenset({"top_n", "instruction"}),
}

_ACTIVE_BINDING_VARIANTS: Mapping[ModelUsageCapability, frozenset[str]] = {
    ModelUsageCapability.LLM: frozenset({"primary", "fallback"}),
    ModelUsageCapability.IMAGE_GENERATION: frozenset({"text", "reference"}),
    ModelUsageCapability.STT: frozenset({"default"}),
    ModelUsageCapability.TTS: frozenset({"default"}),
    ModelUsageCapability.REALTIME_AUDIO: frozenset({"default"}),
    ModelUsageCapability.EMBEDDING: frozenset({"search"}),
    ModelUsageCapability.RERANK: frozenset({"search"}),
}

_DEFAULT_BILLING_SCHEMES: Mapping[ModelUsageCapability, str] = {
    ModelUsageCapability.LLM: "llm-split-v1",
    ModelUsageCapability.IMAGE_GENERATION: "image-count-v1",
    ModelUsageCapability.STT: "stt-seconds-v1",
    ModelUsageCapability.TTS: "tts-characters-v1",
    ModelUsageCapability.REALTIME_AUDIO: "realtime-asr-seconds-tts-characters-v1",
    ModelUsageCapability.EMBEDDING: "embedding-token-v1",
    ModelUsageCapability.RERANK: "rerank-token-v1",
}

_CURRENCY_RE = re.compile(r"^[A-Z]{3,8}$")


@dataclass(frozen=True, slots=True)
class SaveConfigDraftCommand:
    family_id: str
    actor_user_id: str
    base_draft_version_number: int
    idempotency_key: str
    payload: Mapping[str, Any]
    confirm_initial_search_index: bool = False


@dataclass(frozen=True, slots=True)
class ConfigDraftSnapshot:
    base_config_revision_id: str | None
    draft_version_number: int
    payload: dict[str, Any]
    validation_status: str
    validation_errors: tuple[dict[str, str], ...]
    updated_at: datetime | None

    def response_record(self) -> dict[str, Any]:
        return {
            "base_config_revision_id": self.base_config_revision_id,
            "draft_version_number": self.draft_version_number,
            "payload": self.payload,
            "validation_status": self.validation_status,
            "validation_errors": list(self.validation_errors),
            "updated_at": self.updated_at.isoformat() if self.updated_at is not None else None,
        }


def remove_write_only_secret_commands(value: Any) -> Any:
    """Defence in depth for historical/hand-built payloads.

    Strict Pydantic schemas reject these keys today, but persistence must remain
    safe if an older client or a future route hands a raw mapping to this
    service.  The helper preserves ordinary values and only removes known
    write-only credential fields.
    """

    if isinstance(value, Mapping):
        return {
            str(key): remove_write_only_secret_commands(item)
            for key, item in value.items()
            if key not in _WRITE_ONLY_DRAFT_KEYS
        }
    if isinstance(value, list):
        return [remove_write_only_secret_commands(item) for item in value]
    if isinstance(value, tuple):
        return [remove_write_only_secret_commands(item) for item in value]
    return value


def _snapshot(
    draft: FamilyModelConfigDraft,
    *,
    fallback_search_profile_id: str | None = None,
) -> ConfigDraftSnapshot:
    payload, payload_issues = _safe_payload_from_raw(draft.payload_json)
    if payload.search_profile_id is None and fallback_search_profile_id is not None:
        payload = payload.model_copy(update={"search_profile_id": fallback_search_profile_id})
    errors: list[dict[str, str]] = []
    raw_validation_errors = draft.validation_errors_json
    if not isinstance(raw_validation_errors, Sequence) or isinstance(
        raw_validation_errors, (str, bytes, bytearray)
    ):
        raw_validation_errors = ()
    for item in raw_validation_errors:
        if not isinstance(item, Mapping):
            continue
        code = item.get("code")
        if not isinstance(code, str) or not code:
            continue
        normalized = {"code": code[:160]}
        field = item.get("field")
        if isinstance(field, str) and field:
            normalized["field"] = field[:255]
        if normalized:
            errors.append(normalized)
    for issue in payload_issues:
        record = issue.record()
        if record not in errors:
            errors.append(record)
    validation_status = (
        draft.validation_status
        if isinstance(draft.validation_status, str) and draft.validation_status
        else "invalid"
    )
    if payload_issues:
        validation_status = "invalid"
    return ConfigDraftSnapshot(
        base_config_revision_id=draft.base_config_revision_id,
        draft_version_number=draft.draft_version_number,
        payload=payload.model_dump(mode="json", exclude_none=True),
        validation_status=validation_status,
        validation_errors=tuple(errors),
        updated_at=draft.updated_at,
    )


def _snapshot_from_response(response: object) -> ConfigDraftSnapshot:
    if not isinstance(response, Mapping):
        raise FamilyModelOperationInProgress()
    try:
        payload = FamilyModelConfigDraftPayload.model_validate(response["payload"])
        version = response["draft_version_number"]
        status = response["validation_status"]
        raw_errors = response.get("validation_errors", [])
        raw_updated_at = response.get("updated_at")
        if (
            not isinstance(version, int)
            or not isinstance(status, str)
            or not isinstance(raw_errors, list)
            or (raw_updated_at is not None and not isinstance(raw_updated_at, str))
        ):
            raise TypeError
        updated_at = datetime.fromisoformat(raw_updated_at.replace("Z", "+00:00")) if raw_updated_at else None
        safe_errors: list[dict[str, str]] = []
        for item in raw_errors:
            if not isinstance(item, Mapping):
                continue
            code = item.get("code")
            if not isinstance(code, str) or not code:
                continue
            safe_error = {"code": code[:160]}
            field = item.get("field")
            if isinstance(field, str) and field:
                safe_error["field"] = field[:255]
            if safe_error not in safe_errors:
                safe_errors.append(safe_error)
        errors = tuple(safe_errors)
        base_revision = response.get("base_config_revision_id")
        if base_revision is not None and not isinstance(base_revision, str):
            raise TypeError
    except (KeyError, TypeError, ValueError, ValidationError) as exc:
        raise FamilyModelOperationInProgress() from exc
    return ConfigDraftSnapshot(
        base_config_revision_id=base_revision,
        draft_version_number=version,
        payload=payload.model_dump(mode="json", exclude_none=True),
        validation_status=status,
        validation_errors=errors,
        updated_at=updated_at,
    )


def _require_owned_profile_references(
    db: Session,
    *,
    family_id: str,
    payload: FamilyModelConfigDraftPayload,
) -> None:
    profile_ids = {
        binding.provider_profile_id
        for binding in payload.bindings
        if binding.provider_profile_id is not None
    }
    if not profile_ids:
        return
    owned = set(
        db.scalars(
            select(FamilyModelProviderProfile.id).where(
                FamilyModelProviderProfile.family_id == family_id,
                FamilyModelProviderProfile.id.in_(profile_ids),
            )
        )
    )
    if owned != profile_ids:
        raise FamilyModelProviderProfileNotFound()


def _sanitize_disabled_binding_references(
    payload: FamilyModelConfigDraftPayload,
) -> FamilyModelConfigDraftPayload:
    """Drop provider identities from disabled cards before persistence.

    A disabled card is inert and does not own a Provider.  Older clients kept
    the last selected profile on the card, and old snapshots can point at a
    deleted or different-family profile.  Carrying that ID through the draft
    makes an unrelated card save fail the ownership check (or leaves a stale
    foreign key in JSON), so normalize it at the request boundary.  Enabled
    cards are left untouched and remain subject to the strict family check.
    """

    changed = False
    bindings = []
    for binding in payload.bindings:
        if not binding.enabled and binding.provider_profile_id is not None:
            bindings.append(binding.model_copy(update={"provider_profile_id": None}))
            changed = True
        else:
            bindings.append(binding)
    return payload.model_copy(update={"bindings": bindings}) if changed else payload


def _sanitize_non_owned_profile_references(
    db: Session,
    *,
    family_id: str,
    payload: FamilyModelConfigDraftPayload,
) -> FamilyModelConfigDraftPayload:
    """Make stale historical profile IDs inert without crossing families."""

    profile_ids = {
        binding.provider_profile_id
        for binding in payload.bindings
        if binding.enabled and binding.provider_profile_id is not None
    }
    if not profile_ids:
        return payload
    owned = set(
        db.scalars(
            select(FamilyModelProviderProfile.id).where(
                FamilyModelProviderProfile.family_id == family_id,
                FamilyModelProviderProfile.id.in_(profile_ids),
            )
        )
    )
    changed = False
    bindings = []
    for binding in payload.bindings:
        if (
            binding.enabled
            and binding.provider_profile_id is not None
            and binding.provider_profile_id not in owned
        ):
            bindings.append(binding.model_copy(update={"provider_profile_id": None}))
            changed = True
        else:
            bindings.append(binding)
    return payload.model_copy(update={"bindings": bindings}) if changed else payload


def load_config_draft(
    db: Session,
    *,
    family_id: str,
) -> ConfigDraftSnapshot:
    draft = get_config_draft(db, family_id=family_id)
    if draft is None:
        return ConfigDraftSnapshot(
            base_config_revision_id=None,
            draft_version_number=0,
            payload=FamilyModelConfigDraftPayload().model_dump(mode="json"),
            validation_status="unknown",
            validation_errors=(),
            updated_at=None,
        )
    fallback_search_profile_id: str | None = None
    if draft.base_config_revision_id is not None:
        revision = get_config_revision(
            db,
            family_id=family_id,
            config_revision_id=draft.base_config_revision_id,
        )
        fallback_search_profile_id = revision.search_profile_id if revision is not None else None
    return _snapshot(draft, fallback_search_profile_id=fallback_search_profile_id)


def _ready_initial_embedding(payload: FamilyModelConfigDraftPayload):
    return next(
        (
            binding
            for binding in payload.bindings
            if binding.capability == "embedding"
            and binding.enabled
            and binding.provider_profile_id is not None
            and bool(binding.requested_model.strip())
        ),
        None,
    )


def _configured_search_profile(db: Session, *, settings):
    return _active_search_profile(db, settings=settings)


def _binding_identity(value: object) -> tuple[str, str] | None:
    capability = getattr(value, "capability", None)
    capability_value = capability.value if isinstance(capability, ModelUsageCapability) else capability
    variant = getattr(value, "variant_key", None)
    if isinstance(capability_value, str) and isinstance(variant, str):
        return capability_value, variant
    return None


def _model_record(value: object) -> object:
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return model_dump(mode="json", exclude_none=False)
    return value


def _binding_records_equal(left: object, right: object) -> bool:
    """Compare a binding after Pydantic defaults have been materialized."""

    return _model_record(left) == _model_record(right)


def _coerce_capability(value: object) -> ModelUsageCapability | None:
    raw = value.value if isinstance(value, ModelUsageCapability) else value
    if not isinstance(raw, str):
        return None
    try:
        return ModelUsageCapability(raw)
    except ValueError:
        return None


def _default_binding_record(
    capability: ModelUsageCapability,
    variant_key: str,
) -> dict[str, object]:
    record: dict[str, object] = {
        "capability": capability.value,
        "variant_key": variant_key,
        "enabled": False,
        "provider_profile_id": None,
        "requested_model": "",
        "billing_scheme_key": _DEFAULT_BILLING_SCHEMES[capability],
    }
    if capability is ModelUsageCapability.LLM:
        record.update(
            {
                "max_output_tokens": 4096 if variant_key == "primary" else 2048,
                "supports_vision": False,
                "prompt_cache_enabled": True,
            }
        )
    elif capability is ModelUsageCapability.IMAGE_GENERATION:
        record.update({"image_size": "1024x1024", "response_format": "b64_json"})
    elif capability is ModelUsageCapability.STT:
        record.update({"language_hint": None, "hotwords": []})
    elif capability is ModelUsageCapability.TTS:
        record.update({"voice": None, "output_format": "mp3"})
    elif capability is ModelUsageCapability.REALTIME_AUDIO:
        record.update({"voice": None, "language_hint": None})
    elif capability is ModelUsageCapability.EMBEDDING:
        record.update({"dimensions": 1536})
    elif capability is ModelUsageCapability.RERANK:
        record.update({"top_n": 20, "instruction": None})
    return record


def _parse_single_binding_record(record: Mapping[str, object]) -> object | None:
    """Parse one binding without allowing a sibling to poison the payload."""

    try:
        parsed = FamilyModelConfigDraftPayload.model_validate({"bindings": [record]})
    except (TypeError, ValueError, ValidationError):
        return None
    return parsed.bindings[0] if parsed.bindings else None


def _safe_binding_record_from_raw(
    value: object,
) -> tuple[dict[str, object] | None, bool]:
    """Normalize one historical/raw binding to the current public shape.

    Drafts written by an older release can contain removed options or partially
    written values.  Parsing the complete discriminated union would reject the
    whole draft in that case.  We keep the binding identity where it is known,
    discard unknown fields, and fall back to current option defaults when an
    old option no longer satisfies its type.  The boolean tells callers that a
    repair fact should be surfaced without exposing the rejected value.
    """

    if not isinstance(value, Mapping):
        return None, True
    capability = _coerce_capability(value.get("capability"))
    variant_key = value.get("variant_key")
    if (
        capability is None
        or not isinstance(variant_key, str)
        or variant_key not in _ACTIVE_BINDING_VARIANTS[capability]
    ):
        return None, True

    defaults = _default_binding_record(capability, variant_key)
    allowed = set(defaults)
    record: dict[str, object] = {
        key: value[key] if key in value else default
        for key, default in defaults.items()
        if key in allowed
    }
    malformed = False

    raw_enabled = value.get("enabled", defaults["enabled"])
    if isinstance(raw_enabled, bool):
        record["enabled"] = raw_enabled
    else:
        record["enabled"] = False
        malformed = True

    raw_profile_id = value.get("provider_profile_id", defaults["provider_profile_id"])
    if raw_profile_id is None or isinstance(raw_profile_id, str):
        record["provider_profile_id"] = raw_profile_id
    else:
        record["provider_profile_id"] = None
        malformed = True

    raw_model = value.get("requested_model", defaults["requested_model"])
    if isinstance(raw_model, str):
        if len(raw_model) > 160:
            malformed = True
        record["requested_model"] = raw_model[:160]
    else:
        record["requested_model"] = ""
        malformed = True

    raw_scheme = value.get("billing_scheme_key", defaults["billing_scheme_key"])
    if isinstance(raw_scheme, str):
        record["billing_scheme_key"] = raw_scheme
    else:
        record["billing_scheme_key"] = defaults["billing_scheme_key"]
        malformed = True

    parsed = _parse_single_binding_record(record)
    if parsed is None:
        # Keep the core identity and let the normal capability validator report
        # an empty/disabled card.  Option values are the only fields we reset
        # wholesale here; this avoids turning a repairable model/provider edit
        # into an invisible default.
        malformed = True
        fallback = dict(defaults)
        fallback.update(
            {
                "enabled": record["enabled"],
                "provider_profile_id": record["provider_profile_id"],
                "requested_model": record["requested_model"],
                "billing_scheme_key": defaults["billing_scheme_key"],
            }
        )
        parsed = _parse_single_binding_record(fallback)
    if parsed is None:
        # A malformed core is safest represented as an inert card.  This branch
        # is deliberately unreachable for the current schema, but protects a
        # GET/maintenance path from ever returning an invalid response model.
        fallback = dict(defaults)
        fallback.update(
            {
                "enabled": False,
                "provider_profile_id": None,
                "requested_model": "",
            }
        )
        parsed = _parse_single_binding_record(fallback)
    if parsed is None:
        return None, True

    parsed_record = parsed.model_dump(mode="json", exclude_none=False)  # type: ignore[union-attr]
    if parsed_record.get("enabled") is not True:
        # A disabled binding is inert and must not carry a historical profile
        # into an ownership check during a later sparse save.
        parsed_record["provider_profile_id"] = None
    return parsed_record, malformed


def _safe_rate_record_from_raw(
    value: object,
) -> tuple[dict[str, object] | None, bool]:
    """Normalize one historical/raw price row without echoing bad values."""

    if not isinstance(value, Mapping):
        return None, True
    capability = _coerce_capability(value.get("capability"))
    variant_key = value.get("variant_key")
    meter_raw = value.get("meter")
    meter = meter_raw if isinstance(meter_raw, ModelUsageMeter) else None
    if meter is None and isinstance(meter_raw, str):
        try:
            meter = ModelUsageMeter(meter_raw)
        except ValueError:
            meter = None
    if (
        capability is None
        or not isinstance(variant_key, str)
        or not 1 <= len(variant_key) <= 120
        or meter is None
    ):
        return None, True

    record: dict[str, object] = {
        "capability": capability.value,
        "variant_key": variant_key,
        "meter": meter.value,
        "unit_quantity": value.get("unit_quantity", _default_unit_quantity(meter)),
        "unit_price": value.get("unit_price", Decimal("0")),
        "source_currency": value.get("source_currency", "CNY"),
        "fx_to_cny": value.get("fx_to_cny", Decimal("1")),
        "reported_model_aliases": value.get("reported_model_aliases", []),
    }
    try:
        parsed = FamilyModelPriceRateRequest.model_validate(record)
    except (TypeError, ValueError, ValidationError):
        parsed = None
    if parsed is not None:
        return parsed.model_dump(mode="json", exclude_none=False), False

    # Retry with bounded, non-secret defaults.  A malformed historical rate is
    # still useful to show as a zero/repairable row, but it must never prevent a
    # sibling capability from loading or being saved.
    quantity = _coerce_decimal(
        record.get("unit_quantity"),
        default=_default_unit_quantity(meter),
        positive=True,
    )
    price = _coerce_decimal(record.get("unit_price"), default=Decimal("0"))
    fx = _coerce_decimal(record.get("fx_to_cny"), default=Decimal("1"), positive=True)
    currency = record.get("source_currency")
    currency = currency.strip().upper() if isinstance(currency, str) else "CNY"
    if not _CURRENCY_RE.fullmatch(currency):
        currency = "CNY"
    aliases_value = record.get("reported_model_aliases")
    aliases: list[str] = []
    if isinstance(aliases_value, (list, tuple)):
        for alias in aliases_value:
            if isinstance(alias, str):
                alias = alias.strip()[:160]
                if alias and alias not in aliases:
                    aliases.append(alias)
    fallback = {
        "capability": capability.value,
        "variant_key": variant_key,
        "meter": meter.value,
        "unit_quantity": str(quantity),
        "unit_price": str(price),
        "source_currency": currency,
        "fx_to_cny": str(fx),
        "reported_model_aliases": aliases,
    }
    try:
        parsed = FamilyModelPriceRateRequest.model_validate(fallback)
    except (TypeError, ValueError, ValidationError):
        return None, True
    return parsed.model_dump(mode="json", exclude_none=False), True


def _safe_payload_from_raw(
    raw: object,
) -> tuple[FamilyModelConfigDraftPayload, tuple[DraftValidationIssue, ...]]:
    """Build a response-safe payload from a possibly stale JSON document.

    Each binding/rate is parsed independently.  This is used by GET, sparse
    saves and capability probes so one historical record cannot trigger a
    whole-payload 500 or block an unrelated capability.
    """

    if not isinstance(raw, Mapping):
        return FamilyModelConfigDraftPayload(), (
            DraftValidationIssue("family_model_draft_invalid"),
        )
    cleaned = remove_write_only_secret_commands(raw)
    if not isinstance(cleaned, Mapping):
        return FamilyModelConfigDraftPayload(), (
            DraftValidationIssue("family_model_draft_invalid"),
        )
    issues: list[DraftValidationIssue] = []

    def append_issue(code: str, field: str | None = None) -> None:
        issue = DraftValidationIssue(code, field)
        if issue not in issues:
            issues.append(issue)

    raw_bindings = cleaned.get("bindings", [])
    binding_records: list[dict[str, object]] = []
    seen_bindings: set[tuple[str, str]] = set()
    if isinstance(raw_bindings, Sequence) and not isinstance(raw_bindings, (str, bytes, bytearray)):
        for index, item in enumerate(raw_bindings[:16]):
            record, malformed = _safe_binding_record_from_raw(item)
            if malformed:
                append_issue("family_model_draft_invalid", f"bindings.{index}")
            if record is None:
                continue
            identity = (str(record["capability"]), str(record["variant_key"]))
            if identity in seen_bindings:
                append_issue("family_model_draft_invalid", f"bindings.{index}")
                continue
            seen_bindings.add(identity)
            binding_records.append(record)
        if len(raw_bindings) > 16:
            append_issue("family_model_draft_invalid", "bindings")
    elif raw_bindings not in (None, []):
        append_issue("family_model_draft_invalid", "bindings")

    raw_rates = cleaned.get("price_rates", [])
    rate_records: list[dict[str, object]] = []
    seen_rates: set[tuple[str, str, str]] = set()
    if isinstance(raw_rates, Sequence) and not isinstance(raw_rates, (str, bytes, bytearray)):
        for index, item in enumerate(raw_rates[:256]):
            record, malformed = _safe_rate_record_from_raw(item)
            if malformed:
                append_issue("family_model_draft_invalid", f"price_rates.{index}")
            if record is None:
                continue
            identity = (
                str(record["capability"]),
                str(record["variant_key"]),
                str(record["meter"]),
            )
            if identity in seen_rates:
                append_issue("family_model_draft_invalid", f"price_rates.{index}")
                continue
            seen_rates.add(identity)
            rate_records.append(record)
        if len(raw_rates) > 256:
            append_issue("family_model_draft_invalid", "price_rates")
    elif raw_rates not in (None, []):
        append_issue("family_model_draft_invalid", "price_rates")

    price_draft: dict[str, object] | None = None
    raw_price_draft = cleaned.get("price_draft")
    if raw_price_draft is not None:
        if isinstance(raw_price_draft, Mapping):
            draft_rates: list[dict[str, object]] = []
            seen_draft_rates: set[tuple[str, str, str]] = set()
            raw_draft_rates = raw_price_draft.get("rates", [])
            if isinstance(raw_draft_rates, Sequence) and not isinstance(
                raw_draft_rates, (str, bytes, bytearray)
            ):
                for index, item in enumerate(raw_draft_rates[:256]):
                    record, malformed = _safe_rate_record_from_raw(item)
                    if malformed:
                        append_issue("family_model_draft_invalid", f"price_draft.rates.{index}")
                    if record is None:
                        continue
                    identity = (
                        str(record["capability"]),
                        str(record["variant_key"]),
                        str(record["meter"]),
                    )
                    if identity in seen_draft_rates:
                        append_issue("family_model_draft_invalid", f"price_draft.rates.{index}")
                        continue
                    seen_draft_rates.add(identity)
                    draft_rates.append(record)
            elif raw_draft_rates not in (None, []):
                append_issue("family_model_draft_invalid", "price_draft.rates")
            price_draft = {
                "base_price_version_id": (
                    raw_price_draft.get("base_price_version_id")
                    if isinstance(raw_price_draft.get("base_price_version_id"), str)
                    else None
                ),
                "rates": draft_rates,
                "change_note": (
                    raw_price_draft.get("change_note")[:255]
                    if isinstance(raw_price_draft.get("change_note"), str)
                    else ""
                ),
            }
        else:
            append_issue("family_model_draft_invalid", "price_draft")

    payload_data: dict[str, object] = {
        "base_config_revision_id": (
            cleaned.get("base_config_revision_id")
            if isinstance(cleaned.get("base_config_revision_id"), str)
            else None
        ),
        "search_profile_id": (
            cleaned.get("search_profile_id")
            if isinstance(cleaned.get("search_profile_id"), str)
            else None
        ),
        "bindings": binding_records,
        "price_rates": rate_records,
        "price_draft": price_draft,
        "change_note": (
            cleaned.get("change_note")[:255]
            if isinstance(cleaned.get("change_note"), str)
            else ""
        ),
    }
    try:
        payload = FamilyModelConfigDraftPayload.model_validate(payload_data)
    except (TypeError, ValueError, ValidationError):
        # The per-item fallbacks above should make this impossible. Keep the
        # endpoint safe even if a future schema adds a cross-field invariant.
        append_issue("family_model_draft_invalid")
        payload = FamilyModelConfigDraftPayload()
    return payload, tuple(issues)


def _active_binding_payload(binding: FamilyModelCapabilityBinding) -> dict[str, object] | None:
    """Normalize one immutable row to the current public draft shape.

    Immutable snapshots intentionally outlive the request schema.  In
    particular, a row created by an older release may contain an option or
    billing scheme that no longer exists.  Such a row is reduced to the
    current schema defaults rather than allowing it to poison an unrelated
    card save.  Unknown capability/variant identities are omitted because
    there is no safe runtime contract for them.
    """

    capability = _coerce_capability(getattr(binding, "capability", None))
    variant_key = getattr(binding, "variant_key", None)
    if (
        capability is None
        or not isinstance(variant_key, str)
        or variant_key not in _ACTIVE_BINDING_VARIANTS[capability]
    ):
        return None

    defaults = _default_binding_record(capability, variant_key)
    enabled = getattr(binding, "enabled", False)
    defaults["enabled"] = enabled if isinstance(enabled, bool) else False
    provider_profile_id = getattr(binding, "provider_profile_id", None)
    defaults["provider_profile_id"] = (
        provider_profile_id if isinstance(provider_profile_id, str) else None
    )
    requested_model = getattr(binding, "requested_model", "")
    if isinstance(requested_model, str):
        defaults["requested_model"] = requested_model[:160]
    if defaults["enabled"] is not True:
        # Disabled rows do not own a provider. Clearing a historical ID keeps
        # profile deletion/rebinding independent from inert cards.
        defaults["provider_profile_id"] = None
    elif (
        not isinstance(defaults["provider_profile_id"], str)
        or not defaults["provider_profile_id"]
        or not str(defaults["requested_model"]).strip()
    ):
        # A legacy row may have been marked enabled while its core identity
        # was only partially written. Such a row cannot be resolved by the
        # runtime, so carry it forward as an inert card instead of allowing a
        # sibling save to create another unusable active snapshot.
        defaults["enabled"] = False
        defaults["provider_profile_id"] = None
    billing_scheme_key = getattr(binding, "billing_scheme_key", None)
    if (
        isinstance(billing_scheme_key, str)
        and billing_scheme_key == _DEFAULT_BILLING_SCHEMES[capability]
    ):
        defaults["billing_scheme_key"] = billing_scheme_key
    raw_options = getattr(binding, "options_json", {})
    if isinstance(raw_options, Mapping):
        for key in _ACTIVE_BINDING_OPTION_FIELDS[capability]:
            if key in raw_options:
                defaults[key] = raw_options[key]

    def parse(record: dict[str, object]):
        try:
            parsed = FamilyModelConfigDraftPayload.model_validate(
                {"bindings": [record]}
            )
        except (TypeError, ValueError, ValidationError):
            return None
        return parsed.bindings[0]

    parsed = parse(defaults)
    if parsed is not None:
        return parsed.model_dump(mode="json", exclude_none=False)

    # A single malformed option should not discard the identity or provider.
    # Revert option values as a group to the current schema defaults, then
    # retry with the sanitized core fields above.
    fallback = _default_binding_record(capability, variant_key)
    fallback.update(
        {
            "enabled": defaults["enabled"],
            "provider_profile_id": defaults["provider_profile_id"],
            "requested_model": defaults["requested_model"],
            "billing_scheme_key": _DEFAULT_BILLING_SCHEMES[capability],
        }
    )
    parsed = parse(fallback)
    if parsed is None:
        # A malformed historical core is safest represented as a disabled
        # card.  It remains visible in the draft and cannot create an invalid
        # active foreign-key binding during the next unrelated save.
        fallback["enabled"] = False
        fallback["provider_profile_id"] = None
        fallback["requested_model"] = ""
        parsed = parse(fallback)
    return parsed.model_dump(mode="json", exclude_none=False) if parsed else None


def _coerce_decimal(value: object, *, default: Decimal, positive: bool = False) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default
    if not result.is_finite() or (result <= 0 if positive else result < 0):
        return default
    return result


def _default_unit_quantity(meter: ModelUsageMeter) -> Decimal:
    if meter is ModelUsageMeter.GENERATED_IMAGES:
        return Decimal("1")
    if meter is ModelUsageMeter.AUDIO_INPUT_SECONDS:
        return Decimal("60")
    if meter is ModelUsageMeter.TTS_CHARACTERS:
        return Decimal("1000")
    return Decimal("1000000")


def _active_rate_payload(
    rate: ModelUsagePriceRate,
    *,
    enabled_bindings: Mapping[tuple[str, str], object],
) -> dict[str, object] | None:
    """Normalize a historical rate and drop rows with no current owner."""

    capability = _coerce_capability(getattr(rate, "capability", None))
    variant_key = getattr(rate, "variant_key", None)
    meter_value = getattr(rate, "meter", None)
    meter_raw = meter_value.value if isinstance(meter_value, ModelUsageMeter) else meter_value
    if capability is None or not isinstance(variant_key, str) or not isinstance(meter_raw, str):
        return None
    binding = enabled_bindings.get((capability.value, variant_key))
    if binding is None:
        return None
    try:
        meter = ModelUsageMeter(meter_raw)
    except ValueError:
        return None
    if meter not in required_meters_for_capability(capability):
        return None

    quantity = _coerce_decimal(
        getattr(rate, "unit_quantity", None),
        default=_default_unit_quantity(meter),
        positive=True,
    )
    price = _coerce_decimal(getattr(rate, "unit_price", None), default=Decimal("0"))
    fx = _coerce_decimal(getattr(rate, "fx_to_cny", None), default=Decimal("1"), positive=True)
    currency = getattr(rate, "source_currency", None)
    currency = currency.strip().upper() if isinstance(currency, str) else "CNY"
    if not _CURRENCY_RE.fullmatch(currency):
        currency = "CNY"
    aliases_value = getattr(rate, "reported_model_aliases", ())
    aliases: list[str] = []
    if isinstance(aliases_value, (list, tuple)):
        for alias in aliases_value:
            if not isinstance(alias, str):
                continue
            alias = alias.strip()
            if alias and len(alias) <= 160 and alias not in aliases:
                aliases.append(alias)
    return {
        "capability": capability.value,
        "variant_key": variant_key,
        "meter": meter.value,
        "unit_quantity": str(quantity),
        "unit_price": str(price),
        "source_currency": currency,
        "fx_to_cny": str(fx),
        "reported_model_aliases": aliases,
    }


def _active_runtime_baseline(
    db: Session,
    *,
    settings: FamilyModelSettings,
) -> tuple[
    FamilyModelConfigDraftPayload,
    tuple[FamilyModelCapabilityBinding, ...],
]:
    """Read the immutable active snapshot used when merging one edit.

    A failed/provisioning search candidate is never consulted here.  The
    active revision and active price pointer are the only stable baseline, so
    a broken candidate cannot contaminate an unrelated capability save.
    """

    if settings.active_config_revision_id is None:
        # A repaired/legacy database can retain a live search pointer after
        # the config pointer was cleared. Preserve that independent search
        # identity while allowing the next model-card edit to establish the
        # rest of the runtime snapshot. An unknown/foreign pointer is simply
        # ignored and will not be copied into a draft or revision.
        search_profile_id = None
        if isinstance(settings.active_search_profile_id, str):
            profile = get_search_profile(
                db,
                family_id=settings.family_id,
                search_profile_id=settings.active_search_profile_id,
            )
            if profile is not None:
                search_profile_id = profile.id
        return (
            FamilyModelConfigDraftPayload(search_profile_id=search_profile_id),
            (),
        )
    revision = get_config_revision(
        db,
        family_id=settings.family_id,
        config_revision_id=settings.active_config_revision_id,
    )
    if revision is None or revision.status != FamilyModelConfigRevisionStatus.PUBLISHED:
        # A stale pointer should not turn the next valid card edit into an FK
        # error. Recover the newest family-owned published revision when one
        # exists; apply_validated_family_model_configuration independently
        # re-checks the pointer before writing lineage metadata.
        revision = db.scalar(
            select(FamilyModelConfigRevision).where(
                FamilyModelConfigRevision.family_id == settings.family_id,
                FamilyModelConfigRevision.status
                == FamilyModelConfigRevisionStatus.PUBLISHED,
            )
            .order_by(
                FamilyModelConfigRevision.version_number.desc(),
                FamilyModelConfigRevision.id.desc(),
            )
            .limit(1)
        )
    if revision is None:
        return FamilyModelConfigDraftPayload(), ()
    raw_binding_rows = list_capability_bindings(
        db,
        family_id=settings.family_id,
        config_revision_id=revision.id,
    )

    # Normalize bindings one by one.  Filtering before constructing the full
    # Pydantic payload means one unknown historical variant or malformed option
    # cannot invalidate every sibling card.
    normalized_binding_records: list[dict[str, object]] = []
    normalized_binding_rows: list[FamilyModelCapabilityBinding] = []
    seen_binding_identities: set[tuple[str, str]] = set()
    for row in raw_binding_rows:
        normalized = _active_binding_payload(row)
        if normalized is None:
            continue
        identity = (str(normalized["capability"]), str(normalized["variant_key"]))
        if identity in seen_binding_identities:
            # The immutable table normally enforces uniqueness.  If old data
            # predates that constraint, keep the first deterministic row.
            continue
        seen_binding_identities.add(identity)
        normalized_binding_records.append(normalized)
        normalized_binding_rows.append(row)

    enabled_binding_records = {
        (str(item["capability"]), str(item["variant_key"])): item
        for item in normalized_binding_records
        if item.get("enabled") is True and isinstance(item.get("provider_profile_id"), str)
    }

    # A profile may have been deleted or moved by a historical repair.  Turn
    # only that binding off in the baseline; preserving all unrelated rows is
    # more useful than failing the whole save with a foreign-key error.
    profile_ids = {
        str(item["provider_profile_id"])
        for item in enabled_binding_records.values()
        if isinstance(item.get("provider_profile_id"), str)
    }
    if profile_ids:
        owned_profile_ids = set(
            db.scalars(
                select(FamilyModelProviderProfile.id).where(
                    FamilyModelProviderProfile.family_id == settings.family_id,
                    FamilyModelProviderProfile.id.in_(profile_ids),
                )
            )
        )
        for item in normalized_binding_records:
            if (
                item.get("enabled") is True
                and isinstance(item.get("provider_profile_id"), str)
                and item["provider_profile_id"] not in owned_profile_ids
            ):
                item["enabled"] = False
                item["provider_profile_id"] = None

    # A binding stores an immutable provider-version snapshot, but the old
    # unified-confirmation flow could leave that pointer orphaned (or pointing
    # at a version from another profile/family after a repair).  The version
    # ID is not part of the public draft payload, so validate it against both
    # ownership columns before a sibling save can copy it into a new revision.
    # An invalid historical snapshot is represented as a disabled card; its
    # model/options remain visible for repair, while no stale foreign key can
    # enter the active runtime.
    for index, row in enumerate(normalized_binding_rows):
        record = normalized_binding_records[index]
        if (
            record.get("enabled") is not True
            or not isinstance(record.get("provider_profile_id"), str)
        ):
            continue
        version_id = getattr(row, "provider_profile_version_id", None)
        profile_version = (
            db.scalar(
                select(FamilyModelProviderProfileVersion.id).where(
                    FamilyModelProviderProfileVersion.id == version_id,
                    FamilyModelProviderProfileVersion.family_id == settings.family_id,
                    FamilyModelProviderProfileVersion.profile_id
                    == record["provider_profile_id"],
                )
            )
            if isinstance(version_id, str)
            else None
        )
        if profile_version is None:
            record["enabled"] = False
            record["provider_profile_id"] = None

    # Keep the only cross-variant invariant local to the LLM capability.  A
    # legacy snapshot with an orphan fallback is made inert before it becomes
    # the baseline for an unrelated capability save.
    llm_records = {
        str(item["variant_key"]): item
        for item in normalized_binding_records
        if item.get("capability") == ModelUsageCapability.LLM.value
    }
    primary_record = llm_records.get("primary")
    fallback_record = llm_records.get("fallback")
    if (
        fallback_record is not None
        and fallback_record.get("enabled") is True
        and (primary_record is None or primary_record.get("enabled") is not True)
    ):
        fallback_record["enabled"] = False
        fallback_record["provider_profile_id"] = None

    valid_enabled_bindings = {
        (str(item["capability"]), str(item["variant_key"])): item
        for item in normalized_binding_records
        if item.get("enabled") is True and isinstance(item.get("provider_profile_id"), str)
    }

    price_rows: list[ModelUsagePriceRate] = []
    # First honor the pointer only when it really is this family's active
    # snapshot for this revision.  If it is stale/foreign/candidate, recover
    # the newest valid active snapshot attached to the same revision.
    price: ModelUsagePriceVersion | None = None
    if isinstance(settings.active_price_version_id, str):
        price = db.scalar(
            select(ModelUsagePriceVersion).where(
                ModelUsagePriceVersion.family_id == settings.family_id,
                ModelUsagePriceVersion.id == settings.active_price_version_id,
                ModelUsagePriceVersion.config_revision_id == revision.id,
                ModelUsagePriceVersion.purpose == FamilyModelPricePurpose.ACTIVE,
                ModelUsagePriceVersion.status == "published",
                ModelUsagePriceVersion.search_profile_id.is_(None),
            )
        )
    if price is None:
        price = db.scalar(
            select(ModelUsagePriceVersion).where(
                ModelUsagePriceVersion.family_id == settings.family_id,
                ModelUsagePriceVersion.config_revision_id == revision.id,
                ModelUsagePriceVersion.purpose == FamilyModelPricePurpose.ACTIVE,
                ModelUsagePriceVersion.status == "published",
                ModelUsagePriceVersion.search_profile_id.is_(None),
            )
            .order_by(
                ModelUsagePriceVersion.version_number.desc(),
                ModelUsagePriceVersion.effective_from.desc(),
                ModelUsagePriceVersion.id.desc(),
            )
            .limit(1)
        )
    if price is not None:
        price_rows = list(
            db.scalars(
                select(ModelUsagePriceRate)
                .where(ModelUsagePriceRate.price_version_id == price.id)
                .order_by(
                    ModelUsagePriceRate.capability,
                    ModelUsagePriceRate.variant_key,
                    ModelUsagePriceRate.meter,
                    ModelUsagePriceRate.id,
                )
            )
        )

    normalized_rate_records: list[dict[str, object]] = []
    seen_rate_identities: set[tuple[str, str, str]] = set()
    for row in price_rows:
        normalized = _active_rate_payload(
            row,
            enabled_bindings=valid_enabled_bindings,
        )
        if normalized is None:
            continue
        identity = (
            str(normalized["capability"]),
            str(normalized["variant_key"]),
            str(normalized["meter"]),
        )
        if identity in seen_rate_identities:
            continue
        seen_rate_identities.add(identity)
        normalized_rate_records.append(normalized)

    # Re-run the current request schema on each normalized row.  This catches
    # historical numeric precision/length values that are representable in a
    # legacy database column but no longer fit the public contract.
    safe_rate_records: list[dict[str, object]] = []
    for record in normalized_rate_records:
        try:
            safe_rate = FamilyModelPriceRateRequest.model_validate(record)
        except (TypeError, ValueError, ValidationError):
            continue
        safe_rate_records.append(safe_rate.model_dump(mode="json", exclude_none=False))

    search_profile_id: str | None = None
    # Prefer the revision's identity, then the denormalized settings pointer;
    # both are family-scoped and existence-checked.
    for candidate in (
        revision.search_profile_id,
        settings.active_search_profile_id,
    ):
        if not isinstance(candidate, str):
            continue
        if get_search_profile(
            db,
            family_id=settings.family_id,
            search_profile_id=candidate,
        ) is not None:
            search_profile_id = candidate
            break

    payload = FamilyModelConfigDraftPayload.model_validate(
        {
            "base_config_revision_id": revision.id,
            "search_profile_id": search_profile_id,
            "bindings": normalized_binding_records,
            "price_rates": safe_rate_records,
            "change_note": (
                revision.change_note[:255]
                if isinstance(revision.change_note, str)
                else ""
            ),
        }
    )
    return payload, tuple(normalized_binding_rows)


def _baseline_validated_binding(
    binding: FamilyModelCapabilityBinding,
    *,
    normalized: object | None = None,
) -> ValidatedCapabilityBinding:
    normalized_record: Mapping[str, object] | None = normalized
    if normalized_record is not None and not isinstance(normalized_record, Mapping):
        model_record = _model_record(normalized_record)
        normalized_record = model_record if isinstance(model_record, Mapping) else None
    normalized = normalized_record or _active_binding_payload(binding)
    capability = _coerce_capability(
        normalized.get("capability") if normalized is not None else binding.capability
    )
    if capability is None:
        # This should only be reachable for a caller passing a hand-built
        # object outside _active_runtime_baseline.  Keep the failure local and
        # explicit rather than emitting an invalid enum into a runtime row.
        raise ValueError("unknown active capability")
    variant_key = (
        normalized.get("variant_key")
        if normalized is not None
        else getattr(binding, "variant_key", "")
    )
    if not isinstance(variant_key, str):
        variant_key = ""
    enabled = (
        normalized.get("enabled")
        if normalized is not None
        else getattr(binding, "enabled", False)
    )
    enabled = enabled is True
    provider_profile_id = (
        normalized.get("provider_profile_id")
        if normalized is not None
        else getattr(binding, "provider_profile_id", None)
    )
    provider_profile_id = provider_profile_id if isinstance(provider_profile_id, str) else None
    if not enabled:
        provider_profile_id = None
    provider_profile_version_id = (
        getattr(binding, "provider_profile_version_id", None) if enabled else None
    )
    requested_model = (
        normalized.get("requested_model")
        if normalized is not None
        else getattr(binding, "requested_model", "")
    )
    requested_model = requested_model if isinstance(requested_model, str) else ""
    billing_scheme_key = (
        normalized.get("billing_scheme_key")
        if normalized is not None
        else getattr(binding, "billing_scheme_key", "")
    )
    if not isinstance(billing_scheme_key, str):
        billing_scheme_key = _DEFAULT_BILLING_SCHEMES[capability]
    options = {
        key: value
        for key, value in (normalized or {}).items()
        if key in _ACTIVE_BINDING_OPTION_FIELDS.get(capability, frozenset())
    }
    identity_checksum = _binding_identity_checksum(
        capability=capability,
        variant_key=variant_key,
        provider_profile_id=provider_profile_id,
        provider_profile_version_id=provider_profile_version_id,
        requested_model=requested_model,
        billing_scheme_key=billing_scheme_key,
        options=options,
    )
    return ValidatedCapabilityBinding(
        capability=capability,
        variant_key=variant_key,
        enabled=enabled,
        provider_profile_id=provider_profile_id,
        provider_profile_version_id=provider_profile_version_id,
        requested_model=requested_model,
        billing_scheme_key=billing_scheme_key,
        options=options,
        identity_checksum=identity_checksum,
        # Existing active rows are already immutable/validated.  Their
        # provider objects are intentionally not re-read: a disabled sibling
        # must not block an unrelated capability update.
        billable_meters=required_meters_for_capability(capability),
    )


def _append_unique_issue(
    issues: list[DraftValidationIssue],
    issue: DraftValidationIssue,
) -> None:
    if issue not in issues:
        issues.append(issue)


def _identity_sort_key(identity: tuple[str, str]) -> tuple[str, int, str]:
    """Keep dependent LLM variants deterministic: primary precedes fallback."""

    capability, variant = identity
    if capability == ModelUsageCapability.LLM.value:
        return capability, 0 if variant == "primary" else 1, variant
    return capability, 0, variant


def _scoped_validation_issues(
    issues: tuple[DraftValidationIssue, ...] | list[DraftValidationIssue],
    *,
    binding_index: int | None,
    rate_indices: Sequence[int | None],
) -> tuple[DraftValidationIssue, ...]:
    """Restore full-payload field paths after validating a one-card payload."""

    restored: list[DraftValidationIssue] = []
    for issue in issues:
        field = issue.field
        if binding_index is not None and field == "bindings":
            field = f"bindings.{binding_index}"
        elif binding_index is not None and field and field.startswith("bindings."):
            suffix = field.removeprefix("bindings.")
            head, separator, tail = suffix.partition(".")
            if head.isdigit():
                field = f"bindings.{binding_index}{separator}{tail}" if separator else f"bindings.{binding_index}"
        elif field and field.startswith("price_rates."):
            suffix = field.removeprefix("price_rates.")
            head, separator, tail = suffix.partition(".")
            if head.isdigit() and int(head) < len(rate_indices):
                global_index = rate_indices[int(head)]
                if global_index is not None:
                    field = f"price_rates.{global_index}{separator}{tail}" if separator else f"price_rates.{global_index}"
        restored_issue = DraftValidationIssue(issue.code, field)
        if restored_issue not in restored:
            restored.append(restored_issue)
    return tuple(restored)


def _rate_identity(value: object) -> tuple[str, str, str] | None:
    capability = getattr(value, "capability", None)
    capability_value = capability.value if isinstance(capability, ModelUsageCapability) else capability
    variant_key = getattr(value, "variant_key", None)
    meter = getattr(value, "meter", None)
    meter_value = meter.value if isinstance(meter, ModelUsageMeter) else meter
    if (
        isinstance(capability_value, str)
        and isinstance(variant_key, str)
        and isinstance(meter_value, str)
    ):
        return capability_value, variant_key, meter_value
    return None


def _remap_indexed_issue_fields(
    issues: Sequence[DraftValidationIssue],
    *,
    source_payload: FamilyModelConfigDraftPayload | None,
    stored_payload: FamilyModelConfigDraftPayload,
) -> tuple[DraftValidationIssue, ...]:
    """Point indexed errors at the normalized payload returned to the client."""

    if source_payload is None:
        return tuple(issues)
    source_binding_ids = {
        identity: index
        for index, binding in enumerate(source_payload.bindings)
        if (identity := _binding_identity(binding)) is not None
    }
    stored_binding_ids = {
        identity: index
        for index, binding in enumerate(stored_payload.bindings)
        if (identity := _binding_identity(binding)) is not None
    }
    source_rate_ids = {
        identity: index
        for index, rate in enumerate(source_payload.price_rates)
        if (identity := _rate_identity(rate)) is not None
    }
    stored_rate_ids = {
        identity: index
        for index, rate in enumerate(stored_payload.price_rates)
        if (identity := _rate_identity(rate)) is not None
    }
    remapped: list[DraftValidationIssue] = []
    for issue in issues:
        field = issue.field
        if field:
            match = re.match(r"^bindings\.(\d+)(.*)$", field)
            if match:
                source_index = int(match.group(1))
                if source_index < len(source_payload.bindings):
                    identity = _binding_identity(source_payload.bindings[source_index])
                    target_index = stored_binding_ids.get(identity) if identity is not None else None
                    if target_index is not None:
                        field = f"bindings.{target_index}{match.group(2)}"
            else:
                match = re.match(r"^price_rates\.(\d+)(.*)$", field)
                if match:
                    source_index = int(match.group(1))
                    if source_index < len(source_payload.price_rates):
                        identity = _rate_identity(source_payload.price_rates[source_index])
                        target_index = stored_rate_ids.get(identity) if identity is not None else None
                        if target_index is not None:
                            field = f"price_rates.{target_index}{match.group(2)}"
        remapped_issue = DraftValidationIssue(issue.code, field)
        if remapped_issue not in remapped:
            remapped.append(remapped_issue)
    return tuple(remapped)


def _carry_forward_draft_issues(
    raw_errors: object,
    *,
    existing_payload: FamilyModelConfigDraftPayload | None,
    incoming_identities: set[tuple[str, str]],
) -> tuple[DraftValidationIssue, ...]:
    """Keep unresolved sibling errors across a sparse save.

    A draft can contain a failed card that is intentionally being repaired in
    a later request.  Errors for an omitted identity still describe that
    card; errors for an identity present in the new request are re-evaluated
    and therefore must not be copied blindly.
    """

    if not isinstance(raw_errors, Sequence) or isinstance(
        raw_errors, (str, bytes, bytearray)
    ):
        return ()
    existing_bindings = (
        existing_payload.bindings if existing_payload is not None else ()
    )
    existing_rates = existing_payload.price_rates if existing_payload is not None else ()
    carried: list[DraftValidationIssue] = []
    for raw in raw_errors:
        if not isinstance(raw, Mapping):
            continue
        code = raw.get("code")
        if not isinstance(code, str) or not code:
            continue
        field = raw.get("field")
        field = field if isinstance(field, str) and field else None
        identity: tuple[str, str] | None = None
        if field is not None:
            match = re.match(r"^bindings\.(\d+)(?:\.|$)", field)
            if match:
                index = int(match.group(1))
                if index < len(existing_bindings):
                    identity = _binding_identity(existing_bindings[index])
            else:
                match = re.match(r"^price_rates\.(\d+)(?:\.|$)", field)
                if match:
                    index = int(match.group(1))
                    if index < len(existing_rates):
                        rate = existing_rates[index]
                        identity = (rate.capability, rate.variant_key)
        if identity is not None and identity in incoming_identities:
            continue
        issue = DraftValidationIssue(code[:160], field[:255] if field else None)
        if issue not in carried:
            carried.append(issue)
    return tuple(carried)


def _payload_identity_maps(
    payload: FamilyModelConfigDraftPayload,
) -> tuple[
    dict[tuple[str, str], object],
    dict[tuple[str, str], list[object]],
]:
    bindings: dict[tuple[str, str], object] = {}
    rates: dict[tuple[str, str], list[object]] = {}
    for binding in payload.bindings:
        identity = _binding_identity(binding)
        if identity is not None:
            bindings[identity] = binding
    for rate in payload.price_rates:
        rates.setdefault((rate.capability, rate.variant_key), []).append(rate)
    return bindings, rates


def _merge_rate_groups(
    baseline: Sequence[FamilyModelPriceRateRequest] | None,
    incoming: Sequence[FamilyModelPriceRateRequest] | None,
) -> list[FamilyModelPriceRateRequest]:
    """Merge prices by meter while preserving omitted baseline values.

    A capability card owns several meters (LLM, for example, owns three).
    Sparse saves are valid because the browser may debounce one field at a
    time and older clients may send only the edited row.  Replacing the whole
    group in that case silently turns omitted meters into zero-priced rows.
    Explicitly supplied rows still win, including an explicit ``0`` price.
    """

    by_meter: dict[str, FamilyModelPriceRateRequest] = {}
    for rate in baseline or ():
        by_meter[rate.meter.value] = rate
    for rate in incoming or ():
        by_meter[rate.meter.value] = rate
    return [by_meter[key] for key in sorted(by_meter)]


def _merged_rate_source_indices(
    rates: Sequence[FamilyModelPriceRateRequest],
    *,
    incoming_rates: Sequence[FamilyModelPriceRateRequest],
    incoming_indices: Sequence[int],
) -> tuple[int | None, ...]:
    """Map merged local rate positions back to request positions."""

    incoming_by_identity = {
        identity: index
        for identity, index in zip(
            (_rate_identity(rate) for rate in incoming_rates),
            incoming_indices,
        )
        if identity is not None
    }
    return tuple(
        incoming_by_identity.get(identity)
        for rate in rates
        for identity in (_rate_identity(rate),)
    )


def _merge_payload_for_storage(
    payload: FamilyModelConfigDraftPayload,
    *,
    baseline_payload: FamilyModelConfigDraftPayload,
    existing_payload: FamilyModelConfigDraftPayload | None = None,
) -> FamilyModelConfigDraftPayload:
    """Keep a full, repairable draft while applying cards independently.

    The browser normally sends every card, but old clients and retries can
    send a sparse payload.  Merging omitted identities from the active
    snapshot prevents a partial edit from making already active siblings
    disappear on the next reload.  Invalid incoming cards deliberately win so
    the Owner can see and repair them; only their runtime activation is held
    back.
    """

    baseline_bindings, baseline_rates = _payload_identity_maps(baseline_payload)
    existing_bindings, existing_rates = _payload_identity_maps(existing_payload or FamilyModelConfigDraftPayload())
    incoming_bindings, incoming_rates = _payload_identity_maps(payload)
    # The active immutable snapshot is the starting point, an existing draft
    # is the repairable middle layer, and the current request wins last.  This
    # preserves a failed sibling when an older/sparse client later submits only
    # one other capability.
    merged_bindings = {**baseline_bindings, **existing_bindings, **incoming_bindings}
    existing_or_baseline_rates = {
        identity: _merge_rate_groups(
            baseline_rates.get(identity),
            existing_rates.get(identity),
        )
        for identity in set(baseline_rates) | set(existing_rates)
    }
    merged_rates = {
        identity: _merge_rate_groups(
            existing_or_baseline_rates.get(identity),
            incoming_rates.get(identity),
        )
        for identity in set(existing_or_baseline_rates) | set(incoming_rates)
    }

    # Disabled cards never own prices.  Drop stale rows from both old and new
    # payloads, while retaining orphan incoming rows for an enabled/missing
    # card so the validation response remains actionable.
    for identity, binding in merged_bindings.items():
        if not getattr(binding, "enabled", False):
            merged_rates.pop(identity, None)
    for identity in tuple(merged_rates):
        if identity in merged_bindings:
            continue
        if identity not in incoming_rates and identity not in existing_rates:
            merged_rates.pop(identity, None)

    # Once a search profile exists, its Embedding identity is immutable in the
    # normal card-save flow.  A stale/failed candidate in an old draft must not
    # be echoed as if it were the active identity (the UI would then lock the
    # card and make the dedicated replacement flow unreachable).  Prices for a
    # matching identity remain independently editable.
    embedding_identity = (ModelUsageCapability.EMBEDDING.value, "search")
    if baseline_payload.search_profile_id is not None:
        baseline_embedding = baseline_bindings.get(embedding_identity)
        stored_embedding = merged_bindings.get(embedding_identity)
        if baseline_embedding is None:
            merged_bindings.pop(embedding_identity, None)
            merged_rates.pop(embedding_identity, None)
        else:
            def _embedding_identity_matches(left: object, right: object) -> bool:
                fields = (
                    "enabled",
                    "provider_profile_id",
                    "requested_model",
                    "billing_scheme_key",
                    "dimensions",
                )
                return all(getattr(left, field, None) == getattr(right, field, None) for field in fields)

            if stored_embedding is None or not _embedding_identity_matches(
                stored_embedding,
                baseline_embedding,
            ):
                merged_bindings[embedding_identity] = baseline_embedding
                merged_rates[embedding_identity] = list(baseline_rates.get(embedding_identity, ()))

    base_config_revision_id = (
        baseline_payload.base_config_revision_id
        if baseline_payload.base_config_revision_id is not None
        else (
            existing_payload.base_config_revision_id
            if existing_payload is not None and existing_payload.base_config_revision_id is not None
            else payload.base_config_revision_id
        )
    )
    search_profile_id = (
        baseline_payload.search_profile_id
        if baseline_payload.search_profile_id is not None
        else (
            existing_payload.search_profile_id
            if existing_payload is not None and existing_payload.search_profile_id is not None
            else payload.search_profile_id
        )
    )
    price_draft = (
        payload.price_draft
        if payload.price_draft is not None
        else (
            existing_payload.price_draft
            if existing_payload is not None and existing_payload.price_draft is not None
            else baseline_payload.price_draft
        )
    )
    change_note = payload.change_note or (
        existing_payload.change_note
        if existing_payload is not None and existing_payload.change_note
        else baseline_payload.change_note
    )
    return payload.model_copy(
        update={
            "base_config_revision_id": base_config_revision_id,
            "search_profile_id": search_profile_id,
            "bindings": [
                merged_bindings[identity]
                for identity in sorted(merged_bindings, key=_identity_sort_key)
            ],
            "price_rates": [
                rate
                for identity in sorted(merged_rates, key=_identity_sort_key)
                for rate in merged_rates[identity]
            ],
            "price_draft": price_draft,
            "change_note": change_note,
        }
    )


def restore_active_embedding_after_failed_search_replacement(
    db: Session,
    *,
    family_id: str,
    failed_search_profile_id: str,
    settings: FamilyModelSettings | None = None,
) -> bool:
    """Remove a failed search candidate from the persisted configuration draft."""

    settings = settings or lock_family_model_settings(db, family_id=family_id)
    if (
        settings.family_id != family_id
        or settings.active_search_profile_id is None
        or settings.active_search_profile_id == failed_search_profile_id
    ):
        return False

    draft = get_config_draft(db, family_id=family_id, for_update=True)
    if draft is None:
        return False

    existing_payload, payload_issues = _safe_payload_from_raw(draft.payload_json)
    baseline_payload, _ = _active_runtime_baseline(db, settings=settings)
    embedding_identity = (ModelUsageCapability.EMBEDDING.value, "search")
    baseline_bindings, _ = _payload_identity_maps(baseline_payload)
    if (
        baseline_payload.search_profile_id != settings.active_search_profile_id
        or embedding_identity not in baseline_bindings
    ):
        return False

    restored_payload = _merge_payload_for_storage(
        FamilyModelConfigDraftPayload(),
        baseline_payload=baseline_payload,
        existing_payload=existing_payload,
    )
    restored_errors = list(
        _carry_forward_draft_issues(
            [
                *(draft.validation_errors_json or []),
                *(issue.record() for issue in payload_issues),
            ],
            existing_payload=existing_payload,
            incoming_identities={embedding_identity},
        )
    )
    restored_errors = [
        issue
        for issue in restored_errors
        if issue.code
        not in {
            "family_search_profile_locked",
            "family_search_profile_not_found",
        }
    ]
    serialized = remove_write_only_secret_commands(
        restored_payload.model_dump(mode="json", exclude_none=True)
    )
    validation_status = "invalid" if restored_errors else "valid"
    serialized_errors = [issue.record() for issue in restored_errors]
    if (
        draft.payload_json == serialized
        and draft.base_config_revision_id == restored_payload.base_config_revision_id
        and draft.validation_status == validation_status
        and draft.validation_errors_json == serialized_errors
    ):
        return False

    draft.base_config_revision_id = restored_payload.base_config_revision_id
    draft.payload_json = serialized
    draft.draft_version_number += 1
    draft.validation_status = validation_status
    draft.validation_errors_json = serialized_errors
    draft.updated_at = utcnow()
    return True


def abandon_initial_embedding_candidate(
    db: Session,
    *,
    family_id: str,
    cancelled_search_profile_id: str,
    active_config_revision_id: str,
    actor_user_id: str,
) -> bool:
    """Clear only the failed first Embedding card from the repairable draft."""

    draft = get_config_draft(db, family_id=family_id, for_update=True)
    if draft is None:
        return False
    payload, payload_issues = _safe_payload_from_raw(draft.payload_json)
    if payload.search_profile_id != cancelled_search_profile_id:
        return False

    bindings, rates = _payload_identity_maps(payload)
    embedding_identity = (ModelUsageCapability.EMBEDDING.value, "search")
    disabled_embedding = _parse_single_binding_record(
        _default_binding_record(ModelUsageCapability.EMBEDDING, "search")
    )
    assert disabled_embedding is not None
    bindings[embedding_identity] = disabled_embedding
    rates.pop(embedding_identity, None)
    restored = payload.model_copy(
        update={
            "base_config_revision_id": active_config_revision_id,
            "search_profile_id": None,
            "bindings": [
                bindings[identity]
                for identity in sorted(bindings, key=_identity_sort_key)
            ],
            "price_rates": [
                rate
                for identity in sorted(rates, key=_identity_sort_key)
                for rate in rates[identity]
            ],
        }
    )
    retained_errors = [
        issue
        for issue in _carry_forward_draft_issues(
            [
                *(draft.validation_errors_json or []),
                *(issue.record() for issue in payload_issues),
            ],
            existing_payload=payload,
            incoming_identities={embedding_identity},
        )
        if issue.code not in {
            "family_search_initial_confirmation_required",
            "family_search_profile_locked",
            "family_search_profile_not_found",
        }
    ]
    draft.base_config_revision_id = active_config_revision_id
    draft.payload_json = remove_write_only_secret_commands(
        restored.model_dump(mode="json", exclude_none=True)
    )
    draft.draft_version_number += 1
    draft.validation_status = "invalid" if retained_errors else "valid"
    draft.validation_errors_json = [issue.record() for issue in retained_errors]
    draft.updated_at = utcnow()
    draft.updated_by = actor_user_id
    return True


def _only_initial_embedding_candidate(
    payload: FamilyModelConfigDraftPayload,
    *,
    baseline_payload: FamilyModelConfigDraftPayload,
) -> bool:
    """Whether the request is solely the first ready Embedding card."""

    incoming_bindings, incoming_rates = _payload_identity_maps(payload)
    active_bindings, _ = _payload_identity_maps(baseline_payload)
    meaningful: set[tuple[str, str]] = set()
    for identity, binding in incoming_bindings.items():
        if getattr(binding, "enabled", False) or identity in active_bindings:
            meaningful.add(identity)
    meaningful.update(incoming_rates)
    return meaningful == {(ModelUsageCapability.EMBEDDING.value, "search")}


def _independent_validation(
    db: Session,
    *,
    family_id: str,
    settings: FamilyModelSettings,
    payload: FamilyModelConfigDraftPayload,
    baseline_payload: FamilyModelConfigDraftPayload,
    baseline_binding_rows: tuple[FamilyModelCapabilityBinding, ...],
    network_policy: ProviderNetworkPolicy,
    draft_version_number: int,
    confirm_initial_search_index: bool,
) -> tuple[
    DraftValidationResult | None,
    tuple[DraftValidationIssue, ...],
    frozenset[tuple[str, str]],
]:
    """Validate and merge incoming binding identities independently.

    The returned validation is a complete runtime snapshot assembled from the
    active baseline plus only the identities that validated successfully.  The
    original draft remains untouched by this helper, allowing failed edits to
    be shown and repaired without blocking siblings.
    """

    incoming_bindings = {
        identity: binding
        for binding in payload.bindings
        if (identity := _binding_identity(binding)) is not None
    }
    incoming_binding_indices = {
        identity: index
        for index, binding in enumerate(payload.bindings)
        if (identity := _binding_identity(binding)) is not None
    }
    baseline_bindings = {
        identity: binding
        for binding in baseline_payload.bindings
        if (identity := _binding_identity(binding)) is not None
    }
    incoming_rates: dict[tuple[str, str], list[FamilyModelPriceRateRequest]] = {}
    for rate in payload.price_rates:
        incoming_rates.setdefault((rate.capability, rate.variant_key), []).append(rate)
    incoming_rate_indices: dict[tuple[str, str], list[int]] = {}
    for index, rate in enumerate(payload.price_rates):
        incoming_rate_indices.setdefault((rate.capability, rate.variant_key), []).append(index)
    baseline_rates: dict[tuple[str, str], list[FamilyModelPriceRateRequest]] = {}
    for rate in baseline_payload.price_rates:
        baseline_rates.setdefault((rate.capability, rate.variant_key), []).append(rate)

    target_identities = set(incoming_bindings) | set(incoming_rates)
    if not target_identities:
        return None, (), frozenset()

    baseline_binding_rows_by_identity = {}
    for row in baseline_binding_rows:
        capability = _coerce_capability(getattr(row, "capability", None))
        variant_key = getattr(row, "variant_key", None)
        if capability is None or not isinstance(variant_key, str):
            continue
        identity = (capability.value, variant_key)
        if identity not in baseline_binding_rows_by_identity:
            baseline_binding_rows_by_identity[identity] = row
    baseline_validated_bindings = {
        identity: _baseline_validated_binding(
            row,
            normalized=(baseline_bindings.get(identity) if identity in baseline_bindings else None),
        )
        for identity, row in baseline_binding_rows_by_identity.items()
        if identity in baseline_bindings
    }
    effective_binding_objects = dict(baseline_bindings)
    # Price rows belonging to disabled/orphaned historical bindings are
    # inert.  Do not carry them into a new active snapshot.
    effective_rate_objects = {
        identity: list(values)
        for identity, values in baseline_rates.items()
        if baseline_bindings.get(identity) is not None
        and baseline_bindings[identity].enabled
    }
    effective_bindings = dict(baseline_validated_bindings)
    effective_rates: dict[tuple[str, str], list[ValidatedFamilyPriceRate]] = {}
    # Complete a trusted baseline using the same zero-price semantics as a
    # newly enabled card.  This also repairs snapshots whose old price
    # pointer was incomplete without revalidating their Provider.
    for identity, binding in baseline_validated_bindings.items():
        if not binding.enabled:
            continue
        baseline_rate_payload = baseline_payload.model_copy(
            update={
                "bindings": [baseline_bindings[identity]],
                "price_rates": list(baseline_rates.get(identity, ())),
            }
        )
        rates, _ = validate_family_model_capability_rates(
            baseline_rate_payload,
            binding,
        )
        effective_rates[identity] = list(rates)
    baseline_effective_rates = {
        identity: list(rates) for identity, rates in effective_rates.items()
    }
    issues: list[DraftValidationIssue] = []
    meaningful_successful: set[tuple[str, str]] = set()
    configured_search_profile = _configured_search_profile(db, settings=settings)

    for identity in sorted(target_identities, key=_identity_sort_key):
        capability, variant_key = identity
        incoming_binding = incoming_bindings.get(identity)
        baseline_binding_object = baseline_bindings.get(identity)
        baseline_binding = baseline_validated_bindings.get(identity)
        global_binding_index = incoming_binding_indices.get(identity)
        global_rate_indices = tuple(incoming_rate_indices.get(identity, ()))

        # A sparse request may contain only prices for an already active card.
        # The immutable active binding is sufficient context; never ask the
        # Provider to revalidate it just because a sibling/card was omitted.
        if incoming_binding is None and baseline_binding_object is not None and baseline_binding is not None:
            candidate_rates = _merge_rate_groups(
                baseline_rates.get(identity),
                incoming_rates.get(identity),
            )
            candidate_rate_indices = _merged_rate_source_indices(
                candidate_rates,
                incoming_rates=incoming_rates.get(identity, ()),
                incoming_indices=incoming_rate_indices.get(identity, ()),
            )
            scoped_payload = baseline_payload.model_copy(
                update={
                    "bindings": [baseline_binding_object],
                    "price_rates": list(candidate_rates),
                }
            )
            rates, rate_errors = validate_family_model_capability_rates(
                scoped_payload,
                baseline_binding,
            )
            local_errors = list(_scoped_validation_issues(
                rate_errors,
                binding_index=global_binding_index,
                rate_indices=candidate_rate_indices,
            ))
            if not local_errors:
                effective_rates[identity] = list(rates)
                effective_rate_objects[identity] = list(candidate_rates)
                meaningful_successful.add(identity)
            for issue in local_errors:
                _append_unique_issue(issues, issue)
            continue

        if incoming_binding is None:
            # Price rows without a binding have no runtime owner.  Keep the
            # raw row in the saved draft so the Owner can repair it, but make
            # the failure addressable instead of silently dropping it.
            for index in global_rate_indices:
                _append_unique_issue(
                    issues,
                    DraftValidationIssue("family_model_price_incomplete", f"price_rates.{index}"),
                )
            continue

        # Disabling a card is a local, safe operation.  It must not require a
        # live Provider and any historical price rows become inert.
        candidate_rates = (
            _merge_rate_groups(
                baseline_rates.get(identity),
                incoming_rates.get(identity),
            )
            if incoming_binding.enabled
            else []
        )
        candidate_rate_indices = _merged_rate_source_indices(
            candidate_rates,
            incoming_rates=incoming_rates.get(identity, ()),
            incoming_indices=incoming_rate_indices.get(identity, ()),
        )
        scoped_payload = payload.model_copy(
            update={
                "base_config_revision_id": baseline_payload.base_config_revision_id,
                "search_profile_id": (
                    payload.search_profile_id
                    if payload.search_profile_id is not None
                    else baseline_payload.search_profile_id
                ),
                "bindings": [incoming_binding],
                "price_rates": list(candidate_rates),
            }
        )
        binding_is_unchanged = (
            baseline_binding_object is not None
            and baseline_binding is not None
            and _binding_records_equal(incoming_binding, baseline_binding_object)
        )
        if binding_is_unchanged and baseline_binding is not None:
            # Existing immutable bindings are trusted.  This prevents a
            # temporary Provider outage from blocking a price-only edit or an
            # unrelated sibling save.
            rates, rate_errors = validate_family_model_capability_rates(
                scoped_payload,
                baseline_binding,
            )
            result = DraftValidationResult(
                draft_version_number=draft_version_number,
                payload=scoped_payload,
                search_profile_id=baseline_payload.search_profile_id,
                bindings=(baseline_binding,),
                price_rates=rates,
                errors=tuple(rate_errors),
                config_checksum=None,
                price_checksum=None,
            )
        else:
            result = validate_family_model_capability(
                db,
                family_id=family_id,
                settings=settings,
                payload=scoped_payload,
                capability=capability,
                network_policy=network_policy,
                draft_version_number=draft_version_number,
                validate_fallback_graph=False,
                ignore_disabled_rates=True,
            )
        local_errors = list(_scoped_validation_issues(
            result.errors,
            binding_index=global_binding_index,
            rate_indices=candidate_rate_indices,
        ))
        if capability == ModelUsageCapability.LLM.value and variant_key == "fallback":
            # An invalid primary edit is not an instruction to remove the
            # currently active primary.  The effective map still contains the
            # immutable baseline in that case, so a valid fallback edit can
            # be applied alongside it.  Only an explicitly valid disabled
            # primary (or a missing primary) should block an enabled fallback.
            primary = effective_bindings.get((capability, "primary"))
            if incoming_binding.enabled and (
                primary is None or not primary.enabled
            ):
                _append_unique_issue(
                    local_errors,
                    DraftValidationIssue("family_model_llm_fallback_requires_primary", "bindings"),
                )
        if (
            capability == ModelUsageCapability.EMBEDDING.value
            and incoming_binding.enabled
            and (
                baseline_binding_object is None
                or not baseline_binding_object.enabled
            )
            and _ready_initial_embedding(scoped_payload) is not None
            and configured_search_profile is None
            and not confirm_initial_search_index
        ):
            _append_unique_issue(
                local_errors,
                DraftValidationIssue("family_search_initial_confirmation_required", "bindings"),
            )
        for issue in local_errors:
            _append_unique_issue(issues, issue)
        if local_errors or not result.bindings:
            continue
        validated_binding = result.bindings[0]
        if (
            incoming_binding.enabled
            or identity in baseline_bindings
            or identity in incoming_rates
        ):
            meaningful_successful.add(identity)
        effective_bindings[identity] = validated_binding
        effective_binding_objects[identity] = incoming_binding
        effective_rates[identity] = list(result.price_rates)
        if incoming_binding.enabled:
            effective_rate_objects[identity] = list(candidate_rates)
        else:
            effective_rate_objects.pop(identity, None)

    primary_identity = (ModelUsageCapability.LLM.value, "primary")
    fallback_identity = (ModelUsageCapability.LLM.value, "fallback")
    effective_primary = effective_bindings.get(primary_identity)
    effective_fallback = effective_bindings.get(fallback_identity)
    if (
        effective_fallback is not None
        and effective_fallback.enabled
        and (effective_primary is None or not effective_primary.enabled)
        and primary_identity in meaningful_successful
    ):
        # Reject only the primary edit that would orphan a live fallback.  Any
        # other independently valid capability from the same request can still
        # apply.  Restore the immutable primary baseline before assembling that
        # runtime snapshot.
        primary_index = incoming_binding_indices.get(primary_identity)
        _append_unique_issue(
            issues,
            DraftValidationIssue(
                "family_model_llm_fallback_requires_primary",
                f"bindings.{primary_index}" if primary_index is not None else "bindings",
            ),
        )
        baseline_primary = baseline_validated_bindings.get(primary_identity)
        baseline_primary_object = baseline_bindings.get(primary_identity)
        if baseline_primary is None or baseline_primary_object is None:
            effective_bindings.pop(primary_identity, None)
            effective_binding_objects.pop(primary_identity, None)
            effective_rates.pop(primary_identity, None)
            effective_rate_objects.pop(primary_identity, None)
        else:
            effective_bindings[primary_identity] = baseline_primary
            effective_binding_objects[primary_identity] = baseline_primary_object
            effective_rates[primary_identity] = list(
                baseline_effective_rates.get(primary_identity, ())
            )
            if baseline_primary.enabled:
                effective_rate_objects[primary_identity] = list(
                    baseline_rates.get(primary_identity, ())
                )
            else:
                effective_rate_objects.pop(primary_identity, None)
        meaningful_successful.discard(primary_identity)

    if not meaningful_successful:
        if len(target_identities) == 1:
            if any(issue.code == "family_model_provider_not_found" for issue in issues):
                raise FamilyModelProviderProfileNotFound()
            if any(issue.code == "family_search_profile_locked" for issue in issues):
                raise FamilyModelDraftInvalid("family_search_profile_locked")
        return None, tuple(issues), frozenset()

    # A complete payload is not required from API callers.  Retain the active
    # search identity unless this is the first configuration; unrelated cards
    # therefore cannot accidentally clear it with a null/omitted field.
    retained_base_revision_id = (
        baseline_payload.base_config_revision_id
        if baseline_payload.base_config_revision_id is not None
        else payload.base_config_revision_id
    )
    # Search identity belongs to the Embedding card.  A non-search edit must
    # not hand an unvalidated/stale search_profile_id to the runtime apply
    # path (which would turn an otherwise valid LLM save into a 404).
    embedding_identity = (ModelUsageCapability.EMBEDDING.value, "search")
    if baseline_payload.search_profile_id is not None:
        retained_search_profile_id = baseline_payload.search_profile_id
    elif embedding_identity in meaningful_successful:
        retained_search_profile_id = payload.search_profile_id
    else:
        retained_search_profile_id = None

    merged_payload = payload.model_copy(
        update={
            "base_config_revision_id": retained_base_revision_id,
            "search_profile_id": retained_search_profile_id,
            "bindings": [
                effective_binding_objects[identity]
                for identity in sorted(effective_binding_objects, key=_identity_sort_key)
            ],
            "price_rates": [
                rate
                for identity in sorted(effective_rate_objects, key=_identity_sort_key)
                for rate in effective_rate_objects[identity]
            ],
        }
    )
    merged_bindings = tuple(
        effective_bindings[identity]
        for identity in sorted(effective_bindings, key=_identity_sort_key)
    )
    merged_rates = tuple(
        rate
        for identity in sorted(effective_rates, key=_identity_sort_key)
        for rate in effective_rates[identity]
    )
    search_profile_id = retained_search_profile_id
    return (
        DraftValidationResult(
            draft_version_number=draft_version_number,
            payload=merged_payload,
            search_profile_id=search_profile_id,
            bindings=merged_bindings,
            price_rates=merged_rates,
            errors=(),
            config_checksum=config_checksum(
                bindings=merged_bindings,
                profile_version_ids=tuple(
                    binding.provider_profile_version_id
                    for binding in merged_bindings
                    if binding.enabled and binding.provider_profile_version_id is not None
                ),
                search_profile_id=search_profile_id,
            ),
            price_checksum=price_checksum(merged_rates),
        ),
        tuple(issues),
        frozenset(meaningful_successful),
    )


def save_config_draft(
    db: Session,
    command: SaveConfigDraftCommand,
    *,
    cipher: FamilyModelCredentialCipher,
    network_policy: ProviderNetworkPolicy | None = None,
) -> ConfigDraftSnapshot:
    """Persist a non-secret draft under settings -> draft lock ordering.

    Idempotency is claimed before the optimistic version check.  This lets a
    response-lost retry replay its original safe snapshot even after another
    owner has subsequently edited the draft.
    """

    payload = FamilyModelConfigDraftPayload.model_validate(command.payload)
    serialized = remove_write_only_secret_commands(
        payload.model_dump(mode="json", exclude_none=True)
    )
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="save_config_draft",
        public_fields={
            "family_id": command.family_id,
            "base_draft_version_number": command.base_draft_version_number,
            "payload": serialized,
            "confirm_initial_search_index": command.confirm_initial_search_index,
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="save_config_draft",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _snapshot_from_response(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    # The stable settings row exists from migration/bootstrap and is always the
    # first lock, including the otherwise racy first draft INSERT path.
    settings = lock_family_model_settings(db, family_id=command.family_id)
    draft = get_config_draft(db, family_id=command.family_id, for_update=True)
    current_version = draft.draft_version_number if draft is not None else 0
    if command.base_draft_version_number != current_version:
        raise FamilyModelSettingsVersionConflict(
            current_draft_version_number=current_version
        )
    # On an established family, disabled cards are historical/inert state and
    # may legitimately retain a profile that was deleted or moved.  Normalize
    # those IDs only after the first-save boundary check below; a brand-new
    # request carrying a foreign ID must still fail closed rather than being
    # mistaken for harmless legacy state.
    if draft is not None or settings.active_config_revision_id is not None:
        payload = _sanitize_disabled_binding_references(payload)
    # A malformed/foreign profile reference is a data-boundary violation, not
    # an ordinary card validation warning. Reject the whole write before the
    # independent capability merge so no cross-family ID can enter a draft.
    _require_owned_profile_references(
        db,
        family_id=command.family_id,
        payload=payload,
    )
    existing_payload: FamilyModelConfigDraftPayload | None = None
    existing_payload_issues: tuple[DraftValidationIssue, ...] = ()
    existing_validation_issues: tuple[DraftValidationIssue, ...] = ()
    if draft is not None:
        existing_payload, existing_payload_issues = _safe_payload_from_raw(
            draft.payload_json
        )
        existing_payload = _sanitize_non_owned_profile_references(
            db,
            family_id=command.family_id,
            payload=existing_payload,
        )
        incoming_identities = {
            identity
            for identity in (_binding_identity(binding) for binding in payload.bindings)
            if identity is not None
        }
        incoming_identities.update(
            (rate.capability, rate.variant_key) for rate in payload.price_rates
        )
        existing_validation_issues = _carry_forward_draft_issues(
            draft.validation_errors_json,
            existing_payload=existing_payload,
            incoming_identities=incoming_identities,
        )
    independent_validation: DraftValidationResult | None = None
    validation_issues: tuple[DraftValidationIssue, ...] = ()
    successful_identities: frozenset[tuple[str, str]] = frozenset()
    stored_payload = payload
    if network_policy is not None:
        baseline_payload, baseline_binding_rows = _active_runtime_baseline(
            db,
            settings=settings,
        )
        (
            independent_validation,
            validation_issues,
            successful_identities,
        ) = _independent_validation(
            db,
            family_id=command.family_id,
            settings=settings,
            payload=payload,
            baseline_payload=baseline_payload,
            baseline_binding_rows=baseline_binding_rows,
            network_policy=network_policy,
            draft_version_number=current_version + 1,
            confirm_initial_search_index=command.confirm_initial_search_index,
        )
        # Preserve the historical first-search UX: when the request only
        # contains an unconfirmed initial Embedding, do not create a draft
        # receipt that the UI cannot recover from.  If another capability was
        # valid in the same request, it is applied independently and the
        # Embedding issue is simply retained on the draft.
        if (
            not successful_identities
            and _only_initial_embedding_candidate(
                payload,
                baseline_payload=baseline_payload,
            )
            and any(
                issue.code == "family_search_initial_confirmation_required"
                for issue in validation_issues
            )
        ):
            raise FamilyModelDraftInvalid("family_search_initial_confirmation_required")
        stored_payload = _merge_payload_for_storage(
            payload,
            baseline_payload=baseline_payload,
            existing_payload=existing_payload,
        )
        # Draft pointers are historical client hints, not authority.  Keep
        # only family-owned rows so a stale first-save payload cannot violate
        # the draft FK or make the UI believe an unrelated search profile is
        # configured after an invalid card edit.
        if stored_payload.base_config_revision_id is not None:
            base_revision = get_config_revision(
                db,
                family_id=command.family_id,
                config_revision_id=stored_payload.base_config_revision_id,
            )
            if base_revision is None:
                stored_payload = stored_payload.model_copy(
                    update={"base_config_revision_id": None}
                )
        if stored_payload.search_profile_id is not None:
            search_profile = get_search_profile(
                db,
                family_id=command.family_id,
                search_profile_id=stored_payload.search_profile_id,
            )
            if search_profile is None:
                stored_payload = stored_payload.model_copy(
                    update={"search_profile_id": None}
                )
        # Validation runs against request/existing-payload order, while the
        # storage merge sorts identities for deterministic snapshots. Restore
        # indexed paths after that merge so an error always points at the row
        # returned in this response rather than at a sibling capability.
        normalized_issues: list[DraftValidationIssue] = []
        for source_issues, source_payload in (
            (existing_validation_issues, existing_payload),
            (validation_issues, payload),
            (existing_payload_issues, existing_payload),
        ):
            for issue in _remap_indexed_issue_fields(
                source_issues,
                source_payload=source_payload,
                stored_payload=stored_payload,
            ):
                _append_unique_issue(normalized_issues, issue)
        validation_issues = tuple(normalized_issues)
    changed_at = utcnow()
    if draft is None:
        draft = FamilyModelConfigDraft(
            family_id=command.family_id,
            base_config_revision_id=stored_payload.base_config_revision_id,
            draft_version_number=1,
            payload_json=remove_write_only_secret_commands(
                stored_payload.model_dump(mode="json", exclude_none=True)
            ),
            validation_status="unknown",
            validation_errors_json=[],
            updated_at=changed_at,
            updated_by=command.actor_user_id,
        )
        db.add(draft)
    else:
        draft.base_config_revision_id = stored_payload.base_config_revision_id
        draft.payload_json = remove_write_only_secret_commands(
            stored_payload.model_dump(mode="json", exclude_none=True)
        )
        draft.draft_version_number += 1
        draft.validation_status = "unknown"
        draft.validation_errors_json = []
        draft.updated_at = changed_at
        draft.updated_by = command.actor_user_id
    db.flush()
    if network_policy is not None:
        if independent_validation is not None and successful_identities:
            from app.services.family_model_settings.publishing import (
                apply_validated_family_model_configuration,
            )

            apply_validated_family_model_configuration(
                db,
                family_id=command.family_id,
                actor_user_id=command.actor_user_id,
                settings=settings,
                draft=draft,
                validation=independent_validation,
                network_policy=network_policy,
            )
        draft.validation_status = "invalid" if validation_issues else "valid"
        draft.validation_errors_json = [issue.record() for issue in validation_issues]
        draft.updated_at = utcnow()
        draft.updated_by = command.actor_user_id
    snapshot = _snapshot(draft)
    complete_operation(
        claim,
        result_id=command.family_id,
        response_json=snapshot.response_record(),
        completed_at=changed_at,
    )
    db.flush()
    return snapshot


def profile_is_referenced_by_current_draft(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
) -> bool:
    draft = get_config_draft(db, family_id=family_id)
    if draft is None:
        return False
    bindings = draft.payload_json.get("bindings", []) if isinstance(draft.payload_json, dict) else []
    return any(
        isinstance(binding, Mapping) and binding.get("provider_profile_id") == profile_id
        for binding in bindings
    )


def profile_is_referenced_by_active_binding(
    db: Session,
    *,
    family_id: str,
    profile_id: str,
) -> bool:
    # Callers that mutate a profile already own the settings lock.  This
    # read-only helper deliberately does not acquire it again, preserving the
    # global settings -> profile -> draft ordering.
    settings = get_family_model_settings(db, family_id=family_id)
    if settings is None or settings.active_config_revision_id is None:
        return False
    return (
        db.scalar(
            select(FamilyModelCapabilityBinding.id)
            .where(
                FamilyModelCapabilityBinding.family_id == family_id,
                FamilyModelCapabilityBinding.config_revision_id
                == settings.active_config_revision_id,
                FamilyModelCapabilityBinding.provider_profile_id == profile_id,
                FamilyModelCapabilityBinding.enabled.is_(True),
            )
            .limit(1)
        )
        is not None
    )
