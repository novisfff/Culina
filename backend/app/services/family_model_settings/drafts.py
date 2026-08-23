from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.utils import utcnow
from app.models.family_model_settings import (
    FamilyModelCapabilityBinding,
    FamilyModelConfigDraft,
    FamilyModelProviderProfile,
)
from app.repos.family_model_settings.configurations import get_config_draft
from app.repos.family_model_settings.configurations import get_config_revision
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.search_profiles import get_search_profile
from app.repos.family_model_settings.profiles import (
    get_family_model_settings,
    lock_family_model_settings,
)
from app.schemas.family_model_settings import FamilyModelConfigDraftPayload
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
    payload = FamilyModelConfigDraftPayload.model_validate(draft.payload_json)
    if payload.search_profile_id is None and fallback_search_profile_id is not None:
        payload = payload.model_copy(update={"search_profile_id": fallback_search_profile_id})
    errors: list[dict[str, str]] = []
    for item in draft.validation_errors_json:
        if not isinstance(item, dict):
            continue
        normalized = {
            str(key): str(value)
            for key, value in item.items()
            if isinstance(key, str) and isinstance(value, (str, int, float, bool))
        }
        if normalized:
            errors.append(normalized)
    return ConfigDraftSnapshot(
        base_config_revision_id=draft.base_config_revision_id,
        draft_version_number=draft.draft_version_number,
        payload=payload.model_dump(mode="json", exclude_none=True),
        validation_status=draft.validation_status,
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
        errors = tuple(
            {str(key): str(value) for key, value in item.items()}
            for item in raw_errors
            if isinstance(item, Mapping)
        )
        base_revision = response.get("base_config_revision_id")
        if base_revision is not None and not isinstance(base_revision, str):
            raise TypeError
    except (KeyError, TypeError, ValueError) as exc:
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
    profile_id = settings.active_search_profile_id
    if profile_id is None and settings.active_config_revision_id is not None:
        revision = get_config_revision(
            db,
            family_id=settings.family_id,
            config_revision_id=settings.active_config_revision_id,
        )
        profile_id = revision.search_profile_id if revision is not None else None
    if profile_id is None:
        return None
    return get_search_profile(
        db,
        family_id=settings.family_id,
        search_profile_id=profile_id,
    )


def _require_immutable_search_identity(db: Session, *, settings, payload) -> None:
    profile = _configured_search_profile(db, settings=settings)
    if profile is None:
        return
    embedding = _ready_initial_embedding(payload)
    if (
        embedding is None
        or embedding.provider_profile_id != profile.provider_profile_id
        or embedding.requested_model != profile.embedding_model
        or embedding.dimensions != profile.dimensions
    ):
        raise FamilyModelDraftInvalid("family_search_profile_locked")


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
    configured_search_profile = _configured_search_profile(db, settings=settings)
    if (
        network_policy is not None
        and _ready_initial_embedding(payload) is not None
        and configured_search_profile is None
        and not command.confirm_initial_search_index
    ):
        raise FamilyModelDraftInvalid("family_search_initial_confirmation_required")
    if network_policy is not None:
        _require_immutable_search_identity(db, settings=settings, payload=payload)
    _require_owned_profile_references(db, family_id=command.family_id, payload=payload)
    changed_at = utcnow()
    if draft is None:
        draft = FamilyModelConfigDraft(
            family_id=command.family_id,
            base_config_revision_id=payload.base_config_revision_id,
            draft_version_number=1,
            payload_json=serialized,
            validation_status="unknown",
            validation_errors_json=[],
            updated_at=changed_at,
            updated_by=command.actor_user_id,
        )
        db.add(draft)
    else:
        draft.base_config_revision_id = payload.base_config_revision_id
        draft.payload_json = serialized
        draft.draft_version_number += 1
        draft.validation_status = "unknown"
        draft.validation_errors_json = []
        draft.updated_at = changed_at
        draft.updated_by = command.actor_user_id
    db.flush()
    if network_policy is not None:
        from app.services.family_model_settings.publishing import (
            apply_validated_family_model_configuration,
        )
        from app.services.family_model_settings.validation import (
            ValidateDraftCommand,
            validate_family_model_draft,
        )

        validation = validate_family_model_draft(
            db,
            ValidateDraftCommand(
                family_id=command.family_id,
                actor_user_id=command.actor_user_id,
                network_policy=network_policy,
                base_draft_version_number=draft.draft_version_number,
            ),
        )
        if validation.valid:
            apply_validated_family_model_configuration(
                db,
                family_id=command.family_id,
                actor_user_id=command.actor_user_id,
                settings=settings,
                draft=draft,
                validation=validation,
                network_policy=network_policy,
            )
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
