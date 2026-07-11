// @vitest-environment jsdom

import { act, type FormEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ingredient } from '../../api/types';
import type { DisposableExpiredInventoryItemViewModel, IngredientSummaryViewModel } from './workspaceModel';
import { DestroyExpiredInventoryDialog } from './IngredientDestroyExpiredOverlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const ingredient: Ingredient = {
  id: 'ingredient-tomato',
  family_id: 'family-1',
  name: '番茄',
  category: '蔬菜',
  default_unit: '个',
  unit_conversions: [],
  default_storage: '冷藏',
  default_expiry_mode: 'days',
  default_expiry_days: 3,
  default_low_stock_threshold: 1,
  notes: '',
  image: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const summary: IngredientSummaryViewModel = {
  ingredient,
  inventoryItems: [],
  availableInventoryItems: [],
  alerts: [],
  quantitySummaries: [{ unit: '个', total: 2, label: '2个' }],
  hasMultipleUnits: false,
  primaryStorage: '冷藏',
  storageLocations: ['冷藏'],
  recipeReferences: [],
  latestPurchaseDate: '2026-06-25',
  latestUpdatedAt: '2026-07-01T00:00:00Z',
};

const item: DisposableExpiredInventoryItemViewModel = {
  id: 'inventory-expired-1',
  ingredientId: 'ingredient-tomato',
  ingredientName: '番茄',
  remainingQuantity: 2,
  remainingLabel: '2个',
  unit: '个',
  purchaseDate: '2026-06-20',
  expiryDate: '2026-06-25',
  storageLocation: '冷藏',
  notes: '表面变软',
  status: 'expiring',
  createdAt: '2026-06-20T00:00:00Z',
  rowVersion: 5,
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderDialog(
  items: DisposableExpiredInventoryItemViewModel[] = [item],
  options: { isSubmitting?: boolean } = {},
) {
  const closeOverlay = vi.fn();
  const submit = vi.fn(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <DestroyExpiredInventoryDialog
        closeOverlay={closeOverlay}
        summary={summary}
        meta={['蔬菜', '默认 个', '冷藏']}
        items={items}
        headline="2个"
        submit={submit}
        isSubmitting={options.isSubmitting}
        formId="test-destroy-expired-form"
        overlayRootClassName="home-dashboard-overlay-root"
        listTitle="将要销毁的批次"
        listDescription="只列出已经过期且当前仍有剩余量的批次。"
      />,
    );
  });
  return { closeOverlay, submit, view: container };
}

describe('DestroyExpiredInventoryDialog', () => {
  it('renders the shared disposal content and submits through the provided form id', async () => {
    const { submit, view } = renderDialog();

    expect(view.textContent).toContain('销毁已过期批次');
    expect(view.textContent).toContain('番茄');
    expect(view.textContent).toContain('2个');
    expect(view.querySelector('.destroy-expired-row')).not.toBeNull();
    expect(view.querySelector('.destroy-expired-row-main')?.textContent).toContain('2个');
    expect(view.querySelector('.destroy-expired-row-meta')?.textContent).toContain('到期');
    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.getAttribute('form')).toBe('test-destroy-expired-form');

    await act(async () => {
      view.querySelector<HTMLFormElement>('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('disables submit and shows the empty state when there are no disposable batches', () => {
    const { view } = renderDialog([]);

    expect(view.textContent).toContain('当前没有可销毁的批次');
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.disabled).toBe(true);
  });

  it('keeps the dialog open while disposal is submitting', () => {
    const { closeOverlay, view } = renderDialog([item], { isSubmitting: true });

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(closeOverlay).not.toHaveBeenCalled();
  });
});
