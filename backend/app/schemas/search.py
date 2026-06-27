from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


SearchEntityType = Literal["ingredient", "food", "recipe"]


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
