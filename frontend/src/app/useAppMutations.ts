import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import {
  invalidateAfterFoodChanged,
  invalidateAfterFoodPlanChanged,
  invalidateAfterFoodPlanCompleted,
  invalidateAfterFoodSceneChanged,
  invalidateAfterInventoryChanged,
  invalidateAfterInventoryOperation,
  invalidateAfterMealCompositionChanged,
  invalidateAfterMealLogChanged,
  invalidateAfterMealRecorded,
  invalidateAfterMealRecordReverted,
  invalidateAfterRecipeChanged,
  invalidateAfterRecipeCooked,
  invalidateAfterRecipeDeleted,
} from '../api/cacheInvalidation';
import { useIngredientMutations } from './mutations/useIngredientMutations';
import { useInventoryMutationActions } from './mutations/useInventoryMutations';
import { useShoppingMutations } from './mutations/useShoppingMutations';
import { useRecipeMutations } from './mutations/useRecipeMutations';
import { useFoodPlanMutationActions } from './mutations/useFoodPlanMutations';
import { useFoodMutations } from './mutations/useFoodMutations';
import { useMealMutationActions } from './mutations/useMealMutations';

export function useAppMutationRegistry() {
  const queryClient = useQueryClient();

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
  const updateMealMutation = useMutation({
    mutationFn: ({ mealLogId, payload }: { mealLogId: string; payload: Parameters<typeof api.updateMealLog>[1] }) =>
      api.updateMealLog(mealLogId, payload),
    onSuccess: async () => {
      await invalidateAfterMealLogChanged(queryClient);
    },
  });
  const recordMealMutation = useMutation({
    mutationFn: api.recordMeal,
    onSuccess: (response) => {
      void invalidateAfterMealRecorded(queryClient, {
        createdFood: (response.created_foods?.length ?? 0) > 0,
      }).catch(() => undefined);
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
    createFoodPlanItemMutation,
    updateFoodPlanItemMutation,
    deleteFoodPlanItemMutation,
    createFoodSceneMutation,
    updateFoodSceneMutation,
    deleteFoodSceneMutation,
    updateMealMutation,
    recordMealMutation,
    updateMealCompositionMutation,
    revertMealRecordMutation,
    completeFoodPlanItemMutation,
  };
}

export type AppMutationRegistry = ReturnType<typeof useAppMutationRegistry>;

export function useAppMutations() {
  const registry = useAppMutationRegistry();
  const ingredient = useIngredientMutations();
  const shopping = useShoppingMutations();
  const recipe = useRecipeMutations();
  const food = useFoodMutations();
  return {
    ...ingredient,
    ...useInventoryMutationActions(registry),
    ...shopping,
    ...recipe,
    ...food,
    ...recipe,
    ...useFoodPlanMutationActions(registry),
    ...food,
    ...useMealMutationActions(registry),
  };
}
