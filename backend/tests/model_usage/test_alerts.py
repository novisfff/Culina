from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    MembershipStatus,
    ModelUsageCorrectionStatus,
    ModelUsageCounterKind,
    ModelUsageMeter,
    ModelUsageResolutionKind,
    ModelUsageRollupKind,
    UserRole,
)
from app.models.domain import Family, Membership, User
from app.models.model_usage import (
    ModelUsageAlert,
    ModelUsageAlertReceipt,
    ModelUsageEvent,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
)
from app.services.model_usage import alerts as alerts_service
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.settlement import settle_usage_in_session
from app.services.model_usage.types import ProviderRecoveryPolicy, UsageContext
from app.services.model_usage.alerts import (
    evaluate_budget_alerts,
    repair_new_budget_revision,
)
from app.services.model_usage.adjustments import (
    AdjustmentCommand,
    AdjustmentLineCommand,
    apply_adjustment,
    preview_adjustment,
)
from app.services.model_usage.counters import family_cost_dimension_key
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.policies import (
    PolicyUpdateCommand,
    current_policy,
    ensure_family_model_usage_defaults,
    update_family_policy,
)
from app.services.model_usage.subjects import ensure_user_subject
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW as RESERVATION_NOW, set_policy
from tests.model_usage.test_settlement import _signed_successful_llm_receipt


pytest_plugins = (
    "tests.model_usage.test_reservations",
)


NOW = datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc)


@pytest.fixture()
def policy_and_counter(
    model_usage_db: Session,
) -> tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter]:
    family = Family(id="family-alert", name="提醒家庭", motto="", location="")
    owner = User(
        id="owner-alert",
        username="owner-alert",
        display_name="Owner",
        avatar_seed="Owner",
        is_active=True,
    )
    model_usage_db.add_all(
        [
            family,
            owner,
            Membership(
                id="membership-owner-alert",
                family_id=family.id,
                user_id=owner.id,
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            ),
        ]
    )
    model_usage_db.flush()
    subject = ensure_user_subject(model_usage_db, family_id=family.id, user_id=owner.id)
    ensure_family_model_usage_defaults(
        model_usage_db,
        family_id=family.id,
        creator_subject_id=subject.id,
    )
    initial = current_policy(model_usage_db, family_id=family.id)
    policy = update_family_policy(
        model_usage_db,
        PolicyUpdateCommand(
            family_id=family.id,
            base_version_number=initial.version_number,
            monthly_budget_cny=Decimal("100"),
            alerts_enabled=True,
            hard_limit_enabled=False,
            capability_limits=(),
            actor_subject_id=subject.id,
            active_variants=(),
        ),
    )
    period = shanghai_billing_period(NOW)
    counter = ModelUsagePeriodCounter(
        id="counter-alert-family-cost",
        family_id=family.id,
        period_start=period.start_at,
        period_end=period.end_at,
        counter_kind=ModelUsageCounterKind.FAMILY_COST,
        capability=None,
        meter=None,
        dimension_key=family_cost_dimension_key(),
        settled_value=Decimal("0"),
        reserved_value=Decimal("0"),
        adjustment_value=Decimal("0"),
        version=1,
        health_status="healthy",
    )
    model_usage_db.add(counter)
    model_usage_db.flush()
    return policy, counter


