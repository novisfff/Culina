// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food, FoodPlanItem, MealLog, Member, RecordMealResponse } from '../../api/types';
import { MealEnrichmentModal } from './MealEnrichmentModal';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const meal: MealLog = {
  id: 'meal-1',
  family_id: 'family-1',
  date: '2026-07-07',
  meal_type: 'dinner',
  food_entries: [{ id: 'entry-1', food_id: 'food-1', food_name: '番茄炒蛋', servings: 1, note: '', rating: null }],
  participant_user_ids: [],
  notes: '',
  mood: '',
  photos: [],
  deduction_suggestions: [],
  row_version: 1,
  created_at: '2026-07-07T12:00:00Z',
  updated_at: '2026-07-07T12:00:00Z',
};

const members: Member[] = [];

const rice: Food = {
  id: 'food-rice',
  family_id: 'family-1',
  name: '米饭',
  type: 'selfMade',
  category: '主食',
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

const tomatoWithImage: Food = {
  ...rice,
  id: 'food-1',
  name: '番茄炒蛋',
  category: '家常菜',
  images: [
    {
      id: 'media-tomato',
      name: '番茄炒蛋.jpg',
      url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="80"/%3E',
      source: 'upload',
      alt: '番茄炒蛋成品',
      created_at: '2026-07-07T00:00:00Z',
    },
  ],
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function renderModal(options: {
  open?: boolean;
  isUpdating?: boolean;
  meal?: MealLog;
  pendingPlanItems?: FoodPlanItem[];
  availableFoods?: Food[];
  onRecordPlanItem?: (item: FoodPlanItem) => Promise<RecordMealResponse>;
} = {}) {
  const onClose = vi.fn();
  const open = options.open ?? true;
  const isUpdating = options.isUpdating ?? false;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MealEnrichmentModal
        open={open}
        meal={options.meal ?? meal}
        members={members}
        isUpdating={isUpdating}
        updateMealLog={vi.fn(async () => undefined)}
        pendingPlanItems={options.pendingPlanItems}
        availableFoods={options.availableFoods}
        onRecordPlanItem={options.onRecordPlanItem}
        onClose={onClose}
        overlayRootClassName="home-dashboard-overlay-root"
        formId="test-meal-enrichment-form"
      />,
    );
  });
  return { onClose, view: container };
}

