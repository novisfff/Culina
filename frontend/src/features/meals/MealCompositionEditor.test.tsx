// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/request';
import type { MealLog, UpdateMealCompositionPayload } from '../../api/types';
import { MealCompositionEditor } from './MealCompositionEditor';

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
        note: '少盐',
        rating: 4,
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
    row_version: 2,
    created_at: '2026-07-15T11:00:00.000Z',
    updated_at: '2026-07-15T11:00:00.000Z',
    ...overrides,
  };
}

describe('MealCompositionEditor', () => {
  it('supports add/remove/servings/note and keeps at least one entry', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_payload: UpdateMealCompositionPayload) => mealLog());
    render(
      <MealCompositionEditor
        meal={mealLog()}
        busy={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('番茄炒蛋')).toBeVisible();
    expect(screen.getByDisplayValue('少盐')).toBeVisible();

    const servings = screen.getAllByLabelText('份量');
    await user.clear(servings[0]!);
    await user.type(servings[0]!, '2');

    await user.click(screen.getByRole('button', { name: '添加菜品' }));
    expect(screen.getAllByLabelText('菜品')).toHaveLength(3);

    await user.click(screen.getAllByRole('button', { name: '移除' })[2]!);
    expect(screen.getAllByLabelText('菜品')).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: '移除' })[0]!);
    await user.click(screen.getAllByRole('button', { name: '移除' })[0]!);
    expect(screen.getAllByLabelText('菜品')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '移除' })).toBeDisabled();
  });

  it('on 409 merges conflicts, updates expected version, and requires explicit resubmit', async () => {
    const user = userEvent.setup();
    const serverMeal = mealLog({
      row_version: 5,
      food_entries: [
        {
          id: 'entry-1',
          food_id: 'food-1',
          food_name: '番茄炒蛋',
          servings: 3,
          note: '服务器备注',
          rating: 4,
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
    });
    const onSubmit = vi
      .fn(async (_payload: UpdateMealCompositionPayload) => mealLog())
      .mockRejectedValueOnce(
        new ApiError({
          status: 409,
          detail: '版本冲突',
          path: '/api/meal-logs/meal-1/composition',
          payload: {
            detail: {
              code: 'meal_log_stale',
              current: serverMeal,
            },
          },
        }),
      )
      .mockResolvedValueOnce(serverMeal);

    render(
      <MealCompositionEditor
        meal={mealLog()}
        busy={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );

    const servings = screen.getAllByLabelText('份量');
    await user.clear(servings[0]!);
    await user.type(servings[0]!, '2');
    await user.click(screen.getByRole('button', { name: '保存组合' }));

    await waitFor(() => {
      expect(screen.getAllByText(/有冲突，请确认后再保存/).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('份量冲突')).toBeVisible();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ expected_row_version: 2 });

    // Auto-resubmit must not happen; user must click again.
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '确认并保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0]).toMatchObject({ expected_row_version: 5 });
  });

  it('timeout refetch treats exact submitted composition as success', async () => {
    const user = userEvent.setup();
    const current = mealLog({
      food_entries: [
        {
          id: 'entry-1',
          food_id: 'food-1',
          food_name: '番茄炒蛋',
          servings: 2,
          note: '少盐',
          rating: 4,
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
      row_version: 3,
    });
    const onSubmit = vi.fn(async () => {
      throw new ApiError({
        status: 0,
        detail: '网络超时',
        path: '/api/meal-logs/meal-1/composition',
        payload: null,
      });
    });
    const onRefetch = vi.fn(async () => current);
    const onSaved = vi.fn();

    render(
      <MealCompositionEditor
        meal={mealLog()}
        busy={false}
        onSubmit={onSubmit}
        onRefetchMeal={onRefetch}
        onSaved={onSaved}
        onClose={vi.fn()}
      />,
    );

    const servings = screen.getAllByLabelText('份量');
    await user.clear(servings[0]!);
    await user.type(servings[0]!, '2');
    await user.click(screen.getByRole('button', { name: '保存组合' }));

    await waitFor(() => expect(onRefetch).toHaveBeenCalled());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(current));
    expect(screen.queryByText(/冲突/)).not.toBeInTheDocument();
  });
});
