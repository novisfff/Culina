import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { AiInventoryIntakeApproval } from './AiInventoryIntakeApproval';
import type { InventoryIntakeDraft } from './aiInventoryIntakeDraftModel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function baseDraft(overrides: Record<string, unknown> = {}) {
  return {
    draftType: 'inventory_intake',
    schemaVersion: 'inventory_intake.v1',
    clientRequestId: 'ai-inventory-intake-ui',
    sourceType: 'receipt_image',
    sourceReference: { mediaId: 'media-1' },
    intakeDate: '2026-07-21',
    intakeDateSource: 'receipt',
    items: [
      {
        lineId: 'egg',
        sourceLineId: 'receipt-egg',
        sourceText: '鸡蛋 2个',
        sourceKind: 'shopping_item',
        action: 'stock_and_fulfill',
        shoppingItemId: 'shopping-egg',
        expectedShoppingItemRowVersion: 3,
        title: '鸡蛋',
        targetKind: 'exact_ingredient',
        targetId: 'ingredient-egg',
        expectedIngredientRowVersion: 7,
        plannedQuantity: '2',
        plannedUnit: '个',
        enteredQuantity: '2',
        enteredUnit: '个',
        packageConversion: null,
        storageLocation: '冷藏',
        expiryDate: '2026-07-28',
        inventoryStatus: 'fresh',
        notes: '',
        before: {},
      },
      {
        lineId: 'milk',
        sourceLineId: 'receipt-milk',
        sourceText: '牛奶 1盒',
        sourceKind: 'direct',
        action: 'stock_only',
        title: '牛奶',
        targetKind: 'food',
        targetId: 'food-milk',
        expectedFoodRowVersion: 2,
        enteredQuantity: '',
        enteredUnit: '盒',
        packageConversion: null,
        storageLocation: '冷藏',
        expiryDate: null,
        notes: '',
        before: {},
      },
    ],
    ignoredItems: [
      {
        sourceLineId: 'bags',
        sourceText: '垃圾袋 1个',
        displayName: '垃圾袋',
        reasonCode: 'non_inventory_item',
        reason: '非食品库存对象，本次不会入库',
      },
    ],
    summary: {},
    ...overrides,
  };
}

async function renderApproval(
  draft: Record<string, unknown>,
  onChange = vi.fn(),
  readonly = false,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AiInventoryIntakeApproval
        draft={draft}
        readonly={readonly}
        onChange={onChange}
      />,
    );
  });
  return { container, onChange };
}

describe('AiInventoryIntakeApproval', () => {
  it('renders grouped shopping direct and ignored sections without submit button', async () => {
    const { container: node } = await renderApproval(baseDraft());
    expect(node.querySelector('[aria-label="确认入库内容"]')).not.toBeNull();
    expect(node.textContent).toContain('采购清单关联');
    expect(node.textContent).toContain('直接入库');
    expect(node.textContent).toContain('已忽略');
    expect(node.textContent).toContain('鸡蛋');
    expect(node.textContent).toContain('牛奶');
    expect(node.textContent).toContain('垃圾袋');
    expect(node.textContent).toContain('只增加库存，不创建或完成采购项');
    expect(node.textContent).toContain('无需确认');
    expect(node.textContent).not.toMatch(/还需确认/);
    expect(node.querySelector('button[type="submit"]')).toBeNull();
    expect(Array.from(node.querySelectorAll('button')).some((button) => /确认入库|提交/.test(button.textContent || ''))).toBe(false);
  });

  it('starts incomplete rows expanded and complete rows collapsed', async () => {
    const { container: node } = await renderApproval(baseDraft());
    const eggToggle = Array.from(node.querySelectorAll('button[aria-expanded]'))
      .find((button) => button.textContent?.includes('鸡蛋')) as HTMLButtonElement;
    const milkToggle = Array.from(node.querySelectorAll('button[aria-expanded]'))
      .find((button) => button.textContent?.includes('牛奶')) as HTMLButtonElement;
    expect(eggToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(milkToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(node.querySelector('input[aria-label="牛奶实际入库数量"]')).not.toBeNull();
  });

  it('patches quantity through onChange while preserving protected identity', async () => {
    const onChange = vi.fn();
    const { container: node } = await renderApproval(baseDraft(), onChange);
    const milkToggle = Array.from(node.querySelectorAll('button[aria-expanded]'))
      .find((button) => button.textContent?.includes('牛奶')) as HTMLButtonElement;
    expect(milkToggle).toBeTruthy();

    const quantityInput = node.querySelector('input[aria-label="牛奶实际入库数量"]') as HTMLInputElement;
    expect(quantityInput).toBeTruthy();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(quantityInput, '1');
      quantityInput.dispatchEvent(new Event('input', { bubbles: true }));
      quantityInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)?.[0] as InventoryIntakeDraft;
    const milk = next.items.find((item) => item.lineId === 'milk');
    expect(milk?.enteredQuantity).toBe('1');
    expect(milk?.targetId).toBe('food-milk');
    expect(milk?.expectedFoodRowVersion).toBe(2);
    expect(milk?.sourceKind).toBe('direct');
  });

  it('keeps ignored rows read-only', async () => {
    const { container: node } = await renderApproval(baseDraft());
    const ignored = node.querySelector('.ai-inventory-intake-ignored');
    expect(ignored).not.toBeNull();
    expect(ignored?.querySelector('input, select, textarea')).toBeNull();
    expect(ignored?.textContent).toContain('非食品库存对象');
  });

  it('limits shopping rows to shopping-compatible actions', async () => {
    const incompleteShopping = baseDraft({
      items: [
        {
          lineId: 'egg',
          sourceLineId: 'receipt-egg',
          sourceText: '鸡蛋 2个',
          sourceKind: 'shopping_item',
          action: 'stock_and_fulfill',
          shoppingItemId: 'shopping-egg',
          expectedShoppingItemRowVersion: 3,
          title: '鸡蛋',
          targetKind: 'exact_ingredient',
          targetId: 'ingredient-egg',
          expectedIngredientRowVersion: 7,
          plannedQuantity: '2',
          plannedUnit: '个',
          enteredQuantity: '',
          enteredUnit: '个',
          storageLocation: '冷藏',
          notes: '',
          before: {},
        },
      ],
      ignoredItems: [],
    });
    const { container: node } = await renderApproval(incompleteShopping);
    const select = node.querySelector('select') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(['stock_and_fulfill', 'fulfill_without_stock', 'skip']);
    expect(values).not.toContain('stock_only');
  });
});
