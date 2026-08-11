from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageLimitKind,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageOperationSource,
    ModelUsagePricingStatus,
    ModelUsageQuantitySource,
)
from app.models.domain import Family, User
from app.models.model_usage import ModelUsageEvent, ModelUsagePeriodCounter, ModelUsageReservation
from app.services.model_usage.errors import ModelUsageAttemptConflict, ModelUsageContractError
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.policies import (
    CapabilityLimitCommand,
    PolicyUpdateCommand,
    current_policy,
    ensure_family_model_usage_defaults,
    update_family_policy,
)
from app.services.model_usage.reservations import reserve_usage, reserve_usage_in_session
from app.services.model_usage.subjects import ensure_user_subject
from app.services.model_usage.types import (
    UsageAttribution,
    UsageContext,
    UsageEstimate,
    UsageMeterQuantity,
)
from tests.model_usage.test_pricing_service import publish, raw_manifest


NOW = datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc)


@pytest.fixture()
def reservation_context(model_usage_db: Session) -> UsageContext:
    family = Family(id="family-reserve", name="预留家庭", motto="", location="")
    owner = User(
        id="owner-reserve",
        username="owner-reserve",
        display_name="Owner",
        avatar_seed="Owner",
        is_active=True,
    )
    model_usage_db.add_all([family, owner])
    model_usage_db.flush()
    subject = ensure_user_subject(model_usage_db, family_id=family.id, user_id=owner.id)
    policy_pointer = ensure_family_model_usage_defaults(
        model_usage_db,
        family_id=family.id,
        creator_subject_id=subject.id,
    )
    policy_pointer.tracking_started_at = NOW
    return UsageContext(
        attribution=UsageAttribution(
            family_id=family.id,
            attribution_kind=ModelUsageAttributionKind.USER,
            actor_user_id=owner.id,
            operation_source=ModelUsageOperationSource.INTERACTIVE,
            logical_operation_id="operation-reserve",
        ),
        capability=ModelUsageCapability.LLM,
        provider="openai",
        requested_model="gpt-test",
        billing_model="gpt-test",
        variant_key="default",
        operation_kind="chat_round",
        attempt_key="attempt-a",
        client_attempt_id="mua_reserve_a",
    )


def set_policy(
    db: Session,
    context: UsageContext,
    *,
    budget: Decimal | None,
    hard: bool,
    limits: tuple[CapabilityLimitCommand, ...] = (),
) -> None:
    policy = current_policy(db, family_id=context.attribution.family_id)
    subject = ensure_user_subject(
        db,
        family_id=context.attribution.family_id,
        user_id=context.attribution.actor_user_id or "",
    )
    update_family_policy(
        db,
        PolicyUpdateCommand(
            family_id=context.attribution.family_id,
            base_version_number=policy.version_number,
            monthly_budget_cny=budget,
            alerts_enabled=True,
            hard_limit_enabled=hard,
            capability_limits=limits,
            actor_subject_id=subject.id,
            active_variants=(),
        ),
    )


def counter(db: Session, dimension_key: str) -> ModelUsagePeriodCounter:
    value = db.scalar(
        select(ModelUsagePeriodCounter).where(
            ModelUsagePeriodCounter.family_id == "family-reserve",
            ModelUsagePeriodCounter.dimension_key == dimension_key,
        )
    )
    assert value is not None
    return value


