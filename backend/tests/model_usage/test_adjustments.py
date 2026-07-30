from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.core.enums import (
    MembershipStatus,
    ModelUsageCorrectionStatus,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageResolutionKind,
    ModelUsageRollupKind,
    UserRole,
)
from app.models.domain import Membership
from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageEvent,
    ModelUsageEventMeter,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsageReservation,
)
from app.services.model_usage.adjustments import (
    AdjustmentCommand,
    AdjustmentLineCommand,
    apply_adjustment,
    preview_adjustment,
)
from app.services.model_usage.alerts import evaluate_budget_alerts
from app.services.model_usage.counters import (
    capability_meter_dimension_key,
    family_cost_dimension_key,
)
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.estimators import estimate_llm
from app.services.model_usage.errors import ModelUsageAdjustmentConflict
from app.services.model_usage.errors import (
    ModelUsageAdjustmentValidationError,
    ModelUsageAdjustmentWindowClosed,
)
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.recovery import (
    mark_dispatch_uncertain,
    settle_expired_uncertain_in_session,
)
from app.services.model_usage.reservations import reserve_usage_in_session
from app.services.model_usage.settlement import settle_usage_in_session
from app.services.model_usage.types import ProviderRecoveryPolicy, UsageContext
from app.services.model_usage.pricing import UsagePriceRateSnapshot, UsagePriceSnapshot
from app.services.model_usage.policies import current_policy
from tests.model_usage.test_pricing_service import publish, raw_manifest
from tests.model_usage.test_reservations import NOW, set_policy
from tests.model_usage.test_settlement import _signed_successful_llm_receipt


pytest_plugins = ("tests.model_usage.test_reservations",)


@pytest.fixture()
def settled_source_event(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> ModelUsageEvent:
    publish(model_usage_db, raw_manifest())
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=100, cached_input_tokens=40, max_output_tokens=20),
        fingerprint="fp-adjustment-source",
        at=NOW,
    )
    dispatch = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-adjustment-source",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    assert dispatch.permit is not None
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    settlement = settle_usage_in_session(
        model_usage_db,
        _signed_successful_llm_receipt(dispatch.permit, signer),
        signer=signer,
    )
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    model_usage_db.add(
        Membership(
            id="membership-owner-reserve",
            family_id=event.family_id,
            user_id="owner-reserve",
            role=UserRole.OWNER,
            status=MembershipStatus.ACTIVE,
        )
    )
    model_usage_db.add(
        ModelUsageMonthlyRollup(
            id="rollup-adjustment-source",
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
            source_watermark="test-source",
            checksum="0" * 64,
            correction_status=ModelUsageCorrectionStatus.OPEN,
            adjustment_closed_at=None,
            raw_data_pruned_at=None,
            computed_at=datetime(2026, 7, 30, 3, 2, tzinfo=timezone.utc),
        )
    )
    model_usage_db.flush()
    return event


@pytest.fixture()
def unpriced_source_event(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> ModelUsageEvent:
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=100, cached_input_tokens=40, max_output_tokens=20),
        fingerprint="fp-unpriced-adjustment-source",
        at=NOW,
    )
    dispatch = prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-unpriced-adjustment-source",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    assert dispatch.permit is not None
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    settlement = settle_usage_in_session(
        model_usage_db,
        _signed_successful_llm_receipt(dispatch.permit, signer),
        signer=signer,
    )
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.pricing_status is ModelUsagePricingStatus.UNPRICED
    model_usage_db.add(
        ModelUsageMonthlyRollup(
            id="rollup-unpriced-adjustment-source",
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
            unpriced_event_count=1,
            uncertain_attempt_count=0,
            unresolved_unknown_execution_count=0,
            unresolved_known_unmeasured_count=0,
            has_unknown_measurement_gap=False,
            meter_total=None,
            cost_total_cny=None,
            source_event_count=1,
            source_adjustment_count=0,
            source_incident_count=0,
            revision=1,
            source_watermark="test-unpriced-source",
            checksum="1" * 64,
            correction_status=ModelUsageCorrectionStatus.OPEN,
            adjustment_closed_at=None,
            raw_data_pruned_at=None,
            computed_at=datetime(2026, 7, 30, 3, 2, tzinfo=timezone.utc),
        )
    )
    model_usage_db.flush()
    return event


