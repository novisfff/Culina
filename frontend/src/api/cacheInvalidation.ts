import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import type { AiImageTargetEntityType, SearchEntityType } from './types';

function invalidateMany(queryClient: QueryClient, keys: QueryKey[]) {
  keys.forEach((queryKey) => {
    void queryClient.invalidateQueries({ queryKey });
  });
}

export function invalidateAfterSearchIndexJobChanged(
  queryClient: QueryClient,
  target?: { entity_type?: SearchEntityType | null; entity_id?: string | null }
) {
  invalidateMany(queryClient, [queryKeys.searchIndexJobs, queryKeys.searchRoot]);
  switch (target?.entity_type) {
    case 'food':
      invalidateAfterFoodChanged(queryClient);
      break;
    case 'ingredient':
      invalidateAfterIngredientChanged(queryClient);
      break;
    case 'recipe':
      invalidateAfterRecipeChanged(queryClient);
      break;
    default:
      break;
  }
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
  invalidateMany(queryClient, [queryKeys.inventory, queryKeys.inventoryOverviewRoot, queryKeys.foodRecommendations, queryKeys.activityLogs]);
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
  invalidateMany(queryClient, [queryKeys.foods, queryKeys.inventoryOverviewRoot, queryKeys.foodRecommendations, queryKeys.activityLogs]);
}

export function invalidateAfterMealLogChanged(queryClient: QueryClient) {
  invalidateMany(queryClient, [queryKeys.mealLogs, queryKeys.foodRecommendations, queryKeys.activityLogs]);
}

export function invalidateAfterQuickMealAdded(queryClient: QueryClient) {
  invalidateMany(queryClient, [
    queryKeys.mealLogs,
    queryKeys.foodPlanRoot,
    queryKeys.foods,
    queryKeys.inventoryOverviewRoot,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
  ]);
}

export function invalidateAfterAiApprovalSettled(queryClient: QueryClient, conversationId: string) {
  invalidateMany(queryClient, [
    queryKeys.aiMessages(conversationId),
    queryKeys.aiPendingApprovals(conversationId),
    queryKeys.aiConversations,
    queryKeys.aiQualityMetrics,
    queryKeys.inventory,
    queryKeys.recipes,
    queryKeys.shoppingList,
    queryKeys.foodPlanRoot,
    queryKeys.mealLogs,
    queryKeys.foods,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
  ]);
}

export function invalidateAfterAiMessageSent(queryClient: QueryClient, conversationId: string) {
  invalidateMany(queryClient, [
    queryKeys.aiConversations,
    queryKeys.aiQualityMetrics,
    queryKeys.aiMessages(conversationId),
    queryKeys.aiPendingApprovals(conversationId),
  ]);
}

export function invalidateAfterAiImageJobChanged(
  queryClient: QueryClient,
  target?: { target_entity_type?: AiImageTargetEntityType | null; target_entity_id?: string | null }
) {
  invalidateMany(queryClient, [queryKeys.aiImageJobs]);
  switch (target?.target_entity_type) {
    case 'food':
      invalidateAfterFoodChanged(queryClient);
      break;
    case 'ingredient':
      invalidateAfterIngredientChanged(queryClient);
      break;
    case 'recipe':
      invalidateAfterRecipeChanged(queryClient);
      break;
    case 'food_scene':
      invalidateAfterFoodSceneChanged(queryClient);
      break;
    case 'meal_log':
      invalidateAfterMealLogChanged(queryClient);
      break;
    case 'family':
      invalidateAfterFamilyChanged(queryClient);
      break;
    case 'user':
      invalidateAfterProfileChanged(queryClient);
      break;
    default:
      break;
  }
}
