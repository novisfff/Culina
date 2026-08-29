import { describe, expect, it } from 'vitest';
import type { Ingredient } from '../../api/types';
import type { IngredientSummaryViewModel } from './workspaceModel';
import { buildIngredientCatalogViewModel, buildIngredientInventoryViewModel } from './IngredientWorkspaceViewModel';

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
});
