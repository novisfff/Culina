from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import os
from threading import Barrier, Event, Lock
from typing import Iterator

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

import app.api.auth as auth_routes
from app.core.enums import MembershipStatus, UserRole
from app.core.security import get_password_hash, verify_password
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Membership, User, UserCredential


LOCAL_ORIGIN = "http://localhost:5173"


def _mysql_url() -> str:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not (url.database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return value


@dataclass(frozen=True, slots=True)
class AuthMysqlContext:
    session_factory: sessionmaker[Session]

    def client(self) -> TestClient:
        return TestClient(app)


@pytest.fixture()
def auth_mysql() -> Iterator[AuthMysqlContext]:
    engine = create_engine(
        _mysql_url(),
        poolclass=NullPool,
        pool_pre_ping=True,
        future=True,
    )
    Base.metadata.drop_all(engine)
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
        family = Family(id="family-auth-mysql", name="认证并发家庭", motto="", location="")
        user = User(
            id="user-auth-mysql",
            username="auth-concurrency-owner",
            display_name="认证并发用户",
            avatar_seed="auth-concurrency-owner",
            is_active=True,
        )
        db.add_all(
            [
                family,
                user,
                Membership(
                    id="membership-auth-mysql",
                    family_id=family.id,
                    user_id=user.id,
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                UserCredential(
                    id="credential-auth-mysql",
                    user_id=user.id,
                    password_hash=get_password_hash("OldPass123"),
                ),
            ]
        )
        db.commit()

    def override_db() -> Iterator[Session]:
        with local_session() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    try:
        yield AuthMysqlContext(session_factory=local_session)
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def _login(client: TestClient, password: str) -> object:
    return client.post(
        "/api/auth/login",
        headers={"Origin": LOCAL_ORIGIN},
        json={"username": "auth-concurrency-owner", "password": password},
    )


def _bearer(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def test_old_password_login_cannot_create_session_after_password_revocation(
    auth_mysql: AuthMysqlContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    password_client = auth_mysql.client()
    password_login = _login(password_client, "OldPass123")
    assert password_login.status_code == 200
    access_token = password_login.json()["access_token"]

    login_read = Event()
    release_login = Event()
    call_lock = Lock()
    call_count = 0
    original_get_credential = auth_routes.get_user_credential

    def pause_first_credential_read(db: Session, user_id: str) -> UserCredential | None:
        nonlocal call_count
        credential = original_get_credential(db, user_id)
        with call_lock:
            call_count += 1
            should_pause = call_count == 1
        if should_pause:
            login_read.set()
            assert release_login.wait(timeout=20), "timed out releasing paused login"
        return credential

    monkeypatch.setattr(auth_routes, "get_user_credential", pause_first_credential_read)
    racing_client = auth_mysql.client()
    with ThreadPoolExecutor(max_workers=1) as pool:
        login_future = pool.submit(_login, racing_client, "OldPass123")
        assert login_read.wait(timeout=20), "login did not reach credential read"

        password_response = password_client.patch(
            "/api/auth/password",
            headers={"Origin": LOCAL_ORIGIN, **_bearer(access_token)},
            json={"current_password": "OldPass123", "new_password": "VictimPass456"},
        )
        assert password_response.status_code == 204, password_response.text
        release_login.set()
        racing_login = login_future.result(timeout=20)

    assert racing_login.status_code == 401
    assert _login(auth_mysql.client(), "OldPass123").status_code == 401
    assert _login(auth_mysql.client(), "VictimPass456").status_code == 200


def test_two_concurrent_password_changes_cannot_both_accept_the_old_password(
    auth_mysql: AuthMysqlContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_client = auth_mysql.client()
    second_client = auth_mysql.client()
    first_login = _login(first_client, "OldPass123")
    second_login = _login(second_client, "OldPass123")
    assert first_login.status_code == 200
    assert second_login.status_code == 200

    verify_barrier = Barrier(2, timeout=20)

    def synchronized_verify(plain_password: str, hashed_password: str) -> bool:
        result = verify_password(plain_password, hashed_password)
        verify_barrier.wait(timeout=20)
        return result

    monkeypatch.setattr(
        auth_routes,
        "verify_password",
        synchronized_verify,
        raising=False,
    )

    def change_password(client: TestClient, access_token: str, new_password: str) -> object:
        return client.patch(
            "/api/auth/password",
            headers={"Origin": LOCAL_ORIGIN, **_bearer(access_token)},
            json={"current_password": "OldPass123", "new_password": new_password},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(
            change_password,
            first_client,
            first_login.json()["access_token"],
            "FirstPass456",
        )
        second_future = pool.submit(
            change_password,
            second_client,
            second_login.json()["access_token"],
            "SecondPass456",
        )
        responses = [first_future.result(timeout=30), second_future.result(timeout=30)]

    assert sorted(response.status_code for response in responses) == [204, 400]
    successful_password = (
        "FirstPass456" if responses[0].status_code == 204 else "SecondPass456"
    )
    rejected_password = (
        "SecondPass456" if successful_password == "FirstPass456" else "FirstPass456"
    )
    assert _login(auth_mysql.client(), successful_password).status_code == 200
    assert _login(auth_mysql.client(), rejected_password).status_code == 401
