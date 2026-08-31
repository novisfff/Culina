import type { Food, Ingredient, IngredientInventoryState, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import {
  buildIngredientCategoryFilters,
  buildIngredientSummaries,
  buildInventoryStorageOverview,
  buildShoppingCardGroups,
  buildShoppingCards,
  buildShoppingOverview,
  buildStorageGroups,
  filterShoppingCards,
  filterIngredientSummaries,
  filterIngredientSummariesForInventory,
  isSeasoningIngredient,
  sortInventorySummariesByExpiry,
  type IngredientSummaryViewModel,
  type ShoppingCardFocus,
  type ShoppingOverviewViewModel,
} from './workspaceModel';
import type { InventoryStorageFocus } from './ingredientWorkspaceForms';
import type { CatalogStatusFilter, InventoryQuickFilter, MobileIngredientFilter } from './useIngredientWorkspaceState';

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

export function buildIngredientShoppingViewModel(args: {
  shoppingItems: ShoppingListItem[];
  summaries: IngredientSummaryViewModel[];
  foods: Food[];
  search: string;
  focus: ShoppingCardFocus;
  isPending: (item: ShoppingListItem) => boolean;
}) {
  const pendingShopping = args.shoppingItems.filter(args.isPending);
  const completedShopping = args.shoppingItems.filter((item) => item.done);
  const pendingShoppingCards = buildShoppingCards(pendingShopping, args.summaries, { foods: args.foods });
  const completedShoppingCards = buildShoppingCards(completedShopping, args.summaries, { completed: true, foods: args.foods });
  const shoppingOverview = buildShoppingOverview(pendingShoppingCards);
  return {
    pendingShopping,
    completedShoppingCards,
    pendingShoppingCards,
    shoppingOverview,
    visiblePendingShoppingCards: filterShoppingCards(pendingShoppingCards, args.search, args.focus),
    visibleCompletedShoppingCards: filterShoppingCards(completedShoppingCards, args.search, 'all'),
    visiblePendingShoppingGroups: buildShoppingCardGroups(filterShoppingCards(pendingShoppingCards, args.search, args.focus)),
    activeShoppingOverview: shoppingOverview.find((item: ShoppingOverviewViewModel) => item.key === args.focus) ?? shoppingOverview[0] ?? null,
  };
}

export function filterIngredientMobileCatalogSummaries(args: {
  summaries: IngredientSummaryViewModel[];
  search: string;
  searchMatchedIngredientIds?: readonly string[];
  ingredientFilter: MobileIngredientFilter;
  inventoryEntryFilter: 'all' | 'pending' | 'stocked';
  storageFocus: InventoryStorageFocus;
  actionableIngredientIds?: ReadonlySet<string>;
}) {
  return filterIngredientSummaries(
    args.summaries,
    args.search,
    'all',
    args.searchMatchedIngredientIds,
  ).filter((summary) => {
    if (args.storageFocus !== 'all' && summary.primaryStorage !== args.storageFocus) return false;
    const isActionable = args.actionableIngredientIds?.has(summary.ingredient.id) ?? summary.alerts.length > 0;
    const quickMatches = args.ingredientFilter === 'all'
      || args.ingredientFilter === 'ingredient'
      || (args.ingredientFilter === 'alerted' && isActionable)
      || (args.ingredientFilter === 'expiring' && summary.alerts.some((alert) => alert.kind === 'expiry'))
      || (args.ingredientFilter === 'seasoning' && isSeasoningIngredient(summary.ingredient));
    const entryMatches = args.inventoryEntryFilter === 'all'
      || (args.inventoryEntryFilter === 'pending' && summary.quantitySummaries.length === 0)
      || (args.inventoryEntryFilter === 'stocked' && summary.quantitySummaries.length > 0);
    return quickMatches && entryMatches;
  });
}

export function buildIngredientDetailViewModel(selected: IngredientSummaryViewModel) {
  const detailQuantityLabel = selected.quantitySummaries[0]?.label ?? '还没有库存';
  return {
    detailStorageLabel: selected.primaryStorage || selected.ingredient.default_storage || '常温',
    detailMetricItems: [
      { icon: 'stocked' as const, label: '当前库存', value: detailQuantityLabel, tone: 'green' as const },
      { icon: 'link' as const, label: '相关菜谱', value: `${selected.recipeReferences.length}`, tone: 'brown' as const },
      { icon: 'scale' as const, label: '默认单位', value: selected.ingredient.default_unit || '个', tone: 'brown' as const },
      { icon: 'bell' as const, label: '当前提醒', value: `${selected.alerts.length}`, tone: selected.alerts.length > 0 ? 'red' as const : 'green' as const },
    ],
  };
}
