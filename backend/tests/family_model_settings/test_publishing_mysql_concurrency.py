from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from threading import Barrier

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.enums import MembershipStatus, UserRole
from app.db.base import Base
from app.models.domain import Family, Membership, User
from app.models.family_model_settings import (
    FamilyModelConfigRevision,
    FamilyModelOperationReceipt,
    FamilyModelSettings,
)
from app.models.model_usage import ModelUsagePriceVersion
from app.services.family_model_settings import publishing
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    create_provider_profile,
)
from app.services.family_model_settings.drafts import SaveConfigDraftCommand, save_config_draft
from app.services.family_model_settings.errors import (
    FamilyModelOperationIdempotencyConflict,
    FamilyModelSettingsError,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.publishing import (
    PublishConfigurationCommand,
    PublishedFamilyModelConfiguration,
    publish_family_model_configuration,
)
from app.services.family_model_settings.types import CreateProviderProfileCommand
from app.services.family_model_settings.validation import (
    ValidateDraftCommand,
    validate_family_model_draft,
)

from tests.family_model_settings._support import StaticResolver, make_cipher
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy


FAMILY_ID = "family-publishing-mysql"


def _mysql_url() -> URL:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not (url.database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


def _llm_payload(profile_id: str) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "family-mysql-model",
                "max_output_tokens": 1024,
            }
        ],
        "price_rates": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "meter": meter,
                "unit_quantity": "1000",
                "unit_price": "0.01",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
            for meter in (
                "uncached_input_tokens",
                "cached_input_tokens",
                "output_tokens",
            )
        ],
        "change_note": "MySQL 并发发布测试",
    }


@dataclass(frozen=True, slots=True)
class PublishingMysqlContext:
    SessionLocal: sessionmaker[Session]
    cipher: FamilyModelCredentialCipher
    command: PublishConfigurationCommand

    def command_for(
        self,
        *,
        actor_user_id: str,
        idempotency_key: str,
    ) -> PublishConfigurationCommand:
        return replace(
            self.command,
            actor_user_id=actor_user_id,
            idempotency_key=idempotency_key,
        )

    def publish(self, command: PublishConfigurationCommand) -> object:
        with self.SessionLocal() as db:
            try:
                result = publish_family_model_configuration(db, command, cipher=self.cipher)
                db.commit()
                return result
            except FamilyModelSettingsError as exc:
                db.rollback()
                return exc

    def settings(self) -> FamilyModelSettings:
        with self.SessionLocal() as db:
            settings = db.get(FamilyModelSettings, FAMILY_ID)
            assert settings is not None
            return settings

    def count(self, model: type[object], *, operation: str | None = None) -> int:
        with self.SessionLocal() as db:
            statement = select(func.count()).select_from(model)
            if operation is not None:
                assert model is FamilyModelOperationReceipt
                statement = statement.where(FamilyModelOperationReceipt.operation == operation)
            return int(db.scalar(statement) or 0)


@pytest.fixture()
def publishing_mysql_context() -> PublishingMysqlContext:
    engine = create_engine(_mysql_url(), poolclass=NullPool, pool_pre_ping=True, future=True)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
        class_=Session,
    )
    cipher = make_cipher()
    policy = ProviderNetworkPolicy(resolver=StaticResolver())
    with SessionLocal() as db:
        db.add_all(
            [
                Family(id=FAMILY_ID, name="并发发布家庭", motto="", location=""),
                User(
                    id="owner-publishing-a",
                    username="owner-publishing-a",
                    display_name="Owner A",
                    avatar_seed="owner-publishing-a",
                ),
                User(
                    id="owner-publishing-b",
                    username="owner-publishing-b",
                    display_name="Owner B",
                    avatar_seed="owner-publishing-b",
                ),
                Membership(
                    id="membership-publishing-a",
                    family_id=FAMILY_ID,
                    user_id="owner-publishing-a",
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                Membership(
                    id="membership-publishing-b",
                    family_id=FAMILY_ID,
                    user_id="owner-publishing-b",
                    role=UserRole.OWNER,
                    status=MembershipStatus.ACTIVE,
                ),
                FamilyModelSettings(
                    family_id=FAMILY_ID,
                    created_by="owner-publishing-a",
                    updated_by="owner-publishing-a",
                ),
            ]
        )
        db.commit()
    with SessionLocal() as db:
        profile = create_provider_profile(
            db,
            CreateProviderProfileCommand(
                family_id=FAMILY_ID,
                actor_user_id="owner-publishing-a",
                display_name="MySQL Provider",
                adapter_kind="openai_compatible_http",
                auth_mode="api_key",
                api_base_url="https://provider.example/v1",
                websocket_base_url=None,
                options={},
                api_key="sk-mysql-publishing-marker",
                idempotency_key="mysql-publishing-profile-1",
            ),
            cipher=cipher,
            network_policy=policy,
        )
        db.commit()
    with SessionLocal() as db:
        draft = save_config_draft(
            db,
            SaveConfigDraftCommand(
                family_id=FAMILY_ID,
                actor_user_id="owner-publishing-a",
                base_draft_version_number=0,
                idempotency_key="mysql-publishing-draft-1",
                payload=_llm_payload(profile.id),
            ),
            cipher=cipher,
        )
        db.commit()
    with SessionLocal() as db:
        validation = validate_family_model_draft(
            db,
            ValidateDraftCommand(
                family_id=FAMILY_ID,
                actor_user_id="owner-publishing-a",
                network_policy=policy,
                base_draft_version_number=draft.draft_version_number,
            ),
        )
        assert validation.valid is True
        assert validation.config_checksum is not None
        assert validation.price_checksum is not None
        settings = db.get(FamilyModelSettings, FAMILY_ID)
        assert settings is not None
        command = PublishConfigurationCommand(
            family_id=FAMILY_ID,
            actor_user_id="owner-publishing-a",
            base_settings_version_number=settings.version_number,
            base_draft_version_number=draft.draft_version_number,
            idempotency_key="mysql-publishing-command-1",
            confirm_config_checksum=validation.config_checksum,
            confirm_price_checksum=validation.price_checksum,
            network_policy=policy,
        )
        db.commit()
    context = PublishingMysqlContext(
        SessionLocal=SessionLocal,
        cipher=cipher,
        command=command,
    )
    try:
        yield context
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def _race(
    context: PublishingMysqlContext,
    commands: tuple[PublishConfigurationCommand, PublishConfigurationCommand],
) -> list[object]:
    barrier = Barrier(2, timeout=20)

    def run(command: PublishConfigurationCommand) -> object:
        barrier.wait(timeout=20)
        return context.publish(command)

    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(run, commands))


