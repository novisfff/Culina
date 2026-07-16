import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type {
  Food,
  FoodPlanItem,
  FoodRecommendations,
  FoodScene,
  Ingredient,
  IngredientInventoryState,
  InventoryOperationSummary,
  MealInsight,
  MealLog,
  Recipe,
  RecipeDiscovery,
  RecipeStats,
  ShoppingListItem,
} from '../api/types';
import {
  deriveAppQueryScope,
  type AppNavigationState,
} from './appNavigationModel';

type WeekRange = {
  start: string;
  end: string;
};

export function useAppWorkspaceQueries(args: {
  navigationState: AppNavigationState;
  isAuthenticated: boolean;
  foodPlanWeekRange: WeekRange;
}) {
  const scope = deriveAppQueryScope(args.navigationState);
  const {
    needsMembers,
    needsIngredients,
    needsInventory,
    needsShopping,
    needsRecipes,
    needsRecipeInsights,
    needsFoodPlan,
    needsFoodPlanDetail,
    needsFoodScenes,
    needsFoods,
    needsFoodRecommendations,
    needsMealLogs,
    needsActivityLogs,
    needsAiConversations,
  } = scope;

  // Local-only windows not modeled on AppQueryScope.
  const needsActivityHighlights = args.navigationState.primaryTab === 'home';
  const needsInventoryOperations = args.navigationState.primaryTab === 'ingredients';
  // Phase-two family memories: history view only; never part of boot loading.
  const needsMealInsights =
    args.navigationState.primaryTab === 'eat' && args.navigationState.eat.baseView === 'history';

  const planDetailId =
    args.navigationState.eat.task?.kind === 'plan-detail'
      ? args.navigationState.eat.task.foodPlanItemId
      : args.navigationState.eat.task?.kind === 'meal-create' &&
          args.navigationState.eat.task.source.kind === 'plan'
        ? args.navigationState.eat.task.source.foodPlanItemId
        : null;

  const familyQuery = useQuery({
    queryKey: queryKeys.family,
    queryFn: api.getFamily,
    enabled: args.isAuthenticated,
  });
  const membersQuery = useQuery({
    queryKey: queryKeys.members,
    queryFn: api.getMembers,
    enabled: args.isAuthenticated && needsMembers,
  });
  const ingredientsQuery = useQuery({
    queryKey: queryKeys.ingredients,
    queryFn: () => api.getIngredients(),
    enabled: args.isAuthenticated && needsIngredients,
  });
  const inventoryQuery = useQuery({
    queryKey: queryKeys.inventory,
    queryFn: () => api.getInventory(),
    enabled: args.isAuthenticated && needsInventory,
  });
  const inventoryStatesQuery = useQuery({
    queryKey: queryKeys.inventoryStates,
    queryFn: () => api.listInventoryStates(),
    enabled: args.isAuthenticated && needsInventory,
  });
  const shoppingQuery = useQuery({
    queryKey: queryKeys.shoppingList,
    queryFn: api.getShoppingList,
    enabled: args.isAuthenticated && needsShopping,
  });
  const inventoryOperationsQuery = useQuery({
    queryKey: queryKeys.inventoryOperationList(20),
    queryFn: () => api.listInventoryOperations({ limit: 20 }),
    enabled: args.isAuthenticated && needsInventoryOperations,
  });
  const recipesQuery = useQuery({
    queryKey: queryKeys.recipes,
    queryFn: () => api.getRecipes(),
    enabled: args.isAuthenticated && needsRecipes,
  });
  const recipeDiscoveryQuery = useQuery({
    queryKey: queryKeys.recipeDiscovery,
    queryFn: () => api.getRecipeDiscovery(8),
    enabled: args.isAuthenticated && needsRecipeInsights,
  });
  const recipeStatsQuery = useQuery({
    queryKey: queryKeys.recipeStats,
    queryFn: () => api.getRecipeStats(undefined, undefined, 10),
    enabled: args.isAuthenticated && needsRecipeInsights,
  });
  const recipeFavoritesQuery = useQuery({
    queryKey: queryKeys.recipeFavorites,
    queryFn: api.getRecipeFavorites,
    enabled: args.isAuthenticated && needsRecipeInsights,
  });
  const foodPlanQuery = useQuery({
    queryKey: queryKeys.foodPlan(args.foodPlanWeekRange.start, args.foodPlanWeekRange.end),
    queryFn: () => api.getFoodPlan(args.foodPlanWeekRange.start, args.foodPlanWeekRange.end),
    enabled: args.isAuthenticated && needsFoodPlan,
    placeholderData: keepPreviousData,
  });
  const foodPlanDetailQuery = useQuery({
    queryKey: queryKeys.foodPlanDetail(planDetailId ?? ''),
    queryFn: () => api.getFoodPlanItem(planDetailId as string),
    enabled: args.isAuthenticated && needsFoodPlanDetail && Boolean(planDetailId),
  });
  const foodScenesQuery = useQuery({
    queryKey: queryKeys.foodScenes,
    queryFn: api.getFoodScenes,
    enabled: args.isAuthenticated && needsFoodScenes,
  });
  const foodsQuery = useQuery({
    queryKey: queryKeys.foods,
    queryFn: () => api.getFoods(),
    enabled: args.isAuthenticated && needsFoods,
  });
  const foodRecommendationsQuery = useQuery({
    queryKey: queryKeys.foodRecommendations,
    queryFn: () => api.getFoodRecommendations({ limit: 12, now: new Date().toISOString() }),
    enabled: args.isAuthenticated && needsFoodRecommendations,
  });
  const mealLogsQuery = useQuery({
    queryKey: queryKeys.mealLogs,
    queryFn: api.getMealLogs,
    enabled: args.isAuthenticated && needsMealLogs,
  });
  const mealInsightsQuery = useQuery({
    queryKey: queryKeys.mealInsights,
    queryFn: api.getMealInsights,
    enabled: args.isAuthenticated && needsMealInsights,
  });
  // Shared result bar surfaces: Home, Food (eat), Ingredient, History.
  // Disabled on AI-only / family settings surfaces so phase-one never polls there.
  const needsActiveMealRecordOperations =
    args.navigationState.primaryTab === 'home' ||
    args.navigationState.primaryTab === 'ingredients' ||
    args.navigationState.primaryTab === 'eat';
  const activeMealRecordOperationsQuery = useQuery({
    queryKey: queryKeys.mealRecordOperations(true),
    queryFn: () => api.getActiveMealRecordOperations(true),
    enabled: args.isAuthenticated && needsActiveMealRecordOperations,
  });
  const activityLogsQuery = useQuery({
    queryKey: queryKeys.activityLogs,
    queryFn: () => api.getActivityLogs(),
    enabled: args.isAuthenticated && needsActivityLogs,
  });
  const activityHighlightsQuery = useQuery({
    queryKey: queryKeys.activityHighlightList(5),
    queryFn: () => api.getActivityHighlights(5),
    enabled: args.isAuthenticated && needsActivityHighlights,
  });
  const aiConversationsQuery = useQuery({
    queryKey: queryKeys.aiConversations,
    queryFn: api.getAiConversations,
    enabled: args.isAuthenticated && needsAiConversations,
    refetchInterval: args.isAuthenticated && needsAiConversations ? 2000 : false,
  });

  // foodPlanDetailQuery is intentionally excluded from isBootLoading — it is a
  // local task loading state, not a global application blank screen.
  const isBootLoading =
    familyQuery.isLoading ||
    (needsMembers && membersQuery.isLoading) ||
    (needsIngredients && ingredientsQuery.isLoading) ||
    (needsInventory && (inventoryQuery.isLoading || inventoryStatesQuery.isLoading)) ||
    (needsShopping && shoppingQuery.isLoading) ||
    (needsRecipes && recipesQuery.isLoading) ||
    (needsRecipeInsights &&
      (recipeDiscoveryQuery.isLoading || recipeStatsQuery.isLoading || recipeFavoritesQuery.isLoading)) ||
    (needsFoodPlan && foodPlanQuery.isLoading && !foodPlanQuery.data) ||
    (needsFoodScenes && foodScenesQuery.isLoading) ||
    (needsFoods && foodsQuery.isLoading) ||
    (needsFoodRecommendations && foodRecommendationsQuery.isLoading) ||
    (needsMealLogs && mealLogsQuery.isLoading) ||
    (needsAiConversations && aiConversationsQuery.isLoading);

  return {
    familyQuery,
    membersQuery,
    ingredientsQuery,
    inventoryQuery,
    inventoryStatesQuery,
    shoppingQuery,
    inventoryOperationsQuery,
    recipesQuery,
    recipeDiscoveryQuery,
    recipeStatsQuery,
    recipeFavoritesQuery,
    foodPlanQuery,
    foodPlanDetailQuery,
    foodScenesQuery,
    foodsQuery,
    foodRecommendationsQuery,
    mealLogsQuery,
    mealInsightsQuery,
    activeMealRecordOperationsQuery,
    activityLogsQuery,
    activityHighlightsQuery,
    aiConversationsQuery,
    isBootLoading,
    members: membersQuery.data ?? [],
    ingredients: ingredientsQuery.data ?? ([] as Ingredient[]),
    inventoryItems: inventoryQuery.data ?? [],
    inventoryStates: inventoryStatesQuery.data ?? ([] as IngredientInventoryState[]),
    shoppingItems: shoppingQuery.data ?? ([] as ShoppingListItem[]),
    inventoryOperations: inventoryOperationsQuery.data ?? ([] as InventoryOperationSummary[]),
    recipes: recipesQuery.data ?? ([] as Recipe[]),
    recipeDiscovery: recipeDiscoveryQuery.data ?? (null as RecipeDiscovery | null),
    recipeStats: recipeStatsQuery.data ?? (null as RecipeStats | null),
    recipeFavorites: recipeFavoritesQuery.data ?? [],
    foodPlanItems: foodPlanQuery.data ?? ([] as FoodPlanItem[]),
    foodPlanDetail: foodPlanDetailQuery.data ?? (null as FoodPlanItem | null),
    foodScenes: foodScenesQuery.data ?? ([] as FoodScene[]),
    foods: foodsQuery.data ?? ([] as Food[]),
    foodRecommendations: foodRecommendationsQuery.data ?? (null as FoodRecommendations | null),
    mealLogs: mealLogsQuery.data ?? ([] as MealLog[]),
    mealInsights: mealInsightsQuery.data ?? ([] as MealInsight[]),
    activeMealRecordOperations: activeMealRecordOperationsQuery.data ?? [],
    aiConversations: aiConversationsQuery.data ?? [],
    family: familyQuery.data,
  };
}
