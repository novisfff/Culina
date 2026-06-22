from __future__ import annotations

import pytest

from app.core.security import BCRYPT_SHA256_PREFIX, get_password_hash, verify_password


def test_password_hash_uses_bcrypt_sha256_strategy() -> None:
    hashed = get_password_hash("Culina123!")

    assert hashed.startswith(BCRYPT_SHA256_PREFIX)
    assert verify_password("Culina123!", hashed)
    assert not verify_password("wrong-password", hashed)


def test_password_hash_rejects_weak_passwords() -> None:
    with pytest.raises(ValueError):
        get_password_hash("short1")

    with pytest.raises(ValueError):
        get_password_hash("passwordonly")


def test_verify_password_rejects_non_current_hash_formats() -> None:
    pbkdf2_hash = "$pbkdf2-sha256$29000$SEmptRaC0JozpnQuBWAsZQ$W65J7xkTYV8CZFHMwEqiRz5wkA8L4pYchkQjzKo8l5k"
    assert not verify_password("Culina123!", pbkdf2_hash)


def test_verify_password_treats_malformed_hash_as_invalid() -> None:
    assert not verify_password("Culina123!", f"{BCRYPT_SHA256_PREFIX}not-a-bcrypt-hash")
