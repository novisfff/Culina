// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecipePlanItem } from '../../api/types';
import { RecipePlanDetailDialog, RecipePlanDialog } from './RecipePlanDialogs';

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

function renderPlanDialog() {
  const onClose = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <RecipePlanDialog
        card={null}
        form={{ recipeId: '', planDate: '2026-07-07', mealType: 'dinner', note: '' }}
        recipeOptions={[]}
        recipeSearch=""
        isRecipePickerOpen={false}
        weekRange={{ start: '2026-07-06', end: '2026-07-12' }}
        hasRecipes={false}
        onClose={onClose}
        onSubmit={vi.fn()}
        onChangeForm={vi.fn()}
        onChangeRecipeSearch={vi.fn()}
        onSetRecipePickerOpen={vi.fn()}
        onLoadMoreRecipeOptions={vi.fn()}
        onSelectRecipe={vi.fn()}
      />,
    );
  });
  return { onClose, view };
}

function renderPlanDetailDialog() {
  const onClose = vi.fn();
  const item: RecipePlanItem = {
    id: 'plan-1',
    family_id: 'family-1',
    user_id: 'user-1',
    food_id: 'food-1',
    food_name: '番茄炒蛋',
    food_type: 'dish',
    recipe_id: 'recipe-1',
    recipe_title: '番茄炒蛋',
    plan_date: '2026-07-07',
    meal_type: 'dinner',
    note: '',
    status: 'planned',
    created_at: '2026-07-06T00:00:00Z',
    updated_at: '2026-07-06T00:00:00Z',
  };
  const view = attachRoot();
  act(() => {
    root?.render(
      <RecipePlanDetailDialog
        item={item}
        card={null}
        form={{ planDate: '2026-07-07', mealType: 'dinner', note: '' }}
        weekRange={{ start: '2026-07-06', end: '2026-07-12' }}
        onClose={onClose}
        onSubmit={vi.fn()}
        onChangeForm={vi.fn()}
        onStartCook={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
  });
  return { onClose, view };
}

describe('RecipePlanDialogs', () => {
  it('uses the shared overlay frame for the plan creation dialog', () => {
    const { onClose, view } = renderPlanDialog();

    expect(view.querySelector('.workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-plan-modal')).not.toBeNull();
    expect(view.textContent).toContain('加菜到菜单');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('uses the shared overlay frame for the plan detail dialog', () => {
    const { onClose, view } = renderPlanDetailDialog();

    expect(view.querySelector('.workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.recipe-plan-detail-modal')).not.toBeNull();
    expect(view.querySelector('.workspace-overlay-footer .recipe-plan-detail-actions')).not.toBeNull();
    expect(view.querySelector('.recipe-plan-detail-actions .ui-form-actions-row')).toBeNull();
    expect(view.textContent).toContain('番茄炒蛋');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
