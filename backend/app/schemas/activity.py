from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.core.enums import ActivityHighlightKind


class ActivityLogOut(BaseModel):
    id: str
    family_id: str
    actor_id: str
    actor_name: str | None = None
    action: str
    entity_type: str
    entity_id: str
    summary: str
    created_at: datetime


class ActivityHighlightOut(BaseModel):
    id: str
    kind: ActivityHighlightKind
    summary: str
    actor_id: str
    actor_name: str
    created_at: datetime


class ActivityHighlightsResponse(BaseModel):
    items: list[ActivityHighlightOut]
    week_highlight_count: int

