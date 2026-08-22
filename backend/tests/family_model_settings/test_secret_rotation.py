from __future__ import annotations

import base64
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta

import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    FamilyModelSecretStatus,
    MembershipStatus,
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageOperationSource,
    ModelUsagePricingStatus,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
    UserRole,
)
from app.core.security import get_password_hash
from app.core.utils import utcnow
from app.db.base import Base
from app.models.domain import Family, Membership, User, UserCredential
from app.models.family_model_settings import (
    FamilyModelProviderProfile,
    FamilyModelProviderProfileVersion,
    FamilyModelSecretVersion,
    FamilyModelSettings,
)
from app.models.model_usage import ModelUsageReservation
from app.repos.family_model_settings.idempotency import get_operation_receipt
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    create_secret_version,
    decode_family_model_credential_keyring,
    destroy_eligible_revoked_secrets,
    resolve_dispatch_credential,
    rotate_profile_secret,
)
from app.services.family_model_settings.errors import (
    FamilyModelProviderProfileNotFound,
    FamilyModelProviderScopeChangeRequiresNewProfile,
)
from app.services.family_model_settings.types import RotateProfileSecretCommand


OLD_SECRET = "sk-old-secret-marker"
NEW_SECRET = "sk-new-secret-marker"


@dataclass(slots=True)
class RotationContext:
    db: Session
    cipher: FamilyModelCredentialCipher
    family_id: str
    owner_id: str
    profile_id: str
    scope_checksum: str
    old_secret_id: str


def _cipher() -> FamilyModelCredentialCipher:
    keyring = decode_family_model_credential_keyring(
        active_key_id="k1",
        keys_json=SecretStr(
            json.dumps({"k1": base64.b64encode(b"a" * 32).decode("ascii")})
        ),
    )
    return FamilyModelCredentialCipher(keyring)


def _add_owner(db: Session, *, family_id: str, user_id: str, username: str) -> None:
    db.add_all(
        [
            Family(id=family_id, name=family_id, motto="", location=""),
            User(id=user_id, username=username, display_name=username, avatar_seed=username),
        ]
    )
    db.flush()
    db.add_all(
        [
            UserCredential(
                id=f"credential-{user_id}",
                user_id=user_id,
                password_hash=get_password_hash("OwnerPass123"),
            ),
            Membership(
                id=f"membership-{user_id}",
                family_id=family_id,
                user_id=user_id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            ),
        ]
    )


@pytest.fixture()
def rotation_context() -> Iterator[RotationContext]:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    cipher = _cipher()
    family_id = "family-1"
    owner_id = "owner-1"
    scope_checksum = "credential-scope-1"
    _add_owner(db, family_id=family_id, user_id=owner_id, username="owner-one")
    db.add(FamilyModelSettings(family_id=family_id, created_by=owner_id, updated_by=owner_id))
    profile = FamilyModelProviderProfile(
        id="profile-1",
        family_id=family_id,
        display_name="主服务",
        credential_scope_checksum=scope_checksum,
        status="active",
        version_number=1,
        created_by=owner_id,
        updated_by=owner_id,
    )
    db.add(profile)
    db.flush()
    profile_version = FamilyModelProviderProfileVersion(
        id="profile-version-1",
        family_id=family_id,
        profile_id=profile.id,
        version_number=1,
        adapter_kind="openai_compatible_http",
        auth_mode="api_key",
        api_base_url="https://api.example.test/v1",
        websocket_base_url=None,
        options_json={},
        credential_scope_checksum=scope_checksum,
        endpoint_fingerprint="endpoint-1",
        created_by=owner_id,
    )
    db.add(profile_version)
    db.flush()
    profile.current_profile_version_id = profile_version.id
    old_secret = create_secret_version(
        db,
        profile=profile,
        plaintext=OLD_SECRET,
        cipher=cipher,
        actor_user_id=owner_id,
    )
    profile.current_secret_version_id = old_secret.id
    db.commit()
    try:
        yield RotationContext(
            db=db,
            cipher=cipher,
            family_id=family_id,
            owner_id=owner_id,
            profile_id=profile.id,
            scope_checksum=scope_checksum,
            old_secret_id=old_secret.id,
        )
    finally:
        db.close()
        engine.dispose()


def _command(context: RotationContext, **overrides: object) -> RotateProfileSecretCommand:
    values: dict[str, object] = {
        "family_id": context.family_id,
        "profile_id": context.profile_id,
        "actor_user_id": context.owner_id,
        "base_settings_version": 1,
        "idempotency_key": "rotate-1",
        "credential_scope_checksum": context.scope_checksum,
        "new_api_key": NEW_SECRET,
    }
    values.update(overrides)
    return RotateProfileSecretCommand(**values)


def test_rotate_key_switches_pointer_revokes_old_version_and_keeps_output_write_only(
    rotation_context: RotationContext,
) -> None:
    result = rotate_profile_secret(rotation_context.db, _command(rotation_context), cipher=rotation_context.cipher)
    rotation_context.db.flush()
    profile = rotation_context.db.get(FamilyModelProviderProfile, rotation_context.profile_id)
    old_secret = rotation_context.db.get(FamilyModelSecretVersion, rotation_context.old_secret_id)

    assert profile is not None
    assert old_secret is not None
    assert result.configured is True
    assert result.secret_version_number == 2
    assert profile.current_secret_version_id == result.secret_version_id
    assert old_secret.status is FamilyModelSecretStatus.REVOKED
    assert OLD_SECRET not in str(result)
    assert NEW_SECRET not in str(result)
    receipt = get_operation_receipt(
        rotation_context.db,
        family_id=rotation_context.family_id,
        operation="rotate_profile_secret",
        idempotency_key="rotate-1",
    )
    assert receipt is not None
    assert NEW_SECRET not in json.dumps(receipt.response_json)
    assert NEW_SECRET not in receipt.request_fingerprint


