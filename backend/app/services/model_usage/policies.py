from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageCounterKind,
    ModelUsageLimitKind,
    ModelUsageMeter,
)
from app.core.config import get_settings
from app.core.utils import create_id, utcnow
from app.models.model_usage import (
    ModelUsageCapabilityLimit,
    ModelUsageFamilyPolicy,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
)
from app.services.model_usage.alerts import repair_new_budget_revision
from app.services.model_usage.configured_variants import (
    ConfiguredUsageVariant,
    configured_usage_variants,
)
from app.services.model_usage.counters import family_cost_dimension_key
from app.services.model_usage.errors import (
    ModelUsagePolicyConflict,
    ModelUsagePolicyValidationError,
)
from app.services.model_usage.periods import shanghai_billing_period
from app.services.model_usage.subjects import ensure_system_subject, require_family_subject
from app.services.model_usage.types import capability_meter_contract


@dataclass(frozen=True, slots=True)
class CapabilityLimitCommand:
    capability: ModelUsageCapability
    limit_kind: ModelUsageLimitKind
    meter: ModelUsageMeter | None
    limit_value: Decimal
    enabled: bool = True


@dataclass(frozen=True, slots=True)
class PolicyUpdateCommand:
    family_id: str
    base_version_number: int
    monthly_budget_cny: Decimal | None
    alerts_enabled: bool
    hard_limit_enabled: bool
    capability_limits: Sequence[CapabilityLimitCommand]
    actor_subject_id: str
    active_variants: Sequence[ConfiguredUsageVariant] | None = None
    effective_at: datetime | None = None


def _validation_error(code: str) -> ModelUsagePolicyValidationError:
    return ModelUsagePolicyValidationError(code)


def _normalize_limit(limit: object) -> CapabilityLimitCommand:
    if isinstance(limit, CapabilityLimitCommand):
        return limit
    if isinstance(limit, ModelUsageCapabilityLimit):
        return CapabilityLimitCommand(
            capability=limit.capability,
            limit_kind=limit.limit_kind,
            meter=limit.meter,
            limit_value=limit.limit_value,
            enabled=limit.enabled,
        )
    raise _validation_error("invalid_capability_limit")


def validate_policy_command(command: PolicyUpdateCommand) -> tuple[CapabilityLimitCommand, ...]:
    budget = command.monthly_budget_cny
    if budget is not None and budget <= 0:
        raise _validation_error("positive_monthly_budget_required")
    limits = tuple(_normalize_limit(limit) for limit in command.capability_limits)
    if (command.hard_limit_enabled or limits) and budget is None:
        raise _validation_error("positive_monthly_budget_required")

    active_variants = (
        tuple(command.active_variants)
        if command.active_variants is not None
        else configured_usage_variants(get_settings())
    )
    seen_capabilities: set[ModelUsageCapability] = set()
    for limit in limits:
        if limit.capability in seen_capabilities:
            raise _validation_error("duplicate_capability_guardrail")
        seen_capabilities.add(limit.capability)
        if limit.limit_value <= 0:
            raise _validation_error("positive_capability_limit_required")
        if limit.limit_kind is ModelUsageLimitKind.COST:
            if limit.meter is not None:
                raise _validation_error("cost_guardrail_forbids_meter")
            continue
        if limit.limit_kind is not ModelUsageLimitKind.METER or limit.meter is None:
            raise _validation_error("meter_guardrail_requires_meter")
        try:
            contract = capability_meter_contract(limit.capability, limit.meter)
        except KeyError as exc:
            raise _validation_error("guardrail_meter_not_supported") from exc
        if (
            not contract.guardrail_eligible
            or not contract.requires_reservation_estimate
            or not contract.requires_settlement_quantity
        ):
            raise _validation_error("guardrail_meter_not_supported")
        variants = tuple(
            variant
            for variant in active_variants
            if variant.capability is limit.capability
        )
        if any(limit.meter not in variant.produced_meters for variant in variants):
            raise _validation_error("guardrail_meter_not_supported")
    return limits


def _policy_checksum(
    *,
    version_number: int,
    monthly_budget_cny: Decimal | None,
    alerts_enabled: bool,
    hard_limit_enabled: bool,
    budget_alert_revision: int,
    limits: Sequence[CapabilityLimitCommand],
) -> str:
    payload = {
        "alerts_enabled": alerts_enabled,
        "budget_alert_revision": budget_alert_revision,
        "capability_limits": [
            {
                "capability": limit.capability.value,
                "enabled": limit.enabled,
                "limit_kind": limit.limit_kind.value,
                "limit_value": str(limit.limit_value),
                "meter": limit.meter.value if limit.meter else None,
            }
            for limit in sorted(limits, key=lambda item: item.capability.value)
        ],
        "hard_limit_enabled": hard_limit_enabled,
        "monthly_budget_cny": str(monthly_budget_cny) if monthly_budget_cny is not None else None,
        "version_number": version_number,
    }
    canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def lock_family_policy(db: Session, *, family_id: str) -> ModelUsageFamilyPolicy:
    pointer = db.scalar(
        select(ModelUsageFamilyPolicy)
        .where(ModelUsageFamilyPolicy.family_id == family_id)
        .with_for_update()
    )
    if pointer is None:
        raise ValueError("model_usage_family_policy_not_found")
    return pointer


def _require_current_policy(
    db: Session,
    pointer: ModelUsageFamilyPolicy,
) -> ModelUsagePolicyVersion:
    policy = db.get(ModelUsagePolicyVersion, pointer.current_policy_version_id)
    if policy is None or policy.family_id != pointer.family_id:
        raise ValueError("model_usage_current_policy_not_found")
    return policy


