from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import hashlib
import hmac

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.utils import utcnow
from app.models.auth import AuthSession

REFRESH_TOKEN_VERSION = "v1"
REFRESH_KEY_CONTEXT = b"culina-refresh-token-v1"


class RefreshSessionInvalid(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class RefreshTokenClaims:
    session_id: str
    generation: int


@dataclass(frozen=True, slots=True)
class IssuedAuthSession:
    session: AuthSession
    refresh_token: str


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    try:
        return base64.b64decode(
            value + "=" * (-len(value) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, TypeError) as exc:
        raise RefreshSessionInvalid("Refresh token encoding is invalid") from exc


def _refresh_signing_key() -> bytes:
    root_key = get_settings().jwt_secret.encode("utf-8")
    return hmac.new(root_key, REFRESH_KEY_CONTEXT, hashlib.sha256).digest()


def _refresh_token_payload(session_id: str, generation: int) -> str:
    encoded_session_id = _base64url_encode(session_id.encode("utf-8"))
    return f"{REFRESH_TOKEN_VERSION}.{encoded_session_id}.{generation}"


def encode_refresh_token(*, session_id: str, generation: int) -> str:
    if not session_id or generation < 1:
        raise ValueError("Refresh token scope is invalid")
    payload = _refresh_token_payload(session_id, generation)
    signature = hmac.new(
        _refresh_signing_key(),
        payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{payload}.{_base64url_encode(signature)}"


def decode_refresh_token(token: str) -> RefreshTokenClaims:
    parts = token.split(".") if token else []
    if len(parts) != 4 or parts[0] != REFRESH_TOKEN_VERSION:
        raise RefreshSessionInvalid("Refresh token format is invalid")
    payload = ".".join(parts[:3])
    supplied_signature = _base64url_decode(parts[3])
    expected_signature = hmac.new(
        _refresh_signing_key(),
        payload.encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(supplied_signature, expected_signature):
        raise RefreshSessionInvalid("Refresh token signature is invalid")
    try:
        session_id = _base64url_decode(parts[1]).decode("utf-8")
        generation = int(parts[2])
    except (UnicodeDecodeError, ValueError) as exc:
        raise RefreshSessionInvalid("Refresh token claims are invalid") from exc
    if not session_id or generation < 1:
        raise RefreshSessionInvalid("Refresh token claims are invalid")
    return RefreshTokenClaims(session_id=session_id, generation=generation)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def create_auth_session(
    db: Session,
    *,
    user_id: str,
    now: datetime | None = None,
) -> IssuedAuthSession:
    issued_at = _as_utc(now or utcnow())
    auth_session = AuthSession(
        user_id=user_id,
        refresh_generation=1,
        expires_at=issued_at
        + timedelta(days=get_settings().refresh_session_expire_days),
        last_rotated_at=issued_at,
        last_used_at=issued_at,
        created_at=issued_at,
    )
    db.add(auth_session)
    db.flush()
    return IssuedAuthSession(
        session=auth_session,
        refresh_token=encode_refresh_token(
            session_id=auth_session.id,
            generation=auth_session.refresh_generation,
        ),
    )


def rotate_refresh_session(
    db: Session,
    *,
    refresh_token: str,
    now: datetime | None = None,
) -> IssuedAuthSession:
    claims = decode_refresh_token(refresh_token)
    refreshed_at = _as_utc(now or utcnow())
    auth_session = db.scalar(
        select(AuthSession)
        .where(AuthSession.id == claims.session_id)
        .with_for_update()
    )
    if auth_session is None or auth_session.revoked_at is not None:
        raise RefreshSessionInvalid("Refresh session is revoked or missing")
    if _as_utc(auth_session.expires_at) <= refreshed_at:
        raise RefreshSessionInvalid("Refresh session is expired")

    current_generation = auth_session.refresh_generation
    if claims.generation == current_generation:
        auth_session.refresh_generation += 1
        auth_session.last_rotated_at = refreshed_at
    elif claims.generation == current_generation - 1:
        grace_deadline = _as_utc(auth_session.last_rotated_at) + timedelta(
            seconds=get_settings().refresh_rotation_grace_seconds
        )
        if refreshed_at > grace_deadline:
            raise RefreshSessionInvalid("Refresh token generation is stale")
    else:
        raise RefreshSessionInvalid("Refresh token generation is invalid")

    auth_session.last_used_at = refreshed_at
    db.flush()
    return IssuedAuthSession(
        session=auth_session,
        refresh_token=encode_refresh_token(
            session_id=auth_session.id,
            generation=auth_session.refresh_generation,
        ),
    )


def get_active_auth_session(
    db: Session,
    *,
    session_id: str,
    user_id: str,
    now: datetime | None = None,
) -> AuthSession | None:
    checked_at = _as_utc(now or utcnow())
    auth_session = db.scalar(
        select(AuthSession).where(
            AuthSession.id == session_id,
            AuthSession.user_id == user_id,
            AuthSession.revoked_at.is_(None),
        )
    )
    if auth_session is None or _as_utc(auth_session.expires_at) <= checked_at:
        return None
    return auth_session


def revoke_auth_session(
    db: Session,
    *,
    session_id: str,
    reason: str,
    now: datetime | None = None,
) -> bool:
    auth_session = db.scalar(
        select(AuthSession)
        .where(AuthSession.id == session_id)
        .with_for_update()
    )
    if auth_session is None or auth_session.revoked_at is not None:
        return False
    auth_session.revoked_at = _as_utc(now or utcnow())
    auth_session.revoke_reason = reason
    db.flush()
    return True


def revoke_all_user_sessions(
    db: Session,
    *,
    user_id: str,
    reason: str,
    now: datetime | None = None,
) -> int:
    revoked_at = _as_utc(now or utcnow())
    auth_sessions = list(
        db.scalars(
            select(AuthSession)
            .where(
                AuthSession.user_id == user_id,
                AuthSession.revoked_at.is_(None),
            )
            .order_by(AuthSession.id.asc())
            .with_for_update()
        )
    )
    for auth_session in auth_sessions:
        auth_session.revoked_at = revoked_at
        auth_session.revoke_reason = reason
    db.flush()
    return len(auth_sessions)


def prune_stale_user_sessions(
    db: Session,
    *,
    user_id: str,
    now: datetime | None = None,
    retention_days: int = 7,
) -> int:
    checked_at = _as_utc(now or utcnow())
    cutoff = checked_at - timedelta(days=retention_days)
    result = db.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user_id,
            or_(
                AuthSession.expires_at < cutoff,
                and_(
                    AuthSession.revoked_at.is_not(None),
                    AuthSession.revoked_at < cutoff,
                ),
            ),
        )
    )
    db.flush()
    return int(result.rowcount or 0)