def _settled_source_event_with_open_rollup(
    db: Session,
    context: UsageContext,
) -> ModelUsageEvent:
    publish(db, raw_manifest())
    decision = reserve_usage_in_session(
        db,
        context,
        estimate_llm(input_tokens=100, cached_input_tokens=40, max_output_tokens=20),
        fingerprint="fp-adjustment-alert-source",
        at=RESERVATION_NOW,
    )
    dispatch = prepare_usage_dispatch_in_session(
        db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-adjustment-alert-source",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    assert dispatch.permit is not None
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    settlement = settle_usage_in_session(
        db,
        _signed_successful_llm_receipt(dispatch.permit, signer),
        signer=signer,
    )
    event = db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    db.add_all(
        [
            Membership(
                id="membership-owner-reserve-adjustment-alert",
                family_id=event.family_id,
                user_id=context.attribution.actor_user_id or "",
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            ),
            ModelUsageMonthlyRollup(
                id="rollup-adjustment-alert-source",
                family_id=event.family_id,
                period_start=event.period_start,
                period_end=event.period_end,
                rollup_kind=ModelUsageRollupKind.FAMILY_TOTAL,
                dimension_key="family_total",
                subject_id=None,
                subject_key=None,
                capability=None,
                provider=None,
                billing_model=None,
                meter=None,
                local_day=None,
                exact_event_count=1,
                estimated_event_count=0,
                unpriced_event_count=0,
                uncertain_attempt_count=0,
                unresolved_unknown_execution_count=0,
                unresolved_known_unmeasured_count=0,
                has_unknown_measurement_gap=False,
                meter_total=None,
                cost_total_cny=event.cost_cny,
                source_event_count=1,
                source_adjustment_count=0,
                source_incident_count=0,
                revision=1,
                source_watermark="test-adjustment-alert-source",
                checksum="3" * 64,
                correction_status=ModelUsageCorrectionStatus.OPEN,
                adjustment_closed_at=None,
                raw_data_pruned_at=None,
                computed_at=datetime(2026, 7, 30, 3, 2, tzinfo=timezone.utc),
            ),
        ]
    )
    db.flush()
    return event


def test_alerts_are_unique_per_budget_revision_and_threshold(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    counter.settled_value = Decimal("79")
    assert evaluate_budget_alerts(model_usage_db, policy=policy, counter=counter) == ()

    counter.settled_value = Decimal("111")
    alerts = evaluate_budget_alerts(model_usage_db, policy=policy, counter=counter)

    assert [alert.threshold for alert in alerts] == [
        Decimal("0.80"),
        Decimal("1.00"),
        Decimal("1.10"),
    ]
    assert evaluate_budget_alerts(model_usage_db, policy=policy, counter=counter) == ()
    assert model_usage_db.query(ModelUsageAlert).count() == 3
    assert model_usage_db.query(ModelUsageAlertReceipt).count() == 3
    assert {
        receipt.user_id
        for receipt in model_usage_db.scalars(select(ModelUsageAlertReceipt))
    } == {"owner-alert"}


def test_multi_threshold_evaluation_exposes_highest_notification_focus(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    counter.settled_value = Decimal("111")

    evaluation = alerts_service.evaluate_budget_alerts_with_focus(
        model_usage_db,
        policy=policy,
        counter=counter,
    )

    assert [alert.threshold for alert in evaluation.alerts] == [
        Decimal("0.80"),
        Decimal("1.00"),
        Decimal("1.10"),
    ]
    assert evaluation.notification_focus is evaluation.alerts[-1]
    assert evaluation.notification_focus.threshold == Decimal("1.10")


def test_new_revision_repair_inserts_only_highest_without_later_backfill(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    counter.settled_value = Decimal("111")

    repaired = repair_new_budget_revision(
        model_usage_db,
        policy=policy,
        counter=counter,
    )

    assert [alert.threshold for alert in repaired] == [Decimal("1.10")]
    assert evaluate_budget_alerts(model_usage_db, policy=policy, counter=counter) == ()
    assert [
        alert.threshold
        for alert in model_usage_db.scalars(
            select(ModelUsageAlert).order_by(ModelUsageAlert.threshold)
        )
    ] == [Decimal("1.10")]


def test_new_revision_repair_allows_later_higher_crossings(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    counter.settled_value = Decimal("85")
    repaired = repair_new_budget_revision(
        model_usage_db,
        policy=policy,
        counter=counter,
    )
    assert [alert.threshold for alert in repaired] == [Decimal("0.80")]

    counter.settled_value = Decimal("105")
    crossed_later = evaluate_budget_alerts(
        model_usage_db,
        policy=policy,
        counter=counter,
    )

    assert [alert.threshold for alert in crossed_later] == [Decimal("1.00")]


def test_reserved_value_does_not_create_budget_alert(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    counter.reserved_value = Decimal("111")

    assert evaluate_budget_alerts(model_usage_db, policy=policy, counter=counter) == ()
    assert model_usage_db.query(ModelUsageAlert).count() == 0


def test_disabled_alerts_create_no_facts_or_receipts(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    policy.alerts_enabled = False
    counter.settled_value = Decimal("111")

    assert evaluate_budget_alerts(model_usage_db, policy=policy, counter=counter) == ()
    assert model_usage_db.query(ModelUsageAlert).count() == 0
    assert model_usage_db.query(ModelUsageAlertReceipt).count() == 0


def test_each_active_owner_gets_a_receipt_and_members_do_not(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    users = (
        User(
            id="owner-alert-2",
            username="owner-alert-2",
            display_name="Owner 2",
            avatar_seed="Owner2",
            is_active=True,
        ),
        User(
            id="inactive-owner-alert",
            username="inactive-owner-alert",
            display_name="Inactive owner",
            avatar_seed="InactiveOwner",
            is_active=False,
        ),
        User(
            id="member-alert",
            username="member-alert",
            display_name="Member",
            avatar_seed="Member",
            is_active=True,
        ),
        User(
            id="invited-owner-alert",
            username="invited-owner-alert",
            display_name="Invited owner",
            avatar_seed="InvitedOwner",
            is_active=True,
        ),
    )
    model_usage_db.add_all(users)
    model_usage_db.add_all(
        [
            Membership(
                id="membership-owner-alert-2",
                family_id=policy.family_id,
                user_id="owner-alert-2",
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            ),
            Membership(
                id="membership-member-alert",
                family_id=policy.family_id,
                user_id="member-alert",
                role=UserRole.MEMBER,
                status=MembershipStatus.ACTIVE,
            ),
            Membership(
                id="membership-invited-owner-alert",
                family_id=policy.family_id,
                user_id="invited-owner-alert",
                role=UserRole.OWNER,
                status=MembershipStatus.INVITED,
            ),
            Membership(
                id="membership-inactive-owner-alert",
                family_id=policy.family_id,
                user_id="inactive-owner-alert",
                role=UserRole.OWNER,
                status=MembershipStatus.ACTIVE,
            ),
        ]
    )
    counter.settled_value = Decimal("80")

    alerts = evaluate_budget_alerts(model_usage_db, policy=policy, counter=counter)

    assert [alert.threshold for alert in alerts] == [Decimal("0.80")]
    assert {
        receipt.user_id
        for receipt in model_usage_db.scalars(select(ModelUsageAlertReceipt))
    } == {"owner-alert", "owner-alert-2"}


def test_budget_change_repairs_only_highest_crossed_threshold(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    counter.settled_value = Decimal("111")

    updated = update_family_policy(
        model_usage_db,
        PolicyUpdateCommand(
            family_id=policy.family_id,
            base_version_number=policy.version_number,
            monthly_budget_cny=Decimal("50"),
            alerts_enabled=True,
            hard_limit_enabled=False,
            capability_limits=(),
            actor_subject_id=policy.created_by_subject_id,
            active_variants=(),
            effective_at=NOW,
        ),
    )

    alerts = tuple(
        model_usage_db.scalars(
            select(ModelUsageAlert).where(
                ModelUsageAlert.budget_alert_revision
                == updated.budget_alert_revision
            )
        )
    )
    assert [alert.threshold for alert in alerts] == [Decimal("1.10")]
    assert evaluate_budget_alerts(
        model_usage_db,
        policy=updated,
        counter=counter,
    ) == ()


def test_alert_reenable_repairs_only_highest_crossed_threshold(
    model_usage_db: Session,
    policy_and_counter: tuple[ModelUsagePolicyVersion, ModelUsagePeriodCounter],
) -> None:
    policy, counter = policy_and_counter
    disabled = update_family_policy(
        model_usage_db,
        PolicyUpdateCommand(
            family_id=policy.family_id,
            base_version_number=policy.version_number,
            monthly_budget_cny=policy.monthly_budget_cny,
            alerts_enabled=False,
            hard_limit_enabled=False,
            capability_limits=(),
            actor_subject_id=policy.created_by_subject_id,
            active_variants=(),
            effective_at=NOW,
        ),
    )
    counter.settled_value = Decimal("111")

    reenabled = update_family_policy(
        model_usage_db,
        PolicyUpdateCommand(
            family_id=policy.family_id,
            base_version_number=disabled.version_number,
            monthly_budget_cny=disabled.monthly_budget_cny,
            alerts_enabled=True,
            hard_limit_enabled=False,
            capability_limits=(),
            actor_subject_id=policy.created_by_subject_id,
            active_variants=(),
            effective_at=NOW,
        ),
    )

    alerts = tuple(
        model_usage_db.scalars(
            select(ModelUsageAlert).where(
                ModelUsageAlert.budget_alert_revision
                == reenabled.budget_alert_revision
            )
        )
    )
    assert [alert.threshold for alert in alerts] == [Decimal("1.10")]
    assert evaluate_budget_alerts(
        model_usage_db,
        policy=reenabled,
        counter=counter,
    ) == ()


def test_exact_settlement_creates_alerts_after_counter_mutation(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    model_usage_db.add(
        Membership(
            id="membership-owner-reserve-alert",
            family_id=reservation_context.attribution.family_id,
            user_id=reservation_context.attribution.actor_user_id or "",
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
    )
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("0.000001"),
        hard=False,
    )
    publish(model_usage_db, raw_manifest())
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=100, cached_input_tokens=40, max_output_tokens=20),
        fingerprint="fp-alert-settlement",
        at=RESERVATION_NOW,
    )
    dispatch = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-alert-settlement",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    assert dispatch.permit is not None
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})

    settlement = settle_usage_in_session(
        model_usage_db,
        _signed_successful_llm_receipt(dispatch.permit, signer),
        signer=signer,
    )

    alerts = tuple(model_usage_db.scalars(select(ModelUsageAlert)))
    assert [alert.threshold for alert in alerts] == [
        Decimal("0.80"),
        Decimal("1.00"),
        Decimal("1.10"),
    ]
    assert settlement.notification_focus_threshold == Decimal("1.10")


def test_late_settlement_uses_current_policy_revision_after_policy_update(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    model_usage_db.add(
        Membership(
            id="membership-owner-late-settlement-alert",
            family_id=reservation_context.attribution.family_id,
            user_id=reservation_context.attribution.actor_user_id or "",
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
    )
    publish(model_usage_db, raw_manifest())
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=100, cached_input_tokens=40, max_output_tokens=20),
        fingerprint="fp-alert-late-settlement",
        at=RESERVATION_NOW,
    )
    dispatch = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-alert-late-settlement",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    assert dispatch.permit is not None
    admission_policy_id = dispatch.permit.policy_version_id
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("0.000001"),
        hard=False,
    )
    updated = current_policy(
        model_usage_db,
        family_id=reservation_context.attribution.family_id,
    )
    assert updated.id != admission_policy_id
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})

    settle_usage_in_session(
        model_usage_db,
        _signed_successful_llm_receipt(dispatch.permit, signer),
        signer=signer,
    )

    alerts = tuple(model_usage_db.scalars(select(ModelUsageAlert)))
    assert alerts
    assert {alert.policy_version_id for alert in alerts} == {updated.id}
    assert {alert.budget_alert_revision for alert in alerts} == {
        updated.budget_alert_revision
    }


def test_adjustment_creates_alerts_after_adjustment_counter_mutation(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> None:
    settled_source_event = _settled_source_event_with_open_rollup(
        model_usage_db,
        reservation_context,
    )
    assert settled_source_event.cost_cny is not None
    set_policy(
        model_usage_db,
        reservation_context,
        budget=settled_source_event.cost_cny + Decimal("0.001000000000"),
        hard=False,
    )
    command = AdjustmentCommand(
        family_id=settled_source_event.family_id,
        source_event_id=settled_source_event.id,
        source_reservation_id=settled_source_event.reservation_id,
        idempotency_key="adjustment-alert-crossing",
        fingerprint="fp-adjustment-alert-crossing",
        reason_code="provider_meter_correction",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-ALERT",
        evidence_ref="provider:request:alert-crossing",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
                meter=ModelUsageMeter.TOTAL_TOKENS,
                meter_delta=Decimal("1"),
                cost_delta_cny=Decimal("0.001000000000"),
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)

    result = apply_adjustment(
        model_usage_db,
        replace(command, confirm_checksum=preview.checksum),
    )

    alerts = tuple(model_usage_db.scalars(select(ModelUsageAlert)))
    assert [alert.threshold for alert in alerts] == [Decimal("0.80"), Decimal("1.00")]
    assert result.notification_focus is not None
    assert result.notification_focus.threshold == Decimal("1.00")
