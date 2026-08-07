from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from threading import Barrier

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.enums import (
    ModelUsageCorrectionStatus,
    ModelUsageExecutionCertainty,
    ModelUsageMeasurementStatus,
    ModelUsageMeter,
    ModelUsageMeterRole,
    ModelUsagePricingStatus,
    ModelUsageProviderOutcome,
    ModelUsageQuantitySource,
    ModelUsageResolutionKind,
    ModelUsageRollupKind,
)
from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageAlert,
    ModelUsageEvent,
    ModelUsageMonthlyRollup,
    ModelUsagePeriodCounter,
    ModelUsagePolicyVersion,
    ModelUsageReservation,
    ModelUsageSubject,
)
from app.services.model_usage.adjustments import (
    AdjustmentCommand,
    AdjustmentLineCommand,
    AdjustmentResult,
    apply_adjustment,
    preview_adjustment,
)
from app.services.model_usage.counters import capability_meter_dimension_key
from app.services.model_usage.dispatch import prepare_usage_dispatch_in_session
from app.services.model_usage.errors import ModelUsageAdjustmentConflict
from app.services.model_usage.policies import (
    PolicyUpdateCommand,
    current_policy,
    update_family_policy,
)
from app.services.model_usage.receipts import ProviderUsageReceiptSigner
from app.services.model_usage.settlement import settle_usage_in_session
from app.services.model_usage.types import (
    ProviderRecoveryPolicy,
    ProviderUsageReceipt,
    UsageMeterQuantity,
)
from tests.model_usage.test_reservation_mysql_concurrency import (
    MysqlReservationContext,
    run_barriered,
)


pytest_plugins = ("tests.model_usage.test_reservation_mysql_concurrency",)


TWO_LINES = (
    AdjustmentLineCommand(
        resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
        meter=ModelUsageMeter.OUTPUT_TOKENS,
        meter_delta=Decimal("-1"),
    ),
    AdjustmentLineCommand(
        resolution_kind=ModelUsageResolutionKind.METER_CORRECTION,
        meter=ModelUsageMeter.OUTPUT_TOKENS,
        meter_delta=Decimal("0"),
        cost_delta_cny=Decimal("-3"),
    ),
)


