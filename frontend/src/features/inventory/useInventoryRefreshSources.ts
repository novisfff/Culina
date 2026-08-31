import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { invalidateAfterInventoryChanged, invalidateAfterInventoryOperation } from '../../api/cacheInvalidation';
import { queryKeys } from '../../api/queryKeys';

export function useInventoryRefreshSources() {
  const queryClient = useQueryClient();

  const refreshSources = useCallback(async () => {
    const latest = await Promise.all([
      queryClient.fetchQuery({ queryKey: queryKeys.shoppingList, queryFn: () => api.getShoppingList() }),
      queryClient.fetchQuery({ queryKey: queryKeys.ingredients, queryFn: () => api.getIngredients() }),
      queryClient.fetchQuery({ queryKey: queryKeys.foods, queryFn: () => api.getFoods() }),
      queryClient.fetchQuery({ queryKey: queryKeys.inventoryStates, queryFn: () => api.listInventoryStates() }),
      queryClient.fetchQuery({ queryKey: queryKeys.inventory, queryFn: () => api.getInventory() }),
    ]);
    return {
      shoppingItems: latest[0],
      ingredients: latest[1],
      foods: latest[2],
      inventoryStates: latest[3],
    };
  }, [queryClient]);

  const fetchInventory = useCallback(
    () => queryClient.fetchQuery({ queryKey: queryKeys.inventory, queryFn: () => api.getInventory() }),
    [queryClient],
  );
  const fetchStates = useCallback(
    () => queryClient.fetchQuery({ queryKey: queryKeys.inventoryStates, queryFn: () => api.listInventoryStates() }),
    [queryClient],
  );
  const fetchIngredients = useCallback(
    () => queryClient.fetchQuery({ queryKey: queryKeys.ingredients, queryFn: () => api.getIngredients() }),
    [queryClient],
  );
  const fetchShopping = useCallback(
    () => queryClient.fetchQuery({ queryKey: queryKeys.shoppingList, queryFn: () => api.getShoppingList() }),
    [queryClient],
  );
  const invalidateShopping = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList }),
    [queryClient],
  );
  const invalidateChanged = useCallback(
    () => invalidateAfterInventoryChanged(queryClient),
    [queryClient],
  );
  const invalidateOperation = useCallback(
    () => invalidateAfterInventoryOperation(queryClient),
    [queryClient],
  );

  return {
    refreshSources,
    fetchInventory,
    fetchStates,
    fetchIngredients,
    fetchShopping,
    invalidateShopping,
    invalidateChanged,
    invalidateOperation,
  };
}
