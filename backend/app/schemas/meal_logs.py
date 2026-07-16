from __future__ import annotations

from datetime import date as date_type, datetime

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.enums import MealType
from app.schemas.media import MediaAssetOut


class MealLogFoodIn(BaseModel):
    food_id: str
    servings: float
    note: str = ""
    rating: float | None = Field(default=None, ge=0.5, le=5)


class MealLogFoodOut(MealLogFoodIn):
    id: str
    food_name: str


class MealLogFoodRatingIn(BaseModel):
    id: str
    rating: float | None = Field(default=None, ge=0.5, le=5)


class DeductionSuggestionOut(BaseModel):
    id: str
    ingredient_name: str
    suggested_amount: float
    unit: str
    based_on_food_name: str


class MealLogOut(BaseModel):
    id: str
    family_id: str
    date: date_type
    meal_type: MealType
    food_entries: list[MealLogFoodOut]
    participant_user_ids: list[str]
    notes: str
    mood: str
    photos: list[MediaAssetOut]
    deduction_suggestions: list[DeductionSuggestionOut]
    row_version: int
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateMealLogRequest(BaseModel):
    date: date_type
    meal_type: MealType
    food_entries: list[MealLogFoodIn]
    participant_user_ids: list[str] = Field(default_factory=list)
    notes: str = ""
    mood: str = ""
    media_ids: list[str] = Field(default_factory=list)
    pending_image_job_id: str | None = None


class UpdateMealLogRequest(BaseModel):
    expected_row_version: int = Field(ge=1)
    participant_user_ids: list[str] | None = None
    notes: str | None = None
    mood: str | None = None
    media_ids: list[str] | None = None
    pending_image_job_id: str | None = None
    food_entry_ratings: list[MealLogFoodRatingIn] | None = None


class MealCompositionEntryIn(BaseModel):
    id: str | None = None
    food_id: str
    servings: float = Field(gt=0)
    note: str = ""

    @field_validator("food_id")
    @classmethod
    def validate_food_id(cls, value: str) -> str:
        cleaned = (value or "").strip()
        if not cleaned:
            raise ValueError("food_id 不能为空")
        return cleaned

    @field_validator("id")
    @classmethod
    def validate_entry_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("note")
    @classmethod
    def validate_note(cls, value: str) -> str:
        return value or ""


class UpdateMealCompositionRequest(BaseModel):
    expected_row_version: int = Field(ge=1)
    food_entries: list[MealCompositionEntryIn]