@dataclass(frozen=True, slots=True)
class AdjustmentThreadResult:
    group_id: str
    line_sequences: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class MysqlAdjustmentContext:
    SessionLocal: sessionmaker[Session]
    reservation_context: MysqlReservationContext
    source_event_id: str
    source_reservation_id: str
    confirm_checksum: str

    def command(
        self,
        *,
        idempotency_key: str,
        fingerprint: str,
    ) -> AdjustmentCommand:
        return AdjustmentCommand(
            family_id="family-mysql-reserve",
            source_event_id=self.source_event_id,
            source_reservation_id=self.source_reservation_id,
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            reason_code="provider_meter_correction",
            operator="mysql-concurrency-test",
            change_ticket="CULINA-USAGE-ADJ-MYSQL",
            evidence_ref="provider:mysql-concurrency-source",
            lines=TWO_LINES,
            confirm_checksum=self.confirm_checksum,
        )

    def adjust(
        self,
        *,
        idempotency_key: str,
        fingerprint: str,
    ) -> AdjustmentThreadResult | ModelUsageAdjustmentConflict:
        with self.SessionLocal() as db:
            try:
                result: AdjustmentResult = apply_adjustment(
                    db,
                    self.command(
                        idempotency_key=idempotency_key,
                        fingerprint=fingerprint,
                    ),
                )
                db.commit()
                return AdjustmentThreadResult(
                    group_id=result.group.id,
                    line_sequences=tuple(line.line_sequence for line in result.lines),
                )
            except ModelUsageAdjustmentConflict as exc:
                db.rollback()
                return exc

    def set_budget(self, budget: Decimal) -> None:
        with self.SessionLocal() as db:
            policy = current_policy(db, family_id="family-mysql-reserve")
            subject = db.scalar(
                select(ModelUsageSubject).where(
                    ModelUsageSubject.family_id == "family-mysql-reserve",
                    ModelUsageSubject.user_id == "owner-mysql-reserve",
                )
            )
            assert subject is not None
            update_family_policy(
                db,
                PolicyUpdateCommand(
                    family_id="family-mysql-reserve",
                    base_version_number=policy.version_number,
                    monthly_budget_cny=budget,
                    alerts_enabled=True,
                    hard_limit_enabled=True,
                    capability_limits=(),
                    actor_subject_id=subject.id,
                    active_variants=(),
                ),
            )
            db.commit()

    def group_count(self, idempotency_key: str) -> int:
        with self.SessionLocal() as db:
            return (
                db.query(ModelUsageAdjustmentGroup)
                .filter_by(
                    family_id="family-mysql-reserve",
                    idempotency_key=idempotency_key,
                )
                .count()
            )

    def line_count(self, idempotency_key: str) -> int:
        with self.SessionLocal() as db:
            group_id = db.scalar(
                select(ModelUsageAdjustmentGroup.id).where(
                    ModelUsageAdjustmentGroup.family_id == "family-mysql-reserve",
                    ModelUsageAdjustmentGroup.idempotency_key == idempotency_key,
                )
            )
            assert group_id is not None
            return (
                db.query(ModelUsageAdjustment)
                .filter_by(adjustment_group_id=group_id)
                .count()
            )

    def counter_adjustment(self, dimension_key: str) -> Decimal:
        with self.SessionLocal() as db:
            value = db.scalar(
                select(ModelUsagePeriodCounter.adjustment_value).where(
                    ModelUsagePeriodCounter.family_id == "family-mysql-reserve",
                    ModelUsagePeriodCounter.dimension_key == dimension_key,
                )
            )
            assert value is not None
            return value

    def reservation_for(self, attempt_key: str) -> ModelUsageReservation | None:
        with self.SessionLocal() as db:
            return db.scalar(
                select(ModelUsageReservation).where(
                    ModelUsageReservation.family_id == "family-mysql-reserve",
                    ModelUsageReservation.attempt_key == attempt_key,
                )
            )


def _settle_source_event(context: MysqlReservationContext) -> tuple[str, str]:
    signer, receipt = _prepare_pending_receipt(
        context,
        index=9000,
        attempt_key="adjustment-source-event",
        fingerprint="adjustment-source-fingerprint",
        provider_request_id="provider-adjustment-source",
    )
    with context.SessionLocal() as db:
        settlement = settle_usage_in_session(db, receipt, signer=signer)
        event = db.get(ModelUsageEvent, settlement.event_id)
        assert event is not None
        db.add(
            ModelUsageMonthlyRollup(
                id="rollup-mysql-adjustment-source",
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
                source_watermark="mysql-adjustment-source",
                checksum="a" * 64,
                correction_status=ModelUsageCorrectionStatus.OPEN,
                adjustment_closed_at=None,
                raw_data_pruned_at=None,
                computed_at=datetime(2026, 7, 30, 3, 2, tzinfo=timezone.utc),
            )
        )
        db.commit()
        return event.id, receipt.reservation_id or ""


