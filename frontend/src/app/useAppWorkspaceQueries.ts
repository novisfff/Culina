import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type {
  Food,
  FoodPlanItem,
  FoodRecommendations,
  FoodScene,
  Ingredient,
  MealLog,
  Recipe,
  RecipeDiscovery,
  RecipeStats,
  ShoppingListItem,
} from '../api/types';
import type { TabKey } from './AppShell';

type WeekRange = {
  start: string;
  end: string;
};

function matchesTabWindow(activeTab: TabKey, tabs: TabKey[]) {
  return tabs.includes(activeTab);
}

export function useAppWorkspaceQueries(args: {
  activeTab: TabKey;
  isAuthenticated: boolean;
  foodPlanWeekRange: WeekRange;
}) {
  const needsMembers = matchesTabWindow(args.activeTab, ['home', 'family', 'logs']);
  const needsIngredients = matchesTabWindow(args.activeTab, ['home', 'foods', 'recipes', 'ingredients']);
  const needsInventory = matchesTabWindow(args.activeTab, ['home', 'foods', 'recipes', 'ingredients']);
  const needsShopping = matchesTabWindow(args.activeTab, ['home', 'recipes', 'ingredients']);
  const needsRecipes = matchesTabWindow(args.activeTab, ['home', 'foods', 'recipes', 'ingredients', 'family']);
  const needsRecipeInsights = args.activeTab === 'recipes';
  const needsFoodPlan = matchesTabWindow(args.activeTab, ['home', 'foods', 'recipes', 'logs']);
  const needsFoodScenes = matchesTabWindow(args.activeTab, ['foods', 'recipes']);
  const needsFoods = matchesTabWindow(args.activeTab, ['home', 'foods', 'recipes', 'logs', 'family']);
  const needsFoodRecommendations = matchesTabWindow(args.activeTab, ['home', 'foods']);
  const needsMealLogs = matchesTabWindow(args.activeTab, ['home', 'foods', 'recipes', 'logs', 'family']);
  const needsActivityLogs = matchesTabWindow(args.activeTab, ['home', 'family']);
  const needsAiConversations = args.activeTab === 'ai';

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
  const shoppingQuery = useQuery({
    queryKey: queryKeys.shoppingList,
    queryFn: api.getShoppingList,
    enabled: args.isAuthenticated && needsShopping,
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
  const activityLogsQuery = useQuery({
    queryKey: queryKeys.activityLogs,
    queryFn: api.getActivityLogs,
    enabled: args.isAuthenticated && needsActivityLogs,
  });
  const aiConversationsQuery = useQuery({
    queryKey: queryKeys.aiConversations,
    queryFn: api.getAiConversations,
    enabled: args.isAuthenticated && needsAiConversations,
    refetchInterval: args.isAuthenticated && needsAiConversations ? 2000 : false,
  });

  const isBootLoading =
    familyQuery.isLoading ||
    (needsMembers && membersQuery.isLoading) ||
    (needsIngredients && ingredientsQuery.isLoading) ||
    (needsInventory && inventoryQuery.isLoading) ||
    (needsShopping && shoppingQuery.isLoading) ||
    (needsRecipes && recipesQuery.isLoading) ||
    (needsRecipeInsights && (recipeDiscoveryQuery.isLoading || recipeStatsQuery.isLoading || recipeFavoritesQuery.isLoading)) ||
    (needsFoodPlan && foodPlanQuery.isLoading && !foodPlanQuery.data) ||
    (needsFoodScenes && foodScenesQuery.isLoading) ||
    (needsFoods && foodsQuery.isLoading) ||
    (needsFoodRecommendations && foodRecommendationsQuery.isLoading) ||
    (needsMealLogs && mealLogsQuery.isLoading) ||
    (needsActivityLogs && activityLogsQuery.isLoading) ||
    (needsAiConversations && aiConversationsQuery.isLoading);

  return {
    familyQuery,
    membersQuery,
    ingredientsQuery,
    inventoryQuery,
    shoppingQuery,
    recipesQuery,
    recipeDiscoveryQuery,
    recipeStatsQuery,
    recipeFavoritesQuery,
    foodPlanQuery,
    foodScenesQuery,
    foodsQuery,
    foodRecommendationsQuery,
    mealLogsQuery,
    activityLogsQuery,
    aiConversationsQuery,
    isBootLoading,
    members: membersQuery.data ?? [],
    ingredients: ingredientsQuery.data ?? ([] as Ingredient[]),
    inventoryItems: inventoryQuery.data ?? [],
    shoppingItems: shoppingQuery.data ?? ([] as ShoppingListItem[]),
    recipes: recipesQuery.data ?? ([] as Recipe[]),
    recipeDiscovery: recipeDiscoveryQuery.data ?? (null as RecipeDiscovery | null),
    recipeStats: recipeStatsQuery.data ?? (null as RecipeStats | null),
    recipeFavorites: recipeFavoritesQuery.data ?? [],
    foodPlanItems: foodPlanQuery.data ?? ([] as FoodPlanItem[]),
    foodScenes: foodScenesQuery.data ?? ([] as FoodScene[]),
    foods: foodsQuery.data ?? ([] as Food[]),
    foodRecommendations: foodRecommendationsQuery.data ?? (null as FoodRecommendations | null),
    mealLogs: mealLogsQuery.data ?? ([] as MealLog[]),
    activityLogs: activityLogsQuery.data ?? [],
    aiConversations: aiConversationsQuery.data ?? [],
    family: familyQuery.data,
  };
}
