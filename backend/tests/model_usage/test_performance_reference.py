from __future__ import annotations

import math
import os
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageOperationSource,
)
from app.db.base import Base
from app.models.domain import Family, User
from app.models.model_usage import ModelUsageFamilyPolicy
from app.repos.model_usage.reporting import (
    family_counters_statement,
    family_events_statement,
    historical_rollups_statement,
)
from app.services.model_usage.adapters.llm import LLMUsageAdapter
from app.services.model_usage.dispatch import prepare_usage_dispatch
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.facade import ModelUsageFacade
from app.services.model_usage.policies import ensure_family_model_usage_defaults
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.settlement import settle_usage
from app.services.model_usage.types import ProviderRecoveryPolicy, UsageAttribution, UsageContext
from app.services.model_usage.queries import (
    get_family_usage_breakdown,
    get_family_usage_overview,
)
from app.services.model_usage.subjects import ensure_user_subject
from scripts.model_usage_reference_artifact import (
    record_reference_latency,
    record_reference_query_plan,
)
from tests.model_usage.test_migration_mysql import MySqlAlembicDatabase
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reporting_queries_mysql import (
    PERIOD,
    _explain,
    _mysql_url,
    _seed_first_build_race,
    _seed_reference_scale,
)
from tests.model_usage.test_reservations import NOW


REFERENCE_PROFILE_NAME = "culina-first-launch-mysql84-v1"
REFERENCE_SAMPLE_COUNT = 20
REFERENCE_FAMILY_ID = "family-performance-transaction"
REFERENCE_USER_ID = "user-performance-transaction"


@dataclass(frozen=True, slots=True)
class ReferenceHostProfile:
    actual: str | None
    required: str = REFERENCE_PROFILE_NAME

    def require_enabled(self) -> None:
        if self.actual is None:
            pytest.skip(
                "absolute latency runs only on the designated first-launch reference host"
            )
        if self.actual != self.required:
            pytest.fail(f"unexpected reference profile: {self.actual}")


@dataclass(frozen=True, slots=True)
class ReferenceDataset:
    engine: Engine
    session_factory: sessionmaker[Session]
    signer: ProviderUsageReceiptSigner


@dataclass(frozen=True, slots=True)
class UsagePerformanceResult:
    reserve_p95_ms: float
    settle_p95_ms: float
    current_overview_p95_ms: float
    current_breakdown_p95_ms: float
    historical_rollup_p95_ms: float


@dataclass(frozen=True, slots=True)
class UsageQueryPlanInspection:
    has_full_table_scan: bool
    current_aggregate_query_count: int
    current_breakdown_query_count: int
    historical_rollup_query_count: int


@pytest.fixture()
def reference_host_profile() -> ReferenceHostProfile:
    actual = (os.getenv("MODEL_USAGE_REFERENCE_PROFILE") or "").strip() or None
    return ReferenceHostProfile(actual=actual)


def _reference_mysql_url():
    url = _mysql_url()
    parsed = make_url(str(url))
    if not (parsed.database or "").endswith("_test"):
        pytest.fail("CULINA_TEST_MYSQL_URL database name must end with _test")
    return parsed


def _seed_transaction_benchmark_family(engine: Engine) -> sessionmaker[Session]:
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with factory() as db:
        family = Family(
            id=REFERENCE_FAMILY_ID,
            name="模型用量性能事务家庭",
            motto="",
            location="",
        )
        user = User(
            id=REFERENCE_USER_ID,
            username=REFERENCE_USER_ID,
            display_name="性能测试用户",
            avatar_seed="性能测试用户",
            is_active=True,
        )
        db.add_all((family, user))
        db.flush()
        subject = ensure_user_subject(
            db,
            family_id=family.id,
            user_id=user.id,
        )
        ensure_family_model_usage_defaults(
            db,
            family_id=family.id,
            creator_subject_id=subject.id,
        )
        db.commit()
        publish(db, raw_manifest())
    return factory