def test_rotate_response_lost_replays_before_stale_settings_version_check(
    rotation_context: RotationContext,
) -> None:
    command = _command(rotation_context, idempotency_key="rotate-lost")
    first = rotate_profile_secret(rotation_context.db, command, cipher=rotation_context.cipher)
    rotation_context.db.commit()

    replay = rotate_profile_secret(rotation_context.db, command, cipher=rotation_context.cipher)

    assert replay == first
    assert rotation_context.db.scalar(
        select(func.count())
        .select_from(FamilyModelSecretVersion)
        .where(FamilyModelSecretVersion.profile_id == rotation_context.profile_id)
    ) == 2


def test_rotation_rejects_scope_changes(rotation_context: RotationContext) -> None:
    with pytest.raises(FamilyModelProviderScopeChangeRequiresNewProfile):
        rotate_profile_secret(
            rotation_context.db,
            _command(rotation_context, credential_scope_checksum="different-scope"),
            cipher=rotation_context.cipher,
        )


def test_rotation_hides_cross_family_profiles_as_not_found(rotation_context: RotationContext) -> None:
    _add_owner(
        rotation_context.db,
        family_id="family-2",
        user_id="owner-2",
        username="owner-two",
    )
    rotation_context.db.add(
        FamilyModelSettings(family_id="family-2", created_by="owner-2", updated_by="owner-2")
    )
    rotation_context.db.commit()

    with pytest.raises(FamilyModelProviderProfileNotFound):
        rotate_profile_secret(
            rotation_context.db,
            RotateProfileSecretCommand(
                family_id="family-2",
                profile_id=rotation_context.profile_id,
                actor_user_id="owner-2",
                base_settings_version=1,
                idempotency_key="cross-family",
                credential_scope_checksum=rotation_context.scope_checksum,
                new_api_key=NEW_SECRET,
            ),
            cipher=rotation_context.cipher,
        )


def test_dispatch_uses_current_secret_but_allows_an_already_authorized_revoked_secret(
    rotation_context: RotationContext,
) -> None:
    result = rotate_profile_secret(
        rotation_context.db,
        _command(rotation_context, idempotency_key="rotate-dispatch"),
        cipher=rotation_context.cipher,
    )

    current = resolve_dispatch_credential(
        rotation_context.db,
        cipher=rotation_context.cipher,
        family_id=rotation_context.family_id,
        provider_profile_id=rotation_context.profile_id,
        credential_secret_version_id=None,
    )
    already_authorized = resolve_dispatch_credential(
        rotation_context.db,
        cipher=rotation_context.cipher,
        family_id=rotation_context.family_id,
        provider_profile_id=rotation_context.profile_id,
        credential_secret_version_id=rotation_context.old_secret_id,
    )

    assert current.secret_version_id == result.secret_version_id
    assert current.api_key == NEW_SECRET
    assert already_authorized.secret_version_id == rotation_context.old_secret_id
    assert already_authorized.api_key == OLD_SECRET


def test_secret_destruction_waits_for_recoverable_dispatches(rotation_context: RotationContext) -> None:
    rotate_profile_secret(
        rotation_context.db,
        _command(rotation_context, idempotency_key="rotate-destroy"),
        cipher=rotation_context.cipher,
    )
    old_secret = rotation_context.db.get(FamilyModelSecretVersion, rotation_context.old_secret_id)
    assert old_secret is not None
    old_secret.revoked_at = utcnow() - timedelta(days=2)
    reservation = ModelUsageReservation(
        id="reservation-blocking-secret-destruction",
        attempt_key="attempt-blocking-secret-destruction",
        client_attempt_id="client-blocking-secret-destruction",
        fingerprint="fingerprint",
        family_id=rotation_context.family_id,
        subject_id="subject-not-enforced-in-sqlite",
        subject_key="subject",
        attribution_kind=ModelUsageAttributionKind.SYSTEM,
        operation_source=ModelUsageOperationSource.BACKGROUND_INDEX,
        logical_operation_id="operation",
        operation_kind="test",
        capability=ModelUsageCapability.LLM,
        provider="test",
        requested_model="test",
        billing_model="test",
        variant_key="default",
        billing_scheme_key="test",
        recovery_mode=ModelUsageRecoveryMode.NONE,
        policy_version_id="policy-not-enforced-in-sqlite",
        pricing_status=ModelUsagePricingStatus.UNPRICED,
        credential_secret_version_id=old_secret.id,
        period_start=utcnow(),
        period_end=utcnow(),
        status=ModelUsageReservationStatus.DISPATCHING,
        reserved_at=utcnow(),
    )
    rotation_context.db.add(reservation)
    rotation_context.db.flush()

    assert destroy_eligible_revoked_secrets(
        rotation_context.db,
        cutoff=utcnow() - timedelta(days=1),
    ) == ()

    reservation.status = ModelUsageReservationStatus.SETTLED
    destroyed = destroy_eligible_revoked_secrets(
        rotation_context.db,
        cutoff=utcnow() - timedelta(days=1),
    )

    assert destroyed == (old_secret.id,)
    assert old_secret.status is FamilyModelSecretStatus.DESTROYED
    assert old_secret.nonce is None
    assert old_secret.ciphertext is None
    assert old_secret.auth_tag is None
