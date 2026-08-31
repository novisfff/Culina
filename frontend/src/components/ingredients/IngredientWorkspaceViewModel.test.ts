import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../../api/types';
import type { IngredientSummaryViewModel } from './workspaceModel';
import {
  buildIngredientCatalogViewModel,
  buildIngredientInventoryViewModel,
  filterIngredientMobileCatalogSummaries,
  buildIngredientShoppingViewModel,
  buildIngredientDetailViewModel,
} from './IngredientWorkspaceViewModel';

describe('Ingredient catalog view model', () => {
  it('projects catalog filters and counts without React state', () => {
    const ingredient = { id: 'i-1', name: '番茄', category: '蔬菜' } as Ingredient;
    const summaries = [
      {
        ingredient,
        alerts: [],
        quantitySummaries: [],
      },
    ] as unknown as IngredientSummaryViewModel[];
    const model = buildIngredientCatalogViewModel({
      summaries,
      ingredients: [ingredient],
      search: '',
      categoryFilter: 'all',
      statusFilter: 'all',
      filterByStatus: (items, filter) => (filter === 'all' ? items : []),
    });

    expect(model.filteredSummaries).toHaveLength(1);
    expect(model.countLabel).toBe('共 1 项');
    expect(model.statusCounts).toMatchObject({ all: 1, actionNeeded: 0 });
  });

  it('projects inventory filtering, storage focus and expiry sorting', () => {
    const summaries = [
      { ingredient: { id: 'i-1', name: '番茄' }, inventoryItems: [], availableInventoryItems: [], inventoryState: null, alerts: [{ kind: 'expiry' }], primaryStorage: '冷藏', storageLocations: ['冷藏'], quantitySummaries: [{ value: 1 }], hasMultipleUnits: false, recipeReferences: [], latestPurchaseDate: null, latestUpdatedAt: '', confirmationStatus: 'current', confirmationLabel: '', confirmationTone: 'current', lastConfirmedAt: null },
      { ingredient: { id: 'i-2', name: '盐' }, inventoryItems: [], availableInventoryItems: [], inventoryState: null, alerts: [], primaryStorage: '常温', storageLocations: ['常温'], quantitySummaries: [{ value: 2 }], hasMultipleUnits: false, recipeReferences: [], latestPurchaseDate: null, latestUpdatedAt: '', confirmationStatus: 'current', confirmationLabel: '', confirmationTone: 'current', lastConfirmedAt: null },
    ] as unknown as IngredientSummaryViewModel[];
    const model = buildIngredientInventoryViewModel({
      summaries,
      quickFilter: 'expiring',
      search: '',
      storageFocus: '冷藏',
      sortMode: 'expiry',
      actionableIngredientIds: new Set(['i-1']),
      filterForSearch: (items) => items,
    });

    expect(model.filteredInventorySummaries).toHaveLength(1);
    expect(model.focusedInventorySummaries[0]?.ingredient.id).toBe('i-1');
    expect(model.inventoryGroups).toHaveLength(1);
  });

  it('projects pending and completed shopping cards with the active focus', () => {
    const model = buildIngredientShoppingViewModel({
      shoppingItems: [
        { id: 's-1', title: '番茄', done: false, reason: '', quantity: 1, unit: '个', updated_at: '' },
        { id: 's-2', title: '鸡蛋', done: true, reason: '', quantity: 1, unit: '个', updated_at: '' },
      ] as never,
      summaries: [],
      foods: [],
      search: '番茄',
      focus: 'all',
      isPending: (item) => !item.done,
    });

    expect(model.pendingShoppingCards).toHaveLength(1);
    expect(model.visiblePendingShoppingCards).toHaveLength(1);
    expect(model.visiblePendingShoppingCards[0]?.title).toBe('番茄');
    expect(model.visibleCompletedShoppingCards).toHaveLength(0);
  });

  it('keeps mobile catalog filters composable with remote search matches', () => {
    const summary = {
      ingredient: { id: 'i-1', name: '番茄' },
      alerts: [{ kind: 'expiry' }],
      primaryStorage: '冷藏',
      quantitySummaries: [],
    } as unknown as IngredientSummaryViewModel;
    expect(filterIngredientMobileCatalogSummaries({
      summaries: [summary],
      search: '番茄',
      searchMatchedIngredientIds: ['i-1'],
      ingredientFilter: 'expiring',
      inventoryEntryFilter: 'pending',
      storageFocus: '冷藏',
    })).toEqual([summary]);
  });

  it('projects detail metrics from the selected ingredient summary', () => {
    const selected = {
      ingredient: { id: 'i-1', name: '番茄', default_unit: '个', default_storage: '冷藏' },
      quantitySummaries: [{ label: '2 个' }],
      recipeReferences: [{ id: 'r-1', title: '番茄炒蛋' }],
      alerts: [{ kind: 'expiry' }],
      primaryStorage: '冷藏',
    } as never;
    const model = buildIngredientDetailViewModel(selected);
    expect(model.detailStorageLabel).toBe('冷藏');
    expect(model.detailMetricItems.map((item) => item.value)).toEqual(['2 个', '1', '个', '1']);
  });
});