def test_mysql_concurrent_owners_only_one_advances_active_pointer(
    publishing_mysql_context: PublishingMysqlContext,
) -> None:
    context = publishing_mysql_context
    results = _race(
        context,
        (
            context.command_for(
                actor_user_id="owner-publishing-a",
                idempotency_key="mysql-publishing-owner-a-1",
            ),
            context.command_for(
                actor_user_id="owner-publishing-b",
                idempotency_key="mysql-publishing-owner-b-1",
            ),
        ),
    )

    successful = [item for item in results if isinstance(item, PublishedFamilyModelConfiguration)]
    conflicts = [item for item in results if isinstance(item, FamilyModelSettingsVersionConflict)]
    assert len(successful) == 1
    assert len(conflicts) == 1
    assert conflicts[0].current_settings_version_number == successful[0].settings_version_number
    assert conflicts[0].current_config_revision_id == successful[0].config_revision_id
    settings = context.settings()
    assert settings.active_config_revision_id == successful[0].config_revision_id
    assert settings.active_price_version_id == successful[0].price_version_id
    assert context.count(FamilyModelConfigRevision) == 1
    assert context.count(ModelUsagePriceVersion) == 1


def test_mysql_same_publish_key_replays_the_committed_winner(
    publishing_mysql_context: PublishingMysqlContext,
) -> None:
    context = publishing_mysql_context
    command = context.command_for(
        actor_user_id="owner-publishing-a",
        idempotency_key="mysql-publishing-replay-1",
    )

    first, second = _race(context, (command, command))

    assert isinstance(first, PublishedFamilyModelConfiguration)
    assert isinstance(second, PublishedFamilyModelConfiguration)
    assert first == second
    assert context.count(FamilyModelConfigRevision) == 1
    assert context.count(
        FamilyModelOperationReceipt,
        operation="publish_family_model_configuration",
    ) == 1


def test_mysql_same_publish_key_with_a_different_fingerprint_is_a_conflict(
    publishing_mysql_context: PublishingMysqlContext,
) -> None:
    context = publishing_mysql_context
    command = context.command_for(
        actor_user_id="owner-publishing-a",
        idempotency_key="mysql-publishing-key-conflict-1",
    )
    first = context.publish(command)
    assert isinstance(first, PublishedFamilyModelConfiguration)

    conflict = context.publish(replace(command, confirm_price_checksum="0" * 64))

    assert isinstance(conflict, FamilyModelOperationIdempotencyConflict)
    assert context.count(FamilyModelConfigRevision) == 1
    assert context.count(
        FamilyModelOperationReceipt,
        operation="publish_family_model_configuration",
    ) == 1


def test_mysql_publish_failure_rolls_back_receipt_and_all_published_rows(
    publishing_mysql_context: PublishingMysqlContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = publishing_mysql_context

    def raise_integrity_error(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise IntegrityError("insert price rate", {}, RuntimeError("injected failure"))

    monkeypatch.setattr(publishing, "insert_family_price_rates", raise_integrity_error)
    with context.SessionLocal() as db:
        with pytest.raises(IntegrityError):
            publish_family_model_configuration(db, context.command, cipher=context.cipher)
        db.rollback()
        settings = db.get(FamilyModelSettings, FAMILY_ID)
        assert settings is not None
        assert settings.active_config_revision_id is None
        assert settings.active_price_version_id is None
        assert db.scalar(select(func.count()).select_from(FamilyModelConfigRevision)) == 0
        assert db.scalar(select(func.count()).select_from(ModelUsagePriceVersion)) == 0
        assert (
            db.scalar(
                select(func.count())
                .select_from(FamilyModelOperationReceipt)
                .where(
                    FamilyModelOperationReceipt.operation
                    == "publish_family_model_configuration"
                )
            )
            == 0
        )
