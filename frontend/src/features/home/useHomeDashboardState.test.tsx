// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InventoryActionGroup } from '../inventory/inventoryActionModel';
import {
  useHomeDashboardState,
  type HomeActionCompletionSummary,
  type UseHomeDashboardStateResult,
} from './useHomeDashboardState';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeExpiryGroup(ingredientId: string, name: string): InventoryActionGroup {
  return {
    kind: 'expiry',
    id: `expiry:${ingredientId}`,
    ingredientId,
    ingredientName: name,
    severity: 'expired',
    batches: [],
    expiredBatchCount: 1,
    todayBatchCount: 0,
    soonBatchCount: 0,
    laterBatchCount: 0,
    totalBatchCount: 1,
    quantityLabels: ['1 个'],
    storageLocations: ['冷藏'],
    earliestExpiryDate: '2026-07-01',
    earliestDaysLeft: -1,
    title: `${name}需要处理`,
    detail: '1 批已过期',
    primaryAction: 'manage_expiry',
  };
}

function makeLowStockGroup(ingredientId: string, name: string): InventoryActionGroup {
  return {
    kind: 'low_stock',
    id: `low_stock:${ingredientId}`,
    ingredientId,
    ingredientName: name,
    availableQuantity: 1,
    unit: '个',
    threshold: 4,
    title: `${name}库存不足`,
    detail: '现有 1 个，补货线 4 个',
    primaryAction: 'add_shopping',
  };
}

function Harness({
  groups,
  onState,
}: {
  groups: InventoryActionGroup[];
  onState: (state: UseHomeDashboardStateResult) => void;
}) {
  const state = useHomeDashboardState({
    foodPlanWeekRange: { start: '2026-07-06', end: '2026-07-12' },
    homeEligibleInventoryActionGroups: groups,
  });

  useEffect(() => {
    onState(state);
  });

  return (
    <div>
      <span data-testid="selected">{state.selectedActionGroupId ?? ''}</span>
      <span data-testid="next">{state.nextGroupId ?? ''}</span>
      <span data-testid="completed">{state.completedIngredientId ?? ''}</span>
      <span data-testid="summary">{state.completionSummary?.title ?? ''}</span>
    </div>
  );
}

let latest: UseHomeDashboardStateResult | null = null;

function renderHarness(groups: InventoryActionGroup[]) {
  act(() => {
    root?.render(
      <Harness
        groups={groups}
        onState={(state) => {
          latest = state;
        }}
      />,
    );
  });
  return latest;
}

beforeEach(() => {
  latest = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
});

describe('useHomeDashboardState', () => {
  it('offers the next group after refreshed groups arrive without auto-opening it', () => {
    const tomato = makeExpiryGroup('ingredient-tomato', '番茄');
    const milk = makeExpiryGroup('ingredient-milk', '牛奶');
    const egg = makeLowStockGroup('ingredient-egg', '鸡蛋');

    let state = renderHarness([tomato, milk, egg]);
    expect(state).not.toBeNull();

    act(() => {
      state!.openActionGroup(tomato.id);
    });
    state = latest!;
    expect(state.selectedActionGroupId).toBe(tomato.id);
    expect(state.nextGroupId).toBeNull();

    const summary: HomeActionCompletionSummary = {
      title: '已处理番茄',
      message: '过期批次已处理完成',
    };

    act(() => {
      state!.completeActionGroup({
        ingredientId: tomato.ingredientId,
        summary,
      });
    });
    state = latest!;
    expect(state.selectedActionGroupId).toBeNull();
    expect(state.completedIngredientId).toBe(tomato.ingredientId);
    expect(state.completionSummary).toEqual(summary);
    // Groups not refreshed yet — no next suggestion.
    expect(state.nextGroupId).toBeNull();

    // Refreshed projection excludes tomato and keeps milk/egg.
    state = renderHarness([milk, egg]);
    expect(state!.selectedActionGroupId).toBeNull();
    expect(state!.nextGroupId).toBe(milk.id);
    expect(state!.completionSummary?.title).toBe('已处理番茄');
  });

  it('excludes completedIngredientId from next suggestion even when it reappears as low stock', () => {
    const tomato = makeExpiryGroup('ingredient-tomato', '番茄');
    const milk = makeExpiryGroup('ingredient-milk', '牛奶');
    const tomatoLowStock = makeLowStockGroup('ingredient-tomato', '番茄');

    let state = renderHarness([tomato, milk]);
    act(() => {
      state!.completeActionGroup({
        ingredientId: tomato.ingredientId,
        summary: {
          title: '已处理番茄',
          message: '已销毁过期批次',
          secondaryActionLabel: '番茄库存已不足，加入采购',
          secondaryActionIngredientId: tomato.ingredientId,
        },
      });
    });

    state = renderHarness([tomatoLowStock, milk]);
    expect(state!.completedIngredientId).toBe(tomato.ingredientId);
    expect(state!.nextGroupId).toBe(milk.id);
    expect(state!.nextGroupId).not.toBe(tomatoLowStock.id);
  });

  it('does not expose obsolete raw-list visibility or disposal selection state', () => {
    const state = renderHarness([]);
    expect(state).not.toBeNull();
    expect('visibleExpiryCount' in state!).toBe(false);
    expect('visibleDashboardTodoCount' in state!).toBe(false);
    expect('homeExpiredDisposalIngredientId' in state!).toBe(false);
    expect('homeExpiryReviewItemId' in state!).toBe(false);
    expect('resetVisibleExpiryCount' in state!).toBe(false);
  });
});
