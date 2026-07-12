// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryOperationResult } from '../../api/types';
import {
  InventoryOperationBanner,
  isOperationStillRevertible,
  selectRecentBannerOperation,
} from './InventoryOperationBanner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const applied: InventoryOperationResult = {
  operation_id: 'op-1',
  operation_type: 'shopping_intake',
  status: 'applied',
  applied_at: '2026-07-11T08:01:00.000Z',
  revertible_until: '2026-07-11T08:16:00.000Z',
  can_revert: true,
  summary: {
    title: '本次购买已登记',
    description: '完成 2 项',
    confirmed_count: 0,
    adjusted_count: 0,
    completed_count: 2,
    partial_count: 0,
  },
};

function renderBanner(props: Partial<Parameters<typeof InventoryOperationBanner>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const defaults: Parameters<typeof InventoryOperationBanner>[0] = {
    operation: applied,
    now: () => Date.parse('2026-07-11T08:05:00.000Z'),
    onView: vi.fn(),
    onRevert: vi.fn(),
    ...props,
  };
  act(() => {
    root!.render(<InventoryOperationBanner {...defaults} />);
  });
  return defaults;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-11T08:05:00.000Z'));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe('InventoryOperationBanner helpers', () => {
  it('selects the newest still-revertible operation', () => {
    const older: InventoryOperationResult = {
      ...applied,
      operation_id: 'op-old',
      applied_at: '2026-07-11T07:50:00.000Z',
      revertible_until: '2026-07-11T08:05:00.000Z',
    };
    const newest: InventoryOperationResult = {
      ...applied,
      operation_id: 'op-new',
      applied_at: '2026-07-11T08:10:00.000Z',
      revertible_until: '2026-07-11T08:25:00.000Z',
    };
    const reverted: InventoryOperationResult = {
      ...applied,
      operation_id: 'op-reverted',
      status: 'reverted',
      can_revert: false,
      applied_at: '2026-07-11T08:12:00.000Z',
    };
    const selected = selectRecentBannerOperation(
      [older, newest, reverted],
      Date.parse('2026-07-11T08:11:00.000Z'),
    );
    expect(selected?.operation_id).toBe('op-new');
    expect(isOperationStillRevertible(newest, Date.parse('2026-07-11T08:11:00.000Z'))).toBe(true);
    expect(isOperationStillRevertible(reverted, Date.parse('2026-07-11T08:11:00.000Z'))).toBe(false);
  });
});

describe('InventoryOperationBanner', () => {
  it('renders live countdown copy and eligible actions', () => {
    const props = renderBanner();
    expect(container!.textContent).toContain('本次购买已登记');
    expect(container!.textContent).toContain('可在');
    expect(container!.textContent).toContain('前撤销');
    expect(container!.textContent).toContain('剩余');
    expect(container!.textContent).toContain('查看');
    expect(container!.textContent).toContain('撤销本次操作');

    const view = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('查看'),
    );
    const revert = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('撤销本次操作'),
    );
    act(() => {
      view!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      revert!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onView).toHaveBeenCalledWith('op-1');
    expect(props.onRevert).toHaveBeenCalledWith('op-1');
  });

  it('hides destructive affordance when expired or not can_revert', () => {
    renderBanner({
      operation: {
        ...applied,
        can_revert: false,
      },
      now: () => Date.parse('2026-07-11T08:05:00.000Z'),
    });
    expect(container!.textContent).toContain('撤销窗口已过');
    expect(container!.textContent).not.toContain('撤销本次操作');

    act(() => root?.unmount());
    container?.remove();
    renderBanner({
      operation: {
        ...applied,
        can_revert: true,
        revertible_until: '2026-07-11T08:04:00.000Z',
      },
      now: () => Date.parse('2026-07-11T08:05:00.000Z'),
    });
    expect(container!.textContent).not.toContain('撤销本次操作');
  });

  it('respects server-provided can_revert for Member/Owner', () => {
    renderBanner({
      operation: {
        ...applied,
        can_revert: false,
        summary: {
          ...applied.summary,
          title: '家人的盘点已完成',
        },
      },
    });
    expect(container!.textContent).toContain('家人的盘点已完成');
    expect(container!.textContent).not.toContain('撤销本次操作');
  });
});
