// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, FoodPlanItem } from '../../api/types';
import { FoodPlanDetailModal } from './FoodPlanDetailModal';

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

function buildPlanItem(): FoodPlanItem {
  return {
    id: 'plan-1',
    family_id: 'family-1',
    user_id: 'user-1',
    food_id: 'food-1',
    food_name: '番茄炒蛋',
    food_type: 'selfMade',
    recipe_id: null,
    recipe_title: '',
    plan_date: '2026-07-07',
    meal_type: 'dinner',
    note: '',
    status: 'planned',
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function buildFood(): Food {
  return {
    id: 'food-1',
    family_id: 'family-1',
    name: '番茄炒蛋',
    type: 'selfMade',
    category: '家常菜',
    flavor_tags: [],
    suitable_meal_types: ['lunch', 'dinner'],
    source_name: '',
    purchase_source: '',
    scene: '',
    images: [],
    notes: '',
    routine_note: '',
    price: null,
    rating: null,
    repurchase: null,
    expiry_date: null,
    stock_quantity: null,
    stock_unit: '',
    storage_location: '',
    favorite: false,
    recipe_id: null,
    row_version: 1,
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderModal(options: {
  food?: Food | null;
  item?: FoodPlanItem;
  isCompleting?: boolean;
  isEditing?: boolean;
  isUpdatingPlan?: boolean;
} = {}) {
  const onClose = vi.fn();
  const onComplete = vi.fn();
  const onRecordEaten = vi.fn();
  const onOpenMealRecord = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodPlanDetailModal
        item={options.item ?? buildPlanItem()}
        food={options.food === undefined ? null : options.food}
        recipes={[]}
        form={{ planDate: '2026-07-07', mealType: 'dinner', note: '' }}
        isEditing={Boolean(options.isEditing)}
        isUpdatingPlan={options.isUpdatingPlan}
        isCompleting={options.isCompleting}
        onClose={onClose}
        onChangeForm={vi.fn()}
        onEditingChange={vi.fn()}
        onResetEdit={vi.fn()}
        onSubmit={vi.fn()}
        onComplete={onComplete}
        onRecordEaten={onRecordEaten}
        onOpenMealRecord={onOpenMealRecord}
        onDelete={vi.fn()}
        resolveAssetUrl={() => ''}
        overlayRootClassName="food-workspace-overlay-root"
      />,
    );
  });
  return { onClose, onComplete, onRecordEaten, onOpenMealRecord, view };
}

describe('FoodPlanDetailModal', () => {
  it('uses the shared food overlay frame and closes when idle', () => {
    const { onClose, view } = renderModal();

    expect(view.querySelector('.workspace-overlay-root.food-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.food-plan-detail-modal')).not.toBeNull();
    expect(view.textContent).toContain('番茄炒蛋');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps the modal open and locks actions while completing', () => {
    const { onClose, view } = renderModal({ isCompleting: true });

    expect(view.querySelector('[role="status"]')?.textContent).toContain('正在准备这餐');
    expect(view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.disabled).toBe(true);
    expect(findButton(view, '处理中...')?.disabled).toBe(true);
    expect(findButton(view, '修改')?.disabled).toBe(true);
    expect(findButton(view, '删除')?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps exactly three view actions and calls the primary action record eaten', () => {
    const { view } = renderModal();
    const actionButtons = Array.from(
      view.querySelectorAll<HTMLButtonElement>('.workspace-overlay-footer-actions button'),
    );

    expect(actionButtons.map((button) => button.textContent?.trim())).toEqual([
      '记录已吃',
      '修改',
      '删除',
    ]);
    expect(findButton(view, '补充记录')).toBeUndefined();
    expect(view.querySelector('.recipe-plan-detail-actions.is-standard')).not.toBeNull();
  });

  it('opens the linked meal record after a plan item was recorded', () => {
    const { view, onOpenMealRecord } = renderModal({
      item: { ...buildPlanItem(), status: 'cooked', meal_log_id: 'meal-1', completed_at: '2026-07-07T12:00:00Z' },
    });

    expect(findButton(view, '餐食记录')).toBeDefined();
    expect(findButton(view, '修改')).toBeUndefined();
    expect(view.querySelector('.recipe-plan-detail-actions.is-recorded')).not.toBeNull();
    expect(view.textContent).toContain('已关联餐食记录');
    expect(view.textContent).toContain('记录于');
    act(() => findButton(view, '餐食记录')?.click());
    expect(onOpenMealRecord).toHaveBeenCalledTimes(1);
  });

  it('keeps start cooking primary and offers direct record for a recipe plan', () => {
    const { view, onComplete, onRecordEaten } = renderModal({
      item: { ...buildPlanItem(), recipe_id: 'recipe-1', recipe_title: '番茄炒蛋' },
    });

    expect(findButton(view, '开始做')).toBeDefined();
    expect(findButton(view, '直接记录已吃')).toBeDefined();
    expect(view.querySelector('.recipe-plan-detail-actions.is-recipe')).not.toBeNull();
    act(() => findButton(view, '直接记录已吃')?.click());
    act(() => findButton(view, '开始做')?.click());
    expect(onRecordEaten).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('renders an immersive placeholder and adaptive food facts when the cover is missing', () => {
    const { view } = renderModal({ food: buildFood() });

    expect(view.querySelector('.food-plan-detail-hero')).not.toBeNull();
    const placeholder = view.querySelector('.food-plan-detail-cover-fallback');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.querySelector('strong')).toBeNull();
    expect(view.textContent).toContain('适合餐次');
    expect(view.textContent).toContain('午餐、晚餐');
    expect(view.textContent).toContain('关联菜谱');
  });

  it('locks edit fields while saving changes', () => {
    const { view } = renderModal({ isEditing: true, isUpdatingPlan: true });

    expect(view.querySelector('[role="status"]')?.textContent).toContain('正在保存菜单变更');
    expect(findButton(view, '取消修改')?.disabled).toBe(true);
    expect(view.querySelector<HTMLInputElement>('input.text-input')?.disabled).toBe(true);
    expect(Array.from(view.querySelectorAll<HTMLButtonElement>('.recipe-plan-date-strip button')).every((button) => button.disabled)).toBe(true);
    expect(Array.from(view.querySelectorAll<HTMLButtonElement>('.recipe-plan-meal-segment button')).every((button) => button.disabled)).toBe(true);
    expect(view.querySelector('.recipe-plan-detail-actions.is-editing')).not.toBeNull();
  });
});
