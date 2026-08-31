import { describe, expect, it } from 'vitest';
import type { InventoryOperationResult } from '../../api/types';
import type {
  InventoryReconciliationDraft,
  ReconciliationFieldError,
  ReconciliationSubmitSummary,
} from './inventoryReconciliationModel';
import {
  buildInventoryReconciliationDialogViewModel,
  sortReconciliationFieldErrors,
} from './inventoryReconciliationDialogModel';

const draft: InventoryReconciliationDraft = {
  schemaVersion: 1,
  familyId: 'family-1',
  userId: 'user-1',
  clientRequestId: 'request-1',
  scope: 'all',
  createdAt: '2026-08-28T00:00:00.000Z',
  savedAt: '2026-08-28T00:00:00.000Z',
  intents: [],
};

const summary: ReconciliationSubmitSummary = {
  confirmCount: 1,
  adjustedCount: 0,
  lowCount: 0,
  absentCount: 0,
  createdBatchCount: 0,
  totalTouched: 1,
};

const result: InventoryOperationResult = {
  operation_id: 'operation-1',
  operation_type: 'reconciliation',
  status: 'applied',
  applied_at: '2026-08-28T00:00:00.000Z',
  revertible_until: '2026-08-28T01:00:00.000Z',
  can_revert: true,
  summary: {
    title: '盘点已完成',
    description: '确认 1 项',
    confirmed_count: 1,
    adjusted_count: 0,
    completed_count: 0,
    partial_count: 0,
  },
};

describe('InventoryReconciliationDialog view model', () => {
  it('sorts field errors by target and field without mutating input', () => {
    const errors: ReconciliationFieldError[] = [
      { targetKey: 'food:b', field: 'stockQuantity', code: 'invalid', message: '数量无效' },
      { targetKey: 'food:a', field: 'expiryDate', code: 'invalid', message: '日期无效' },
      { targetKey: 'food:a', field: 'stockQuantity', code: 'invalid', message: '数量无效' },
    ];

    expect(sortReconciliationFieldErrors(errors)).toEqual([errors[1], errors[2], errors[0]]);
    expect(errors[0].targetKey).toBe('food:b');
  });

  it('exposes a stable read-only projection for focus, conflict, and result states', () => {
    const viewModel = buildInventoryReconciliationDialogViewModel({
      open: true,
      step: 'summary',
      scope: 'all',
      draft,
      groups: [],
      orderedGroups: [],
      referenceDate: '2026-08-28',
      loading: false,
      busy: false,
      fieldErrors: [
        { targetKey: 'food:a', field: 'stockQuantity', code: 'invalid', message: '数量无效' },
      ],
      focusFieldKey: 'food:a:stockQuantity',
      conflictState: 'stale_version',
      result,
      summary,
    });

    expect(viewModel).toMatchObject({
      step: 'summary',
      focusFieldKey: 'food:a:stockQuantity',
      hasConflict: true,
      hasResult: true,
      fieldErrors: [{ targetKey: 'food:a', field: 'stockQuantity' }],
      summary,
    });
    expect(Object.isFrozen(viewModel.fieldErrors)).toBe(true);
  });
});
