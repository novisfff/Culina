import type { Food, Ingredient, IngredientInventoryState, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import {
  buildIngredientCategoryFilters,
  buildIngredientSummaries,
  buildInventoryStorageOverview,
  buildStorageGroups,
  filterIngredientSummaries,
  filterIngredientSummariesForInventory,
  isSeasoningIngredient,
  sortInventorySummariesByExpiry,
  type IngredientSummaryViewModel,
} from './workspaceModel';
import type { InventoryStorageFocus } from './ingredientWorkspaceForms';
import type { CatalogStatusFilter, InventoryQuickFilter } from './useIngredientWorkspaceState';

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

export function buildIngredientInventoryViewModel(args: {
  summaries: IngredientSummaryViewModel[];
  quickFilter: InventoryQuickFilter;
  search: string;
  searchMatchedIngredientIds?: readonly string[];
  storageFocus: InventoryStorageFocus;
  sortMode: 'default' | 'expiry';
  actionableIngredientIds: ReadonlySet<string>;
  filterForSearch?: (
    summaries: IngredientSummaryViewModel[],
    search: string,
    matchedIngredientIds?: readonly string[],
  ) => IngredientSummaryViewModel[];
}) {
  const sourceSummaries = args.quickFilter === 'alerted'
    ? args.summaries.filter((item) => args.actionableIngredientIds.has(item.ingredient.id))
    : args.quickFilter === 'expiring'
      ? args.summaries.filter((item) => item.alerts.some((alert) => alert.kind === 'expiry'))
      : args.quickFilter === 'seasoning'
        ? args.summaries.filter((item) => isSeasoningIngredient(item.ingredient))
        : args.summaries;
  const searchFilter = args.filterForSearch ?? filterIngredientSummariesForInventory;
  const filteredInventorySummaries = searchFilter(sourceSummaries, args.search, args.searchMatchedIngredientIds);
  const focusedInventorySummaries = args.storageFocus === 'all'
    ? filteredInventorySummaries
    : filteredInventorySummaries.filter((item) => item.primaryStorage === args.storageFocus);
  const inventoryGroups = buildStorageGroups(focusedInventorySummaries).map((group) => ({
    ...group,
    items: args.sortMode === 'expiry' ? sortInventorySummariesByExpiry(group.items) : group.items,
  }));
  return {
    sourceSummaries,
    filteredInventorySummaries,
    focusedInventorySummaries,
    inventoryStorageOverview: buildInventoryStorageOverview(filteredInventorySummaries),
    inventoryGroups,
  };
}
