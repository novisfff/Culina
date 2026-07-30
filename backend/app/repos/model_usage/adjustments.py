from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.model_usage import (
    ModelUsageAdjustment,
    ModelUsageAdjustmentGroup,
    ModelUsageEvent,
    ModelUsageMonthlyRollup,
)


def adjustment_group_by_idempotency_key_for_update(
    db: Session,
    *,
    family_id: str,
    idempotency_key: str,
) -> ModelUsageAdjustmentGroup | None:
    return db.scalar(
        select(ModelUsageAdjustmentGroup)
        .where(
            ModelUsageAdjustmentGroup.family_id == family_id,
            ModelUsageAdjustmentGroup.idempotency_key == idempotency_key,
        )
        .with_for_update()
    )


def require_adjustment_group_for_update(
    db: Session,
    *,
    family_id: str,
    idempotency_key: str,
) -> ModelUsageAdjustmentGroup:
    group = adjustment_group_by_idempotency_key_for_update(
        db,
        family_id=family_id,
        idempotency_key=idempotency_key,
    )
    if group is None:
        raise LookupError("model_usage_adjustment_group_not_found")
    return group


def adjustment_groups_for_source_event(
    db: Session,
    *,
    family_id: str,
    source_event_id: str,
    for_update: bool = False,
) -> tuple[ModelUsageAdjustmentGroup, ...]:
    statement = (
        select(ModelUsageAdjustmentGroup)
        .where(
            ModelUsageAdjustmentGroup.family_id == family_id,
            ModelUsageAdjustmentGroup.source_event_id == source_event_id,
        )
        .order_by(ModelUsageAdjustmentGroup.created_at, ModelUsageAdjustmentGroup.id)
    )
    if for_update:
        statement = statement.with_for_update()
    return tuple(db.scalars(statement))


def adjustment_lines_for_groups(
    db: Session,
    *,
    group_ids: Sequence[str],
) -> tuple[ModelUsageAdjustment, ...]:
    if not group_ids:
        return ()
    return tuple(
        db.scalars(
            select(ModelUsageAdjustment)
            .where(ModelUsageAdjustment.adjustment_group_id.in_(tuple(group_ids)))
            .order_by(
                ModelUsageAdjustment.adjustment_group_id,
                ModelUsageAdjustment.line_sequence,
                ModelUsageAdjustment.id,
            )
        )
    )


def require_family_event_for_update(
    db: Session,
    *,
    family_id: str,
    event_id: str,
) -> ModelUsageEvent:
    event = db.scalar(
        select(ModelUsageEvent)
        .where(
            ModelUsageEvent.id == event_id,
            ModelUsageEvent.family_id == family_id,
        )
        .with_for_update()
    )
    if event is None:
        raise LookupError("model_usage_source_event_not_found")
    return event


def family_total_rollup_for_update(
    db: Session,
    *,
    family_id: str,
    period_start: object,
    rollup_kind: object,
) -> ModelUsageMonthlyRollup | None:
    return db.scalar(
        select(ModelUsageMonthlyRollup)
        .where(
            ModelUsageMonthlyRollup.family_id == family_id,
            ModelUsageMonthlyRollup.period_start == period_start,
            ModelUsageMonthlyRollup.rollup_kind == rollup_kind,
        )
        .with_for_update()
    )
