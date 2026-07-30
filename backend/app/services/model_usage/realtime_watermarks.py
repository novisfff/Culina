from __future__ import annotations

import re
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.enums import ModelUsageCapability, ModelUsageMeter
from app.core.utils import create_id
from app.models.model_usage import ModelUsageRealtimeWatermark
from app.services.model_usage.decimal_math import quantize_quantity
from app.services.model_usage.errors import ModelUsageSettlementPending
from app.services.model_usage.types import ProviderMeterWatermark, ProviderUsageReceipt


_REALTIME_ATTEMPT_KEY = re.compile(
    r"^realtime:([^:]{1,96}):[^:]+:[^:]+:lease:([1-9][0-9]*)$"
)


def _same_database_instant(left: datetime, right: datetime) -> bool:
    """Compare persisted MySQL UTC datetimes to signed UTC receipt values."""

    def as_utc(value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    return as_utc(left) == as_utc(right)


def realtime_session_key_from_attempt_key(attempt_key: str) -> str:
    match = _REALTIME_ATTEMPT_KEY.fullmatch(attempt_key)
    if match is None:
        raise ModelUsageSettlementPending("realtime_attempt_key_invalid")
    return match.group(1)


def _validated_watermarks(
    receipt: ProviderUsageReceipt,
) -> tuple[ProviderMeterWatermark, ...]:
    if receipt.capability is not ModelUsageCapability.REALTIME_AUDIO:
        if receipt.meter_watermarks:
            raise ModelUsageSettlementPending("realtime_watermark_capability_mismatch")
        return ()
    if not receipt.meter_watermarks:
        return ()
    session_key = realtime_session_key_from_attempt_key(receipt.attempt_key)
    if not session_key:
        raise ModelUsageSettlementPending("realtime_attempt_key_invalid")
    receipt_meters = {line.meter for line in receipt.meters}
    seen: set[ModelUsageMeter] = set()
    validated: list[ProviderMeterWatermark] = []
    for watermark in sorted(receipt.meter_watermarks, key=lambda item: item.meter.value):
        if watermark.meter in seen or watermark.meter not in receipt_meters:
            raise ModelUsageSettlementPending("realtime_watermark_meter_invalid")
        seen.add(watermark.meter)
        if isinstance(watermark.lease_sequence, bool) or watermark.lease_sequence <= 0:
            raise ModelUsageSettlementPending("realtime_watermark_sequence_invalid")
        try:
            baseline = quantize_quantity(watermark.baseline_quantity)
            cumulative = quantize_quantity(watermark.cumulative_quantity)
        except (TypeError, ValueError, ArithmeticError) as exc:
            raise ModelUsageSettlementPending("realtime_watermark_quantity_invalid") from exc
        if baseline != watermark.baseline_quantity or cumulative != watermark.cumulative_quantity:
            raise ModelUsageSettlementPending("realtime_watermark_quantity_invalid")
        if baseline < 0 or cumulative < baseline:
            raise ModelUsageSettlementPending("realtime_watermark_decreased")
        validated.append(
            ProviderMeterWatermark(
                meter=watermark.meter,
                lease_sequence=watermark.lease_sequence,
                baseline_quantity=baseline,
                cumulative_quantity=cumulative,
            )
        )
    return tuple(validated)


def _lock_row(
    db: Session,
    *,
    family_id: str,
    period_start: datetime,
    session_key: str,
    provider: str,
    meter: ModelUsageMeter,
) -> ModelUsageRealtimeWatermark | None:
    return db.scalar(
        select(ModelUsageRealtimeWatermark)
        .where(
            ModelUsageRealtimeWatermark.family_id == family_id,
            ModelUsageRealtimeWatermark.period_start == period_start,
            ModelUsageRealtimeWatermark.session_key == session_key,
            ModelUsageRealtimeWatermark.provider == provider,
            ModelUsageRealtimeWatermark.meter == meter,
        )
        .execution_options(populate_existing=True)
        .with_for_update()
    )


def _latest_prior_row(
    db: Session,
    *,
    family_id: str,
    period_start: datetime,
    session_key: str,
    provider: str,
    meter: ModelUsageMeter,
) -> ModelUsageRealtimeWatermark | None:
    return db.scalar(
        select(ModelUsageRealtimeWatermark)
        .where(
            ModelUsageRealtimeWatermark.family_id == family_id,
            ModelUsageRealtimeWatermark.period_start < period_start,
            ModelUsageRealtimeWatermark.session_key == session_key,
            ModelUsageRealtimeWatermark.provider == provider,
            ModelUsageRealtimeWatermark.meter == meter,
        )
        .order_by(ModelUsageRealtimeWatermark.period_start.desc())
        .with_for_update()
        .limit(1)
    )


def _lock_or_create_row(
    db: Session,
    receipt: ProviderUsageReceipt,
    *,
    session_key: str,
    watermark: ProviderMeterWatermark,
) -> ModelUsageRealtimeWatermark:
    existing = _lock_row(
        db,
        family_id=receipt.family_id,
        period_start=receipt.period.start_at,
        session_key=session_key,
        provider=receipt.provider,
        meter=watermark.meter,
    )
    if existing is not None:
        return existing
    prior = _latest_prior_row(
        db,
        family_id=receipt.family_id,
        period_start=receipt.period.start_at,
        session_key=session_key,
        provider=receipt.provider,
        meter=watermark.meter,
    )
    if prior is not None and prior.cumulative_quantity != watermark.baseline_quantity:
        raise ModelUsageSettlementPending("realtime_watermark_baseline_conflict")
    candidate = ModelUsageRealtimeWatermark(
        id=create_id("usage-realtime-watermark"),
        family_id=receipt.family_id,
        period_start=receipt.period.start_at,
        period_end=receipt.period.end_at,
        session_key=session_key,
        provider=receipt.provider,
        meter=watermark.meter,
        cumulative_quantity=watermark.baseline_quantity,
        sequence=0,
    )
    savepoint = db.begin_nested()
    try:
        db.add(candidate)
        db.flush()
    except IntegrityError:
        savepoint.rollback()
    else:
        savepoint.commit()
    winner = _lock_row(
        db,
        family_id=receipt.family_id,
        period_start=receipt.period.start_at,
        session_key=session_key,
        provider=receipt.provider,
        meter=watermark.meter,
    )
    if winner is None:  # pragma: no cover - database invariant
        raise ModelUsageSettlementPending("realtime_watermark_claim_failed")
    return winner


def apply_realtime_watermarks_in_session(
    db: Session,
    receipt: ProviderUsageReceipt,
) -> None:
    """Advance signed realtime cumulative usage within the event transaction.

    Callers must claim/replay the event before this function.  An existing
    event returns before this mutation, which makes signed receipt recovery
    idempotent and prevents a counter/watermark double advance.
    """

    watermarks = _validated_watermarks(receipt)
    if not watermarks:
        return
    session_key = realtime_session_key_from_attempt_key(receipt.attempt_key)
    for watermark in watermarks:
        row = _lock_or_create_row(
            db,
            receipt,
            session_key=session_key,
            watermark=watermark,
        )
        if not _same_database_instant(row.period_end, receipt.period.end_at):
            raise ModelUsageSettlementPending("realtime_watermark_period_conflict")
        if row.cumulative_quantity != watermark.baseline_quantity:
            raise ModelUsageSettlementPending("realtime_watermark_baseline_conflict")
        if watermark.lease_sequence <= row.sequence:
            raise ModelUsageSettlementPending("realtime_watermark_sequence_conflict")
        if watermark.cumulative_quantity < row.cumulative_quantity:
            raise ModelUsageSettlementPending("realtime_watermark_decreased")
        row.cumulative_quantity = watermark.cumulative_quantity
        row.sequence = watermark.lease_sequence
