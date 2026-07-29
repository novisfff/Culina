from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum as SqlEnum,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.enums import (
    ModelUsageAttributionKind,
    ModelUsageCapability,
    ModelUsageCorrectionStatus,
    ModelUsageCounterKind,
    ModelUsageExecutionCertainty,
    ModelUsageIncidentCoverage,
    ModelUsageIncidentRecoveryStatus,
    ModelUsageLimitKind,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsageOperationSource,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageRecoveryMode,
    ModelUsageReservationStatus,
    ModelUsageResolutionKind,
    ModelUsageRollupKind,
    ModelUsageSubjectKind,
)
from app.core.utils import create_id, utcnow
from app.models.domain import Base


MONEY = Numeric(30, 12)
QUANTITY = Numeric(30, 6)


def _enum_type(enum_class: type) -> SqlEnum:
    return SqlEnum(
        enum_class,
        native_enum=False,
        values_callable=lambda items: [item.value for item in items],
    )


class ModelUsagePriceVersion(Base):
    __tablename__ = "model_usage_price_versions"
    __table_args__ = (
        UniqueConstraint("version_number", name="uq_model_usage_price_version_number"),
        UniqueConstraint("manifest_checksum", name="uq_model_usage_price_manifest_checksum"),
        Index("ix_model_usage_price_version_status_effective", "status", "effective_from"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-price")
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    effective_from: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_ref: Mapped[str] = mapped_column(String(255), nullable=False)
    change_note: Mapped[str] = mapped_column(Text, nullable=False)
    operator: Mapped[str] = mapped_column(String(120), nullable=False)
    change_ticket: Mapped[str | None] = mapped_column(String(160), nullable=True)
    manifest_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    model_aliases_json: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False)
    fx_rates_json: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class ModelUsagePriceRate(Base):
    __tablename__ = "model_usage_price_rates"
    __table_args__ = (
        UniqueConstraint(
            "price_version_id",
            "provider",
            "billing_model",
            "capability",
            "variant_key",
            "billing_scheme_key",
            "meter",
            name="uq_model_usage_price_rate_identity",
        ),
        Index(
            "ix_model_usage_price_rate_lookup",
            "price_version_id",
            "provider",
            "billing_model",
            "capability",
            "variant_key",
        ),
        CheckConstraint("unit_quantity > 0", name="ck_model_usage_price_rate_unit_quantity"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-rate")
    )
    price_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_price_versions.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    billing_model: Mapped[str] = mapped_column(String(160), nullable=False)
    capability: Mapped[ModelUsageCapability] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=False
    )
    variant_key: Mapped[str] = mapped_column(String(255), nullable=False)
    billing_scheme_key: Mapped[str] = mapped_column(String(160), nullable=False)
    meter: Mapped[ModelUsageMeter] = mapped_column(
        _enum_type(ModelUsageMeter), nullable=False
    )
    meter_role: Mapped[ModelUsageMeterRole] = mapped_column(
        _enum_type(ModelUsageMeterRole), nullable=False
    )
    unit_quantity: Mapped[Decimal] = mapped_column(QUANTITY, nullable=False)
    unit_price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    source_currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    fx_to_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    unit_price_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    reported_model_aliases: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ModelUsageSubject(Base):
    __tablename__ = "model_usage_subjects"
    __table_args__ = (
        UniqueConstraint("subject_key", name="uq_model_usage_subject_key"),
        UniqueConstraint("family_id", "user_id", name="uq_model_usage_subject_user"),
        UniqueConstraint(
            "family_id", "dimension_key", name="uq_model_usage_subject_dimension"
        ),
        UniqueConstraint(
            "family_id",
            "anonymized_label",
            name="uq_model_usage_subject_anonymized_label",
        ),
        Index("ix_model_usage_subject_family_kind", "family_id", "subject_kind"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-subject")
    )
    subject_key: Mapped[str] = mapped_column(String(64), nullable=False)
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    subject_kind: Mapped[ModelUsageSubjectKind] = mapped_column(
        _enum_type(ModelUsageSubjectKind), nullable=False
    )
    dimension_key: Mapped[str] = mapped_column(String(160), nullable=False)
    anonymized_label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    unlinked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ModelUsagePolicyVersion(Base):
    __tablename__ = "model_usage_policy_versions"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "version_number",
            name="uq_model_usage_policy_family_version",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-policy")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    monthly_budget_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    alerts_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    hard_limit_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    budget_alert_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    policy_checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_subject_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ModelUsageFamilyPolicy(Base):
    __tablename__ = "model_usage_family_policies"

    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), primary_key=True
    )
    current_policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    tracking_started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class ModelUsageCapabilityLimit(Base):
    __tablename__ = "model_usage_capability_limits"
    __table_args__ = (
        UniqueConstraint(
            "policy_version_id",
            "capability",
            name="uq_model_usage_capability_limit_version_capability",
        ),
        CheckConstraint(
            "(limit_kind = 'cost' AND meter IS NULL) OR "
            "(limit_kind = 'meter' AND meter IS NOT NULL)",
            name="ck_model_usage_capability_limit_meter",
        ),
        CheckConstraint("limit_value >= 0", name="ck_model_usage_capability_limit_value"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-limit")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="CASCADE"), nullable=False
    )
    capability: Mapped[ModelUsageCapability] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=False
    )
    limit_kind: Mapped[ModelUsageLimitKind] = mapped_column(
        _enum_type(ModelUsageLimitKind), nullable=False
    )
    meter: Mapped[ModelUsageMeter | None] = mapped_column(
        _enum_type(ModelUsageMeter), nullable=True
    )
    limit_value: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ModelUsagePeriodCounter(Base):
    __tablename__ = "model_usage_period_counters"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "period_start",
            "dimension_key",
            name="uq_model_usage_counter_dimension",
        ),
        Index("ix_model_usage_counter_family_period", "family_id", "period_start"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-counter")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    counter_kind: Mapped[ModelUsageCounterKind] = mapped_column(
        _enum_type(ModelUsageCounterKind), nullable=False
    )
    capability: Mapped[ModelUsageCapability | None] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=True
    )
    meter: Mapped[ModelUsageMeter | None] = mapped_column(
        _enum_type(ModelUsageMeter), nullable=True
    )
    dimension_key: Mapped[str] = mapped_column(String(255), nullable=False)
    settled_value: Mapped[Decimal] = mapped_column(
        MONEY, nullable=False, default=Decimal("0")
    )
    reserved_value: Mapped[Decimal] = mapped_column(
        MONEY, nullable=False, default=Decimal("0")
    )
    adjustment_value: Mapped[Decimal] = mapped_column(
        MONEY, nullable=False, default=Decimal("0")
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    health_status: Mapped[str] = mapped_column(String(32), nullable=False, default="healthy")
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class ModelUsageReservation(Base):
    __tablename__ = "model_usage_reservations"
    __table_args__ = (
        UniqueConstraint(
            "family_id", "attempt_key", name="uq_model_usage_reservation_attempt"
        ),
        Index(
            "ix_model_usage_reservation_status_expiry",
            "status",
            "expires_at",
        ),
        Index(
            "ix_model_usage_reservation_family_period",
            "family_id",
            "period_start",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-reservation")
    )
    attempt_key: Mapped[str] = mapped_column(String(255), nullable=False)
    client_attempt_id: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    subject_key: Mapped[str] = mapped_column(String(64), nullable=False)
    attribution_kind: Mapped[ModelUsageAttributionKind] = mapped_column(
        _enum_type(ModelUsageAttributionKind), nullable=False
    )
    operation_source: Mapped[ModelUsageOperationSource] = mapped_column(
        _enum_type(ModelUsageOperationSource), nullable=False
    )
    logical_operation_id: Mapped[str] = mapped_column(String(160), nullable=False)
    operation_kind: Mapped[str] = mapped_column(String(120), nullable=False)
    capability: Mapped[ModelUsageCapability] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    requested_model: Mapped[str] = mapped_column(String(160), nullable=False)
    billing_model: Mapped[str] = mapped_column(String(160), nullable=False)
    variant_key: Mapped[str] = mapped_column(String(255), nullable=False)
    billing_scheme_key: Mapped[str] = mapped_column(String(160), nullable=False)
    recovery_mode: Mapped[ModelUsageRecoveryMode] = mapped_column(
        _enum_type(ModelUsageRecoveryMode), nullable=False
    )
    idempotency_window_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    query_window_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    automatic_resend_deadline_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    provider_idempotency_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    dispatch_policy_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=True
    )
    pre_dispatch_denial_policy_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=True
    )
    pricing_status: Mapped[ModelUsagePricingStatus] = mapped_column(
        _enum_type(ModelUsagePricingStatus), nullable=False
    )
    price_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_price_versions.id", ondelete="RESTRICT"), nullable=True
    )
    price_snapshot_checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reserved_cost_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    status: Mapped[ModelUsageReservationStatus] = mapped_column(
        _enum_type(ModelUsageReservationStatus), nullable=False
    )
    provider_request_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reserved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    dispatching_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    provider_acknowledged_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )
    error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)


