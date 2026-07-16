// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoodPlanItem } from '../../api/types';
import { FoodPlanSurface, type FoodPlanSurfaceProps } from './FoodPlanSurface';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const breakfastItem: FoodPlanItem = {
  id: 'plan-breakfast',
  family_id: 'family-1',
  user_id: 'user-1',
  food_id: 'food-milk',
  food_name: '盒装牛奶',
  food_type: 'readyMade',
  recipe_id: null,
  recipe_title: '',
  plan_date: '2026-07-14',
  meal_type: 'breakfast',
  note: '',
  status: 'planned',
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

const dinnerItem: FoodPlanItem = {
  ...breakfastItem,
  id: 'plan-dinner',
  food_id: 'food-cauliflower',
  food_name: '干锅花菜',
  recipe_id: 'recipe-cauliflower',
  recipe_title: '干锅花菜',
  meal_type: 'dinner',
  plan_date: '2026-07-16',
};

function buildProps(overrides: Partial<FoodPlanSurfaceProps> = {}): FoodPlanSurfaceProps {
  return {
    weekRange: { start: '2026-07-13', end: '2026-07-19' },
    days: [
      { date: '2026-07-13', label: '2026-07-13', items: [] },
      { date: '2026-07-14', label: '2026-07-14', items: [breakfastItem] },
      { date: '2026-07-15', label: '2026-07-15', items: [] },
      { date: '2026-07-16', label: '今天', items: [dinnerItem] },
      { date: '2026-07-17', label: '2026-07-17', items: [] },
      { date: '2026-07-18', label: '2026-07-18', items: [] },
      { date: '2026-07-19', label: '2026-07-19', items: [] },
    ],
    onPreviousWeek: vi.fn(),
    onCurrentWeek: vi.fn(),
    onNextWeek: vi.fn(),
    onCreatePlan: vi.fn(),
    onOpenPlanItem: vi.fn(),
    onStartPlanItem: vi.fn(),
    ...overrides,
  };
}

function renderTabletPlan(overrides: Partial<FoodPlanSurfaceProps> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const props = buildProps(overrides);
  act(() => {
    root?.render(
      <FoodPlanSurface
        {...({
          ...props,
          presentation: 'tabletLandscape',
          todayDate: '2026-07-16',
        } as unknown as FoodPlanSurfaceProps)}
      />,
    );
  });
  return { props, view: container };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('FoodPlanSurface tablet landscape presentation', () => {
  it('selects today and only renders the selected day summary', () => {
    const { view } = renderTabletPlan();

    const dateRail = view.querySelector('.food-tablet-plan-date-rail');
    const selectedDate = view.querySelector<HTMLButtonElement>('[aria-pressed="true"]');

    expect(dateRail?.querySelectorAll('button')).toHaveLength(7);
    expect(selectedDate?.dataset.date).toBe('2026-07-16');
    expect(view.querySelector('.food-tablet-plan-day-summary')?.textContent).toContain('干锅花菜');
    expect(view.querySelector('.food-tablet-plan-day-summary')?.textContent).not.toContain('盒装牛奶');
  });

  it('switches the summary when a different date is selected', () => {
    const { view } = renderTabletPlan();
    const target = view.querySelector<HTMLButtonElement>('[data-date="2026-07-14"]');

    act(() => target?.click());

    expect(view.querySelector('.food-tablet-plan-day-summary')?.textContent).toContain('盒装牛奶');
    expect(view.querySelector('.food-tablet-plan-day-summary')?.textContent).not.toContain('干锅花菜');
  });

  it('prefills the selected date and meal when adding to an empty meal', () => {
    const onCreatePlan = vi.fn();
    const { view } = renderTabletPlan({ onCreatePlan });
    const addLunch = view.querySelector<HTMLButtonElement>('[aria-label="添加午餐"]');

    act(() => addLunch?.click());

    expect(onCreatePlan).toHaveBeenCalledWith({ planDate: '2026-07-16', mealType: 'lunch' });
  });
});
