from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from app.core.deps import get_current_auth
from app.core.utils import utcnow
from app.core.enums import (
    MembershipStatus,
    ModelUsageCapability,
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    UserRole,
)
from app.db.session import get_db
from app.main import app
from app.models.domain import Base, Family, Membership, User
from app.models.model_usage import (
    ModelUsageAlert,
    ModelUsageAlertReceipt,
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsagePeriodCounter,
    ModelUsageSubject,
)
from app.services.model_usage.counters import family_cost_dimension_key
from app.services.model_usage.policies import (
    current_policy,
    ensure_family_model_usage_defaults,
)
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.subjects import ensure_user_subject, unlink_user_subjects


NOW = utcnow()
CURRENT_PERIOD = shanghai_billing_period(NOW)


@dataclass(frozen=True, slots=True)
class UsageApiContext:
    client: TestClient
    SessionLocal: sessionmaker[Session]
    use_auth: Callable[[str, str], None]
    family_a_id: str
    family_b_id: str
    owner_a_id: str
    owner_a_membership_id: str
    owner_a2_id: str
    owner_a2_membership_id: str
    member_a_id: str
    member_a_membership_id: str
    owner_b_id: str
    owner_b_membership_id: str
    deleted_subject_label: str
    secret_subject_key: str
    period: str


def _user(user_id: str, display_name: str) -> User:
    return User(
        id=user_id,
        username=user_id,
        display_name=display_name,
        avatar_seed=display_name,
        is_active=True,
    )


def _membership(
    membership_id: str,
    *,
    family_id: str,
    user_id: str,
    role: UserRole,
) -> Membership:
    return Membership(
        id=membership_id,
        family_id=family_id,
        user_id=user_id,
        role=role,
        status=MembershipStatus.ACTIVE,
    )


def _usage_event(
    *,
    event_id: str,
    family_id: str,
    subject: ModelUsageSubject,
    policy_id: str,
    cost_cny: Decimal,
    provider: str = "openai",
    billing_model: str = "gpt-test",
) -> ModelUsageEvent:
    return ModelUsageEvent(
        id=event_id,
        reservation_id=None,
        recovery_source="provider",
        attempt_key=f"attempt-{event_id}",
        fingerprint=(event_id * 64)[:64],
        client_attempt_id=f"client-{event_id}",
        family_id=family_id,
        subject_id=subject.id,
        subject_key=subject.subject_key,
        capability=ModelUsageCapability.LLM,
        provider=provider,
        requested_model=billing_model,
        reported_model=billing_model,
        billing_model=billing_model,
        variant_key="default",
        billing_scheme_key="llm-split-v1",
        pricing_status=ModelUsagePricingStatus.PRICED,
        price_version_id=None,
        price_snapshot_checksum=None,
        policy_version_id=policy_id,
        dispatch_policy_version_id=policy_id,
        period_start=CURRENT_PERIOD.start_at,
        period_end=CURRENT_PERIOD.end_at,
        provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
        execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
        measurement_status=ModelUsageMeasurementStatus.EXACT,
        provider_reported_source_cost=None,
        provider_reported_source_currency=None,
        cost_cny=cost_cny,
        provider_request_id=None,
        dispatched_at=NOW,
        completed_at=NOW,
        estimation_reason=None,
        stable_error_code=None,
        fail_open_proof_id=None,
        created_at=NOW,
    )


def _meter(*, event_id: str, meter_id: str, quantity: Decimal) -> ModelUsageEventMeter:
    return ModelUsageEventMeter(
        id=meter_id,
        event_id=event_id,
        meter_key="total_tokens",
        meter=ModelUsageMeter.TOTAL_TOKENS,
        meter_role=ModelUsageMeterRole.INFORMATIONAL,
        quantity=quantity,
        quantity_source=ModelUsageQuantitySource.PROVIDER,
        unit_quantity=None,
        source_unit_price=None,
        source_currency=None,
        fx_to_cny=None,
        unit_price_cny=None,
        cost_cny=None,
    )


