from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session
from fastapi import APIRouter, Depends

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.models.domain import ActivityLog, Membership
from app.schemas.domain import ActivityLogOut
from app.services.serializers import serialize_activity

router = APIRouter(tags=["activity-logs"])


@router.get("/api/activity-logs", response_model=list[ActivityLogOut])
def list_activity_logs(auth: tuple = Depends(get_current_auth), db: Session = Depends(get_db)) -> list[dict]:
    _, membership = auth
    logs = list(
        db.scalars(
            select(ActivityLog)
            .where(ActivityLog.family_id == membership.family_id)
            .order_by(ActivityLog.created_at.desc())
        )
    )
    memberships = list(db.scalars(select(Membership).where(Membership.family_id == membership.family_id)))
    actor_map = {item.user_id: item.user.display_name for item in memberships}
    return [serialize_activity(item, actor_map.get(item.actor_id)) for item in logs]
