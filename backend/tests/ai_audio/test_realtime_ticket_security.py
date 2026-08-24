from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.websockets import WebSocketDisconnect

from app.core.enums import MembershipStatus, UserRole
from app.core.security import create_access_token
from app.core.utils import utcnow
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Membership, User
from app.services.access_tickets import create_realtime_websocket_ticket
from app.services.ai_audio.realtime import (
    RealtimeVoiceSessionState,
    RealtimeVoiceSessionStore,
    realtime_voice_session_store,
)
from app.services.ai_audio.service import AIAudioService

class _Scope:
    async def finish_current_lease_once(self, **_kwargs):
        return SimpleNamespace(decision="ended", error_code=None)


def _state(*, ticket_id: str = "") -> RealtimeVoiceSessionState:
    state = RealtimeVoiceSessionState(
        session_id="voice-a",
        family_id="family-a",
        user_id="user-a",
        config_revision_id="revision-a",
        provider_profile_id="profile-a",
        provider_profile_version_id="profile-version-a",
        requested_model="realtime-model",
        binding_identity_checksum="checksum-a",
        adapter_kind="dashscope_realtime",
        recipe_id="recipe-a",
        cook_session_id="cook-a",
        session_revision=1,
        subject={"source": "recipe_cook_page", "extra": {"surface": "recipe_cook_page"}},
        created_at=utcnow(),
        expires_at=utcnow() + timedelta(minutes=5),
        realtime_usage_scope=_Scope(),  # type: ignore[arg-type]
    )
    if hasattr(state, "connection_ticket_id"):
        state.connection_ticket_id = ticket_id
    return state


@pytest.fixture
def realtime_client(monkeypatch):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    local_session = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    with local_session() as db:
        db.add_all(
            [
                Family(id="family-a", name="家庭 A", motto="", location=""),
                User(
                    id="user-a",
                    username="voice-a",
                    display_name="Voice A",
                    avatar_seed="",
                    is_active=True,
                ),
                Membership(
                    id="membership-a",
                    family_id="family-a",
                    user_id="user-a",
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
            ]
        )
        db.commit()

    def override_db():
        with local_session() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    monkeypatch.setattr(
        AIAudioService,
        "realtime_runtime_for_session",
        lambda _self, _session: object(),
    )
    realtime_voice_session_store.clear()
    yield TestClient(app)
    realtime_voice_session_store.clear()
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_access_token_query_is_rejected_by_realtime_websocket(realtime_client: TestClient) -> None:
    realtime_voice_session_store.put(_state())
    access_token = create_access_token("user-a")

    with pytest.raises(WebSocketDisconnect) as exc_info:
        with realtime_client.websocket_connect(
            f"/api/ai/realtime/cooking/sessions/voice-a/ws?token={access_token}"
        ) as websocket:
            websocket.receive_json()

    assert exc_info.value.code == 4401


def test_short_lived_subprotocol_ticket_connects_and_replay_is_rejected(
    realtime_client: TestClient,
) -> None:
    encoded = create_realtime_websocket_ticket(
        session_id="voice-a",
        family_id="family-a",
        user_id="user-a",
    )
    realtime_voice_session_store.put(_state(ticket_id=encoded.ticket_id))
    protocols = ["culina-realtime", f"culina-ticket.{encoded.token}"]
    path = "/api/ai/realtime/cooking/sessions/voice-a/ws"

    with realtime_client.websocket_connect(path, subprotocols=protocols) as first:
        assert first.accepted_subprotocol == "culina-realtime"
        assert first.receive_json()["status"] == "listening"
        with pytest.raises(WebSocketDisconnect) as replay:
            with realtime_client.websocket_connect(path, subprotocols=protocols) as second:
                second.receive_json()
        assert replay.value.code == 4401
        first.send_json({"type": "hangup"})
        assert first.receive_json()["status"] == "closed"


def test_connection_ticket_store_is_family_bound_and_single_use() -> None:
    store = RealtimeVoiceSessionStore()
    store.put(_state(ticket_id="ticket-a"))

    with pytest.raises(HTTPException) as other_family:
        store.consume_connection_ticket(
            "voice-a",
            family_id="family-b",
            user_id="user-a",
            ticket_id="ticket-a",
        )
    assert other_family.value.status_code == 403

    assert store.consume_connection_ticket(
        "voice-a",
        family_id="family-a",
        user_id="user-a",
        ticket_id="ticket-a",
    ).session_id == "voice-a"

    with pytest.raises(HTTPException) as replay:
        store.consume_connection_ticket(
            "voice-a",
            family_id="family-a",
            user_id="user-a",
            ticket_id="ticket-a",
        )
    assert replay.value.status_code == 401
