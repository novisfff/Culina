import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import type { InventoryReconciliationResponse } from '../../api/types/inventory';
import { useInventoryOperationLoaders } from './useInventoryOperationLoaders';

describe('useInventoryOperationLoaders', () => {
  it('loads reconciliation data with the controller scope shape', async () => {
    const response = {} as InventoryReconciliationResponse;
    const getReconciliation = vi.spyOn(api, 'getInventoryReconciliation').mockResolvedValue(response);
    const { result } = renderHook(() => useInventoryOperationLoaders());

    await expect(result.current.fetchReconciliation({ scope: 'suggested', storageLocation: null })).resolves.toBe(response);
    expect(getReconciliation).toHaveBeenCalledWith({ scope: 'suggested', storage_location: null });
  });

  it('loads operation details and keeps both loaders stable', async () => {
    const detail = { operation_id: 'op-1' } as Awaited<ReturnType<typeof api.getInventoryOperation>>;
    const getOperation = vi.spyOn(api, 'getInventoryOperation').mockResolvedValue(detail);
    const { result, rerender } = renderHook(() => useInventoryOperationLoaders());
    const initial = result.current;

    await expect(result.current.getOperationDetail('op-1')).resolves.toBe(detail);
    rerender();
    expect(result.current.getOperationDetail).toBe(initial.getOperationDetail);
    expect(result.current.fetchReconciliation).toBe(initial.fetchReconciliation);
    expect(getOperation).toHaveBeenCalledWith('op-1');
  });
});