@pytest.fixture()
def unknown_source_event(
    model_usage_db: Session,
    reservation_context: UsageContext,
) -> ModelUsageEvent:
    publish(model_usage_db, raw_manifest())
    decision = reserve_usage_in_session(
        model_usage_db,
        reservation_context,
        estimate_llm(input_tokens=10, cached_input_tokens=0, max_output_tokens=10),
        fingerprint="fp-unknown-adjustment-source",
        at=NOW,
    )
    prepare_usage_dispatch_in_session(
        model_usage_db,
        reservation_id=decision.reservation_id or "",
        fingerprint="fp-unknown-adjustment-source",
        recovery_policy=ProviderRecoveryPolicy.none(),
    )
    reservation = model_usage_db.get(ModelUsageReservation, decision.reservation_id)
    assert reservation is not None and reservation.dispatching_at is not None
    mark_dispatch_uncertain(model_usage_db, reservation_id=reservation.id)
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    settlement = settle_expired_uncertain_in_session(
        model_usage_db,
        reservation_id=reservation.id,
        at=reservation.dispatching_at + timedelta(hours=24),
        signer=signer,
    )
    assert settlement is not None
    event = model_usage_db.get(ModelUsageEvent, settlement.event_id)
    assert event is not None
    assert event.execution_certainty is ModelUsageExecutionCertainty.UNKNOWN
    model_usage_db.add(
        ModelUsageMonthlyRollup(
            id="rollup-unknown-adjustment-source",
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
            exact_event_count=0,
            estimated_event_count=1,
            unpriced_event_count=0,
            uncertain_attempt_count=0,
            unresolved_unknown_execution_count=1,
            unresolved_known_unmeasured_count=0,
            has_unknown_measurement_gap=False,
            meter_total=None,
            cost_total_cny=event.cost_cny,
            source_event_count=1,
            source_adjustment_count=0,
            source_incident_count=0,
            revision=1,
            source_watermark="test-unknown-source",
            checksum="2" * 64,
            correction_status=ModelUsageCorrectionStatus.OPEN,
            adjustment_closed_at=None,
            raw_data_pruned_at=None,
            computed_at=datetime(2026, 7, 31, 3, 2, tzinfo=timezone.utc),
        )
    )
    model_usage_db.flush()
    return event


def evidence_snapshot(
    *,
    complete: bool,
    billing_scheme_key: str = "tokens-v1",
) -> UsagePriceSnapshot:
    rates = (
        UsagePriceRateSnapshot(
            meter=ModelUsageMeter.UNCACHED_INPUT_TOKENS,
            meter_role=ModelUsageMeterRole.BILLABLE,
            unit_quantity=Decimal("1"),
            unit_price=Decimal("1"),
            source_currency="CNY",
            fx_to_cny=Decimal("1"),
            unit_price_cny=Decimal("1"),
        ),
        UsagePriceRateSnapshot(
            meter=ModelUsageMeter.CACHED_INPUT_TOKENS,
            meter_role=ModelUsageMeterRole.BILLABLE,
            unit_quantity=Decimal("1"),
            unit_price=Decimal("1"),
            source_currency="CNY",
            fx_to_cny=Decimal("1"),
            unit_price_cny=Decimal("1"),
        ),
        UsagePriceRateSnapshot(
            meter=ModelUsageMeter.OUTPUT_TOKENS,
            meter_role=ModelUsageMeterRole.BILLABLE,
            unit_quantity=Decimal("1"),
            unit_price=Decimal("1"),
            source_currency="CNY",
            fx_to_cny=Decimal("1"),
            unit_price_cny=Decimal("1"),
        ),
    )
    return UsagePriceSnapshot(
        pricing_status=ModelUsagePricingStatus.PRICED,
        price_version_id="evidence-price-v1",
        billing_model="gpt-test",
        billing_scheme_key=billing_scheme_key,
        rates=rates if complete else rates[:1],
        missing_billable_meters=frozenset(),
        checksum="e" * 64,
    )


