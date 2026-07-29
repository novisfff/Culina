import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IngredientSummaryViewModel } from './workspaceModel';
import { IngredientDetailView } from './IngredientDetailView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('IngredientDetailView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('labels an overdue remaining batch as expired even when its stored condition is fresh', () => {
    const selectedIngredient: IngredientSummaryViewModel = {
      ingredient: {
        id: 'ingredient-milk',
        family_id: 'family-1',
        name: '牛奶',
        category: '蛋奶',
        default_unit: '袋',
        unit_conversions: [],
        quantity_tracking_mode: 'track_quantity',
        default_storage: '冷藏',
        default_expiry_mode: 'days',
        default_expiry_days: 3,
        default_low_stock_threshold: null,
        notes: '',
        image: null,
        created_at: '2026-03-01T00:00:00Z',
        updated_at: '2026-03-01T00:00:00Z',
      },
      inventoryItems: [{
        id: 'inventory-expired',
        family_id: 'family-1',
        ingredient_id: 'ingredient-milk',
        ingredient_name: '牛奶',
        quantity: 1,
        remaining_quantity: 1,
        unit: '袋',
        status: 'fresh',
        purchase_date: '2020-01-01',
        expiry_date: '2020-01-04',
        storage_location: '冷藏',
        notes: '',
        low_stock_threshold: 0,
        created_at: '2020-01-01T00:00:00Z',
        updated_at: '2020-01-01T00:00:00Z',
        row_version: 1,
      }],
      availableInventoryItems: [],
      inventoryState: null,
      alerts: [],
      quantitySummaries: [{ unit: '袋', total: 1, label: '1袋' }],
      hasMultipleUnits: false,
      primaryStorage: '冷藏',
      storageLocations: ['冷藏'],
      recipeReferences: [],
      latestPurchaseDate: '2020-01-01',
      latestUpdatedAt: '2026-03-01T00:00:00Z',
      confirmationStatus: 'never_confirmed',
      confirmationLabel: '从未确认',
      confirmationTone: 'neutral',
      lastConfirmedAt: null,
    };

    act(() => {
      root.render(
        <IngredientDetailView
          activePanelBackLabel="返回档案"
          detailStorageLabel="冷藏"
          detailMetricItems={[]}
          selectedIngredient={selectedIngredient}
          recipes={[]}
          goBackToWorkspace={() => undefined}
          openInventoryOverlay={() => undefined}
          openConsumeOverlay={() => undefined}
          openShoppingOverlay={() => undefined}
          openEditView={() => undefined}
          renderIcon={() => null}
          formatExpiryRuleLabel={() => '买后 3 天到期'}
          formatLowStockRuleLabel={() => '未设置低库存提醒'}
        />
      );
    });

    expect(container.textContent).toContain('已过期');
    expect(container.textContent).not.toContain('新鲜');
  });
});
