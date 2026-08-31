import { describe, expect, it, vi } from 'vitest';
import { refreshHomeInventoryActions } from './useHomeInventoryRefresh';

describe('refreshHomeInventoryActions', () => {
  it('invalidates canonical data before rebuilding actions from fresh responses', async () => {
    const order: string[] = [];
    const result = await refreshHomeInventoryActions({
      invalidateChanged: async () => { order.push('changed'); },
      invalidateShopping: async () => { order.push('shopping'); },
      fetchInventory: async () => [],
      fetchStates: async () => [],
      fetchIngredients: async () => [],
      fetchShopping: async () => [],
      referenceDate: '2026-08-29',
    });
    expect(order).toEqual(['changed', 'shopping']);
    expect(result).toEqual([]);
  });

  it('propagates a fetch failure instead of returning stale actions', async () => {
    const fetchInventory = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(refreshHomeInventoryActions({
      invalidateChanged: async () => undefined,
      invalidateShopping: async () => undefined,
      fetchInventory,
      fetchStates: async () => [],
      fetchIngredients: async () => [],
      fetchShopping: async () => [],
      referenceDate: '2026-08-29',
    })).rejects.toThrow('offline');
  });
});