@pytest.fixture()
def meter_correction_command(settled_source_event: ModelUsageEvent) -> AdjustmentCommand:
    return AdjustmentCommand(
        family_id=settled_source_event.family_id,
        source_event_id=settled_source_event.id,
        source_reservation_id=settled_source_event.reservation_id,
        idempotency_key="adjustment-meter-correction-1",
        fingerprint="fp-adjustment-meter-correction-1",
        reason_code="provider_meter_correction",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-1",
        evidence_ref="provider:request:adjustment-source",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
                meter=ModelUsageMeter.TOTAL_TOKENS,
                meter_delta=Decimal("-10"),
            ),
        ),
    )


def test_group_replay_is_idempotent_and_conflicting_fingerprint_is_rejected(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
    meter_correction_command: AdjustmentCommand,
) -> None:
    preview = preview_adjustment(model_usage_db, meter_correction_command)
    command = replace(meter_correction_command, confirm_checksum=preview.checksum)

    first = apply_adjustment(model_usage_db, command)
    replay = apply_adjustment(model_usage_db, command)

    assert first.group.id == replay.group.id
    assert model_usage_db.query(ModelUsageAdjustmentGroup).count() == 1
    assert model_usage_db.query(ModelUsageAdjustment).count() == 1
    counter = model_usage_db.scalar(
        select(ModelUsagePeriodCounter).where(
            ModelUsagePeriodCounter.family_id == settled_source_event.family_id,
            ModelUsagePeriodCounter.period_start == settled_source_event.period_start,
            ModelUsagePeriodCounter.dimension_key
            == capability_meter_dimension_key(
                settled_source_event.capability,
                ModelUsageMeter.TOTAL_TOKENS,
            ),
        )
    )
    assert counter is not None
    assert counter.adjustment_value == Decimal("-10")

    with pytest.raises(ModelUsageAdjustmentConflict, match="model_usage_adjustment_conflict"):
        apply_adjustment(model_usage_db, replace(command, fingerprint="other-fingerprint"))


def test_one_group_can_hold_multiple_ordered_lines(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
    meter_correction_command: AdjustmentCommand,
) -> None:
    command = replace(
        meter_correction_command,
        idempotency_key="adjustment-multi-line-1",
        lines=(
            meter_correction_command.lines[0],
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
                meter=ModelUsageMeter.INPUT_TOKENS,
                meter_delta=Decimal("-5"),
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)

    result = apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))

    assert [line.line_sequence for line in result.lines] == [1, 2]
    assert {line.adjustment_group_id for line in result.lines} == {result.group.id}
    assert result.effective.quantity(ModelUsageMeter.TOTAL_TOKENS) == Decimal("100")
    assert result.effective.quantity(ModelUsageMeter.INPUT_TOKENS) == Decimal("95")


