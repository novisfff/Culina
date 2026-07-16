// @vitest-environment jsdom

import type { FormEvent } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, Recipe } from '../../api/types';
import { FoodQuickMealDialog, type FoodQuickMealDialogState } from './FoodQuickMealDialog';
import { buildDirectCookTarget, buildPlanCookLaunchContext } from './FoodWorkspaceModel';

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

function buildRecipe(overrides: Partial<Recipe> = {}): Recipe {
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
    ...overrides,
  };
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function findByAriaLabel(view: HTMLElement, label: string) {
  return view.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function renderDialog(options: {
  dialog?: Partial<FoodQuickMealDialogState>;
  isSubmitting?: boolean;
  recipes?: Recipe[];
  onChange?: ReturnType<typeof vi.fn>;
  onSubmit?: ReturnType<typeof vi.fn>;
} = {}) {
  const onChange = options.onChange ?? vi.fn();
  const onClose = vi.fn();
  const onSubmit = options.onSubmit ?? vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
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
        dateOptions={['2026-07-07', '2026-07-08', '2026-07-15']}
        isSubmitting={options.isSubmitting}
        recipes={options.recipes ?? [buildRecipe()]}
        onChange={onChange}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
  });
  return { onChange, onClose, onSubmit, view, dialog };
}

/**
 * Controlled cook dialog that applies onChange patches so user can confirm date/meal/servings
 * and submit — exercises the direct Cook launch path without plan mutation.
 */
function renderFoodQuickMeal(options: {
  action?: 'cook' | 'eat';
  createFoodPlanItem: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  recipeServings?: number;
}) {
  const recipe = buildRecipe({ servings: options.recipeServings ?? 2 });
  const food = buildFood();
  let dialog: FoodQuickMealDialogState = {
    action: options.action ?? 'cook',
    date: '2026-07-07',
    food,
    mealType: 'dinner',
    recipeId: recipe.id,
    servings: recipe.servings,
  };
  const onChange = vi.fn((patch: Partial<FoodQuickMealDialogState>) => {
    dialog = { ...dialog, ...patch };
    act(() => {
      root?.render(
        <FoodQuickMealDialog
          dialog={dialog}
          dateOptions={['2026-07-07', '2026-07-08', '2026-07-15']}
          recipes={[recipe]}
          onChange={onChange}
          onClose={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });
  });
  const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Mirror FoodWorkspace.submitQuickMealDialog cook branch (no plan mutation).
    if (dialog.action === 'cook' && dialog.recipeId) {
      options.navigate(
        buildDirectCookTarget({
          foodId: dialog.food.id,
          recipeId: dialog.recipeId,
          date: dialog.date,
          mealType: dialog.mealType,
          servings: dialog.servings ?? recipe.servings,
        }),
      );
    }
  });
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodQuickMealDialog
        dialog={dialog}
        dateOptions={['2026-07-07', '2026-07-08', '2026-07-15']}
        recipes={[recipe]}
        onChange={onChange}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
  });
  return { view, createFoodPlanItem: options.createFoodPlanItem, navigate: options.navigate };
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

  it('does not expose stock deduction controls (inventory is a separate command)', () => {
    const { view } = renderDialog({
      dialog: {
        food: {
          ...buildFood(),
          type: 'instant',
          stock_quantity: 3,
          stock_unit: '盒',
        },
      },
    });

    expect(view.textContent).not.toContain('同步扣减库存');
    expect(view.textContent).not.toContain('扣减数量');
    expect(view.querySelector('.food-quick-meal-stock-toggle')).toBeNull();
    expect(view.querySelector('.food-quick-meal-stock-quantity')).toBeNull();
  });

  it('shows cook-only servings stepper and cook confirmation copy', () => {
    const { onChange, view } = renderDialog({
      dialog: {
        action: 'cook',
        recipeId: 'recipe-1',
        servings: 2,
        mealType: 'dinner',
      },
    });

    expect(view.textContent).toContain('确认日期、餐次和份量后开始做');
    expect(view.querySelector('.eat-quick-meal-servings')).not.toBeNull();
    expect(findByAriaLabel(view, '份量增加')).not.toBeNull();
    expect(view.textContent).not.toContain('同步扣减库存');

    act(() => findByAriaLabel(view, '份量增加')?.click());
    expect(onChange).toHaveBeenCalledWith({ servings: 2.5 });
  });

  it('launches direct Cook with the user-confirmed context and no plan mutation', () => {
    const createFoodPlanItem = vi.fn();
    const navigate = vi.fn();
    const { view } = renderFoodQuickMeal({
      action: 'cook',
      createFoodPlanItem,
      navigate,
      recipeServings: 2,
    });

    const dateListbox = view.querySelector<HTMLElement>('[role="listbox"][aria-label="选择日期"]');
    const july15 = Array.from(dateListbox?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('7/15'),
    );
    act(() => july15?.click());
    act(() => findButton(view, '午餐')?.click());
    act(() => findByAriaLabel(view, '份量增加')?.click());
    act(() => findButton(view, '开始做')?.click());

    expect(createFoodPlanItem).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: 'eat',
        view: 'cook',
        launchContext: {
          date: '2026-07-15',
          mealType: 'lunch',
          servings: 2.5,
          source: { kind: 'direct' },
        },
      }),
    );
  });

  it('launches plan Cook from the loaded detail version', () => {
    const item = {
      id: 'plan-1',
      plan_date: '2026-07-15',
      meal_type: 'dinner' as const,
      updated_at: '2026-07-12T10:00:00Z',
    };
    expect(buildPlanCookLaunchContext(item, buildRecipe({ servings: 4 }))).toEqual({
      date: item.plan_date,
      mealType: item.meal_type,
      servings: 4,
      source: { kind: 'plan', foodPlanItemId: 'plan-1', planItemBaseUpdatedAt: item.updated_at },
    });
  });
});