def test_same_attempt_and_fingerprint_replays_reservation(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    estimate = estimate_llm(input_tokens=100, cached_input_tokens=20, max_output_tokens=200)
    first = reserve_usage_in_session(
        model_usage_db, reservation_context, estimate, fingerprint="fp-a", at=NOW
    )
    second = reserve_usage_in_session(
        model_usage_db, reservation_context, estimate, fingerprint="fp-a", at=NOW
    )
    assert first.reservation_id == second.reservation_id
    assert model_usage_db.query(ModelUsageReservation).count() == 1
    assert counter(model_usage_db, "family_cost").reserved_value == first.reserved_cost_cny


def test_existing_reservation_counters_are_locked_in_one_query(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    estimate = estimate_llm(input_tokens=100, cached_input_tokens=20, max_output_tokens=200)
    reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate,
        fingerprint="fp-counter-seed",
        at=NOW,
    )
    next_context = replace(
        reservation_context,
        attempt_key="attempt-counter-batch",
        client_attempt_id="mua_counter_batch",
    )
    statements: list[str] = []
    engine = model_usage_db.get_bind()

    def capture_statement(_conn, _cursor, statement, _parameters, _context, _executemany) -> None:
        statements.append(statement.lower())

    event.listen(engine, "before_cursor_execute", capture_statement)
    try:
        reserve_usage_in_session(
            model_usage_db,
            next_context,
            estimate,
            fingerprint="fp-counter-batch",
            at=NOW,
        )
    finally:
        event.remove(engine, "before_cursor_execute", capture_statement)

    counter_selects = [
        statement
        for statement in statements
        if statement.lstrip().startswith("select") and "from model_usage_period_counters" in statement
    ]
    assert len(counter_selects) == 1


def test_reserve_usage_commits_only_its_own_transaction(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    model_usage_db.commit()
    usage_session_factory = sessionmaker(
        bind=model_usage_db.get_bind(),
        expire_on_commit=False,
    )

    decision = reserve_usage(
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-public-reserve",
        session_factory=usage_session_factory,
    )

    assert decision.decision == "allowed"
    with usage_session_factory() as check_db:
        reservation = check_db.get(ModelUsageReservation, decision.reservation_id)
        assert reservation is not None


def test_same_attempt_with_different_fingerprint_is_rejected(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    estimate = estimate_llm(input_tokens=100, cached_input_tokens=20, max_output_tokens=200)
    reserve_usage_in_session(model_usage_db, reservation_context, estimate, fingerprint="fp-a", at=NOW)
    with pytest.raises(ModelUsageAttemptConflict):
        reserve_usage_in_session(model_usage_db, reservation_context, estimate, fingerprint="fp-b", at=NOW)


def test_hard_limit_rejects_unpriced_before_reservation(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    set_policy(model_usage_db, reservation_context, budget=Decimal("100"), hard=True)
    result = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=100, cached_input_tokens=20, max_output_tokens=200),
        fingerprint="fp-unpriced",
        at=NOW,
    )
    assert result.decision == "blocked"
    assert result.error_code == "model_usage_price_unavailable"
    assert model_usage_db.query(ModelUsageReservation).count() == 0


def test_monitoring_mode_admits_unpriced_and_tracks_meter_counters(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    estimate = UsageEstimate(
        meters=(
            UsageMeterQuantity(
                meter=ModelUsageMeter.TOTAL_TOKENS,
                quantity=Decimal("300"),
                meter_role=ModelUsageMeterRole.INFORMATIONAL,
                quantity_source=ModelUsageQuantitySource.ESTIMATED,
            ),
        )
    )
    result = reserve_usage_in_session(
        model_usage_db, reservation_context, estimate, fingerprint="fp-meter", at=NOW
    )
    assert result.decision == "allowed"
    assert result.pricing_status is ModelUsagePricingStatus.UNPRICED
    assert counter(
        model_usage_db, "capability_meter:llm:total_tokens"
    ).reserved_value == Decimal("300")


@pytest.mark.parametrize(
    ("meter", "quantity"),
    [
        (ModelUsageMeter.TOTAL_TOKENS, Decimal("-1")),
        (ModelUsageMeter.TOTAL_TOKENS, Decimal("1.5")),
        (ModelUsageMeter.TOTAL_TOKENS, Decimal("1.0000001")),
    ],
)
def test_reservation_rejects_invalid_meter_quantity_contract(
    model_usage_db: Session,
    reservation_context: UsageContext,
    meter: ModelUsageMeter,
    quantity: Decimal,
) -> None:
    estimate = UsageEstimate(
        meters=(
            UsageMeterQuantity(
                meter=meter,
                quantity=quantity,
                meter_role=ModelUsageMeterRole.INFORMATIONAL,
                quantity_source=ModelUsageQuantitySource.ESTIMATED,
            ),
        )
    )

    with pytest.raises(ModelUsageContractError, match="meter_quantity"):
        reserve_usage_in_session(
            model_usage_db,
            reservation_context,
            estimate,
            fingerprint=f"fp-invalid-{quantity}",
            at=NOW,
        )

    assert model_usage_db.query(ModelUsageReservation).count() == 0


def test_full_precision_budget_comparison_blocks_without_cent_rounding(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    estimate = estimate_llm(input_tokens=100, cached_input_tokens=20, max_output_tokens=200)
    preview = reserve_usage_in_session(
        model_usage_db, reservation_context, estimate, fingerprint="preview", at=NOW
    )
    assert preview.reserved_cost_cny is not None
    # Use another family transaction state by releasing the preview rows directly for this boundary test.
    reservation = model_usage_db.get(ModelUsageReservation, preview.reservation_id)
    assert reservation is not None
    model_usage_db.delete(reservation)
    for row in model_usage_db.query(ModelUsagePeriodCounter).all():
        model_usage_db.delete(row)
    model_usage_db.flush()
    set_policy(
        model_usage_db,
        reservation_context,
        budget=preview.reserved_cost_cny - Decimal("0.000000000001"),
        hard=True,
    )
    result = reserve_usage_in_session(
        model_usage_db,
        replace(reservation_context, attempt_key="attempt-boundary", client_attempt_id="mua_boundary"),
        estimate,
        fingerprint="fp-boundary",
        at=NOW,
    )
    assert result.decision == "blocked"
    assert result.error_code == "model_usage_budget_exceeded"


def test_capability_meter_guardrail_uses_informational_quantity(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    publish(model_usage_db, raw_manifest())
    limit = CapabilityLimitCommand(
        capability=ModelUsageCapability.LLM,
        limit_kind=ModelUsageLimitKind.METER,
        meter=ModelUsageMeter.TOTAL_TOKENS,
        limit_value=Decimal("250"),
    )
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=True,
        limits=(limit,),
    )
    result = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        UsageEstimate(
            meters=(
                UsageMeterQuantity(
                    meter=ModelUsageMeter.TOTAL_TOKENS,
                    quantity=Decimal("300"),
                    meter_role=ModelUsageMeterRole.INFORMATIONAL,
                    quantity_source=ModelUsageQuantitySource.ESTIMATED,
                ),
            )
        ),
        fingerprint="fp-guardrail",
        at=NOW,
    )
    assert result.decision == "blocked"
    assert result.error_code == "model_usage_capability_limit_exceeded"


def test_existing_same_fingerprint_event_returns_already_accounted(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    policy = current_policy(model_usage_db, family_id="family-reserve")
    subject = ensure_user_subject(model_usage_db, family_id="family-reserve", user_id="owner-reserve")
    event = ModelUsageEvent(
        id="event-existing",
        reservation_id=None,
        recovery_source="receipt",
        attempt_key=reservation_context.attempt_key,
        fingerprint="fp-event",
        client_attempt_id=reservation_context.client_attempt_id,
        family_id="family-reserve",
        subject_id=subject.id,
        subject_key=subject.subject_key,
        capability=ModelUsageCapability.LLM,
        provider="openai",
        requested_model="gpt-test",
        reported_model=None,
        billing_model="gpt-test",
        variant_key="default",
        billing_scheme_key="unpriced",
        policy_version_id=policy.id,
        dispatch_policy_version_id=policy.id,
        pricing_status=ModelUsagePricingStatus.UNPRICED,
        price_version_id=None,
        price_snapshot_checksum=None,
        period_start=NOW,
        period_end=NOW,
        provider_request_id=None,
        provider_outcome="unknown",
        execution_certainty="unknown",
        measurement_status="estimated",
        cost_cny=None,
        dispatched_at=NOW,
        completed_at=NOW,
    )
    model_usage_db.add(event)
    model_usage_db.flush()
    result = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=1, cached_input_tokens=0, max_output_tokens=1),
        fingerprint="fp-event",
        at=NOW,
    )
    assert result.decision == "already_accounted"
    assert result.existing_event_id == event.id
