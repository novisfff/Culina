// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExactIngredientReconciliationGroup,
  InventoryReconciliationResponse,
  ReconciliationBatch,
} from '../../api/types';
import { reconciliationDraftKey } from '../../lib/storage';
import {
  buildExactConfirmAllIntent,
  createEmptyDraft,
  type InventoryReconciliationDraft,
} from './inventoryReconciliationModel';
import {
  clearPersistedReconciliationDraft,
  readPersistedReconciliationDraft,
  useInventoryReconciliationState,
  writePersistedReconciliationDraft,
} from './useInventoryReconciliationState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useInventoryReconciliationState> | null = null;

const FAMILY_ID = 'family-1';
const USER_ID = 'user-1';
const NOW = '2026-07-11T08:00:00.000Z';

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

function makeResponse(groups: InventoryReconciliationResponse['groups']): InventoryReconciliationResponse {
  return {
    business_date: '2026-07-11',
    business_timezone: 'Asia/Shanghai',
    generated_at: NOW,
    summary: {
      total_groups: groups.length,
      never_confirmed: groups.length,
      stale: 0,
      expired_physical_batches: 0,
    },
    groups,
  };
}

function HookHost({
  onReady,
}: {
  onReady: (value: ReturnType<typeof useInventoryReconciliationState>) => void;
}) {
  const state = useInventoryReconciliationState();
  useEffect(() => {
    onReady(state);
  });
  return null;
}

function renderHook() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <HookHost
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
});

