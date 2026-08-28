import type { Ingredient, IngredientInventoryState, InventoryItem } from '../../api/types/inventory';
import type { ShoppingListItem } from '../../api/types/inventory';
import { buildInventoryActionGroups, selectHomeEligibleInventoryActionGroups, type InventoryActionGroup } from '../inventory/inventoryActionModel';

type Args = {
  invalidateChanged: () => Promise<unknown>;
  invalidateShopping: () => Promise<unknown>;
  fetchInventory: () => Promise<InventoryItem[]>;
  fetchStates: () => Promise<IngredientInventoryState[]>;
  fetchIngredients: () => Promise<Ingredient[]>;
  fetchShopping: () => Promise<ShoppingListItem[]>;
  referenceDate: string;
};

/** Rebuilds Home's actionable inventory view from fresh canonical query data. */
export async function refreshHomeInventoryActions(args: Args): Promise<InventoryActionGroup[]> {
  await args.invalidateChanged();
  await args.invalidateShopping();
  const [inventoryItems, inventoryStates, ingredients, shoppingItems] = await Promise.all([
    args.fetchInventory(),
    args.fetchStates(),
    args.fetchIngredients(),
    args.fetchShopping(),
  ]);
  return selectHomeEligibleInventoryActionGroups(
    buildInventoryActionGroups({
      inventoryItems,
      inventoryStates,
      ingredients,
      shoppingItems,
      referenceDate: args.referenceDate,
    }),
  );
}
