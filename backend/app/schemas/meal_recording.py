from __future__ import annotations

from datetime import date as date_type, datetime

from pydantic import BaseModel

from app.core.enums import MealType
from app.schemas.media import MediaAssetOut


class MealLogCandidateFoodOut(BaseModel):
    food_id: str
    name: str
    food_type: str
    cover: MediaAssetOut | None = None


class MealLogCandidateOut(BaseModel):
    meal_log_id: str
    row_version: int
    date: date_type
    meal_type: MealType
    created_at: datetime
    foods: list[MealLogCandidateFoodOut]
    preview_media: MediaAssetOut | None = None
    photo_count: int
