from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.enums import MembershipStatus, UserRole
from app.core.security import decode_access_token, get_password_hash
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Membership, User, UserCredential

LOCAL_ORIGIN = "http://localhost:5173"
PRODUCTION_ORIGIN = "https://culina.example.com"
REFRESH_COOKIE_NAME = "culina-refresh"


@dataclass(frozen=True)
class AuthApiContext:
    session_factory: sessionmaker[Session]

    def client(self) -> TestClient:
        return TestClient(app)


@pytest.fixture()
def auth_api() -> Iterator[AuthApiContext]:
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
        family = Family(id="family-a", name="测试家庭", motto="", location="")
        user = User(
            id="user-a",
            username="owner",
            display_name="Owner",
            avatar_seed="Owner",
            is_active=True,
        )
        db.add_all(
            [
                family,
                user,
                Membership(
                    id="membership-a",
                    family_id=family.id,
                    user_id=user.id,
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                UserCredential(
                    id="credential-a",
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
    yield AuthApiContext(session_factory=local_session)
    app.dependency_overrides.clear()
    Base.metadata.drop_all(engine)
    engine.dispose()


def login(client: TestClient, *, origin: str = LOCAL_ORIGIN) -> tuple[str, object]:
    response = client.post(
        "/api/auth/login",
        headers={"Origin": origin},
        json={"username": "owner", "password": "OldPass123"},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"], response


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_login_sets_http_only_strict_cookie_and_me_does_not_mint_token(
    auth_api: AuthApiContext,
) -> None:
    client = auth_api.client()

    token, response = login(client)
    set_cookie = response.headers["set-cookie"].lower()
    claims = decode_access_token(token)

    assert claims.user_id == "user-a"
    assert REFRESH_COOKIE_NAME in client.cookies
    assert "httponly" in set_cookie
    assert "samesite=strict" in set_cookie
    assert "path=/api/auth" in set_cookie
    assert "secure" not in set_cookie

    me_response = client.get("/api/auth/me", headers=bearer(token))
    assert me_response.status_code == 200
    assert "access_token" not in me_response.json()
    assert me_response.json()["user"]["id"] == "user-a"


def test_production_login_cookie_is_secure(auth_api: AuthApiContext) -> None:
    client = auth_api.client()
    production_settings = SimpleNamespace(
        environment="production",
        frontend_origin=PRODUCTION_ORIGIN,
    )

    with patch("app.api.auth.get_settings", return_value=production_settings):
        _, response = login(client, origin=PRODUCTION_ORIGIN)

    assert "secure" in response.headers["set-cookie"].lower()


def test_refresh_rotates_cookie_and_preserves_session_binding(
    auth_api: AuthApiContext,
) -> None:
    client = auth_api.client()
    first_access, _ = login(client)
    first_refresh = client.cookies.get(REFRESH_COOKIE_NAME)

    response = client.post("/api/auth/refresh", headers={"Origin": LOCAL_ORIGIN})

    assert response.status_code == 200, response.text
    second_access = response.json()["access_token"]
    second_refresh = client.cookies.get(REFRESH_COOKIE_NAME)
    assert second_refresh != first_refresh
    assert decode_access_token(second_access).session_id == decode_access_token(first_access).session_id


def test_logout_revokes_only_the_current_browser_session(
    auth_api: AuthApiContext,
) -> None:
    first_client = auth_api.client()
    second_client = auth_api.client()
    first_access, _ = login(first_client)
    second_access, _ = login(second_client)

    response = first_client.post(
        "/api/auth/logout",
        headers={"Origin": LOCAL_ORIGIN},
    )

    assert response.status_code == 204
    assert REFRESH_COOKIE_NAME not in first_client.cookies
    assert first_client.get("/api/auth/me", headers=bearer(first_access)).status_code == 401
    assert second_client.get("/api/auth/me", headers=bearer(second_access)).status_code == 200


def test_logout_uses_bearer_session_when_refresh_cookie_is_missing(
    auth_api: AuthApiContext,
) -> None:
    client = auth_api.client()
    access_token, _ = login(client)
    client.cookies.delete(REFRESH_COOKIE_NAME)

    response = client.post(
        "/api/auth/logout",
        headers={"Origin": LOCAL_ORIGIN, **bearer(access_token)},
    )

    assert response.status_code == 204
    assert REFRESH_COOKIE_NAME not in client.cookies
    assert client.get("/api/auth/me", headers=bearer(access_token)).status_code == 401


def test_failed_refresh_does_not_delete_a_possibly_newer_shared_cookie(
    auth_api: AuthApiContext,
) -> None:
    client = auth_api.client()
    client.cookies.set(REFRESH_COOKIE_NAME, "invalid-refresh-token")

    response = client.post(
        "/api/auth/refresh",
        headers={"Origin": LOCAL_ORIGIN},
    )

    assert response.status_code == 401
    assert "set-cookie" not in response.headers


def test_password_change_revokes_every_session_and_requires_new_password(
    auth_api: AuthApiContext,
) -> None:
    first_client = auth_api.client()
    second_client = auth_api.client()
    first_access, _ = login(first_client)
    second_access, _ = login(second_client)

    response = first_client.patch(
        "/api/auth/password",
        headers={"Origin": LOCAL_ORIGIN, **bearer(first_access)},
        json={"current_password": "OldPass123", "new_password": "NewPass123"},
    )

    assert response.status_code == 204, response.text
    assert REFRESH_COOKIE_NAME not in first_client.cookies
    assert first_client.get("/api/auth/me", headers=bearer(first_access)).status_code == 401
    assert second_client.get("/api/auth/me", headers=bearer(second_access)).status_code == 401
    assert second_client.post("/api/auth/refresh", headers={"Origin": LOCAL_ORIGIN}).status_code == 401
    assert first_client.post(
        "/api/auth/login",
        headers={"Origin": LOCAL_ORIGIN},
        json={"username": "owner", "password": "OldPass123"},
    ).status_code == 401
    assert first_client.post(
        "/api/auth/login",
        headers={"Origin": LOCAL_ORIGIN},
        json={"username": "owner", "password": "NewPass123"},
    ).status_code == 200


@pytest.mark.parametrize("disabled_boundary", ["user", "membership"])
def test_disabled_identity_rejects_access_and_refresh_immediately(
    auth_api: AuthApiContext,
    disabled_boundary: str,
) -> None:
    client = auth_api.client()
    access_token, _ = login(client)
    with auth_api.session_factory() as db:
        if disabled_boundary == "user":
            user = db.get(User, "user-a")
            assert user is not None
            user.is_active = False
        else:
            membership = db.get(Membership, "membership-a")
            assert membership is not None
            membership.status = MembershipStatus.INVITED
        db.commit()

    assert client.get("/api/auth/me", headers=bearer(access_token)).status_code == 401
    refresh_response = client.post(
        "/api/auth/refresh",
        headers={"Origin": LOCAL_ORIGIN},
    )
    assert refresh_response.status_code == 401
    assert "set-cookie" not in refresh_response.headers


@pytest.mark.parametrize("origin", [None, "https://attacker.example"])
def test_login_rejects_missing_or_untrusted_origin(
    auth_api: AuthApiContext,
    origin: str | None,
) -> None:
    client = auth_api.client()
    headers = {"Origin": origin} if origin else {}

    response = client.post(
        "/api/auth/login",
        headers=headers,
        json={"username": "owner", "password": "OldPass123"},
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "auth_origin_not_allowed"