@pytest.fixture(scope="module")
def reference_dataset() -> Iterator[ReferenceDataset]:
    # Check this before even inspecting the MySQL URL or allocating the 100k
    # event fixture.  A non-reference host must never spend minutes pretending
    # that its local timing proves the release latency target.
    ReferenceHostProfile(
        actual=(os.getenv("MODEL_USAGE_REFERENCE_PROFILE") or "").strip() or None
    ).require_enabled()
    database = MySqlAlembicDatabase.from_test_url(_reference_mysql_url())
    database.recreate()
    engine = create_engine(database.url, pool_pre_ping=True, future=True)
    try:
        Base.metadata.create_all(engine)
        _seed_reference_scale(engine, events_in_current_period=100_000)
        _seed_first_build_race(engine)
        # The historical seed deliberately focuses on raw aggregate functions.
        # The public overview/breakdown path also needs a policy pointer.
        with engine.begin() as connection:
            connection.execute(
                ModelUsageFamilyPolicy.__table__.insert(),
                {
                    "family_id": "family-a",
                    "current_policy_version_id": "policy-a",
                    "tracking_started_at": PERIOD.start_at,
                    "created_at": PERIOD.start_at,
                    "updated_at": PERIOD.start_at,
                },
            )
        factory = _seed_transaction_benchmark_family(engine)
        yield ReferenceDataset(
            engine=engine,
            session_factory=factory,
            signer=ProviderUsageReceiptSigner(
                active_key_id="reference-performance-key",
                keys={"reference-performance-key": b"reference-performance-secret"},
            ),
        )
    finally:
        engine.dispose()
        database.dispose()


def _p95(samples: Sequence[float]) -> float:
    if not samples:
        raise ValueError("at least one performance sample is required")
    ordered = sorted(samples)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def _elapsed_ms(action: Callable[[], object]) -> float:
    started = time.perf_counter()
    action()
    return (time.perf_counter() - started) * 1000


def _reference_context(index: int) -> UsageContext:
    return UsageContext(
        attribution=UsageAttribution(
            family_id=REFERENCE_FAMILY_ID,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=REFERENCE_USER_ID,
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id=f"performance-operation-{index}",
        ),
        capability=ModelUsageCapability.LLM,
        provider="openai",
        requested_model="gpt-test",
        billing_model="gpt-test",
        variant_key="default",
        operation_kind="performance_reference",
        attempt_key=f"performance-attempt-{index}",
        client_attempt_id=f"mua_performance_{index}",
    )


def _reserve_dispatch_and_receipt(
    dataset: ReferenceDataset,
    *,
    index: int,
) -> tuple[float, object]:
    context = _reference_context(index)
    fingerprint = f"performance-fingerprint-{index}"
    estimate = estimate_llm(input_tokens=1, cached_input_tokens=0, max_output_tokens=1)
    decision_box: list[object] = []

    def reserve_once() -> None:
        with dataset.session_factory() as db:
            with db.begin():
                decision_box.append(
                    reserve_usage_in_session(
                        db,
                        context,
                        estimate,
                        fingerprint=fingerprint,
                        at=NOW,
                    )
                )

    reserve_ms = _elapsed_ms(reserve_once)
    decision = decision_box[0]
    assert getattr(decision, "reservation_id", None) is not None
    permit = prepare_usage_dispatch(
        decision.reservation_id,
        fingerprint=fingerprint,
        recovery_policy=ProviderRecoveryPolicy.none(),
        session_factory=dataset.session_factory,
        at=NOW,
    )
    adapter = LLMUsageAdapter(
        provider="openai",
        usage_facade=ModelUsageFacade(
            session_factory=dataset.session_factory,
            clock=lambda: NOW,
        ),
        session_factory=dataset.session_factory,
        signer=dataset.signer,
        clock=lambda: NOW,
    )
    receipt = adapter.receipt_from_openai_usage(
        permit,
        raw_usage={"input_tokens": 1, "output_tokens": 1},
        reported_model="gpt-test",
        provider_request_id=f"reference-request-{index}",
        completed_at=NOW + timedelta(seconds=1),
    )
    return reserve_ms, receipt


def benchmark_usage_queries(dataset: ReferenceDataset) -> UsagePerformanceResult:
    reserve_samples: list[float] = []
    settle_samples: list[float] = []
    for index in range(REFERENCE_SAMPLE_COUNT):
        reserve_ms, receipt = _reserve_dispatch_and_receipt(dataset, index=index)
        reserve_samples.append(reserve_ms)
        settle_samples.append(
            _elapsed_ms(
                lambda receipt=receipt: settle_usage(
                    receipt,
                    signer=dataset.signer,
                    session_factory=dataset.session_factory,
                )
            )
        )

    current_overview_samples = [
        _elapsed_ms(
            lambda: _family_overview(dataset, period="2026-07", at=NOW)
        )
        for _ in range(REFERENCE_SAMPLE_COUNT)
    ]
    current_breakdown_samples = [
        _elapsed_ms(
            lambda: _family_breakdown(dataset, period="2026-07", at=NOW)
        )
        for _ in range(REFERENCE_SAMPLE_COUNT)
    ]
    historical_samples = [
        _elapsed_ms(
            lambda: _family_overview(
                dataset,
                period="2026-06",
                at=datetime(2026, 8, 1, tzinfo=timezone.utc),
            )
        )
        for _ in range(REFERENCE_SAMPLE_COUNT)
    ]
    return UsagePerformanceResult(
        reserve_p95_ms=_p95(reserve_samples),
        settle_p95_ms=_p95(settle_samples),
        current_overview_p95_ms=_p95(current_overview_samples),
        current_breakdown_p95_ms=_p95(current_breakdown_samples),
        historical_rollup_p95_ms=_p95(historical_samples),
    )


