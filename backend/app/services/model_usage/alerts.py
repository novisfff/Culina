from __future__ import annotations

from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import MembershipStatus, ModelUsageCounterKind, UserRole
from app.core.utils import create_id
from app.models.domain import Membership
from app.models.model_usage import (
    ModelUsageAlert,
    ModelUsageAlertReceipt,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
)
from app.services.model_usage.counters import family_cost_dimension_key
from app.services.model_usage.errors import ModelUsageContractError


ALERT_THRESHOLDS: tuple[Decimal, ...] = (
    Decimal("0.80"),
    Decimal("1.00"),
    Decimal("1.10"),
)


def effective_alert_spend(counter: ModelUsagePeriodCounter) -> Decimal:
    return counter.settled_value + counter.adjustment_value


def _validate_family_cost_counter(
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
) -> None:
    if (
        counter.family_id != policy.family_id
        or counter.counter_kind is not ModelUsageCounterKind.FAMILY_COST
        or counter.dimension_key != family_cost_dimension_key()
    ):
        raise ModelUsageContractError("alert_family_cost_counter_required")


def crossed_alert_thresholds(
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
) -> tuple[Decimal, ...]:
    _validate_family_cost_counter(policy, counter)
    return crossed_alert_thresholds_for_spend(
        policy,
        effective_spend=effective_alert_spend(counter),
    )


def crossed_alert_thresholds_for_spend(
    policy: ModelUsagePolicyVersion,
    *,
    effective_spend: Decimal,
) -> tuple[Decimal, ...]:
    if (
        not policy.alerts_enabled
        or policy.monthly_budget_cny is None
        or policy.monthly_budget_cny <= 0
    ):
        return ()
    return tuple(
        threshold
        for threshold in ALERT_THRESHOLDS
        if effective_spend >= policy.monthly_budget_cny * threshold
    )


def _existing_alert_for_update(
    db: Session,
    *,
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
    threshold: Decimal,
) -> ModelUsageAlert | None:
    return db.scalar(
        select(ModelUsageAlert)
        .where(
            ModelUsageAlert.family_id == policy.family_id,
            ModelUsageAlert.period_start == counter.period_start,
            ModelUsageAlert.budget_alert_revision == policy.budget_alert_revision,
            ModelUsageAlert.threshold == threshold,
        )
        .with_for_update()
    )


def _highest_existing_threshold(
    db: Session,
    *,
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
) -> Decimal | None:
    return db.scalar(
        select(func.max(ModelUsageAlert.threshold)).where(
            ModelUsageAlert.family_id == policy.family_id,
            ModelUsageAlert.period_start == counter.period_start,
            ModelUsageAlert.budget_alert_revision == policy.budget_alert_revision,
        )
    )


def pending_budget_alert_thresholds(
    db: Session,
    *,
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
    effective_spend: Decimal | None = None,
) -> tuple[Decimal, ...]:
    _validate_family_cost_counter(policy, counter)
    crossed = crossed_alert_thresholds_for_spend(
        policy,
        effective_spend=(
            effective_alert_spend(counter)
            if effective_spend is None
            else effective_spend
        ),
    )
    highest_existing = _highest_existing_threshold(
        db,
        policy=policy,
        counter=counter,
    )
    if highest_existing is None:
        return crossed
    return tuple(threshold for threshold in crossed if threshold > highest_existing)


def _active_owner_user_ids(db: Session, *, family_id: str) -> tuple[str, ...]:
    return tuple(
        db.scalars(
            select(Membership.user_id)
            .where(
                Membership.family_id == family_id,
                Membership.role == UserRole.OWNER,
                Membership.status == MembershipStatus.ACTIVE,
            )
            .order_by(Membership.user_id)
        )
    )


def _severity_for(threshold: Decimal) -> str:
    return "warning" if threshold < Decimal("1.00") else "critical"


def _claim_alert(
    db: Session,
    *,
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
    threshold: Decimal,
) -> ModelUsageAlert | None:
    if (
        _existing_alert_for_update(
            db,
            policy=policy,
            counter=counter,
            threshold=threshold,
        )
        is not None
    ):
        return None
    spend = effective_alert_spend(counter)
    alert = ModelUsageAlert(
        id=create_id("usage-alert"),
        family_id=policy.family_id,
        period_start=counter.period_start,
        period_end=counter.period_end,
        policy_version_id=policy.id,
        budget_alert_revision=policy.budget_alert_revision,
        threshold=threshold,
        budget_cny=policy.monthly_budget_cny,
        settled_value=counter.settled_value,
        adjustment_value=counter.adjustment_value,
        effective_spend_cny=spend,
        severity=_severity_for(threshold),
    )
    savepoint = db.begin_nested()
    try:
        db.add(alert)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
        return None
    else:
        savepoint.commit()
    for owner_user_id in _active_owner_user_ids(db, family_id=policy.family_id):
        db.add(
            ModelUsageAlertReceipt(
                id=create_id("usage-alert-receipt"),
                alert_id=alert.id,
                user_id=owner_user_id,
            )
        )
    db.flush()
    return alert


def evaluate_budget_alerts(
    db: Session,
    *,
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
) -> tuple[ModelUsageAlert, ...]:
    """Append threshold facts for a settled/adjusted family-cost counter.

    Reservation values intentionally do not participate: an alert represents spend
    that is already settled or has been corrected in the append-only ledger.
    """

    return tuple(
        alert
        for threshold in pending_budget_alert_thresholds(
            db,
            policy=policy,
            counter=counter,
        )
        if (
            alert := _claim_alert(
                db,
                policy=policy,
                counter=counter,
                threshold=threshold,
            )
        )
        is not None
    )


def repair_new_budget_revision(
    db: Session,
    *,
    policy: ModelUsagePolicyVersion,
    counter: ModelUsagePeriodCounter,
) -> tuple[ModelUsageAlert, ...]:
    """Create only the highest current threshold for a newly effective revision."""

    thresholds = crossed_alert_thresholds(policy, counter)
    if not thresholds:
        return ()
    alert = _claim_alert(
        db,
        policy=policy,
        counter=counter,
        threshold=thresholds[-1],
    )
    return () if alert is None else (alert,)
