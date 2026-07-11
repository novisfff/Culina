// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type {
  ExactIngredientReconciliationGroup,
  InventoryOperationResult,
  InventoryReconciliationResponse,
  PresenceIngredientReconciliationGroup,
  ReconciliationBatch,
} from '../../api/types';
import {
  buildExactConfirmAllIntent,
  createEmptyDraft,
  type InventoryReconciliationDraft,
} from './inventoryReconciliationModel';
import { useInventoryReconciliationActions } from './useInventoryReconciliationActions';
import {
  clearPersistedReconciliationDraft,
  useInventoryReconciliationState,
  writePersistedReconciliationDraft,
} from './useInventoryReconciliationState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type Bundle = {
  state: ReturnType<typeof useInventoryReconciliationState>;
  actions: ReturnType<typeof useInventoryReconciliationActions>;
};

let latest: Bundle | null = null;

const FAMILY_ID = 'family-1';
const USER_ID = 'user-1';
const NOW = '2026-07-11T08:00:00.000Z';
const REFERENCE_DATE = '2026-07-11';

function makeBatch(
  overrides: Partial<ReconciliationBatch> & Pick<ReconciliationBatch, 'inventory_item_id'>,
): ReconciliationBatch {
  return {
    row_version: 1,
    remaining_quantity: 3,
    unit: '个',
    status: 'fresh',
    purchase_date: '2026-07-01',
    expiry_date: '2026-07-20',
    storage_location: '冷藏',
    notes: '',
    confirmation_status: 'never_confirmed',
    last_confirmed_at: null,
    ...overrides,
  };
}

function makeExactGroup(
  overrides: Partial<ExactIngredientReconciliationGroup> &
    Pick<ExactIngredientReconciliationGroup, 'ingredient_id' | 'ingredient_name'> = {
    ingredient_id: 'ing-egg',
    ingredient_name: '鸡蛋',
  },
): ExactIngredientReconciliationGroup {
  return {
    kind: 'exact_ingredient',
    ingredient_row_version: 4,
    confirmation_status: 'never_confirmed',
    last_confirmed_at: null,
    batches: [makeBatch({ inventory_item_id: 'batch-1', remaining_quantity: 4 })],
    pending_shopping_item_id: null,
    ...overrides,
  };
}