@pytest.fixture()
def usage_api_context() -> Iterator[UsageApiContext]:
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
    secret_subject_key = "CULINA_USAGE_SECRET_SUBJECT_KEY"
    with SessionLocal() as db:
        family_a = Family(id="family-usage-a", name="用量家庭 A", motto="", location="")
        family_b = Family(id="family-usage-b", name="用量家庭 B", motto="", location="")
        owner_a = _user("owner-usage-a", "A 家庭主理人")
        owner_a2 = _user("owner-usage-a2", "A 家庭共同主理人")
        member_a = _user("member-usage-a", "A 家庭成员")
        owner_b = _user("owner-usage-b", "B 家庭主理人")
        deleted_user = _user("deleted-usage-a", "已删除用户")
        db.add_all([family_a, family_b, owner_a, owner_a2, member_a, owner_b, deleted_user])
        db.flush()
        db.add_all(
            [
                _membership(
                    "membership-owner-usage-a",
                    family_id=family_a.id,
                    user_id=owner_a.id,
                    role=UserRole.OWNER,
                ),
                _membership(
                    "membership-owner-usage-a2",
                    family_id=family_a.id,
                    user_id=owner_a2.id,
                    role=UserRole.OWNER,
                ),
                _membership(
                    "membership-member-usage-a",
                    family_id=family_a.id,
                    user_id=member_a.id,
                    role=UserRole.MEMBER,
                ),
                _membership(
                    "membership-owner-usage-b",
                    family_id=family_b.id,
                    user_id=owner_b.id,
                    role=UserRole.OWNER,
                ),
            ]
        )
        owner_a_subject = ensure_user_subject(db, family_id=family_a.id, user_id=owner_a.id)
        owner_a2_subject = ensure_user_subject(db, family_id=family_a.id, user_id=owner_a2.id)
        member_a_subject = ensure_user_subject(db, family_id=family_a.id, user_id=member_a.id)
        deleted_subject = ensure_user_subject(db, family_id=family_a.id, user_id=deleted_user.id)
        owner_b_subject = ensure_user_subject(db, family_id=family_b.id, user_id=owner_b.id)
        deleted_subject.subject_key = secret_subject_key
        ensure_family_model_usage_defaults(
            db,
            family_id=family_a.id,
            creator_subject_id=owner_a_subject.id,
        )
        ensure_family_model_usage_defaults(
            db,
            family_id=family_b.id,
            creator_subject_id=owner_b_subject.id,
        )
        unlink_user_subjects(db, user_id=deleted_user.id)
        db.flush()
        policy_a = current_policy(db, family_id=family_a.id)
        policy_b = current_policy(db, family_id=family_b.id)
        events = [
            _usage_event(
                event_id="usage-event-owner-a",
                family_id=family_a.id,
                subject=owner_a_subject,
                policy_id=policy_a.id,
                cost_cny=Decimal("12.345"),
            ),
            _usage_event(
                event_id="usage-event-member-a",
                family_id=family_a.id,
                subject=member_a_subject,
                policy_id=policy_a.id,
                cost_cny=Decimal("0.001"),
            ),
            _usage_event(
                event_id="usage-event-deleted-a",
                family_id=family_a.id,
                subject=deleted_subject,
                policy_id=policy_a.id,
                cost_cny=Decimal("2"),
            ),
            _usage_event(
                event_id="usage-event-owner-b",
                family_id=family_b.id,
                subject=owner_b_subject,
                policy_id=policy_b.id,
                cost_cny=Decimal("99"),
            ),
        ]
        db.add_all(events)
        db.add_all(
            [
                _meter(event_id="usage-event-owner-a", meter_id="usage-meter-owner-a", quantity=Decimal("100")),
                _meter(event_id="usage-event-member-a", meter_id="usage-meter-member-a", quantity=Decimal("10")),
                _meter(event_id="usage-event-deleted-a", meter_id="usage-meter-deleted-a", quantity=Decimal("20")),
                _meter(event_id="usage-event-owner-b", meter_id="usage-meter-owner-b", quantity=Decimal("900")),
            ]
        )
        db.add_all(
            [
                ModelUsagePeriodCounter(
                    id="usage-counter-a",
                    family_id=family_a.id,
                    period_start=CURRENT_PERIOD.start_at,
                    period_end=CURRENT_PERIOD.end_at,
                    counter_kind=ModelUsageCounterKind.FAMILY_COST,
                    capability=None,
                    meter=None,
                    dimension_key=family_cost_dimension_key(),
                    settled_value=Decimal("14.346"),
                    reserved_value=Decimal("0"),
                    adjustment_value=Decimal("0"),
                    version=1,
                    health_status="healthy",
                ),
                ModelUsagePeriodCounter(
                    id="usage-counter-b",
                    family_id=family_b.id,
                    period_start=CURRENT_PERIOD.start_at,
                    period_end=CURRENT_PERIOD.end_at,
                    counter_kind=ModelUsageCounterKind.FAMILY_COST,
                    capability=None,
                    meter=None,
                    dimension_key=family_cost_dimension_key(),
                    settled_value=Decimal("99"),
                    reserved_value=Decimal("0"),
                    adjustment_value=Decimal("0"),
                    version=1,
                    health_status="healthy",
                ),
            ]
        )
        db.commit()

    def override_db() -> Iterator[Session]:
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db

    def use_auth(user_id: str, membership_id: str) -> None:
        def override_auth(db: Session = Depends(get_db)) -> tuple[User, Membership]:
            user = db.get(User, user_id)
            membership = db.get(Membership, membership_id)
            assert user is not None
            assert membership is not None
            return user, membership

        app.dependency_overrides[get_current_auth] = override_auth

    use_auth("owner-usage-a", "membership-owner-usage-a")

    try:
        yield UsageApiContext(
            client=TestClient(app),
            SessionLocal=SessionLocal,
            use_auth=use_auth,
            family_a_id="family-usage-a",
            family_b_id="family-usage-b",
            owner_a_id="owner-usage-a",
            owner_a_membership_id="membership-owner-usage-a",
            owner_a2_id="owner-usage-a2",
            owner_a2_membership_id="membership-owner-usage-a2",
            member_a_id="member-usage-a",
            member_a_membership_id="membership-member-usage-a",
            owner_b_id="owner-usage-b",
            owner_b_membership_id="membership-owner-usage-b",
            deleted_subject_label="已删除成员 1",
            secret_subject_key=secret_subject_key,
            period=CURRENT_PERIOD.local_month,
        )
    finally:
        app.dependency_overrides.clear()
        Base.metadata.drop_all(engine)
        engine.dispose()