def test_multi_meter_counter_deltas_apply_in_stable_meter_order(
    model_usage_db: Session,
    meter_correction_command: AdjustmentCommand,
) -> None:
    command = replace(
        meter_correction_command,
        idempotency_key="adjustment-stable-meter-order",
        fingerprint="fp-adjustment-stable-meter-order",
        lines=(
            meter_correction_command.lines[0],
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
                meter=ModelUsageMeter.INPUT_TOKENS,
                meter_delta=Decimal("-5"),
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)
    mutation_order: list[ModelUsageMeter] = []

    def record_meter_mutation(
        target: ModelUsagePeriodCounter,
        _value: object,
        _old_value: object,
        _initiator: object,
    ) -> None:
        if target.meter is not None:
            mutation_order.append(target.meter)

    event.listen(
        ModelUsagePeriodCounter.adjustment_value,
        "set",
        record_meter_mutation,
    )
    try:
        apply_adjustment(
            model_usage_db,
            replace(command, confirm_checksum=preview.checksum),
        )
    finally:
        event.remove(
            ModelUsagePeriodCounter.adjustment_value,
            "set",
            record_meter_mutation,
        )

    assert mutation_order == [
        ModelUsageMeter.INPUT_TOKENS,
        ModelUsageMeter.TOTAL_TOKENS,
    ]


def test_preview_projects_counters_alerts_and_rollup_without_mutation(
    model_usage_db: Session,
    reservation_context: UsageContext,
    settled_source_event: ModelUsageEvent,
    meter_correction_command: AdjustmentCommand,
) -> None:
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=False,
    )
    counters = tuple(
        model_usage_db.scalars(
            select(ModelUsagePeriodCounter)
            .where(
                ModelUsagePeriodCounter.family_id == settled_source_event.family_id,
                ModelUsagePeriodCounter.period_start == settled_source_event.period_start,
            )
            .order_by(ModelUsagePeriodCounter.dimension_key)
        )
    )
    family_counter = next(
        counter
        for counter in counters
        if counter.dimension_key == family_cost_dimension_key()
    )
    family_counter.settled_value = Decimal("79")
    rollup = model_usage_db.scalar(
        select(ModelUsageMonthlyRollup).where(
            ModelUsageMonthlyRollup.family_id == settled_source_event.family_id,
            ModelUsageMonthlyRollup.period_start == settled_source_event.period_start,
            ModelUsageMonthlyRollup.rollup_kind == ModelUsageRollupKind.FAMILY_TOTAL,
        )
    )
    assert rollup is not None
    command = replace(
        meter_correction_command,
        idempotency_key="adjustment-preview-projection",
        fingerprint="fp-adjustment-preview-projection",
        lines=(
            replace(
                meter_correction_command.lines[0],
                cost_delta_cny=Decimal("2"),
            ),
        ),
    )
    before = (
        tuple(
            (counter.id, counter.adjustment_value, counter.version)
            for counter in counters
        ),
        rollup.revision,
        model_usage_db.query(ModelUsageAdjustmentGroup).count(),
    )

    preview = preview_adjustment(model_usage_db, command)

    family_after = preview.payload["counter_after"][family_cost_dimension_key()]
    assert family_after["adjustment_value"] == "2"
    assert family_after["effective_value"] == "81"
    assert preview.payload["crossed_thresholds"] == ["0.80"]
    assert preview.payload["rollup_revision_after"] == rollup.revision + 1
    assert (
        tuple(
            (counter.id, counter.adjustment_value, counter.version)
            for counter in counters
        ),
        rollup.revision,
        model_usage_db.query(ModelUsageAdjustmentGroup).count(),
    ) == before


def test_preview_alert_impact_excludes_thresholds_already_recorded(
    model_usage_db: Session,
    reservation_context: UsageContext,
    settled_source_event: ModelUsageEvent,
    meter_correction_command: AdjustmentCommand,
) -> None:
    set_policy(
        model_usage_db,
        reservation_context,
        budget=Decimal("100"),
        hard=False,
    )
    policy = current_policy(
        model_usage_db,
        family_id=settled_source_event.family_id,
    )
    family_counter = model_usage_db.scalar(
        select(ModelUsagePeriodCounter).where(
            ModelUsagePeriodCounter.family_id == settled_source_event.family_id,
            ModelUsagePeriodCounter.period_start == settled_source_event.period_start,
            ModelUsagePeriodCounter.dimension_key == family_cost_dimension_key(),
        )
    )
    assert family_counter is not None
    family_counter.settled_value = Decimal("85")
    assert [
        alert.threshold
        for alert in evaluate_budget_alerts(
            model_usage_db,
            policy=policy,
            counter=family_counter,
        )
    ] == [Decimal("0.80")]
    command = replace(
        meter_correction_command,
        idempotency_key="adjustment-preview-next-alert",
        fingerprint="fp-adjustment-preview-next-alert",
        lines=(
            replace(
                meter_correction_command.lines[0],
                cost_delta_cny=Decimal("20"),
            ),
        ),
    )

    preview = preview_adjustment(model_usage_db, command)

    assert preview.payload["crossed_thresholds"] == ["1.00"]


