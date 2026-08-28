import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterFoodPlanChanged, invalidateAfterFoodPlanCompleted, invalidateAfterFoodSceneChanged } from '../../api/cacheInvalidation';
export function useFoodPlanMutations() {
  const queryClient = useQueryClient();
  const createFoodPlanItemMutation = useMutation({ mutationFn: api.createFoodPlanItem, onSuccess: async () => invalidateAfterFoodPlanChanged(queryClient) });
  const updateFoodPlanItemMutation = useMutation({ mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateFoodPlanItem>[1] }) => api.updateFoodPlanItem(itemId, payload), onSuccess: async () => invalidateAfterFoodPlanChanged(queryClient) });
  const deleteFoodPlanItemMutation = useMutation({ mutationFn: api.deleteFoodPlanItem, onSuccess: async () => invalidateAfterFoodPlanChanged(queryClient) });
  const createFoodSceneMutation = useMutation({ mutationFn: api.createFoodScene, onSuccess: async () => invalidateAfterFoodSceneChanged(queryClient) });
  const updateFoodSceneMutation = useMutation({ mutationFn: ({ sceneId, payload }: { sceneId: string; payload: Parameters<typeof api.updateFoodScene>[1] }) => api.updateFoodScene(sceneId, payload), onSuccess: async () => invalidateAfterFoodSceneChanged(queryClient) });
  const deleteFoodSceneMutation = useMutation({ mutationFn: api.deleteFoodScene, onSuccess: async () => invalidateAfterFoodSceneChanged(queryClient) });
  const completeFoodPlanItemMutation = useMutation({ mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.completeFoodPlanItem>[1] }) => api.completeFoodPlanItem(itemId, payload), onSuccess: async () => invalidateAfterFoodPlanCompleted(queryClient) });
  return { createFoodPlanItemMutation, updateFoodPlanItemMutation, deleteFoodPlanItemMutation, createFoodSceneMutation, updateFoodSceneMutation, deleteFoodSceneMutation, completeFoodPlanItemMutation };
}
