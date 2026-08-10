from __future__ import annotations

from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.model_usage import ModelUsageMeasurementIncident


def overlapping_incidents(
    db: Session,
    *,
    family_id: str,
    period_start: datetime,
    period_end: datetime,
) -> tuple[ModelUsageMeasurementIncident, ...]:
    return tuple(
        db.scalars(
            select(ModelUsageMeasurementIncident).where(
                ModelUsageMeasurementIncident.period_start < period_end,
                ModelUsageMeasurementIncident.period_end > period_start,
                or_(
                    ModelUsageMeasurementIncident.family_id == family_id,
                    ModelUsageMeasurementIncident.family_id.is_(None),
                ),
            )
        )
    )
