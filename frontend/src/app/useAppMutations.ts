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
import { useInventoryMutations } from './mutations/useInventoryMutations';
import { useShoppingMutations } from './mutations/useShoppingMutations';
import { useRecipeMutations } from './mutations/useRecipeMutations';
import { useFoodPlanMutations } from './mutations/useFoodPlanMutations';
import { useFoodMutations } from './mutations/useFoodMutations';
import { useMealMutations } from './mutations/useMealMutations';

export function useAppMutationRegistry() {
  const queryClient = useQueryClient();


  return {
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
  const inventory = useInventoryMutations();
  return {
    ...ingredient,
    ...inventory,
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
