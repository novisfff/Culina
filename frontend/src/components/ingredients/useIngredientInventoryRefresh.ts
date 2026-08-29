import type { QueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { invalidateAfterInventoryChanged } from '../../api/cacheInvalidation';
import type { Recipe } from '../../api/types';
import { buildIngredientPriorityActionGroups, buildIngredientSummaries } from './workspaceModel';
import { resolveExpiryInventoryActionGroup } from './useIngredientOverlayState';

export function useIngredientInventoryRefresh(args: {
  queryClient: QueryClient;
  recipes: Recipe[];
  referenceDate: string;
}) {
  return async (ingredientId: string) => {
    await invalidateAfterInventoryChanged(args.queryClient);
    await args.queryClient.invalidateQueries({ queryKey: queryKeys.shoppingList });
    const [inventoryItems, inventoryStates, ingredients, shoppingItems] = await Promise.all([
      args.queryClient.fetchQuery({ queryKey: queryKeys.inventory, queryFn: () => api.getInventory() }),
      args.queryClient.fetchQuery({ queryKey: queryKeys.inventoryStates, queryFn: () => api.listInventoryStates() }),
      args.queryClient.fetchQuery({ queryKey: queryKeys.ingredients, queryFn: () => api.getIngredients() }),
      args.queryClient.fetchQuery({ queryKey: queryKeys.shoppingList, queryFn: () => api.getShoppingList() }),
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