@pytest.mark.parametrize(
    "status",
    [ModelUsageCorrectionStatus.PRUNING, ModelUsageCorrectionStatus.CLOSED],
)
def test_non_open_period_rejects_preview_and_apply(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
    meter_correction_command: AdjustmentCommand,
    status: ModelUsageCorrectionStatus,
) -> None:
    rollup = model_usage_db.scalar(
        select(ModelUsageMonthlyRollup).where(
            ModelUsageMonthlyRollup.family_id == settled_source_event.family_id,
            ModelUsageMonthlyRollup.period_start == settled_source_event.period_start,
            ModelUsageMonthlyRollup.rollup_kind == ModelUsageRollupKind.FAMILY_TOTAL,
        )
    )
    assert rollup is not None
    rollup.correction_status = status

    with pytest.raises(ModelUsageAdjustmentWindowClosed):
        preview_adjustment(model_usage_db, meter_correction_command)
    with pytest.raises(ModelUsageAdjustmentWindowClosed):
        apply_adjustment(model_usage_db, meter_correction_command)


def test_open_period_with_closed_timestamp_rejects_preview_and_apply(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
    meter_correction_command: AdjustmentCommand,
) -> None:
    rollup = model_usage_db.scalar(
        select(ModelUsageMonthlyRollup).where(
            ModelUsageMonthlyRollup.family_id == settled_source_event.family_id,
            ModelUsageMonthlyRollup.period_start == settled_source_event.period_start,
            ModelUsageMonthlyRollup.rollup_kind == ModelUsageRollupKind.FAMILY_TOTAL,
        )
    )
    assert rollup is not None
    rollup.adjustment_closed_at = datetime(2026, 7, 30, 4, 0, tzinfo=timezone.utc)

    with pytest.raises(ModelUsageAdjustmentWindowClosed):
        preview_adjustment(model_usage_db, meter_correction_command)
    with pytest.raises(ModelUsageAdjustmentWindowClosed):
        apply_adjustment(model_usage_db, meter_correction_command)


def test_adjustment_requires_a_source_event(
    model_usage_db: Session,
    meter_correction_command: AdjustmentCommand,
) -> None:
    command = replace(meter_correction_command, source_event_id="missing-event")

    with pytest.raises(ModelUsageAdjustmentValidationError, match="source_event_required"):
        preview_adjustment(model_usage_db, command)


def test_adjustment_cannot_attach_a_different_source_reservation(
    model_usage_db: Session,
    meter_correction_command: AdjustmentCommand,
) -> None:
    command = replace(
        meter_correction_command,
        source_reservation_id="other-family-or-attempt-reservation",
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="source_reservation_mismatch",
    ):
        preview_adjustment(model_usage_db, command)


def test_negative_adjustment_cannot_credit_more_than_effective_meter_usage(
    model_usage_db: Session,
    settled_source_event: ModelUsageEvent,
    meter_correction_command: AdjustmentCommand,
) -> None:
    command = replace(
        meter_correction_command,
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
                meter=ModelUsageMeter.TOTAL_TOKENS,
                meter_delta=-(Decimal("110") + Decimal("1")),
            ),
        ),
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="effective_usage_cannot_be_negative",
    ):
        preview_adjustment(model_usage_db, command)


@pytest.mark.parametrize(
    "invalid_fields",
    [
        {
            "resulting_provider_outcome": ModelUsageProviderOutcome.NOT_BILLED,
            "resulting_execution_certainty": (
                ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
            ),
            "resulting_measurement_status": ModelUsageMeasurementStatus.EXACT,
        },
        {"resulting_pricing_status": ModelUsagePricingStatus.PRICED},
    ],
    ids=("execution-status", "pricing-status"),
)
def test_meter_correction_cannot_set_resolution_statuses(
    model_usage_db: Session,
    meter_correction_command: AdjustmentCommand,
    invalid_fields: dict[str, object],
) -> None:
    command = replace(
        meter_correction_command,
        lines=(replace(meter_correction_command.lines[0], **invalid_fields),),
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="meter_correction_fields_invalid",
    ):
        preview_adjustment(model_usage_db, command)


