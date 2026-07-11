from __future__ import annotations

from datetime import date as date_type, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.core.enums import FoodType, MealType
from app.schemas.media import MediaAssetOut
from app.schemas.recipes import CookRecipeShortageOut


class FoodOut(BaseModel):
    id: str
    family_id: str
    name: str
    type: FoodType
    category: str
    flavor_tags: list[str]
    scene_tags: list[str] = Field(default_factory=list)
    suitable_meal_types: list[MealType] = Field(default_factory=list)
    source_name: str
    purchase_source: str
    scene: str
    images: list[MediaAssetOut]
    notes: str
    routine_note: str
    price: float | None = None
    rating: int | None = None
    repurchase: bool | None = None
    expiry_date: date_type | None = None
    stock_quantity: float | None = None
    stock_unit: str
    storage_location: str
    favorite: bool
    recipe_id: str | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None
    row_version: int = 1


class FoodStockChangeRequest(BaseModel):
    quantity: float = Field(gt=0)
    unit: str | None = Field(default=None, max_length=32)
    expiry_date: date_type | None = None
    purchase_source: str | None = Field(default=None, max_length=120)
    storage_location: str | None = Field(default=None, max_length=120)
    note: str = Field(default="", max_length=255)
    reason: str = Field(default="", max_length=255)
    expected_row_version: int = Field(ge=1)


class FoodStockChangeOut(FoodOut):
    pass


class FoodRecommendationRecipeAvailabilityOut(BaseModel):
    recipe_id: str
    availability: Literal["ready", "partial", "missing"]
    availability_score: float
    ready_count: int
    total_count: int
    shortages: list[CookRecipeShortageOut] = Field(default_factory=list)


class FoodRecommendationItemOut(BaseModel):
    food: FoodOut
    score: float
    reasons: list[str] = Field(default_factory=list)
    primary_action: Literal["cook_recipe", "quick_add_meal", "review_food"]
    recipe_availability: FoodRecommendationRecipeAvailabilityOut | None = None


class FoodRecommendationsOut(BaseModel):
    target_meal_type: MealType
    target_date: date_type
    items: list[FoodRecommendationItemOut] = Field(default_factory=list)


class CreateFoodRequest(BaseModel):
    name: str
    type: FoodType
    category: str
    flavor_tags: list[str] = Field(default_factory=list)
    scene_tags: list[str] = Field(default_factory=list)
    suitable_meal_types: list[MealType] = Field(default_factory=list)
    source_name: str = ""
    purchase_source: str = ""
    scene: str = ""
    notes: str = ""
    routine_note: str = ""
    price: float | None = None
    rating: int | None = None
    repurchase: bool | None = None
    expiry_date: date_type | None = None
    stock_quantity: float | None = None
    stock_unit: str = ""
    storage_location: str = ""
    favorite: bool = False
    recipe_id: str | None = None
    media_ids: list[str] = Field(default_factory=list)
    pending_image_job_id: str | None = None

    @model_validator(mode="after")
    def validate_food_details(self) -> "CreateFoodRequest":
        if self.rating is not None and (self.rating < 1 or self.rating > 5):
            raise ValueError("评分必须在 1 到 5 之间")
        if self.price is not None and self.price < 0:
            raise ValueError("价格不能为负数")
        if self.stock_quantity is not None and self.stock_quantity < 0:
            raise ValueError("剩余数量不能为负数")
        return self


class UpdateFoodRequest(CreateFoodRequest):
    # Optional for AI draft payloads (they use baseUpdatedAt); HTTP routes require it.
    expected_row_version: int | None = Field(default=None, ge=1)


class UpdateFoodFavoriteRequest(BaseModel):
    favorite: bool
    expected_row_version: int = Field(ge=1)