def _prepare_pending_receipt(
    context: MysqlReservationContext,
    *,
    index: int,
    attempt_key: str,
    fingerprint: str,
    provider_request_id: str,
) -> tuple[ProviderUsageReceiptSigner, ProviderUsageReceipt]:
    decision = context.reserve(
        index,
        attempt_key=attempt_key,
        fingerprint=fingerprint,
    )
    assert decision.decision == "allowed"
    assert decision.reservation_id is not None
    with context.SessionLocal() as db:
        dispatch = prepare_usage_dispatch_in_session(
            db,
            reservation_id=decision.reservation_id,
            fingerprint=fingerprint,
            recovery_policy=ProviderRecoveryPolicy.none(),
        )
        assert dispatch.permit is not None
        permit = dispatch.permit
        db.commit()
    signer = ProviderUsageReceiptSigner(active_key_id="key", keys={"key": b"secret"})
    return signer, signer.sign(
        ProviderUsageReceipt(
            reservation_id=permit.reservation_id,
            family_id=permit.family_id,
            subject_key=permit.subject_key,
            capability=permit.capability,
            provider=permit.provider,
            requested_model=permit.requested_model,
            reported_model=permit.billing_model,
            billing_model=permit.billing_model,
            variant_key=permit.variant_key,
            billing_scheme_key=permit.billing_scheme_key,
            attempt_key=permit.attempt_key,
            fingerprint=permit.fingerprint,
            client_attempt_id=permit.client_attempt_id,
            policy_version_id=permit.policy_version_id,
            dispatch_policy_version_id=permit.dispatch_policy_version_id,
            provider_request_id=provider_request_id,
            provider_outcome=ModelUsageProviderOutcome.SUCCEEDED,
            execution_certainty=ModelUsageExecutionCertainty.CONFIRMED_EXECUTED,
            measurement_status=ModelUsageMeasurementStatus.EXACT,
            pricing_status=ModelUsagePricingStatus.PRICED,
            period=permit.period,
            meters=(
                UsageMeterQuantity(
                    meter=ModelUsageMeter.OUTPUT_TOKENS,
                    quantity=Decimal("1"),
                    meter_role=ModelUsageMeterRole.BILLABLE,
                    quantity_source=ModelUsageQuantitySource.PROVIDER,
                ),
            ),
            meter_watermarks=(),
            dispatched_at=permit.dispatched_at,
            completed_at=datetime(2026, 7, 30, 3, 1, tzinfo=timezone.utc),
            price_version_id=permit.price_version_id,
            price_snapshot=permit.price_snapshot,
            price_snapshot_checksum=permit.price_snapshot_checksum,
            fail_open_proof_id=None,
            integrity_key_id="",
            integrity_hmac="",
        )
    )


def _update_policy_in_session(
    db: Session,
    *,
    budget: Decimal,
) -> ModelUsagePolicyVersion:
    policy = current_policy(db, family_id="family-mysql-reserve")
    subject = db.scalar(
        select(ModelUsageSubject).where(
            ModelUsageSubject.family_id == "family-mysql-reserve",
            ModelUsageSubject.user_id == "owner-mysql-reserve",
        )
    )
    assert subject is not None
    return update_family_policy(
        db,
        PolicyUpdateCommand(
            family_id="family-mysql-reserve",
            base_version_number=policy.version_number,
            monthly_budget_cny=budget,
            alerts_enabled=True,
            hard_limit_enabled=False,
            capability_limits=(),
            actor_subject_id=subject.id,
            active_variants=(),
            effective_at=datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc),
        ),
    )


@pytest.fixture()
def mysql_adjustment_context(
    mysql_reservation_context: MysqlReservationContext,
) -> MysqlAdjustmentContext:
    event_id, reservation_id = _settle_source_event(mysql_reservation_context)
    provisional = AdjustmentCommand(
        family_id="family-mysql-reserve",
        source_event_id=event_id,
        source_reservation_id=reservation_id,
        idempotency_key="preview-adjustment",
        fingerprint="preview-adjustment-fingerprint",
        reason_code="provider_meter_correction",
        operator="mysql-concurrency-test",
        change_ticket="CULINA-USAGE-ADJ-MYSQL",
        evidence_ref="provider:mysql-concurrency-source",
        lines=TWO_LINES,
    )
    with mysql_reservation_context.SessionLocal() as db:
        preview = preview_adjustment(db, provisional)
        db.rollback()
    return MysqlAdjustmentContext(
        SessionLocal=mysql_reservation_context.SessionLocal,
        reservation_context=mysql_reservation_context,
        source_event_id=event_id,
        source_reservation_id=reservation_id,
        confirm_checksum=preview.checksum,
    )