def test_pricing_correction_rejects_execution_result_fields(
    model_usage_db: Session,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    command = AdjustmentCommand(
        family_id=unpriced_source_event.family_id,
        source_event_id=unpriced_source_event.id,
        source_reservation_id=unpriced_source_event.reservation_id,
        idempotency_key="adjustment-pricing-with-execution-fields",
        fingerprint="fp-adjustment-pricing-with-execution-fields",
        reason_code="provider_price_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-PRICE-STRICT",
        evidence_ref="provider:invoice:strict-price",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.PRICING_CORRECTION,
                cost_delta_cny=Decimal("110"),
                resulting_provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
                price_snapshot=evidence_snapshot(
                    complete=True,
                    billing_scheme_key=unpriced_source_event.billing_scheme_key,
                ),
                resolved_cost_cny=Decimal("110"),
            ),
        ),
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="pricing_correction_fields_invalid",
    ):
        preview_adjustment(model_usage_db, command)


def test_execution_resolution_rejects_pricing_evidence_fields(
    model_usage_db: Session,
    unknown_source_event: ModelUsageEvent,
) -> None:
    command = AdjustmentCommand(
        family_id=unknown_source_event.family_id,
        source_event_id=unknown_source_event.id,
        source_reservation_id=unknown_source_event.reservation_id,
        idempotency_key="adjustment-execution-with-pricing-evidence",
        fingerprint="fp-adjustment-execution-with-pricing-evidence",
        reason_code="provider_execution_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-EXECUTION-STRICT",
        evidence_ref="provider:execution:strict",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.EXECUTION_RESOLUTION,
                resulting_provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
                resulting_execution_certainty=(
                    ModelUsageExecutionCertainty.CONFIRMED_EXECUTED
                ),
                resulting_measurement_status=ModelUsageMeasurementStatus.EXACT,
                price_snapshot=evidence_snapshot(
                    complete=True,
                    billing_scheme_key=unknown_source_event.billing_scheme_key,
                ),
                resolved_cost_cny=unknown_source_event.cost_cny,
            ),
        ),
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="execution_resolution_fields_invalid",
    ):
        preview_adjustment(model_usage_db, command)


def test_pricing_resolution_requires_complete_evidence_snapshot(
    model_usage_db: Session,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    command = AdjustmentCommand(
        family_id=unpriced_source_event.family_id,
        source_event_id=unpriced_source_event.id,
        source_reservation_id=unpriced_source_event.reservation_id,
        idempotency_key="adjustment-pricing-resolution-incomplete",
        fingerprint="fp-adjustment-pricing-resolution-incomplete",
        reason_code="provider_price_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-PRICE",
        evidence_ref="provider:invoice:line-1",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.PRICING_CORRECTION,
                cost_delta_cny=Decimal("110"),
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
                price_snapshot=evidence_snapshot(
                    complete=False,
                    billing_scheme_key=unpriced_source_event.billing_scheme_key,
                ),
                resolved_cost_cny=Decimal("110"),
            ),
        ),
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="pricing_resolution_snapshot_incomplete",
    ):
        preview_adjustment(model_usage_db, command)


def test_pricing_resolution_uses_immutable_evidence_snapshot_without_mutating_event(
    model_usage_db: Session,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    original = (
        unpriced_source_event.pricing_status,
        unpriced_source_event.cost_cny,
        unpriced_source_event.price_version_id,
        unpriced_source_event.price_snapshot_checksum,
    )
    command = AdjustmentCommand(
        family_id=unpriced_source_event.family_id,
        source_event_id=unpriced_source_event.id,
        source_reservation_id=unpriced_source_event.reservation_id,
        idempotency_key="adjustment-pricing-resolution-complete",
        fingerprint="fp-adjustment-pricing-resolution-complete",
        reason_code="provider_price_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-PRICE",
        evidence_ref="provider:invoice:line-2",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.PRICING_CORRECTION,
                cost_delta_cny=Decimal("110"),
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
                price_snapshot=evidence_snapshot(
                    complete=True,
                    billing_scheme_key=unpriced_source_event.billing_scheme_key,
                ),
                resolved_cost_cny=Decimal("110"),
            ),
        ),
    )
    preview = preview_adjustment(model_usage_db, command)

    result = apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))
    model_usage_db.refresh(unpriced_source_event)

    assert result.effective.pricing_status is ModelUsagePricingStatus.PRICED
    assert result.effective.cost_cny == Decimal("110")
    assert result.lines[0].price_snapshot_checksum == evidence_snapshot(
        complete=True,
        billing_scheme_key=unpriced_source_event.billing_scheme_key,
    ).checksum
    assert (
        unpriced_source_event.pricing_status,
        unpriced_source_event.cost_cny,
        unpriced_source_event.price_version_id,
        unpriced_source_event.price_snapshot_checksum,
    ) == original


