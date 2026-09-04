from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import SecretStr
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.enums import (
    FamilyModelProviderStatus,
    FamilyModelSecretStatus,
    ModelUsageReservationStatus,
)
from app.core.enums import ActivityAction, MembershipStatus, UserRole
from app.core.security import verify_password
from app.core.utils import create_id, utcnow
from app.models.domain import Membership, UserCredential
from app.models.family_model_settings import (
    FamilyModelOperationReceipt,
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSecretVersion,
)
from app.models.model_usage import ModelUsageReservation
from app.services.family_model_settings.errors import (
    FamilyModelCredentialConfigurationError,
    FamilyModelOperationInProgress,
    FamilyModelOwnerReauthenticationFailed,
    FamilyModelProviderProfileInUse,
    FamilyModelProviderProfileVersionConflict,
    FamilyModelProviderScopeChangeRequiresNewProfile,
    FamilyModelSecretUnavailable,
    FamilyModelSettingsError,
)
from app.services.family_model_settings.credential_keyring_store import (
    load_local_credential_keyring,
)
from app.services.family_model_settings.types import (
    CanonicalCredentialScope,
    CreateProviderProfileCommand,
    DispatchCredential,
    ProviderProfileSnapshot,
    RotatedSecretResult,
    RotateProfileSecretCommand,
    UpdateProviderProfileCommand,
)
from app.repos.family_model_settings.idempotency import claim_operation, complete_operation
from app.repos.family_model_settings.profiles import (
    get_current_provider_profile_version,
    get_current_provider_secret_version,
    lock_family_model_settings,
    lock_provider_profile,
    require_provider_profile,
    require_settings_version,
)
from app.services.activity import log_activity
from app.services.family_model_settings.adapter_registry import (
    DASHSCOPE_API_BASE_URL,
    DASHSCOPE_WEBSOCKET_BASE_URL,
    adapter_definition,
    require_adapter_endpoint_contract,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy

if TYPE_CHECKING:
    from app.core.config import Settings


_AAD_PREFIX = b"culina-family-model-secret-v1\0"
_SECRET_FINGERPRINT_PREFIX = b"culina-family-model-secret-fingerprint-v1\0"
_OPERATION_FINGERPRINT_PREFIX = b"culina-family-model-operation-fingerprint-v1\0"


@dataclass(frozen=True, slots=True)
class FamilyModelCredentialKeyring:
    active_key_id: str
    keys: Mapping[str, bytes] = field(repr=False)

    def key_for(self, key_id: str) -> bytes:
        key = self.keys.get(key_id)
        if key is None:
            raise FamilyModelCredentialConfigurationError("family_model_credential_key_unavailable")
        return key


@dataclass(frozen=True, slots=True)
class SecretEnvelope:
    encryption_key_id: str
    nonce: bytes = field(repr=False)
    ciphertext: bytes = field(repr=False)
    auth_tag: bytes = field(repr=False)
    secret_fingerprint: str


def decode_family_model_credential_keyring(
    *,
    active_key_id: str,
    keys_json: SecretStr,
) -> FamilyModelCredentialKeyring:
    """Decode an AES-256 keyring without ever serializing its material."""

    normalized_active_key_id = active_key_id.strip()
    encoded = keys_json.get_secret_value().strip()
    if not normalized_active_key_id or not encoded:
        raise FamilyModelCredentialConfigurationError("family_model_credential_keyring_required")
    try:
        raw_keys = json.loads(encoded)
    except json.JSONDecodeError as exc:
        raise FamilyModelCredentialConfigurationError("family_model_credential_keyring_invalid") from exc
    if not isinstance(raw_keys, dict) or not raw_keys:
        raise FamilyModelCredentialConfigurationError("family_model_credential_keyring_invalid")

    decoded: dict[str, bytes] = {}
    for raw_key_id, encoded_key in raw_keys.items():
        if (
            not isinstance(raw_key_id, str)
            or not raw_key_id.strip()
            or len(raw_key_id) > 120
            or not isinstance(encoded_key, str)
            or not encoded_key
        ):
            raise FamilyModelCredentialConfigurationError("family_model_credential_keyring_invalid")
        try:
            material = base64.b64decode(encoded_key, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise FamilyModelCredentialConfigurationError(
                "family_model_credential_keyring_invalid"
            ) from exc
        if len(material) != 32:
            raise FamilyModelCredentialConfigurationError(
                "family_model_credential_key_length_invalid"
            )
        decoded[raw_key_id] = material
    if normalized_active_key_id not in decoded:
        raise FamilyModelCredentialConfigurationError("family_model_credential_active_key_missing")
    return FamilyModelCredentialKeyring(
        active_key_id=normalized_active_key_id,
        keys=MappingProxyType(decoded),
    )


def credential_aad(
    *,
    family_id: str,
    profile_id: str,
    secret_version_id: str,
    key_id: str,
) -> bytes:
    identities = (family_id, profile_id, secret_version_id, key_id)
    if any(not value or "\0" in value for value in identities):
        raise FamilyModelCredentialConfigurationError("family_model_credential_identity_invalid")
    return _AAD_PREFIX + b"\0".join(value.encode("utf-8") for value in identities)


def _secret_fingerprint(*, key: bytes, plaintext: str) -> str:
    return hmac.new(
        key,
        _SECRET_FINGERPRINT_PREFIX + plaintext.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise FamilyModelCredentialConfigurationError(
            "family_model_operation_fingerprint_invalid"
        ) from exc


def operation_request_fingerprint(
    keyring: FamilyModelCredentialKeyring,
    *,
    key_id: str,
    operation: str,
    public_fields: Mapping[str, Any],
    secret_fields: Mapping[str, str],
) -> str:
    """Fingerprint a write command without persisting its raw sensitive fields."""

    key = keyring.key_for(key_id)
    protected_secret_fields = {
        field_name: hmac.new(
            key,
            _OPERATION_FINGERPRINT_PREFIX
            + field_name.encode("utf-8")
            + b"\0"
            + value.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        for field_name, value in sorted(secret_fields.items())
    }
    payload = {
        "operation": operation,
        "public": dict(public_fields),
        "sensitive": protected_secret_fields,
    }
    return hmac.new(key, _canonical_json(payload), hashlib.sha256).hexdigest()


def validate_credential_keyring_references(
    db: Session,
    *,
    keyring: FamilyModelCredentialKeyring | None,
) -> None:
    """Reject removing encryption/HMAC keys still needed by retained records.

    Deployment startup or maintenance can call this after opening a database
    session.  It deliberately exposes neither missing key ids nor any secret
    record identity through the stable failure code.
    """

    secret_key_ids = set(
        db.scalars(
            select(FamilyModelSecretVersion.encryption_key_id).where(
                FamilyModelSecretVersion.status != FamilyModelSecretStatus.DESTROYED
            )
        )
    )
    receipt_key_ids = set(
        db.scalars(select(FamilyModelOperationReceipt.request_fingerprint_key_id))
    )
    available_key_ids = set(keyring.keys) if keyring is not None else set()
    if (secret_key_ids | receipt_key_ids) - available_key_ids:
        raise FamilyModelCredentialConfigurationError(
            "family_model_credential_referenced_key_missing"
        )


class FamilyModelCredentialCipher:
    def __init__(self, keyring: FamilyModelCredentialKeyring) -> None:
        self._keyring = keyring

    @property
    def active_key_id(self) -> str:
        return self._keyring.active_key_id

    @property
    def keyring(self) -> FamilyModelCredentialKeyring:
        return self._keyring

    @classmethod
    def from_settings(
        cls,
        settings: Settings,
        *,
        allow_local_keyring_creation: bool = False,
    ) -> FamilyModelCredentialCipher:
        active_key_id = settings.family_model_credential_active_key_id
        keys_json = settings.family_model_credential_keys_json
        if not active_key_id.strip() and not keys_json.get_secret_value().strip():
            from app.core.config import LOCAL_ENVIRONMENTS

            if settings.environment.strip().lower() in LOCAL_ENVIRONMENTS:
                stored = load_local_credential_keyring(
                    getattr(
                        settings,
                        "family_model_credential_keyring_file",
                        "storage/secrets/family-model-credential-keyring.json",
                    ),
                    create_if_missing=allow_local_keyring_creation,
                )
                active_key_id = stored.active_key_id
                keys_json = stored.keys_json
        return cls(
            decode_family_model_credential_keyring(
                active_key_id=active_key_id,
                keys_json=keys_json,
            )
        )

    def encrypt(
        self,
        *,
        family_id: str,
        profile_id: str,
        secret_version_id: str,
        plaintext: str,
    ) -> SecretEnvelope:
        if not plaintext:
            raise FamilyModelSecretUnavailable("family_model_secret_empty")
        nonce = os.urandom(12)
        key_id = self._keyring.active_key_id
        key = self._keyring.key_for(key_id)
        encrypted = AESGCM(key).encrypt(
            nonce,
            plaintext.encode("utf-8"),
            credential_aad(
                family_id=family_id,
                profile_id=profile_id,
                secret_version_id=secret_version_id,
                key_id=key_id,
            ),
        )
        return SecretEnvelope(
            encryption_key_id=key_id,
            nonce=nonce,
            ciphertext=encrypted[:-16],
            auth_tag=encrypted[-16:],
            secret_fingerprint=_secret_fingerprint(key=key, plaintext=plaintext),
        )

    def decrypt(
        self,
        *,
        version: FamilyModelSecretVersion,
        family_id: str,
        profile_id: str,
        secret_version_id: str,
    ) -> str:
        if (
            version.status is FamilyModelSecretStatus.DESTROYED
            or version.nonce is None
            or version.ciphertext is None
            or version.auth_tag is None
        ):
            raise FamilyModelSecretUnavailable()
        try:
            key = self._keyring.key_for(version.encryption_key_id)
            plaintext = AESGCM(key).decrypt(
                version.nonce,
                version.ciphertext + version.auth_tag,
                credential_aad(
                    family_id=family_id,
                    profile_id=profile_id,
                    secret_version_id=secret_version_id,
                    key_id=version.encryption_key_id,
                ),
            )
            return plaintext.decode("utf-8")
        except (
            FamilyModelCredentialConfigurationError,
            InvalidTag,
            UnicodeDecodeError,
            ValueError,
        ) as exc:
            raise FamilyModelSecretUnavailable() from exc


def create_secret_version(
    db: Session,
    *,
    profile: FamilyModelProviderProfile,
    plaintext: str,
    cipher: FamilyModelCredentialCipher,
    actor_user_id: str,
) -> FamilyModelSecretVersion:
    """Create an immutable encrypted secret version while the profile row is locked."""

    next_version_number = (
        db.scalar(
            select(func.max(FamilyModelSecretVersion.version_number)).where(
                FamilyModelSecretVersion.family_id == profile.family_id,
                FamilyModelSecretVersion.profile_id == profile.id,
            )
        )
        or 0
    ) + 1
    secret_version_id = create_id("family-model-secret")
    envelope = cipher.encrypt(
        family_id=profile.family_id,
        profile_id=profile.id,
        secret_version_id=secret_version_id,
        plaintext=plaintext,
    )
    version = FamilyModelSecretVersion(
        id=secret_version_id,
        family_id=profile.family_id,
        profile_id=profile.id,
        version_number=next_version_number,
        encryption_key_id=envelope.encryption_key_id,
        nonce=envelope.nonce,
        ciphertext=envelope.ciphertext,
        auth_tag=envelope.auth_tag,
        secret_fingerprint=envelope.secret_fingerprint,
        status=FamilyModelSecretStatus.ACTIVE,
        created_by=actor_user_id,
    )
    db.add(version)
    db.flush()
    return version


def revoke_current_secret(
    db: Session,
    *,
    profile: FamilyModelProviderProfile,
) -> FamilyModelSecretVersion | None:
    if profile.current_secret_version_id is None:
        return None
    current = db.scalar(
        select(FamilyModelSecretVersion)
        .where(
            FamilyModelSecretVersion.id == profile.current_secret_version_id,
            FamilyModelSecretVersion.family_id == profile.family_id,
            FamilyModelSecretVersion.profile_id == profile.id,
        )
        .with_for_update()
    )
    if current is None:
        raise FamilyModelSecretUnavailable()
    if current.status is FamilyModelSecretStatus.ACTIVE:
        current.status = FamilyModelSecretStatus.REVOKED
        current.revoked_at = utcnow()
    return current


def resolve_dispatch_credential(
    db: Session,
    *,
    cipher: FamilyModelCredentialCipher,
    family_id: str,
    provider_profile_id: str,
    credential_secret_version_id: str | None,
) -> DispatchCredential:
    profile = db.scalar(
        select(FamilyModelProviderProfile).where(
            FamilyModelProviderProfile.family_id == family_id,
            FamilyModelProviderProfile.id == provider_profile_id,
        )
    )
    if profile is None:
        raise FamilyModelSecretUnavailable()
    secret_version_id = credential_secret_version_id or profile.current_secret_version_id
    if secret_version_id is None:
        return DispatchCredential(
            family_id=family_id,
            provider_profile_id=profile.id,
            secret_version_id=None,
            api_key=None,
        )
    version = db.scalar(
        select(FamilyModelSecretVersion).where(
            FamilyModelSecretVersion.id == secret_version_id,
            FamilyModelSecretVersion.family_id == family_id,
            FamilyModelSecretVersion.profile_id == profile.id,
        )
    )
    if version is None:
        raise FamilyModelSecretUnavailable()
    if (
        credential_secret_version_id is None
        and version.status is not FamilyModelSecretStatus.ACTIVE
    ):
        raise FamilyModelSecretUnavailable()
    return DispatchCredential(
        family_id=family_id,
        provider_profile_id=profile.id,
        secret_version_id=version.id,
        api_key=cipher.decrypt(
            version=version,
            family_id=family_id,
            profile_id=profile.id,
            secret_version_id=version.id,
        ),
    )


def verify_owner_password(
    db: Session,
    *,
    family_id: str,
    actor_user_id: str,
    current_password: str,
) -> None:
    membership = db.scalar(
        select(Membership.id).where(
            Membership.family_id == family_id,
            Membership.user_id == actor_user_id,
            Membership.role == UserRole.OWNER,
            Membership.status == MembershipStatus.ACTIVE,
        )
    )
    credential = db.scalar(
        select(UserCredential).where(UserCredential.user_id == actor_user_id)
    )
    if membership is None or credential is None or not verify_password(
        current_password, credential.password_hash
    ):
        raise FamilyModelOwnerReauthenticationFailed()


def _require_api_key_profile(
    db: Session,
    *,
    profile: FamilyModelProviderProfile,
) -> None:
    if profile.current_profile_version_id is None:
        raise FamilyModelProviderScopeChangeRequiresNewProfile()
    profile_version = db.scalar(
        select(FamilyModelProviderProfileVersion).where(
            FamilyModelProviderProfileVersion.id == profile.current_profile_version_id,
            FamilyModelProviderProfileVersion.family_id == profile.family_id,
            FamilyModelProviderProfileVersion.profile_id == profile.id,
        )
    )
    if profile_version is None or profile_version.auth_mode != "api_key":
        raise FamilyModelProviderScopeChangeRequiresNewProfile()


def _rotated_secret_result(
    *,
    secret: FamilyModelSecretVersion,
    updated_at: datetime,
) -> RotatedSecretResult:
    return RotatedSecretResult(
        configured=True,
        secret_version_id=secret.id,
        secret_version_number=secret.version_number,
        updated_at=updated_at,
    )


def _rotation_response(result: RotatedSecretResult) -> dict[str, object]:
    return {
        "configured": result.configured,
        "secretVersionNumber": result.secret_version_number,
        "updatedAt": result.updated_at.isoformat(),
    }


def _replayed_rotation_result(claim) -> RotatedSecretResult:
    response = claim.receipt.response_json
    if claim.receipt.result_id is None or not isinstance(response, dict):
        raise FamilyModelSecretUnavailable()
    try:
        configured = response["configured"]
        version_number = response["secretVersionNumber"]
        updated_at = response["updatedAt"]
        if (
            not isinstance(configured, bool)
            or not isinstance(version_number, int)
            or not isinstance(updated_at, str)
        ):
            raise TypeError
        parsed_updated_at = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        if parsed_updated_at.tzinfo is None:
            raise ValueError
    except (KeyError, TypeError, ValueError) as exc:
        raise FamilyModelSecretUnavailable() from exc
    return RotatedSecretResult(
        configured=configured,
        secret_version_id=claim.receipt.result_id,
        secret_version_number=version_number,
        updated_at=parsed_updated_at,
    )


def rotate_profile_secret(
    db: Session,
    command: RotateProfileSecretCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> RotatedSecretResult:
    """Replace one profile Key under the stable family settings lock.

    The caller owns the surrounding transaction.  A successful receipt and all
    secret-pointer updates are therefore committed or rolled back together.
    """

    require_provider_profile(
        db,
        family_id=command.family_id,
        profile_id=command.profile_id,
    )
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="rotate_profile_secret",
        public_fields={
            "family_id": command.family_id,
            "profile_id": command.profile_id,
            "base_settings_version": command.base_settings_version,
            "credential_scope_checksum": command.credential_scope_checksum,
        },
        secret_fields={"new_api_key": command.new_api_key},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="rotate_profile_secret",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _replayed_rotation_result(claim)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    profile = lock_provider_profile(
        db,
        family_id=command.family_id,
        profile_id=command.profile_id,
    )
    require_settings_version(settings, command.base_settings_version)
    if not hmac.compare_digest(
        profile.credential_scope_checksum, command.credential_scope_checksum
    ):
        raise FamilyModelProviderScopeChangeRequiresNewProfile()
    _require_api_key_profile(db, profile=profile)

    new_secret = create_secret_version(
        db,
        profile=profile,
        plaintext=command.new_api_key,
        cipher=cipher,
        actor_user_id=command.actor_user_id,
    )
    revoke_current_secret(db, profile=profile)
    changed_at = utcnow()
    profile.current_secret_version_id = new_secret.id
    profile.version_number += 1
    profile.updated_by = command.actor_user_id
    profile.updated_at = changed_at
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = changed_at
    result = _rotated_secret_result(secret=new_secret, updated_at=changed_at)
    complete_operation(
        claim,
        result_id=new_secret.id,
        response_json=_rotation_response(result),
        completed_at=changed_at,
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="family_model_provider_profile",
        entity_id=profile.id,
        summary="更新了家庭 AI 服务凭据",
    )
    db.flush()
    return result


_BLOCKING_SECRET_STATUSES = (
    ModelUsageReservationStatus.DISPATCHING,
    ModelUsageReservationStatus.UNCERTAIN,
)


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def secret_can_be_destroyed(
    db: Session,
    *,
    secret: FamilyModelSecretVersion,
    cutoff: datetime,
) -> bool:
    if secret.status is not FamilyModelSecretStatus.REVOKED or secret.revoked_at is None:
        return False
    if _as_utc(secret.revoked_at) > _as_utc(cutoff):
        return False
    blocking_reservation = db.scalar(
        select(ModelUsageReservation.id)
        .where(
            ModelUsageReservation.family_id == secret.family_id,
            ModelUsageReservation.credential_secret_version_id == secret.id,
            ModelUsageReservation.status.in_(_BLOCKING_SECRET_STATUSES),
        )
        .limit(1)
    )
    return blocking_reservation is None


def destroy_eligible_revoked_secrets(
    db: Session,
    *,
    cutoff: datetime,
) -> tuple[str, ...]:
    destroyed: list[str] = []
    candidates = db.scalars(
        select(FamilyModelSecretVersion)
        .where(
            FamilyModelSecretVersion.status == FamilyModelSecretStatus.REVOKED,
            FamilyModelSecretVersion.revoked_at.is_not(None),
        )
        .order_by(FamilyModelSecretVersion.family_id, FamilyModelSecretVersion.id)
        .with_for_update()
    )
    for secret in candidates:
        if not secret_can_be_destroyed(db, secret=secret, cutoff=cutoff):
            continue
        secret.nonce = None
        secret.ciphertext = None
        secret.auth_tag = None
        secret.status = FamilyModelSecretStatus.DESTROYED
        secret.destroyed_at = utcnow()
        destroyed.append(secret.id)
    db.flush()
    return tuple(destroyed)


def canonical_credential_scope(
    *,
    network_policy: ProviderNetworkPolicy,
    adapter_kind: str,
    auth_mode: str,
    api_base_url: str,
    websocket_base_url: str | None,
    options: Mapping[str, object],
) -> CanonicalCredentialScope:
    """Authorize and fingerprint the immutable credential scope once.

    The profile version keeps the normalized endpoint strings, while the
    profile keeps a checksum over every scope component.  Neither record has
    plaintext credentials, so the checksum can safely participate in OCC and
    operation fingerprints.
    """

    definition = adapter_definition(adapter_kind)
    if adapter_kind == "dashscope":
        if auth_mode != "api_key":
            raise FamilyModelProviderProtocolUnsupported()
        api_base_url = DASHSCOPE_API_BASE_URL
        websocket_base_url = DASHSCOPE_WEBSOCKET_BASE_URL
    main_protocol = (
        "http"
        if any(protocol in {"http", "https"} for protocol in definition.http_protocols)
        else "websocket"
    )
    endpoint = network_policy.authorize(api_base_url, protocol=main_protocol)  # type: ignore[arg-type]
    require_adapter_endpoint_contract(
        kind=adapter_kind,
        auth_mode=auth_mode,
        endpoint=endpoint,
    )
    websocket_endpoint = (
        network_policy.authorize(websocket_base_url, protocol="websocket")
        if websocket_base_url
        else None
    )
    normalized_options = {
        str(key): value
        for key, value in sorted(options.items())
        if value is not None
    }
    endpoint_record = {
        "api_base_url": endpoint.normalized_url,
        "websocket_base_url": (
            websocket_endpoint.normalized_url if websocket_endpoint is not None else None
        ),
    }
    scope_record = {
        "adapter_kind": adapter_kind,
        "auth_mode": auth_mode,
        **endpoint_record,
        "options": normalized_options,
    }
    return CanonicalCredentialScope(
        checksum=hashlib.sha256(_canonical_json(scope_record)).hexdigest(),
        endpoint_fingerprint=hashlib.sha256(_canonical_json(endpoint_record)).hexdigest(),
        api_endpoint=endpoint,
        websocket_endpoint=websocket_endpoint,
        options=MappingProxyType(normalized_options),
    )


def provider_profile_snapshot(
    db: Session,
    *,
    family_id: str,
    profile: FamilyModelProviderProfile,
) -> ProviderProfileSnapshot:
    version = get_current_provider_profile_version(
        db,
        family_id=family_id,
        profile=profile,
    )
    if version is None:
        raise FamilyModelSecretUnavailable("family_model_provider_profile_incomplete")
    secret = get_current_provider_secret_version(
        db,
        family_id=family_id,
        profile=profile,
    )
    auth_mode = version.auth_mode
    configured = (
        auth_mode == "no_auth"
        or (
            secret is not None
            and secret.status is FamilyModelSecretStatus.ACTIVE
            and secret.nonce is not None
            and secret.ciphertext is not None
            and secret.auth_tag is not None
        )
    )
    return ProviderProfileSnapshot(
        id=profile.id,
        display_name=profile.display_name,
        adapter_kind=version.adapter_kind,  # type: ignore[arg-type]
        auth_mode=auth_mode,  # type: ignore[arg-type]
        api_base_url=version.api_base_url,
        websocket_base_url=version.websocket_base_url,
        options=MappingProxyType(dict(version.options_json or {})),
        status=profile.status.value,
        archived=profile.status is FamilyModelProviderStatus.ARCHIVED,
        version_number=profile.version_number,
        profile_version_number=version.version_number,
        credential_configured=configured,
        credential_version_number=secret.version_number if secret is not None else None,
        credential_updated_at=secret.created_at if secret is not None else None,
        created_at=profile.created_at,
        updated_at=profile.updated_at,
    )


def provider_profile_response_record(snapshot: ProviderProfileSnapshot) -> dict[str, object]:
    return {
        "id": snapshot.id,
        "display_name": snapshot.display_name,
        "adapter_kind": snapshot.adapter_kind,
        "auth_mode": snapshot.auth_mode,
        "api_base_url": snapshot.api_base_url,
        "websocket_base_url": snapshot.websocket_base_url,
        "options": dict(snapshot.options),
        "status": snapshot.status,
        "archived": snapshot.archived,
        "version_number": snapshot.version_number,
        "profile_version_number": snapshot.profile_version_number,
        "credential": {
            "configured": snapshot.credential_configured,
            "version_number": snapshot.credential_version_number,
            "updated_at": (
                snapshot.credential_updated_at.isoformat()
                if snapshot.credential_updated_at is not None
                else None
            ),
        },
        "created_at": snapshot.created_at.isoformat(),
        "updated_at": snapshot.updated_at.isoformat(),
    }


def _snapshot_from_profile_response(response: object) -> ProviderProfileSnapshot:
    if not isinstance(response, Mapping):
        raise FamilyModelOperationInProgress()
    try:
        credential = response["credential"]
        if not isinstance(credential, Mapping):
            raise TypeError
        options = response.get("options", {})
        if not isinstance(options, Mapping):
            raise TypeError
        created_at = datetime.fromisoformat(str(response["created_at"]).replace("Z", "+00:00"))
        updated_at = datetime.fromisoformat(str(response["updated_at"]).replace("Z", "+00:00"))
        raw_credential_updated_at = credential.get("updated_at")
        credential_updated_at = (
            datetime.fromisoformat(str(raw_credential_updated_at).replace("Z", "+00:00"))
            if raw_credential_updated_at is not None
            else None
        )
        fields = (
            "id",
            "display_name",
            "adapter_kind",
            "auth_mode",
            "api_base_url",
            "status",
        )
        if any(not isinstance(response[field], str) for field in fields):
            raise TypeError
        if not isinstance(response.get("websocket_base_url"), (str, type(None))):
            raise TypeError
        if not isinstance(response["archived"], bool):
            raise TypeError
        if not isinstance(response["version_number"], int):
            raise TypeError
        if not isinstance(response["profile_version_number"], int):
            raise TypeError
        if not isinstance(credential["configured"], bool):
            raise TypeError
        if not isinstance(credential.get("version_number"), (int, type(None))):
            raise TypeError
    except (KeyError, TypeError, ValueError) as exc:
        raise FamilyModelOperationInProgress() from exc
    return ProviderProfileSnapshot(
        id=response["id"],
        display_name=response["display_name"],
        adapter_kind=response["adapter_kind"],  # type: ignore[arg-type]
        auth_mode=response["auth_mode"],  # type: ignore[arg-type]
        api_base_url=response["api_base_url"],
        websocket_base_url=response.get("websocket_base_url"),
        options=MappingProxyType(dict(options)),
        status=response["status"],
        archived=response["archived"],
        version_number=response["version_number"],
        profile_version_number=response["profile_version_number"],
        credential_configured=credential["configured"],
        credential_version_number=credential.get("version_number"),
        credential_updated_at=credential_updated_at,
        created_at=created_at,
        updated_at=updated_at,
    )


def _same_family_display_name_exists(
    db: Session,
    *,
    family_id: str,
    display_name: str,
    excluding_profile_id: str | None = None,
) -> bool:
    statement = select(FamilyModelProviderProfile.id).where(
        FamilyModelProviderProfile.family_id == family_id,
        FamilyModelProviderProfile.display_name == display_name,
    )
    if excluding_profile_id is not None:
        statement = statement.where(FamilyModelProviderProfile.id != excluding_profile_id)
    return db.scalar(statement.limit(1)) is not None


def create_provider_profile(
    db: Session,
    command: CreateProviderProfileCommand,
    *,
    cipher: FamilyModelCredentialCipher,
    network_policy: ProviderNetworkPolicy,
) -> ProviderProfileSnapshot:
    scope = canonical_credential_scope(
        network_policy=network_policy,
        adapter_kind=command.adapter_kind,
        auth_mode=command.auth_mode,
        api_base_url=command.api_base_url,
        websocket_base_url=command.websocket_base_url,
        options=command.options,
    )
    if command.auth_mode == "api_key" and not (command.api_key or "").strip():
        raise FamilyModelSecretUnavailable("family_model_api_key_required")
    if command.auth_mode == "no_auth" and (command.api_key or "").strip():
        raise FamilyModelProviderScopeChangeRequiresNewProfile("family_model_api_key_not_allowed")
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="create_provider_profile",
        public_fields={
            "family_id": command.family_id,
            "display_name": command.display_name,
            "adapter_kind": command.adapter_kind,
            "auth_mode": command.auth_mode,
            "credential_scope_checksum": scope.checksum,
        },
        secret_fields={"api_key": command.api_key or ""},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="create_provider_profile",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _snapshot_from_profile_response(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    if _same_family_display_name_exists(
        db,
        family_id=command.family_id,
        display_name=command.display_name,
    ):
        raise FamilyModelSettingsError("family_model_provider_display_name_conflict")
    profile = FamilyModelProviderProfile(
        id=create_id("family-model-profile"),
        family_id=command.family_id,
        display_name=command.display_name,
        credential_scope_checksum=scope.checksum,
        status=FamilyModelProviderStatus.ACTIVE,
        version_number=1,
        created_by=command.actor_user_id,
        updated_by=command.actor_user_id,
    )
    db.add(profile)
    db.flush()
    version = FamilyModelProviderProfileVersion(
        id=create_id("family-model-profile-version"),
        family_id=command.family_id,
        profile_id=profile.id,
        version_number=1,
        adapter_kind=command.adapter_kind,
        auth_mode=command.auth_mode,
        api_base_url=scope.api_endpoint.normalized_url,
        websocket_base_url=(
            scope.websocket_endpoint.normalized_url
            if scope.websocket_endpoint is not None
            else None
        ),
        options_json=dict(scope.options),
        credential_scope_checksum=scope.checksum,
        endpoint_fingerprint=scope.endpoint_fingerprint,
        created_by=command.actor_user_id,
    )
    db.add(version)
    db.flush()
    profile.current_profile_version_id = version.id
    if command.auth_mode == "api_key":
        secret = create_secret_version(
            db,
            profile=profile,
            plaintext=(command.api_key or "").strip(),
            cipher=cipher,
            actor_user_id=command.actor_user_id,
        )
        profile.current_secret_version_id = secret.id
    changed_at = utcnow()
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = changed_at
    profile.updated_at = changed_at
    db.flush()
    snapshot = provider_profile_snapshot(db, family_id=command.family_id, profile=profile)
    complete_operation(
        claim,
        result_id=profile.id,
        response_json=provider_profile_response_record(snapshot),
        completed_at=changed_at,
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.CREATE,
        entity_type="family_model_provider_profile",
        entity_id=profile.id,
        summary="新增了家庭 AI 服务档案",
    )
    db.flush()
    return snapshot


def update_provider_profile(
    db: Session,
    command: UpdateProviderProfileCommand,
    *,
    cipher: FamilyModelCredentialCipher,
) -> ProviderProfileSnapshot:
    fingerprint_for_key_id = lambda key_id: operation_request_fingerprint(
        cipher.keyring,
        key_id=key_id,
        operation="update_provider_profile",
        public_fields={
            "family_id": command.family_id,
            "profile_id": command.profile_id,
            "base_profile_version_number": command.base_profile_version_number,
            "display_name": command.display_name,
            "status": command.status,
        },
        secret_fields={},
    )
    claim = claim_operation(
        db,
        family_id=command.family_id,
        operation="update_provider_profile",
        idempotency_key=command.idempotency_key,
        active_fingerprint_key_id=cipher.active_key_id,
        fingerprint_for_key_id=fingerprint_for_key_id,
    )
    if claim.completed:
        return _snapshot_from_profile_response(claim.receipt.response_json)
    if not claim.created_by_request:
        raise FamilyModelOperationInProgress()

    settings = lock_family_model_settings(db, family_id=command.family_id)
    profile = lock_provider_profile(
        db,
        family_id=command.family_id,
        profile_id=command.profile_id,
    )
    if profile.version_number != command.base_profile_version_number:
        raise FamilyModelProviderProfileVersionConflict(profile.version_number)
    if command.display_name is not None and command.display_name != profile.display_name:
        if _same_family_display_name_exists(
            db,
            family_id=command.family_id,
            display_name=command.display_name,
            excluding_profile_id=profile.id,
        ):
            raise FamilyModelSettingsError("family_model_provider_display_name_conflict")
        profile.display_name = command.display_name
    if command.status is not None:
        target_status = FamilyModelProviderStatus(command.status)
        if target_status is FamilyModelProviderStatus.ARCHIVED:
            # Imports stay local to avoid a credentials <-> drafts import cycle.
            from app.services.family_model_settings.drafts import (
                profile_is_referenced_by_active_binding,
                profile_is_referenced_by_current_draft,
            )

            if profile_is_referenced_by_current_draft(
                db,
                family_id=command.family_id,
                profile_id=profile.id,
            ) or profile_is_referenced_by_active_binding(
                db,
                family_id=command.family_id,
                profile_id=profile.id,
            ):
                raise FamilyModelProviderProfileInUse()
        profile.status = target_status
    changed_at = utcnow()
    profile.version_number += 1
    profile.updated_by = command.actor_user_id
    profile.updated_at = changed_at
    settings.version_number += 1
    settings.updated_by = command.actor_user_id
    settings.updated_at = changed_at
    db.flush()
    snapshot = provider_profile_snapshot(db, family_id=command.family_id, profile=profile)
    complete_operation(
        claim,
        result_id=profile.id,
        response_json=provider_profile_response_record(snapshot),
        completed_at=changed_at,
    )
    log_activity(
        db,
        family_id=command.family_id,
        actor_id=command.actor_user_id,
        action=ActivityAction.UPDATE,
        entity_type="family_model_provider_profile",
        entity_id=profile.id,
        summary="更新了家庭 AI 服务档案",
    )
    db.flush()
    return snapshot