def test_concurrent_adjustment_group_claim_is_exactly_once(
    mysql_adjustment_context: MysqlAdjustmentContext,
) -> None:
    results = run_barriered(
        50,
        lambda _: mysql_adjustment_context.adjust(
            idempotency_key="concurrent-adjustment",
            fingerprint="concurrent-adjustment-fingerprint",
        ),
    )

    assert all(isinstance(result, AdjustmentThreadResult) for result in results)
    winners = tuple(result for result in results if isinstance(result, AdjustmentThreadResult))
    assert len({result.group_id for result in winners}) == 1
    assert {result.line_sequences for result in winners} == {(1, 2)}
    assert mysql_adjustment_context.group_count("concurrent-adjustment") == 1
    assert mysql_adjustment_context.line_count("concurrent-adjustment") == 2
    assert mysql_adjustment_context.counter_adjustment("family_cost") == Decimal("-3")
    assert mysql_adjustment_context.counter_adjustment(
        capability_meter_dimension_key(
            mysql_adjustment_context.reservation_context.base_context.capability,
            ModelUsageMeter.OUTPUT_TOKENS,
        )
    ) == Decimal("-1")


def test_concurrent_mixed_fingerprints_have_one_complete_winner(
    mysql_adjustment_context: MysqlAdjustmentContext,
) -> None:
    results = run_barriered(
        2,
        lambda index: mysql_adjustment_context.adjust(
            idempotency_key="conflicting-adjustment",
            fingerprint=f"conflicting-adjustment-fingerprint-{index}",
        ),
    )

    assert sum(isinstance(result, AdjustmentThreadResult) for result in results) == 1
    assert sum(isinstance(result, ModelUsageAdjustmentConflict) for result in results) == 1
    winner = next(result for result in results if isinstance(result, AdjustmentThreadResult))
    assert winner.line_sequences == (1, 2)
    assert mysql_adjustment_context.group_count("conflicting-adjustment") == 1
    assert mysql_adjustment_context.line_count("conflicting-adjustment") == 2
    assert mysql_adjustment_context.counter_adjustment("family_cost") == Decimal("-3")


def test_negative_adjustment_releases_budget_without_replaying_blocked_call(
    mysql_adjustment_context: MysqlAdjustmentContext,
) -> None:
    mysql_adjustment_context.set_budget(Decimal("3"))
    blocked = mysql_adjustment_context.reservation_context.reserve(
        9100,
        attempt_key="blocked-before-credit",
        fingerprint="blocked-before-credit-fingerprint",
    )
    assert blocked.decision == "blocked"

    adjusted = mysql_adjustment_context.adjust(
        idempotency_key="negative-credit-adjustment",
        fingerprint="negative-credit-adjustment-fingerprint",
    )
    assert isinstance(adjusted, AdjustmentThreadResult)

    allowed = mysql_adjustment_context.reservation_context.reserve(
        9200,
        attempt_key="new-after-credit",
        fingerprint="new-after-credit-fingerprint",
    )
    assert allowed.decision == "allowed"
    assert mysql_adjustment_context.reservation_for("blocked-before-credit") is None


