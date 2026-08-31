import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAppInventoryRevert } from './useAppInventoryRevert';

const result = {
  operation_id: 'op-1',
  operation_type: 'shopping_intake',
  family_id: 'family-1',
  actor_user_id: 'user-1',
  applied_at: '2026-08-29T00:00:00Z',
  reverted_at: null,
  reverted_by: null,
  can_revert: false,
  summary: { title: '已撤销', description: '库存已恢复' },
};

function setup(overrides: Record<string, unknown> = {}) {
  const setConflict = vi.fn();
  const setError = vi.fn();
  const setDetail = vi.fn();
  const setShoppingResult = vi.fn();
  const setReconciliationResult = vi.fn();
  const setRecentBannerOverride = vi.fn();
  const showNotice = vi.fn();
  const mutate = vi.fn().mockResolvedValue(result);
  const getDetail = vi.fn().mockResolvedValue({ operation_id: 'op-1' });
  const args = {
    mutate,
    operationHistory: { open: true, selectedOperationId: 'op-1', setConflict, setError, setDetail },
    shoppingResult: { ...result, items: [{ shopping_item_id: 'item-1' }] } as never,
    setShoppingResult,
    reconciliationResult: result,
    setReconciliationResult,
    familyId: 'family-1',
    userId: 'user-1',
    getDetail,
    setRecentBannerOverride,
    showNotice,
    errorMessage: () => '撤销失败',
    ...overrides,
  };
  const hook = renderHook(() => useAppInventoryRevert(args as never));
  return { hook, mutate, getDetail, setConflict, setError, setDetail, setShoppingResult, setReconciliationResult, setRecentBannerOverride, showNotice };
}

describe('useAppInventoryRevert', () => {
  it('synchronizes owned results and refreshes the selected operation after success', async () => {
    const state = setup();
    await act(() => state.hook.result.current('op-1'));
    expect(state.setConflict).toHaveBeenCalledWith(null);
    expect(state.setError).toHaveBeenCalledWith(null);
    expect(state.setRecentBannerOverride).toHaveBeenCalledWith(result);
    expect(state.setShoppingResult).toHaveBeenCalledWith(expect.objectContaining({ operation_id: 'op-1', items: [{ shopping_item_id: 'item-1' }] }));
    expect(state.setReconciliationResult).toHaveBeenCalledWith(result, 'family-1', 'user-1');
    expect(state.getDetail).toHaveBeenCalledWith('op-1');
    expect(state.showNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success', message: '库存已恢复' }));
  });

  it('keeps the history open and exposes a conflict message when revert fails', async () => {
    const state = setup({ mutate: vi.fn().mockRejectedValue(new Error('stale')) });
    await act(() => state.hook.result.current('op-1'));
    expect(state.setConflict).toHaveBeenLastCalledWith('撤销失败');
    expect(state.showNotice).not.toHaveBeenCalled();
  });
});
