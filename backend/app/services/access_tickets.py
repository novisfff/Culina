from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, cast
from uuid import uuid4

from jose import JWTError, jwt

from app.core.config import get_settings
from app.core.utils import utcnow

ALGORITHM = "HS256"
MEDIA_ACCESS_AUDIENCE = "culina-media-access"
REALTIME_WEBSOCKET_AUDIENCE = "culina-realtime-websocket"
MediaVariantName = Literal["original", "thumb", "card", "large"]
MEDIA_VARIANTS = frozenset({"original", "thumb", "card", "large"})


class AccessTicketInvalid(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class EncodedTicket:
    token: str
    expires_at: datetime
    ticket_id: str


@dataclass(frozen=True, slots=True)
class MediaAccessClaims:
    media_id: str
    family_id: str
    variant: MediaVariantName
    ticket_id: str
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class RealtimeTicketClaims:
    session_id: str
    family_id: str
    user_id: str
    ticket_id: str
    expires_at: datetime


def _required_string(payload: dict, key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise AccessTicketInvalid("Access ticket claim is invalid")
    return value


def _expires_at(payload: dict) -> datetime:
    value = payload.get("exp")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AccessTicketInvalid("Access ticket expiry is invalid")
    return datetime.fromtimestamp(value, tz=UTC)


def _decode(token: str, *, audience: str, ticket_type: str) -> dict:
    if not token:
        raise AccessTicketInvalid("Access ticket is missing")
    try:
        payload = jwt.decode(
            token,
            get_settings().jwt_secret,
            algorithms=[ALGORITHM],
            audience=audience,
            options={
                "require_aud": True,
                "require_exp": True,
                "require_iat": True,
                "require_sub": ticket_type == "realtime_websocket",
            },
        )
    except JWTError as exc:
        raise AccessTicketInvalid("Access ticket is invalid or expired") from exc
    if payload.get("typ") != ticket_type:
        raise AccessTicketInvalid("Access ticket type is invalid")
    return payload


def create_media_access_ticket(
    *,
    media_id: str,
    family_id: str,
    variant: MediaVariantName,
) -> EncodedTicket:
    if not media_id or not family_id or variant not in MEDIA_VARIANTS:
        raise ValueError("Media access ticket scope is invalid")
    settings = get_settings()
    issued_at = utcnow()
    expires_at = issued_at + timedelta(seconds=settings.media_access_url_ttl_seconds)
    ticket_id = f"media_ticket-{uuid4().hex}"
    token = jwt.encode(
        {
            "aud": MEDIA_ACCESS_AUDIENCE,
            "typ": "media_access",
            "media_id": media_id,
            "family_id": family_id,
            "variant": variant,
            "jti": ticket_id,
            "iat": issued_at,
            "exp": expires_at,
        },
        settings.jwt_secret,
        algorithm=ALGORITHM,
    )
    return EncodedTicket(token=token, expires_at=expires_at, ticket_id=ticket_id)


def decode_media_access_ticket(token: str) -> MediaAccessClaims:
    payload = _decode(
        token,
        audience=MEDIA_ACCESS_AUDIENCE,
        ticket_type="media_access",
    )
    variant = _required_string(payload, "variant")
    if variant not in MEDIA_VARIANTS:
        raise AccessTicketInvalid("Media access ticket variant is invalid")
    return MediaAccessClaims(
        media_id=_required_string(payload, "media_id"),
        family_id=_required_string(payload, "family_id"),
        variant=cast(MediaVariantName, variant),
        ticket_id=_required_string(payload, "jti"),
        expires_at=_expires_at(payload),
    )


def create_realtime_websocket_ticket(
    *,
    session_id: str,
    family_id: str,
    user_id: str,
) -> EncodedTicket:
    if not session_id or not family_id or not user_id:
        raise ValueError("Realtime ticket scope is invalid")
    settings = get_settings()
    issued_at = utcnow()
    expires_at = issued_at + timedelta(
        seconds=settings.realtime_websocket_ticket_ttl_seconds
    )
    ticket_id = f"voice_ticket-{uuid4().hex}"
    token = jwt.encode(
        {
            "aud": REALTIME_WEBSOCKET_AUDIENCE,
            "typ": "realtime_websocket",
            "sub": user_id,
            "family_id": family_id,
            "session_id": session_id,
            "jti": ticket_id,
            "iat": issued_at,
            "exp": expires_at,
        },
        settings.jwt_secret,
        algorithm=ALGORITHM,
    )
    return EncodedTicket(token=token, expires_at=expires_at, ticket_id=ticket_id)


def decode_realtime_websocket_ticket(token: str) -> RealtimeTicketClaims:
    payload = _decode(
        token,
        audience=REALTIME_WEBSOCKET_AUDIENCE,
        ticket_type="realtime_websocket",
    )
    return RealtimeTicketClaims(
        session_id=_required_string(payload, "session_id"),
        family_id=_required_string(payload, "family_id"),
        user_id=_required_string(payload, "sub"),
        ticket_id=_required_string(payload, "jti"),
        expires_at=_expires_at(payload),
    )