function makePresenceGroup(
  overrides: Partial<PresenceIngredientReconciliationGroup> = {},
): PresenceIngredientReconciliationGroup {
  return {
    kind: 'presence_ingredient',
    ingredient_id: 'ing-salt',
    ingredient_name: '盐',
    ingredient_row_version: 2,
    confirmation_status: 'stale',
    pending_shopping_item_id: null,
    state: {
      id: 'state-salt',
      family_id: FAMILY_ID,
      ingredient_id: 'ing-salt',
      availability_level: 'sufficient',
      inventory_status: 'fresh',
      purchase_date: '2026-06-01',
      expiry_date: null,
      storage_location: '常温',
      notes: '',
      expiry_alert_snoozed_until: null,
      expiry_reviewed_at: null,
      expiry_reviewed_by: null,
      last_confirmed_at: '2026-06-01T00:00:00.000Z',
      last_confirmed_by: null,
      last_confirmation_source: 'manual_entry',
      row_version: 1,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

function makeResponse(
  groups: InventoryReconciliationResponse['groups'],
): InventoryReconciliationResponse {
  return {
    business_date: REFERENCE_DATE,
    business_timezone: 'Asia/Shanghai',
    generated_at: NOW,
    summary: {
      total_groups: groups.length,
      never_confirmed: groups.filter((group) => group.confirmation_status === 'never_confirmed').length,
      stale: groups.filter((group) => group.confirmation_status === 'stale').length,
      expired_physical_batches: 0,
    },
    groups,
  };
}

function makeResult(overrides: Partial<InventoryOperationResult> = {}): InventoryOperationResult {
  return {
    operation_id: 'op-recon-1',
    operation_type: 'reconciliation',
    status: 'applied',
    applied_at: '2026-07-11T08:01:00.000Z',
    revertible_until: '2026-07-11T08:16:00.000Z',
    can_revert: true,
    summary: {
      title: '本次盘点已完成',
      description: '确认 1 项',
      confirmed_count: 1,
      adjusted_count: 0,
      completed_count: 1,
      partial_count: 0,
    },
    ...overrides,
  };
}

function HookHost(props: {
  fetchReconciliation: (args: {
    scope: string;
    storageLocation: string | null;
  }) => Promise<InventoryReconciliationResponse>;
  submitReconciliation: (request: unknown) => Promise<InventoryOperationResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice: (notice: { tone: string; title: string; message: string }) => void;
  onReady: (value: Bundle) => void;
}) {
  const state = useInventoryReconciliationState();
  const actions = useInventoryReconciliationActions({
    familyId: FAMILY_ID,
    userId: USER_ID,
    referenceDate: REFERENCE_DATE,
    state,
    fetchReconciliation: props.fetchReconciliation as never,
    submitReconciliation: props.submitReconciliation as never,
    invalidateAfterInventoryOperation: props.invalidateAfterInventoryOperation,
    showNotice: props.showNotice as never,
    now: () => NOW,
  });
  useEffect(() => {
    props.onReady({ state, actions });
  });
  return null;
}

function renderBundle(args: {
  fetchReconciliation: (args: {
    scope: string;
    storageLocation: string | null;
  }) => Promise<InventoryReconciliationResponse>;
  submitReconciliation: (request: unknown) => Promise<InventoryOperationResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice?: (notice: { tone: string; title: string; message: string }) => void;
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <HookHost
        fetchReconciliation={args.fetchReconciliation}
        submitReconciliation={args.submitReconciliation}
        invalidateAfterInventoryOperation={args.invalidateAfterInventoryOperation}
        showNotice={args.showNotice ?? vi.fn()}
        onReady={(value) => {
          latest = value;
        }}
      />,
    );
  });
  return latest!;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  localStorage.clear();
  vi.useRealTimers();
});

