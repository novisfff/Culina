from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.media import MediaAssetOut


class MealInsightKind(str, Enum):
    FREQUENT_RECENT = "frequent_recent"
    MISSED = "missed"
    REPURCHASE = "repurchase"
    REPEATED_CHOICE = "repeated_choice"


class MealInsightFoodOut(BaseModel):
    id: str
    name: str
    food_type: str
    cover: MediaAssetOut | None = None


class MealInsightEvidenceOut(BaseModel):
    meal_count: int = Field(ge=0)
    last_eaten_on: date
    rating_count: int = Field(ge=0)
    average_rating: float | None = None
    window_days: int = Field(ge=0)


class MealInsightOut(BaseModel):
    kind: Literal["frequent_recent", "missed", "repurchase", "repeated_choice"]
    food: MealInsightFoodOut
    evidence: MealInsightEvidenceOut