def test_policy_update_pointer_winner_controls_late_settlement_alert_revision(
    mysql_adjustment_context: MysqlAdjustmentContext,
) -> None:
    signer, receipt = _prepare_pending_receipt(
        mysql_adjustment_context.reservation_context,
        index=9300,
        attempt_key="late-settlement-after-policy",
        fingerprint="late-settlement-after-policy-fingerprint",
        provider_request_id="provider-late-settlement-after-policy",
    )
    barrier = Barrier(2)

    def update_first() -> tuple[str, int]:
        with mysql_adjustment_context.SessionLocal() as db:
            updated = _update_policy_in_session(db, budget=Decimal("4"))
            barrier.wait(timeout=10)
            db.commit()
            return updated.id, updated.budget_alert_revision

    def settle_after_update() -> None:
        with mysql_adjustment_context.SessionLocal() as db:
            # Establish a consistent-read snapshot before the policy update commits.
            # Settlement must still observe the policy row selected by the pointer's
            # later locking read under MySQL REPEATABLE READ.
            assert db.get(ModelUsageReservation, receipt.reservation_id) is not None
            barrier.wait(timeout=10)
            settle_usage_in_session(db, receipt, signer=signer)
            db.commit()

    with ThreadPoolExecutor(max_workers=2) as pool:
        update_future = pool.submit(update_first)
        settle_future = pool.submit(settle_after_update)
        updated_policy_id, updated_revision = update_future.result(timeout=20)
        settle_future.result(timeout=20)

    with mysql_adjustment_context.SessionLocal() as db:
        alerts = tuple(
            db.scalars(
                select(ModelUsageAlert)
                .where(
                    ModelUsageAlert.family_id == "family-mysql-reserve",
                    ModelUsageAlert.policy_version_id == updated_policy_id,
                )
                .order_by(ModelUsageAlert.threshold)
            )
        )
        assert [alert.threshold for alert in alerts] == [
            Decimal("0.80"),
            Decimal("1.00"),
            Decimal("1.10"),
        ]
        assert {alert.budget_alert_revision for alert in alerts} == {
            updated_revision
        }


def test_settlement_pointer_winner_preserves_old_facts_then_repairs_new_revision(
    mysql_adjustment_context: MysqlAdjustmentContext,
) -> None:
    with mysql_adjustment_context.SessionLocal() as db:
        old_policy = _update_policy_in_session(db, budget=Decimal("4"))
        db.commit()
        old_policy_id = old_policy.id
        old_revision = old_policy.budget_alert_revision
    signer, receipt = _prepare_pending_receipt(
        mysql_adjustment_context.reservation_context,
        index=9400,
        attempt_key="policy-after-late-settlement",
        fingerprint="policy-after-late-settlement-fingerprint",
        provider_request_id="provider-policy-after-late-settlement",
    )
    barrier = Barrier(2)

    def settle_first() -> None:
        with mysql_adjustment_context.SessionLocal() as db:
            settle_usage_in_session(db, receipt, signer=signer)
            barrier.wait(timeout=10)
            db.commit()

    def update_after_settlement() -> tuple[str, int]:
        with mysql_adjustment_context.SessionLocal() as db:
            barrier.wait(timeout=10)
            updated = _update_policy_in_session(db, budget=Decimal("2"))
            db.commit()
            return updated.id, updated.budget_alert_revision

    with ThreadPoolExecutor(max_workers=2) as pool:
        settlement_future = pool.submit(settle_first)
        update_future = pool.submit(update_after_settlement)
        settlement_future.result(timeout=20)
        updated_policy_id, updated_revision = update_future.result(timeout=20)

    with mysql_adjustment_context.SessionLocal() as db:
        old_alerts = tuple(
            db.scalars(
                select(ModelUsageAlert)
                .where(ModelUsageAlert.policy_version_id == old_policy_id)
                .order_by(ModelUsageAlert.threshold)
            )
        )
        new_alerts = tuple(
            db.scalars(
                select(ModelUsageAlert)
                .where(ModelUsageAlert.policy_version_id == updated_policy_id)
                .order_by(ModelUsageAlert.threshold)
            )
        )
        assert [alert.threshold for alert in old_alerts] == [
            Decimal("0.80"),
            Decimal("1.00"),
            Decimal("1.10"),
        ]
        assert {alert.budget_alert_revision for alert in old_alerts} == {
            old_revision
        }
        assert [alert.threshold for alert in new_alerts] == [Decimal("1.10")]
        assert {alert.budget_alert_revision for alert in new_alerts} == {
            updated_revision
        }