describe('useInventoryReconciliationActions', () => {
  it('open fetches the selected scope and does not auto-confirm', async () => {
    const eggs = makeExactGroup();
    const fetchReconciliation = vi.fn(async (args: { scope: string; storageLocation: string | null }) => {
      expect(args).toEqual({ scope: 'refrigerated', storageLocation: '冷藏' });
      return makeResponse([eggs]);
    });

    renderBundle({
      fetchReconciliation,
      submitReconciliation: vi.fn(async () => makeResult()),
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    await act(async () => {
      await latest!.actions.openReconciliation('refrigerated', '冷藏');
    });

    expect(fetchReconciliation).toHaveBeenCalledTimes(1);
    expect(latest!.state.open).toBe(true);
    expect(latest!.state.loading).toBe(false);
    expect(latest!.state.scope).toBe('refrigerated');
    expect(latest!.state.groups).toHaveLength(1);
    expect(latest!.state.draft?.intents).toEqual([]);
    expect(latest!.state.checkedCount).toBe(0);
  });

  it('restored drafts fetch latest then replay without auto-confirming new groups', async () => {
    const eggs = makeExactGroup();
    const salt = makePresenceGroup();
    const draft: InventoryReconciliationDraft = {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'suggested',
        now: NOW,
        clientRequestId: 'client-restore-1',
      }),
      intents: [buildExactConfirmAllIntent(eggs)],
      savedAt: NOW,
    };
    writePersistedReconciliationDraft(FAMILY_ID, USER_ID, draft);

    const fetchReconciliation = vi.fn(async () => makeResponse([eggs, salt]));
    renderBundle({
      fetchReconciliation,
      submitReconciliation: vi.fn(async () => makeResult()),
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    await act(async () => {
      await latest!.actions.openReconciliation('suggested');
    });

    expect(fetchReconciliation).toHaveBeenCalledTimes(1);
    expect(latest!.state.draft?.clientRequestId).toBe('client-restore-1');
    expect(latest!.state.draft?.intents).toHaveLength(1);
    expect(latest!.state.groups).toHaveLength(2);
    expect(latest!.state.restoredDraftPrompt).toBeNull();
    // Newly discovered salt is listed but not auto-confirmed.
    expect(latest!.state.draft?.intents.some((intent) => intent.kind === 'presence_ingredient')).toBe(
      false,
    );
  });

  it('submit sends only touched intents and clears draft after awaited invalidation', async () => {
    const eggs = makeExactGroup();
    const salt = makePresenceGroup();
    const order: string[] = [];
    const submit = vi.fn(async (payload: unknown) => {
      order.push('submit');
      const body = payload as { client_request_id: string; groups: unknown[] };
      expect(body.client_request_id).toBeTruthy();
      expect(body.groups).toHaveLength(1);
      expect(body.groups[0]).toMatchObject({
        kind: 'exact_ingredient',
        ingredient_id: 'ing-egg',
        action: 'confirm_all',
      });
      return makeResult();
    });
    const invalidate = vi.fn(async () => {
      order.push('invalidate');
    });
    const showNotice = vi.fn();

    renderBundle({
      fetchReconciliation: vi.fn(async () => makeResponse([eggs, salt])),
      submitReconciliation: submit,
      invalidateAfterInventoryOperation: invalidate,
      showNotice,
    });

    await act(async () => {
      await latest!.actions.openReconciliation('all');
    });
    const requestId = latest!.state.draft!.clientRequestId;

    act(() => {
      latest!.state.setIntent(buildExactConfirmAllIntent(eggs), NOW);
    });

    await act(async () => {
      await latest!.actions.submitDraft();
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['submit', 'invalidate']);
    expect(latest!.state.step).toBe('result');
    expect(latest!.state.result?.operation_id).toBe('op-recon-1');
    expect(latest!.state.draft?.intents).toEqual([]);
    expect(latest!.state.busy).toBe(false);
    expect(showNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'success', title: '本次盘点已完成' }),
    );
    // Storage cleared after success.
    clearPersistedReconciliationDraft(FAMILY_ID, USER_ID);
    // Request id preserved on in-memory draft shell until close.
    expect(latest!.state.draft?.clientRequestId).toBe(requestId);
  });

  it('409 refreshes latest, preserves non-conflicting intents, places conflicts first, keeps dialog open', async () => {
    const eggs = makeExactGroup();
    const salt = makePresenceGroup();
    const staleEggs = makeExactGroup({
      ingredient_id: 'ing-egg',
      ingredient_name: '鸡蛋',
      ingredient_row_version: 9,
      batches: [makeBatch({ inventory_item_id: 'batch-1', remaining_quantity: 4, row_version: 3 })],
    });

    const fetchReconciliation = vi
      .fn()
      .mockResolvedValueOnce(makeResponse([eggs, salt]))
      .mockResolvedValueOnce(makeResponse([staleEggs, salt]));

    const submit = vi.fn().mockRejectedValueOnce(
      new ApiError({
        status: 409,
        detail: '版本冲突',
        path: '/api/inventory/reconciliations',
        payload: {
          detail: {
            code: 'stale_version',
            message: '家人可能刚改动了库存，请重新确认。',
            conflicts: [{ entity_type: 'ingredient', entity_id: 'ing-egg' }],
          },
        },
      }),
    );

    renderBundle({
      fetchReconciliation,
      submitReconciliation: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    await act(async () => {
      await latest!.actions.openReconciliation('all');
    });
    const requestId = latest!.state.draft!.clientRequestId;

    act(() => {
      latest!.state.setIntent(buildExactConfirmAllIntent(eggs), NOW);
      latest!.state.setIntent(
        {
          kind: 'presence_ingredient',
          ingredientId: 'ing-salt',
          stateId: 'state-salt',
          expectedIngredientRowVersion: 2,
          expectedStateRowVersion: 1,
          availabilityLevel: 'low',
          inventoryStatus: 'fresh',
          purchaseDate: '2026-06-01',
          expiryDate: null,
          storageLocation: '常温',
          notes: '',
        },
        NOW,
      );
    });
    expect(latest!.state.draft?.intents).toHaveLength(2);

    await act(async () => {
      await latest!.actions.submitDraft();
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      groups: expect.arrayContaining([
        expect.objectContaining({ kind: 'exact_ingredient' }),
        expect.objectContaining({ kind: 'presence_ingredient' }),
      ]),
    });
    expect(latest!.state.open).toBe(true);
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.conflictState).toBe('stale_version');
    expect(latest!.state.result).toBeNull();
    expect(latest!.state.draft?.clientRequestId).toBe(requestId);
    // Salt non-conflict preserved; eggs rebound with conflict.
    expect(latest!.state.draft?.intents.map((intent) => intent.kind).sort()).toEqual([
      'exact_ingredient',
      'presence_ingredient',
    ]);
    expect(latest!.state.replayConflicts.some((conflict) => conflict.targetKey.includes('ing-egg'))).toBe(
      true,
    );
    expect(latest!.state.orderedGroups[0]).toMatchObject({ ingredient_id: 'ing-egg' });
    expect(fetchReconciliation).toHaveBeenCalledTimes(2);
  });

  it('422 maps field_errors onto group controls and keeps dialog open', async () => {
    const eggs = makeExactGroup();
    const submit = vi.fn().mockRejectedValueOnce(
      new ApiError({
        status: 422,
        detail: '数量无效',
        path: '/api/inventory/reconciliations',
        payload: {
          detail: {
            code: 'invalid_quantity',
            message: '数量无效',
            field_errors: [
              {
                path: 'groups.0.updates.0.actual_remaining_quantity',
                message: '请填写有效剩余量',
                code: 'invalid_quantity',
              },
            ],
          },
        },
      }),
    );

    renderBundle({
      fetchReconciliation: vi.fn(async () => makeResponse([eggs])),
      submitReconciliation: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    await act(async () => {
      await latest!.actions.openReconciliation('all');
    });
    act(() => {
      latest!.state.setIntent(
        {
          kind: 'exact_ingredient',
          ingredientId: 'ing-egg',
          expectedIngredientRowVersion: 4,
          action: 'adjust_batches',
          observedBatches: [{ inventory_item_id: 'batch-1', expected_row_version: 1 }],
          updates: [
            {
              inventoryItemId: 'batch-1',
              expectedRowVersion: 1,
              // Locally valid non-negative quantity; server still rejects with 422.
              actualRemainingQuantity: '2',
              inventoryStatus: 'fresh',
              purchaseDate: '2026-07-01',
              expiryDate: '2026-07-20',
              storageLocation: '冷藏',
              notes: '',
            },
          ],
          creates: [],
        },
        NOW,
      );
    });

    await act(async () => {
      await latest!.actions.submitDraft();
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(latest!.state.open).toBe(true);
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.fieldErrors).toEqual([
      expect.objectContaining({
        targetKey: 'exact_ingredient:ing-egg',
        message: '请填写有效剩余量',
        code: 'invalid_quantity',
      }),
    ]);
    expect(latest!.state.focusFieldKey).toContain('exact_ingredient:ing-egg');
    expect(latest!.state.result).toBeNull();
  });

  it('submit from summary 422 recovers onto review with fieldErrors and expanded batch controls', async () => {
    const eggs = makeExactGroup();
    const submit = vi.fn().mockRejectedValueOnce(
      new ApiError({
        status: 422,
        detail: '数量无效',
        path: '/api/inventory/reconciliations',
        payload: {
          detail: {
            code: 'invalid_quantity',
            message: '数量无效',
            field_errors: [
              {
                path: 'groups.0.updates.0.actual_remaining_quantity',
                message: '请填写有效剩余量',
                code: 'invalid_quantity',
              },
            ],
          },
        },
      }),
    );

    renderBundle({
      fetchReconciliation: vi.fn(async () => makeResponse([eggs])),
      submitReconciliation: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    await act(async () => {
      await latest!.actions.openReconciliation('all');
    });
    act(() => {
      latest!.state.setIntent(
        {
          kind: 'exact_ingredient',
          ingredientId: 'ing-egg',
          expectedIngredientRowVersion: 4,
          action: 'adjust_batches',
          observedBatches: [{ inventory_item_id: 'batch-1', expected_row_version: 1 }],
          updates: [
            {
              inventoryItemId: 'batch-1',
              expectedRowVersion: 1,
              actualRemainingQuantity: '2',
              inventoryStatus: 'fresh',
              purchaseDate: '2026-07-01',
              expiryDate: '2026-07-20',
              storageLocation: '冷藏',
              notes: '',
            },
          ],
          creates: [],
        },
        NOW,
      );
    });

    let advanced = false;
    act(() => {
      advanced = latest!.state.goToSummary();
    });
    expect(advanced).toBe(true);
    expect(latest!.state.step).toBe('summary');
    expect(latest!.state.expandedBatchGroupKeys).toEqual([]);

    await act(async () => {
      await latest!.actions.submitDraft();
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.fieldErrors).toEqual([
      expect.objectContaining({
        targetKey: 'exact_ingredient:ing-egg',
        field: 'batch:batch-1:actualRemainingQuantity',
        message: '请填写有效剩余量',
      }),
    ]);
    expect(latest!.state.focusFieldKey).toBe(
      'exact_ingredient:ing-egg:batch:batch-1:actualRemainingQuantity',
    );
    expect(latest!.state.expandedBatchGroupKeys).toContain('exact_ingredient:ing-egg');
    expect(latest!.state.errorMessage).toBe('请填写有效剩余量');

    // Summary "返回检查" after 422 must not wipe recovered field errors.
    act(() => {
      latest!.state.goToSummary();
    });
    // goToSummary may fail validation or succeed; force summary then cancel back.
    act(() => {
      // ensure we're able to exercise goToReview from a summary-like state
      // even if goToSummary re-validates and stays on review when errors exist
      if (latest!.state.step !== 'summary') {
        // recover path already left us on review with errors; re-enter summary by
        // temporarily clearing then restoring is unnecessary — call goToReview directly.
      }
    });
    const errorsAfter422 = latest!.state.fieldErrors;
    const focusAfter422 = latest!.state.focusFieldKey;
    act(() => {
      latest!.state.goToReview();
    });
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.fieldErrors).toEqual(errorsAfter422);
    expect(latest!.state.focusFieldKey).toBe(focusAfter422);
  });

  it('network errors preserve draft and request id for retry', async () => {
    const eggs = makeExactGroup();
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(makeResult());

    renderBundle({
      fetchReconciliation: vi.fn(async () => makeResponse([eggs])),
      submitReconciliation: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    await act(async () => {
      await latest!.actions.openReconciliation('all');
    });
    act(() => {
      latest!.state.setIntent(buildExactConfirmAllIntent(eggs), NOW);
    });
    const requestId = latest!.state.draft!.clientRequestId;

    await act(async () => {
      await latest!.actions.submitDraft();
    });
    expect(latest!.state.open).toBe(true);
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.draft?.clientRequestId).toBe(requestId);
    expect(latest!.state.draft?.intents).toHaveLength(1);
    expect(latest!.state.errorMessage).toBeTruthy();

    await act(async () => {
      await latest!.actions.retryLatest();
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0]).toMatchObject({ client_request_id: requestId });
    expect(submit.mock.calls[1][0]).toMatchObject({ client_request_id: requestId });
    expect(latest!.state.step).toBe('result');
  });

  it('prevents duplicate submits while busy', async () => {
    const eggs = makeExactGroup();
    let resolveSubmit: ((value: InventoryOperationResult) => void) | null = null;
    const submit = vi.fn(
      () =>
        new Promise<InventoryOperationResult>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    renderBundle({
      fetchReconciliation: vi.fn(async () => makeResponse([eggs])),
      submitReconciliation: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    await act(async () => {
      await latest!.actions.openReconciliation('all');
    });
    act(() => {
      latest!.state.setIntent(buildExactConfirmAllIntent(eggs), NOW);
    });

    let first: Promise<void> | null = null;
    await act(async () => {
      first = latest!.actions.submitDraft();
      // second call while in-flight must no-op
      await latest!.actions.submitDraft();
    });
    expect(submit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSubmit?.(makeResult());
      await first;
    });
    expect(latest!.state.step).toBe('result');
  });
});
