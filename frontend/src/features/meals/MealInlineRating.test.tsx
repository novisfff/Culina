// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MealLog, UpdateMealLogPayload } from '../../api/types';
import { MealInlineRating } from './MealInlineRating';

function mealLog(overrides: Partial<MealLog> = {}): MealLog {
  return {
    id: 'meal-1',
    family_id: 'family-1',
    date: '2026-07-15',
    meal_type: 'dinner',
    food_entries: [
      {
        id: 'entry-1',
        food_id: 'food-1',
        food_name: '番茄炒蛋',
        servings: 1,
        note: '',
        rating: null,
      },
      {
        id: 'entry-2',
        food_id: 'food-2',
        food_name: '青菜',
        servings: 1,
        note: '',
        rating: null,
      },
    ],
    participant_user_ids: [],
    notes: '',
    mood: '',
    photos: [],
    deduction_suggestions: [],
    row_version: 4,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

describe('MealInlineRating', () => {
  it('sends expected_row_version from the latest MealLog and has no skip/debt CTA', async () => {
    const user = userEvent.setup();
    const onRate = vi.fn(async (_payload: UpdateMealLogPayload) => mealLog({ row_version: 5 }));
    render(<MealInlineRating meal={mealLog()} busy={false} onRate={onRate} />);

    expect(screen.getByText('番茄炒蛋')).toBeVisible();
    expect(screen.getByText('青菜')).toBeVisible();
    for (const debt of ['未评分', '待补充', '跳过', '稍后再说', '基础记录']) {
      expect(screen.queryByText(debt)).not.toBeInTheDocument();
    }

    const sliders = screen.getAllByRole('slider', { name: '评分' });
    expect(sliders).toHaveLength(2);
    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperty(pointerDown, 'clientX', { value: 60 });
    Object.defineProperty(sliders[0], 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 100, top: 0, height: 20, right: 100, bottom: 20 }),
    });
    sliders[0]!.dispatchEvent(pointerDown);
    await user.click(screen.getByRole('button', { name: '保存评分' }));

    expect(onRate).toHaveBeenCalledWith(
      expect.objectContaining({
        expected_row_version: 4,
        food_entry_ratings: expect.arrayContaining([
          expect.objectContaining({ id: 'entry-1' }),
          expect.objectContaining({ id: 'entry-2' }),
        ]),
      }),
    );
  });

  it('does not submit when every rating is left blank', async () => {
    const user = userEvent.setup();
    const onRate = vi.fn(async (_payload: UpdateMealLogPayload) => mealLog());
    render(<MealInlineRating meal={mealLog()} busy={false} onRate={onRate} />);
    await user.click(screen.getByRole('button', { name: '保存评分' }));
    expect(onRate).not.toHaveBeenCalled();
  });

  it('disables save while busy', () => {
    render(<MealInlineRating meal={mealLog()} busy onRate={vi.fn(async () => mealLog())} />);
    expect(screen.getByRole('button', { name: '保存评分' })).toBeDisabled();
  });
});
