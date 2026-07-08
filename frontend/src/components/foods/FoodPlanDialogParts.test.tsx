// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Food } from '../../api/types';
import { FoodPlanDateMealNoteFields, FoodPlanSelectedHero } from './FoodPlanDialogParts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const food: Food = {
  id: 'food-1',
  family_id: 'family-1',
  name: '番茄炒蛋',
  type: 'selfMade',
  category: '家常菜',
  flavor_tags: [],
  suitable_meal_types: ['dinner'],
  recipe_id: 'recipe-1',
  source_name: '',
  purchase_source: '',
  scene: '',
  notes: '',
  routine_note: '',
  images: [],
  stock_unit: '',
  storage_location: '',
  favorite: false,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

describe('FoodPlanDialogParts', () => {
  it('renders selected food hero and exposes the change action', () => {
    const onClear = vi.fn();
    const view = render(
      <FoodPlanSelectedHero
        food={food}
        coverUrl={undefined}
        coverSrcSet={undefined}
        coverSizes={undefined}
        typeLabel="家常菜"
        sourceLabel="家庭厨房"
        capabilityLabel="有菜谱"
        iconKind="bookOpen"
        onClear={onClear}
      />,
    );

    expect(view.textContent).toContain('即将加入');
    expect(view.textContent).toContain('番茄炒蛋');
    act(() => Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '修改')?.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('emits date meal and note changes from one shared field block', () => {
    const onPlanDateChange = vi.fn();
    const onMealTypeChange = vi.fn();
    const onPlanNoteChange = vi.fn();
    const view = render(
      <FoodPlanDateMealNoteFields
        planDate="2026-07-07"
        mealType="dinner"
        note=""
        todayDate="2026-07-07"
        planDateOptions={[
          { value: '2026-07-07', label: '今天', display: '07/07' },
          { value: '2026-07-08', label: '周三', display: '07/08' },
        ]}
        mealOptions={[
          { value: 'breakfast', label: '早餐' },
          { value: 'dinner', label: '晚餐' },
        ]}
        notePlaceholder="比如：少油、常点套餐、提前解冻"
        onPlanDateChange={onPlanDateChange}
        onMealTypeChange={onMealTypeChange}
        onPlanNoteChange={onPlanNoteChange}
      />,
    );

    act(() => Array.from(view.querySelectorAll('button')).find((button) => button.textContent?.includes('07/08'))?.click());
    act(() => Array.from(view.querySelectorAll('button')).find((button) => button.textContent === '早餐')?.click());
    const input = view.querySelector<HTMLInputElement>('input.text-input');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '提前解冻');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(onPlanDateChange).toHaveBeenCalledWith('2026-07-08');
    expect(onMealTypeChange).toHaveBeenCalledWith('breakfast');
    expect(onPlanNoteChange).toHaveBeenCalledWith('提前解冻');
  });

  it('can lock the shared date meal and note fields while submitting', () => {
    const view = render(
      <FoodPlanDateMealNoteFields
        planDate="2026-07-07"
        mealType="dinner"
        note=""
        todayDate="2026-07-07"
        planDateOptions={[
          { value: '2026-07-07', label: '今天', display: '07/07' },
          { value: '2026-07-08', label: '周三', display: '07/08' },
        ]}
        mealOptions={[
          { value: 'breakfast', label: '早餐' },
          { value: 'dinner', label: '晚餐' },
        ]}
        notePlaceholder="比如：少油、常点套餐、提前解冻"
        disabled
        onPlanDateChange={vi.fn()}
        onMealTypeChange={vi.fn()}
        onPlanNoteChange={vi.fn()}
      />,
    );

    expect(Array.from(view.querySelectorAll('button')).every((button) => button.disabled)).toBe(true);
    expect(view.querySelector<HTMLInputElement>('input.text-input')?.disabled).toBe(true);
  });

  it('keeps food plan hero separate from recipe-only empty cover styling', () => {
    const source = readFileSync(resolve(__dirname, './FoodPlanDialogParts.tsx'), 'utf8');
    const styles = readFileSync(resolve(__dirname, '../../styles/05-workspace-overlays.css'), 'utf8');

    expect(source).not.toContain('recipe-plan-cover-empty');
    expect(styles).not.toContain('.food-plan-modal .recipe-plan-cover-empty');
    expect(styles).toContain('.recipe-plan-cover-empty');
  });
});
