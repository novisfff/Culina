from __future__ import annotations

from app.schemas.activity import ActivityLogOut
from app.schemas.ai import (
    AIConversationOut,
    AIRecipeDraftOut,
    AIRecommendationOut,
    GenerateRecipeDraftRequest,
    GenerateRecipeDraftResponse,
)
from app.schemas.family import CreateMemberRequest, FamilyDetailOut, MemberOut
from app.schemas.foods import (
    CreateFoodRequest,
    FoodOut,
    FoodRecommendationItemOut,
    FoodRecommendationRecipeAvailabilityOut,
    FoodRecommendationsOut,
    UpdateFoodFavoriteRequest,
    UpdateFoodRequest,
)
from app.schemas.ingredients import (
    CreateIngredientRequest,
    IngredientOut,
    IngredientUnitConversion,
    UpdateIngredientRequest,
)
from app.schemas.inventory import (
    ConsumeInventoryRequest,
    ConsumeInventoryResponse,
    CreateInventoryItemRequest,
    DisposeExpiredInventoryRequest,
    DisposeExpiredInventoryResponse,
    InventoryItemOut,
)
from app.schemas.meal_logs import (
    CreateMealLogRequest,
    DeductionSuggestionOut,
    MealLogFoodIn,
    MealLogFoodOut,
    MealLogOut,
    QuickAddMealLogRequest,
)
from app.schemas.media import (
    AiRenderResponse,
    CreateAiRenderRequest,
    MediaAssetOut,
    UploadMediaMetadata,
    UploadMediaResponse,
)
from app.schemas.recipes import (
    CookRecipeConsumedItemOut,
    CookRecipePreviewBatchOut,
    CookRecipePreviewItemOut,
    CookRecipePreviewRequest,
    CookRecipePreviewResponse,
    CookRecipeRequest,
    CookRecipeResponse,
    CookRecipeShortageOut,
    CreateFoodPlanItemRequest,
    CreateFoodSceneRequest,
    CreateRecipeRequest,
    FoodPlanItemOut,
    FoodSceneOut,
    RecipeAvailabilityOut,
    RecipeCookLogOut,
    RecipeDiscoveryOut,
    RecipeDiscoverySectionOut,
    RecipeFavoriteOut,
    RecipeIngredientIn,
    RecipeIngredientOut,
    RecipeOut,
    RecipeStatsItemOut,
    RecipeStatsOut,
    RecipeStepIn,
    RecipeStepOut,
    UpdateFoodPlanItemRequest,
    UpdateFoodSceneRequest,
    UpdateRecipeRequest,
)
from app.schemas.shopping import CreateShoppingListItemRequest, ShoppingListItemOut, UpdateShoppingListItemRequest
