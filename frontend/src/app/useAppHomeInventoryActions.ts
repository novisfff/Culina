import { useCallback } from 'react';
import { refreshHomeInventoryActions } from '../features/home/useHomeInventoryRefresh';

type Args = {
  sources: {
    invalidateChanged: () => Promise<unknown>;
    invalidateShopping: () => Promise<unknown>;
    fetchInventory: () => Promise<import('../api/types').InventoryItem[]>;
    fetchStates: () => Promise<import('../api/types').IngredientInventoryState[]>;
    fetchIngredients: () => Promise<import('../api/types').Ingredient[]>;
    fetchShopping: () => Promise<import('../api/types').ShoppingListItem[]>;
  };
  referenceDate: string;
};

export function createHomeInventoryActionRefresh(args: Args) {
  return () => refreshHomeInventoryActions({ ...args.sources, referenceDate: args.referenceDate });
}

/** App composition boundary for Home's canonical inventory refresh action. */
export function useAppHomeInventoryActions(args: Args) {
  return useCallback(createHomeInventoryActionRefresh(args), [args.sources, args.referenceDate]);
}
