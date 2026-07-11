import { useMemo } from 'react';
import type { Food, Ingredient, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import {
  buildIngredientPriorityActionGroups,
  buildInventoryCardStatus,
  buildInventoryStorageOverview,
  buildIngredientCategoryFilters,
  buildIngredientSummaries,
  buildPrioritySurfaceRows,
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
  type ShoppingOverviewViewModel,
} from './workspaceModel';
import { businessDateKey } from '../../lib/date';
import type { InventoryStorageFocus } from './ingredientWorkspaceForms';
import type { InventoryEntryFilter } from './inventoryOverviewModel';
import type {
  CatalogStatusFilter,
  InventoryQuickFilter,
  MobileIngredientFilter,
} from './useIngredientWorkspaceState';

type UseIngredientWorkspaceDataArgs = {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  recipes: Recipe[];
  foods: Food[];
  shoppingItems: ShoppingListItem[];
  ingredientOptions: Ingredient[];
  selectedIngredientId: string | null;
  catalogSearch: string;
  catalogSearchMatchedIngredientIds?: readonly string[];
  catalogCategoryFilter: string;
  catalogStatusFilter: CatalogStatusFilter;
  inventoryQuickFilter: InventoryQuickFilter;
  inventorySearch: string;
  inventorySearchMatchedIngredientIds?: readonly string[];
  inventoryStorageFocus: InventoryStorageFocus;
  inventorySortMode: 'default' | 'expiry';
  shoppingSearch: string;
  shoppingFocus: ShoppingOverviewViewModel['key'];
  mobileIngredientFilter: MobileIngredientFilter;
  mobileInventoryEntryFilter: InventoryEntryFilter;
  mobileStorageFocus: InventoryStorageFocus;
  filterIngredientSummariesByCatalogStatus: (
    summaries: IngredientSummaryViewModel[],
    filter: CatalogStatusFilter
  ) => IngredientSummaryViewModel[];
  isPendingShopping: (item: ShoppingListItem) => boolean;
  referenceDate?: string;
};

export function filterMobileCatalogSummaries(args: {
  summaries: IngredientSummaryViewModel[];
  catalogSearch: string;
  catalogSearchMatchedIngredientIds?: readonly string[];
  mobileIngredientFilter: MobileIngredientFilter;
  mobileInventoryEntryFilter: InventoryEntryFilter;
  mobileStorageFocus: InventoryStorageFocus;
  actionableIngredientIds?: ReadonlySet<string>;
}) {
  return filterIngredientSummaries(
    args.summaries,
    args.catalogSearch,
    'all',
    args.catalogSearchMatchedIngredientIds
  ).filter((summary) => {
    if (args.mobileStorageFocus !== 'all' && summary.primaryStorage !== args.mobileStorageFocus) {
      return false;
    }
    const isActionable =
      args.actionableIngredientIds?.has(summary.ingredient.id) ?? summary.alerts.length > 0;
    const quickMatches =
      args.mobileIngredientFilter === 'all' ||
      args.mobileIngredientFilter === 'ingredient' ||
      (args.mobileIngredientFilter === 'alerted' && isActionable) ||
      (args.mobileIngredientFilter === 'expiring' && summary.alerts.some((alert) => alert.kind === 'expiry')) ||
      (args.mobileIngredientFilter === 'seasoning' && isSeasoningIngredient(summary.ingredient));
    const entryMatches =
      args.mobileInventoryEntryFilter === 'all' ||
      (args.mobileInventoryEntryFilter === 'pending' && summary.quantitySummaries.length === 0) ||
      (args.mobileInventoryEntryFilter === 'stocked' && summary.quantitySummaries.length > 0);
    return quickMatches && entryMatches;
  });
}

function filterInventorySummariesByQuickFilter(
  summaries: IngredientSummaryViewModel[],
  quickFilter: InventoryQuickFilter,
  actionableIngredientIds: ReadonlySet<string>
) {
  if (quickFilter === 'alerted') {
    return summaries.filter((item) => actionableIngredientIds.has(item.ingredient.id));
  }
  if (quickFilter === 'food') {
    return [];
  }
  if (quickFilter === 'expiring') {
    return summaries.filter((item) => item.alerts.some((alert) => alert.kind === 'expiry'));
  }
  if (quickFilter === 'seasoning') {
    return summaries.filter((item) => isSeasoningIngredient(item.ingredient));
  }
  return summaries;
}

export function useIngredientWorkspaceData(args: UseIngredientWorkspaceDataArgs) {
  return useMemo(() => {
    const referenceDate = args.referenceDate ?? businessDateKey();
    const inventoryActionGroups = buildIngredientPriorityActionGroups({
      ingredients: args.ingredients,
      inventoryItems: args.inventoryItems,
      shoppingItems: args.shoppingItems,
      referenceDate,
    });
    const priorityActionCount = inventoryActionGroups.length;
    const actionableIngredientIds = new Set(inventoryActionGroups.map((group) => group.ingredientId));
    const summaries = buildIngredientSummaries({
      ingredients: args.ingredients,
      inventoryItems: args.inventoryItems,
      recipes: args.recipes,
      today: referenceDate,
      shoppingItems: args.shoppingItems,
    });
    const catalogCategories = buildIngredientCategoryFilters(args.ingredients);
    const catalogBaseSummaries = filterIngredientSummaries(
      summaries,
      args.catalogSearch,
      args.catalogCategoryFilter,
      args.catalogSearchMatchedIngredientIds
    );
    const filteredSummaries = args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, args.catalogStatusFilter);
    const catalogHasActiveFilter =
      Boolean(args.catalogSearch.trim()) || args.catalogCategoryFilter !== 'all' || args.catalogStatusFilter !== 'all';
    const catalogCountLabel = catalogHasActiveFilter
      ? `当前筛选 ${filteredSummaries.length} 项`
      : `共 ${summaries.length} 项`;
    const catalogStatusCounts = {
      all: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'all').length,
      actionNeeded: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'actionNeeded').length,
      expired: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'expired').length,
      expiring: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'expiring').length,
      lowStock: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'lowStock').length,
      stable: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'stable').length,
    } as const;
    const inventorySourceSummaries = filterInventorySummariesByQuickFilter(
      summaries,
      args.inventoryQuickFilter,
      actionableIngredientIds
    );
    const filteredInventorySummaries = filterIngredientSummariesForInventory(
      inventorySourceSummaries,
      args.inventorySearch,
      args.inventorySearchMatchedIngredientIds
    );
    const inventoryStorageOverview = buildInventoryStorageOverview(filteredInventorySummaries);
    const focusedInventorySummaries =
      args.inventoryStorageFocus === 'all'
        ? filteredInventorySummaries
        : filteredInventorySummaries.filter((item) => item.primaryStorage === args.inventoryStorageFocus);
    const inventoryGroups = buildStorageGroups(focusedInventorySummaries).map((group) => ({
      ...group,
      items: args.inventorySortMode === 'expiry' ? sortInventorySummariesByExpiry(group.items) : group.items,
    }));
    const selectedIngredient =
      summaries.find((item) => item.ingredient.id === args.selectedIngredientId) ?? summaries[0] ?? null;
    const allAlerts = summaries.flatMap((item) => item.alerts);
    const pendingShopping = args.shoppingItems.filter(args.isPendingShopping);
    const completedShopping = args.shoppingItems.filter((item) => item.done);
    const pendingShoppingCards = buildShoppingCards(pendingShopping, summaries, { foods: args.foods });
    const completedShoppingCards = buildShoppingCards(completedShopping, summaries, { completed: true, foods: args.foods });
    const shoppingOverview = buildShoppingOverview(pendingShoppingCards);
    const visiblePendingShoppingCards = filterShoppingCards(pendingShoppingCards, args.shoppingSearch, args.shoppingFocus);
    const visibleCompletedShoppingCards = filterShoppingCards(completedShoppingCards, args.shoppingSearch, 'all');
    const visiblePendingShoppingGroups = buildShoppingCardGroups(visiblePendingShoppingCards);
    const activeShoppingOverview =
      shoppingOverview.find((item) => item.key === args.shoppingFocus) ?? shoppingOverview[0] ?? null;
    const stockedIngredientCount = summaries.filter((item) => item.quantitySummaries.length > 0).length;
    const workspaceMetrics = [
      { label: '提醒', value: `${priorityActionCount} 种`, detail: '过期、临期或待补货需要优先处理' },
      { label: '待买', value: `${pendingShopping.length} 项`, detail: '购物清单中尚未完成的项目' },
      { label: '在库食材', value: `${stockedIngredientCount} 种`, detail: '已经登记过库存的食材' },
    ];
    const summaryByIngredientId = new Map(summaries.map((summary) => [summary.ingredient.id, summary]));
    // Full priority surface keeps all shared groups, including 4-7 day later severity.
    const mobilePriorityRows = buildPrioritySurfaceRows(inventoryActionGroups).map((row) => ({
      ...row,
      summary: summaryByIngredientId.get(row.group.ingredientId) ?? null,
    }));
    const mobilePrioritySummaries = mobilePriorityRows
      .map((row) => row.summary)
      .filter((summary): summary is IngredientSummaryViewModel => Boolean(summary));
    const mobileStorageCards = buildInventoryStorageOverview(summaries).filter((item) =>
      ['冷藏', '冷冻', '常温'].includes(item.key)
    );
    const mobileCatalogSummaries = filterMobileCatalogSummaries({
      summaries,
      catalogSearch: args.catalogSearch,
      catalogSearchMatchedIngredientIds: args.catalogSearchMatchedIngredientIds,
      mobileIngredientFilter: args.mobileIngredientFilter,
      mobileInventoryEntryFilter: args.mobileInventoryEntryFilter,
      mobileStorageFocus: args.mobileStorageFocus,
      actionableIngredientIds,
    });
    const mobileShoppingCards = pendingShoppingCards.slice(0, 4);
    const mobileShoppingGroups = buildShoppingCardGroups(mobileShoppingCards);
    const mobileHasCatalogFilters =
      Boolean(args.catalogSearch.trim()) ||
      args.mobileIngredientFilter !== 'all' ||
      args.mobileInventoryEntryFilter !== 'all' ||
      args.mobileStorageFocus !== 'all';
    const quickRestockIngredients = (
      summaries
        .filter((item) => item.inventoryItems.length > 0 || item.latestPurchaseDate)
        .sort(
          (left, right) =>
            (right.latestPurchaseDate ?? '').localeCompare(left.latestPurchaseDate ?? '') ||
            right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) ||
            left.ingredient.name.localeCompare(right.ingredient.name, 'zh-CN')
        )
        .map((item) => item.ingredient)
        .concat(args.ingredientOptions)
    )
      .filter((ingredient, index, list) => list.findIndex((entry) => entry.id === ingredient.id) === index)
      .slice(0, 6);

    return {
      summaries,
      inventoryActionGroups,
      priorityActionCount,
      actionableIngredientIds,
      catalogCategories,
      filteredSummaries,
      catalogCountLabel,
      catalogStatusCounts,
      filteredInventorySummaries,
      inventoryStorageOverview,
      focusedInventorySummaries,
      inventoryGroups,
      selectedIngredient,
      allAlerts,
      pendingShopping,
      completedShoppingCards,
      pendingShoppingCards,
      visiblePendingShoppingCards,
      visiblePendingShoppingGroups,
      visibleCompletedShoppingCards,
      shoppingOverview,
      activeShoppingOverview,
      stockedIngredientCount,
      workspaceMetrics,
      mobilePriorityRows,
      mobilePrioritySummaries,
      mobileStorageCards,
      mobileCatalogSummaries,
      mobileShoppingCards,
      mobileShoppingGroups,
      mobileHasCatalogFilters,
      quickRestockIngredients,
    };
  }, [
    args.catalogCategoryFilter,
    args.catalogSearch,
    args.catalogSearchMatchedIngredientIds,
    args.catalogStatusFilter,
    args.filterIngredientSummariesByCatalogStatus,
    args.ingredientOptions,
    args.ingredients,
    args.inventoryItems,
    args.inventoryQuickFilter,
    args.inventorySearch,
    args.inventorySearchMatchedIngredientIds,
    args.inventorySortMode,
    args.inventoryStorageFocus,
    args.isPendingShopping,
    args.mobileIngredientFilter,
    args.mobileInventoryEntryFilter,
    args.mobileStorageFocus,
    args.recipes,
    args.referenceDate,
    args.selectedIngredientId,
    args.shoppingFocus,
    args.shoppingItems,
    args.shoppingSearch,
  ]);
}
