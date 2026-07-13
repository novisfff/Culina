from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.domain import ActivityLog, Membership
from app.services.clock import activity_week_window_utc, now_for_family


def _response_time(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def list_activity_highlights(
    db: Session,
    *,
    family_id: str,
    limit: int,
    at: datetime | None = None,
) -> dict[str, object]:
    eligible = (
        ActivityLog.family_id == family_id,
        ActivityLog.highlight_kind.is_not(None),
        ActivityLog.highlight_summary.is_not(None),
    )
    logs = list(
        db.scalars(
            select(ActivityLog)
            .where(*eligible)
            .order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc())
            .limit(limit)
        )
    )
    memberships = list(
        db.scalars(select(Membership).where(Membership.family_id == family_id))
    )
    actor_map = {membership.user_id: membership.user.display_name for membership in memberships}
    # Resolve "now" through this module so tests can patch activity_highlights.now_for_family.
    effective_at = at if at is not None else now_for_family(family_id)
    week_start, now = activity_week_window_utc(family_id, at=effective_at)
    week_count = int(
        db.scalar(
            select(func.count(ActivityLog.id)).where(
                *eligible,
                ActivityLog.created_at >= week_start,
                ActivityLog.created_at <= now,
            )
        )
        or 0
    )
    return {
        "items": [
            {
                "id": log.id,
                "kind": log.highlight_kind.value,
                "summary": log.highlight_summary,
                "actor_id": log.actor_id,
                "actor_name": actor_map.get(log.actor_id, "家庭成员"),
                "created_at": _response_time(log.created_at),
            }
            for log in logs
        ],
        "week_highlight_count": week_count,
    }