def test_pricing_resolution_uses_effective_meters_after_prior_correction(
    model_usage_db: Session,
    unpriced_source_event: ModelUsageEvent,
) -> None:
    meter_command = AdjustmentCommand(
        family_id=unpriced_source_event.family_id,
        source_event_id=unpriced_source_event.id,
        source_reservation_id=unpriced_source_event.reservation_id,
        idempotency_key="adjustment-unpriced-meter-correction",
        fingerprint="fp-adjustment-unpriced-meter-correction",
        reason_code="provider_meter_correction",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-PRICE-METER",
        evidence_ref="provider:invoice:meter-correction",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
                meter=ModelUsageMeter.UNCACHED_INPUT_TOKENS,
                meter_delta=Decimal("-10"),
            ),
        ),
    )
    meter_preview = preview_adjustment(model_usage_db, meter_command)
    meter_result = apply_adjustment(
        model_usage_db,
        replace(meter_command, confirm_checksum=meter_preview.checksum),
    )
    assert meter_result.effective.quantity(ModelUsageMeter.UNCACHED_INPUT_TOKENS) == Decimal("50")
    pricing_command = AdjustmentCommand(
        family_id=unpriced_source_event.family_id,
        source_event_id=unpriced_source_event.id,
        source_reservation_id=unpriced_source_event.reservation_id,
        idempotency_key="adjustment-pricing-after-meter-correction",
        fingerprint="fp-adjustment-pricing-after-meter-correction",
        reason_code="provider_price_evidence",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-PRICE-EFFECTIVE",
        evidence_ref="provider:invoice:effective-meter-price",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.PRICING_CORRECTION,
                cost_delta_cny=Decimal("100"),
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
                price_snapshot=evidence_snapshot(
                    complete=True,
                    billing_scheme_key=unpriced_source_event.billing_scheme_key,
                ),
                resolved_cost_cny=Decimal("100"),
            ),
        ),
    )

    pricing_preview = preview_adjustment(model_usage_db, pricing_command)
    result = apply_adjustment(
        model_usage_db,
        replace(pricing_command, confirm_checksum=pricing_preview.checksum),
    )

    assert result.effective.cost_cny == Decimal("100")
    assert result.effective.pricing_status is ModelUsagePricingStatus.PRICED


def test_confirmed_not_executed_resolution_requires_matching_cost_and_all_guardrail_deltas(
    model_usage_db: Session,
    unknown_source_event: ModelUsageEvent,
) -> None:
    first_meter = model_usage_db.scalar(
        select(ModelUsageEventMeter).where(
            ModelUsageEventMeter.event_id == unknown_source_event.id
        )
    )
    assert first_meter is not None and unknown_source_event.cost_cny is not None
    command = AdjustmentCommand(
        family_id=unknown_source_event.family_id,
        source_event_id=unknown_source_event.id,
        source_reservation_id=unknown_source_event.reservation_id,
        idempotency_key="adjustment-incomplete-execution-resolution",
        fingerprint="fp-adjustment-incomplete-execution-resolution",
        reason_code="provider_confirmed_not_executed",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-EXECUTION",
        evidence_ref="provider:request:not-executed",
        lines=(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.EXECUTION_RESOLUTION,
                meter=first_meter.meter,
                meter_delta=-first_meter.quantity,
                cost_delta_cny=-unknown_source_event.cost_cny,
                resulting_provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
                resulting_execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
                resulting_measurement_status=ModelUsageMeasurementStatus.EXACT,
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
            ),
        ),
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="execution_resolution_delta_mismatch",
    ):
        preview_adjustment(model_usage_db, command)


