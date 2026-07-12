// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShoppingIntakeResult } from '../../api/types';
import { ShoppingIntakeDialog } from './ShoppingIntakeDialog';
import type { ShoppingIntakeDraft, ShoppingIntakeDraftItem } from './shoppingIntakeModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const exactItem: ShoppingIntakeDraftItem = {
  kind: 'exact_ingredient',
  shoppingItemId: 's-milk',
  expectedShoppingItemRowVersion: 1,
  title: '牛奶',
  selected: true,
  targetId: 'ing-milk',
  expectedIngredientRowVersion: 1,
  actualQuantity: '6',
  unit: '盒',
  inventoryStatus: 'fresh',
  expiryDate: '2026-07-16',
  storageLocation: '冷藏',
  notes: '',
  plannedQuantity: 6,
  plannedUnit: '盒',
  requiresManualExpiry: false,
};

const freeTextItem: ShoppingIntakeDraftItem = {
  kind: 'free_text',
  shoppingItemId: 's-paper',
  expectedShoppingItemRowVersion: 1,
  title: '厨房纸',
  selected: false,
  plannedQuantity: 1,
  plannedUnit: '卷',
  resolution: 'unresolved',
};

const presenceItem: ShoppingIntakeDraftItem = {
  kind: 'presence_ingredient',
  shoppingItemId: 's-salt',
  expectedShoppingItemRowVersion: 1,
  title: '盐',
  selected: true,
  targetId: 'ing-salt',
  expectedIngredientRowVersion: 1,
  stateId: null,
  expectedStateRowVersion: null,
  resultingAvailabilityLevel: 'sufficient',
  inventoryStatus: 'fresh',
  expiryDate: null,
  storageLocation: '常温',
  notes: '',
  requiresManualExpiry: false,
};

function makeDraft(items: ShoppingIntakeDraftItem[]): ShoppingIntakeDraft {
  return {
    clientRequestId: 'client-1',
    purchaseDate: '2026-07-11',
    createdAt: '2026-07-11T08:00:00.000Z',
    items,
  };
}

const result: ShoppingIntakeResult = {
  operation_id: 'op-1',
  operation_type: 'shopping_intake',
  status: 'applied',
  applied_at: '2026-07-12T08:01:00.000Z',
  // Keep revertible window in the future relative to the suite wall clock.
  revertible_until: '2099-07-12T08:16:00.000Z',
  can_revert: true,
  summary: {
    title: '本次购买已登记',
    description: '完成 2 项，部分买到 0 项',
    confirmed_count: 0,
    adjusted_count: 0,
    completed_count: 2,
    partial_count: 0,
  },
  items: [
    {
      shopping_item_id: 's-milk',
      result: 'completed',
      remaining_planned_quantity: null,
      inventory_item_id: 'inv-1',
      state_id: null,
      food_id: null,
    },
  ],
};

