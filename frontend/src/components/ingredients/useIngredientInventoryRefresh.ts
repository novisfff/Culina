import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { invalidateAfterInventoryChanged } from '../../api/cacheInvalidation';
import { invalidateAfterInventoryOperation } from '../../api/cacheInvalidation';
import type { Recipe } from '../../api/types';
import { buildIngredientPriorityActionGroups, buildIngredientSummaries } from './workspaceModel';
import { resolveExpiryInventoryActionGroup } from './useIngredientOverlayState';

export function useIngredientInventoryOperationInvalidation() {
  const queryClient = useQueryClient();
  return () => invalidateAfterInventoryOperation(queryClient);
}

export function useIngredientInventoryRefresh(args: {
  recipes: Recipe[];
  referenceDate: string;
}) {
  const queryClient = useQueryClient();
  return async (ingredientId: string) => {
    await invalidateAfterInventoryChanged(queryClient);
    await queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList });
    const [inventoryItems, inventoryStates, ingredients, shoppingItems] = await Promise.all([
      queryClient.fetchQuery({ queryKey: queryKeys.inventory, queryFn: () => api.getInventory() }),
      queryClient.fetchQuery({ queryKey: queryKeys.inventoryStates, queryFn: () => api.listInventoryStates() }),
      queryClient.fetchQuery({ queryKey: queryKeys.ingredients, queryFn: () => api.getIngredients() }),
      queryClient.fetchQuery({ queryKey: queryKeys.shoppingList, queryFn: () => api.getShoppingList() }),
    ]);
    const groups = buildIngredientPriorityActionGroups({
      inventoryItems,
      ingredients,
      shoppingItems,
      inventoryStates,
      referenceDate: args.referenceDate,
    });
    const summaries = buildIngredientSummaries({
      ingredients,
      inventoryItems,
      inventoryStates,
      recipes: args.recipes,
      referenceDate: args.referenceDate,
      shoppingItems,
    });
    return resolveExpiryInventoryActionGroup({
      ingredientId,
      inventoryActionGroups: groups,
      summaries,
      referenceDate: args.referenceDate,
    });
  };
}
