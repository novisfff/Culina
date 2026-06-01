import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';

function invalidateMany(queryClient: QueryClient, keys: QueryKey[]) {
  keys.forEach((queryKey) => {
    void queryClient.invalidateQueries({ queryKey });
  });
}

export function invalidateAfterMemberChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.members, queryKeys.activityLogs]);
}

export function invalidateAfterProfileChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.authMe, queryKeys.members, queryKeys.activityLogs]);
}

export function invalidateAfterFamilyChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.family, queryKeys.authMe, queryKeys.activityLogs]);
}

export function invalidateAfterIngredientChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.ingredients, queryKeys.activityLogs]);
}

export function invalidateAfterInventoryChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.inventory, queryKeys.foodRecommendations, queryKeys.activityLogs]);
}

export function invalidateAfterShoppingChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.shoppingList, queryKeys.activityLogs]);
}

export function invalidateAfterRecipeChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [
    queryKeys.recipes,
    queryKeys.recipeDiscovery,
    queryKeys.recipeStats,
    queryKeys.foods,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
  ]);
}

export function invalidateAfterRecipeDeleted(queryClient: QueryClient) {
  invalidateMany(queryClient, [
    queryKeys.recipes,
    queryKeys.recipeDiscovery,
    queryKeys.recipeStats,
    queryKeys.recipeFavorites,
    queryKeys.foodPlanRoot,
    queryKeys.foods,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
  ]);
}

export function invalidateAfterRecipeCooked(queryClient: QueryClient) {
  invalidateMany(queryClient, [
    queryKeys.inventory,
    queryKeys.recipeDiscovery,
    queryKeys.foodRecommendations,
    queryKeys.recipeStats,
    queryKeys.foods,
    queryKeys.mealLogs,
    queryKeys.foodPlanRoot,
    queryKeys.activityLogs,
  ]);
}

export function invalidateAfterRecipeFavoriteChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.recipeFavorites, queryKeys.activityLogs]);
}

export function invalidateAfterFoodPlanChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.foodPlanRoot, queryKeys.activityLogs]);
}

export function invalidateAfterFoodSceneChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.foodScenes, queryKeys.activityLogs]);
}

export function invalidateAfterFoodChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.foods, queryKeys.foodRecommendations, queryKeys.activityLogs]);
}

export function invalidateAfterMealLogChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.mealLogs, queryKeys.foodRecommendations, queryKeys.activityLogs]);
}

export function invalidateAfterQuickMealAdded(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.mealLogs, queryKeys.foodPlanRoot, queryKeys.foodRecommendations, queryKeys.activityLogs]);
}

export function invalidateAfterLegacyAiQuery(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.aiConversations, queryKeys.family, queryKeys.activityLogs]);
}

export function invalidateAfterAiApprovalSettled(queryClient: QueryClient, conversationId: string) {
  invalidateMany(queryClient, [
    queryKeys.aiMessages(conversationId),
    queryKeys.aiPendingApprovals(conversationId),
    queryKeys.aiConversations,
    queryKeys.recipes,
  ]);
}

export function invalidateAfterAiMessageSent(queryClient: QueryClient, conversationId: string) {
  invalidateMany(queryClient, [
    queryKeys.aiConversations,
    queryKeys.aiMessages(conversationId),
    queryKeys.aiPendingApprovals(conversationId),
  ]);
}
