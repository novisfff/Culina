from __future__ import annotations

from datetime import date, datetime
from datetime import date as date_type
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.enums import (
    AiMode,
    Difficulty,
    FoodType,
    ImageGenerationMode,
    IngredientExpiryMode,
    InventoryStatus,
    MealType,
    MediaEntityType,
    MediaSource,
    UserRole,
)


class MediaAssetOut(BaseModel):
    id: str
    name: str
    url: str
    source: MediaSource
    alt: str
    generation_mode: ImageGenerationMode | None = None
    reference_media_id: str | None = None
    style_key: str | None = None
    prompt_version: str | None = None
    created_at: datetime
    created_by: str | None = None


class MemberOut(BaseModel):
    id: str
    username: str
    display_name: str
    email: str | None = None
    phone: str | None = None
    avatar_seed: str
    role: UserRole
    status: str


class CreateMemberRequest(BaseModel):
    username: str
    display_name: str
    password: str
    role: UserRole
    email: str | None = None


class IngredientUnitConversion(BaseModel):
    unit: str
    ratio_to_default: float

    @field_validator("unit")
    @classmethod
    def validate_unit(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("单位不能为空")
        return normalized

    @field_validator("ratio_to_default")
    @classmethod
    def validate_ratio_to_default(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("换算值必须大于 0")
        return value


class IngredientOut(BaseModel):
    id: str
    family_id: str
    name: str
    category: str
    default_unit: str
    unit_conversions: list[IngredientUnitConversion] = Field(default_factory=list)
    default_storage: str
    default_expiry_mode: IngredientExpiryMode
    default_expiry_days: int | None = None
    default_low_stock_threshold: float | None = None
    notes: str
    image: MediaAssetOut | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateIngredientRequest(BaseModel):
    name: str
    category: str
    default_unit: str
    unit_conversions: list[IngredientUnitConversion] = Field(default_factory=list)
    default_storage: str
    default_expiry_mode: IngredientExpiryMode = IngredientExpiryMode.NONE
    default_expiry_days: int | None = None
    default_low_stock_threshold: float | None = None
    notes: str = ""
    media_ids: list[str] = Field(default_factory=list)

    @field_validator("default_unit")
    @classmethod
    def validate_default_unit(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("主单位不能为空")
        return normalized

    @model_validator(mode="after")
    def validate_unit_conversions(self) -> "CreateIngredientRequest":
        seen_units = {self.default_unit}
        for entry in self.unit_conversions:
            if entry.unit in seen_units:
                raise ValueError("副单位不能重复，也不能与主单位相同")
            seen_units.add(entry.unit)
        if self.default_low_stock_threshold is not None and self.default_low_stock_threshold <= 0:
            raise ValueError("默认低库存提醒值必须大于 0")
        return self


class UpdateIngredientRequest(BaseModel):
    name: str
    category: str
    default_unit: str
    unit_conversions: list[IngredientUnitConversion] = Field(default_factory=list)
    default_storage: str
    default_expiry_mode: IngredientExpiryMode = IngredientExpiryMode.NONE
    default_expiry_days: int | None = None
    default_low_stock_threshold: float | None = None
    notes: str = ""
    media_ids: list[str] = Field(default_factory=list)

    @field_validator("default_unit")
    @classmethod
    def validate_default_unit(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("主单位不能为空")
        return normalized

    @model_validator(mode="after")
    def validate_unit_conversions(self) -> "UpdateIngredientRequest":
        seen_units = {self.default_unit}
        for entry in self.unit_conversions:
            if entry.unit in seen_units:
                raise ValueError("副单位不能重复，也不能与主单位相同")
            seen_units.add(entry.unit)
        if self.default_low_stock_threshold is not None and self.default_low_stock_threshold <= 0:
            raise ValueError("默认低库存提醒值必须大于 0")
        return self


class InventoryItemOut(BaseModel):
    id: str
    family_id: str
    ingredient_id: str
    ingredient_name: str
    quantity: float
    consumed_quantity: float
    remaining_quantity: float
    unit: str
    entered_quantity: float | None = None
    entered_unit: str | None = None
    status: InventoryStatus
    purchase_date: date
    expiry_date: date | None = None
    storage_location: str
    notes: str
    low_stock_threshold: float
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateInventoryItemRequest(BaseModel):
    ingredient_id: str
    quantity: float
    unit: str
    status: InventoryStatus
    purchase_date: date
    expiry_date: date | None = None
    storage_location: str
    notes: str = ""
    low_stock_threshold: float = 0


class ConsumeInventoryRequest(BaseModel):
    ingredient_id: str
    quantity: float
    unit: str


class ConsumeInventoryResponse(BaseModel):
    ingredient_id: str
    unit: str
    consumed_quantity: float
    affected_item_ids: list[str] = Field(default_factory=list)


class DisposeExpiredInventoryRequest(BaseModel):
    ingredient_id: str
    inventory_item_ids: list[str] = Field(default_factory=list, min_length=1)


class DisposeExpiredInventoryResponse(BaseModel):
    ingredient_id: str
    disposed_item_ids: list[str] = Field(default_factory=list)
    disposed_count: int


class ShoppingListItemOut(BaseModel):
    id: str
    family_id: str
    title: str
    quantity: float
    unit: str
    reason: str
    done: bool
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateShoppingListItemRequest(BaseModel):
    title: str
    quantity: float
    unit: str
    reason: str = ""


class UpdateShoppingListItemRequest(BaseModel):
    done: bool


class RecipeIngredientIn(BaseModel):
    ingredient_id: str | None = None
    ingredient_name: str
    quantity: float
    unit: str
    note: str = ""


class RecipeIngredientOut(RecipeIngredientIn):
    id: str


class RecipeStepIn(BaseModel):
    title: str = ""
    text: str
    icon: str = "pan"
    summary: str = ""
    estimated_minutes: int | None = None
    tip: str = ""
    key_points: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def coerce_legacy_step(cls, value: object) -> object:
        if isinstance(value, str):
            return {"title": "", "text": value}
        return value


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
    cook_date: date
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
    scene_tags: list[str]
    images: list[MediaAssetOut]
    cook_logs: list[RecipeCookLogOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class RecipeSceneOut(BaseModel):
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


class CreateRecipeSceneRequest(BaseModel):
    name: str
    description: str = ""
    image_prompt: str = ""
    image_asset_id: str | None = None
    hidden: bool = False
    custom: bool = True
    sort_order: int = 0


class UpdateRecipeSceneRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    image_prompt: str | None = None
    image_asset_id: str | None = None
    hidden: bool | None = None
    custom: bool | None = None
    sort_order: int | None = None


class CreateRecipeRequest(BaseModel):
    title: str
    servings: int
    prep_minutes: int
    difficulty: Difficulty
    ingredient_items: list[RecipeIngredientIn]
    steps: list[RecipeStepIn]
    tips: str = ""
    scene_tags: list[str] = Field(default_factory=list)
    media_ids: list[str] = Field(default_factory=list)
    auto_create_food: bool = True


class UpdateRecipeRequest(BaseModel):
    title: str
    servings: int
    prep_minutes: int
    difficulty: Difficulty
    ingredient_items: list[RecipeIngredientIn]
    steps: list[RecipeStepIn]
    tips: str = ""
    scene_tags: list[str] = Field(default_factory=list)
    media_ids: list[str] = Field(default_factory=list)


class CookRecipeRequest(BaseModel):
    servings: float
    date: date_type | None = None
    meal_type: MealType | None = None
    participant_user_ids: list[str] = Field(default_factory=list)
    notes: str = ""
    create_meal_log: bool = False
    recipe_plan_item_id: str | None = None
    result_note: str = ""
    adjustments: str = ""
    rating: int | None = None


class CookRecipeConsumedItemOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    requested_quantity: float
    unit: str
    affected_item_ids: list[str] = Field(default_factory=list)


class CookRecipePreviewBatchOut(BaseModel):
    inventory_item_id: str
    quantity: float
    unit: str
    purchase_date: date
    expiry_date: date | None = None
    storage_location: str


class CookRecipePreviewItemOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    requested_quantity: float
    unit: str
    batches: list[CookRecipePreviewBatchOut] = Field(default_factory=list)


class CookRecipeShortageOut(BaseModel):
    ingredient_id: str | None = None
    ingredient_name: str
    required_quantity: float
    available_quantity: float
    missing_quantity: float
    unit: str


class CookRecipeResponse(BaseModel):
    recipe_id: str
    consumed_items: list[CookRecipeConsumedItemOut] = Field(default_factory=list)
    shortages: list[CookRecipeShortageOut] = Field(default_factory=list)
    meal_log_id: str | None = None
    cook_log_id: str | None = None


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
    last_used_at: date | None = None


class RecipeStatsOut(BaseModel):
    total_cooks: int
    recently_cooked: list[RecipeStatsItemOut] = Field(default_factory=list)
    frequent: list[RecipeStatsItemOut] = Field(default_factory=list)


class RecipeFavoriteOut(BaseModel):
    id: str
    family_id: str
    user_id: str
    recipe_id: str
    created_at: datetime


class RecipePlanItemOut(BaseModel):
    id: str
    family_id: str
    user_id: str
    recipe_id: str
    recipe_title: str
    plan_date: date
    meal_type: MealType
    note: str
    status: str
    completed_at: datetime | None = None
    meal_log_id: str | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateRecipePlanItemRequest(BaseModel):
    recipe_id: str
    plan_date: date
    meal_type: MealType
    note: str = ""


class UpdateRecipePlanItemRequest(BaseModel):
    recipe_id: str | None = None
    plan_date: date | None = None
    meal_type: MealType | None = None
    note: str | None = None
    status: str | None = None


class FoodOut(BaseModel):
    id: str
    family_id: str
    name: str
    type: FoodType
    category: str
    flavor_tags: list[str]
    source_name: str
    scene: str
    images: list[MediaAssetOut]
    notes: str
    favorite: bool
    recipe_id: str | None = None
    created_at: datetime
    updated_at: datetime
    created_by: str | None = None
    updated_by: str | None = None


class CreateFoodRequest(BaseModel):
    name: str
    type: FoodType
    category: str
    flavor_tags: list[str] = Field(default_factory=list)
    source_name: str = ""
    scene: str = ""
    notes: str = ""
    favorite: bool = False
    recipe_id: str | None = None
    media_ids: list[str] = Field(default_factory=list)


class UpdateFoodFavoriteRequest(BaseModel):
    favorite: bool


class MealLogFoodIn(BaseModel):
    food_id: str
    servings: float
    note: str = ""


class MealLogFoodOut(MealLogFoodIn):
    id: str
    food_name: str


class DeductionSuggestionOut(BaseModel):
    id: str
    ingredient_name: str
    suggested_amount: float
    unit: str
    based_on_food_name: str


class MealLogOut(BaseModel):
    id: str
    family_id: str
    date: date
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
    date: date
    meal_type: MealType
    food_entries: list[MealLogFoodIn]
    participant_user_ids: list[str] = Field(default_factory=list)
    notes: str = ""
    mood: str = ""
    media_ids: list[str] = Field(default_factory=list)


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


class AIConversationOut(BaseModel):
    id: str
    family_id: str
    mode: AiMode
    prompt: str
    response: str
    created_at: datetime
    created_by: str | None = None
    context: dict


class AIRecommendationOut(BaseModel):
    id: str
    family_id: str
    title: str
    detail: str
    created_at: datetime


class AIQueryRequest(BaseModel):
    mode: AiMode
    prompt: str = ""
    food_id: str | None = None
    ingredient_ids: list[str] = Field(default_factory=list)


class AIQueryResponse(BaseModel):
    conversation: AIConversationOut
    recommendation: AIRecommendationOut | None = None


class AIRecipeDraftOut(BaseModel):
    title: str
    servings: int
    prep_minutes: int
    difficulty: Difficulty
    ingredient_items: list[RecipeIngredientIn]
    steps: list[RecipeStepIn]
    tips: str = ""
    scene_tags: list[str] = Field(default_factory=list)
    media_ids: list[str] = Field(default_factory=list)


class GenerateRecipeDraftRequest(BaseModel):
    title: str = ""
    prompt: str = ""
    ingredient_ids: list[str] = Field(default_factory=list)
    extra_ingredients: list[str] = Field(default_factory=list)
    servings: int | None = None
    prep_minutes: int | None = None
    difficulty: Difficulty | None = None
    scene_tags: list[str] = Field(default_factory=list)
    generate_image: bool = True


class GenerateRecipeDraftResponse(BaseModel):
    draft: AIRecipeDraftOut | None = None
    agent_run_id: str
    status: Literal["completed", "failed"]
    error: str | None = None
    image_render_payload: dict | None = None


class FamilyDetailOut(BaseModel):
    id: str
    name: str
    motto: str
    location: str
    created_at: datetime
    updated_at: datetime
    ai_recommendations: list[AIRecommendationOut] = Field(default_factory=list)


class UploadMediaResponse(BaseModel):
    id: str
    name: str
    url: str
    source: MediaSource
    alt: str
    generation_mode: ImageGenerationMode | None = None
    reference_media_id: str | None = None
    style_key: str | None = None
    prompt_version: str | None = None
    created_at: datetime
    created_by: str | None = None


class UploadMediaMetadata(BaseModel):
    source: MediaSource = MediaSource.UPLOAD
    alt: str = ""


class CreateAiRenderRequest(BaseModel):
    mode: ImageGenerationMode
    entity_type: MediaEntityType
    reference_media_id: str | None = None
    title: str = ""
    category: str = ""
    notes: str = ""
    tags: list[str] = Field(default_factory=list)
    scene: str = ""
    meal_type: MealType | None = None
    food_names: list[str] = Field(default_factory=list)
    ingredient_names: list[str] = Field(default_factory=list)
    size: str = ""


class AiRenderResponse(BaseModel):
    generated_asset: MediaAssetOut
    reference_asset: MediaAssetOut | None = None
    style_key: str
    prompt_version: str
    generation_mode: Literal["reference", "text"]
