// @vitest-environment jsdom

import type { FormEvent } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, Recipe } from '../../api/types';
import { FoodQuickMealDialog, type FoodQuickMealDialogState } from './FoodQuickMealDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function attachRoot() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  return container;
}

function buildFood(): Food {
  return {
    id: 'food-1',
    family_id: 'family-1',
    name: '番茄炒蛋',
    type: 'selfMade',
    category: '家常菜',
    flavor_tags: [],
    scene_tags: [],
    suitable_meal_types: ['dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '',
    stock_unit: '份',
    storage_location: '',
    favorite: false,
    recipe_id: 'recipe-1',
    row_version: 1,
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function buildRecipe(): Recipe {
  return {
    id: 'recipe-1',
    family_id: 'family-1',
    title: '番茄炒蛋',
    servings: 2,
    prep_minutes: 12,
    difficulty: 'easy',
    ingredient_items: [],
    steps: [],
    tips: '',
    scene_tags: [],
    images: [],
    cook_logs: [],
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderDialog(options: {
  dialog?: Partial<FoodQuickMealDialogState>;
  isSubmitting?: boolean;
} = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
  const dialog: FoodQuickMealDialogState = {
    action: 'eat',
    date: '2026-07-07',
    food: buildFood(),
    mealType: 'dinner',
    ...options.dialog,
  };
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodQuickMealDialog
        dialog={dialog}
        dateOptions={['2026-07-07', '2026-07-08']}
        isSubmitting={options.isSubmitting}
        recipes={[buildRecipe()]}
        onChange={onChange}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
  });
  return { onChange, onClose, onSubmit, view };
}

describe('FoodQuickMealDialog', () => {
  it('uses the shared food overlay frame and closes when idle', () => {
    const { onChange, onClose, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root.food-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.food-quick-meal-modal')).not.toBeNull();
    expect(view.querySelector('.workspace-overlay-footer .food-quick-meal-actions')).not.toBeNull();
    expect(view.textContent).toContain('番茄炒蛋');

    act(() => findButton(view, '明天')?.click());
    expect(onChange).toHaveBeenCalledWith({ date: '2026-07-08' });

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '取消')?.click());

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the dialog open and locks choices while submitting', () => {
    const { onChange, onClose, view } = renderDialog({ isSubmitting: true });

    expect(findButton(view, '处理中...')?.disabled).toBe(true);
    expect(findButton(view, '取消')?.disabled).toBe(true);
    expect(Array.from(view.querySelectorAll<HTMLButtonElement>('.food-quick-meal-date-strip button')).every((button) => button.disabled)).toBe(true);
    expect(Array.from(view.querySelectorAll<HTMLButtonElement>('.food-quick-meal-segments button')).every((button) => button.disabled)).toBe(true);

    act(() => findButton(view, '明天')?.click());
    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows stock deduction controls for eat actions with stock', () => {
    const { onChange, view } = renderDialog({
      dialog: {
        food: {
          ...buildFood(),
          type: 'instant',
          stock_quantity: 3,
          stock_unit: '盒',
        },
        deductStock: true,
        stockQuantity: '1.5',
      },
    });

    expect(view.textContent).toContain('同步扣减库存');
    expect(view.textContent).toContain('当前剩余 3盒');
    expect(view.textContent).toContain('扣减数量');

    const checkbox = view.querySelector<HTMLInputElement>('.food-quick-meal-stock-toggle input');
    const quantityInput = view.querySelector<HTMLInputElement>('.food-quick-meal-stock-quantity input');

    expect(checkbox?.checked).toBe(true);
    expect(quantityInput?.value).toBe('1.5');
    expect(quantityInput?.step).toBe('0.1');

    act(() => {
      checkbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ deductStock: false });
  });

  it('shows an inline stock quantity error when provided', () => {
    const { view } = renderDialog({
      dialog: {
        food: {
          ...buildFood(),
          type: 'instant',
          stock_quantity: 3,
          stock_unit: '盒',
        },
        deductStock: true,
        stockQuantity: '',
        stockQuantityError: '请输入大于 0 的扣减数量。',
      },
    });

    const quantityInput = view.querySelector<HTMLInputElement>('.food-quick-meal-stock-quantity input');
    const error = view.querySelector<HTMLElement>('.food-quick-meal-stock-error');

    expect(quantityInput?.getAttribute('aria-invalid')).toBe('true');
    expect(quantityInput?.getAttribute('aria-describedby')).toBe('food-quick-meal-stock-error');
    expect(error?.textContent).toContain('请输入大于 0 的扣减数量。');
  });
});
