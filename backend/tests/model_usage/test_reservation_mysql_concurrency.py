from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from threading import Barrier

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageOperationSource,
    ModelUsageQuantitySource,
)
from app.db.base import Base
from app.models.domain import Family, User
from app.models.model_usage import ModelUsagePeriodCounter, ModelUsagePriceRate, ModelUsagePriceVersion
from app.services.model_usage.errors import ModelUsageAttemptConflict
from app.services.model_usage.policies import (
    PolicyUpdateCommand,
    current_policy,
    ensure_family_model_usage_defaults,
    update_family_policy,
)
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.subjects import ensure_user_subject
from app.services.model_usage.types import (
    UsageAttribution,
    UsageContext,
    UsageEstimate,
    UsageMeterQuantity,
)


NOW = datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc)


def mysql_url() -> URL:
    value = (os.environ.get("CULINA_TEST_MYSQL_URL") or "").strip()
    if not value:
        pytest.skip("CULINA_TEST_MYSQL_URL is not set")
    url = make_url(value)
    if not (url.database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return url


@dataclass(frozen=True)
class MysqlReservationContext:
    SessionLocal: sessionmaker[Session]
    base_context: UsageContext
    estimate: UsageEstimate

    def reserve(self, index: int, *, attempt_key: str | None = None, fingerprint: str = "fp"):
        context = UsageContext(
            attribution=self.base_context.attribution,
            capability=self.base_context.capability,
            provider=self.base_context.provider,
            requested_model=self.base_context.requested_model,
            billing_model=self.base_context.billing_model,
            variant_key=self.base_context.variant_key,
            operation_kind=self.base_context.operation_kind,
            attempt_key=attempt_key or f"attempt-{index}",
            client_attempt_id=f"mua_mysql_{index}",
        )
        with self.SessionLocal() as db:
            try:
                result = reserve_usage_in_session(
                    db,
                    context,
                    self.estimate,
                    fingerprint=fingerprint,
                    at=NOW,
                )
                db.commit()
                return result
            except ModelUsageAttemptConflict as exc:
                db.rollback()
                return exc

    def family_reserved(self) -> Decimal:
        with self.SessionLocal() as db:
            value = db.scalar(
                select(ModelUsagePeriodCounter.reserved_value).where(
                    ModelUsagePeriodCounter.family_id == "family-mysql-reserve",
                    ModelUsagePeriodCounter.dimension_key == "family_cost",
                )
            )
            return value or Decimal("0")


@pytest.fixture()
def mysql_reservation_context() -> MysqlReservationContext:
    url = mysql_url()
    database = url.database or ""
    admin_url = URL.create(
        drivername=url.drivername,
        username=url.username,
        password=url.password,
        host=url.host,
        port=url.port,
        database=None,
        query=url.query,
    )
    admin = create_engine(admin_url, isolation_level="AUTOCOMMIT", future=True)
    with admin.begin() as connection:
        connection.execute(
            text(
                f"CREATE DATABASE IF NOT EXISTS `{database}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
        )
    admin.dispose()
    engine = create_engine(url, pool_size=50, max_overflow=0, future=True)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with SessionLocal() as db:
        family = Family(id="family-mysql-reserve", name="并发家庭", motto="", location="")
        owner = User(
            id="owner-mysql-reserve",
            username="owner-mysql-reserve",
            display_name="Owner",
            avatar_seed="Owner",
            is_active=True,
        )
        db.add_all([family, owner])
        db.flush()
        subject = ensure_user_subject(db, family_id=family.id, user_id=owner.id)
        ensure_family_model_usage_defaults(
            db,
            family_id=family.id,
            creator_subject_id=subject.id,
        )
        policy = current_policy(db, family_id=family.id)
        update_family_policy(
            db,
            PolicyUpdateCommand(
                family_id=family.id,
                base_version_number=policy.version_number,
                monthly_budget_cny=Decimal("100"),
                alerts_enabled=True,
                hard_limit_enabled=True,
                capability_limits=(),
                actor_subject_id=subject.id,
                active_variants=(),
            ),
        )
        version = ModelUsagePriceVersion(
            id="price-mysql-reserve",
            version_number=1,
            status="published",
            effective_from=datetime(2026, 1, 1, tzinfo=timezone.utc),
            reviewed_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            source_ref="test",
            change_note="test",
            operator="test",
            change_ticket="test",
            manifest_checksum="a" * 64,
            model_aliases_json={},
            fx_rates_json={"CNY": "1"},
        )
        db.add(version)
        db.flush()
        db.add(
            ModelUsagePriceRate(
                id="rate-mysql-reserve",
                price_version_id=version.id,
                provider="test",
                billing_model="test",
                capability=ModelUsageCapability.LLM,
                variant_key="default",
                billing_scheme_key="test-cost-v1",
                meter=ModelUsageMeter.OUTPUT_TOKENS,
                meter_role=ModelUsageMeterRole.BILLABLE,
                unit_quantity=Decimal("1"),
                unit_price=Decimal("3"),
                source_currency="CNY",
                fx_to_cny=Decimal("1"),
                unit_price_cny=Decimal("3"),
                reported_model_aliases=[],
            )
        )
        db.commit()
    context = MysqlReservationContext(
        SessionLocal=SessionLocal,
        base_context=UsageContext(
            attribution=UsageAttribution(
                family_id="family-mysql-reserve",
                attribution_kind=ModelUsageAttributionKind.USER,
                actor_user_id="owner-mysql-reserve",
                operation_source=ModelUsageOperationSource.INTERACTIVE,
                logical_operation_id="mysql-concurrency",
            ),
            capability=ModelUsageCapability.LLM,
            provider="test",
            requested_model="test",
            billing_model="test",
            variant_key="default",
            operation_kind="test",
            attempt_key="base",
            client_attempt_id="mua_base",
        ),
        estimate=UsageEstimate(
            meters=(
                UsageMeterQuantity(
                    meter=ModelUsageMeter.OUTPUT_TOKENS,
                    quantity=Decimal("1"),
                    meter_role=ModelUsageMeterRole.BILLABLE,
                    quantity_source=ModelUsageQuantitySource.ESTIMATED,
                ),
            )
        ),
    )
    try:
        yield context
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def run_barriered(count: int, operation):
    barrier = Barrier(count)

    def run(index: int):
        barrier.wait()
        return operation(index)

    with ThreadPoolExecutor(max_workers=count) as pool:
        return list(pool.map(run, range(count)))


def test_fifty_concurrent_reservations_do_not_oversell(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    results = run_barriered(50, mysql_reservation_context.reserve)
    assert sum(getattr(result, "decision", None) == "allowed" for result in results) == 33
    assert sum(getattr(result, "error_code", None) == "model_usage_budget_exceeded" for result in results) == 17
    assert mysql_reservation_context.family_reserved() == Decimal("99.000000000000")


def test_fifty_same_attempt_claims_mutate_counter_once(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    results = run_barriered(
        50,
        lambda index: mysql_reservation_context.reserve(
            index,
            attempt_key="same-attempt",
            fingerprint="same-fingerprint",
        ),
    )
    assert len({result.reservation_id for result in results}) == 1
    assert mysql_reservation_context.family_reserved() == Decimal("3.000000000000")


def test_concurrent_same_attempt_different_fingerprint_has_one_winner(
    mysql_reservation_context: MysqlReservationContext,
) -> None:
    results = run_barriered(
        2,
        lambda index: mysql_reservation_context.reserve(
            index,
            attempt_key="conflicting-attempt",
            fingerprint=f"fp-{index}",
        ),
    )
    assert sum(getattr(result, "decision", None) == "allowed" for result in results) == 1
    assert sum(isinstance(result, ModelUsageAttemptConflict) for result in results) == 1
    assert mysql_reservation_context.family_reserved() == Decimal("3.000000000000")
