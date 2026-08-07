from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageCounterKind,
    ModelUsageMeter,
)
from app.core.utils import create_id
from app.models.model_usage import ModelUsagePeriodCounter
from app.services.model_usage.periods import BillingPeriod
from app.services.model_usage.types import UsageContext, UsageEstimate, capability_meter_contract


def family_cost_dimension_key() -> str:
    return "family_cost"


def capability_cost_dimension_key(capability: ModelUsageCapability) -> str:
    return f"capability_cost:{capability.value}"


def capability_meter_dimension_key(
    capability: ModelUsageCapability,
    meter: ModelUsageMeter,
) -> str:
    return f"capability_meter:{capability.value}:{meter.value}"


@dataclass(frozen=True, slots=True)
class CounterKey:
    family_id: str
    period: BillingPeriod
    counter_kind: ModelUsageCounterKind
    capability: ModelUsageCapability | None
    meter: ModelUsageMeter | None
    dimension_key: str


def contract_counter_keys(
    context: UsageContext,
    estimate: UsageEstimate,
    period: BillingPeriod,
) -> tuple[CounterKey, ...]:
    keys = [
        CounterKey(
            family_id=context.attribution.family_id,
            period=period,
            counter_kind=ModelUsageCounterKind.FAMILY_COST,
            capability=None,
            meter=None,
            dimension_key=family_cost_dimension_key(),
        ),
        CounterKey(
            family_id=context.attribution.family_id,
            period=period,
            counter_kind=ModelUsageCounterKind.CAPABILITY_COST,
            capability=context.capability,
            meter=None,
            dimension_key=capability_cost_dimension_key(context.capability),
        ),
    ]
    meters = sorted({line.meter for line in estimate.meters}, key=lambda item: item.value)
    for meter in meters:
        try:
            contract = capability_meter_contract(context.capability, meter)
        except KeyError:
            continue
        if not contract.guardrail_eligible:
            continue
        keys.append(
            CounterKey(
                family_id=context.attribution.family_id,
                period=period,
                counter_kind=ModelUsageCounterKind.CAPABILITY_METER,
                capability=context.capability,
                meter=meter,
                dimension_key=capability_meter_dimension_key(context.capability, meter),
            )
        )
    return tuple(keys)


def _select_counter(
    db: Session,
    key: CounterKey,
) -> ModelUsagePeriodCounter | None:
    return db.scalar(
        select(ModelUsagePeriodCounter)
        .where(
            ModelUsagePeriodCounter.family_id == key.family_id,
            ModelUsagePeriodCounter.period_start == key.period.start_at,
            ModelUsagePeriodCounter.dimension_key == key.dimension_key,
        )
        .with_for_update()
    )


def lock_or_create_counter(db: Session, key: CounterKey) -> ModelUsagePeriodCounter:
    existing = _select_counter(db, key)
    if existing is not None:
        return existing
    candidate = ModelUsagePeriodCounter(
        id=create_id("usage-counter"),
        family_id=key.family_id,
        period_start=key.period.start_at,
        period_end=key.period.end_at,
        counter_kind=key.counter_kind,
        capability=key.capability,
        meter=key.meter,
        dimension_key=key.dimension_key,
        settled_value=Decimal("0"),
        reserved_value=Decimal("0"),
        adjustment_value=Decimal("0"),
        version=1,
        health_status="healthy",
    )
    savepoint = db.begin_nested()
    try:
        db.add(candidate)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
    else:
        savepoint.commit()
    winner = _select_counter(db, key)
    if winner is None:
        raise RuntimeError("model_usage_counter_claim_failed")
    return winner


def effective_counter_value(counter: ModelUsagePeriodCounter) -> Decimal:
    return counter.settled_value + counter.adjustment_value + counter.reserved_value
