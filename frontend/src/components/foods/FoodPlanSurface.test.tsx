// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FoodPlanItem, MediaAsset } from '../../api/types';
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

const dinnerCover: MediaAsset = {
  id: 'media-dinner',
  name: '干锅花菜封面',
  url: '/media/dinner.jpg',
  source: 'upload',
  alt: '干锅花菜',
  created_at: '2026-07-01T00:00:00Z',
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
    getPlanItemCoverAsset: (item) => (item.id === dinnerItem.id ? dinnerCover : null),
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

function renderSidebarPlan(overrides: Partial<FoodPlanSurfaceProps> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const props = buildProps(overrides);
  act(() => {
    root?.render(<FoodPlanSurface {...props} presentation="sidebar" todayDate="2026-07-17" />);
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

  it('shows a food image before the copy and opens the item without a trailing quick-action button', () => {
    const onOpenPlanItem = vi.fn();
    const onStartPlanItem = vi.fn();
    const { view } = renderTabletPlan({ onOpenPlanItem, onStartPlanItem });
    const item = view.querySelector<HTMLElement>('.food-tablet-plan-item');
    const image = item?.querySelector<HTMLImageElement>('img');

    expect(item?.firstElementChild).toHaveClass('food-tablet-plan-item-media');
    expect(image?.getAttribute('src')).toContain('/media/dinner.jpg');
    expect(item?.querySelector('button')).toBeNull();

    act(() => item?.click());

    expect(onOpenPlanItem).toHaveBeenCalledWith(dinnerItem);
    expect(onStartPlanItem).not.toHaveBeenCalled();
  });
});

describe('FoodPlanSurface desktop sidebar presentation', () => {
  it('opens one planned day at a time and defaults to the first planned day when today is empty', () => {
    const { view } = renderSidebarPlan();

    const initiallyExpanded = view.querySelector<HTMLElement>('.food-sidebar-plan-day.expanded');
    expect(initiallyExpanded?.dataset.date).toBe('2026-07-14');
    expect(initiallyExpanded?.textContent).toContain('盒装牛奶');
    expect(view.querySelectorAll('.food-sidebar-plan-day.expanded')).toHaveLength(1);
    expect(view.querySelector('.food-sidebar-plan-week')?.textContent).not.toContain('干锅花菜');

    const dinnerDay = view.querySelector<HTMLButtonElement>('[data-date="2026-07-16"] .food-sidebar-plan-day-head');
    act(() => dinnerDay?.click());

    expect(view.querySelectorAll('.food-sidebar-plan-day.expanded')).toHaveLength(1);
    expect(view.querySelector<HTMLElement>('.food-sidebar-plan-day.expanded')?.dataset.date).toBe('2026-07-16');
    expect(view.querySelector('.food-sidebar-plan-week')?.textContent).toContain('干锅花菜');
    expect(view.querySelector('.food-sidebar-plan-week')?.textContent).not.toContain('盒装牛奶');
  });

  it('prefills the date when an empty day is selected', () => {
    const onCreatePlan = vi.fn();
    const { view } = renderSidebarPlan({ onCreatePlan });
    const emptyDay = view.querySelector<HTMLButtonElement>('[data-date="2026-07-13"] .food-sidebar-plan-day-head');

    act(() => emptyDay?.click());

    expect(onCreatePlan).toHaveBeenCalledWith({ planDate: '2026-07-13' });
  });

  it('shows three items first and reveals the remaining items on request', () => {
    const fiveItems = Array.from({ length: 5 }, (_, index) => ({
      ...breakfastItem,
      id: `plan-${index + 1}`,
      food_id: `food-${index + 1}`,
      food_name: `计划食物 ${index + 1}`,
    }));
    const days = buildProps().days.map((day) => day.date === '2026-07-14' ? { ...day, items: fiveItems } : day);
    const { view } = renderSidebarPlan({ days });

    expect(view.querySelectorAll('[data-date="2026-07-14"] .food-sidebar-plan-item')).toHaveLength(3);
    const revealButton = Array.from(view.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('查看另外 2 项'),
    );

    act(() => revealButton?.click());

    expect(view.querySelectorAll('[data-date="2026-07-14"] .food-sidebar-plan-item')).toHaveLength(5);
  });

  it('shows the food cover at the front of a sidebar plan item', () => {
    const { view } = renderSidebarPlan();
    const dinnerDay = view.querySelector<HTMLButtonElement>('[data-date="2026-07-16"] .food-sidebar-plan-day-head');

    act(() => dinnerDay?.click());

    const item = view.querySelector<HTMLElement>('[data-date="2026-07-16"] .food-sidebar-plan-item');
    expect(item?.firstElementChild).toHaveClass('food-sidebar-plan-item-media');
    expect(item?.querySelector<HTMLImageElement>('img')?.getAttribute('src')).toContain('/media/dinner.jpg');
  });

  it('uses a completed treatment without rendering completed status copy', () => {
    const cookedBreakfast = { ...breakfastItem, status: 'cooked' as const };
    const days = buildProps().days.map((day) =>
      day.date === cookedBreakfast.plan_date ? { ...day, items: [cookedBreakfast] } : day,
    );
    const { view } = renderSidebarPlan({ days });

    const item = view.querySelector<HTMLElement>('[data-date="2026-07-14"] .food-sidebar-plan-item');
    expect(item).toHaveClass('is-completed');
    expect(item?.textContent).not.toContain('已完成');
    expect(item?.getAttribute('aria-label')).toContain('已完成');
    expect(item?.querySelector('.food-sidebar-plan-item-complete-mark')).not.toBeNull();
  });

  it('does not reuse recipe plan classes in the desktop sidebar', () => {
    const { view } = renderSidebarPlan();

    expect(view.querySelector('.food-sidebar-plan-week')).not.toBeNull();
    expect(view.querySelector('.food-sidebar-plan-week .recipe-plan-day')).toBeNull();
    expect(view.querySelector('.food-sidebar-plan-week .recipe-plan-item')).toBeNull();
  });
});
