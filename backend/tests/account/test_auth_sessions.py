from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models.auth import AuthSession
from app.models.domain import Base, User
from app.services.auth_sessions import (
    RefreshSessionInvalid,
    create_auth_session,
    decode_refresh_token,
    get_active_auth_session,
    prune_stale_user_sessions,
    revoke_all_user_sessions,
    revoke_auth_session,
    rotate_refresh_session,
)


@pytest.fixture()
def db() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    local_session = sessionmaker(bind=engine, class_=Session, expire_on_commit=False)
    with local_session() as session:
        session.add(
            User(
                id="user-a",
                username="user-a",
                display_name="User A",
                avatar_seed="User A",
                is_active=True,
            )
        )
        session.commit()
        yield session
    Base.metadata.drop_all(engine)
    engine.dispose()


def test_create_auth_session_issues_signed_generation_with_absolute_expiry(
    db: Session,
) -> None:
    now = datetime(2026, 8, 24, 3, 0, tzinfo=UTC)

    issued = create_auth_session(db, user_id="user-a", now=now)
    claims = decode_refresh_token(issued.refresh_token)

    assert isinstance(issued.session, AuthSession)
    assert claims.session_id == issued.session.id
    assert claims.generation == 1
    assert issued.session.refresh_generation == 1
    assert issued.session.expires_at == now + timedelta(days=30)


def test_refresh_rotation_accepts_one_concurrent_previous_generation(
    db: Session,
) -> None:
    now = datetime(2026, 8, 24, 3, 0, tzinfo=UTC)
    first = create_auth_session(db, user_id="user-a", now=now)

    rotated = rotate_refresh_session(db, refresh_token=first.refresh_token, now=now)
    concurrent = rotate_refresh_session(
        db,
        refresh_token=first.refresh_token,
        now=now + timedelta(seconds=5),
    )

    assert rotated.refresh_token != first.refresh_token
    assert concurrent.refresh_token == rotated.refresh_token
    assert concurrent.session.refresh_generation == 2
    assert concurrent.session.expires_at == first.session.expires_at


def test_refresh_rotation_rejects_previous_generation_outside_grace(
    db: Session,
) -> None:
    now = datetime(2026, 8, 24, 3, 0, tzinfo=UTC)
    first = create_auth_session(db, user_id="user-a", now=now)
    rotate_refresh_session(db, refresh_token=first.refresh_token, now=now)

    with pytest.raises(RefreshSessionInvalid, match="generation"):
        rotate_refresh_session(
            db,
            refresh_token=first.refresh_token,
            now=now + timedelta(seconds=11),
        )


def test_refresh_decoder_rejects_tampering() -> None:
    with pytest.raises(RefreshSessionInvalid):
        decode_refresh_token("v1.c2Vzc2lvbi1h.1.invalid-signature")


def test_current_and_all_session_revocation_are_immediate(db: Session) -> None:
    now = datetime(2026, 8, 24, 3, 0, tzinfo=UTC)
    first = create_auth_session(db, user_id="user-a", now=now)
    second = create_auth_session(db, user_id="user-a", now=now)

    assert revoke_auth_session(
        db,
        session_id=first.session.id,
        reason="logout",
        now=now,
    )
    assert get_active_auth_session(
        db,
        session_id=first.session.id,
        user_id="user-a",
        now=now,
    ) is None
    assert get_active_auth_session(
        db,
        session_id=second.session.id,
        user_id="user-a",
        now=now,
    ) is not None

    assert revoke_all_user_sessions(
        db,
        user_id="user-a",
        reason="password_changed",
        now=now,
    ) == 1
    assert get_active_auth_session(
        db,
        session_id=second.session.id,
        user_id="user-a",
        now=now,
    ) is None


def test_expired_refresh_session_cannot_rotate(db: Session) -> None:
    now = datetime(2026, 8, 24, 3, 0, tzinfo=UTC)
    issued = create_auth_session(db, user_id="user-a", now=now)

    with pytest.raises(RefreshSessionInvalid, match="expired"):
        rotate_refresh_session(
            db,
            refresh_token=issued.refresh_token,
            now=now + timedelta(days=30, seconds=1),
        )


def test_successful_login_cleanup_only_prunes_stale_sessions(db: Session) -> None:
    now = datetime(2026, 8, 24, 3, 0, tzinfo=UTC)
    expired = create_auth_session(db, user_id="user-a", now=now - timedelta(days=40))
    revoked = create_auth_session(db, user_id="user-a", now=now - timedelta(days=20))
    active = create_auth_session(db, user_id="user-a", now=now)
    revoked.session.revoked_at = now - timedelta(days=8)
    db.flush()

    assert prune_stale_user_sessions(db, user_id="user-a", now=now) == 2
    assert db.get(AuthSession, expired.session.id) is None
    assert db.get(AuthSession, revoked.session.id) is None
    assert db.get(AuthSession, active.session.id) is not None
