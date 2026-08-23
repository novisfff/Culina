from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from decimal import Decimal
from threading import Barrier, Event

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool

from app.core.enums import (
    FamilyModelSearchProfileStatus,
    MembershipStatus,
    ModelUsageCapability,
    ModelUsageMeter,
    UserRole,
)
from app.core.security import get_password_hash
from app.db.base import Base
from app.models.domain import Family, Membership, User, UserCredential
from app.models.family_model_settings import FamilyModelSettings, FamilySearchProfile
from app.models.model_usage import ModelUsagePriceRate
from app.repos.family_model_settings.profiles import lock_family_model_settings
from app.services.family_model_settings.credentials import (
    FamilyModelCredentialCipher,
    create_provider_profile,
)
from app.services.family_model_settings.drafts import SaveConfigDraftCommand, save_config_draft
from app.services.family_model_settings.errors import (
    FamilyModelSettingsError,
    FamilyModelSettingsVersionConflict,
)
from app.services.family_model_settings.network_policy import ProviderNetworkPolicy
from app.services.family_model_settings.prices import (
    PublishFamilyPriceVersionCommand,
    publish_family_price_version,
    validate_complete_family_price_rates,
)
from app.services.family_model_settings.publishing import (
    PublishConfigurationCommand,
    PublishedFamilyModelConfiguration,
    publish_family_model_configuration,
)
from app.services.family_model_settings.search_profiles import (
    CreateSearchReplacementCommand,
    activate_ready_search_profile,
    create_search_replacement,
    preview_search_replacement,
)
from app.services.family_model_settings.types import CreateProviderProfileCommand
from app.services.family_model_settings.validation import (
    ValidateDraftCommand,
    price_checksum,
    validate_family_model_draft,
)

from tests.family_model_settings._support import StaticResolver, make_cipher


FAMILY_ID = "family-search-activation-mysql"
OWNER_ID = "owner-search-activation"


