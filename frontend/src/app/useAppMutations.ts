import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  invalidateAfterFoodChanged,
  invalidateAfterFoodPlanChanged,
  invalidateAfterFoodSceneChanged,
  invalidateAfterIngredientChanged,
  invalidateAfterInventoryChanged,
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
    onSuccess: () => {
      invalidateAfterIngredientChanged(queryClient);
    },
  });
  const updateIngredientMutation = useMutation({
    mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.updateIngredient>[1] }) =>
      api.updateIngredient(ingredientId, payload),
    onSuccess: () => {
      invalidateAfterIngredientChanged(queryClient);
    },
  });
  const createInventoryMutation = useMutation({
    mutationFn: api.createInventory,
    onSuccess: () => {
      invalidateAfterInventoryChanged(queryClient);
    },
  });
  const consumeInventoryMutation = useMutation({
    mutationFn: api.consumeInventory,
    onSuccess: () => {
      invalidateAfterInventoryChanged(queryClient);
    },
  });
  const disposeExpiredInventoryMutation = useMutation({
    mutationFn: api.disposeExpiredInventory,
    onSuccess: () => {
      invalidateAfterInventoryChanged(queryClient);
    },
  });
  const createShoppingMutation = useMutation({
    mutationFn: api.createShoppingItem,
    onSuccess: () => {
      invalidateAfterShoppingChanged(queryClient);
    },
  });
  const updateShoppingMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateShoppingItem>[1] }) =>
      api.updateShoppingItem(itemId, payload),
    onSuccess: () => {
      invalidateAfterShoppingChanged(queryClient);
    },
  });
  const deleteShoppingMutation = useMutation({
    mutationFn: api.deleteShoppingItem,
    onSuccess: () => {
      invalidateAfterShoppingChanged(queryClient);
    },
  });
  const createRecipeMutation = useMutation({
    mutationFn: api.createRecipe,
    onSuccess: () => {
      invalidateAfterRecipeChanged(queryClient);
    },
  });
  const updateRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.updateRecipe>[1] }) =>
      api.updateRecipe(recipeId, payload),
    onSuccess: () => {
      invalidateAfterRecipeChanged(queryClient);
    },
  });
  const deleteRecipeMutation = useMutation({
    mutationFn: api.deleteRecipe,
    onSuccess: () => {
      invalidateAfterRecipeDeleted(queryClient);
    },
  });
  const cookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.cookRecipe>[1] }) =>
      api.cookRecipe(recipeId, payload),
    onSuccess: () => {
      invalidateAfterRecipeCooked(queryClient);
    },
  });
  const previewCookRecipeMutation = useMutation({
    mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.previewCookRecipe>[1] }) =>
      api.previewCookRecipe(recipeId, payload),
  });
  const addRecipeFavoriteMutation = useMutation({
    mutationFn: api.addRecipeFavorite,
    onSuccess: () => {
      invalidateAfterRecipeFavoriteChanged(queryClient);
    },
  });
  const removeRecipeFavoriteMutation = useMutation({
    mutationFn: api.removeRecipeFavorite,
    onSuccess: () => {
      invalidateAfterRecipeFavoriteChanged(queryClient);
    },
  });
  const createFoodPlanItemMutation = useMutation({
    mutationFn: api.createFoodPlanItem,
    onSuccess: () => {
      invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const updateFoodPlanItemMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateFoodPlanItem>[1] }) =>
      api.updateFoodPlanItem(itemId, payload),
    onSuccess: () => {
      invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const deleteFoodPlanItemMutation = useMutation({
    mutationFn: api.deleteFoodPlanItem,
    onSuccess: () => {
      invalidateAfterFoodPlanChanged(queryClient);
    },
  });
  const createFoodSceneMutation = useMutation({
    mutationFn: api.createFoodScene,
    onSuccess: () => {
      invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const updateFoodSceneMutation = useMutation({
    mutationFn: ({ sceneId, payload }: { sceneId: string; payload: Parameters<typeof api.updateFoodScene>[1] }) =>
      api.updateFoodScene(sceneId, payload),
    onSuccess: () => {
      invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const deleteFoodSceneMutation = useMutation({
    mutationFn: api.deleteFoodScene,
    onSuccess: () => {
      invalidateAfterFoodSceneChanged(queryClient);
    },
  });
  const createFoodMutation = useMutation({
    mutationFn: api.createFood,
    onSuccess: () => {
      invalidateAfterFoodChanged(queryClient);
    },
  });
  const updateFoodMutation = useMutation({
    mutationFn: ({ foodId, payload }: { foodId: string; payload: Parameters<typeof api.updateFood>[1] }) =>
      api.updateFood(foodId, payload),
    onSuccess: () => {
      invalidateAfterFoodChanged(queryClient);
    },
  });
  const toggleFavoriteMutation = useMutation({
    mutationFn: ({ foodId, favorite }: { foodId: string; favorite: boolean }) =>
      api.updateFoodFavorite(foodId, favorite),
    onSuccess: () => {
      invalidateAfterFoodChanged(queryClient);
    },
  });
  const createMealMutation = useMutation({
    mutationFn: api.createMealLog,
    onSuccess: () => {
      invalidateAfterMealLogChanged(queryClient);
    },
  });
  const updateMealMutation = useMutation({
    mutationFn: ({ mealLogId, payload }: { mealLogId: string; payload: Parameters<typeof api.updateMealLog>[1] }) =>
      api.updateMealLog(mealLogId, payload),
    onSuccess: () => {
      invalidateAfterMealLogChanged(queryClient);
    },
  });
  const quickAddMealMutation = useMutation({
    mutationFn: api.quickAddMealLog,
    onSuccess: () => {
      invalidateAfterQuickMealAdded(queryClient);
    },
  });

  return {
    createIngredientMutation,
    updateIngredientMutation,
    createInventoryMutation,
    consumeInventoryMutation,
    disposeExpiredInventoryMutation,
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
    createMealMutation,
    updateMealMutation,
    quickAddMealMutation,
  };
}
