import { useMemo } from 'react';
import type { Food, Ingredient, IngredientInventoryState, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import {
  buildIngredientPriorityActionGroups,
  buildInventoryCardStatus,
  buildInventoryStorageOverview,
  buildIngredientSummaries,
  buildPrioritySurfaceRows,
  buildShoppingCardGroups,
  filterIngredientSummaries,
  isSeasoningIngredient,
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
import {
  buildIngredientCatalogViewModel,
  buildIngredientInventoryViewModel,
  buildIngredientShoppingViewModel,
} from './IngredientWorkspaceViewModel';

type UseIngredientWorkspaceDataArgs = {
  ingredients: Ingredient[];
  inventoryItems: InventoryItem[];
  recipes: Recipe[];
  foods: Food[];
  shoppingItems: ShoppingListItem[];
  inventoryStates?: IngredientInventoryState[];
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

export function useIngredientWorkspaceData(args: UseIngredientWorkspaceDataArgs) {
  return useMemo(() => {
    const referenceDate = args.referenceDate ?? businessDateKey();
    const inventoryStates = args.inventoryStates ?? [];
    const inventoryActionGroups = buildIngredientPriorityActionGroups({
      ingredients: args.ingredients,
      inventoryItems: args.inventoryItems,
      shoppingItems: args.shoppingItems,
      inventoryStates,
      referenceDate,
    });
    const priorityActionCount = inventoryActionGroups.length;
    const actionableIngredientIds = new Set(inventoryActionGroups.map((group) => group.ingredientId));
    const summaries = buildIngredientSummaries({
      ingredients: args.ingredients,
      inventoryItems: args.inventoryItems,
      recipes: args.recipes,
      referenceDate,
      shoppingItems: args.shoppingItems,
      inventoryStates,
    });
    const catalogProjection = buildIngredientCatalogViewModel({
      summaries,
      ingredients: args.ingredients,
      search: args.catalogSearch,
      categoryFilter: args.catalogCategoryFilter,
      statusFilter: args.catalogStatusFilter,
      searchMatchedIngredientIds: args.catalogSearchMatchedIngredientIds,
      filterByStatus: args.filterIngredientSummariesByCatalogStatus,
    });
    const {
      catalogCategories,
      filteredSummaries,
      countLabel: catalogCountLabel,
      statusCounts: catalogStatusCounts,
    } = catalogProjection;
    const inventoryProjection = buildIngredientInventoryViewModel({
      summaries,
      quickFilter: args.inventoryQuickFilter,
      search: args.inventorySearch,
      searchMatchedIngredientIds: args.inventorySearchMatchedIngredientIds,
      storageFocus: args.inventoryStorageFocus,
      sortMode: args.inventorySortMode,
      actionableIngredientIds,
    });
    const {
      filteredInventorySummaries,
      focusedInventorySummaries,
      inventoryStorageOverview,
      inventoryGroups,
    } = inventoryProjection;
    const selectedIngredient =
      summaries.find((item) => item.ingredient.id === args.selectedIngredientId) ?? summaries[0] ?? null;
    const allAlerts = summaries.flatMap((item) => item.alerts);
    const shoppingProjection = buildIngredientShoppingViewModel({
      shoppingItems: args.shoppingItems,
      summaries,
      foods: args.foods,
      search: args.shoppingSearch,
      focus: args.shoppingFocus,
      isPending: args.isPendingShopping,
    });
    const {
      pendingShopping,
      completedShoppingCards,
      pendingShoppingCards,
      shoppingOverview,
      visiblePendingShoppingCards,
      visibleCompletedShoppingCards,
      visiblePendingShoppingGroups,
      activeShoppingOverview,
    } = shoppingProjection;
    const stockedIngredientCount = summaries.filter((item) => item.quantitySummaries.length > 0).length;
    const workspaceMetrics = [
      { label: '提醒', value: `${priorityActionCount} 种`, detail: '过期、临期或待补货需要优先处理' },
      { label: '待买', value: `${pendingShopping.length} 项`, detail: '采购清单中还没买到的内容' },
      { label: '在库食材', value: `${stockedIngredientCount} 种`, detail: '已有库存的食材' },
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
    const mobileShoppingCards = pendingShoppingCards;
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
    args.inventoryStates,
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
