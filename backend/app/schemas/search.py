from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


SearchEntityType = Literal["ingredient", "food", "recipe", "meal_plan"]
SearchIndexJobStatus = Literal["queued", "running", "succeeded", "failed"]
SearchIndexVectorStatus = Literal["pending", "indexed", "skipped", "failed"]


class SearchResultItemOut(BaseModel):
    entity_type: SearchEntityType
    entity_id: str
    score: float
    keyword_score: float = 0
    semantic_score: float = 0
    business_score: float = 0
    match_reason: list[str] = Field(default_factory=list)
    entity: dict[str, Any]


class SearchResponseOut(BaseModel):
    items: list[SearchResultItemOut] = Field(default_factory=list)
    total: int
    query: str
    search_mode: str = "hybrid"
    degraded: bool = False


class SearchIndexJobResponse(BaseModel):
    job_id: str
    status: SearchIndexJobStatus
    error: str | None = None
    entity_type: SearchEntityType
    entity_id: str
    target_name: str
    vector_status: SearchIndexVectorStatus = "pending"
    created_at: datetime
    completed_at: datetime | None = None
