// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InventoryOperationDetail,
  InventoryOperationSummary,
} from '../../api/types';
import { InventoryOperationHistoryDialog } from './InventoryOperationHistoryDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeSummary(
  overrides: Partial<InventoryOperationSummary> = {},
): InventoryOperationSummary {
  return {
    operation_id: 'op-1',
    operation_type: 'shopping_intake',
    status: 'applied',
    applied_at: '2026-07-11T08:01:00.000Z',
    revertible_until: '2026-07-11T08:16:00.000Z',
    can_revert: true,
    actor_display_name: '小明',
    summary: {
      title: '本次购买已登记',
      description: '完成 2 项',
      confirmed_count: 0,
      adjusted_count: 0,
      completed_count: 2,
      partial_count: 0,
    },
    ...overrides,
  };
}

const detail: InventoryOperationDetail = {
  ...makeSummary(),
  lines: [
    {
      sequence: 1,
      entity_type: 'inventory_item',
      change_type: 'create',
      title: '牛奶',
      description: '新增 6 盒',
    },
    {
      sequence: 2,
      entity_type: 'shopping_list_item',
      change_type: 'update',
      title: '牛奶采购项',
      description: '标记为已买',
    },
  ],
};

function renderDialog(
  props: Partial<Parameters<typeof InventoryOperationHistoryDialog>[0]> = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const operations = props.operations ?? [
    makeSummary(),
    makeSummary({
      operation_id: 'op-2',
      operation_type: 'reconciliation',
      actor_display_name: '小红',
      summary: {
        title: '本次盘点已完成',
        description: '确认 1 项',
        confirmed_count: 1,
        adjusted_count: 0,
        completed_count: 1,
        partial_count: 0,
      },
      can_revert: false,
    }),
  ];
  const defaults: Parameters<typeof InventoryOperationHistoryDialog>[0] = {
    open: true,
    operations,
    loading: false,
    busy: false,
    errorMessage: null,
    selectedOperationId: 'op-1',
    detail,
    detailLoading: false,
    detailError: null,
    conflictMessage: null,
    now: () => Date.parse('2026-07-11T08:05:00.000Z'),
    onClose: vi.fn(),
    onSelectOperation: vi.fn(),
    onLoadDetail: vi.fn(),
    onRevert: vi.fn(),
    onRetry: vi.fn(),
    ...props,
  };
  act(() => {
    root!.render(<InventoryOperationHistoryDialog {...defaults} />);
  });
  return defaults;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('InventoryOperationHistoryDialog', () => {
  it('renders newest 20 list and expands detail lines', () => {
    const many = Array.from({ length: 22 }, (_, index) =>
      makeSummary({
        operation_id: `op-${index + 1}`,
        summary: {
          title: `操作 ${index + 1}`,
          description: `描述 ${index + 1}`,
          confirmed_count: 0,
          adjusted_count: 0,
          completed_count: 1,
          partial_count: 0,
        },
      }),
    );
    renderDialog({
      operations: many,
      selectedOperationId: 'op-1',
      detail: {
        ...detail,
        operation_id: 'op-1',
        summary: many[0].summary,
      },
    });
    expect(container!.textContent).toContain('最近 20 次');
    expect(container!.textContent).toContain('操作 1');
    expect(container!.textContent).toContain('操作 20');
    expect(container!.textContent).not.toContain('操作 22');
    expect(container!.textContent).toContain('新增 · 牛奶');
    expect(container!.textContent).toContain('新增 6 盒');
    expect(container!.textContent).toContain('更新 · 牛奶采购项');
  });

  it('shows Member/Owner can_revert from server and requires explicit confirmation', () => {
    const props = renderDialog({
      operations: [
        makeSummary({ can_revert: true, actor_display_name: '我自己' }),
        makeSummary({
          operation_id: 'op-other',
          can_revert: false,
          actor_display_name: '其他成员',
          summary: {
            title: '家人盘点',
            description: '确认 1 项',
            confirmed_count: 1,
            adjusted_count: 0,
            completed_count: 1,
            partial_count: 0,
          },
        }),
      ],
      selectedOperationId: 'op-1',
    });
    expect(container!.textContent).toContain('撤销本次操作');
    const revert = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('撤销本次操作'),
    );
    act(() => {
      revert!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onRevert).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('确认撤销整次操作');
    expect(container!.textContent).toContain('回退这次操作涉及的全部变更');

    const confirm = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认撤销整次操作'),
    );
    act(() => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onRevert).toHaveBeenCalledWith('op-1');
  });

  it('hides revert for ineligible operations and keeps conflict notice open', () => {
    const props = renderDialog({
      operations: [
        makeSummary({
          can_revert: false,
          status: 'reverted',
          summary: {
            title: '本次购买已登记',
            description: '已撤销',
            confirmed_count: 0,
            adjusted_count: 0,
            completed_count: 2,
            partial_count: 0,
          },
        }),
      ],
      selectedOperationId: 'op-1',
      detail: {
        ...detail,
        status: 'reverted',
        can_revert: false,
      },
      conflictMessage: '撤销窗口已过，无法撤销本次操作',
    });
    expect(container!.textContent).toContain('已撤销');
    const revertButtons = Array.from(container!.querySelectorAll('button')).filter((button) =>
      button.textContent === '撤销本次操作' || button.textContent === '确认撤销整次操作',
    );
    expect(revertButtons).toHaveLength(0);
    expect(container!.textContent).toContain('暂时无法撤销');
    expect(container!.textContent).toContain('撤销窗口已过');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('loads selected detail and supports immediate result undo path', () => {
    const props = renderDialog({
      selectedOperationId: null,
      detail: null,
      initialOperationId: 'op-1',
    });
    expect(props.onSelectOperation).toHaveBeenCalledWith('op-1');
    expect(props.onLoadDetail).toHaveBeenCalledWith('op-1');

    const second = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('本次盘点已完成'),
    );
    act(() => {
      second!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onSelectOperation).toHaveBeenCalledWith('op-2');
    expect(props.onLoadDetail).toHaveBeenCalledWith('op-2');
  });

  it('renders loading empty and error states', () => {
    renderDialog({ loading: true, operations: [] });
    expect(container!.textContent).toContain('正在加载操作历史');

    act(() => root?.unmount());
    container?.remove();
    renderDialog({ loading: false, operations: [], selectedOperationId: null, detail: null });
    expect(container!.textContent).toContain('还没有可查看的操作');

    act(() => root?.unmount());
    container?.remove();
    renderDialog({
      errorMessage: '读取操作历史失败',
      detailError: '详情加载失败',
    });
    expect(container!.textContent).toContain('读取操作历史失败');
    expect(container!.textContent).toContain('详情加载失败');
  });
});