def current_policy(db: Session, *, family_id: str) -> ModelUsagePolicyVersion:
    pointer = db.get(ModelUsageFamilyPolicy, family_id)
    if pointer is None:
        raise ValueError("model_usage_family_policy_not_found")
    return _require_current_policy(db, pointer)


def policy_limits(
    db: Session,
    *,
    policy_version_id: str,
) -> tuple[CapabilityLimitCommand, ...]:
    rows = tuple(
        db.scalars(
            select(ModelUsageCapabilityLimit)
            .where(ModelUsageCapabilityLimit.policy_version_id == policy_version_id)
            .order_by(ModelUsageCapabilityLimit.capability)
        )
    )
    return tuple(_normalize_limit(row) for row in rows)


def _insert_policy_version(
    db: Session,
    *,
    family_id: str,
    version_number: int,
    monthly_budget_cny: Decimal | None,
    alerts_enabled: bool,
    hard_limit_enabled: bool,
    budget_alert_revision: int,
    limits: Sequence[CapabilityLimitCommand],
    created_by_subject_id: str,
    effective_at: datetime,
) -> ModelUsagePolicyVersion:
    version = ModelUsagePolicyVersion(
        id=create_id("usage-policy"),
        family_id=family_id,
        version_number=version_number,
        monthly_budget_cny=monthly_budget_cny,
        alerts_enabled=alerts_enabled,
        hard_limit_enabled=hard_limit_enabled,
        budget_alert_revision=budget_alert_revision,
        policy_checksum=_policy_checksum(
            version_number=version_number,
            monthly_budget_cny=monthly_budget_cny,
            alerts_enabled=alerts_enabled,
            hard_limit_enabled=hard_limit_enabled,
            budget_alert_revision=budget_alert_revision,
            limits=limits,
        ),
        created_by_subject_id=created_by_subject_id,
        effective_at=effective_at,
    )
    db.add(version)
    db.flush()
    db.add_all(
        [
            ModelUsageCapabilityLimit(
                id=create_id("usage-limit"),
                family_id=family_id,
                policy_version_id=version.id,
                capability=limit.capability,
                limit_kind=limit.limit_kind,
                meter=limit.meter,
                limit_value=limit.limit_value,
                enabled=limit.enabled,
            )
            for limit in limits
        ]
    )
    db.flush()
    return version


def ensure_family_model_usage_defaults(
    db: Session,
    *,
    family_id: str,
    creator_subject_id: str,
) -> ModelUsageFamilyPolicy:
    existing = db.get(ModelUsageFamilyPolicy, family_id)
    if existing is not None:
        return existing
    creator_subject = require_family_subject(
        db,
        family_id=family_id,
        subject_id=creator_subject_id,
    )
    ensure_system_subject(db, family_id=family_id)
    db.flush()
    now = utcnow()
    version = _insert_policy_version(
        db,
        family_id=family_id,
        version_number=1,
        monthly_budget_cny=None,
        alerts_enabled=True,
        hard_limit_enabled=False,
        budget_alert_revision=1,
        limits=(),
        created_by_subject_id=creator_subject.id,
        effective_at=now,
    )
    pointer = ModelUsageFamilyPolicy(
        family_id=family_id,
        current_policy_version_id=version.id,
        tracking_started_at=now,
    )
    db.add(pointer)
    db.flush()
    return pointer


def update_family_policy(
    db: Session,
    command: PolicyUpdateCommand,
) -> ModelUsagePolicyVersion:
    pointer = lock_family_policy(db, family_id=command.family_id)
    existing = _require_current_policy(db, pointer)
    if existing.version_number != command.base_version_number:
        raise ModelUsagePolicyConflict(existing)
    limits = validate_policy_command(command)
    actor = require_family_subject(
        db,
        family_id=command.family_id,
        subject_id=command.actor_subject_id,
    )
    budget_changed = existing.monthly_budget_cny != command.monthly_budget_cny
    alerts_reenabled = not existing.alerts_enabled and command.alerts_enabled
    revision = existing.budget_alert_revision + int(budget_changed or alerts_reenabled)
    effective_at = command.effective_at or utcnow()
    repair_counter: ModelUsagePeriodCounter | None = None
    if budget_changed or alerts_reenabled:
        period = shanghai_billing_period(effective_at)
        repair_counter = db.scalar(
            select(ModelUsagePeriodCounter)
            .where(
                ModelUsagePeriodCounter.family_id == command.family_id,
                ModelUsagePeriodCounter.period_start == period.start_at,
                ModelUsagePeriodCounter.counter_kind
                == ModelUsageCounterKind.FAMILY_COST,
                ModelUsagePeriodCounter.dimension_key
                == family_cost_dimension_key(),
            )
            .with_for_update()
        )
    next_version = _insert_policy_version(
        db,
        family_id=command.family_id,
        version_number=existing.version_number + 1,
        monthly_budget_cny=command.monthly_budget_cny,
        alerts_enabled=command.alerts_enabled,
        hard_limit_enabled=command.hard_limit_enabled,
        budget_alert_revision=revision,
        limits=limits,
        created_by_subject_id=actor.id,
        effective_at=effective_at,
    )
    pointer.current_policy_version_id = next_version.id
    if repair_counter is not None and next_version.alerts_enabled:
        repair_new_budget_revision(
            db,
            policy=next_version,
            counter=repair_counter,
        )
    db.flush()
    return next_version
