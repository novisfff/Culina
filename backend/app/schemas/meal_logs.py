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
    participant_user_ids: list[str] | None = None
    notes: str | None = None
    mood: str | None = None
    media_ids: list[str] | None = None
    pending_image_job_id: str | None = None
    food_entry_ratings: list[MealLogFoodRatingIn] | None = None


class QuickAddMealLogRequest(BaseModel):
    food_id: str
    date: date_type
    meal_type: MealType
    servings: float = 1
    note: str = ""
    food_plan_item_id: str | None = None
    deduct_food_stock: bool = False
    expected_food_row_version: int | None = Field(default=None, ge=1)
    stock_quantity: float | None = Field(default=None, gt=0)
    stock_unit: str | None = Field(default=None, max_length=32)

    @field_validator("servings")
    @classmethod
    def validate_servings(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("份数必须大于 0")
        return value

    @model_validator(mode="after")
    def validate_stock_version(self) -> "QuickAddMealLogRequest":
        if self.deduct_food_stock and self.expected_food_row_version is None:
            raise ValueError("扣减成品库存时必须提供 expected_food_row_version")
        return self
