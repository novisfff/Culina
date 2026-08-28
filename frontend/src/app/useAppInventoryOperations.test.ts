import { describe, expect, it, vi } from 'vitest';
import { createInventoryOperationController } from './useAppInventoryOperations';

describe('inventory operation controller', () => {
  it('clears stale detail and exposes the load error when refresh fails', async () => {
    const setDetail = vi.fn();
    const setError = vi.fn();
    const setLoading = vi.fn();
    const controller = createInventoryOperationController({ getDetail: vi.fn().mockRejectedValue(new Error('offline')), setDetail, setLoading, setError });
    await controller.loadDetail('operation-1');
    expect(setDetail).toHaveBeenCalledWith(null);
    expect(setError).toHaveBeenCalledWith('offline');
    expect(setLoading.mock.calls).toEqual([[true], [false]]);
  });
});
