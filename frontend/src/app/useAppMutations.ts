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
import { useFoodPlanMutations } from './mutations/useFoodPlanMutations';
import { useFoodMutations } from './mutations/useFoodMutations';
import { useMealMutations } from './mutations/useMealMutations';

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
  };
}

export type AppMutationRegistry = ReturnType<typeof useAppMutationRegistry>;

export function useAppMutations() {
  const registry = useAppMutationRegistry();
  const ingredient = useIngredientMutations();
  const shopping = useShoppingMutations();
  const recipe = useRecipeMutations();
  const food = useFoodMutations();
  const foodPlan = useFoodPlanMutations();
  const meal = useMealMutations();
  return {
    ...ingredient,
    ...useInventoryMutationActions(registry),
    ...shopping,
    ...recipe,
    ...food,
    ...foodPlan,
    ...meal,
    ...recipe,
    ...foodPlan,
    ...food,
    ...meal,
  };
}
