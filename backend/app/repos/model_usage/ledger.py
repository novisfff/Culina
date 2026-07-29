from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.model_usage import ModelUsageEvent, ModelUsageReservation


def lock_reservation_by_attempt(
    db: Session,
    *,
    family_id: str,
    attempt_key: str,
) -> ModelUsageReservation | None:
    return db.scalar(
        select(ModelUsageReservation)
        .where(
            ModelUsageReservation.family_id == family_id,
            ModelUsageReservation.attempt_key == attempt_key,
        )
        .with_for_update()
    )


def lock_event_by_attempt(
    db: Session,
    *,
    family_id: str,
    attempt_key: str,
) -> ModelUsageEvent | None:
    return db.scalar(
        select(ModelUsageEvent)
        .where(
            ModelUsageEvent.family_id == family_id,
            ModelUsageEvent.attempt_key == attempt_key,
        )
        .with_for_update()
    )