def _family_overview(
    dataset: ReferenceDataset,
    *,
    period: str,
    at: datetime,
) -> object:
    with Session(dataset.engine, expire_on_commit=False) as db:
        return get_family_usage_overview(db, family_id="family-a", period=period, at=at)


def _family_breakdown(
    dataset: ReferenceDataset,
    *,
    period: str,
    at: datetime,
) -> object:
    with Session(dataset.engine, expire_on_commit=False) as db:
        return get_family_usage_breakdown(
            db,
            family_id="family-a",
            period=period,
            group_by="capability",
            at=at,
        )


def _count_queries(engine: Engine, action: Callable[[], object]) -> int:
    count = 0

    def record_query(*_args: object) -> None:
        nonlocal count
        count += 1

    event.listen(engine, "before_cursor_execute", record_query)
    try:
        action()
    finally:
        event.remove(engine, "before_cursor_execute", record_query)
    return count


def inspect_usage_query_plans(dataset: ReferenceDataset) -> UsageQueryPlanInspection:
    plans = (
        _explain(
            dataset.engine,
            family_counters_statement(family_id="family-a", period=PERIOD),
        ),
        _explain(
            dataset.engine,
            family_events_statement(family_id="family-a", period=PERIOD),
        ),
        _explain(
            dataset.engine,
            historical_rollups_statement(family_id="family-a", period=PERIOD),
        ),
    )
    has_full_table_scan = any(
        str(row.get("type") or "").upper() == "ALL"
        for plan in plans
        for row in plan
    )
    return UsageQueryPlanInspection(
        has_full_table_scan=has_full_table_scan,
        # Task 9 intentionally performs eight bounded, bulk reads to retain
        # exact health and correction state.  The former task-22 draft's
        # threshold of five conflicts with that already verified contract.
        current_aggregate_query_count=_count_queries(
            dataset.engine,
            lambda: _family_overview(dataset, period="2026-07", at=NOW),
        ),
        current_breakdown_query_count=_count_queries(
            dataset.engine,
            lambda: _family_breakdown(dataset, period="2026-07", at=NOW),
        ),
        historical_rollup_query_count=_count_queries(
            dataset.engine,
            lambda: _family_overview(
                dataset,
                period="2026-06",
                at=datetime(2026, 8, 1, tzinfo=timezone.utc),
            ),
        ),
    )


def test_reference_marker_is_registered(pytestconfig: pytest.Config) -> None:
    assert any(
        marker.startswith("model_usage_reference:")
        for marker in pytestconfig.getini("markers")
    )


def test_reference_host_profile_refuses_an_unexpected_name() -> None:
    with pytest.raises(pytest.fail.Exception, match="unexpected reference profile"):
        ReferenceHostProfile(actual="laptop").require_enabled()


@pytest.mark.model_usage_reference
def test_reference_profile_latency(
    reference_dataset: ReferenceDataset,
    reference_host_profile: ReferenceHostProfile,
    pytestconfig: pytest.Config,
) -> None:
    reference_host_profile.require_enabled()
    result = benchmark_usage_queries(reference_dataset)

    assert result.reserve_p95_ms <= 150
    assert result.settle_p95_ms <= 150
    assert result.current_overview_p95_ms <= 300
    assert result.current_breakdown_p95_ms <= 1000
    assert result.historical_rollup_p95_ms <= 500
    record_reference_latency(pytestconfig, result)


@pytest.mark.model_usage_reference
def test_usage_query_plans_and_counts(
    reference_dataset: ReferenceDataset,
    pytestconfig: pytest.Config,
) -> None:
    result = inspect_usage_query_plans(reference_dataset)

    assert result.has_full_table_scan is False
    assert result.current_aggregate_query_count <= 11
    assert result.current_breakdown_query_count <= 6
    assert result.historical_rollup_query_count <= 3
    record_reference_query_plan(pytestconfig, result)
