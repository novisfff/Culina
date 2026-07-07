// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoodPlanItem } from '../../api/types';
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

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderModal(options: {
  isCompleting?: boolean;
  isEditing?: boolean;
  isSupplementing?: boolean;
  isUpdatingPlan?: boolean;
} = {}) {
  const onClose = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodPlanDetailModal
        item={buildPlanItem()}
        food={null}
        recipes={[]}
        form={{ planDate: '2026-07-07', mealType: 'dinner', note: '' }}
        isEditing={Boolean(options.isEditing)}
        isUpdatingPlan={options.isUpdatingPlan}
        isCompleting={options.isCompleting}
        isSupplementing={options.isSupplementing}
        onClose={onClose}
        onChangeForm={vi.fn()}
        onEditingChange={vi.fn()}
        onResetEdit={vi.fn()}
        onSubmit={vi.fn()}
        onComplete={vi.fn()}
        onSupplementRecord={vi.fn()}
        onDelete={vi.fn()}
        resolveAssetUrl={() => ''}
        overlayRootClassName="food-workspace-overlay-root"
      />,
    );
  });
  return { onClose, view };
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

    expect(findButton(view, '处理中...')?.disabled).toBe(true);
    expect(findButton(view, '补充记录')?.disabled).toBe(true);
    expect(findButton(view, '修改')?.disabled).toBe(true);
    expect(findButton(view, '删除')?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('locks edit fields while saving changes', () => {
    const { view } = renderModal({ isEditing: true, isUpdatingPlan: true });

    expect(findButton(view, '取消修改')?.disabled).toBe(true);
    expect(view.querySelector<HTMLInputElement>('input.text-input')?.disabled).toBe(true);
    expect(Array.from(view.querySelectorAll<HTMLButtonElement>('.recipe-plan-date-strip button')).every((button) => button.disabled)).toBe(true);
    expect(Array.from(view.querySelectorAll<HTMLButtonElement>('.recipe-plan-meal-segment button')).every((button) => button.disabled)).toBe(true);
  });
});
