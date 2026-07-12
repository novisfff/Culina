from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.deps import get_current_auth
from app.db.session import get_db
from app.schemas.activity import ActivityHighlightsResponse
from app.services.activity_highlights import list_activity_highlights

router = APIRouter(tags=["activity-highlights"])


@router.get("/api/activity-highlights", response_model=ActivityHighlightsResponse)
def get_activity_highlights(
    limit: int = Query(default=5, ge=1, le=20),
    auth: tuple = Depends(get_current_auth),
    db: Session = Depends(get_db),
) -> dict:
    _, membership = auth
    return list_activity_highlights(
        db,
        family_id=membership.family_id,
        limit=limit,
    )
