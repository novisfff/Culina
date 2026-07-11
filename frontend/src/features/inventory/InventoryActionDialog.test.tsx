// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type { VersionedInventoryItemRef } from '../../api/types';
import type { ExpiryInventoryActionGroup, InventoryActionBatch } from './inventoryActionModel';
import { InventoryActionDialog } from './InventoryActionDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const REFERENCE_DATE = '2026-07-11';

function batch(overrides: Partial<InventoryActionBatch> & Pick<InventoryActionBatch, 'inventoryItemId' | 'daysLeft' | 'expiryDate'>): InventoryActionBatch {
  return {
    inventoryItemId: overrides.inventoryItemId,
    rowVersion: overrides.rowVersion ?? 1,
    remainingQuantity: overrides.remainingQuantity ?? 1,
    unit: overrides.unit ?? '个',
    storageLocation: overrides.storageLocation ?? '冷藏',
    purchaseDate: overrides.purchaseDate ?? '2026-07-01',
    expiryDate: overrides.expiryDate,
    daysLeft: overrides.daysLeft,
    expiryAlertSnoozedUntil: overrides.expiryAlertSnoozedUntil ?? null,
    expiryReviewedAt: overrides.expiryReviewedAt ?? null,
    expiryReviewedBy: overrides.expiryReviewedBy ?? null,
  };
}

const mixedGroup: ExpiryInventoryActionGroup = {
  kind: 'expiry',
  id: 'expiry:ingredient-tomato',
  ingredientId: 'ingredient-tomato',
  ingredientName: '番茄',
  severity: 'expired',
  batches: [
    batch({
      inventoryItemId: 'expired-a',
      daysLeft: -2,
      expiryDate: '2026-07-09',
      remainingQuantity: 2,
      unit: '盒',
      expiryReviewedAt: '2026-07-08T10:00:00Z',
      expiryReviewedBy: 'user-linran',
      expiryAlertSnoozedUntil: '2026-07-10',
    }),
    batch({
      inventoryItemId: 'expired-b',
      daysLeft: -1,
      expiryDate: '2026-07-10',
      remainingQuantity: 1,
      unit: '盒',
    }),
    batch({
      inventoryItemId: 'upcoming-a',
      daysLeft: 2,
      expiryDate: '2026-07-13',
      remainingQuantity: 500,
      unit: '克',
    }),
    batch({
      inventoryItemId: 'upcoming-b',
      daysLeft: 5,
      expiryDate: '2026-07-16',
      remainingQuantity: 1,
      unit: '袋',
    }),
  ],
  expiredBatchCount: 2,
  todayBatchCount: 0,
  soonBatchCount: 1,
  laterBatchCount: 1,
  totalBatchCount: 4,
  quantityLabels: ['3 盒', '500 克', '1 袋'],
  storageLocations: ['冷藏'],
  earliestExpiryDate: '2026-07-09',
  earliestDaysLeft: -2,
  title: '番茄需要处理',
  detail: '2 批已过期，1 批 3 天内到期，1 批 7 天内到期',
  primaryAction: 'manage_expiry',
};

const upcomingOnlyGroup: ExpiryInventoryActionGroup = {
  ...mixedGroup,
  id: 'expiry:ingredient-milk',
  ingredientId: 'ingredient-milk',
  ingredientName: '牛奶',
  severity: 'expires_soon',
  batches: [
    batch({
      inventoryItemId: 'milk-a',
      daysLeft: 1,
      expiryDate: '2026-07-12',
      remainingQuantity: 2,
      unit: '盒',
    }),
    batch({
      inventoryItemId: 'milk-b',
      daysLeft: 3,
      expiryDate: '2026-07-14',
      remainingQuantity: 1,
      unit: '盒',
    }),
  ],
  expiredBatchCount: 0,
  todayBatchCount: 0,
  soonBatchCount: 2,
  laterBatchCount: 0,
  totalBatchCount: 2,
  quantityLabels: ['3 盒'],
  earliestExpiryDate: '2026-07-12',
  earliestDaysLeft: 1,
  title: '牛奶需要处理',
  detail: '2 批 3 天内到期',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

type RenderOptions = {
  group?: ExpiryInventoryActionGroup;
  busy?: boolean;
  errorMessage?: string | null;
  conflictState?: 'none' | 'review_again';
  onDispose?: (items: VersionedInventoryItemRef[]) => Promise<void>;
  onSnooze?: (args: {
    action: 'retain_expired' | 'snooze_upcoming';
    items: VersionedInventoryItemRef[];
    snoozedUntil: string;
  }) => Promise<void>;
  onCorrectExpiry?: (args: {
    inventoryItemId: string;
    expectedRowVersion: number;
    expiryDate: string;
  }) => Promise<void>;
};

function renderDialog(options: RenderOptions = {}) {
  const onClose = vi.fn();
  const onDispose = options.onDispose ?? vi.fn(async () => undefined);
  const onSnooze = options.onSnooze ?? vi.fn(async () => undefined);
  const onCorrectExpiry = options.onCorrectExpiry ?? vi.fn(async () => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <InventoryActionDialog
        open
        group={options.group ?? mixedGroup}
        referenceDate={REFERENCE_DATE}
        busy={options.busy ?? false}
        errorMessage={options.errorMessage ?? null}
        conflictState={options.conflictState ?? 'none'}
        onClose={onClose}
        onDispose={onDispose}
        onSnooze={onSnooze}
        onCorrectExpiry={onCorrectExpiry}
      />,
    );
  });
  return { onClose, onDispose, onSnooze, onCorrectExpiry, view: container };
}

