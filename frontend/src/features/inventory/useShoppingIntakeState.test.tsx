// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Ingredient, ShoppingListItem } from '../../api/types';
import { useShoppingIntakeState } from './useShoppingIntakeState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useShoppingIntakeState> | null = null;

function makeIngredient(overrides: Partial<Ingredient> & Pick<Ingredient, 'id' | 'name'>): Ingredient {
  return {
    family_id: 'family-1',
    category: '食材',
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
    ...overrides,
  };
}

function makeShoppingItem(
  overrides: Partial<ShoppingListItem> & Pick<ShoppingListItem, 'id' | 'title'>,
): ShoppingListItem {
  return {
    family_id: 'family-1',
    quantity: 6,
    unit: '盒',
    reason: '',
    done: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    target_type: 'ingredient',
    ingredient_id: 'ing-milk',
    row_version: 1,
    ...overrides,
  };
}

function HookHost({ onReady }: { onReady: (value: ReturnType<typeof useShoppingIntakeState>) => void }) {
  const state = useShoppingIntakeState();
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
});

describe('useShoppingIntakeState', () => {
  it('owns step, selection, expanded exceptions, result, busy, and field errors', () => {
    const state = renderHook();
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶' });
    const items = [
      makeShoppingItem({ id: 's1', title: '牛奶' }),
      makeShoppingItem({ id: 's2', title: '牛奶2', ingredient_id: 'ing-milk' }),
    ];

    act(() => {
      state.openIntake({
        shoppingItems: items,
        ingredients: [milk],
        foods: [],
        referenceDate: '2026-07-11',
        now: '2026-07-11T08:00:00.000Z',
      });
    });

    expect(latest!.open).toBe(true);
    expect(latest!.step).toBe('select');
    expect(latest!.draft?.items.every((item) => !item.selected)).toBe(true);
    expect(latest!.selectedCount).toBe(0);
    expect(latest!.canGoReview).toBe(false);

    act(() => {
      latest!.toggleItemSelected('s1');
    });
    expect(latest!.selectedCount).toBe(1);
    expect(latest!.canGoReview).toBe(true);

    act(() => {
      latest!.goToReview();
    });
    expect(latest!.step).toBe('review');

    act(() => {
      latest!.toggleExceptionExpanded('s1');
      latest!.setBusy(true);
      latest!.setFieldErrors([
        {
          shoppingItemId: 's1',
          field: 'actualQuantity',
          code: 'invalid_quantity',
          message: '数量无效',
        },
      ]);
    });
    expect(latest!.expandedExceptionIds).toEqual(['s1']);
    expect(latest!.busy).toBe(true);
    expect(latest!.fieldErrors).toHaveLength(1);

    act(() => {
      latest!.setBusy(false);
      latest!.setResult({
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
        items: [],
      });
      latest!.setStep('result');
    });
    expect(latest!.step).toBe('result');
    expect(latest!.result?.operation_id).toBe('op-1');
  });

  it('generates a new clientRequestId for each new intake open', () => {
    const state = renderHook();
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶' });
    const items = [makeShoppingItem({ id: 's1', title: '牛奶' })];

    act(() => {
      state.openIntake({
        shoppingItems: items,
        ingredients: [milk],
        foods: [],
        referenceDate: '2026-07-11',
        selectedItemId: 's1',
      });
    });
    const firstId = latest!.draft!.clientRequestId;

    act(() => {
      latest!.closeIntake();
    });
    act(() => {
      latest!.openIntake({
        shoppingItems: items,
        ingredients: [milk],
        foods: [],
        referenceDate: '2026-07-11',
        selectedItemId: 's1',
      });
    });
    expect(latest!.draft!.clientRequestId).toBeTruthy();
    expect(latest!.draft!.clientRequestId).not.toBe(firstId);
    expect(latest!.draft!.items[0].selected).toBe(true);
  });

  it('keeps dialog open while busy', () => {
    const state = renderHook();
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶' });

    act(() => {
      state.openIntake({
        shoppingItems: [makeShoppingItem({ id: 's1', title: '牛奶' })],
        ingredients: [milk],
        foods: [],
        referenceDate: '2026-07-11',
        selectedItemId: 's1',
      });
    });
    act(() => {
      latest!.setBusy(true);
    });

    act(() => {
      latest!.closeIntake();
    });
    expect(latest!.open).toBe(true);

    act(() => {
      latest!.setBusy(false);
    });
    act(() => {
      latest!.closeIntake();
    });
    expect(latest!.open).toBe(false);
  });

  it('applyLocalValidation focuses the first field error', () => {
    const state = renderHook();
    const freeTextItem = makeShoppingItem({
      id: 's-free',
      title: '厨房纸',
      target_type: 'free_text',
      ingredient_id: null,
    });

    act(() => {
      state.openIntake({
        shoppingItems: [freeTextItem],
        ingredients: [],
        foods: [],
        referenceDate: '2026-07-11',
        selectedItemId: 's-free',
      });
    });

    let errors: ReturnType<typeof state.applyLocalValidation> = [];
    act(() => {
      errors = latest!.applyLocalValidation();
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(latest!.focusFieldKey).toBe('s-free:resolution');
    expect(latest!.errorMessage).toBeTruthy();
    expect(latest!.expandedExceptionIds).toContain('s-free');
  });

  it('setFocusFieldKey auto-expands the owning exception row', () => {
    const state = renderHook();
    const milk = makeIngredient({ id: 'ing-milk', name: '牛奶' });

    act(() => {
      state.openIntake({
        shoppingItems: [makeShoppingItem({ id: 's1', title: '牛奶' })],
        ingredients: [milk],
        foods: [],
        referenceDate: '2026-07-11',
        selectedItemId: 's1',
      });
    });

    act(() => {
      latest!.setFocusFieldKey('s1:actualQuantity');
    });
    expect(latest!.focusFieldKey).toBe('s1:actualQuantity');
    expect(latest!.expandedExceptionIds).toContain('s1');
  });
});
