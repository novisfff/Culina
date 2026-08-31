import type { AppNavigationState } from './appNavigationModel';
import { deriveAppQueryScope } from './appNavigationModel';
import { useAiQueries } from './useAiQueries';
import { useAppShellQueries } from './useAppShellQueries';
import { useEatQueries } from './useEatQueries';
import { useFamilyQueries } from './useFamilyQueries';
import { useFoodPlanQueries } from './useFoodPlanQueries';
import { useHomeQueries } from './useHomeQueries';
import { useIngredientQueries } from './useIngredientQueries';

type WeekRange = { start: string; end: string };

export function useAppWorkspaceQueries(args: { navigationState: AppNavigationState; isAuthenticated: boolean; foodPlanWeekRange: WeekRange }) {
  const scope = deriveAppQueryScope(args.navigationState);
  const primary = args.navigationState.primaryTab;
  const planDetailId = args.navigationState.eat.task?.kind === 'plan-detail' ? args.navigationState.eat.task.foodPlanItemId : args.navigationState.eat.task?.kind === 'meal-create' && args.navigationState.eat.task.source.kind === 'plan' ? args.navigationState.eat.task.source.foodPlanItemId : null;
  const shell = useAppShellQueries({ isAuthenticated: args.isAuthenticated });
  const home = useHomeQueries({ isAuthenticated: args.isAuthenticated, enabled: primary === 'home' || primary === 'ingredients' || primary === 'eat' });
  const ingredients = useIngredientQueries({ isAuthenticated: args.isAuthenticated, enabled: scope.needsIngredients, needsInventory: scope.needsInventory, needsShopping: scope.needsShopping, includeOperations: primary === 'ingredients' });
  const eat = useEatQueries({ isAuthenticated: args.isAuthenticated, needsRecipes: scope.needsRecipes, needsInsights: scope.needsRecipeInsights, needsFoods: scope.needsFoods, needsMealLogs: scope.needsMealLogs, needsMealInsights: primary === 'eat' && args.navigationState.eat.baseView === 'history' });
  const foodPlan = useFoodPlanQueries({ isAuthenticated: args.isAuthenticated, enabled: scope.needsFoodPlan, needsDetail: scope.needsFoodPlanDetail, needsScenes: scope.needsFoodScenes, needsRecommendations: scope.needsFoodRecommendations, weekRange: args.foodPlanWeekRange, planDetailId });
  const family = useFamilyQueries({ isAuthenticated: args.isAuthenticated, enabled: scope.needsActivityLogs });
  const ai = useAiQueries({ isAuthenticated: args.isAuthenticated, enabled: scope.needsAiConversations });
  const isBootLoading = shell.familyQuery.isLoading || shell.membersQuery.isLoading || (scope.needsIngredients && ingredients.ingredientsQuery.isLoading) || (scope.needsInventory && (ingredients.inventoryQuery.isLoading || ingredients.inventoryStatesQuery.isLoading)) || (scope.needsShopping && ingredients.shoppingQuery.isLoading) || (scope.needsRecipes && eat.recipesQuery.isLoading) || (scope.needsRecipeInsights && (eat.recipeDiscoveryQuery.isLoading || eat.recipeStatsQuery.isLoading)) || (scope.needsFoodPlan && foodPlan.foodPlanQuery.isLoading && !foodPlan.foodPlanQuery.data) || (scope.needsFoodScenes && foodPlan.foodScenesQuery.isLoading) || (scope.needsFoods && eat.foodsQuery.isLoading) || (scope.needsFoodRecommendations && foodPlan.foodRecommendationsQuery.isLoading) || (scope.needsMealLogs && eat.mealLogsQuery.isLoading) || (scope.needsAiConversations && ai.aiConversationsQuery.isLoading);
  return {
    ...shell, ...ingredients, ...eat, ...foodPlan, ...family, ...ai, ...home, isBootLoading,
    members: shell.membersQuery.data ?? [], ingredients: ingredients.ingredientsQuery.data ?? [], inventoryItems: ingredients.inventoryQuery.data ?? [], inventoryStates: ingredients.inventoryStatesQuery.data ?? [], shoppingItems: ingredients.shoppingQuery.data ?? [], inventoryOperations: ingredients.inventoryOperationsQuery.data ?? [], recipes: eat.recipesQuery.data ?? [], recipeDiscovery: eat.recipeDiscoveryQuery.data ?? null, recipeStats: eat.recipeStatsQuery.data ?? null, foodPlanItems: foodPlan.foodPlanQuery.data ?? [], foodPlanDetail: foodPlan.foodPlanDetailQuery.data ?? null, foodScenes: foodPlan.foodScenesQuery.data ?? [], foods: eat.foodsQuery.data ?? [], foodRecommendations: foodPlan.foodRecommendationsQuery.data ?? null, mealLogs: eat.mealLogsQuery.data ?? [], mealInsights: eat.mealInsightsQuery.data ?? [], activeMealRecordOperations: home.activeMealRecordOperationsQuery.data ?? [], aiConversations: ai.aiConversationsQuery.data ?? [], family: shell.familyQuery.data,
  };
}
