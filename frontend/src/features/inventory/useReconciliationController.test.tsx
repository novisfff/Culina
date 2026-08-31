import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useReconciliationController } from './useReconciliationController';

vi.mock('./useInventoryReconciliationActions', () => ({
  useInventoryReconciliationActions: vi.fn((args) => ({
    openReconciliation: vi.fn((scope) => args.state.beginOpen({ familyId: args.familyId, userId: args.userId, scope, storageLocation: null, now: 'now' })),
    submitDraft: vi.fn(),
    retryLatest: vi.fn(),
  })),
}));

describe('useReconciliationController', () => {
  it('owns a single state instance and exposes scope actions', () => {
    const hook = renderHook(() => useReconciliationController({
      familyId: 'family-1',
      userId: 'user-1',
      referenceDate: '2026-08-29',
      fetchReconciliation: vi.fn(),
      submitReconciliation: vi.fn(),
      invalidateAfterInventoryOperation: vi.fn(),
      showNotice: vi.fn(),
    }));
    expect(hook.result.current.state).toBeTruthy();
    expect(hook.result.current.actions).toBeTruthy();
    expect(hook.result.current.openForScope).toBeTypeOf('function');
    expect(hook.result.current.changeScope).toBeTypeOf('function');
  });
});
