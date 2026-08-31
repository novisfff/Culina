import { useMemo } from 'react';
import type { Food, Ingredient, IngredientInventoryState, InventoryItem, Recipe, ShoppingListItem } from '../../api/types';
import {
  buildIngredientPriorityActionGroups,
  buildInventoryCardStatus,
  buildInventoryStorageOverview,
  buildIngredientSummaries,
  buildPrioritySurfaceRows,
  buildShoppingCardGroups,
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
  filterIngredientMobileCatalogSummaries,
} from './IngredientWorkspaceViewModel';

// Compatibility export for existing model tests and callers during the workspace migration.
export function filterMobileCatalogSummaries(args: {
  summaries: IngredientSummaryViewModel[];
  catalogSearch: string;
  catalogSearchMatchedIngredientIds?: readonly string[];
  mobileIngredientFilter: MobileIngredientFilter;
  mobileInventoryEntryFilter: InventoryEntryFilter;
  mobileStorageFocus: InventoryStorageFocus;
  actionableIngredientIds?: ReadonlySet<string>;
}) {
  return filterIngredientMobileCatalogSummaries({
    summaries: args.summaries,
    search: args.catalogSearch,
    searchMatchedIngredientIds: args.catalogSearchMatchedIngredientIds,
    ingredientFilter: args.mobileIngredientFilter,
    inventoryEntryFilter: args.mobileInventoryEntryFilter,
    storageFocus: args.mobileStorageFocus,
    actionableIngredientIds: args.actionableIngredientIds,
  });
}

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
    const mobileCatalogSummaries = filterIngredientMobileCatalogSummaries({
      summaries,
      search: args.catalogSearch,
      searchMatchedIngredientIds: args.catalogSearchMatchedIngredientIds,
      ingredientFilter: args.mobileIngredientFilter,
      inventoryEntryFilter: args.mobileInventoryEntryFilter,
      storageFocus: args.mobileStorageFocus,
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
