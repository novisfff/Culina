import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  invalidateAfterFoodChanged,
  invalidateAfterFoodPlanChanged,
  invalidateAfterFoodPlanCompleted,
  invalidateAfterFoodSceneChanged,
  invalidateAfterIngredientChanged,
  invalidateAfterInventoryChanged,
  invalidateAfterInventoryOperation,
  invalidateAfterMealCompositionChanged,
  invalidateAfterMealLogChanged,
  invalidateAfterMealRecorded,
  invalidateAfterMealRecordReverted,
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
  const transitionIngredientTrackingModeMutation = useMutation({
    mutationFn: ({
      ingredientId,
      payload,
    }: {
      ingredientId: string;
      payload: Parameters<typeof api.transitionIngredientTrackingMode>[1];
    }) => api.transitionIngredientTrackingMode(ingredientId, payload),
    retry: false,
    // Intentionally no onSuccess invalidation: the editor dual-write path
    // (transition + profile update) invalidates only after the full save finishes,
    // so inventory/state refresh does not land under an open transition dialog.
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
    mutationFn: ({
      itemId,
      expectedRowVersion,
    }: {
      itemId: string;
      expectedRowVersion: number;
    }) => api.deleteShoppingItem(itemId, expectedRowVersion),
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
    mutationFn: ({ foodId, favorite, expectedRowVersion }: { foodId: string; favorite: boolean; expectedRowVersion: number }) =>
      api.updateFoodFavorite(foodId, favorite, expectedRowVersion),
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
  const recordMealMutation = useMutation({
    mutationFn: api.recordMeal,
    onSuccess: async (response) => {
      await invalidateAfterMealRecorded(queryClient, {
        createdFood: (response.created_foods?.length ?? 0) > 0,
      });
    },
  });
  const updateMealCompositionMutation = useMutation({
    mutationFn: ({
      mealLogId,
      payload,
    }: {
      mealLogId: string;
      payload: Parameters<typeof api.updateMealComposition>[1];
    }) => api.updateMealComposition(mealLogId, payload),
    onSuccess: async () => {
      await invalidateAfterMealCompositionChanged(queryClient);
    },
  });
  const revertMealRecordMutation = useMutation({
    mutationFn: api.revertMealRecordOperation,
    retry: false,
    onSuccess: async (response) => {
      await invalidateAfterMealRecordReverted(queryClient, {
        removedFood: (response.removed_food_ids?.length ?? 0) > 0,
      });
    },
  });
  const completeFoodPlanItemMutation = useMutation({
    mutationFn: ({
      itemId,
      payload,
    }: {
      itemId: string;
      payload: Parameters<typeof api.completeFoodPlanItem>[1];
    }) => api.completeFoodPlanItem(itemId, payload),
    onSuccess: async () => {
      await invalidateAfterFoodPlanCompleted(queryClient);
    },
  });

  return {
    createIngredientMutation,
    updateIngredientMutation,
    transitionIngredientTrackingModeMutation,
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
    recordMealMutation,
    updateMealCompositionMutation,
    revertMealRecordMutation,
    completeFoodPlanItemMutation,
  };
}