describe('MealEnrichmentModal', () => {
  it('wraps MealEnrichmentForm with the shared modal footer', () => {
    const { view } = renderModal();

    expect(view.textContent).toContain('评价这顿晚餐');
    expect(view.textContent).toContain('餐食已经记录；关闭评价不会撤销这顿');
    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    expect(view.querySelector<HTMLButtonElement>('button.ui-form-actions-primary')?.getAttribute('form')).toBe(
      'test-meal-enrichment-form',
    );
  });

  it('treats the modal as a whole meal and offers pending plan items for immediate record', async () => {
    const pending: FoodPlanItem = {
      id: 'plan-rice', family_id: 'family-1', user_id: 'user-1', food_id: 'food-rice',
      food_name: '米饭', food_type: 'selfMade', recipe_id: null, recipe_title: '',
      plan_date: meal.date, meal_type: meal.meal_type, note: '', status: 'planned',
      created_at: '2026-07-07T00:00:00Z', updated_at: '2026-07-07T00:00:00Z',
    };
    const onRecordPlanItem = vi.fn(async () => ({
      meal_log: {
        ...meal,
        row_version: 2,
        food_entries: [...meal.food_entries, { id: 'entry-rice', food_id: 'food-rice', food_name: '米饭', servings: 1, note: '', rating: null }],
      },
      created_foods: [],
      outcome: 'appended' as const,
      operation: { id: 'op-rice', status: 'applied' as const, can_revert: true, revertible_until: '2026-07-07T13:00:00Z', created_entry_ids: ['entry-rice'] },
      completed_plan_item_ids: ['plan-rice'],
    }));
    const { view } = renderModal({ pendingPlanItems: [pending], onRecordPlanItem });

    expect(view.textContent).toContain('评价这顿晚餐');
    expect(view.textContent).toContain('本餐计划 · 尚未记录');
    expect(view.textContent).toContain('添加其他实际吃的食物');
    expect(view.textContent).toContain('稍后再说');

    await act(async () => {
      view.querySelector<HTMLButtonElement>('button[aria-label="记录米饭已吃"]')?.click();
    });
    expect(onRecordPlanItem).toHaveBeenCalledWith(pending);
  });

  it('shows food thumbnails and a stable placeholder for foods without an image', () => {
    const pending: FoodPlanItem = {
      id: 'plan-rice', family_id: 'family-1', user_id: 'user-1', food_id: rice.id,
      food_name: rice.name, food_type: rice.type, recipe_id: null, recipe_title: '',
      plan_date: meal.date, meal_type: meal.meal_type, note: '', status: 'planned',
      created_at: '2026-07-07T00:00:00Z', updated_at: '2026-07-07T00:00:00Z',
    };
    const { view } = renderModal({
      pendingPlanItems: [pending],
      availableFoods: [tomatoWithImage, rice],
    });

    const recordedRow = Array.from(view.querySelectorAll('.meal-dish-rating-row'))
      .find((row) => row.textContent?.includes('番茄炒蛋'));
    const pendingRow = Array.from(view.querySelectorAll('.meal-dish-rating-row'))
      .find((row) => row.textContent?.includes('米饭'));

    expect(recordedRow?.querySelector<HTMLImageElement>('.meal-dish-rating-media img')?.alt).toBe('番茄炒蛋成品');
    expect(pendingRow?.querySelector('.meal-dish-rating-media .media-placeholder')).not.toBeNull();
  });

  it('shows a newly recorded plan food as rateable and restores the plus action after undo', async () => {
    const pending: FoodPlanItem = {
      id: 'plan-rice', family_id: 'family-1', user_id: 'user-1', food_id: 'food-rice', food_name: '米饭',
      food_type: 'selfMade', recipe_id: null, recipe_title: '', plan_date: meal.date, meal_type: meal.meal_type,
      note: '', status: 'planned', created_at: '', updated_at: '2026-07-07T00:00:00Z',
    };
    const appendedMeal: MealLog = {
      ...meal,
      row_version: 2,
      food_entries: [...meal.food_entries, { id: 'entry-rice', food_id: 'food-rice', food_name: '米饭', servings: 1, note: '', rating: null }],
    };
    const onRecordPlanItem = vi.fn(async () => ({
      meal_log: appendedMeal,
      created_foods: [],
      outcome: 'appended' as const,
      operation: { id: 'op-rice', status: 'applied' as const, can_revert: true, revertible_until: '2026-07-07T13:00:00Z', created_entry_ids: ['entry-rice'] },
      completed_plan_item_ids: [pending.id],
    }));
    const onRevertRecord = vi.fn(async () => ({ status: 'reverted' as const, meal_log: meal, removed_food_ids: [], replayed: false }));

    function Harness() {
      const [currentMeal, setCurrentMeal] = useState(meal);
      return (
        <MealEnrichmentModal
          open
          meal={currentMeal}
          members={[]}
          isUpdating={false}
          updateMealLog={vi.fn(async () => undefined)}
          onClose={vi.fn()}
          pendingPlanItems={[pending]}
          onRecordPlanItem={onRecordPlanItem}
          onRevertRecord={onRevertRecord}
          onMealChanged={setCurrentMeal}
        />
      );
    }

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness />));
    await act(async () => container?.querySelector<HTMLButtonElement>('button[aria-label="记录米饭已吃"]')?.click());

    expect(container.textContent).toContain('撤回刚才添加');
    expect(container.textContent).toContain('米饭');
    await act(async () => {
      Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent?.includes('撤回刚才添加'))?.click();
    });

    expect(onRevertRecord).toHaveBeenCalledWith('op-rice');
    expect(container.querySelector('button[aria-label="记录米饭已吃"]')).not.toBeNull();
  });

  it('opens the other-food picker and appends an existing food', async () => {
    const appendedMeal: MealLog = {
      ...meal,
      row_version: 2,
      food_entries: [
        ...meal.food_entries,
        { id: 'entry-rice', food_id: rice.id, food_name: rice.name, servings: 1, note: '', rating: null },
      ],
    };
    const onAddExistingFood = vi.fn(async () => ({
      meal_log: appendedMeal,
      created_foods: [],
      outcome: 'appended' as const,
      operation: {
        id: 'op-rice',
        status: 'applied' as const,
        can_revert: true,
        revertible_until: '2026-07-07T13:00:00Z',
        created_entry_ids: ['entry-rice'],
      },
      completed_plan_item_ids: [],
    }));

    function Harness() {
      const [currentMeal, setCurrentMeal] = useState(meal);
      return (
        <MealEnrichmentModal
          open
          meal={currentMeal}
          members={[]}
          isUpdating={false}
          updateMealLog={vi.fn(async () => undefined)}
          onClose={vi.fn()}
          availableFoods={[rice]}
          onAddExistingFood={onAddExistingFood}
          onRevertRecord={vi.fn(async () => ({
            status: 'reverted' as const,
            meal_log: meal,
            removed_food_ids: [],
            replayed: false,
          }))}
          onMealChanged={setCurrentMeal}
        />
      );
    }

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness />));
    act(() => {
      Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent?.includes('添加其他实际吃的食物'))
        ?.click();
    });

    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索食物"]');
    expect(search).not.toBeNull();
    act(() => search?.focus());
    await act(async () => {
      Array.from(container?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
        .find((button) => button.textContent?.includes('米饭'))
        ?.click();
    });

    expect(onAddExistingFood).toHaveBeenCalledWith(rice);
    expect(container.textContent).toContain('撤回刚才添加');
  });

  it('clears temporary food-adder state when the modal switches to another meal', () => {
    const nextMeal: MealLog = {
      ...meal,
      id: 'meal-2',
      date: '2026-07-08',
      food_entries: [{ id: 'entry-2', food_id: 'food-2', food_name: '牛肉面', servings: 1, note: '', rating: null }],
    };

    function Harness() {
      const [currentMeal, setCurrentMeal] = useState(meal);
      return (
        <>
          <button type="button" onClick={() => setCurrentMeal(nextMeal)}>切换餐食</button>
          <MealEnrichmentModal
            open
            meal={currentMeal}
            members={[]}
            isUpdating={false}
            updateMealLog={vi.fn(async () => undefined)}
            onClose={vi.fn()}
            availableFoods={[rice]}
            onAddExistingFood={vi.fn(async () => {
              throw new Error('not used');
            })}
          />
        </>
      );
    }

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness />));
    act(() => {
      Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent?.includes('添加其他实际吃的食物'))
        ?.click();
    });
    expect(container.querySelector('input[aria-label="搜索食物"]')).not.toBeNull();

    act(() => {
      Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent === '切换餐食')
        ?.click();
    });

    expect(container.textContent).toContain('牛肉面');
    expect(container.querySelector('input[aria-label="搜索食物"]')).toBeNull();
    expect(container.textContent).toContain('添加其他实际吃的食物');
  });

  it('renders nothing when closed', () => {
    const { view } = renderModal({ open: false });
    expect(view.textContent).toBe('');
  });

  it('keeps the modal open while an update is submitting', () => {
    const { onClose, view } = renderModal({ isUpdating: true });

    expect(view.querySelector('[role="status"]')?.textContent).toContain('正在保存餐食记录');
    expect(view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.disabled).toBe(true);
    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => view.querySelector<HTMLButtonElement>('button.ui-form-actions-secondary')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });
});
