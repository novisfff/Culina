from __future__ import annotations

from datetime import date as date_type, datetime
from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

from app.core.enums import Difficulty, MealType
from app.schemas.media import MediaAssetOut


class RecipeIngredientIn(BaseModel):
    ingredient_id: str | None = None
    ingredient_name: str = Field(min_length=1)
    quantity: float | None = Field(default=None, gt=0)
    unit: str = ""
    note: str = ""


class RecipeIngredientOut(RecipeIngredientIn):
    id: str
    quantity: float = Field(gt=0)
    unit: str = Field(min_length=1)


class RecipeStepIn(BaseModel):
    title: str = ""
    text: str
    icon: str = "pan"
    summary: str = ""
    estimated_minutes: int | None = None
    tip: str = ""
    key_points: list[str] = Field(default_factory=list)


class RecipeStepOut(BaseModel):
    id: str
    title: str = ""
    text: str
    icon: str = "pan"
    summary: str = ""
    estimated_minutes: int | None = None
    tip: str = ""
    key_points: list[str] = Field(default_factory=list)


class RecipeCookLogOut(BaseModel):
    id: str
    family_id: str
    recipe_id: str
    meal_log_id: str | None = None
    cook_date: date_type
    meal_type: MealType
    servings: float
    result_note: str
    adjustments: str
    rating: int | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class RecipeOut(BaseModel):
    id: str
    family_id: str
    title: str
    servings: int
    prep_minutes: int
    difficulty: Difficulty
    ingredient_items: list[RecipeIngredientOut]
    steps: list[RecipeStepOut]
    tips: str
    scene_tags: list[str] = Field(default_factory=list)
    images: list[MediaAssetOut]
    cook_logs: list[RecipeCookLogOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class FoodSceneOut(BaseModel):
    id: str
    family_id: str
    name: str
    description: str
    image_prompt: str
    image: MediaAssetOut | None = None
    hidden: bool
    custom: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateFoodSceneRequest(BaseModel):
    name: str
    description: str = ""
    image_prompt: str = ""
    image_asset_id: str | None = None
    pending_image_job_id: str | None = None
    hidden: bool = False
    custom: bool = True
    sort_order: int = 0


class UpdateFoodSceneRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    image_prompt: str | None = None
    image_asset_id: str | None = None
    pending_image_job_id: str | None = None
    hidden: bool | None = None
    custom: bool | None = None
    sort_order: int | None = None


class CreateRecipeRequest(BaseModel):
    title: str = Field(min_length=1)
    servings: int = Field(gt=0)
    prep_minutes: int = Field(ge=0)
    difficulty: Difficulty
    ingredient_items: list[RecipeIngredientIn] = Field(min_length=1)
    steps: list[RecipeStepIn]
    tips: str = ""
    scene_tags: list[str] = Field(default_factory=list)
    media_ids: list[str] = Field(default_factory=list)
    pending_image_job_id: str | None = None


class UpdateRecipeRequest(CreateRecipeRequest):
    pass


class CookRecipePreviewRequest(BaseModel):
    """Preview-only shape: does not claim a completion identity."""

    servings: float = Field(gt=0)
    allow_partial_inventory_deduction: bool = False


class CookRecipeDraftFields(BaseModel):
    """Shared cook fields for AI draft normalization (no completion claim)."""

    servings: float = Field(gt=0)
    date: date_type | None = None
    meal_type: MealType | None = None
    participant_user_ids: list[str] = Field(default_factory=list)
    notes: str = ""
    result_note: str = ""
    adjustments: str = ""
    rating: int | None = Field(default=None, ge=1, le=5)
    allow_partial_inventory_deduction: bool = False


class CookRecipeRequest(CookRecipeDraftFields):
    completion_request_id: str = Field(min_length=1, max_length=120)
    food_plan_item_id: str | None = None
    food_plan_item_base_updated_at: datetime | None = None
    target_meal_log_id: str | None = None
    expected_meal_log_row_version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def require_plan_base_timestamp(self) -> Self:
        if self.food_plan_item_id and self.food_plan_item_base_updated_at is None:
            raise ValueError("计划来源完成请求必须提供 food_plan_item_base_updated_at")
        if self.target_meal_log_id and self.expected_meal_log_row_version is None:
            raise ValueError("加入已有餐时必须提供 expected_meal_log_row_version")
        if self.expected_meal_log_row_version is not None and not self.target_meal_log_id:
            raise ValueError("expected_meal_log_row_version 不能脱离 target_meal_log_id 使用")
        return self


class CookRecipeConsumedItemOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    requested_quantity: float
    unit: str
    quantity_tracking_mode: str = "track_quantity"
    deduction_note: str | None = None
    affected_item_ids: list[str] = Field(default_factory=list)


class CookRecipePreviewBatchOut(BaseModel):
    inventory_item_id: str
    quantity: float
    unit: str
    purchase_date: date_type
    expiry_date: date_type | None = None
    storage_location: str


class CookRecipePreviewItemOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    requested_quantity: float
    unit: str
    quantity_tracking_mode: str = "track_quantity"
    deduction_note: str | None = None
    batches: list[CookRecipePreviewBatchOut] = Field(default_factory=list)


class CookRecipeShortageOut(BaseModel):
    ingredient_id: str | None = None
    ingredient_name: str
    required_quantity: float
    available_quantity: float
    missing_quantity: float
    unit: str
    shortage_type: str = "quantity"


class CookRecipeResponse(BaseModel):
    recipe_id: str
    consumed_items: list[CookRecipeConsumedItemOut] = Field(default_factory=list)
    shortages: list[CookRecipeShortageOut] = Field(default_factory=list)
    meal_log_id: str | None = None
    cook_log_id: str | None = None
    replayed: bool = False


class CookRecipePreviewResponse(BaseModel):
    recipe_id: str
    preview_items: list[CookRecipePreviewItemOut] = Field(default_factory=list)
    shortages: list[CookRecipeShortageOut] = Field(default_factory=list)


class RecipeAvailabilityOut(BaseModel):
    recipe_id: str
    availability: Literal["ready", "partial", "missing"]
    availability_score: float
    ready_count: int
    total_count: int
    shortages: list[CookRecipeShortageOut] = Field(default_factory=list)


class RecipeDiscoverySectionOut(BaseModel):
    recipe_ids: list[str] = Field(default_factory=list)
    recipes: list[RecipeOut] = Field(default_factory=list)


class RecipeDiscoveryOut(BaseModel):
    recommended: RecipeDiscoverySectionOut
    ready: RecipeDiscoverySectionOut
    quick: RecipeDiscoverySectionOut
    missing: RecipeDiscoverySectionOut


class RecipeStatsItemOut(BaseModel):
    recipe_id: str
    recipe_title: str
    count: int
    last_used_at: date_type | None = None


class RecipeStatsOut(BaseModel):
    total_cooks: int
    recently_cooked: list[RecipeStatsItemOut] = Field(default_factory=list)
    frequent: list[RecipeStatsItemOut] = Field(default_factory=list)


class FoodPlanItemOut(BaseModel):
    id: str
    family_id: str
    user_id: str
    food_id: str
    food_name: str
    food_type: str
    recipe_id: str | None = None
    recipe_title: str = ""
    plan_date: date_type
    meal_type: MealType
    note: str
    status: str
    completed_at: datetime | None = None
    meal_log_id: str | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateFoodPlanItemRequest(BaseModel):
    food_id: str
    plan_date: date_type
    meal_type: MealType
    note: str = ""


class UpdateFoodPlanItemRequest(BaseModel):
    food_id: str | None = None
    plan_date: date_type | None = None
    meal_type: MealType | None = None
    note: str | None = None
    status: str | None = None


class CompleteFoodPlanItemRequest(BaseModel):
    food_plan_item_base_updated_at: datetime
    target_meal_log_id: str | None = None
    expected_meal_log_row_version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def require_target_version_pair(self) -> Self:
        if self.target_meal_log_id and self.expected_meal_log_row_version is None:
            raise ValueError("加入已有餐时必须提供 expected_meal_log_row_version")
        if self.expected_meal_log_row_version is not None and not self.target_meal_log_id:
            raise ValueError("expected_meal_log_row_version 不能脱离 target_meal_log_id 使用")
        return self

