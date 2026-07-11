// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type { Ingredient, ShoppingIntakeResult, ShoppingListItem } from '../../api/types';
import { useShoppingIntakeActions } from './useShoppingIntakeActions';
import { useShoppingIntakeState } from './useShoppingIntakeState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type Bundle = {
  state: ReturnType<typeof useShoppingIntakeState>;
  actions: ReturnType<typeof useShoppingIntakeActions>;
};

let latest: Bundle | null = null;

function makeIngredient(): Ingredient {
  return {
    id: 'ing-milk',
    family_id: 'family-1',
    name: '牛奶',
    category: '乳品',
    default_unit: '盒',
    unit_conversions: [],
    quantity_tracking_mode: 'track_quantity',
    default_storage: '冷藏',
    default_expiry_mode: 'days',
    default_expiry_days: 5,
    default_low_stock_threshold: null,
    notes: '',
    image: null,
    row_version: 1,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

function makeShoppingItem(): ShoppingListItem {
  return {
    id: 's1',
    family_id: 'family-1',
    ingredient_id: 'ing-milk',
    title: '牛奶',
    quantity: 6,
    unit: '盒',
    reason: '',
    done: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    target_type: 'ingredient',
    row_version: 1,
  };
}

function makeResult(overrides: Partial<ShoppingIntakeResult> = {}): ShoppingIntakeResult {
  return {
    operation_id: 'op-1',
    operation_type: 'shopping_intake',
    status: 'applied',
    applied_at: '2026-07-11T08:01:00.000Z',
    revertible_until: '2026-07-11T08:16:00.000Z',
    can_revert: true,
    summary: {
      title: '本次购买已登记',
      description: '完成 1 项',
      confirmed_count: 0,
      adjusted_count: 0,
      completed_count: 1,
      partial_count: 0,
    },
    items: [
      {
        shopping_item_id: 's1',
        result: 'completed',
        remaining_planned_quantity: null,
        inventory_item_id: 'inv-1',
        state_id: null,
        food_id: null,
      },
    ],
    ...overrides,
  };
}

function HookHost(props: {
  submitShoppingIntake: (payload: unknown) => Promise<ShoppingIntakeResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice?: (notice: { tone: string; title: string; message: string }) => void;
  onReady: (value: Bundle) => void;
}) {
  const state = useShoppingIntakeState();
  const actions = useShoppingIntakeActions({
    state,
    submitShoppingIntake: props.submitShoppingIntake as never,
    invalidateAfterInventoryOperation: props.invalidateAfterInventoryOperation,
    showNotice: props.showNotice as never,
  });
  useEffect(() => {
    props.onReady({ state, actions });
  });
  return null;
}

function renderBundle(args: {
  submitShoppingIntake: (payload: unknown) => Promise<ShoppingIntakeResult>;
  invalidateAfterInventoryOperation: () => Promise<void>;
  showNotice?: (notice: { tone: string; title: string; message: string }) => void;
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <HookHost
        submitShoppingIntake={args.submitShoppingIntake}
        invalidateAfterInventoryOperation={args.invalidateAfterInventoryOperation}
        showNotice={args.showNotice}
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
});

async function openReadyDraft() {
  act(() => {
    latest!.state.openIntake({
      shoppingItems: [makeShoppingItem()],
      ingredients: [makeIngredient()],
      foods: [],
      referenceDate: '2026-07-11',
      selectedItemId: 's1',
      now: '2026-07-11T08:00:00.000Z',
    });
  });
  act(() => {
    latest!.state.goToReview();
  });
}

describe('useShoppingIntakeActions', () => {
  it('submits one request and moves to result only after awaited invalidation', async () => {
    const order: string[] = [];
    const submit = vi.fn(async (payload: unknown) => {
      order.push('submit');
      expect((payload as { client_request_id: string }).client_request_id).toBeTruthy();
      return makeResult();
    });
    const invalidate = vi.fn(async () => {
      order.push('invalidate');
    });
    const showNotice = vi.fn();

    renderBundle({
      submitShoppingIntake: submit,
      invalidateAfterInventoryOperation: invalidate,
      showNotice,
    });
    await openReadyDraft();
    const requestId = latest!.state.draft!.clientRequestId;

    await act(async () => {
      await latest!.actions.submitDraft();
    });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['submit', 'invalidate']);
    expect(latest!.state.step).toBe('result');
    expect(latest!.state.result?.operation_id).toBe('op-1');
    expect(latest!.state.draft?.clientRequestId).toBe(requestId);
    expect(latest!.state.busy).toBe(false);
    expect(showNotice).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'success', title: '本次购买已登记' }),
    );
  });

  it('keeps dialog/draft open on 409 and 422 and focuses field errors', async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({
          status: 422,
          detail: '数量无效',
          path: '/api/shopping-list/intakes',
          payload: {
            detail: {
              code: 'invalid_quantity',
              message: '数量无效',
              field_errors: [{ path: 'items.0.actual_quantity', message: '请填写有效数量', code: 'invalid_quantity' }],
            },
          },
        }),
      )
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          detail: '版本冲突',
          path: '/api/shopping-list/intakes',
          payload: {
            detail: {
              code: 'stale_version',
              message: '采购项已被家人更新',
              conflicts: [{ entity_type: 'shopping_list_item', entity_id: 's1' }],
            },
          },
        }),
      );

    renderBundle({
      submitShoppingIntake: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });
    await openReadyDraft();
    const requestId = latest!.state.draft!.clientRequestId;

    await act(async () => {
      await latest!.actions.submitDraft();
    });
    expect(latest!.state.open).toBe(true);
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.draft?.clientRequestId).toBe(requestId);
    expect(latest!.state.fieldErrors).toEqual([
      expect.objectContaining({
        shoppingItemId: 's1',
        field: 'actualQuantity',
        code: 'invalid_quantity',
        message: '请填写有效数量',
      }),
    ]);
    expect(latest!.state.focusFieldKey).toBe('s1:actualQuantity');
    expect(latest!.state.expandedExceptionIds).toContain('s1');
    expect(latest!.state.result).toBeNull();

    await act(async () => {
      await latest!.actions.retryLatest();
    });
    expect(latest!.state.open).toBe(true);
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.conflictState).toBe('stale_version');
    expect(latest!.state.draft?.clientRequestId).toBe(requestId);
    expect(latest!.state.result).toBeNull();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0]).toMatchObject({ client_request_id: requestId });
    expect(submit.mock.calls[1][0]).toMatchObject({ client_request_id: requestId });
  });

  it('network retry reuses the draft request id; new intake creates a new id', async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(makeResult());

    renderBundle({
      submitShoppingIntake: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });
    await openReadyDraft();
    const firstId = latest!.state.draft!.clientRequestId;

    await act(async () => {
      await latest!.actions.submitDraft();
    });
    expect(latest!.state.open).toBe(true);
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.draft?.clientRequestId).toBe(firstId);

    await act(async () => {
      await latest!.actions.retryLatest();
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0]).toMatchObject({ client_request_id: firstId });
    expect(submit.mock.calls[1][0]).toMatchObject({ client_request_id: firstId });
    expect(latest!.state.step).toBe('result');

    act(() => {
      latest!.state.closeIntake();
      latest!.state.openIntake({
        shoppingItems: [makeShoppingItem()],
        ingredients: [makeIngredient()],
        foods: [],
        referenceDate: '2026-07-11',
        selectedItemId: 's1',
      });
    });
    expect(latest!.state.draft!.clientRequestId).not.toBe(firstId);
  });

  it('does not move to result when local validation fails', async () => {
    const submit = vi.fn(async () => makeResult());
    renderBundle({
      submitShoppingIntake: submit,
      invalidateAfterInventoryOperation: vi.fn(async () => undefined),
    });

    act(() => {
      latest!.state.openIntake({
        shoppingItems: [
          {
            ...makeShoppingItem(),
            id: 's-free',
            title: '厨房纸',
            target_type: 'free_text',
            ingredient_id: null,
          },
        ],
        ingredients: [],
        foods: [],
        referenceDate: '2026-07-11',
        selectedItemId: 's-free',
      });
    });
    act(() => {
      latest!.state.goToReview();
    });
    expect(latest!.state.step).toBe('review');

    await act(async () => {
      await latest!.actions.submitDraft();
    });

    expect(submit).not.toHaveBeenCalled();
    expect(latest!.state.step).toBe('review');
    expect(latest!.state.fieldErrors.length).toBeGreaterThan(0);
  });
});