def _mysql_url() -> URL:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not (url.database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


def _configuration_payload(profile_id: str) -> dict[str, object]:
    return {
        "bindings": [
            {
                "capability": "llm",
                "variant_key": "primary",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "mysql-search-llm",
                "max_output_tokens": 256,
            },
            {
                "capability": "embedding",
                "variant_key": "search",
                "enabled": True,
                "provider_profile_id": profile_id,
                "requested_model": "mysql-search-embedding-a",
                "dimensions": 2,
            },
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
        ]
        + [
            {
                "capability": "embedding",
                "variant_key": "search",
                "meter": "embedding_tokens",
                "unit_quantity": "1000",
                "unit_price": "0.02",
                "source_currency": "CNY",
                "fx_to_cny": "1",
            }
        ],
        "change_note": "MySQL 搜索索引激活测试",
    }


@dataclass(frozen=True, slots=True)
class SearchActivationMysqlContext:
    SessionLocal: sessionmaker[Session]
    cipher: FamilyModelCredentialCipher
    policy: ProviderNetworkPolicy
    active_profile_id: str
    replacement_provider_id: str

    def create_candidate(self, *, model: str, idempotency_key: str) -> str:
        with self.SessionLocal() as db:
            settings = db.get(FamilyModelSettings, FAMILY_ID)
            assert settings is not None and settings.active_search_profile_id == self.active_profile_id
            preview_command = CreateSearchReplacementCommand(
                family_id=FAMILY_ID,
                actor_user_id=OWNER_ID,
                current_password="OwnerPass123",
                base_settings_version_number=settings.version_number,
                base_search_profile_id=self.active_profile_id,
                provider_profile_id=self.replacement_provider_id,
                requested_model=model,
                dimensions=3,
                rates=[
                    {
                        "capability": "embedding",
                        "variant_key": "search",
                        "meter": "embedding_tokens",
                        "unit_quantity": "1000",
                        "unit_price": "0.03",
                        "source_currency": "CNY",
                        "fx_to_cny": "1",
                    }
                ],
                confirm_checksum="",
                idempotency_key=idempotency_key,
            )
            preview = preview_search_replacement(
                db,
                preview_command,
                network_policy=self.policy,
            )
            result = create_search_replacement(
                db,
                replace(preview_command, confirm_checksum=preview.confirmation_checksum),
                cipher=self.cipher,
                network_policy=self.policy,
            )
            db.commit()
            return result.profile_id

    def set_profile_status(self, profile_id: str, status: FamilyModelSearchProfileStatus) -> None:
        with self.SessionLocal() as db:
            profile = db.get(FamilySearchProfile, profile_id)
            assert profile is not None
            profile.status = status
            db.commit()

    def activate(self, profile_id: str) -> PublishedFamilyModelConfiguration | FamilyModelSettingsError:
        with self.SessionLocal() as db:
            try:
                result = activate_ready_search_profile(
                    db,
                    family_id=FAMILY_ID,
                    profile_id=profile_id,
                    actor_user_id=OWNER_ID,
                )
                db.commit()
                return result
            except FamilyModelSettingsError as exc:
                db.rollback()
                return exc

    def price_command(self) -> PublishFamilyPriceVersionCommand:
        with self.SessionLocal() as db:
            settings = db.get(FamilyModelSettings, FAMILY_ID)
            assert (
                settings is not None
                and settings.active_config_revision_id is not None
                and settings.active_price_version_id is not None
            )
            rates = [
                {
                    "capability": rate.capability.value,
                    "variant_key": rate.variant_key,
                    "meter": rate.meter.value,
                    "unit_quantity": str(rate.unit_quantity),
                    "unit_price": (
                        "3.2"
                        if rate.capability is ModelUsageCapability.LLM
                        and rate.meter is ModelUsageMeter.OUTPUT_TOKENS
                        else str(rate.unit_price)
                    ),
                    "source_currency": str(rate.source_currency),
                    "fx_to_cny": str(rate.fx_to_cny),
                    "reported_model_aliases": list(rate.reported_model_aliases),
                }
                for rate in db.scalars(
                    select(ModelUsagePriceRate)
                    .where(ModelUsagePriceRate.price_version_id == settings.active_price_version_id)
                    .order_by(
                        ModelUsagePriceRate.capability,
                        ModelUsagePriceRate.variant_key,
                        ModelUsagePriceRate.meter,
                    )
                )
            ]
            validated = validate_complete_family_price_rates(
                db,
                family_id=FAMILY_ID,
                config_revision_id=settings.active_config_revision_id,
                rates=rates,
            )
            return PublishFamilyPriceVersionCommand(
                family_id=FAMILY_ID,
                actor_user_id=OWNER_ID,
                base_settings_version_number=settings.version_number,
                base_price_version_id=settings.active_price_version_id,
                idempotency_key="mysql-search-price-race-1",
                confirm_checksum=price_checksum(validated),
                change_note="并发切换前调价",
                rates=rates,
            )

    def active_llm_output_price(self) -> Decimal:
        with self.SessionLocal() as db:
            settings = db.get(FamilyModelSettings, FAMILY_ID)
            assert settings is not None and settings.active_price_version_id is not None
            rate = db.scalar(
                select(ModelUsagePriceRate).where(
                    ModelUsagePriceRate.price_version_id == settings.active_price_version_id,
                    ModelUsagePriceRate.capability == ModelUsageCapability.LLM,
                    ModelUsagePriceRate.meter == ModelUsageMeter.OUTPUT_TOKENS,
                )
            )
            assert rate is not None and rate.unit_price is not None
            return rate.unit_price


@pytest.fixture()
def search_activation_mysql_context() -> SearchActivationMysqlContext:
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
    try:
        with SessionLocal() as db:
            db.add_all(
                [
                    Family(id=FAMILY_ID, name="搜索激活并发家庭", motto="", location=""),
                    User(
                        id=OWNER_ID,
                        username=OWNER_ID,
                        display_name="Search Owner",
                        avatar_seed=OWNER_ID,
                    ),
                    UserCredential(
                        id="credential-search-activation-owner",
                        user_id=OWNER_ID,
                        password_hash=get_password_hash("OwnerPass123"),
                    ),
                    Membership(
                        id="membership-search-activation-owner",
                        family_id=FAMILY_ID,
                        user_id=OWNER_ID,
                        role=UserRole.OWNER,
                        status=MembershipStatus.ACTIVE,
                    ),
                    FamilyModelSettings(
                        family_id=FAMILY_ID,
                        created_by=OWNER_ID,
                        updated_by=OWNER_ID,
                    ),
                ]
            )
            db.commit()

        with SessionLocal() as db:
            initial_provider = create_provider_profile(
                db,
                CreateProviderProfileCommand(
                    family_id=FAMILY_ID,
                    actor_user_id=OWNER_ID,
                    display_name="MySQL 搜索初始 Provider",
                    adapter_kind="openai_compatible_http",
                    auth_mode="api_key",
                    api_base_url="https://provider.example/v1",
                    websocket_base_url=None,
                    options={},
                    api_key="mysql-search-initial-key",
                    idempotency_key="mysql-search-initial-provider-1",
                ),
                cipher=cipher,
                network_policy=policy,
            )
            replacement_provider = create_provider_profile(
                db,
                CreateProviderProfileCommand(
                    family_id=FAMILY_ID,
                    actor_user_id=OWNER_ID,
                    display_name="MySQL 搜索替换 Provider",
                    adapter_kind="openai_compatible_http",
                    auth_mode="api_key",
                    api_base_url="https://replacement.example/v1",
                    websocket_base_url=None,
                    options={},
                    api_key="mysql-search-replacement-key",
                    idempotency_key="mysql-search-replacement-provider-1",
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
                    actor_user_id=OWNER_ID,
                    base_draft_version_number=0,
                    idempotency_key="mysql-search-initial-draft-1",
                    payload=_configuration_payload(initial_provider.id),
                ),
                cipher=cipher,
            )
            validation = validate_family_model_draft(
                db,
                ValidateDraftCommand(
                    family_id=FAMILY_ID,
                    actor_user_id=OWNER_ID,
                    network_policy=policy,
                    base_draft_version_number=draft.draft_version_number,
                ),
            )
            assert validation.valid and validation.config_checksum and validation.price_checksum
            settings = db.get(FamilyModelSettings, FAMILY_ID)
            assert settings is not None
            published = publish_family_model_configuration(
                db,
                PublishConfigurationCommand(
                    family_id=FAMILY_ID,
                    actor_user_id=OWNER_ID,
                    base_settings_version_number=settings.version_number,
                    base_draft_version_number=draft.draft_version_number,
                    idempotency_key="mysql-search-initial-publish-1",
                    confirm_config_checksum=validation.config_checksum,
                    confirm_price_checksum=validation.price_checksum,
                    network_policy=policy,
                ),
                cipher=cipher,
            )
            assert published.search_profile_id is not None
            activate_ready_search_profile(
                db,
                family_id=FAMILY_ID,
                profile_id=published.search_profile_id,
                actor_user_id=OWNER_ID,
            )
            db.commit()

        yield SearchActivationMysqlContext(
            SessionLocal=SessionLocal,
            cipher=cipher,
            policy=policy,
            active_profile_id=published.search_profile_id,
            replacement_provider_id=replacement_provider.id,
        )
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_mysql_only_matching_base_replacement_can_activate(
    search_activation_mysql_context: SearchActivationMysqlContext,
) -> None:
    context = search_activation_mysql_context
    first = context.create_candidate(
        model="mysql-search-embedding-b",
        idempotency_key="mysql-search-candidate-a-1",
    )
    # The service permits one live rebuild at a time. Create a second valid
    # candidate only after marking the first terminal, then restore the first
    # to provisioning to exercise the activation race against the same base.
    context.set_profile_status(first, FamilyModelSearchProfileStatus.CANCELLED)
    second = context.create_candidate(
        model="mysql-search-embedding-c",
        idempotency_key="mysql-search-candidate-b-1",
    )
    context.set_profile_status(first, FamilyModelSearchProfileStatus.PROVISIONING)

    barrier = Barrier(2, timeout=20)

    def activate(profile_id: str):
        barrier.wait(timeout=20)
        return context.activate(profile_id)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(activate, (first, second)))

    successful = [item for item in results if isinstance(item, PublishedFamilyModelConfiguration)]
    failures = [item for item in results if isinstance(item, FamilyModelSettingsVersionConflict)]
    assert len(successful) == 1
    assert len(failures) == 1
    assert failures[0].code == "family_search_profile_locked"

    with context.SessionLocal() as db:
        settings = db.get(FamilyModelSettings, FAMILY_ID)
        assert settings is not None
        assert settings.active_search_profile_id in {first, second}
        assert settings.active_search_profile_id == successful[0].search_profile_id


