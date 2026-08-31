import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InventoryOperationDetail } from '../api/types/inventory';
import { createInventoryOperationController, useAppInventoryOperationHistory } from './useAppInventoryOperations';

const operationDetail: InventoryOperationDetail = {
  operation_id: 'operation-1',
  operation_type: 'reconciliation',
  status: 'applied',
  applied_at: '2026-08-29T00:00:00Z',
  revertible_until: '2026-08-30T00:00:00Z',
  can_revert: true,
  actor_display_name: '测试用户',
  summary: {
    title: '库存盘点',
    description: '已确认 1 项',
    confirmed_count: 1,
    adjusted_count: 0,
    completed_count: 0,
    partial_count: 0,
  },
  lines: [],
};

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

describe('useAppInventoryOperationHistory', () => {
  function renderHistory(isRevertPending = false) {
    const getDetail = vi.fn().mockResolvedValue(operationDetail);
    const view = renderHook(
      ({ pending }) => useAppInventoryOperationHistory({
        getDetail,
        isRevertPending: pending,
      }),
      { initialProps: { pending: isRevertPending } },
    );
    return { ...view, getDetail };
  }

  it('opens on a requested operation and clears prior history errors', () => {
    const { result } = renderHistory();
    act(() => {
      result.current.setError('加载失败');
      result.current.setConflict('版本冲突');
      result.current.openHistory('operation-1');
    });
    expect(result.current.open).toBe(true);
    expect(result.current.selectedOperationId).toBe('operation-1');
    expect(result.current.initialOperationId).toBe('operation-1');
    expect(result.current.error).toBeNull();
    expect(result.current.conflict).toBeNull();
  });

  it('keeps history open while a revert is pending', () => {
    const { result } = renderHistory(true);
    act(() => result.current.openHistory());
    act(() => result.current.closeHistory());
    expect(result.current.open).toBe(true);
  });

  it('owns detail loading state and exposes the loaded operation', async () => {
    const { result, getDetail } = renderHistory();
    await act(() => result.current.loadDetail('operation-1'));
    await waitFor(() => expect(result.current.detail).toEqual(operationDetail));
    expect(result.current.detailLoading).toBe(false);
    expect(result.current.detailError).toBeNull();
    expect(getDetail).toHaveBeenCalledWith('operation-1');
  });
});