class ModelUsageReservationMeter(Base):
    __tablename__ = "model_usage_reservation_meters"
    __table_args__ = (
        UniqueConstraint(
            "reservation_id", "meter_key", name="uq_model_usage_reservation_meter_key"
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-reserved-meter")
    )
    reservation_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_reservations.id", ondelete="CASCADE"), nullable=False
    )
    meter_key: Mapped[str] = mapped_column(String(160), nullable=False)
    meter: Mapped[ModelUsageMeter] = mapped_column(
        _enum_type(ModelUsageMeter), nullable=False
    )
    meter_role: Mapped[ModelUsageMeterRole] = mapped_column(
        _enum_type(ModelUsageMeterRole), nullable=False
    )
    reserved_quantity: Mapped[Decimal] = mapped_column(QUANTITY, nullable=False)
    unit_quantity: Mapped[Decimal | None] = mapped_column(QUANTITY, nullable=True)
    source_unit_price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    source_currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    fx_to_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    unit_price_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    reserved_cost_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)


class ModelUsageEvent(Base):
    __tablename__ = "model_usage_events"
    __table_args__ = (
        UniqueConstraint("family_id", "attempt_key", name="uq_model_usage_event_attempt"),
        Index("ix_model_usage_event_family_period", "family_id", "period_start"),
        Index("ix_model_usage_event_completed", "completed_at"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-event")
    )
    reservation_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_reservations.id", ondelete="RESTRICT"),
        unique=True,
        nullable=True,
    )
    recovery_source: Mapped[str] = mapped_column(String(32), nullable=False)
    attempt_key: Mapped[str] = mapped_column(String(255), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    client_attempt_id: Mapped[str] = mapped_column(String(160), nullable=False)
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    subject_key: Mapped[str] = mapped_column(String(64), nullable=False)
    capability: Mapped[ModelUsageCapability] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    requested_model: Mapped[str] = mapped_column(String(160), nullable=False)
    reported_model: Mapped[str | None] = mapped_column(String(160), nullable=True)
    billing_model: Mapped[str] = mapped_column(String(160), nullable=False)
    variant_key: Mapped[str] = mapped_column(String(255), nullable=False)
    billing_scheme_key: Mapped[str] = mapped_column(String(160), nullable=False)
    pricing_status: Mapped[ModelUsagePricingStatus] = mapped_column(
        _enum_type(ModelUsagePricingStatus), nullable=False
    )
    price_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_price_versions.id", ondelete="RESTRICT"), nullable=True
    )
    price_snapshot_checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    dispatch_policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    provider_outcome: Mapped[ModelUsageProviderOutcome] = mapped_column(
        _enum_type(ModelUsageProviderOutcome), nullable=False
    )
    execution_certainty: Mapped[ModelUsageExecutionCertainty] = mapped_column(
        _enum_type(ModelUsageExecutionCertainty), nullable=False
    )
    measurement_status: Mapped[ModelUsageMeasurementStatus] = mapped_column(
        _enum_type(ModelUsageMeasurementStatus), nullable=False
    )
    provider_reported_source_cost: Mapped[Decimal | None] = mapped_column(
        MONEY, nullable=True
    )
    provider_reported_source_currency: Mapped[str | None] = mapped_column(
        String(8), nullable=True
    )
    cost_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    provider_request_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    dispatched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    estimation_reason: Mapped[str | None] = mapped_column(String(160), nullable=True)
    stable_error_code: Mapped[str | None] = mapped_column(String(120), nullable=True)
    fail_open_proof_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ModelUsageEventMeter(Base):
    __tablename__ = "model_usage_event_meters"
    __table_args__ = (
        UniqueConstraint("event_id", "meter_key", name="uq_model_usage_event_meter_key"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-event-meter")
    )
    event_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_events.id", ondelete="CASCADE"), nullable=False
    )
    meter_key: Mapped[str] = mapped_column(String(160), nullable=False)
    meter: Mapped[ModelUsageMeter] = mapped_column(
        _enum_type(ModelUsageMeter), nullable=False
    )
    meter_role: Mapped[ModelUsageMeterRole] = mapped_column(
        _enum_type(ModelUsageMeterRole), nullable=False
    )
    quantity: Mapped[Decimal] = mapped_column(QUANTITY, nullable=False)
    quantity_source: Mapped[ModelUsageQuantitySource] = mapped_column(
        _enum_type(ModelUsageQuantitySource), nullable=False
    )
    unit_quantity: Mapped[Decimal | None] = mapped_column(QUANTITY, nullable=True)
    source_unit_price: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    source_currency: Mapped[str | None] = mapped_column(String(8), nullable=True)
    fx_to_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    unit_price_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    cost_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)