function selectedIds(view: HTMLElement) {
  return [...view.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .filter((input) => input.checked && !input.disabled)
    .map((input) => input.value)
    .sort();
}


function setInputValue(input: HTMLInputElement, value: string) {
  const prototype = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  prototype?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function clickButton(view: HTMLElement, label: string) {
  const button = [...view.querySelectorAll('button')].find((node) => node.textContent?.includes(label));
  expect(button, `button "${label}"`).toBeTruthy();
  act(() => button?.click());
  return button as HTMLButtonElement;
}

describe('InventoryActionDialog', () => {
  it('separates expired and upcoming batches and defaults to expired selection', () => {
    const { view } = renderDialog();

    expect(view.textContent).toContain('已过期批次');
    expect(view.textContent).toContain('即将到期批次');
    expect(selectedIds(view)).toEqual(['expired-a', 'expired-b']);
  });

  it('selects all upcoming rows when the group has no expired batches', () => {
    const { view } = renderDialog({ group: upcomingOnlyGroup });
    expect(selectedIds(view)).toEqual(['milk-a', 'milk-b']);
  });

  it('resets selection when switching disposal, temporary retention, and future snooze', () => {
    const { view } = renderDialog();

    clickButton(view, '销毁所选批次');
    expect(selectedIds(view)).toEqual(['expired-a', 'expired-b']);

    clickButton(view, '暂时保留');
    expect(selectedIds(view)).toEqual(['expired-a', 'expired-b']);

    clickButton(view, '稍后提醒');
    expect(selectedIds(view)).toEqual(['upcoming-a', 'upcoming-b']);

    clickButton(view, '销毁所选批次');
    expect(selectedIds(view)).toEqual(['expired-a', 'expired-b']);
  });

  it('blocks selecting unexpired rows for disposal and temporary retention', () => {
    const { view } = renderDialog();

    clickButton(view, '销毁所选批次');
    const upcomingCheckbox = view.querySelector<HTMLInputElement>('input[value="upcoming-a"]');
    expect(upcomingCheckbox?.disabled).toBe(true);

    clickButton(view, '暂时保留');
    expect(view.querySelector<HTMLInputElement>('input[value="upcoming-a"]')?.disabled).toBe(true);
  });

  it('blocks selecting expired rows for future snooze', () => {
    const { view } = renderDialog();
    clickButton(view, '稍后提醒');
    expect(view.querySelector<HTMLInputElement>('input[value="expired-a"]')?.disabled).toBe(true);
    expect(selectedIds(view)).toEqual(['upcoming-a', 'upcoming-b']);
  });

  it('edits exactly one row for date correction and submits its row version', async () => {
    const onCorrectExpiry = vi.fn(async () => undefined);
    const { view } = renderDialog({ onCorrectExpiry });

    const correctButtons = [...view.querySelectorAll('button')].filter((node) =>
      node.textContent?.includes('日期录错了'),
    );
    expect(correctButtons).toHaveLength(4);
    act(() => correctButtons[0]?.click());

    expect(view.textContent).toContain('更正到期日');
    const dateInput = view.querySelector<HTMLInputElement>('input[type="date"][name="corrected-expiry-date"]');
    expect(dateInput).not.toBeNull();
    act(() => {
      if (!dateInput) return;
      setInputValue(dateInput, '2026-07-20');
    });

    await act(async () => {
      clickButton(view, '保存更正');
    });

    expect(onCorrectExpiry).toHaveBeenCalledWith({
      inventoryItemId: 'expired-a',
      expectedRowVersion: 1,
      expiryDate: '2026-07-20',
    });
  });

  it('shows disposal confirmation with ingredient, batch count, and summed quantities by unit', async () => {
    const onDispose = vi.fn(async () => undefined);
    const { view } = renderDialog({ onDispose });

    clickButton(view, '销毁所选批次');
    clickButton(view, '销毁所选批次');

    expect(view.textContent).toContain('确认销毁');
    expect(view.textContent).toContain('番茄');
    expect(view.textContent).toMatch(/2\s*个批次|2\s*批/);
    const footer = view.querySelector('.inventory-action-footer-summary');
    expect(footer?.textContent).toContain('3 盒');
    expect(footer?.textContent).not.toContain('500 克');
    expect(view.querySelector('.inventory-action-batch-section')?.textContent).not.toContain('即将到期批次');
    expect(view.querySelector('.inventory-action-batch-list')?.textContent ?? '').not.toContain('500 克');

    await act(async () => {
      clickButton(view, '确认销毁');
    });

    expect(onDispose).toHaveBeenCalledWith([
      { inventory_item_id: 'expired-a', expected_row_version: 1 },
      { inventory_item_id: 'expired-b', expected_row_version: 1 },
    ]);
  });

  it('offers tomorrow, three-days-later, and custom reminder presets with UTC-safe bounds', async () => {
    const onSnooze = vi.fn(async () => undefined);
    const { view } = renderDialog({ onSnooze });

    clickButton(view, '暂时保留');
    expect(view.textContent).toContain('明天');
    expect(view.textContent).toContain('3 天后');
    expect(view.textContent).toContain('自定义日期');
    expect(view.textContent).toContain('原到期日');

    const customInput = view.querySelector<HTMLInputElement>('input[type="date"][name="custom-snooze-date"]');
    expect(customInput?.min).toBe('2026-07-12');
    expect(customInput?.max).toBe('2026-08-10');

    await act(async () => {
      clickButton(view, '明天');
      clickButton(view, '确认暂时保留');
    });

    expect(onSnooze).toHaveBeenCalledWith({
      action: 'retain_expired',
      items: [
        { inventory_item_id: 'expired-a', expected_row_version: 1 },
        { inventory_item_id: 'expired-b', expected_row_version: 1 },
      ],
      snoozedUntil: '2026-07-12',
    });
  });

  it('enforces custom date bounds before submission', async () => {
    const onSnooze = vi.fn(async () => undefined);
    const { view } = renderDialog({ onSnooze });

    clickButton(view, '暂时保留');
    clickButton(view, '自定义日期');
    const customInput = view.querySelector<HTMLInputElement>('input[type="date"][name="custom-snooze-date"]');
    expect(customInput).not.toBeNull();

    act(() => {
      if (!customInput) return;
      setInputValue(customInput, REFERENCE_DATE);
    });

    await act(async () => {
      clickButton(view, '确认暂时保留');
    });
    expect(onSnooze).not.toHaveBeenCalled();

    act(() => {
      if (!customInput) return;
      setInputValue(customInput, '2026-08-11');
    });
    await act(async () => {
      clickButton(view, '确认暂时保留');
    });
    expect(onSnooze).not.toHaveBeenCalled();

    act(() => {
      if (!customInput) return;
      setInputValue(customInput, '2026-07-20');
    });
    await act(async () => {
      clickButton(view, '确认暂时保留');
    });
    expect(onSnooze).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'retain_expired',
        snoozedUntil: '2026-07-20',
      }),
    );
  });

  it('keeps unlike units separate in selection summary', () => {
    const { view } = renderDialog();
    clickButton(view, '稍后提醒');
    expect(view.textContent).toContain('500 克');
    expect(view.textContent).toContain('1 袋');
    expect(view.textContent).not.toMatch(/501/);
  });

  it('shows neutral prior review copy without raw reviewer IDs', () => {
    const { view } = renderDialog();
    expect(view.textContent).toContain('此前已确认暂时保留');
    expect(view.textContent).toMatch(/再次提醒|原到期日/);
    expect(view.textContent).not.toContain('user-linran');
  });

  it('keeps the dialog open and shows conflict/review-again state after ApiError 409', async () => {
    const onDispose = vi.fn(async () => {
      throw new ApiError({
        status: 409,
        detail: '库存状态已变化',
        path: '/api/inventory/dispose-expired',
        payload: { detail: '库存状态已变化' },
      });
    });
    const { onClose, view } = renderDialog({
      onDispose,
      conflictState: 'review_again',
      errorMessage: '家人刚刚改动了这批库存，请重新确认后再提交。',
    });

    expect(view.textContent).toContain('重新确认');
    expect(view.textContent).toContain('家人刚刚改动了这批库存');
    expect(view.querySelector('.workspace-overlay-root')).not.toBeNull();

    clickButton(view, '销毁所选批次');
    clickButton(view, '销毁所选批次');
    await act(async () => {
      clickButton(view, '确认销毁');
    });

    expect(onDispose).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.querySelector('.workspace-overlay-root')).not.toBeNull();
  });

  it('disables close and duplicate submission while busy without trapping focus', () => {
    const { onClose, view } = renderDialog({ busy: true });

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(onClose).not.toHaveBeenCalled();
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.disabled).toBe(true);
    expect(view.querySelector('[aria-modal="true"][data-focus-trap="true"]')).toBeNull();
    expect(document.activeElement === document.body || view.contains(document.activeElement)).toBe(true);
  });
});
