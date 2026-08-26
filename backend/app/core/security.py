from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import bcrypt
import jwt
from jwt import InvalidTokenError

from app.core.config import get_settings
from app.core.utils import utcnow

ALGORITHM = "HS256"
ACCESS_TOKEN_AUDIENCE = "culina-api"
ACCESS_TOKEN_ISSUER = "culina"
BCRYPT_SHA256_PREFIX = "bcrypt_sha256$"
PASSWORD_MIN_LENGTH = 8


class AccessTokenInvalid(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class AccessTokenClaims:
    user_id: str
    session_id: str
    token_id: str
    expires_at: datetime


def validate_password_strength(password: str) -> str:
    if len(password) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"Password must be at least {PASSWORD_MIN_LENGTH} characters")
    if not any(char.isalpha() for char in password) or not any(char.isdigit() for char in password):
        raise ValueError("Password must include both letters and numbers")
    return password


def _password_digest(password: str) -> bytes:
    return hashlib.sha256(password.encode("utf-8")).hexdigest().encode("ascii")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        if hashed_password.startswith(BCRYPT_SHA256_PREFIX):
            bcrypt_hash = hashed_password.removeprefix(BCRYPT_SHA256_PREFIX).encode("utf-8")
            return bcrypt.checkpw(_password_digest(plain_password), bcrypt_hash)
    except (TypeError, ValueError):
        return False
    return False


def get_password_hash(password: str) -> str:
    validate_password_strength(password)
    hashed = bcrypt.hashpw(_password_digest(password), bcrypt.gensalt(rounds=12))
    return f"{BCRYPT_SHA256_PREFIX}{hashed.decode('utf-8')}"


def create_access_token(subject: str, *, session_id: str) -> str:
    if not subject or not session_id:
        raise ValueError("Access token subject and session are required")
    settings = get_settings()
    issued_at = utcnow()
    expire = issued_at + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {
        "aud": ACCESS_TOKEN_AUDIENCE,
        "iss": ACCESS_TOKEN_ISSUER,
        "typ": "access",
        "sub": subject,
        "sid": session_id,
        "jti": f"access-{uuid4().hex}",
        "iat": issued_at,
        "exp": expire,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)


def decode_access_token(token: str) -> AccessTokenClaims:
    if not token:
        raise AccessTokenInvalid("Access token is missing")
    try:
        payload = jwt.decode(
            token,
            get_settings().jwt_secret,
            algorithms=[ALGORITHM],
            audience=ACCESS_TOKEN_AUDIENCE,
            issuer=ACCESS_TOKEN_ISSUER,
            options={
                "require": ["aud", "exp", "iat", "iss", "jti", "sid", "sub", "typ"],
            },
        )
    except InvalidTokenError as exc:
        raise AccessTokenInvalid("Access token is invalid or expired") from exc

    if payload.get("typ") != "access":
        raise AccessTokenInvalid("Access token type is invalid")
    subject = payload.get("sub")
    session_id = payload.get("sid")
    token_id = payload.get("jti")
    expires_at = payload.get("exp")
    if not all(
        isinstance(value, str) and value.strip()
        for value in (subject, session_id, token_id)
    ):
        raise AccessTokenInvalid("Access token claims are invalid")
    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
        raise AccessTokenInvalid("Access token expiry is invalid")
    return AccessTokenClaims(
        user_id=subject,
        session_id=session_id,
        token_id=token_id,
        expires_at=datetime.fromtimestamp(expires_at, tz=UTC),
    )
