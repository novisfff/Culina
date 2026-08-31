import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { useInventoryRefreshSources } from './useInventoryRefreshSources';

describe('useInventoryRefreshSources', () => {
  it('refreshes the inventory source set through the canonical API methods', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getShoppingList = vi.spyOn(api, 'getShoppingList').mockResolvedValue([]);
    const getIngredients = vi.spyOn(api, 'getIngredients').mockResolvedValue([]);
    const getFoods = vi.spyOn(api, 'getFoods').mockResolvedValue([]);
    const listInventoryStates = vi.spyOn(api, 'listInventoryStates').mockResolvedValue([]);
    const getInventory = vi.spyOn(api, 'getInventory').mockResolvedValue([]);
    const { result } = renderHook(() => useInventoryRefreshSources(), {
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    });

    const sources = await result.current.refreshSources();

    expect(sources).toEqual({ shoppingItems: [], ingredients: [], foods: [], inventoryStates: [] });
    expect(getShoppingList).toHaveBeenCalledOnce();
    expect(getIngredients).toHaveBeenCalledOnce();
    expect(getFoods).toHaveBeenCalledOnce();
    expect(listInventoryStates).toHaveBeenCalledOnce();
    expect(getInventory).toHaveBeenCalledOnce();
  });
});
