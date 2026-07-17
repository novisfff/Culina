// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

function renderDialog(options: {
  isUpdatingPlan?: boolean;
  selectedPlanFood?: Food | null;
  overlayRootClassName?: string;
  modalClassName?: string;
} = {}) {
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
        planForm={{ foodId: 'food-1', planDate: '2026-07-17', mealType: 'dinner', note: '' }}
        todayDate="2026-07-17"
        isUpdatingPlan={options.isUpdatingPlan}
        overlayRootClassName={options.overlayRootClassName}
        modalClassName={options.modalClassName}
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
        getPlanDateParts={(date) => {
          const [, month, day] = date.split('-');
          return { month: Number(month), day: Number(day), weekday: `周${day}` };
        }}
        normalizeFoodType={() => 'selfMade'}
      />,
    );
  });
  return { onClose, view };
}

describe('FoodPlanDialog', () => {
  it('shows a stable seven-day window from yesterday and selects today', () => {
    const { view } = renderDialog();
    const dateButtons = Array.from(view.querySelectorAll<HTMLButtonElement>('.food-plan-date-strip button'));

    expect(dateButtons.map((button) => button.dataset.date)).toEqual([
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
    ]);
    expect(dateButtons[0]?.textContent).toContain('昨天');
    expect(dateButtons[1]?.textContent).toContain('今天');
    expect(dateButtons.filter((button) => button.classList.contains('active'))).toHaveLength(1);
    expect(dateButtons[1]).toHaveClass('active');
  });

  it('keeps exactly one date hover treatment when the pointer moves', () => {
    const { view } = renderDialog();
    const dateButtons = Array.from(view.querySelectorAll<HTMLButtonElement>('.food-plan-date-strip button'));

    act(() => dateButtons[0]?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    expect(dateButtons[0]).toHaveClass('is-hovered');

    act(() => {
      dateButtons[0]?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      dateButtons[5]?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });

    expect(dateButtons.filter((button) => button.classList.contains('is-hovered'))).toEqual([dateButtons[5]]);
  });

  it('uses the standard mobile bottom-sheet geometry for the home plan dialog', () => {
    const mobileStyles = readFileSync(resolve(__dirname, '../../styles/07-mobile.css'), 'utf8');

    expect(mobileStyles).toMatch(
      /\.home-dashboard-overlay-root \.home-plan-add-modal\.recipe-plan-modal\.workspace-modal \{[^}]*width: 100%;[^}]*max-height: min\(92dvh, var\(--app-visual-viewport-height\)\);[^}]*border-radius: 24px 24px 0 0;/,
    );
  });

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
    expect(view.querySelector<HTMLButtonElement>('.food-plan-date-strip button')?.disabled).toBe(true);
    expect(findButton(view, '早餐')?.disabled).toBe(true);
    expect(view.querySelector<HTMLInputElement>('input.text-input')?.disabled).toBe(true);

    act(() => view.querySelector<HTMLDivElement>('.workspace-overlay-backdrop')?.click());
    act(() => view.querySelector<HTMLButtonElement>('.workspace-overlay-close')?.click());
    act(() => findButton(view, '取消')?.click());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses the same configurable shell and busy feedback for the home entry', () => {
    const { view } = renderDialog({
      isUpdatingPlan: true,
      overlayRootClassName: 'home-dashboard-overlay-root',
      modalClassName: 'home-plan-add-modal',
    });

    expect(view.querySelector('.workspace-overlay-root.home-dashboard-overlay-root')).not.toBeNull();
    expect(view.querySelector('.food-plan-modal.home-plan-add-modal')).not.toBeNull();
    expect(view.textContent).toContain('正在加入菜单');
    expect(view.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });
});
