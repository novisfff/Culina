from __future__ import annotations

import importlib
from datetime import timedelta
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import jwt
import pytest

from app.core.utils import utcnow

def _ticket_module() -> ModuleType:
    try:
        return importlib.import_module("app.services.access_tickets")
    except ModuleNotFoundError:
        pytest.fail("access ticket service is missing")


def _settings():
    return SimpleNamespace(
        jwt_secret="ticket-test-secret-with-at-least-32-bytes",
        media_access_url_ttl_seconds=300,
        realtime_websocket_ticket_ttl_seconds=45,
    )


def test_media_access_ticket_round_trips_scoped_claims() -> None:
    tickets = _ticket_module()
    with patch.object(tickets, "get_settings", return_value=_settings()):
        encoded = tickets.create_media_access_ticket(
            media_id="photo-a",
            family_id="family-a",
            variant="card",
        )
        claims = tickets.decode_media_access_ticket(encoded.token)

    assert claims.media_id == "photo-a"
    assert claims.family_id == "family-a"
    assert claims.variant == "card"
    assert claims.ticket_id == encoded.ticket_id
    assert 295 <= (encoded.expires_at - utcnow()).total_seconds() <= 300


def test_media_ticket_is_rejected_by_realtime_decoder() -> None:
    tickets = _ticket_module()
    with patch.object(tickets, "get_settings", return_value=_settings()):
        encoded = tickets.create_media_access_ticket(
            media_id="photo-a",
            family_id="family-a",
            variant="original",
        )
        with pytest.raises(tickets.AccessTicketInvalid):
            tickets.decode_realtime_websocket_ticket(encoded.token)


def test_realtime_ticket_round_trips_user_family_and_session_claims() -> None:
    tickets = _ticket_module()
    with patch.object(tickets, "get_settings", return_value=_settings()):
        encoded = tickets.create_realtime_websocket_ticket(
            session_id="voice-a",
            family_id="family-a",
            user_id="user-a",
        )
        claims = tickets.decode_realtime_websocket_ticket(encoded.token)

    assert (claims.session_id, claims.family_id, claims.user_id) == (
        "voice-a",
        "family-a",
        "user-a",
    )
    assert claims.ticket_id == encoded.ticket_id
    assert 40 <= (encoded.expires_at - utcnow()).total_seconds() <= 45


def test_expired_realtime_ticket_is_rejected() -> None:
    tickets = _ticket_module()
    now = utcnow()
    token = jwt.encode(
        {
            "aud": tickets.REALTIME_WEBSOCKET_AUDIENCE,
            "typ": "realtime_websocket",
            "sub": "user-a",
            "family_id": "family-a",
            "session_id": "voice-a",
            "jti": "voice-ticket-a",
            "iat": now - timedelta(minutes=2),
            "exp": now - timedelta(seconds=1),
        },
        _settings().jwt_secret,
        algorithm="HS256",
    )

    with patch.object(tickets, "get_settings", return_value=_settings()):
        with pytest.raises(tickets.AccessTicketInvalid):
            tickets.decode_realtime_websocket_ticket(token)
