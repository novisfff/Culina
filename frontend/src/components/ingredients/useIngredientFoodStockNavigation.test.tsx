import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useIngredientFoodStockNavigation } from './useIngredientFoodStockNavigation';

describe('useIngredientFoodStockNavigation', () => {
  it('reports a warning instead of opening a stock editor for an unloaded item', () => {
    const showNotice = vi.fn();
    const { result } = renderHook(() => useIngredientFoodStockNavigation({
      unifiedInventoryItems: [], foods: [], readyFoodOptions: [], lookupFood: vi.fn(),
      setFoodStockAdjustDialog: vi.fn(), setFoodStockDeductDialog: vi.fn(), setQuickRecord: vi.fn(),
      mealBusinessDate: '2026-08-30', showNotice, openShoppingOverlay: vi.fn(),
    }));

    act(() => result.current.handleOpenFoodStockFromInventory('missing-food'));
    expect(showNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: 'warning' }));
  });
});
