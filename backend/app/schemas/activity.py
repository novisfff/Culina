from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


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

