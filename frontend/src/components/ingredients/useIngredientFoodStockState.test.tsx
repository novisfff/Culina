import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { InventoryOverviewItem } from '../../api/types/inventory';
import { useIngredientFoodStockState } from './useIngredientFoodStockState';

describe('useIngredientFoodStockState', () => {
  it('updates restock fields without dropping the current dialog', () => {
    const { result } = renderHook(() => useIngredientFoodStockState('2026-08-29'));
    act(() => result.current.setFoodStockAdjustDialog({
      item: {
        id: 'food-1', source_type: 'food', source_id: 'food-1', row_version: 1,
        title: '番茄酱', category: '调味品', image: null, quantity: 2, unit: '瓶', quantity_label: '2 瓶',
        quantity_tracking_mode: 'track_quantity', tone: 'stable', expiry_date: null,
        storage_location: '常温', purchase_source: null, updated_at: '2026-08-29T00:00:00Z',
        primary_action: 'edit_food_stock', search_text: '番茄酱',
      } satisfies InventoryOverviewItem,
      quantity: '1', unit: '瓶', expiryDate: '', purchaseSource: '', error: '旧错误',
    }));
    act(() => result.current.setFoodStockRestockExpiryDays(7));
    expect(result.current.foodStockAdjustDialog).toMatchObject({ quantity: '1', unit: '瓶', expiryDate: '2026-09-05', error: null });
  });

  it('does not recreate a closed dialog when a field setter runs', () => {
    const { result } = renderHook(() => useIngredientFoodStockState('2026-08-29'));
    act(() => result.current.setFoodStockRestockSource('盒马'));
    expect(result.current.foodStockAdjustDialog).toBeNull();
  });
});
