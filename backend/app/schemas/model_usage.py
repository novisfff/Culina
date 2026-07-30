from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import (
    ModelUsageCapability,
    ModelUsageIncidentCoverage,
    ModelUsageLimitKind,
    ModelUsageMemberBudgetState,
    ModelUsageMeter,
)


class ModelUsageGapIntervalOut(BaseModel):
    started_at: datetime
    ended_at: datetime
    scope: list[str] = Field(default_factory=list)
    coverage: ModelUsageIncidentCoverage


class ModelUsageMeasurementHealthOut(BaseModel):
    exact_event_count: int
    estimated_event_count: int
    unpriced_event_count: int
    uncertain_attempt_count: int
    pending_attempt_count: int
    unresolved_unknown_execution_attempt_count: int
    conservative_estimated_cost_cny: str | None
    known_unmeasured_attempt_count: int
    measurement_gap: bool
    measurement_gap_scope: list[str] = Field(default_factory=list)
    gap_intervals: list[ModelUsageGapIntervalOut] = Field(default_factory=list)


class ModelUsageMeterTotalOut(BaseModel):
    meter: ModelUsageMeter
    quantity: str


class ModelUsageOverviewBaseOut(BaseModel):
    family_id: str
    period: str
    source: Literal["raw", "rollup"]
    is_partial_period: bool
    tracking_started_at: datetime | None = None
    known_priced_cost_cny: str
    pricing_complete: bool
    unpriced_event_count: int
    total_cost_cny: str | None = None
    meter_totals: list[ModelUsageMeterTotalOut] = Field(default_factory=list)
    measurement_health: ModelUsageMeasurementHealthOut


class ModelUsagePersonalOverviewOut(ModelUsageOverviewBaseOut):
    scope: Literal["me"]
    family_budget_state: ModelUsageMemberBudgetState


class ModelUsageFamilyOverviewOut(ModelUsageOverviewBaseOut):
    scope: Literal["family"]
    monthly_budget_cny: str | None
    effective_spend_cny: str
    reserved_cost_cny: str
    hard_limit_enabled: bool


class ModelUsageBreakdownItemOut(BaseModel):
    label: str
    capability: ModelUsageCapability | None = None
    provider: str | None = None
    billing_model: str | None = None
    meter: ModelUsageMeter | None = None
    meter_total: str | None = None
    local_day: str | None = None
    known_priced_cost_cny: str
    pricing_complete: bool
    unpriced_event_count: int
    total_cost_cny: str | None = None
    measurement_health: ModelUsageMeasurementHealthOut


class ModelUsageBreakdownBaseOut(BaseModel):
    family_id: str
    period: str
    source: Literal["raw", "rollup"]
    is_partial_period: bool
    group_by: Literal[
        "capability",
        "provider_model",
        "subject",
        "meter",
        "daily_capability_cost",
    ]
    items: list[ModelUsageBreakdownItemOut] = Field(default_factory=list)


class ModelUsagePersonalBreakdownOut(ModelUsageBreakdownBaseOut):
    scope: Literal["me"]


class ModelUsageFamilyBreakdownOut(ModelUsageBreakdownBaseOut):
    scope: Literal["family"]


class ModelUsageCapabilityLimitOut(BaseModel):
    capability: ModelUsageCapability
    limit_kind: ModelUsageLimitKind
    meter: ModelUsageMeter | None
    limit_value: str
    enabled: bool


class ModelUsagePolicyOut(BaseModel):
    version_number: int
    monthly_budget_cny: str | None
    alerts_enabled: bool
    hard_limit_enabled: bool
    budget_alert_revision: int
    capability_limits: list[ModelUsageCapabilityLimitOut] = Field(default_factory=list)
    effective_at: datetime


class ModelUsageCapabilityLimitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability: ModelUsageCapability
    limit_kind: ModelUsageLimitKind
    meter: ModelUsageMeter | None = None
    limit_value: Decimal
    enabled: bool = True


class ModelUsagePolicyUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_version_number: int = Field(ge=1)
    monthly_budget_cny: Decimal | None = None
    alerts_enabled: bool
    hard_limit_enabled: bool
    capability_limits: list[ModelUsageCapabilityLimitRequest] = Field(default_factory=list)
    confirm_missing_price_impact: bool = False


class ModelUsageAlertReceiptOut(BaseModel):
    alert_id: str
    seen_at: datetime | None
    dismissed_at: datetime | None


class ModelUsageAlertOut(BaseModel):
    id: str
    period: str
    threshold: str
    budget_cny: str
    settled_value: str
    adjustment_value: str
    effective_spend_cny: str
    severity: str
    created_at: datetime
    seen_at: datetime | None
    dismissed_at: datetime | None