def test_confirmed_not_executed_resolution_zeros_effective_cost_and_guardrail_meters(
    model_usage_db: Session,
    unknown_source_event: ModelUsageEvent,
) -> None:
    meters = tuple(
        model_usage_db.scalars(
            select(ModelUsageEventMeter)
            .where(ModelUsageEventMeter.event_id == unknown_source_event.id)
            .order_by(ModelUsageEventMeter.meter_key)
        )
    )
    assert meters and unknown_source_event.cost_cny is not None
    command = AdjustmentCommand(
        family_id=unknown_source_event.family_id,
        source_event_id=unknown_source_event.id,
        source_reservation_id=unknown_source_event.reservation_id,
        idempotency_key="adjustment-confirmed-not-executed",
        fingerprint="fp-adjustment-confirmed-not-executed",
        reason_code="provider_confirmed_not_executed",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-EXECUTION",
        evidence_ref="provider:request:not-executed-confirmed",
        lines=tuple(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.EXECUTION_RESOLUTION,
                meter=row.meter,
                meter_delta=-row.quantity,
                cost_delta_cny=-unknown_source_event.cost_cny if index == 0 else None,
                resulting_provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
                resulting_execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED,
                resulting_measurement_status=ModelUsageMeasurementStatus.EXACT,
                resulting_pricing_status=ModelUsagePricingStatus.PRICED,
            )
            for index, row in enumerate(meters)
        ),
    )
    preview = preview_adjustment(model_usage_db, command)

    result = apply_adjustment(model_usage_db, replace(command, confirm_checksum=preview.checksum))

    assert result.effective.cost_cny == Decimal("0")
    assert all(result.effective.guardrail_quantity(row.meter) == 0 for row in meters)
    assert result.counter_delta.cost == -unknown_source_event.cost_cny
    assert result.counter_delta.meter(ModelUsageMeter.TOTAL_TOKENS) == -Decimal("20")
    family_counter = model_usage_db.scalar(
        select(ModelUsagePeriodCounter).where(
            ModelUsagePeriodCounter.family_id == unknown_source_event.family_id,
            ModelUsagePeriodCounter.period_start == unknown_source_event.period_start,
            ModelUsagePeriodCounter.dimension_key == family_cost_dimension_key(),
        )
    )
    assert family_counter is not None
    assert family_counter.adjustment_value == -unknown_source_event.cost_cny


def test_confirmed_not_executed_resolution_requires_priced_final_state(
    model_usage_db: Session,
    unknown_source_event: ModelUsageEvent,
) -> None:
    unknown_source_event.pricing_status = ModelUsagePricingStatus.UNPRICED
    meters = tuple(
        model_usage_db.scalars(
            select(ModelUsageEventMeter)
            .where(ModelUsageEventMeter.event_id == unknown_source_event.id)
            .order_by(ModelUsageEventMeter.meter_key)
        )
    )
    assert meters and unknown_source_event.cost_cny is not None
    command = AdjustmentCommand(
        family_id=unknown_source_event.family_id,
        source_event_id=unknown_source_event.id,
        source_reservation_id=unknown_source_event.reservation_id,
        idempotency_key="adjustment-not-executed-unpriced-final",
        fingerprint="fp-adjustment-not-executed-unpriced-final",
        reason_code="provider_confirmed_not_executed",
        operator="release-owner",
        change_ticket="CULINA-USAGE-ADJ-EXECUTION-PRICED",
        evidence_ref="provider:request:not-executed-unpriced",
        lines=tuple(
            AdjustmentLineCommand(
                resolution_kind=ModelUsageResolutionKind.EXECUTION_RESOLUTION,
                meter=row.meter,
                meter_delta=-row.quantity,
                cost_delta_cny=-unknown_source_event.cost_cny if index == 0 else None,
                resulting_provider_outcome=ModelUsageProviderOutcome.NOT_BILLED,
                resulting_execution_certainty=(
                    ModelUsageExecutionCertainty.CONFIRMED_NOT_EXECUTED
                ),
                resulting_measurement_status=ModelUsageMeasurementStatus.EXACT,
            )
            for index, row in enumerate(meters)
        ),
    )

    with pytest.raises(
        ModelUsageAdjustmentValidationError,
        match="execution_resolution_delta_mismatch",
    ):
        preview_adjustment(model_usage_db, command)
