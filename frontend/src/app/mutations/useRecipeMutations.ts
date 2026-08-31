import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterRecipeChanged, invalidateAfterRecipeCooked, invalidateAfterRecipeDeleted } from '../../api/cacheInvalidation';
export function useRecipeMutations() {
  const queryClient = useQueryClient();
  const createRecipeMutation = useMutation({ mutationFn: api.createRecipe, onSuccess: async () => invalidateAfterRecipeChanged(queryClient) });
  const updateRecipeMutation = useMutation({ mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.updateRecipe>[1] }) => api.updateRecipe(recipeId, payload), onSuccess: async () => invalidateAfterRecipeChanged(queryClient) });
  const deleteRecipeMutation = useMutation({ mutationFn: api.deleteRecipe, onSuccess: async () => invalidateAfterRecipeDeleted(queryClient) });
  const cookRecipeMutation = useMutation({ mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.cookRecipe>[1] }) => api.cookRecipe(recipeId, payload), onSuccess: async () => invalidateAfterRecipeCooked(queryClient) });
  const previewCookRecipeMutation = useMutation({ mutationFn: ({ recipeId, payload }: { recipeId: string; payload: Parameters<typeof api.previewCookRecipe>[1] }) => api.previewCookRecipe(recipeId, payload) });
  return { createRecipeMutation, updateRecipeMutation, deleteRecipeMutation, cookRecipeMutation, previewCookRecipeMutation };
}