describe('useInventoryReconciliationState', () => {
  it('opens without marking anything confirmed', () => {
    const state = renderHook();
    const eggs = makeExactGroup();

    act(() => {
      state.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        storageLocation: '冷藏',
        now: NOW,
      });
    });
    expect(latest!.open).toBe(true);
    expect(latest!.step).toBe('review');
    expect(latest!.draft?.intents).toEqual([]);
    expect(latest!.checkedCount).toBe(0);

    act(() => {
      latest!.applyLoadedGroups({
        response: makeResponse([eggs]),
        scope: 'refrigerated',
        storageLocation: '冷藏',
      });
    });
    expect(latest!.groups).toHaveLength(1);
    expect(latest!.draft?.intents).toEqual([]);
    expect(latest!.canSubmit).toBe(false);
    expect(latest!.loading).toBe(false);
  });

  it('owns scope, focus, expanded batches, intents, summary, busy, result, and restored-draft prompt', () => {
    const state = renderHook();
    const eggs = makeExactGroup();

    act(() => {
      state.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'suggested',
        now: NOW,
      });
      latest!.applyLoadedGroups({
        response: makeResponse([eggs]),
        scope: 'suggested',
      });
    });

    act(() => {
      latest!.setFocusedGroupKey('exact_ingredient:ing-egg');
      latest!.toggleBatchDetails('exact_ingredient:ing-egg');
      latest!.setIntent(buildExactConfirmAllIntent(eggs), NOW);
      latest!.setBusy(true);
    });

    expect(latest!.focusedGroupKey).toBe('exact_ingredient:ing-egg');
    expect(latest!.expandedBatchGroupKeys).toEqual(['exact_ingredient:ing-egg']);
    expect(latest!.draft?.intents).toHaveLength(1);
    expect(latest!.summary.confirmCount).toBe(1);
    expect(latest!.checkedCount).toBe(1);
    expect(latest!.busy).toBe(true);
    expect(latest!.canSubmit).toBe(true);

    act(() => {
      latest!.setBusy(false);
      latest!.goToSummary();
    });
    expect(latest!.step).toBe('summary');

    act(() => {
      latest!.setResultAndClearDraft({
        result: {
          operation_id: 'op-1',
          operation_type: 'reconciliation',
          status: 'applied',
          applied_at: '2026-07-11T08:05:00.000Z',
          revertible_until: '2026-07-11T08:20:00.000Z',
          can_revert: true,
          summary: {
            title: '盘点已完成',
            description: '确认 1 项',
            confirmed_count: 1,
            adjusted_count: 0,
            completed_count: 0,
            partial_count: 0,
          },
        },
        familyId: FAMILY_ID,
        userId: USER_ID,
      });
    });
    expect(latest!.step).toBe('result');
    expect(latest!.result?.operation_id).toBe('op-1');
    expect(readPersistedReconciliationDraft(FAMILY_ID, USER_ID)).toBeNull();
    expect(latest!.draft?.intents).toEqual([]);
  });

  it('preserves draft on close while not busy and restores prompt on next open', () => {
    const state = renderHook();
    const eggs = makeExactGroup();

    act(() => {
      state.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: NOW,
      });
      latest!.applyLoadedGroups({
        response: makeResponse([eggs]),
        scope: 'refrigerated',
        storageLocation: '冷藏',
      });
      latest!.setIntent(buildExactConfirmAllIntent(eggs), NOW);
    });

    expect(readPersistedReconciliationDraft(FAMILY_ID, USER_ID)?.intents).toHaveLength(1);

    act(() => {
      latest!.closeReconciliation({ familyId: FAMILY_ID, userId: USER_ID, now: NOW });
    });
    expect(latest!.open).toBe(false);
    expect(readPersistedReconciliationDraft(FAMILY_ID, USER_ID)?.clientRequestId).toBeTruthy();

    act(() => {
      latest!.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: '2026-07-11T09:00:00.000Z',
      });
    });
    expect(latest!.restoredDraftPrompt?.intents).toHaveLength(1);
    // Fresh open still starts with empty intents until user accepts restore.
    expect(latest!.draft?.intents).toEqual([]);
    expect(latest!.draft?.clientRequestId).not.toBe(latest!.restoredDraftPrompt?.clientRequestId);

    act(() => {
      latest!.acceptRestoredDraft({
        draft: latest!.restoredDraftPrompt!,
        latest: makeResponse([eggs]),
        familyId: FAMILY_ID,
        userId: USER_ID,
        referenceDate: '2026-07-11',
        now: '2026-07-11T09:00:00.000Z',
      });
    });
    expect(latest!.draft?.intents).toHaveLength(1);
    expect(latest!.draft?.clientRequestId).toBe(latest!.draft?.clientRequestId);
    expect(latest!.restoredDraftPrompt).toBeNull();
  });

  it('blocks submit until replay conflicts are reconfirmed', () => {
    const eggs = makeExactGroup();
    const staleEggs = makeExactGroup({
      ingredient_id: 'ing-egg',
      ingredient_name: '鸡蛋',
      ingredient_row_version: 5,
      batches: [makeBatch({ inventory_item_id: 'batch-1', remaining_quantity: 4, row_version: 2 })],
    });
    writePersistedReconciliationDraft(FAMILY_ID, USER_ID, {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: NOW,
        clientRequestId: 'req-stale',
      }),
      intents: [buildExactConfirmAllIntent(eggs)],
    });

    const state = renderHook();
    act(() => {
      state.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: NOW,
      });
    });
    expect(latest!.restoredDraftPrompt).not.toBeNull();

    act(() => {
      latest!.acceptRestoredDraft({
        draft: latest!.restoredDraftPrompt!,
        latest: makeResponse([staleEggs]),
        familyId: FAMILY_ID,
        userId: USER_ID,
        referenceDate: '2026-07-11',
        now: NOW,
      });
    });

    expect(latest!.replayConflicts.length).toBeGreaterThan(0);
    expect(latest!.draft?.intents).toHaveLength(1);
    expect(latest!.canSubmit).toBe(false);

    let advanced = true;
    act(() => {
      advanced = latest!.goToSummary();
    });
    expect(advanced).toBe(false);
    expect(latest!.step).toBe('review');
    expect(latest!.fieldErrors.length).toBeGreaterThan(0);

    let validationErrorCount = 0;
    act(() => {
      validationErrorCount = latest!.applyLocalValidation().length;
    });
    expect(validationErrorCount).toBeGreaterThan(0);

    act(() => {
      latest!.setIntent(buildExactConfirmAllIntent(staleEggs), NOW);
    });

    expect(latest!.replayConflicts).toEqual([]);
    expect(latest!.canSubmit).toBe(true);

    act(() => {
      advanced = latest!.goToSummary();
    });
    expect(advanced).toBe(true);
    expect(latest!.step).toBe('summary');
  });

  it('discards expired drafts in beginOpen so restore prompt is not shown', () => {
    const eggs = makeExactGroup();
    writePersistedReconciliationDraft(FAMILY_ID, USER_ID, {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: '2026-07-01T08:00:00.000Z',
        clientRequestId: 'req-expired',
      }),
      savedAt: '2026-07-01T08:00:00.000Z',
      intents: [buildExactConfirmAllIntent(eggs)],
    });

    const state = renderHook();
    act(() => {
      state.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: NOW,
      });
    });

    expect(latest!.restoredDraftPrompt).toBeNull();
    expect(readPersistedReconciliationDraft(FAMILY_ID, USER_ID)).toBeNull();
  });

  it('does not close while busy', () => {
    const state = renderHook();
    act(() => {
      state.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'all',
        now: NOW,
      });
      latest!.setBusy(true);
    });
    let closed = true;
    act(() => {
      closed = latest!.closeReconciliation({ familyId: FAMILY_ID, userId: USER_ID, now: NOW });
    });
    expect(closed).toBe(false);
    expect(latest!.open).toBe(true);
  });

  it('uses family/user scoped storage key and rejects mismatched draft shapes', () => {
    expect(reconciliationDraftKey(FAMILY_ID, USER_ID)).toBe(
      `culina:inventory-reconciliation-draft:${FAMILY_ID}:${USER_ID}`,
    );
    const draft: InventoryReconciliationDraft = {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'all',
        now: NOW,
        clientRequestId: 'req-x',
      }),
      intents: [buildExactConfirmAllIntent(makeExactGroup())],
    };
    writePersistedReconciliationDraft(FAMILY_ID, USER_ID, draft);
    expect(readPersistedReconciliationDraft(FAMILY_ID, USER_ID)?.clientRequestId).toBe('req-x');
    localStorage.setItem(reconciliationDraftKey(FAMILY_ID, USER_ID), '{"schemaVersion":9}');
    expect(readPersistedReconciliationDraft(FAMILY_ID, USER_ID)).toBeNull();
    clearPersistedReconciliationDraft(FAMILY_ID, USER_ID);
    expect(localStorage.getItem(reconciliationDraftKey(FAMILY_ID, USER_ID))).toBeNull();
  });

  it('discards restored draft on explicit discard', () => {
    const eggs = makeExactGroup();
    writePersistedReconciliationDraft(FAMILY_ID, USER_ID, {
      ...createEmptyDraft({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: NOW,
        clientRequestId: 'req-old',
      }),
      intents: [buildExactConfirmAllIntent(eggs)],
    });
    const state = renderHook();
    act(() => {
      state.beginOpen({
        familyId: FAMILY_ID,
        userId: USER_ID,
        scope: 'refrigerated',
        now: NOW,
      });
    });
    expect(latest!.restoredDraftPrompt).not.toBeNull();
    act(() => {
      latest!.discardRestoredDraft({ familyId: FAMILY_ID, userId: USER_ID });
    });
    expect(latest!.restoredDraftPrompt).toBeNull();
    expect(readPersistedReconciliationDraft(FAMILY_ID, USER_ID)).toBeNull();
  });
});
