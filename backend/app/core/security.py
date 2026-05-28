from __future__ import annotations

import hashlib
from datetime import timedelta

import bcrypt
from jose import jwt

from app.core.config import get_settings
from app.core.utils import utcnow

ALGORITHM = "HS256"
BCRYPT_SHA256_PREFIX = "bcrypt_sha256$"
PASSWORD_MIN_LENGTH = 8


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
        if hashed_password.startswith("$pbkdf2-sha256$"):
            from passlib.hash import pbkdf2_sha256

            return pbkdf2_sha256.verify(plain_password, hashed_password)
    except (TypeError, ValueError):
        return False
    return False


def get_password_hash(password: str) -> str:
    validate_password_strength(password)
    hashed = bcrypt.hashpw(_password_digest(password), bcrypt.gensalt(rounds=12))
    return f"{BCRYPT_SHA256_PREFIX}{hashed.decode('utf-8')}"


def create_access_token(subject: str) -> str:
    settings = get_settings()
    expire = utcnow() + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)
