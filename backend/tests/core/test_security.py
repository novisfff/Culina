from __future__ import annotations

from datetime import timedelta

import jwt
import pytest

from app.core.config import get_settings
from app.core.security import (
    ALGORITHM,
    AccessTokenInvalid,
    BCRYPT_SHA256_PREFIX,
    create_access_token,
    decode_access_token,
    get_password_hash,
    verify_password,
)
from app.core.utils import utcnow


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


def test_access_token_is_short_lived_and_bound_to_a_server_session() -> None:
    before = utcnow()

    token = create_access_token("user-a", session_id="session-a")
    claims = decode_access_token(token)

    assert claims.user_id == "user-a"
    assert claims.session_id == "session-a"
    assert claims.token_id.startswith("access-")
    assert timedelta(minutes=14, seconds=59) <= claims.expires_at - before <= timedelta(minutes=15, seconds=1)


def test_access_token_decoder_rejects_legacy_tokens_without_session_claims() -> None:
    settings = get_settings()
    legacy_token = jwt.encode(
        {"sub": "user-a", "exp": utcnow() + timedelta(minutes=15)},
        settings.jwt_secret,
        algorithm=ALGORITHM,
    )

    with pytest.raises(AccessTokenInvalid):
        decode_access_token(legacy_token)
