import type { Food, Ingredient, IngredientInventoryState, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import { buildIngredientSummaries, buildStorageGroups } from './workspaceModel';

export function buildIngredientWorkspaceViewModel(args: { ingredients: Ingredient[]; inventoryItems: InventoryItem[]; inventoryStates: IngredientInventoryState[]; shoppingItems: ShoppingListItem[]; recipes: Recipe[]; foods: Food[]; referenceDate: string; selectedId?: string | null }) {
  const selected = args.selectedId ? args.ingredients.find((item) => item.id === args.selectedId) ?? null : null;
  const summaries = buildIngredientSummaries({ ingredients: args.ingredients, inventoryItems: args.inventoryItems, inventoryStates: args.inventoryStates, recipes: args.recipes, referenceDate: args.referenceDate, shoppingItems: args.shoppingItems });
  return { selected, summaries, storageGroups: buildStorageGroups(summaries), shoppingItems: args.shoppingItems, foods: args.foods };
}
