import { describe, expect, it, vi } from 'vitest';
import { createHomeInventoryActionRefresh } from './useAppHomeInventoryActions';

describe('createHomeInventoryActionRefresh', () => {
  it('delegates canonical refresh sources with the current business date', async () => {
    const sources = {
      invalidateChanged: vi.fn().mockResolvedValue(undefined),
      invalidateShopping: vi.fn().mockResolvedValue(undefined),
      fetchInventory: vi.fn().mockResolvedValue([]),
      fetchStates: vi.fn().mockResolvedValue([]),
      fetchIngredients: vi.fn().mockResolvedValue([]),
      fetchShopping: vi.fn().mockResolvedValue([]),
    };
    const controller = createHomeInventoryActionRefresh({ sources, referenceDate: '2026-08-30' });
    await expect(controller()).resolves.toEqual([]);
    expect(sources.invalidateChanged).toHaveBeenCalledOnce();
    expect(sources.fetchInventory).toHaveBeenCalledOnce();
  });
});
