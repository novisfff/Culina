import type { Food, Ingredient, IngredientInventoryState, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import {
  buildIngredientCategoryFilters,
  buildIngredientSummaries,
  buildStorageGroups,
  filterIngredientSummaries,
  type IngredientSummaryViewModel,
} from './workspaceModel';
import type { CatalogStatusFilter } from './useIngredientWorkspaceState';

export function buildIngredientWorkspaceViewModel(args: { ingredients: Ingredient[]; inventoryItems: InventoryItem[]; inventoryStates: IngredientInventoryState[]; shoppingItems: ShoppingListItem[]; recipes: Recipe[]; foods: Food[]; referenceDate: string; selectedId?: string | null }) {
  const selected = args.selectedId ? args.ingredients.find((item) => item.id === args.selectedId) ?? null : null;
  const summaries = buildIngredientSummaries({ ingredients: args.ingredients, inventoryItems: args.inventoryItems, inventoryStates: args.inventoryStates, recipes: args.recipes, referenceDate: args.referenceDate, shoppingItems: args.shoppingItems });
  return { selected, summaries, storageGroups: buildStorageGroups(summaries), shoppingItems: args.shoppingItems, foods: args.foods };
}

/** Pure catalog projection shared by desktop and mobile views. */
export function buildIngredientCatalogViewModel(args: {
  summaries: IngredientSummaryViewModel[];
  ingredients: Ingredient[];
  search: string;
  categoryFilter: string;
  statusFilter: CatalogStatusFilter;
  filterByStatus: (summaries: IngredientSummaryViewModel[], filter: CatalogStatusFilter) => IngredientSummaryViewModel[];
  searchMatchedIngredientIds?: readonly string[];
}) {
  const baseSummaries = filterIngredientSummaries(
    args.summaries,
    args.search,
    args.categoryFilter,
    args.searchMatchedIngredientIds,
  );
  const filteredSummaries = args.filterByStatus(baseSummaries, args.statusFilter);
  const hasActiveFilter = Boolean(args.search.trim()) || args.categoryFilter !== 'all' || args.statusFilter !== 'all';
  const statusCounts = {
    all: args.filterByStatus(baseSummaries, 'all').length,
    actionNeeded: args.filterByStatus(baseSummaries, 'actionNeeded').length,
    expired: args.filterByStatus(baseSummaries, 'expired').length,
    expiring: args.filterByStatus(baseSummaries, 'expiring').length,
    lowStock: args.filterByStatus(baseSummaries, 'lowStock').length,
    stable: args.filterByStatus(baseSummaries, 'stable').length,
  } as const;
  return {
    catalogCategories: buildIngredientCategoryFilters(args.ingredients),
    catalogBaseSummaries: baseSummaries,
    filteredSummaries,
    countLabel: hasActiveFilter ? `当前筛选 ${filteredSummaries.length} 项` : `共 ${args.summaries.length} 项`,
    statusCounts,
  };
}