function renderDialog(props: Partial<Parameters<typeof ShoppingIntakeDialog>[0]> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const defaults: Parameters<typeof ShoppingIntakeDialog>[0] = {
    open: true,
    step: 'select',
    draft: makeDraft([exactItem, freeTextItem, presenceItem]),
    busy: false,
    errorMessage: null,
    fieldErrors: [],
    conflictState: 'none',
    result: null,
    expandedExceptionIds: [],
    onClose: vi.fn(),
    onGoReview: vi.fn(),
    onGoSelect: vi.fn(),
    onToggleItem: vi.fn(),
    onPatchItem: vi.fn(),
    onCompleteFreeText: vi.fn(),
    onLinkFreeText: vi.fn(),
    onToggleException: vi.fn(),
    onSubmit: vi.fn(),
    ...props,
  };
  act(() => {
    root!.render(<ShoppingIntakeDialog {...defaults} />);
  });
  return defaults;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ShoppingIntakeDialog', () => {
  it('renders select step with explicit multi-select and free-text actions', () => {
    const props = renderDialog();
    expect(container!.textContent).toContain('选择本次买到的项目');
    expect(container!.textContent).toContain('牛奶');
    expect(container!.textContent).toContain('厨房纸');
    expect(container!.textContent).toContain('仅标记已买');

    const checkboxes = container!.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBeGreaterThanOrEqual(3);

    const milkCheckbox = Array.from(checkboxes).find((node) =>
      node.parentElement?.textContent?.includes('牛奶'),
    ) as HTMLInputElement;
    expect(milkCheckbox.checked).toBe(true);

    act(() => {
      milkCheckbox.click();
    });
    expect(props.onToggleItem).toHaveBeenCalledWith('s-milk');
  });

  it('lets free text explicitly search and link a non-exact existing profile', () => {
    const handwrittenEggs: ShoppingIntakeDraftItem = {
      ...freeTextItem,
      shoppingItemId: 's-eggs',
      title: '鸡蛋（手写）',
      selected: true,
      plannedQuantity: 6,
      plannedUnit: '个',
    };
    const candidate = {
      kind: 'ingredient' as const,
      id: 'ing-eggs',
      name: '鸡蛋',
      quantityTrackingMode: 'track_quantity' as const,
    };
    const props = renderDialog({
      draft: makeDraft([handwrittenEggs]),
      freeTextCandidatesByItemId: { 's-eggs': [] },
      freeTextLinkOptions: [candidate],
    });

    const openSearch = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '搜索其他档案',
    );
    expect(openSearch).toBeTruthy();
    act(() => {
      openSearch!.click();
    });

    const searchInput = container!.querySelector(
      'input[aria-label="鸡蛋（手写）关联档案"]',
    ) as HTMLInputElement | null;
    expect(searchInput).toBeTruthy();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(searchInput, '鸡蛋');
      searchInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const eggOption = Array.from(container!.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (button) => button.textContent?.includes('鸡蛋'),
    );
    expect(eggOption).toBeTruthy();
    act(() => {
      eggOption!.click();
    });
    expect(props.onLinkFreeText).toHaveBeenCalledWith('s-eggs', candidate);
  });

  it('shows but prevents an incompatible Food unit from being linked', () => {
    const handwrittenEggs: ShoppingIntakeDraftItem = {
      ...freeTextItem,
      shoppingItemId: 's-eggs',
      title: '鸡蛋（手写）',
      selected: true,
      plannedQuantity: 6,
      plannedUnit: '个',
    };
    const foodCandidate = {
      kind: 'food' as const,
      id: 'food-braised-eggs',
      name: '卤蛋',
      stockUnit: '份',
    };
    const props = renderDialog({
      draft: makeDraft([handwrittenEggs]),
      freeTextLinkOptions: [foodCandidate],
    });

    const openSearch = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '搜索其他档案',
    );
    act(() => {
      openSearch!.click();
    });
    const searchInput = container!.querySelector(
      'input[aria-label="鸡蛋（手写）关联档案"]',
    ) as HTMLInputElement;
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(searchInput, '卤蛋');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const foodOption = Array.from(container!.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (button) => button.textContent?.includes('卤蛋'),
    );
    expect(foodOption?.disabled).toBe(true);
    expect(container!.textContent).toContain('请先调整采购计划单位');
    act(() => {
      foodOption!.click();
    });
    expect(props.onLinkFreeText).not.toHaveBeenCalled();
  });

  it('renders review step exceptions and submit controls', () => {
    const partialExact: ShoppingIntakeDraftItem = {
      ...exactItem,
      actualQuantity: '2',
    };
    const props = renderDialog({
      step: 'review',
      draft: makeDraft([partialExact, presenceItem]),
      expandedExceptionIds: ['s-milk'],
    });

    expect(container!.textContent).toContain('核对实际数量与例外');
    expect(container!.textContent).toContain('差异与例外');
    expect(container!.textContent).toContain('入库 2 盒，还差 4 盒');
    // Default-sufficient presence rows remain reviewable.
    expect(container!.textContent).toContain('盐');
    expect(container!.textContent).toContain('默认充足');
    expect(container!.textContent).toContain('确认入库');

    const submit = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认入库'),
    );
    expect(submit).toBeTruthy();
    act(() => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onSubmit).toHaveBeenCalled();
  });

  it('lets a default planned row enter exception editing', () => {
    const props = renderDialog({
      step: 'review',
      draft: makeDraft([exactItem]),
    });

    const adjustButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '调整',
    );
    expect(adjustButton).toBeTruthy();

    act(() => {
      adjustButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onToggleException).toHaveBeenCalledWith('s-milk');
  });

  it('renders the quantity editor for an expanded default planned row', () => {
    const props = renderDialog({
      step: 'review',
      draft: makeDraft([exactItem]),
      expandedExceptionIds: ['s-milk'],
    });

    const quantityInput = container!.querySelector(
      'input[data-field-key="s-milk:actualQuantity"]',
    ) as HTMLInputElement | null;
    expect(quantityInput).toBeTruthy();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(quantityInput, '2');
      quantityInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(props.onPatchItem).toHaveBeenCalledWith('s-milk', { actualQuantity: '2' });
  });

  it('presence default is editable on review after expand', () => {
    const props = renderDialog({
      step: 'review',
      draft: makeDraft([presenceItem]),
      expandedExceptionIds: ['s-salt'],
    });

    expect(container!.textContent).toContain('默认充足');
    expect(container!.textContent).toContain('买到后状态');
    expect(container!.textContent).toContain('充足');
    expect(container!.textContent).toContain('还在');
    expect(container!.textContent).toContain('少量');

    const lowChip = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('少量'),
    );
    expect(lowChip).toBeTruthy();
    act(() => {
      lowChip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(props.onPatchItem).toHaveBeenCalledWith(
      's-salt',
      expect.objectContaining({ resultingAvailabilityLevel: 'low' }),
    );
  });

  it('focuses real quantity input via data-field-key', () => {
    renderDialog({
      step: 'review',
      draft: makeDraft([{ ...exactItem, actualQuantity: '0' }]),
      focusFieldKey: 's-milk:actualQuantity',
      expandedExceptionIds: ['s-milk'],
      fieldErrors: [
        {
          shoppingItemId: 's-milk',
          field: 'actualQuantity',
          code: 'invalid_quantity',
          message: '数量为 0',
        },
      ],
    });

    const quantityInput = container!.querySelector(
      'input[data-field-key="s-milk:actualQuantity"]',
    ) as HTMLInputElement | null;
    expect(quantityInput).toBeTruthy();
    expect(quantityInput!.type).toBe('number');
    expect(document.activeElement).toBe(quantityInput);
  });

  it('renders and focuses a structured unit error on the unit control', () => {
    renderDialog({
      step: 'review',
      draft: makeDraft([exactItem]),
      focusFieldKey: 's-milk:unit',
      expandedExceptionIds: ['s-milk'],
      fieldErrors: [
        {
          shoppingItemId: 's-milk',
          field: 'unit',
          code: 'incompatible_unit',
          message: '当前食物库存单位是 份，不能按 盒 入库',
        },
      ],
    });

    const unitTrigger = container!.querySelector(
      'button[data-field-key="s-milk:unit"]',
    ) as HTMLButtonElement | null;
    expect(unitTrigger).toBeTruthy();
    expect(container!.textContent).toContain('当前食物库存单位是 份，不能按 盒 入库');
    expect(document.activeElement).toBe(unitTrigger);
  });

  it('renders a structured storage-location error beside the editable field', () => {
    renderDialog({
      step: 'review',
      draft: makeDraft([presenceItem]),
      focusFieldKey: 's-salt:storageLocation',
      expandedExceptionIds: ['s-salt'],
      fieldErrors: [
        {
          shoppingItemId: 's-salt',
          field: 'storageLocation',
          code: 'invalid_target',
          message: '存放位置不能为空',
        },
      ],
    });

    const storageInput = container!.querySelector(
      'input[data-field-key="s-salt:storageLocation"]',
    ) as HTMLInputElement | null;
    expect(storageInput).toBeTruthy();
    expect(container!.textContent).toContain('存放位置不能为空');
    expect(document.activeElement).toBe(storageInput);
  });

  it('renders result with applied/partial counts and revertible_until', () => {
    renderDialog({
      step: 'result',
      draft: makeDraft([exactItem]),
      result,
    });
    expect(container!.textContent).toContain('本次购买已登记');
    expect(container!.textContent).toContain('完成');
    expect(container!.textContent).toContain('部分');
    expect(container!.textContent).toMatch(/可在/);
    expect(container!.querySelector('[aria-live]')).toBeTruthy();
    expect(container!.textContent).toContain('牛奶');
    expect(container!.textContent).not.toContain('s-milk');
  });

  it('shows loading, empty, field-error, conflict, and busy states', () => {
    renderDialog({
      loading: true,
      draft: null,
    });
    expect(container!.textContent).toContain('正在准备采购项');

    act(() => root?.unmount());
    container?.remove();
    renderDialog({
      draft: makeDraft([]),
    });
    expect(container!.textContent).toContain('没有待买项目');

    act(() => root?.unmount());
    container?.remove();
    renderDialog({
      step: 'review',
      draft: makeDraft([{ ...exactItem, actualQuantity: '0' }]),
      errorMessage: '还有 1 处需要确认后才能入库。',
      fieldErrors: [
        {
          shoppingItemId: 's-milk',
          field: 'actualQuantity',
          code: 'invalid_quantity',
          message: '数量为 0',
        },
      ],
      focusFieldKey: 's-milk:actualQuantity',
      expandedExceptionIds: ['s-milk'],
    });
    expect(container!.textContent).toContain('还有 1 处需要确认');
    expect(container!.querySelector('[role="alert"]')).toBeTruthy();

    act(() => root?.unmount());
    container?.remove();
    const conflictProps = renderDialog({
      step: 'review',
      draft: makeDraft([exactItem]),
      conflictState: 'stale_version',
      errorMessage: '采购项已被家人更新',
      onRetry: vi.fn(),
    });
    expect(container!.textContent).toContain('需要重新确认');
    expect(container!.textContent).toContain('采购项已被家人更新');

    act(() => root?.unmount());
    container?.remove();
    renderDialog({
      step: 'review',
      draft: makeDraft([exactItem]),
      busy: true,
    });
    const busySubmit = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('处理中'),
    );
    expect(busySubmit).toBeTruthy();
    expect((busySubmit as HTMLButtonElement).disabled).toBe(true);
    expect(conflictProps.onRetry).toBeTruthy();
  });

  it('puts a conflicted clean row first and requires a fresh confirmation', () => {
    const partialItem: ShoppingIntakeDraftItem = {
      ...exactItem,
      shoppingItemId: 's-other',
      title: '酸奶',
      actualQuantity: '2',
    };
    renderDialog({
      step: 'review',
      draft: makeDraft([partialItem, exactItem]),
      conflictState: 'stale_version',
      errorMessage: '牛奶采购项已更新，请核对最新数量',
      fieldErrors: [
        {
          shoppingItemId: 's-milk',
          field: 'conflict',
          code: 'stale_version',
          message: '牛奶采购项已更新，请核对最新数量',
        },
      ],
      expandedExceptionIds: ['s-milk'],
      onRetry: vi.fn(),
    });

    const text = container!.textContent ?? '';
    expect(text.indexOf('牛奶')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('牛奶')).toBeLessThan(text.indexOf('酸奶'));
    expect(text).toContain('牛奶采购项已更新，请核对最新数量');
    expect(text).toContain('重新确认并提交');
  });

  it('does not call APIs itself — only callbacks', () => {
    // Structural guarantee: component props are callbacks only; no fetch/request imports.
    // Exercised by ensuring submit/close go through provided handlers.
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    renderDialog({
      step: 'review',
      draft: makeDraft([exactItem]),
      onSubmit,
      onClose,
    });
    const submit = Array.from(container!.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认入库'),
    );
    act(() => {
      submit!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('exposes aria-live region for errors and result', () => {
    renderDialog({
      step: 'result',
      draft: makeDraft([exactItem]),
      result,
    });
    const live = container!.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.textContent).toMatch(/可在|撤销/);
  });
});