class ModelUsageAdjustmentGroup(Base):
    __tablename__ = "model_usage_adjustment_groups"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "idempotency_key",
            name="uq_model_usage_adjustment_group_key",
        ),
        Index("ix_model_usage_adjustment_group_period", "family_id", "period_start"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-adjustment")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    idempotency_key: Mapped[str] = mapped_column(String(160), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    subject_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=False
    )
    subject_key: Mapped[str] = mapped_column(String(64), nullable=False)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_event_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_events.id", ondelete="RESTRICT"), nullable=False
    )
    source_reservation_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_reservations.id", ondelete="RESTRICT"), nullable=True
    )
    reason_code: Mapped[str] = mapped_column(String(120), nullable=False)
    operator: Mapped[str] = mapped_column(String(120), nullable=False)
    change_ticket: Mapped[str] = mapped_column(String(160), nullable=False)
    evidence_ref: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ModelUsageAdjustment(Base):
    __tablename__ = "model_usage_adjustments"
    __table_args__ = (
        UniqueConstraint(
            "adjustment_group_id",
            "line_sequence",
            name="uq_model_usage_adjustment_line_sequence",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-adjustment-line")
    )
    adjustment_group_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_adjustment_groups.id", ondelete="CASCADE"), nullable=False
    )
    line_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    capability: Mapped[ModelUsageCapability] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=False
    )
    meter: Mapped[ModelUsageMeter | None] = mapped_column(
        _enum_type(ModelUsageMeter), nullable=True
    )
    meter_delta: Mapped[Decimal | None] = mapped_column(QUANTITY, nullable=True)
    cost_delta_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    resolution_kind: Mapped[ModelUsageResolutionKind] = mapped_column(
        _enum_type(ModelUsageResolutionKind), nullable=False
    )
    resulting_provider_outcome: Mapped[ModelUsageProviderOutcome | None] = mapped_column(
        _enum_type(ModelUsageProviderOutcome), nullable=True
    )
    resulting_execution_certainty: Mapped[
        ModelUsageExecutionCertainty | None
    ] = mapped_column(_enum_type(ModelUsageExecutionCertainty), nullable=True)
    resulting_measurement_status: Mapped[
        ModelUsageMeasurementStatus | None
    ] = mapped_column(_enum_type(ModelUsageMeasurementStatus), nullable=True)
    resulting_pricing_status: Mapped[ModelUsagePricingStatus | None] = mapped_column(
        _enum_type(ModelUsagePricingStatus), nullable=True
    )
    price_snapshot_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    price_snapshot_checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolved_cost_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ModelUsageMonthlyRollup(Base):
    __tablename__ = "model_usage_monthly_rollups"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "period_start",
            "dimension_key",
            name="uq_model_usage_rollup_dimension",
        ),
        Index("ix_model_usage_rollup_family_period", "family_id", "period_start"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-rollup")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    rollup_kind: Mapped[ModelUsageRollupKind] = mapped_column(
        _enum_type(ModelUsageRollupKind), nullable=False
    )
    dimension_key: Mapped[str] = mapped_column(String(255), nullable=False)
    subject_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=True
    )
    subject_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    capability: Mapped[ModelUsageCapability | None] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=True
    )
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    billing_model: Mapped[str | None] = mapped_column(String(160), nullable=True)
    meter: Mapped[ModelUsageMeter | None] = mapped_column(
        _enum_type(ModelUsageMeter), nullable=True
    )
    local_day: Mapped[date | None] = mapped_column(Date, nullable=True)
    exact_event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    estimated_event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unpriced_event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    uncertain_attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unresolved_unknown_execution_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    unresolved_known_unmeasured_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    has_unknown_measurement_gap: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    meter_total: Mapped[Decimal | None] = mapped_column(QUANTITY, nullable=True)
    cost_total_cny: Mapped[Decimal | None] = mapped_column(MONEY, nullable=True)
    source_event_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_adjustment_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_incident_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    source_watermark: Mapped[str] = mapped_column(String(255), nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    correction_status: Mapped[ModelUsageCorrectionStatus] = mapped_column(
        _enum_type(ModelUsageCorrectionStatus), nullable=False
    )
    adjustment_closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    raw_data_pruned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class ModelUsageAlert(Base):
    __tablename__ = "model_usage_alerts"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "period_start",
            "budget_alert_revision",
            "threshold",
            name="uq_model_usage_alert_threshold",
        ),
        Index("ix_model_usage_alert_family_period", "family_id", "period_start"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-alert")
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    policy_version_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    budget_alert_revision: Mapped[int] = mapped_column(Integer, nullable=False)
    threshold: Mapped[Decimal] = mapped_column(Numeric(6, 3), nullable=False)
    budget_cny: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    settled_value: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    adjustment_value: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    effective_spend_cny: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    severity: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ModelUsageAlertReceipt(Base):
    __tablename__ = "model_usage_alert_receipts"
    __table_args__ = (
        UniqueConstraint(
            "alert_id", "user_id", name="uq_model_usage_alert_receipt_owner"
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-alert-receipt")
    )
    alert_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_alerts.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )


class ModelUsageMeasurementIncident(Base):
    __tablename__ = "model_usage_measurement_incidents"
    __table_args__ = (
        UniqueConstraint("incident_key", name="uq_model_usage_incident_key"),
        Index("ix_model_usage_incident_period", "period_start", "period_end"),
        Index("ix_model_usage_incident_family_period", "family_id", "period_start"),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-incident")
    )
    incident_key: Mapped[str] = mapped_column(String(160), nullable=False)
    family_id: Mapped[str | None] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=True
    )
    subject_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=True
    )
    subject_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    capability: Mapped[ModelUsageCapability | None] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=True
    )
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    cause_code: Mapped[str] = mapped_column(String(120), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    recovered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    coverage: Mapped[ModelUsageIncidentCoverage] = mapped_column(
        _enum_type(ModelUsageIncidentCoverage), nullable=False
    )
    source_instance: Mapped[str] = mapped_column(String(160), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class ModelUsageMeasurementIncidentAttempt(Base):
    __tablename__ = "model_usage_measurement_incident_attempts"
    __table_args__ = (
        UniqueConstraint(
            "family_id",
            "client_attempt_id",
            name="uq_model_usage_incident_attempt_family_client",
        ),
        Index(
            "ix_model_usage_incident_attempt_recovery",
            "incident_id",
            "recovery_status",
        ),
    )

    id: Mapped[str] = mapped_column(
        String(64), primary_key=True, default=lambda: create_id("usage-gap-attempt")
    )
    incident_id: Mapped[str] = mapped_column(
        ForeignKey("model_usage_measurement_incidents.id", ondelete="CASCADE"),
        nullable=False,
    )
    family_id: Mapped[str] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), nullable=False
    )
    subject_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_subjects.id", ondelete="RESTRICT"), nullable=True
    )
    capability: Mapped[ModelUsageCapability | None] = mapped_column(
        _enum_type(ModelUsageCapability), nullable=True
    )
    client_attempt_id: Mapped[str] = mapped_column(String(160), nullable=False)
    recovery_status: Mapped[ModelUsageIncidentRecoveryStatus] = mapped_column(
        _enum_type(ModelUsageIncidentRecoveryStatus), nullable=False
    )
    recovered_event_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_usage_events.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
