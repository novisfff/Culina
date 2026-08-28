import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterIngredientChanged } from '../../api/cacheInvalidation';

export function useIngredientMutations() {
  const queryClient = useQueryClient();
  const createIngredientMutation = useMutation({ mutationFn: api.createIngredient, onSuccess: async () => invalidateAfterIngredientChanged(queryClient) });
  const updateIngredientMutation = useMutation({
    mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.updateIngredient>[1] }) => api.updateIngredient(ingredientId, payload),
    onSuccess: async () => invalidateAfterIngredientChanged(queryClient),
  });
  const transitionIngredientTrackingModeMutation = useMutation({
    mutationFn: ({ ingredientId, payload }: { ingredientId: string; payload: Parameters<typeof api.transitionIngredientTrackingMode>[1] }) => api.transitionIngredientTrackingMode(ingredientId, payload),
    retry: false,
    // Intentionally no onSuccess invalidation: the editor invalidates only after its dual-write settles.
  });
  return { createIngredientMutation, updateIngredientMutation, transitionIngredientTrackingModeMutation };
}