def create_usage_alert(
    context: UsageApiContext,
    *,
    alert_id: str = "usage-alert-a",
    family_id: str | None = None,
    owner_ids: tuple[str, ...] | None = None,
) -> str:
    family_id = family_id or context.family_a_id
    owner_ids = owner_ids or (context.owner_a_id, context.owner_a2_id)
    with context.SessionLocal() as db:
        policy = current_policy(db, family_id=family_id)
        alert = ModelUsageAlert(
            id=alert_id,
            family_id=family_id,
            period_start=CURRENT_PERIOD.start_at,
            period_end=CURRENT_PERIOD.end_at,
            policy_version_id=policy.id,
            budget_alert_revision=policy.budget_alert_revision,
            threshold=Decimal("0.80"),
            budget_cny=Decimal("80"),
            settled_value=Decimal("64"),
            adjustment_value=Decimal("0"),
            effective_spend_cny=Decimal("64"),
            severity="warning",
            created_at=NOW,
        )
        db.add(alert)
        db.add_all(
            [
                ModelUsageAlertReceipt(
                    id=f"receipt-{alert_id}-{owner_id}",
                    alert_id=alert.id,
                    user_id=owner_id,
                )
                for owner_id in owner_ids
            ]
        )
        db.commit()
    return alert_id
