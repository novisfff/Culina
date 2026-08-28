import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterMealCompositionChanged, invalidateAfterMealLogChanged, invalidateAfterMealRecorded, invalidateAfterMealRecordReverted } from '../../api/cacheInvalidation';
export function useMealMutations() {
  const queryClient = useQueryClient();
  const updateMealMutation = useMutation({ mutationFn: ({ mealLogId, payload }: { mealLogId: string; payload: Parameters<typeof api.updateMealLog>[1] }) => api.updateMealLog(mealLogId, payload), onSuccess: async () => invalidateAfterMealLogChanged(queryClient) });
  const recordMealMutation = useMutation({ mutationFn: api.recordMeal, onSuccess: (response) => { void invalidateAfterMealRecorded(queryClient, { createdFood: (response.created_foods?.length ?? 0) > 0 }).catch(() => undefined); } });
  const updateMealCompositionMutation = useMutation({ mutationFn: ({ mealLogId, payload }: { mealLogId: string; payload: Parameters<typeof api.updateMealComposition>[1] }) => api.updateMealComposition(mealLogId, payload), onSuccess: async () => invalidateAfterMealCompositionChanged(queryClient) });
  const revertMealRecordMutation = useMutation({ mutationFn: api.revertMealRecordOperation, retry: false, onSuccess: async (response) => invalidateAfterMealRecordReverted(queryClient, { removedFood: (response.removed_food_ids?.length ?? 0) > 0 }) });
  return { updateMealMutation, recordMealMutation, updateMealCompositionMutation, revertMealRecordMutation };
}
