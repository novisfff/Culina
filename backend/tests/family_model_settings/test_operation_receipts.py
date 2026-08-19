from __future__ import annotations

import base64
import json
from collections.abc import Callable, Iterator

import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.models.domain import Family
from app.repos.family_model_settings.idempotency import (
    claim_operation,
    complete_operation,
    get_operation_receipt,
)
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialKeyring,
    decode_family_model_credential_keyring,
    operation_request_fingerprint,
    validate_credential_keyring_references,
)
from app.services.family_model_settings.errors import (
    FamilyModelCredentialConfigurationError,
    FamilyModelOperationIdempotencyConflict,
    FamilyModelOperationInProgress,
)


SECRET_MARKER = "sk-operation-receipt-secret-marker"


def _keyring(*, active_key_id: str, include_old: bool = True) -> FamilyModelCredentialKeyring:
    entries = {"k2": base64.b64encode(b"b" * 32).decode("ascii")}
    if include_old:
        entries["k1"] = base64.b64encode(b"a" * 32).decode("ascii")
    return decode_family_model_credential_keyring(
        active_key_id=active_key_id,
        keys_json=SecretStr(json.dumps(entries)),
    )


def _fingerprint_factory(
    keyring: FamilyModelCredentialKeyring,
    *,
    new_api_key: str = SECRET_MARKER,
) -> Callable[[str], str]:
    return lambda key_id: operation_request_fingerprint(
        keyring,
        key_id=key_id,
        operation="rotate_profile_secret",
        public_fields={
            "family_id": "family-1",
            "profile_id": "profile-1",
            "base_settings_version": 1,
        },
        secret_fields={"current_password": "OwnerPass123", "new_api_key": new_api_key},
    )


@pytest.fixture()
def db() -> Iterator[Session]:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    session.add(Family(id="family-1", name="测试家庭", motto="", location=""))
    session.commit()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_completed_receipt_replay_uses_the_receipt_key_after_active_key_changes(db: Session) -> None:
    first_keyring = _keyring(active_key_id="k1")
    first = claim_operation(
        db,
        family_id="family-1",
        operation="rotate_profile_secret",
        idempotency_key="rotate-lost-response",
        active_fingerprint_key_id=first_keyring.active_key_id,
        fingerprint_for_key_id=_fingerprint_factory(first_keyring),
    )
    complete_operation(
        first,
        result_id="secret-2",
        response_json={"configured": True, "secretVersionNumber": 2},
    )
    db.commit()

    rotated_keyring = _keyring(active_key_id="k2")
    replay = claim_operation(
        db,
        family_id="family-1",
        operation="rotate_profile_secret",
        idempotency_key="rotate-lost-response",
        active_fingerprint_key_id=rotated_keyring.active_key_id,
        fingerprint_for_key_id=_fingerprint_factory(rotated_keyring),
    )

    assert replay.created_by_request is False
    assert replay.completed is True
    assert replay.receipt.request_fingerprint_key_id == "k1"
    assert replay.receipt.response_json == {"configured": True, "secretVersionNumber": 2}
    assert SECRET_MARKER not in replay.receipt.request_fingerprint
    assert SECRET_MARKER not in json.dumps(replay.receipt.response_json)


def test_same_key_with_a_different_sensitive_payload_is_a_stable_conflict(db: Session) -> None:
    keyring = _keyring(active_key_id="k1")
    claim_operation(
        db,
        family_id="family-1",
        operation="rotate_profile_secret",
        idempotency_key="rotate-conflict",
        active_fingerprint_key_id=keyring.active_key_id,
        fingerprint_for_key_id=_fingerprint_factory(keyring),
    )

    with pytest.raises(FamilyModelOperationIdempotencyConflict):
        claim_operation(
            db,
            family_id="family-1",
            operation="rotate_profile_secret",
            idempotency_key="rotate-conflict",
            active_fingerprint_key_id=keyring.active_key_id,
            fingerprint_for_key_id=_fingerprint_factory(keyring, new_api_key="different-secret"),
        )


def test_unowned_pending_claim_is_never_reexecuted(db: Session) -> None:
    keyring = _keyring(active_key_id="k1")
    claim_operation(
        db,
        family_id="family-1",
        operation="rotate_profile_secret",
        idempotency_key="rotate-pending",
        active_fingerprint_key_id=keyring.active_key_id,
        fingerprint_for_key_id=_fingerprint_factory(keyring),
    )

    with pytest.raises(FamilyModelOperationInProgress):
        claim_operation(
            db,
            family_id="family-1",
            operation="rotate_profile_secret",
            idempotency_key="rotate-pending",
            active_fingerprint_key_id=keyring.active_key_id,
            fingerprint_for_key_id=_fingerprint_factory(keyring),
        )


def test_root_claim_rolls_back_with_the_callers_transaction(db: Session) -> None:
    """A first root write must not escape through a released SQLite savepoint."""

    keyring = _keyring(active_key_id="k1")
    claim = claim_operation(
        db,
        family_id="family-1",
        operation="rotate_profile_secret",
        idempotency_key="root-rollback",
        active_fingerprint_key_id=keyring.active_key_id,
        fingerprint_for_key_id=_fingerprint_factory(keyring),
    )
    assert claim.created_by_request is True

    db.rollback()

    assert (
        get_operation_receipt(
            db,
            family_id="family-1",
            operation="rotate_profile_secret",
            idempotency_key="root-rollback",
        )
        is None
    )


def test_replay_rejects_removing_a_key_referenced_by_a_retained_receipt(db: Session) -> None:
    first_keyring = _keyring(active_key_id="k1")
    claim = claim_operation(
        db,
        family_id="family-1",
        operation="rotate_profile_secret",
        idempotency_key="rotate-key-removal",
        active_fingerprint_key_id=first_keyring.active_key_id,
        fingerprint_for_key_id=_fingerprint_factory(first_keyring),
    )
    complete_operation(claim, result_id="secret-2", response_json={"configured": True})
    db.commit()

    unavailable_old_keyring = _keyring(active_key_id="k2", include_old=False)
    with pytest.raises(FamilyModelCredentialConfigurationError):
        validate_credential_keyring_references(db, keyring=unavailable_old_keyring)
    with pytest.raises(FamilyModelCredentialConfigurationError):
        claim_operation(
            db,
            family_id="family-1",
            operation="rotate_profile_secret",
            idempotency_key="rotate-key-removal",
            active_fingerprint_key_id=unavailable_old_keyring.active_key_id,
            fingerprint_for_key_id=_fingerprint_factory(unavailable_old_keyring),
        )
