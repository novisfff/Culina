import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  invalidateAfterFoodChanged,
  invalidateAfterFoodPlanChanged,
  invalidateAfterFoodSceneChanged,
  invalidateAfterIngredientChanged,
  invalidateAfterInventoryChanged,
  invalidateAfterInventoryOperation,
  invalidateAfterMealLogChanged,
  invalidateAfterQuickMealAdded,
  invalidateAfterRecipeChanged,
  invalidateAfterRecipeCooked,
  invalidateAfterRecipeDeleted,
  invalidateAfterRecipeFavoriteChanged,
  invalidateAfterShoppingChanged,
} from '../api/cacheInvalidation';

export function useAppMutations() {
  const queryClient = useQueryClient();

  const createIngredientMutation = useMutation({
    mutationFn: api.createIngredient,
    onSuccess: async () => {
      await invalidateAfterIngredientChanged(queryClient);
    },
  });
  const updateIngredientMutation = useMutation({
    mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.updateIngredient>[1] }) =>
      api.updateIngredient(ingredientId, payload),
    onSuccess: async () => {
      await invalidateAfterIngredientChanged(queryClient);
    },
  });
  const createInventoryMutation = useMutation({
    mutationFn: api.createInventory,
    onSuccess: async () => {
      await invalidateAfterInventoryChanged(queryClient);
    },
  });
  const consumeInventoryMutation = useMutation({
    mutationFn: api.consumeInventory,
    onSuccess: async () => {
      await invalidateAfterInventoryChanged(queryClient);
    },
  });
  const disposeExpiredInventoryMutation = useMutation({
    mutationFn: api.disposeExpiredInventory,
    onSuccess: async () => {
      await invalidateAfterInventoryChanged(queryClient);
    },
  });
  const snoozeInventoryExpiryAlertsMutation = useMutation({
    mutationFn: api.snoozeInventoryExpiryAlerts,
    onSuccess: async () => {
      await invalidateAfterInventoryChanged(queryClient);
    },
  });
  const correctInventoryExpiryDateMutation = useMutation({
    mutationFn: ({
      inventoryItemId,
      payload,
    }: {
      inventoryItemId: string;
      payload: Parameters<typeof api.correctInventoryExpiryDate>[1];
    }) => api.correctInventoryExpiryDate(inventoryItemId, payload),
    onSuccess: async () => {
      await invalidateAfterInventoryChanged(queryClient);
    },
  });
  const upsertInventoryStateMutation = useMutation({
    mutationFn: ({
      ingredientId,
      payload,
    }: {
      ingredientId: string;
      payload: Parameters<typeof api.upsertInventoryState>[1];
    }) => api.upsertInventoryState(ingredientId, payload),
    retry: false,
    onSuccess: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
  });
  const snoozeStateExpiryAlertMutation = useMutation({
    mutationFn: ({
      ingredientId,
      payload,
    }: {
      ingredientId: string;
      payload: Parameters<typeof api.snoozeStateExpiryAlert>[1];
    }) => api.snoozeStateExpiryAlert(ingredientId, payload),
    retry: false,
    onSuccess: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
  });
  const correctStateExpiryDateMutation = useMutation({
    mutationFn: ({
      ingredientId,
      payload,
    }: {
      ingredientId: string;
      payload: Parameters<typeof api.correctStateExpiryDate>[1];
    }) => api.correctStateExpiryDate(ingredientId, payload),
    retry: false,
    onSuccess: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
  });
  const setInventoryStateAbsentMutation = useMutation({
    mutationFn: ({
      ingredientId,
      payload,
    }: {
      ingredientId: string;
      payload: Parameters<typeof api.setInventoryStateAbsent>[1];
    }) => api.setInventoryStateAbsent(ingredientId, payload),
    retry: false,
    onSuccess: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
  });
  const submitShoppingIntakeMutation = useMutation({
    mutationFn: api.submitShoppingIntake,
    retry: false,
    onSuccess: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
  });
  const submitInventoryReconciliationMutation = useMutation({
    mutationFn: api.submitInventoryReconciliation,
    retry: false,
    onSuccess: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
  });
  const revertInventoryOperationMutation = useMutation({
    mutationFn: api.revertInventoryOperation,
    retry: false,
    onSuccess: async () => {
      await invalidateAfterInventoryOperation(queryClient);
    },
  });
  const createShoppingMutation = useMutation({
    mutationFn: api.createShoppingItem,
    onSuccess: async () => {
      await invalidateAfterShoppingChanged(queryClient);
    },
  });
  const updateShoppingMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateShoppingItem>[1] }) =>
      api.updateShoppingItem(itemId, payload),
    onSuccess: async () => {
      await invalidateAfterShoppingChanged(queryClient);
    },
  });
  const deleteShoppingMutation = useMutation({
    mutationFn: api.deleteShoppingItem,
    onSuccess: async () => {
      await invalidateAfterShoppingChanged(queryClient);
    },
  });
  const createRecipeMutation = useMutation({
    mutationFn: api.createRecipe,
    onSuccess: async () => {
      await invalidateAfterRecipeChanged(queryClient);
    },
  });
  const updateRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.updateRecipe>[1] }) =>
      api.updateRecipe(recipeId, payload),
    onSuccess: async () => {
      await invalidateAfterRecipeChanged(queryClient);
    },
  });
  const deleteRecipeMutation = useMutation({
    mutationFn: api.deleteRecipe,
    onSuccess: async () => {
      await invalidateAfterRecipeDeleted(queryClient);
    },
  });
  const cookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.cookRecipe>[1] }) =>
      api.cookRecipe(recipeId, payload),
    onSuccess: async () => {
      await invalidateAfterRecipeCooked(queryClient);
    },
  });
  const previewCookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.previewCookRecipe>[1] }) =>
      api.previewCookRecipe(recipeId, payload),
  });
  const addRecipeFavoriteMutation = useMutation({
    mutationFn: api.addRecipeFavorite,
    onSuccess: async () => {
      await invalidateAfterRecipeFavoriteChanged(queryClient);
    },
  });
  const removeRecipeFavoriteMutation = useMutation({
    mutationFn: api.removeRecipeFavorite,
    onSuccess: async () => {
      await invalidateAfterRecipeFavoriteChanged(queryClient);
    },
  });
  const createFoodPlanItemMutation = useMutation({
    mutationFn: api.createFoodPlanItem,
    onSuccess: async () => {
      await invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const updateFoodPlanItemMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateFoodPlanItem>[1] }) =>
      api.updateFoodPlanItem(itemId, payload),
    onSuccess: async () => {
      await invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const deleteFoodPlanItemMutation = useMutation({
    mutationFn: api.deleteFoodPlanItem,
    onSuccess: async () => {
      await invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const createFoodSceneMutation = useMutation({
    mutationFn: api.createFoodScene,
    onSuccess: async () => {
      await invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const updateFoodSceneMutation = useMutation({
    mutationFn: ({ sceneId, payload }: { sceneId: string; payload: Parameters<typeof api.updateFoodScene>[1] }) =>
      api.updateFoodScene(sceneId, payload),
    onSuccess: async () => {
      await invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const deleteFoodSceneMutation = useMutation({
    mutationFn: api.deleteFoodScene,
    onSuccess: async () => {
      await invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const createFoodMutation = useMutation({
    mutationFn: api.createFood,
    onSuccess: async () => {
      await invalidateAfterFoodChanged(queryClient);
    },
  });
  const updateFoodMutation = useMutation({
    mutationFn: ({ foodId, payload }: { foodId: string; payload: Parameters<typeof api.updateFood>[1] }) =>
      api.updateFood(foodId, payload),
    onSuccess: async () => {
      await invalidateAfterFoodChanged(queryClient);
    },
  });
  const toggleFavoriteMutation = useMutation({
    mutationFn: ({ foodId, favorite }: { foodId: string; favorite: boolean }) =>
      api.updateFoodFavorite(foodId, favorite),
    onSuccess: async () => {
      await invalidateAfterFoodChanged(queryClient);
    },
  });
  const updateMealMutation = useMutation({
    mutationFn: ({ mealLogId, payload }: { mealLogId: string; payload: Parameters<typeof api.updateMealLog>[1] }) =>
      api.updateMealLog(mealLogId, payload),
    onSuccess: async () => {
      await invalidateAfterMealLogChanged(queryClient);
    },
  });
  const quickAddMealMutation = useMutation({
    mutationFn: api.quickAddMealLog,
    onSuccess: async () => {
      await invalidateAfterQuickMealAdded(queryClient);
    },
  });

  return {
    createIngredientMutation,
    updateIngredientMutation,
    createInventoryMutation,
    consumeInventoryMutation,
    disposeExpiredInventoryMutation,
    snoozeInventoryExpiryAlertsMutation,
    correctInventoryExpiryDateMutation,
    upsertInventoryStateMutation,
    snoozeStateExpiryAlertMutation,
    correctStateExpiryDateMutation,
    setInventoryStateAbsentMutation,
    submitShoppingIntakeMutation,
    submitInventoryReconciliationMutation,
    revertInventoryOperationMutation,
    createShoppingMutation,
    updateShoppingMutation,
    deleteShoppingMutation,
    createRecipeMutation,
    updateRecipeMutation,
    deleteRecipeMutation,
    cookRecipeMutation,
    previewCookRecipeMutation,
    addRecipeFavoriteMutation,
    removeRecipeFavoriteMutation,
    createFoodPlanItemMutation,
    updateFoodPlanItemMutation,
    deleteFoodPlanItemMutation,
    createFoodSceneMutation,
    updateFoodSceneMutation,
    deleteFoodSceneMutation,
    createFoodMutation,
    updateFoodMutation,
    toggleFavoriteMutation,
    updateMealMutation,
    quickAddMealMutation,
  };
}
