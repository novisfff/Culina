import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import type { AiImageTargetEntityType, SearchEntityType } from './types';

function invalidateMany(queryClient: QueryClient, keys: QueryKey[]) {
  return Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

export async function invalidateAfterSearchIndexJobChanged(
  queryClient: QueryClient,
  target?: { entity_type?: SearchEntityType | null; entity_id?: string | null }
) {
  await invalidateMany(queryClient, [queryKeys.searchIndexJobs, queryKeys.searchRoot]);
  switch (target?.entity_type) {
    case 'food':
      await invalidateAfterFoodChanged(queryClient);
      break;
    case 'ingredient':
      await invalidateAfterIngredientChanged(queryClient);
      break;
    case 'recipe':
      await invalidateAfterRecipeChanged(queryClient);
      break;
    default:
      break;
  }
}

export async function invalidateAfterMemberChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.members,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterProfileChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [queryKeys.authMe, queryKeys.members, queryKeys.activityLogs]);
}

export async function invalidateAfterFamilyChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [queryKeys.family, queryKeys.authMe, queryKeys.activityLogs]);
}

export async function invalidateAfterIngredientChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [queryKeys.ingredients, queryKeys.activityLogs]);
}

export async function invalidateAfterInventoryChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.inventory,
    queryKeys.inventoryStates,
    queryKeys.inventoryOverviewRoot,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}


export async function invalidateAfterInventoryOperation(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.inventory,
    queryKeys.inventoryStates,
    queryKeys.inventoryOverviewRoot,
    queryKeys.inventoryOperations,
    queryKeys.ingredients,
    queryKeys.foods,
    queryKeys.shoppingList,
    queryKeys.foodPlanRoot,
    queryKeys.foodRecommendations,
    queryKeys.recipeDiscovery,
    queryKeys.searchRoot,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterShoppingChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [queryKeys.shoppingList, queryKeys.activityLogs]);
}

export async function invalidateAfterRecipeChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.recipes,
    queryKeys.recipeDiscovery,
    queryKeys.recipeStats,
    queryKeys.foods,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
  ]);
}

export async function invalidateAfterRecipeDeleted(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
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

export async function invalidateAfterRecipeCooked(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.inventory,
    queryKeys.inventoryStates,
    queryKeys.inventoryOverviewRoot,
    queryKeys.inventoryOperations,
    queryKeys.recipes,
    queryKeys.recipeDiscovery,
    queryKeys.recipeStats,
    queryKeys.foods,
    queryKeys.foodRecommendations,
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.foodPlanRoot,
    queryKeys.shoppingList,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterRecipeFavoriteChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [queryKeys.recipeFavorites, queryKeys.activityLogs]);
}

export async function invalidateAfterFoodPlanChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.foodPlanRoot,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterFoodSceneChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [queryKeys.foodScenes, queryKeys.activityLogs]);
}

export async function invalidateAfterFoodChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.foods,
    queryKeys.inventoryOverviewRoot,
    queryKeys.foodRecommendations,
    queryKeys.mealInsights,
    queryKeys.activityLogs,
  ]);
}

export async function invalidateAfterMealLogChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterMealRecorded(
  queryClient: QueryClient,
  options: { createdFood?: boolean } = {},
) {
  const keys: QueryKey[] = [
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.mealRecordOperations(true),
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ];
  if (options.createdFood) {
    keys.push(queryKeys.foods);
  }
  await invalidateMany(queryClient, keys);
}

export async function invalidateAfterMealCompositionChanged(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterMealRecordReverted(
  queryClient: QueryClient,
  options: { removedFood?: boolean } = {},
) {
  const keys: QueryKey[] = [
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.mealRecordOperations(true),
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ];
  if (options.removedFood) {
    keys.push(queryKeys.foods);
  }
  await invalidateMany(queryClient, keys);
}

export async function invalidateAfterFoodPlanCompleted(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.foodPlanRoot,
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterQuickMealAdded(queryClient: QueryClient) {
  await invalidateMany(queryClient, [
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.foodPlanRoot,
    queryKeys.foods,
    queryKeys.inventoryOverviewRoot,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterAiApprovalSettled(queryClient: QueryClient, conversationId: string) {
  await invalidateMany(queryClient, [
    queryKeys.aiMessages(conversationId),
    queryKeys.aiPendingApprovals(conversationId),
    queryKeys.aiConversations,
    queryKeys.aiQualityMetrics,
    queryKeys.inventory,
    queryKeys.inventoryStates,
    queryKeys.inventoryOverviewRoot,
    queryKeys.recipes,
    queryKeys.shoppingList,
    queryKeys.foodPlanRoot,
    queryKeys.mealLogs,
    queryKeys.mealCandidatesRoot,
    queryKeys.mealInsights,
    queryKeys.foods,
    queryKeys.foodRecommendations,
    queryKeys.activityLogs,
    queryKeys.activityHighlights,
  ]);
}

export async function invalidateAfterAiMessageSent(queryClient: QueryClient, conversationId: string) {
  await invalidateMany(queryClient, [
    queryKeys.aiConversations,
    queryKeys.aiQualityMetrics,
    queryKeys.aiMessages(conversationId),
    queryKeys.aiPendingApprovals(conversationId),
  ]);
}

export async function invalidateAfterAiImageJobChanged(
  queryClient: QueryClient,
  target?: { target_entity_type?: AiImageTargetEntityType | null; target_entity_id?: string | null }
) {
  await invalidateMany(queryClient, [queryKeys.aiImageJobs]);
  switch (target?.target_entity_type) {
    case 'food':
      await invalidateAfterFoodChanged(queryClient);
      break;
    case 'ingredient':
      await invalidateAfterIngredientChanged(queryClient);
      break;
    case 'recipe':
      await invalidateAfterRecipeChanged(queryClient);
      break;
    case 'food_scene':
      await invalidateAfterFoodSceneChanged(queryClient);
      break;
    case 'meal_log':
      await invalidateAfterMealLogChanged(queryClient);
      break;
    case 'family':
      await invalidateAfterFamilyChanged(queryClient);
      break;
    case 'user':
      await invalidateAfterProfileChanged(queryClient);
      break;
    default:
      break;
  }
}
