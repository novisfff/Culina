// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food } from '../../api/types';
import { FoodPlanDialog } from './FoodPlanDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../hooks/useFoodResourceSearch', () => ({
  useFoodResourceSearch: () => ({
    foods: [buildFood()],
    isSearching: false,
    isFetchingNextPage: false,
    hasMore: false,
    fetchNextPage: vi.fn(),
    findFoodById: (foodId: string) => (foodId === 'food-1' ? buildFood() : null),
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
  }),
}));

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
    stock_unit: '',
    storage_location: '',
    favorite: false,
    recipe_id: 'recipe-1',
    created_at: '2026-07-07T00:00:00Z',
    updated_at: '2026-07-07T00:00:00Z',
  };
}

function findButton(view: HTMLElement, text: string) {
  return Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function renderDialog(options: { isUpdatingPlan?: boolean; selectedPlanFood?: Food | null } = {}) {
  const onClose = vi.fn();
  const view = attachRoot();
  act(() => {
    root?.render(
      <FoodPlanDialog
        isOpen
        selectedPlanFood={options.selectedPlanFood ?? buildFood()}
        foods={[buildFood()]}
        recipes={[]}
        planFoodSearch=""
        planForm={{ foodId: 'food-1', planDate: '2026-07-07', mealType: 'dinner', note: '' }}
        todayDate="2026-07-07"
        planDateOptions={['2026-07-07', '2026-07-08']}
        isUpdatingPlan={options.isUpdatingPlan}
        onClose={onClose}
        onSubmit={vi.fn()}
        onClearPlanFoodSelection={vi.fn()}
        onPlanFoodSearchChange={vi.fn()}
        onSelectPlanFood={vi.fn()}
        onPlanDateChange={vi.fn()}
        onMealTypeChange={vi.fn()}
        onPlanNoteChange={vi.fn()}
        resolveFoodAssetUrl={() => ''}
        getFoodCover={() => undefined}
        getDefaultMealType={() => 'dinner'}
        getPlanDateParts={(date) => (date === '2026-07-07'
          ? { month: '7', day: '7', weekday: '周二' }
          : { month: '7', day: '8', weekday: '周三' })}
        normalizeFoodType={() => 'selfMade'}
      />,
    );
  });
  return { onClose, view };
}

describe('FoodPlanDialog', () => {
  it('uses the shared food overlay frame and closes when idle', () => {
    const { onClose, view } = renderDialog();

    expect(view.querySelector('.workspace-overlay-root.food-workspace-overlay-root')).not.toBeNull();
    expect(view.querySelector('.food-plan-modal')).not.toBeNull();
    expect(view.textContent).toContain('加食物到菜单');

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '取消')?.click());

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the dialog open and locks editing while saving', () => {
    const { onClose, view } = renderDialog({ isUpdatingPlan: true });

    expect(findButton(view, '取消')?.disabled).toBe(true);
    expect(findButton(view, '修改')?.disabled).toBe(true);
    expect(findButton(view, '周三')?.disabled).toBe(true);
    expect(findButton(view, '早餐')?.disabled).toBe(true);
    expect(view.querySelector<HTMLInputElement>('input.text-input')?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '取消')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });
});
