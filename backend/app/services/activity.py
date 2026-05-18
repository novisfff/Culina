from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.enums import ActivityAction
from app.core.utils import create_id, utcnow
from app.models.domain import ActivityLog


def log_activity(
    db: Session,
    *,
    family_id: str,
    actor_id: str,
    action: ActivityAction,
    entity_type: str,
    entity_id: str,
    summary: str,
) -> ActivityLog:
    activity = ActivityLog(
        id=create_id("activity"),
        family_id=family_id,
        actor_id=actor_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        summary=summary,
        created_at=utcnow(),
    )
    db.add(activity)
    return activity