def test_mysql_price_publish_locked_before_activation_survives_the_switch(
    search_activation_mysql_context: SearchActivationMysqlContext,
) -> None:
    context = search_activation_mysql_context
    candidate = context.create_candidate(
        model="mysql-search-embedding-price-race",
        idempotency_key="mysql-search-candidate-price-race-1",
    )
    command = context.price_command()
    price_lock_acquired = Event()
    activation_started = Event()

    def publish_price() -> object:
        with context.SessionLocal() as db:
            # Acquire the project-wide first lock before signalling the other
            # worker. This makes the interleaving deterministic while still
            # using two independent MySQL transactions.
            lock_family_model_settings(db, family_id=FAMILY_ID)
            price_lock_acquired.set()
            assert activation_started.wait(timeout=20)
            result = publish_family_price_version(db, command, cipher=context.cipher)
            db.commit()
            return result

    def activate_candidate() -> object:
        assert price_lock_acquired.wait(timeout=20)
        activation_started.set()
        return context.activate(candidate)

    with ThreadPoolExecutor(max_workers=2) as pool:
        price_future = pool.submit(publish_price)
        activation_future = pool.submit(activate_candidate)
        price_result = price_future.result()
        activation_result = activation_future.result()

    assert not isinstance(price_result, FamilyModelSettingsError)
    assert isinstance(activation_result, PublishedFamilyModelConfiguration)
    assert context.active_llm_output_price() == Decimal("3.2")
