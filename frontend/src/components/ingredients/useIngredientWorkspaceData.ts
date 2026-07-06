import { useMemo } from 'react';
import type { Ingredient, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import {
  buildInventoryCardStatus,
  buildInventoryStorageOverview,
  buildIngredientCategoryFilters,
  buildIngredientSummaries,
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
  type InventoryStorageOverviewViewModel,
  type ShoppingCardViewModel,
  type ShoppingOverviewViewModel,
  type StorageGroupViewModel,
} from './workspaceModel';
import type { InventoryStorageFocus } from './ingredientWorkspaceForms';
import type {
  CatalogStatusFilter,
  InventoryQuickFilter,
  MobileIngredientFilter,
} from './useIngredientWorkspaceState';

type UseIngredientWorkspaceDataArgs = {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  recipes: Recipe[];
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
  mobileStorageFocus: InventoryStorageFocus;
  filterIngredientSummariesByCatalogStatus: (
    summaries: IngredientSummaryViewModel[],
    filter: CatalogStatusFilter
  ) => IngredientSummaryViewModel[];
  isPendingShopping: (item: ShoppingListItem) => boolean;
};

export function filterMobileCatalogSummaries(args: {
  summaries: IngredientSummaryViewModel[];
  catalogSearch: string;
  catalogSearchMatchedIngredientIds?: readonly string[];
  mobileIngredientFilter: MobileIngredientFilter;
  mobileStorageFocus: InventoryStorageFocus;
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
    if (args.mobileIngredientFilter === 'alerted') {
      return summary.alerts.length > 0;
    }
    if (args.mobileIngredientFilter === 'seasoning') {
      return isSeasoningIngredient(summary.ingredient);
    }
    if (args.mobileIngredientFilter === 'empty') {
      return summary.quantitySummaries.length === 0;
    }
    if (args.mobileIngredientFilter === 'stocked') {
      return summary.quantitySummaries.length > 0;
    }
    return true;
  });
}

export function useIngredientWorkspaceData(args: UseIngredientWorkspaceDataArgs) {
  return useMemo(() => {
    const summaries = buildIngredientSummaries({
      ingredients: args.ingredients,
      inventoryItems: args.inventoryItems,
      recipes: args.recipes,
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
      expired: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'expired').length,
      expiring: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'expiring').length,
      lowStock: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'lowStock').length,
      stable: args.filterIngredientSummariesByCatalogStatus(catalogBaseSummaries, 'stable').length,
    } as const;
    const inventorySourceSummaries =
      args.inventoryQuickFilter === 'alerted' ? summaries.filter((item) => item.alerts.length > 0) : summaries;
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
    const pendingShoppingCards = buildShoppingCards(pendingShopping, summaries);
    const completedShoppingCards = buildShoppingCards(completedShopping, summaries, { completed: true });
    const shoppingOverview = buildShoppingOverview(pendingShoppingCards);
    const visiblePendingShoppingCards = filterShoppingCards(pendingShoppingCards, args.shoppingSearch, args.shoppingFocus);
    const visibleCompletedShoppingCards = filterShoppingCards(completedShoppingCards, args.shoppingSearch, 'all');
    const visiblePendingShoppingGroups = buildShoppingCardGroups(visiblePendingShoppingCards);
    const activeShoppingOverview =
      shoppingOverview.find((item) => item.key === args.shoppingFocus) ?? shoppingOverview[0] ?? null;
    const stockedIngredientCount = summaries.filter((item) => item.quantitySummaries.length > 0).length;
    const workspaceMetrics = [
      { label: '提醒', value: `${allAlerts.length} 条`, detail: '低库存与临期需要优先处理' },
      { label: '待买', value: `${pendingShopping.length} 项`, detail: '购物清单中尚未完成的项目' },
      { label: '在库食材', value: `${stockedIngredientCount} 种`, detail: '已经登记过库存的食材' },
    ];
    const mobilePrioritySummaries = [...summaries]
      .filter((summary) => summary.alerts.length > 0 || summary.quantitySummaries.length === 0)
      .sort((left, right) => {
        const leftStatus = buildInventoryCardStatus(left);
        const rightStatus = buildInventoryCardStatus(right);
        return (
          rightStatus.priority - leftStatus.priority ||
          right.alerts.length - left.alerts.length ||
          right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) ||
          left.ingredient.name.localeCompare(right.ingredient.name, 'zh-CN')
        );
      })
      .slice(0, 6);
    const mobileStorageCards = buildInventoryStorageOverview(summaries).filter((item) =>
      ['冷藏', '冷冻', '常温'].includes(item.key)
    );
    const mobileCatalogSummaries = filterMobileCatalogSummaries({
      summaries,
      catalogSearch: args.catalogSearch,
      catalogSearchMatchedIngredientIds: args.catalogSearchMatchedIngredientIds,
      mobileIngredientFilter: args.mobileIngredientFilter,
      mobileStorageFocus: args.mobileStorageFocus,
    });
    const mobileShoppingCards = pendingShoppingCards.slice(0, 4);
    const mobileShoppingGroups = buildShoppingCardGroups(mobileShoppingCards);
    const mobileHasCatalogFilters =
      Boolean(args.catalogSearch.trim()) || args.mobileIngredientFilter !== 'all' || args.mobileStorageFocus !== 'all';
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
    args.mobileStorageFocus,
    args.recipes,
    args.selectedIngredientId,
    args.shoppingFocus,
    args.shoppingItems,
    args.shoppingSearch,
  ]);
}
