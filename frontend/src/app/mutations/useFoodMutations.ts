import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterFoodChanged } from '../../api/cacheInvalidation';
export function useFoodMutations() {
  const queryClient = useQueryClient();
  const onSuccess = async () => invalidateAfterFoodChanged(queryClient);
  const createFoodMutation = useMutation({ mutationFn: api.createFood, onSuccess });
  const updateFoodMutation = useMutation({ mutationFn: ({ foodId, payload }: { foodId: string; payload: Parameters<typeof api.updateFood>[1] }) => api.updateFood(foodId, payload), onSuccess });
  const toggleFavoriteMutation = useMutation({ mutationFn: ({ foodId, favorite, expectedRowVersion }: { foodId: string; favorite: boolean; expectedRowVersion: number }) => api.updateFoodFavorite(foodId, favorite, expectedRowVersion), onSuccess });
  return { createFoodMutation, updateFoodMutation, toggleFavoriteMutation };
}
