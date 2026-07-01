from __future__ import annotations

from datetime import date, datetime, time

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.core.enums import ActivityAction
from app.db.session import get_db
from app.models.domain import ActivityLog, Membership
from app.schemas.activity import ActivityLogOut
from app.services.serializers import serialize_activity

router = APIRouter(tags=["activity-logs"])


@router.get("/api/activity-logs", response_model=list[ActivityLogOut])
def list_activity_logs(
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
    start_date: date | None = None,
    end_date: date | None = None,
    actor_id: str | None = None,
    action: ActivityAction | None = None,
    entity_type: str | None = None,
    limit: int | None = Query(default=None, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[dict]:
    _, membership = auth
    query = select(ActivityLog).where(ActivityLog.family_id == membership.family_id)
    if start_date is not None:
        query = query.where(ActivityLog.created_at >= datetime.combine(start_date, time.min))
    if end_date is not None:
        query = query.where(ActivityLog.created_at <= datetime.combine(end_date, time.max))
    if actor_id:
        query = query.where(ActivityLog.actor_id == actor_id)
    if action is not None:
        query = query.where(ActivityLog.action == action)
    if entity_type:
        query = query.where(ActivityLog.entity_type == entity_type)
    query = query.order_by(ActivityLog.created_at.desc()).offset(offset)
    if limit is not None:
        query = query.limit(limit)

    logs = list(
        db.scalars(
            query
        )
    )
    memberships = list(db.scalars(select(Membership).where(Membership.family_id == membership.family_id)))
    actor_map = {item.user_id: item.user.display_name for item in memberships}
    return [serialize_activity(item, actor_map.get(item.actor_id)) for item in logs]
