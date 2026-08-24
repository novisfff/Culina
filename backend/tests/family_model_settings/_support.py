from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Iterator

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api import family_model_settings as family_model_settings_api
from app.core.deps import get_current_auth
from app.core.enums import MembershipStatus, UserRole
from app.core.security import get_password_hash
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Membership, User, UserCredential
from app.models.family_model_settings import FamilyModelSettings
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    decode_family_model_credential_keyring,
)
from app.services.family_model_settings.capability_tests import CapabilityTestDependencies
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.transport import ProviderResponse
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.receipts import ProviderUsageReceiptSigner


SECRET_MARKER = "sk-family-model-secret-marker"
_OWNER_PASSWORD_HASH = get_password_hash("OwnerPass123")
_MEMBER_PASSWORD_HASH = get_password_hash("MemberPass123")


@dataclass(slots=True)
class StaticResolver:
    addresses: tuple[str, ...] = ("93.184.216.34",)

    def resolve_all(self, host: str) -> tuple[str, ...]:
        del host
        return self.addresses


@dataclass(slots=True)
class FakeTransport:
    responses: list[ProviderResponse] = field(default_factory=list)
    calls: list[tuple[str, str, dict[str, str], object | None]] = field(default_factory=list)
    websocket_calls: list[tuple[str, dict[str, str]]] = field(default_factory=list)

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        json: object | None = None,
        body: bytes | None = None,
    ) -> ProviderResponse:
        if json is not None and body is not None:
            raise AssertionError("fake transport received both json and body")
        self.calls.append((method, url, dict(headers), json))
        if self.responses:
            return self.responses.pop(0)
        return ProviderResponse(status_code=200, headers={}, content=b'{"data": []}')

    def connect_websocket(self, url: str, *, headers: dict[str, str]):
        self.websocket_calls.append((url, dict(headers)))

        class _Socket:
            def __init__(self) -> None:
                self.messages: list[str] = []
                self.closed = False

            def send(self, payload: str) -> None:
                self.messages.append(payload)

            def close(self) -> None:
                self.closed = True

        return _Socket()


@dataclass(slots=True)
class FamilyModelApiContext:
    client: TestClient
    session_factory: sessionmaker[Session]
    cipher: FamilyModelCredentialCipher
    policy: ProviderNetworkPolicy
    transport: FakeTransport
    auth_state: SimpleNamespace

    @property
    def owner_headers(self) -> dict[str, str]:
        return {}

    @property
    def member_headers(self) -> dict[str, str]:
        return {}

    def use_owner(self, family_id: str = "family-a") -> None:
        self.auth_state.family_id = family_id
        self.auth_state.user_id = "owner-a" if family_id == "family-a" else "owner-b"
        self.auth_state.membership_id = (
            "membership-owner-a" if family_id == "family-a" else "membership-owner-b"
        )

    def use_member(self) -> None:
        self.auth_state.family_id = "family-a"
        self.auth_state.user_id = "member-a"
        self.auth_state.membership_id = "membership-member-a"

    def create_profile(self, **overrides: object) -> dict[str, object]:
        payload: dict[str, object] = {
            "display_name": "家庭 OpenAI",
            "adapter_kind": "openai_compatible_http",
            "auth_mode": "api_key",
            "api_base_url": "https://provider.example/v1",
            "api_key": SECRET_MARKER,
            "idempotency_key": "profile-create-1",
        }
        payload.update(overrides)
        response = self.client.post(
            "/api/family/model-settings/provider-profiles",
            headers=self.owner_headers,
            json=payload,
        )
        assert response.status_code == 201, response.text
        return response.json()


def make_cipher() -> FamilyModelCredentialCipher:
    keyring = decode_family_model_credential_keyring(
        active_key_id="test-key",
        keys_json=SecretStr(
            json.dumps(
                {"test-key": base64.b64encode(b"t" * 32).decode("ascii")}
            )
        ),
    )
    return FamilyModelCredentialCipher(keyring)


@pytest.fixture()
def family_model_api() -> Iterator[FamilyModelApiContext]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    with SessionLocal() as db:
        db.add_all(
            [
                Family(id="family-a", name="家庭 A", motto="", location=""),
                Family(id="family-b", name="家庭 B", motto="", location=""),
                User(
                    id="owner-a",
                    username="owner-a",
                    display_name="Owner A",
                    avatar_seed="owner-a",
                ),
                User(
                    id="owner-b",
                    username="owner-b",
                    display_name="Owner B",
                    avatar_seed="owner-b",
                ),
                User(
                    id="member-a",
                    username="member-a",
                    display_name="Member A",
                    avatar_seed="member-a",
                ),
                UserCredential(
                    id="credential-owner-a",
                    user_id="owner-a",
                    password_hash=_OWNER_PASSWORD_HASH,
                ),
                UserCredential(
                    id="credential-owner-b",
                    user_id="owner-b",
                    password_hash=_OWNER_PASSWORD_HASH,
                ),
                UserCredential(
                    id="credential-member-a",
                    user_id="member-a",
                    password_hash=_MEMBER_PASSWORD_HASH,
                ),
                Membership(
                    id="membership-owner-a",
                    family_id="family-a",
                    user_id="owner-a",
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                Membership(
                    id="membership-owner-b",
                    family_id="family-b",
                    user_id="owner-b",
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                Membership(
                    id="membership-member-a",
                    family_id="family-a",
                    user_id="member-a",
                    role=UserRole.MEMBER,
                    status=MembershipStatus.ACTIVE,
                ),
                FamilyModelSettings(
                    family_id="family-a", created_by="owner-a", updated_by="owner-a"
                ),
                FamilyModelSettings(
                    family_id="family-b", created_by="owner-b", updated_by="owner-b"
                ),
            ]
        )
        db.commit()

    auth_state = SimpleNamespace(
        family_id="family-a", user_id="owner-a", membership_id="membership-owner-a"
    )
    cipher = make_cipher()
    policy = ProviderNetworkPolicy(resolver=StaticResolver())
    transport = FakeTransport()

    def override_db() -> Iterator[Session]:
        with SessionLocal() as db:
            yield db

    def override_auth(db: Session = Depends(get_db)) -> tuple[User, Membership]:
        user = db.get(User, auth_state.user_id)
        membership = db.get(Membership, auth_state.membership_id)
        assert user is not None and membership is not None
        return user, membership

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_auth] = override_auth
    app.dependency_overrides[
        family_model_settings_api.get_family_model_credential_cipher
    ] = lambda: cipher
    app.dependency_overrides[
        family_model_settings_api.get_family_model_network_policy
    ] = lambda: policy
    app.dependency_overrides[
        family_model_settings_api.get_family_model_provider_transport
    ] = lambda: transport
    app.dependency_overrides[
        family_model_settings_api.get_family_model_capability_test_dependencies
    ] = lambda: CapabilityTestDependencies(
        cipher=cipher,
        network_policy=policy,
        transport=transport,  # type: ignore[arg-type]
        usage_facade=ModelUsageFacade(session_factory=SessionLocal),
        signer=ProviderUsageReceiptSigner(
            active_key_id="family-model-capability-test",
            keys={"family-model-capability-test": b"family-model-capability-test-key"},
        ),
        session_factory=SessionLocal,
    )
    client = TestClient(app)
    context = FamilyModelApiContext(
        client=client,
        session_factory=SessionLocal,
        cipher=cipher,
        policy=policy,
        transport=transport,
        auth_state=auth_state,
    )
    try:
        yield context
    finally:
        client.close()
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()
