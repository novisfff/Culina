import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterShoppingChanged } from '../../api/cacheInvalidation';

export function useShoppingMutations() {
  const queryClient = useQueryClient();
  const createShoppingMutation = useMutation({ mutationFn: api.createShoppingItem, onSuccess: async () => invalidateAfterShoppingChanged(queryClient) });
  const updateShoppingMutation = useMutation({
    mutationFn: ({ itemId, payload }: { itemId: string; payload: Parameters<typeof api.updateShoppingItem>[1] }) => api.updateShoppingItem(itemId, payload),
    onSuccess: async () => invalidateAfterShoppingChanged(queryClient),
  });
  const deleteShoppingMutation = useMutation({
    mutationFn: ({ itemId, expectedRowVersion }: { itemId: string; expectedRowVersion: number }) => api.deleteShoppingItem(itemId, expectedRowVersion),
    onSuccess: async () => invalidateAfterShoppingChanged(queryClient),
  });
  return { createShoppingMutation, updateShoppingMutation, deleteShoppingMutation };
}
